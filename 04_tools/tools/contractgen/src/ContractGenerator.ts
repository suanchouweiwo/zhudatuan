import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { PERMISSION_CATALOG } from '../../../../01_core_hexin/packages/authz/src/PermissionCatalog';
import { buildOpenapi, operationSource, schemaSource, sdkDomainSources, sdkSource, type OperationDefinition } from './ClientArtifacts';

interface EventDefinition {
  readonly id: string;
  readonly owner: string;
  readonly version: number;
  readonly schema: string;
  readonly handlers: readonly string[];
}

interface CapabilityDefinition {
  readonly code: string;
  readonly kind: string;
  readonly audience?: OperationDefinition['audience'];
}

interface ErrorDefinition {
  readonly code: string;
  readonly status: number;
}

type RawOperationDefinition = Omit<OperationDefinition, 'availability' | 'execution' | 'expectedVersion' | 'idempotency' | 'summary'> & Partial<Pick<OperationDefinition, 'availability' | 'execution' | 'expectedVersion' | 'idempotency' | 'summary'>> & Readonly<{
  controller?: unknown;
  handler?: unknown;
  sdk?: unknown;
}>;

type NormalizedOperationDefinition = OperationDefinition & Required<Pick<OperationDefinition,
  'availability' | 'execution' | 'expectedVersion' | 'idempotency' | 'summary' | 'title' | 'targets'
  | 'node_profiles_allowed' | 'requestSchema' | 'responseSchema' | 'errorUnion' | 'capability'
  | 'scope_resolver_ref' | 'idempotencyScope' | 'assuranceLevel' | 'makerChecker' | 'sensitiveFields'
  | 'csrfPolicy' | 'originPolicy' | 'targetPolicy' | 'responseMode' | 'cachePolicy' | 'rateClass'
  | 'timeout' | 'sdk' | 'writePath' | 'stateMachine' | 'businessNumber' | 'operationHash'>>;

const root = resolve(import.meta.dirname, '../../../..');
const definitions = resolve(root, '01_core_hexin/packages/contract/definitions');
const CRITICAL_WRITE_DOMAINS = new Set(['access', 'benefit', 'finance', 'identity', 'inventory', 'invoice', 'member', 'order', 'payment', 'provisioning', 'voucher']);
const DEFAULT_OPERATION_ERRORS = Object.freeze(['CONTRACT_REQUEST_INVALID', 'CONTRACT_RESPONSE_INVALID', 'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED', 'STATE_INVALID', 'SCOPE_DENIED', 'VERSION_CONFLICT']);
const rawOperations = await catalog<RawOperationDefinition>('operations.yml', 'operations');
const operations = normalizeOperations(rawOperations);
const runtimeOperations = operations.filter((operation) => operation.availability === 'runtime');
const events = await catalog<EventDefinition>('events.yml', 'events');
const capabilities = await catalog<CapabilityDefinition>('capabilities.yml', 'capabilities');
const errors = await catalog<ErrorDefinition>('errors.yml', 'errors');
validateOperations(operations, rawOperations);
validateEvents(events);
validatePermissions(operations);
validateCapabilityAudiences(operations, capabilities);
validateErrors(errors);
const check = process.argv.includes('--check');
const contractSdkOnly = process.argv.includes('--scope=contract-sdk');
const databaseOnly = process.argv.includes('--scope=database');
const permissionMetadata = new Map(PERMISSION_CATALOG.map(({ code, risk, stepup, scopes }) => [code, { risk, stepup, scopes }]));
const openapi = buildOpenapi(operations, permissionMetadata);
const eventArtifact = stable({ version: 1, events: events.map((item) => ({ type: item.id, version: item.version, module: item.owner })) });
const permissionArtifact = PERMISSION_CATALOG.map(({ code, category, risk, stepup, scopes }) => ({ code, category, risk, stepup, scopes }));
const errorArtifact = errors.map(({ code, status }) => ({ code, status }));
// OMS links are design provenance; without a path/schema/permission change they do not rotate the published runtime identity.
const contractChecksum = hash(JSON.stringify({ openapi: contractIdentityOpenapi(openapi), events: eventArtifact, permissions: permissionArtifact, errors: errorArtifact }));

