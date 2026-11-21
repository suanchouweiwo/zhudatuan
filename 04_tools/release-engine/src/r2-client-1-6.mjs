import { DeliveryError, invariant } from './errors.mjs';
import { sha256 } from './stable.mjs';

export async function r2ClientFromEnvironment(environment = process.env) {
  const accountId = required(environment.CLOUDFLARE_R2_ACCOUNT_ID, 'R2_ACCOUNT_ID_REQUIRED');
  const bucket = required(environment.CLOUDFLARE_R2_BUCKET, 'R2_BUCKET_REQUIRED');
  const endpoint = environment.CLOUDFLARE_R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  const accessKeyId = required(environment.CLOUDFLARE_R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID_REQUIRED');
  const secretAccessKey = required(environment.CLOUDFLARE_R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY_REQUIRED');
  const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    region: 'auto', endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return createR2Client({ bucket, endpoint }, { client, getSignedUrl, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command });
}

export function createR2Client({ bucket, endpoint }, { client, getSignedUrl, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command }) {
  return Object.freeze({
    endpoint,
    async headObject(object) {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object }));
        return { exists: true, object, bytes: response.ContentLength ?? 0, sha256: response.Metadata?.sha256 };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return { exists: false, object };
        throw failure('OSS_HEAD_FAILED', error);
      }
    },
    async getObject(object, missingCode = 'OSS_OBJECT_NOT_FOUND') {
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object }));
        return Buffer.from(await response.Body.transformToByteArray());
      } catch (error) {
        throw failure(error.$metadata?.httpStatusCode === 404 ? missingCode : 'OSS_GET_FAILED', error);
      }
    },
    async *listObjects(prefix) {
      let token;
      do {
        let page;
        try {
          page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        } catch (error) {
          throw failure('OSS_LIST_FAILED', error);
        }
        for (const entry of page.Contents ?? []) if (entry.Key) yield entry.Key;
        if (!page.IsTruncated) return;
        invariant(page.NextContinuationToken && page.NextContinuationToken !== token, 'OSS_LIST_CONTINUATION_MISSING', 'Artifact listing did not return the next page token');
        token = page.NextContinuationToken;
      } while (token);
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
    async signGet(object, ttlSeconds = 900) {
      invariant(Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 3600, 'OSS_SIGNED_URL_TTL_INVALID', 'OSS URL lifetime is invalid');
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: object }), { expiresIn: ttlSeconds });
    },
  });

  async function put(object, bytes, contentType, contentSha256) {
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: object, Body: bytes,
        ContentType: contentType, Metadata: { sha256: contentSha256 } }));
      return { object, status: 'uploaded', bytes: bytes.byteLength, sha256: `sha256:${contentSha256}` };
    } catch (error) {
      throw failure('OSS_PUT_FAILED', error);
    }
  }
}

function failure(code, error) {
  const status = error.$metadata?.httpStatusCode;
  return new DeliveryError(code, `${code}${status ? `: HTTP ${status}` : ''}`, { status, reason: error.name });
}

function required(value, code) {
  if (value === undefined || value === null || value === '') throw new DeliveryError(code, code);
  return value;
}
