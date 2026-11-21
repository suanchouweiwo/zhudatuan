const API_ROOT = 'https://api.cloudflare.com/client/v4';

export class AutoNodeCloudflareClient {
  constructor({ accountId, zoneId, apiToken, fetcher = fetch }) {
    this.accountId = identifier(accountId, 'CLOUDFLARE_ACCOUNT_ID_INVALID');
    this.zoneId = zoneId === undefined ? undefined : identifier(zoneId, 'CLOUDFLARE_ZONE_ID_INVALID');
    this.apiToken = requiredText(apiToken, 'CLOUDFLARE_API_TOKEN_MISSING');
    if (typeof fetcher !== 'function') throw new Error('CLOUDFLARE_FETCH_INVALID');
    this.fetcher = fetcher;
  }

  async ensureTunnel(name, tunnelSecret) {
    const tunnelName = tunnelLabel(name);
    const existing = await this.#request('GET',
      `/accounts/${this.accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
    const matches = existing.filter((tunnel) => tunnel?.name === tunnelName && tunnel?.deleted_at == null);
    if (matches.length > 1) throw new Error(`AUTONODE_CLOUDFLARE_TUNNEL_AMBIGUOUS:${tunnelName}`);
    if (matches.length === 1) {
      return Object.freeze({ id: identifier(matches[0].id, 'CLOUDFLARE_TUNNEL_ID_INVALID'), name: tunnelName, created: false });
    }
    const created = await this.#request('POST', `/accounts/${this.accountId}/cfd_tunnel`, {
      name: tunnelName,
      tunnel_secret: requiredText(tunnelSecret, 'CLOUDFLARE_TUNNEL_SECRET_MISSING'),
      config_src: 'local',
    });
    return Object.freeze({ id: identifier(created.id, 'CLOUDFLARE_TUNNEL_ID_INVALID'), name: tunnelName, created: true });
  }

  async deleteTunnel(tunnelId) {
    try {
      await this.#request('DELETE', `/accounts/${this.accountId}/cfd_tunnel/${identifier(tunnelId, 'CLOUDFLARE_TUNNEL_ID_INVALID')}`);
    } catch (cause) {
      if (!String(cause).includes(':DELETE:404:')) throw cause;
    }
  }

  async zoneForDomain(name) {
    const domain = hostname(name);
    const query = new URLSearchParams({ name: domain, 'account.id': this.accountId, status: 'active' });
    const zones = await this.#request('GET', `/zones?${query}`);
    const matches = zones.filter((zone) => zone?.name === domain && zone.account?.id === this.accountId);
    if (matches.length !== 1) throw new Error(`AUTONODE_CLOUDFLARE_ZONE_UNRESOLVED:${domain}`);
    return identifier(matches[0].id, 'CLOUDFLARE_ZONE_ID_INVALID');
  }

  async ensureCname(name, content, comment) {
    const host = hostname(name);
    const target = hostname(content);
    const zoneId = identifier(this.zoneId, 'CLOUDFLARE_ZONE_ID_INVALID');
    const existing = await this.#request('GET',
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(host)}`);
    if (existing.length > 1) throw new Error(`AUTONODE_CLOUDFLARE_DNS_AMBIGUOUS:${host}`);
    if (existing.length === 1) {
      const record = existing[0];
      if (normalizedHost(record.content) !== target || record.proxied !== true) {
        throw new Error(`AUTONODE_CLOUDFLARE_DNS_CONFLICT:${host}`);
      }
      return Object.freeze({
        id: identifier(record.id, 'CLOUDFLARE_DNS_RECORD_ID_INVALID'),
        name: host,
        content: target,
        comment: typeof record.comment === 'string' ? record.comment : null,
        created: false,
      });
    }
    const created = await this.#request('POST', `/zones/${zoneId}/dns_records`, {
      type: 'CNAME',
      name: host,
      content: target,
      proxied: true,
      ttl: 1,
      comment: requiredText(comment, 'CLOUDFLARE_DNS_COMMENT_MISSING'),
    });
    return Object.freeze({
      id: identifier(created.id, 'CLOUDFLARE_DNS_RECORD_ID_INVALID'),
      name: host,
      content: target,
      comment: typeof created.comment === 'string' ? created.comment : null,
      created: true,
    });
  }

  async deleteDnsRecord(recordId) {
    const zoneId = identifier(this.zoneId, 'CLOUDFLARE_ZONE_ID_INVALID');
    try {
      await this.#request('DELETE', `/zones/${zoneId}/dns_records/${identifier(recordId, 'CLOUDFLARE_DNS_RECORD_ID_INVALID')}`);
    } catch (cause) {
      if (!String(cause).includes(':DELETE:404:')) throw cause;
    }
  }

  async #request(method, path, body) {
    const response = await this.fetcher(`${API_ROOT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`AUTONODE_CLOUDFLARE_RESPONSE_INVALID:${method}:${response.status}`);
    }
    if (!response.ok || payload?.success !== true) {
      const errors = Array.isArray(payload?.errors)
        ? payload.errors.map((error) => error?.message ?? error?.code).filter(Boolean).join('|')
        : '';
      throw new Error(`AUTONODE_CLOUDFLARE_REQUEST_FAILED:${method}:${response.status}:${errors}`);
    }
    return payload.result;
  }
}

function tunnelLabel(value) {
  const name = requiredText(value, 'CLOUDFLARE_TUNNEL_NAME_INVALID');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('CLOUDFLARE_TUNNEL_NAME_INVALID');
  return name;
}

function hostname(value) {
  const host = normalizedHost(requiredText(value, 'CLOUDFLARE_DNS_HOST_INVALID'));
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error('CLOUDFLARE_DNS_HOST_INVALID');
  }
  return host;
}

function normalizedHost(value) {
  return requiredText(value, 'CLOUDFLARE_DNS_HOST_INVALID').toLowerCase().replace(/\.$/, '');
}

function identifier(value, code) {
  const id = requiredText(value, code);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error(code);
  return id;
}

function requiredText(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}