if (databaseOnly) {
  await emitDatabaseArtifact(contractChecksum, runtimeOperations);
} else {
  await emit(resolve(root, '01_core_hexin/packages/contract/openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
  await emit(resolve(root, '01_core_hexin/packages/contract/events.json'), `${JSON.stringify(eventArtifact, null, 2)}\n`);
  await emit(resolve(root, '01_core_hexin/packages/contract/src/operations/CommerceOperations.ts'), operationSource(operations, permissionMetadata));
  await emit(resolve(root, '01_core_hexin/packages/contract/src/operations/CommerceSchemas.ts'), schemaSource(operations));
  await emit(resolve(root, '01_core_hexin/packages/contract/src/events/CommerceEvents.ts'), eventSource(events));
  await emit(resolve(root, '01_core_hexin/packages/contract/src/EventSerializer.ts'), eventSerializerSource(events));
  await emit(resolve(root, '01_core_hexin/packages/contract/src/ContractIdentity.generated.ts'), contractIdentitySource(contractChecksum));
  await emit(resolve(root, '01_core_hexin/packages/contract/src/ErrorContract.generated.ts'), errorSource(errors));
  await emit(resolve(root, '01_core_hexin/packages/sdk/src/operations/CommerceClient.generated.ts'), sdkSource(operations));
  for (const [domain, source] of sdkDomainSources(operations)) {
    await emit(resolve(root, `01_core_hexin/packages/sdk/src/operations/${domain}.ts`), source);
  }
  if (!contractSdkOnly) await emitRuntimeArtifacts(contractChecksum, runtimeOperations);
}

async function catalog<T>(name: string, key: string): Promise<readonly T[]> {
  const payload = parse(await readFile(resolve(definitions, name), 'utf8')) as Record<string, unknown>;
  const values = payload[key];
  if (!Array.isArray(values)) throw new Error(`CONTRACT_DEFINITION_INVALID:${name}:${key}`);
  return values as readonly T[];
}

function normalizeOperations(values: readonly RawOperationDefinition[]): readonly NormalizedOperationDefinition[] {
  return values.map((item) => {
    const idempotency = item.idempotency ?? (item.method === 'GET' || item.audience === 'provider' ? 'none' : 'required');
    const expectedVersion = item.expectedVersion ?? (item.method === 'GET' ? 'none' : 'optional');
    const execution = item.execution ?? 'sync';
    const availability = item.availability ?? 'runtime';
    const summary = item.summary ?? item.id;
    const writePath = item.writePath ?? operationWritePath(item);
    const permission = item.permission === undefined ? undefined : PERMISSION_CATALOG.find(({ code }) => code === item.permission);
    const normalized = {
      id: item.id, owner: item.owner, method: item.method, path: item.path, audience: item.audience,
      ...(item.stepup === undefined ? {} : { stepup: item.stepup }),
      ...(item.permission === undefined ? {} : { permission: item.permission }), idempotent: item.idempotent,
      idempotency, expectedVersion, execution, availability, summary, schema: item.schema,
      title: item.title ?? summary,
      targets: Object.freeze([...(item.targets ?? operationTargets(item.audience))]),
      node_profiles_allowed: Object.freeze([...(item.node_profiles_allowed ?? operationNodeProfiles(item.audience))]),
      requestSchema: item.requestSchema ?? schemaName(item.id, 'Request'),
      responseSchema: item.responseSchema ?? schemaName(item.id, 'Response'),
      errorUnion: Object.freeze([...(item.errorUnion ?? DEFAULT_OPERATION_ERRORS)]),
      capability: item.capability ?? item.permission ?? item.id,
      scope_resolver_ref: item.scope_resolver_ref ?? (['public', 'provider'].includes(item.audience) ? 'scope.none.v1' : 'access.resolve_scope.v1'),
      idempotencyScope: item.idempotencyScope ?? (writePath === 'none' ? 'none' : 'operation+realm+node+membership+business-key'),
      assuranceLevel: item.assuranceLevel ?? (permission?.stepup ? 2 : 1),
      makerChecker: item.makerChecker ?? false,
      sensitiveFields: Object.freeze([...(item.sensitiveFields ?? sensitiveFields(item.id))]),
      csrfPolicy: item.csrfPolicy ?? (['member', 'operator'].includes(item.audience) && item.method !== 'GET' ? 'session' : 'none'),
      originPolicy: item.originPolicy ?? (['public', 'provider'].includes(item.audience) ? 'public' : 'same-node'),
      targetPolicy: item.targetPolicy ?? (['public', 'provider'].includes(item.audience) ? 'public' : 'resolved-node'),
      responseMode: item.responseMode ?? (item.id === 'payment.webhooks.wechat' ? 'empty' : 'json'),
      cachePolicy: item.cachePolicy ?? (item.method === 'GET' ? (item.audience === 'public' ? 'public' : 'private') : 'none'),
      rateClass: item.rateClass ?? permission?.risk ?? 'low', timeout: item.timeout ?? 10_000,
      sdk: String(item.sdk ?? ''), writePath,
      stateMachine: item.stateMachine ?? (writePath === 'none' ? 'none' : `${item.id}.execution.v1`),
      businessNumber: item.businessNumber ?? (writePath === 'none' ? 'none' : `SFL-${item.owner.toUpperCase()}-{sha256:16}`),
      ...(item.requestFields === undefined ? {} : { requestFields: Object.freeze([...item.requestFields]) }),
      ...(item.responseFields === undefined ? {} : { responseFields: Object.freeze([
        ...new Set([...item.responseFields, 'code', 'message', 'requestId', 'retryable', 'details']),
      ]) }),
      ...(item.gates === undefined ? {} : { gates: Object.freeze(item.gates.map((gate) => Object.freeze({ ...gate }))) }),
      requirements: Object.freeze([...item.requirements]),
    } satisfies Omit<NormalizedOperationDefinition, 'operationHash'>;
    return Object.freeze({ ...normalized, operationHash: hash(JSON.stringify(stable(normalized))) });
  });
}

function operationWritePath(item: RawOperationDefinition): NormalizedOperationDefinition['writePath'] {
  if (item.method === 'GET' || /\.(?:read|preview|verify|quote)$/.test(item.id)) return 'none';
  if (item.id === 'payment.webhooks.wechat') return 'provider';
  if (item.id === 'payment.intents.create' || item.id === 'identity.wechat.session' || item.id === 'identity.wechat.bind') return 'durable';
  return CRITICAL_WRITE_DOMAINS.has(item.id.split('.')[0]!) ? 'transactional' : 'none';
}

function operationTargets(audience: OperationDefinition['audience']): readonly string[] {
  return audience === 'member' ? ['storefront'] : audience === 'operator' ? ['console'] : [audience];
}

function operationNodeProfiles(audience: OperationDefinition['audience']): readonly ('operating_mall' | 'consumer')[] {
  return audience === 'provider' ? ['operating_mall'] : ['operating_mall', 'consumer'];
}

function schemaName(id: string, suffix: string): string {
  return `${id.split('.').map((segment) => `${segment[0]!.toUpperCase()}${segment.slice(1)}`).join('')}${suffix}`;
}

function sensitiveFields(id: string): readonly string[] {
  if (id.startsWith('identity.')) return ['password', 'code', 'token', 'proof', 'mobile', 'destination', 'bindingToken'];
  if (id.startsWith('payment.')) return ['payer', 'providerCredential', 'rawBody'];
  return [];
}

function validateOperations(values: readonly NormalizedOperationDefinition[], sources: readonly RawOperationDefinition[]): void {
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const [index, item] of values.entries()) {
    const source = sources[index]!;
    if (!/^[a-z]+(?:\.[a-z]+)+$/.test(item.id) || ids.has(item.id)) throw new Error(`OPERATION_ID_INVALID:${item.id}`);
    const pathAllowed = item.path.startsWith('/api/v1/') || (item.id.startsWith('runtime.health.') && item.path.startsWith('/health/'));
    if (!pathAllowed || routes.has(`${item.method} ${item.path}`)) throw new Error(`OPERATION_ROUTE_INVALID:${item.id}`);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method)) throw new Error(`OPERATION_METHOD_INVALID:${item.id}`);
    if (!['public', 'member', 'operator', 'provider'].includes(item.audience)) throw new Error(`OPERATION_AUDIENCE_INVALID:${item.id}`);
    if (!['runtime', 'frozen'].includes(item.availability)) throw new Error(`OPERATION_AVAILABILITY_INVALID:${item.id}`);
    if (!['sync', 'async'].includes(item.execution)) throw new Error(`OPERATION_EXECUTION_INVALID:${item.id}`);
    if (!['none', 'required'].includes(item.idempotency)) throw new Error(`OPERATION_IDEMPOTENCY_INVALID:${item.id}`);
    if (!['none', 'optional', 'required'].includes(item.expectedVersion)) throw new Error(`OPERATION_VERSION_POLICY_INVALID:${item.id}`);
    if (typeof item.idempotent !== 'boolean') throw new Error(`OPERATION_IDEMPOTENT_INVALID:${item.id}`);
    if (item.summary.trim().length === 0) throw new Error(`OPERATION_SUMMARY_INVALID:${item.id}`);
    if (item.schema !== 'named' && item.schema !== 'structural') throw new Error(`OPERATION_SCHEMA_INVALID:${item.id}`);
    if (item.writePath !== 'none' && item.schema !== 'named') throw new Error(`OPERATION_WRITE_SCHEMA_NOT_NAMED:${item.id}`);
    if (item.writePath !== 'none' && item.idempotency !== 'required' && item.writePath !== 'provider') {
      throw new Error(`OPERATION_WRITE_IDEMPOTENCY_NOT_REQUIRED:${item.id}`);
    }
    if (!/^[A-Z][A-Za-z0-9]+Request$/.test(item.requestSchema) || !/^[A-Z][A-Za-z0-9]+Response$/.test(item.responseSchema)) {
      throw new Error(`OPERATION_SCHEMA_REF_INVALID:${item.id}`);
    }
    if (item.errorUnion.length === 0 || item.targets.length === 0 || item.node_profiles_allowed.length === 0
      || item.scope_resolver_ref.length === 0 || item.sdk.length === 0 || item.timeout < 1) {
      throw new Error(`OPERATION_STRONG_CONTRACT_INCOMPLETE:${item.id}`);
    }
    for (const gate of item.gates ?? []) {
      if (!['identity', 'permission', 'risk', 'finance'].includes(gate.slot)) throw new Error(`OPERATION_GATE_SLOT_INVALID:${item.id}`);
      if (gate.phase !== 'before') throw new Error(`OPERATION_GATE_PHASE_INVALID:${item.id}`);
      if (!['disabled', 'observe'].includes(gate.mode)) throw new Error(`OPERATION_GATE_MODE_INVALID:${item.id}`);
    }
    if (item.requirements.length === 0 || item.requirements.some((id) => !/^(?:MVP(?:0[3-9]|1\d|2[0-3])|OMS-(?:00[1-9]|01[0-4]))$/.test(id))) {
      throw new Error(`OPERATION_REQUIREMENT_INVALID:${item.id}`);
    }
    const domain = item.id.split('.')[0]!;
    if (source.sdk !== `01_core_hexin/packages/sdk/src/operations/${domain}.ts`) throw new Error(`OPERATION_SDK_TARGET_INVALID:${item.id}`);
    if (item.availability === 'frozen' && item.owner !== domain) throw new Error(`OPERATION_OWNER_INVALID:${item.id}:${item.owner}`);
    if (item.availability === 'frozen' && ['availability', 'execution', 'expectedVersion', 'idempotency', 'summary'].some((field) => !Object.hasOwn(source, field))) {
      throw new Error(`OPERATION_POLICY_NOT_EXPLICIT:${item.id}`);
    }
    if (item.method === 'GET' && (!item.idempotent || item.idempotency !== 'none' || item.expectedVersion !== 'none' || item.execution !== 'sync')) {
      throw new Error(`OPERATION_GET_POLICY_INVALID:${item.id}`);
    }
    if (item.execution === 'async' && (item.method === 'GET' || item.idempotency !== 'required')) throw new Error(`OPERATION_ASYNC_POLICY_INVALID:${item.id}`);
    if (item.idempotency === 'required' && item.method === 'GET') throw new Error(`OPERATION_IDEMPOTENCY_METHOD_INVALID:${item.id}`);
    if (item.expectedVersion === 'required' && item.method === 'GET') throw new Error(`OPERATION_VERSION_METHOD_INVALID:${item.id}`);
    ids.add(item.id);
    routes.add(`${item.method} ${item.path}`);
  }
}

