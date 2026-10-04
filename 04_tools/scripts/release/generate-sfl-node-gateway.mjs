import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      check: { type: 'string' },
      instance: { type: 'string' },
      'node-root': { type: 'string' },
      'gateway-port': { type: 'string' },
      'storefront-port': { type: 'string' },
      'catalog-port': { type: 'string' },
      'web-port': { type: 'string' },
      'identity-port': { type: 'string' },
      'purchase-port': { type: 'string' },
      'webhook-port': { type: 'string' },
      'support-port': { type: 'string' },
      'provisioning-port': { type: 'string' },
      'omit-runtime-config': { type: 'boolean' },
    },
    strict: true,
  });
  if (!values.manifest) throw new Error('SFL_GATEWAY_MANIFEST_REQUIRED');
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
  const instance = values.instance ?? nodeInstance(manifest.node_id);
  const nodeRoot = values['node-root'] ?? `/opt/sfl/nodes/${instance}`;
  const ports = Object.fromEntries(
    ['gateway', 'storefront', 'catalog', 'web', 'identity', 'purchase', 'webhook'].map((name) => {
      const raw = values[`${name}-port`];
      const port = Number(raw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`SFL_GATEWAY_${name.toUpperCase()}_PORT_INVALID`);
      }
      return [name, port];
    }),
  );
  if (values['support-port'] !== undefined) {
    const support = Number(values['support-port']);
    if (!Number.isSafeInteger(support) || support < 1 || support > 65_535) {
      throw new Error('SFL_GATEWAY_SUPPORT_PORT_INVALID');
    }
    ports.support = support;
  }
  if (values['provisioning-port'] !== undefined) {
    const provisioning = Number(values['provisioning-port']);
    if (!Number.isSafeInteger(provisioning) || provisioning < 1 || provisioning > 65_535) {
      throw new Error('SFL_GATEWAY_PROVISIONING_PORT_INVALID');
    }
    ports.provisioning = provisioning;
  }
  const expected = gatewayConfiguration(manifest, nodeRoot, ports, {
    runtimeConfigRoutes: values['omit-runtime-config'] !== true,
  });
  if (values.check) {
    const actual = await readFile(values.check, 'utf8');
    if (actual !== expected) throw new Error(`SFL_GATEWAY_CONFIGURATION_STALE:${values.check}`);
  } else {
    process.stdout.write(expected);
  }
}

export function nodeInstance(nodeId) {
  if (typeof nodeId !== 'string' || !/^node:[a-z0-9][a-z0-9-]*:l[0-9]+$/.test(nodeId)) {
    throw new Error('SFL_GATEWAY_NODE_ID_INVALID');
  }
  const [, name, level] = nodeId.split(':');
  return `${name}-${level}`;
}

