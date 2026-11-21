import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PARENT_NODE = '/opt/sfl/nodes/zhudatuan-l0';
const SHARED_ROOT = '/opt/zhudatuan';
const PARENT_SECRET_PREFIX = 'zhudatuan/nodes/l0/';

const APPLICATIONS = {
  storefront: 'app/dist/start.mjs',
  'catalog-api': 'service/CatalogOperatorApiMain.js',
  'web-api': 'service/WebBusinessApiMain.js',
  'identity-api': 'service/IdentityRegistrationApiMain.js',
  'purchase-api': 'service/PurchaseApiMain.js',
  'catalog-jobs': 'service/CatalogJobsMain.js',
  console: 'static/index.html',
  'auth-web': 'static/index.html',
};

const PAYMENT_APPLICATIONS = {
  'payment-webhook-api': 'service/PaymentWebhookApiMain.js',
  'payment-jobs': 'service/PaymentJobsOnlyMain.js',
};

export function isZhudatuanL0Opening(request) {
  return request.target.runtime_profile_ref === '/opt/sfl/control/autonode/zhudatuan-l0-runtime-profile.json'
    && request.provisioning_request.parent_node_id === 'node:zhudatuan:l0'
    && request.provisioning_request.binding_sources?.domains?.base_domain === 'zhudatuan.com';
}

export function zhudatuanOpeningSecretUnit(instance) {
  return `sfl-autonode-secret-store@${instance}.service`;
}

export async function openingArtifacts(request, saved = null) {
  const payment = request.provisioning_request.resources.payment;
  const targets = payment ? { ...APPLICATIONS, ...PAYMENT_APPLICATIONS } : APPLICATIONS;
  const artifacts = {};
  const missing = [];
  for (const [target, entry] of Object.entries(targets)) {
    const root = ['console', 'auth-web'].includes(target) ? SHARED_ROOT : PARENT_NODE;
    try {
      const release = saved === null ? await realpath(join(root, 'targets', target, 'current')) : saved[target];
      if (!release || !(await stat(join(release, entry))).isFile()) {
        missing.push(target);
        continue;
      }
      artifacts[target] = release;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
      missing.push(target);
    }
  }
  return { artifacts, missing };
}

export async function openingInheritedSecrets(request, environment) {
  const resources = request.provisioning_request.resources;
  const references = {
    'database/catalog-api': null,
    'database/web-api': null,
    'database/identity-api': null,
    'database/purchase-api': null,
    'database/catalog-jobs': null,
  };
  if (resources.wechat_identity ?? true) Object.assign(references, {
    'identity/wechat-applications': 'AUTONODE_ZHUDUATUAN_WECHAT_APPLICATIONS',
    'identity/wechat': 'AUTONODE_ZHUDUATUAN_WECHAT_IDENTITY',
  });
  if (resources.payment) Object.assign(references, {
    'database/payment-webhook-api': null,
    'database/payment-jobs': null,
    'payment/wechat-applications': 'AUTONODE_ZHUDUATUAN_PAYMENT_APPLICATIONS',
    'payment/wechat': 'AUTONODE_ZHUDUATUAN_WECHAT_PAYMENT',
  });
  let source;
  try {
    source = JSON.parse(await readFile(join(SHARED_ROOT, 'shared/secrets.json'), 'utf8'));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw new Error('AUTONODE_L0_SECRET_CATALOG_UNREADABLE');
    source = {};
  }
  const entries = {};
  const missing = [];
  for (const [reference, variable] of Object.entries(references)) {
    const value = source?.[PARENT_SECRET_PREFIX + reference] || (variable && environment[variable]);
    if (typeof value !== 'string' || !value.trim()) missing.push(reference);
    else entries[reference] = value;
  }
  return { entries, missing };
}

export function openingPaymentSecret(value, apiHost, scope) {
  try {
    const configuration = JSON.parse(value);
    const callback = (source) => {
      const url = new URL(source);
      url.host = apiHost;
      return url.href;
    };
    const scoped = configuration.notifyUrlsByScope?.[scope];
    return JSON.stringify({
      ...configuration,
      notifyUrl: callback(configuration.notifyUrl),
      ...(configuration.notifyUrlsByScope === undefined ? {} : {
        notifyUrlsByScope: scoped === undefined ? {} : { [scope]: callback(scoped) },
      }),
    });
  } catch {
    throw new Error('AUTONODE_L0_PAYMENT_CONFIGURATION_INVALID');
  }
}

export function openingSecretUnitFile(nodeDirectory, executable, entry, port, dependents) {
  return `[Unit]
Description=AutoNode child Secret Store
After=network-online.target
Before=${dependents.join(' ')}

[Service]
Type=simple
User=zhudatuan
Group=zhudatuan
EnvironmentFile=${nodeDirectory}/runtime/secret-store.env
ExecStart="${executable}" "${entry}" serve-opening-secrets
ExecStartPost=/usr/bin/curl --fail --silent --show-error --retry 10 --retry-connrefused --max-time 10 --cacert /opt/zhudatuan/shared/tls/internal-ca.crt https://127.0.0.1:${port}/health/ready
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=multi-user.target ${dependents.join(' ')}
`;
}