function validateEvents(values: readonly EventDefinition[]): void {
  const ids = new Set<string>();
  for (const item of values) {
    if (!/^[a-z]+(?:\.[a-z]+)+$/.test(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.version) || item.version < 1) throw new Error(`EVENT_DEFINITION_INVALID:${item.id}`);
    ids.add(item.id);
  }
}

function validatePermissions(values: readonly OperationDefinition[]): void {
  const definitions = new Set(PERMISSION_CATALOG.map(({ code }) => code));
  for (const operation of values) {
    if (operation.permission !== undefined && !definitions.has(operation.permission)) {
      throw new Error(`OPERATION_PERMISSION_UNKNOWN:${operation.id}:${operation.permission}`);
    }
  }
}

function validateCapabilityAudiences(values: readonly OperationDefinition[], capabilities: readonly CapabilityDefinition[]): void {
  const operations = new Map(values.map((operation) => [operation.id, operation]));
  for (const capability of capabilities) {
    if (capability.kind !== 'operation') continue;
    const operation = operations.get(capability.code);
    if (operation !== undefined && capability.audience !== operation.audience) {
      throw new Error(`OPERATION_AUDIENCE_DRIFT:${operation.id}:${operation.audience}:${capability.audience ?? 'missing'}`);
    }
  }
}