export function gatewayConfiguration(manifest, nodeRoot, ports, options = {}) {
  const lifecycleAllowed = manifest?.lifecycle_status === 'active'
    || (options.allowProvisioning === true && manifest?.lifecycle_status === 'provisioning');
  if (manifest?.schema_version !== 'sfl.node-manifest.v1' || !lifecycleAllowed) {
    throw new Error('SFL_GATEWAY_NODE_MANIFEST_INVALID');
  }
  const domains = manifest.domain_bindings ?? [];
  const hosts = (surface) => domains.filter((binding) => binding.surface_ref === `surface:${surface}`).map((binding) => binding.host);
  const apiHosts = hosts('api');
  const identityHosts = hosts('identity');
  const consoleHosts = hosts('console');
  const storefrontHosts = hosts('storefront');
  if (apiHosts.length !== 1 || identityHosts.length !== 1 || consoleHosts.length !== 1 || storefrontHosts.length === 0) {
    throw new Error('SFL_GATEWAY_DOMAIN_BINDINGS_INVALID');
  }
  const apiHost = apiHosts[0];
  const allHosts = [...apiHosts, ...identityHosts, ...consoleHosts, ...storefrontHosts];
  if (new Set(allHosts).size !== allHosts.length) throw new Error('SFL_GATEWAY_DOMAIN_BINDINGS_AMBIGUOUS');
  const loopback = options.httpLoopback === true;
  const proxy = (port) => `\t\treverse_proxy 127.0.0.1:${port} {\n\t\t\theader_up Host {http.request.host}\n${loopback ? '\t\t\theader_up X-Forwarded-Proto https\n' : ''}\t\t\theader_up X-Real-IP {http.request.header.CF-Connecting-IP}\n\t\t\theader_up -X-Sfl-Node-Id\n\t\t\theader_up -X-Sfl-Node-Manifest-Id\n\t\t\theader_up -X-Sfl-Node-Surface\n\t\t\theader_up -X-Zdt-Identity-Entry-Host\n\t\t}`;
  return `# Generated from ${manifest.manifest_id} (${manifest.manifest_digest}). Do not hand edit.\n` +
`{\n\tadmin off\n\tauto_https off\n}\n\n` +
`${loopback ? 'http://:' : 'https://:'}${ports.gateway} {\n${loopback ? '\tbind 127.0.0.1\n' : ''}` +
`${loopback ? '' : `\ttls ${nodeRoot}/runtime/tls/origin.crt ${nodeRoot}/runtime/tls/origin.key\n`}\tencode gzip\n\n` +
`${manifest.node_id === 'node:zhudatuan:l0' && storefrontHosts.includes('zhudatuan.com') && storefrontHosts.includes('www.zhudatuan.com') ? '\t@storefrontCanonical host zhudatuan.com\n\thandle @storefrontCanonical {\n\t\tredir https://www.zhudatuan.com{uri} 308\n\t}\n\n' : ''}` +
`\t@ordersReadPreflight {\n\t\thost ${apiHost}\n\t\tmethod OPTIONS\n\t\tpath /api/v1/orders /api/v1/orders/*\n\t\theader Access-Control-Request-Method GET\n\t}\n` +
`\thandle @ordersReadPreflight {\n${proxy(ports.web)}\n\t}\n\n` +
`\t@purchaseWrite {\n\t\thost ${apiHost}\n\t\tmethod POST OPTIONS\n\t\tpath /api/v1/checkouts/quotes /api/v1/orders /api/v1/payments/intents\n\t}\n` +
`\thandle @purchaseWrite {\n${proxy(ports.purchase)}\n\t}\n\n` +
`\t@paymentRead {\n\t\thost ${apiHost}\n\t\tmethod GET HEAD OPTIONS\n\t\tpath /api/v1/payments/intents/*\n\t}\n` +
`\thandle @paymentRead {\n${proxy(ports.purchase)}\n\t}\n\n` +
`\t@ordersRead {\n\t\thost ${apiHost}\n\t\tmethod GET HEAD\n\t\tpath /api/v1/orders /api/v1/orders/*\n\t}\n` +
`\thandle @ordersRead {\n${proxy(ports.web)}\n\t}\n\n` +
`\t@storefrontPublicCatalog {\n\t\thost ${storefrontHosts.join(' ')}\n\t\tmethod GET HEAD OPTIONS\n\t\tpath /api/v1/catalog/public/products*\n\t}\n` +
`\thandle @storefrontPublicCatalog {\n${proxy(ports.web)}\n\t}\n\n` +
`\t@webBusiness {\n\t\thost ${apiHost}\n\t\tpath /api/v1/members/me* /api/v1/organizations/layers* /api/v1/reports/dashboard* /api/v1/catalog/listings /api/v1/catalog/public/products* /api/v1/pricing/offers* /api/v1/inventory/availability* /api/v1/carts/current* /api/v1/benefits/accounts* /api/v1/benefits/ledgers*\n\t}\n` +
`\thandle @webBusiness {\n${proxy(ports.web)}\n\t}\n\n` +
`${ports.provisioning ? `\t@mallProvisioning {\n\t\thost ${apiHost}\n\t\tmethod GET POST OPTIONS\n\t\tpath /api/v1/provisioning/malls /api/v1/provisioning/malls/* /api/v1/provisioning/node-tasks/*\n\t}\n` +
`\thandle @mallProvisioning {\n${proxy(ports.provisioning)}\n\t}\n\n` : ''}` +
`\t@catalogImports {\n\t\thost ${apiHost}\n\t\tpath /api/v1/catalog/imports*\n\t}\n` +
`\thandle @catalogImports {\n${proxy(ports.catalog)}\n\t}\n\n` +
`\t@catalogBatch {\n\t\thost ${apiHost}\n\t\tmethod POST OPTIONS\n\t\tpath /api/v1/catalog/listings/batches\n\t}\n` +
`\thandle @catalogBatch {\n${proxy(ports.catalog)}\n\t}\n\n` +
`\t@catalogPublication {\n\t\thost ${apiHost}\n\t\tmethod PUT DELETE OPTIONS\n\t\tpath_regexp publication ^/api/v1/catalog/listings/[^/]+/publication$\n\t}\n` +
`\thandle @catalogPublication {\n${proxy(ports.catalog)}\n\t}\n\n` +
`\t@paymentWebhook {\n\t\thost ${apiHost}\n\t\tmethod POST\n\t\tpath /api/v1/webhooks/wechat/payment\n\t}\n` +
`\thandle @paymentWebhook {\n${proxy(ports.webhook)}\n\t}\n\n` +
`${ports.support ? `\t@supportApi {\n\t\thost ${apiHost}\n\t\tpath /api/v1/support /api/v1/support/*\n\t}\n` +
`\thandle @supportApi {\n${proxy(ports.support)}\n\t}\n\n` : ''}` +
`\t@identityApi {\n\t\thost ${apiHost}\n\t\tpath /api/v1/*\n\t}\n` +
`\thandle @identityApi {\n${proxy(ports.identity)}\n\t}\n\n` +
`\t@gatewayHealth {\n\t\thost ${apiHost}\n\t\tpath /health/gateway\n\t}\n` +
`\thandle @gatewayHealth {\n\t\theader Content-Type application/json\n\t\trespond \`${JSON.stringify({ status: 'ready', nodeId: manifest.node_id, manifestId: manifest.manifest_id })}\` 200\n\t}\n\n` +
`${options.runtimeConfigRoutes === false ? '' : `\t@identityRuntime {\n\t\thost ${identityHosts.join(' ')}\n\t\tpath /identity-runtime.json\n\t}\n` +
`\thandle @identityRuntime {\n\t\troot * ${nodeRoot}/runtime\n\t\tfile_server\n\t}\n\n` +
``}` +
`\t@accounts host ${identityHosts.join(' ')}\n\thandle @accounts {\n\t\t@accountsEntry not path /assets/* /brand/*\n\t\trequest_header @accountsEntry -If-None-Match\n\t\trequest_header @accountsEntry -If-Modified-Since\n\t\theader @accountsEntry Cache-Control "no-store"\n\t\theader @accountsEntry -Etag\n\t\troot * ${nodeRoot}/targets/auth-web/current/static\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n\n` +
`${options.runtimeConfigRoutes === false ? '' : `\t@consoleRuntime {\n\t\thost ${consoleHosts.join(' ')}\n\t\tpath /console-runtime.json\n\t}\n` +
`\thandle @consoleRuntime {\n\t\troot * ${nodeRoot}/runtime\n\t\tfile_server\n\t}\n\n` +
``}` +
`\t@console host ${consoleHosts.join(' ')}\n\thandle @console {\n\t\t@consoleEntry not path /assets/* /brand/*\n\t\trequest_header @consoleEntry -If-None-Match\n\t\trequest_header @consoleEntry -If-Modified-Since\n\t\theader @consoleEntry Cache-Control "no-store"\n\t\theader @consoleEntry -Etag\n\t\troot * ${nodeRoot}/targets/console/current/static\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n\n` +
`\t@storefront host ${storefrontHosts.join(' ')}\n\thandle @storefront {\n${proxy(ports.storefront)}\n\t}\n\n` +
`\thandle {\n\t\theader Content-Type application/json\n\t\trespond \`{"code":"NODE_BOUNDARY_HOST_MISMATCH"}\` 421\n\t}\n}\n`;
}
