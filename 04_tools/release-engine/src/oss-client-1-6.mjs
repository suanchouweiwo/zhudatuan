import { createHash, createHmac } from 'node:crypto';

import { DeliveryError, invariant } from './errors.mjs';
import { sha256 } from './stable.mjs';

export function simpleOssClientFromEnvironment(endpoint, environment = process.env) {
  return createSimpleOssClient({
    accessKeyId: required(environment.ALIYUN_OSS_ACCESS_KEY_ID, 'ALIYUN_OSS_ACCESS_KEY_ID_REQUIRED'),
    accessKeySecret: required(environment.ALIYUN_OSS_ACCESS_KEY_SECRET, 'ALIYUN_OSS_ACCESS_KEY_SECRET_REQUIRED'),
    securityToken: environment.ALIYUN_OSS_SECURITY_TOKEN || null,
    bucket: required(environment.ALIYUN_OSS_BUCKET, 'ALIYUN_OSS_BUCKET_REQUIRED'),
    endpoint: endpoint ?? required(environment.ALIYUN_OSS_ENDPOINT, 'ALIYUN_OSS_ENDPOINT_REQUIRED'),
  });
}

export function simpleDownloadEndpoint(publicEndpoint, override) {
  return normalizeEndpoint(override || publicEndpoint);
}

export function createSimpleOssClient(configuration, dependencies = {}) {
  const auth = { ...configuration, endpoint: normalizeEndpoint(configuration.endpoint) };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    endpoint: auth.endpoint,
    async headObject(object) {
      const response = await request('HEAD', object);
      if (response.status === 404) return { exists: false, object };
      await assertResponse(response, 'OSS_HEAD_FAILED');
      return { exists: true, object, bytes: Number(response.headers.get('content-length') ?? '0'), sha256: response.headers.get('x-oss-meta-sha256') };
    },
    async getObject(object, missingCode = 'OSS_OBJECT_NOT_FOUND') {
      const response = await request('GET', object);
      await assertResponse(response, response.status === 404 ? missingCode : 'OSS_GET_FAILED');
      return Buffer.from(await response.arrayBuffer());
    },
    async *listObjects(prefix) {
      let marker;
      do {
        const query = { prefix, 'encoding-type': 'url', ...(marker ? { marker } : {}) };
        const response = await request('GET', '', { query });
        await assertResponse(response, 'OSS_LIST_FAILED');
        const xml = await response.text();
        for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) yield decodeURIComponent(key);
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return;
        const next = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1];
        const decoded = next ? decodeURIComponent(next) : undefined;
        invariant(decoded && decoded !== marker, 'OSS_LIST_CONTINUATION_MISSING', 'Artifact listing did not return the next marker');
        marker = decoded;
      } while (marker);
    },
    async putContent(object, body, contentType = 'application/octet-stream') {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const contentSha256 = sha256(bytes);
      const existing = await this.headObject(object);
      if (existing.exists && existing.bytes === bytes.byteLength && existing.sha256 === contentSha256) {
        return { object, status: 'reused', bytes: bytes.byteLength, sha256: `sha256:${contentSha256}` };
      }
      return put(object, bytes, contentType, contentSha256);
    },
    async putObject(object, body, contentType = 'application/octet-stream') {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      return put(object, bytes, contentType, sha256(bytes));
    },
    signGet(object, ttlSeconds = 900) {
      invariant(Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 3600, 'OSS_SIGNED_URL_TTL_INVALID', 'OSS URL lifetime is invalid');
      const expires = Math.floor(now().getTime() / 1000) + ttlSeconds;
      const tokenQuery = auth.securityToken ? `?security-token=${auth.securityToken}` : '';
      const canonicalResource = `/${auth.bucket}/${object}${tokenQuery}`;
      const value = `GET\n\n\n${expires}\n${canonicalResource}`;
      const url = objectUrl(auth, object);
      url.searchParams.set('OSSAccessKeyId', auth.accessKeyId);
      url.searchParams.set('Expires', String(expires));
      if (auth.securityToken) url.searchParams.set('security-token', auth.securityToken);
      url.searchParams.set('Signature', signature(auth.accessKeySecret, value));
      return url.toString();
    },
  });

  async function put(object, bytes, contentType, contentSha256) {
    const contentMd5 = createHash('md5').update(bytes).digest('base64');
    const response = await request('PUT', object, { body: bytes, contentMd5, contentType, ossHeaders: { 'x-oss-meta-sha256': contentSha256 } });
    await assertResponse(response, 'OSS_PUT_FAILED');
    return { object, status: 'uploaded', bytes: bytes.byteLength, sha256: `sha256:${contentSha256}` };
  }

  async function request(method, object, options = {}) {
    const date = now().toUTCString();
    const url = objectUrl(auth, object);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const ossHeaders = { ...(auth.securityToken ? { 'x-oss-security-token': auth.securityToken } : {}), ...(options.ossHeaders ?? {}) };
    const headers = { Date: date, ...ossHeaders };
    if (options.contentMd5) headers['Content-MD5'] = options.contentMd5;
    if (options.contentType) headers['Content-Type'] = options.contentType;
    if (options.body) headers['Content-Length'] = String(options.body.byteLength);
    const canonicalHeaders = Object.entries(ossHeaders)
      .map(([key, value]) => [key.toLowerCase(), String(value).trim()])
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}:${value}\n`)
      .join('');
    const canonicalResource = `/${auth.bucket}/${object}`;
    const value = `${method}\n${options.contentMd5 ?? ''}\n${options.contentType ?? ''}\n${date}\n${canonicalHeaders}${canonicalResource}`;
    headers.Authorization = `OSS ${auth.accessKeyId}:${signature(auth.accessKeySecret, value)}`;
    let response;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetchImpl(url, { method, headers, body: options.body });
      if (![408, 429, 500, 501, 502, 503, 504].includes(response.status) || attempt === 3) return response;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
    return response;
  }
}

function normalizeEndpoint(value) {
  return required(value, 'OSS_ENDPOINT_REQUIRED')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}
function objectUrl(auth, object) {
  return new URL(`https://${auth.bucket}.${auth.endpoint}/${object.split('/').map(encodeURIComponent).join('/')}`);
}
function signature(secret, value) {
  return createHmac('sha1', secret).update(value).digest('base64');
}
async function assertResponse(response, code) {
  if (response.ok) return;
  const detail = (await response.text()).slice(0, 1000);
  throw new DeliveryError(code, `${code}: HTTP ${response.status}`, { status: response.status, detail });
}
function required(value, code) {
  if (value === undefined || value === null || value === '') throw new DeliveryError(code, code);
  return value;
}