function validateErrors(values: readonly ErrorDefinition[]): void {
  const codes = new Set<string>();
  let previous = '';
  for (const error of values) {
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(error.code) || codes.has(error.code)) throw new Error(`ERROR_CODE_INVALID:${error.code}`);
    if (!Number.isSafeInteger(error.status) || error.status < 400 || error.status > 599) throw new Error(`ERROR_STATUS_INVALID:${error.code}`);
    if (error.code.localeCompare(previous) <= 0) throw new Error(`ERROR_CATALOG_NOT_SORTED:${error.code}`);
    codes.add(error.code);
    previous = error.code;
  }
}

async function emit(path: string, content: string): Promise<void> {
  if (!check) {
    await writeFile(path, content, 'utf8');
    return;
  }
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current !== content) throw new Error(`GENERATED_CONTRACT_DRIFT:${path}`);
}

async function emitRuntimeArtifacts(contractChecksum: string, values: readonly OperationDefinition[]): Promise<void> {
  const miniappApi = resolve(root, '01_core_hexin/apps/miniapp/miniprogram/api');
  const miniappPresent = await stat(miniappApi)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (miniappPresent) {
    await emit(resolve(miniappApi, 'identity.js'), miniappIdentitySource(contractChecksum));
    await emit(resolve(miniappApi, 'operations.js'), miniappSource(values, permissionMetadata));
  }
  await emit(resolve(root, '01_core_hexin/services/commerce/src/foundation/application/OperationHandler.ts'), hardenedHandlerSource(values));
  await emit(resolve(root, '01_core_hexin/services/commerce/src/foundation/interface/OperationController.ts'), hardenedControllerSource(values));
  await emit(resolve(root, '01_core_hexin/services/commerce/src/app/events.ts'), eventRegistrySource(events));

  await emitDatabaseArtifact(contractChecksum, values);
}

