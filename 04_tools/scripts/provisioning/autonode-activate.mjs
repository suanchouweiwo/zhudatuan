// Real-provider CLI. `plan` is read-only outside its state root. `apply` and
// `restore` require the exact immutable plan digest printed by `plan`.
//
// node --import tsx 04_tools/scripts/provisioning/autonode-activate.mjs plan \
//   --state-root /var/lib/zhudatuan/autonode --request request.json

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { startLocalHttps } from '../../tools/localinfra/src/Http.ts';
import { secretStoreHandler } from '../../tools/localsecrets/src/Handler.ts';
import { SecretCatalog } from '../../tools/localsecrets/src/SecretCatalog.ts';
import {
  NodeActivationEngine,
  parseNodeActivationRequest,
} from './autonode-activation-engine.mjs';
import { ProductionNodeActivationProvider } from './autonode-production-provider.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'state-root': { type: 'string' },
    'provider-state-root': { type: 'string' },
    request: { type: 'string' },
    'approved-plan-digest': { type: 'string' },
    reason: { type: 'string' },
  },
  strict: true,
});

const command = positionals[0];
if (command === 'serve-opening-secrets') {
  const environment = process.env;
  const catalog = await SecretCatalog.load(environment.LOCAL_SECRETS_FILE);
  await startLocalHttps('localsecrets', Number(environment.LOCAL_SECRETS_PORT),
    secretStoreHandler(catalog, environment.LOCAL_SECRET_STORE_BEARER_TOKEN), {
      certificateFile: environment.LOCAL_TLS_CERT_FILE,
      keyFile: environment.LOCAL_TLS_KEY_FILE,
    }, 1024);
} else {
  await runActivation(command, values);
}

async function runActivation(command, values) {
  if (!['plan', 'status', 'apply', 'rollback', 'restore'].includes(command)
    || !values['state-root'] || !values.request) throw new Error('AUTONODE_ACTIVATION_USAGE_INVALID');
  if ((command === 'apply' || command === 'restore') && !values['approved-plan-digest']) {
    throw new Error('AUTONODE_APPROVED_PLAN_DIGEST_REQUIRED');
  }

  const request = parseNodeActivationRequest(JSON.parse(await readFile(values.request, 'utf8')));
  const providerStateRoot = values['provider-state-root'] ?? join(values['state-root'], 'provider');
  const provider = new ProductionNodeActivationProvider(providerStateRoot);
  const engine = new NodeActivationEngine(values['state-root'], provider);
  let result;
  if (command === 'plan') {
    result = await engine.plan(request);
    result = {
      plan: result.plan,
      waiting_external: await provider.preflight({ request, plan: result.plan, candidate: result.candidate }),
    };
  } else if (command === 'status') {
    result = await engine.read(request);
  } else if (command === 'apply') {
    result = await engine.apply(request, values['approved-plan-digest']);
  } else if (command === 'rollback') {
    result = await engine.rollback(request, values.reason ?? 'approved node rollback');
  } else {
    result = await engine.restore(request, values['approved-plan-digest']);
  }

  process.stdout.write(`${JSON.stringify(summary(command, result), null, 2)}\n`);
}

function summary(selected, value) {
  if (selected === 'plan') return value;
  if (value === null) return null;
  const manifest = value.candidate?.manifest;
  return {
    activation_request_id: value.ledger.activation_request_id,
    node_id: value.ledger.node_id,
    state: value.ledger.state,
    status: value.ledger.status,
    generation: value.ledger.generation,
    waiting_external: value.ledger.waiting_external,
    plan_digest: value.plan.plan_digest,
    node_directory: value.plan.node_directory,
    source_sha: value.plan.source_sha,
    build_id: value.plan.build_id,
    build_count: value.plan.build_count,
    immutable_artifact_digest: value.plan.immutable_artifact_digest,
    result: value.ledger.status === 'ACTIVE' && manifest ? {
      manifest_id: manifest.manifest_id ?? null,
      access_entries: Array.isArray(manifest.domain_bindings) ? manifest.domain_bindings.flatMap((binding) =>
        typeof binding?.surface_ref === 'string' && typeof binding?.host === 'string'
          ? [{ surface_ref: binding.surface_ref, url: `https://${binding.host}` }]
          : []) : [],
    } : null,
  };
}