async function emitDatabaseArtifact(contractChecksum: string, values: readonly OperationDefinition[]): Promise<void> {
  const template = await readFile(resolve(root, '02_platform_pingtai/database/contracts/publish.template.sql'), 'utf8');
  const operationRows = values.map((item) => sqlRow([item.id, item.owner, item.method, item.path, '1.0.0'])).join(',\n');
  const eventRows = events.map((item) => sqlRow([item.id, item.version, item.owner, item.schema])).join(',\n');
  const capabilityRows = values.map((item) => sqlRow([item.id, 'operation', item.id, 1, 'active'])).join(',\n');
  const bindings = values.map((item) => sqlRow([item.id, item.id, item.permission ?? null, item.audience])).join(',\n');
  const usedPermissions = new Set(values.flatMap((item) => (item.permission ? [item.permission] : [])));
  const permissions = PERMISSION_CATALOG.filter(({ code }) => usedPermissions.has(code))
    .sort((left, right) => left.code.localeCompare(right.code))
    .map(({ code, risk }) => sqlRow([`permission:${hash(code).slice(0, 24)}`, code, risk, 'active']))
    .join(',\n');
  const migration = template
    .replace('{{OPERATIONS}}', operationRows)
    .replace('{{EVENTS}}', eventRows)
    .replace('{{CAPABILITIES}}', capabilityRows)
    .replace('{{OPERATIONCAPABILITIES}}', bindings)
    .replace('{{PERMISSIONS}}', permissions)
    .replace('{{CONTRACTCHECKSUM}}', contractChecksum);
  await emit(resolve(root, '02_platform_pingtai/database/contracts/current.sql'), migration);
}

function errorSource(values: readonly ErrorDefinition[]): string {
  const rows = values.map(({ code, status }) => `  ${JSON.stringify([code, status])},`).join('\n');
  return `// Generated from definitions/errors.yml. Do not edit.\nexport { ErrorContractSchema } from './ErrorSchema';\nexport type { ErrorContract } from './ErrorSchema';\n\nconst rows = [\n${rows}\n] as const;\n\nexport const ERROR_CODES = Object.freeze(rows.map(([code]) => code));\nexport type ErrorCode = (typeof rows)[number][0];\nconst statuses: ReadonlyMap<string, number> = new Map(rows);\nexport function errorStatus(code: string): number | undefined { return statuses.get(code); }\n`;
}

function eventSource(values: readonly EventDefinition[]): string {
  const rows = values.map((item) => `  eventContract(${JSON.stringify({ type: item.id, version: item.version, module: item.owner })}),`).join('\n');
  return `// Generated from definitions/events.yml. Do not edit.\nimport { eventContract } from '../EventContract';\n\nexport const COMMERCE_EVENTS = Object.freeze([\n${rows}\n] as const);\n`;
}

function eventSerializerSource(values: readonly EventDefinition[]): string {
  const ids = values.map((item) => `  '${item.id}',`).join('\n');
  return `// Generated from definitions/events.yml. Do not edit.\nimport type { EventContract } from './EventContract';\n\nexport const SERIALIZED_EVENT_TYPES = Object.freeze([\n${ids}\n] as const);\n\nexport interface SerializedEvent {\n  readonly type: string;\n  readonly version: number;\n  readonly module: string;\n  readonly payload: unknown;\n}\n\nexport function serializeEvent(contract: EventContract, payload: unknown): SerializedEvent {\n  return Object.freeze({ type: contract.type, version: contract.version, module: contract.module, payload });\n}\n`;
}

function contractIdentitySource(checksum: string): string {
  return ['// Generated from the canonical operation and event definitions. Do not edit.', "export const CONTRACT_VERSION = '1.0.0' as const;", "export const CONTRACT_CHECKSUM = '" + checksum + "' as const;", ''].join('\n');
}

function miniappIdentitySource(checksum: string): string {
  return ['// Generated from the canonical operation and event definitions. Do not edit.', "module.exports = Object.freeze({ version: '1.0.0', checksum: '" + checksum + "' });", ''].join('\n');
}

function eventRegistrySource(values: readonly EventDefinition[]): string {
  const ids = values.map((item) => `  '${item.id}',`).join('\n');
  const handlers = values.map((item) => `  [${JSON.stringify(item.id)}, Object.freeze(${JSON.stringify(item.handlers)})],`).join('\n');
  return `// Generated from 01_core_hexin/packages/contract/definitions/events.yml. Do not edit.\nimport { COMMERCE_EVENTS } from '@shop/contract';\n\nexport const EVENT_SCHEMA_TYPES = Object.freeze([\n${ids}\n] as const);\n\nexport const EVENT_HANDLERS = new Map<string, readonly string[]>([\n${handlers}\n]);\n\nconst versions = new Map<string, number>(COMMERCE_EVENTS.map((event) => [event.type, event.version]));\n\nexport function eventVersion(type: string): number {\n  const version = versions.get(type);\n  if (version === undefined) throw new Error('EVENT_SCHEMA_UNKNOWN');\n  return version;\n}\n`;
}

function miniappSource(values: readonly OperationDefinition[], permissions: ReadonlyMap<string, Readonly<{ risk: string; stepup: boolean; scopes: readonly string[] }>>): string {
  const definitions = Object.fromEntries(
    values.map((item) => {
      const permission = item.permission === undefined ? undefined : permissions.get(item.permission);
      return [
        item.id,
        {
          method: item.method,
          path: item.path,
          audience: item.audience,
          idempotent: item.idempotent,
          idempotency: item.method === 'GET' || item.audience === 'provider' ? 'none' : 'required',
          expectedVersion: item.expectedVersion ?? (item.method === 'GET' ? 'none' : 'optional'),
          risk: permission?.risk ?? 'low',
          stepup: permission?.stepup ?? false,
          scopeKinds: permission?.scopes ?? [],
          schema: item.schema,
        },
      ];
    })
  );
  const groups = new Map<string, OperationDefinition[]>();
  for (const operation of values) {
    const domain = operation.id.split('.')[0]!;
    const current = groups.get(domain) ?? [];
    current.push(operation);
    groups.set(domain, current);
  }
  const clients = [...groups]
    .map(([domain, operations]) => {
      const methods = operations.map((operation) => `    ${miniappMethodName(operation.id)}: bind(execute, ${JSON.stringify(operation.id)}),`).join('\n');
      return `  ${domain}: Object.freeze({\n${methods}\n  }),`;
    })
    .join('\n');
  return `// Generated from definitions/operations.yml. Do not edit.\nconst definitions = Object.freeze(${JSON.stringify(definitions, null, 2)});\n\n/** @param {(id: string, input?: any, context?: any) => Promise<any>} execute */\nfunction createOperations(execute) {\n  if (typeof execute !== 'function') throw new Error('MINIAPP_OPERATION_EXECUTOR_REQUIRED');\n  return Object.freeze({\n${clients}\n  });\n}\n\n/** @param {(id: string, input?: any, context?: any) => Promise<any>} execute @param {string} id */\nfunction bind(execute, id) { return (input = {}, context = {}) => execute(id, input, context); }\n\nmodule.exports = Object.freeze({ createOperations, definitions });\n`;
}

function miniappMethodName(id: string): string {
  const [, ...segments] = id.split('.');
  return segments.map((segment, index) => (index === 0 ? segment : `${segment[0]!.toUpperCase()}${segment.slice(1)}`)).join('');
}

function handlerSource(values: readonly OperationDefinition[]): string {
  const ids = values.map((item) => `  '${item.id}',`).join('\n');
  return `// Generated shell from definitions/operations.yml. Do not edit.\nimport type { OperationId } from '@shop/contract';\nimport type { AccessContext } from '../security/AccessContext';\nimport type { Handler } from './Handler';\n\nexport const HANDLED_OPERATION_IDS = Object.freeze([\n${ids}\n] as const satisfies readonly OperationId[]);\n\nexport interface OperationInput {\n  readonly path: Readonly<Record<string, string>>;\n  readonly query: Readonly<Record<string, string | readonly string[]>>;\n  readonly body: unknown;\n  readonly idempotency?: string;\n  readonly expectedVersion?: number;\n}\n\nexport interface OperationRequest {\n  readonly type: OperationId;\n  readonly input: OperationInput;\n  readonly access: AccessContext | null;\n}\n\nexport interface OperationResult {\n  readonly status: number;\n  readonly body?: unknown;\n  readonly headers?: Readonly<Record<string, string>>;\n}\n\nexport interface OperationUsecase {\n  invoke(request: OperationRequest): Promise<OperationResult>;\n}\n\nexport class OperationHandler implements Handler<OperationRequest, OperationResult> {\n  constructor(private readonly usecase: OperationUsecase) {}\n\n  handle(request: OperationRequest): Promise<OperationResult> {\n    return this.usecase.invoke(request);\n  }\n}\n`;
}

function controllerSource(values: readonly OperationDefinition[]): string {
  const ids = values.map((item) => `  '${item.id}',`).join('\n');
  return `// Generated shell from definitions/operations.yml. Do not edit.\nimport { OperationCatalog, type OperationId } from '@shop/contract';\nimport { token } from '../../bootstrap/Container';\nimport type { ModuleContext } from '../../bootstrap/ModuleRegistry';\nimport type { OperationHandler, OperationInput, OperationResult } from '../application/OperationHandler';\nimport type { AccessContext } from '../security/AccessContext';\nimport type { HttpRequest } from './HttpRequest';\nimport { json } from './HttpResponse';\n\nexport const CONTROLLER_OPERATION_IDS = Object.freeze([\n${ids}\n] as const satisfies readonly OperationId[]);\n\nexport interface OperationAuthorizer {\n  authorize(headers: Readonly<Record<string, string>>, operation: string, permission: string, resource?: string): Promise<AccessContext>;\n}\n\nexport const OPERATION_HANDLERS = token<Map<OperationId, OperationHandler>>('operation.handlers');\nexport const OPERATION_AUTHORIZER = token<OperationAuthorizer>('operation.authorizer');\n\nexport function registerOperationRoutes(module: string, context: ModuleContext): void {\n  const handlers = context.container.get(OPERATION_HANDLERS);\n  const authorizer = context.container.get(OPERATION_AUTHORIZER);\n  for (const operation of OperationCatalog.all().filter((candidate) => candidate.module === module)) {\n    const handler = handlers.get(operation.id);\n    if (!handler) throw new Error(\`OPERATION_HANDLER_MISSING:\${operation.id}\`);\n    context.routes.register({ operation: operation.id, handler: async (request) => {\n      const access = operation.audience === 'public' ? null : await authorizer.authorize(request.headers, operation.id, operation.permission ?? operation.id, Object.values(request.parameters)[0]);\n      const result: OperationResult = await handler.handle({ type: operation.id, input: operationInput(operation.method, request), access });\n      return json(result.status, result.body, result.headers);\n    } });\n  }\n}\n\nfunction operationInput(method: string, request: HttpRequest): OperationInput {\n  const idempotency = request.headers['idempotency-key'];\n  if (method !== 'GET' && idempotency === undefined) throw new Error('IDEMPOTENCY_KEY_REQUIRED');\n  const header = request.headers['if-match'];\n  const normalized = header?.replace(/^W\\/\"|\"$/g, '');\n  const expectedVersion = normalized === undefined ? undefined : Number(normalized);\n  if (normalized !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 0)) throw new Error('EXPECTED_VERSION_INVALID');\n  return { path: request.parameters, query: queryObject(request.query), body: request.body,\n    ...(idempotency === undefined ? {} : { idempotency }), ...(expectedVersion === undefined ? {} : { expectedVersion }) };\n}\n\nfunction queryObject(parameters: URLSearchParams): Readonly<Record<string, string | readonly string[]>> {\n  const result: Record<string, string | readonly string[]> = {};\n  for (const key of new Set(parameters.keys())) {\n    const values = parameters.getAll(key);\n    result[key] = values.length === 1 ? values[0]! : Object.freeze(values);\n  }\n  return Object.freeze(result);\n}\n`;
}

function hardenedHandlerSource(values: readonly OperationDefinition[]): string {
  return handlerSource(values)
  .replace(
    "import type { OperationId } from '@shop/contract';",
    "import type { OperationId } from '@shop/contract';\nimport { assertEnforcedWriteResult, normalizeOperationResult } from './ExecutionKernel';"
  )
  .replace(
    '  readonly query: Readonly<Record<string, string | readonly string[]>>;\n  readonly body: unknown;',
    '  readonly query: Readonly<Record<string, string | readonly string[]>>;\n  readonly headers: Readonly<Record<string, string>>;\n  readonly body: unknown;\n  readonly rawBody: string;\n  readonly deadline: number;\n  readonly signal: AbortSignal;\n  /** Server-derived target used for authorization and action-proof binding. */\n  readonly resource?: string;'
  )
  .replace(
    '  handle(request: OperationRequest): Promise<OperationResult> {\n    return this.usecase.invoke(request);\n  }',
    `  async handle(request: OperationRequest): Promise<OperationResult> {
    const result = await this.usecase.invoke(request);
    assertEnforcedWriteResult(request, result);
    return normalizeOperationResult(request, result);
  }`
  );
}

function hardenedControllerSource(values: readonly OperationDefinition[]): string {
  return controllerSource(values)
    .replace(
      "import { OperationCatalog, type OperationId } from '@shop/contract';",
      "import { OperationCatalog, type OperationId } from '@shop/contract';"
    )
    .replace(
      'export function registerOperationRoutes(module: string, context: ModuleContext): void {',
      `export function registerOperationRoutes(module: string, context: ModuleContext): void {
  registerRoutes(OperationCatalog.all().filter((candidate) => candidate.module === module), context);
}

export function registerSelectedOperationRoutes(operationIds: readonly OperationId[], context: ModuleContext): void {
  registerRoutes(operationIds.map((operationId) => OperationCatalog.get(operationId)), context);
}

function registerRoutes(operations: ReturnType<typeof OperationCatalog.all>, context: ModuleContext): void {`
    )
    .replace(
      'for (const operation of OperationCatalog.all().filter((candidate) => candidate.module === module)) {',
      'for (const operation of operations) {'
    )
    .replace("operation.audience === 'public' ? null", "operation.audience === 'public' || operation.audience === 'provider' ? null")
    .replace('const access = operation.audience', 'const resource = operationResource(operation.id, request);\n      const access = operation.audience')
    .replace('Object.values(request.parameters)[0]);', 'resource);')
    .replace(
      "const access = operation.audience === 'public' || operation.audience === 'provider' ? null : await authorizer.authorize(request.headers, operation.id, operation.permission ?? operation.id, resource);",
      'const access = await operationAccess(operation, request, resource, authorizer);'
    )
    .replace('operationInput(operation.method, request)', 'operationInput(operation.id, request, resource)')
    .replace(
      'const result: OperationResult = await handler.handle({ type: operation.id, input: operationInput(operation.id, request, resource), access });',
      'const input = contractOperationInput(operation.id, operationInput(operation.id, request, resource));\n      const result: OperationResult = await handler.handle({ type: operation.id, input, access });'
    )
    .replace(
      'function operationInput(method: string, request: HttpRequest): OperationInput {',
      `async function operationAccess(operation: ReturnType<typeof OperationCatalog.get>, request: HttpRequest, resource: string | undefined,
  authorizer: OperationAuthorizer): Promise<AccessContext | null> {
  if (operation.id === 'identity.wechat.session' && authenticatedWechatMode(request.body)) {
    const currentSession = OperationCatalog.get('identity.session.read');
    return authorizer.authorize(request.headers, currentSession.id, currentSession.permission ?? currentSession.id, resource);
  }
  if (operation.audience === 'public' || operation.audience === 'provider') return null;
  return authorizer.authorize(request.headers, operation.id, operation.permission, resource);
}

function authenticatedWechatMode(body: unknown): boolean {
  return body !== null && typeof body === 'object' && !Array.isArray(body) && Reflect.get(body, 'mode') === 'authenticated';
}

function operationInput(operation: string, request: HttpRequest, resource: string | undefined): OperationInput {`
    )
    .replace("if (method !== 'GET' && idempotency === undefined)", "if (OperationCatalog.get(operation as OperationId).idempotency === 'required' && idempotency === undefined)")
    .replace('const normalized = header?.replace(/^W\\/"|"$/g, \'\');', "const normalized = header?.replace(/^W\\//, '').replace(/^\"|\"$/g, '');")
    .replace(
      "if (normalized !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 0)) throw new Error('EXPECTED_VERSION_INVALID');",
      "if (normalized !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 0)) throw new Error('EXPECTED_VERSION_INVALID');\n  if (OperationCatalog.get(operation as OperationId).expectedVersion === 'required' && expectedVersion === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');"
    )
    .replace(
      'return { path: request.parameters, query: queryObject(request.query), body: request.body,',
      'return { path: request.parameters, query: queryObject(request.query), headers: request.headers, body: request.body, rawBody: request.rawBody, deadline: request.deadline, signal: request.signal,'
    )
    .replace('    ...(idempotency === undefined ? {} : { idempotency }),', '    ...(resource === undefined ? {} : { resource }), ...(idempotency === undefined ? {} : { idempotency }),')
    .replace(
      '\nfunction queryObject(parameters: URLSearchParams)',
      "\nfunction contractOperationInput(operation: OperationId, input: OperationInput): OperationInput {\n  try {\n    const contractValue = { ...(Object.keys(input.path).length === 0 ? {} : { path: input.path }), query: input.query, body: input.body };\n    const parsed = operationSchema(operation).input.parse(contractValue) as { readonly path?: Readonly<Record<string, string>>; readonly query?: OperationInput['query']; readonly body?: unknown };\n    return Object.freeze({ ...input, path: parsed.path ?? {}, query: parsed.query ?? {}, body: parsed.body });\n  } catch (cause) {\n    throw new Error(`CONTRACT_REQUEST_INVALID:${cause instanceof Error ? cause.message : 'UNKNOWN'}`, { cause });\n  }\n}\n\nfunction operationResource(operation: string, request: HttpRequest): string | undefined {\n  if (operation === 'access.roles.manage' && request.body !== null && typeof request.body === 'object'\n    && !Array.isArray(request.body) && Reflect.get(request.body, 'action') === 'offboard') return undefined;\n  // A new policy id is not resolvable before its first approved revision. The selected Scope is the authorization resource; the path id remains bound by ExpectedVersion and the canonical request hash.\n  if (operation === 'finance.policies.manage' || operation === 'finance.policies.preview') return undefined;\n  const pathResource = Object.values(request.parameters)[0];\n  if (operation === 'catalog.imports.read' && pathResource?.startsWith('catalogpublication:')) return undefined;\n  if (pathResource !== undefined) return pathResource;\n  if (!['finance.withdrawals.create', 'invoice.requests.create'].includes(operation) || request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return undefined;\n  const settlement = Reflect.get(request.body, 'settlement');\n  return typeof settlement === 'string' && settlement.length > 0 ? settlement : undefined;\n}\n\nfunction queryObject(parameters: URLSearchParams)"
    )
    .replace(
      /\nfunction contractOperationInput[\s\S]*?\n}\n\n(?=function operationResource)/,
      "\nfunction contractOperationInput(operation: OperationId, input: OperationInput): OperationInput {\n  void operation;\n  return Object.freeze({ ...input });\n}\n\n"
    )
    .replace(
      "if (operation === 'finance.policies.manage' || operation === 'finance.policies.preview') return undefined;\n  const pathResource",
      "if (operation === 'finance.policies.manage' || operation === 'finance.policies.preview') return undefined;\n  // Member targets remain path IDs; authorization resolves the selected mall.\n  if (['member.storefront.detail.read', 'member.storefront.invitees.read', 'member.storefront.orders.read',\n    'member.storefront.custom.read', 'member.storefront.custom.manage'].includes(operation)) return undefined;\n  const pathResource"
    );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)])
    );
  return value;
}

function contractIdentityOpenapi(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contractIdentityOpenapi);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      key === 'x-requirements' && Array.isArray(child)
        ? child.filter((requirement) => typeof requirement !== 'string' || !requirement.startsWith('OMS-'))
        : contractIdentityOpenapi(child),
    ]));
  }
  return value;
}

function sqlRow(values: readonly (string | number | null)[]): string {
  return `  (${values.map((value) => (value === null ? 'null' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`)).join(',')})`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
