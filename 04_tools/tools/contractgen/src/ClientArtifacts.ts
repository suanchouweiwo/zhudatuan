export interface OperationDefinition {
  readonly id: string;
  readonly owner: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: `/api/v1/${string}` | `/health/${string}`;
  readonly audience: 'public' | 'member' | 'operator' | 'provider';
  readonly permission?: string;
  readonly stepup?: boolean;
  readonly idempotent: boolean;
  readonly idempotency?: 'none' | 'required';
  readonly expectedVersion?: 'none' | 'optional' | 'required';
  readonly execution?: 'sync' | 'async';
  readonly availability?: 'runtime' | 'frozen';
  readonly summary?: string;
  readonly schema: 'named' | 'structural';
  readonly title?: string;
  readonly targets?: readonly string[];
  readonly node_profiles_allowed?: readonly ('operating_mall' | 'consumer')[];
  readonly requestSchema?: string;
  readonly responseSchema?: string;
  readonly errorUnion?: readonly string[];
  readonly capability?: string;
  readonly scope_resolver_ref?: string;
  readonly idempotencyScope?: string;
  readonly assuranceLevel?: number;
  readonly makerChecker?: boolean;
  readonly sensitiveFields?: readonly string[];
  readonly csrfPolicy?: 'none' | 'session';
  readonly originPolicy?: 'public' | 'same-node';
  readonly targetPolicy?: 'public' | 'resolved-node';
  readonly responseMode?: 'json' | 'empty';
  readonly cachePolicy?: 'none' | 'private' | 'public';
  readonly rateClass?: 'low' | 'elevated' | 'high' | 'critical';
  readonly timeout?: number;
  readonly writePath?: 'none' | 'transactional' | 'durable' | 'provider';
  readonly stateMachine?: string;
  readonly businessNumber?: string;
  readonly operationHash?: string;
  readonly requestFields?: readonly string[];
  readonly responseFields?: readonly string[];
  readonly gates?: readonly Readonly<{
    slot: 'identity' | 'permission' | 'risk' | 'finance';
    phase: 'before';
    mode: 'disabled' | 'observe';
  }>[];
  readonly requirements: readonly string[];
  readonly controller?: string;
  readonly handler?: string;
  readonly sdk?: string;
}

export interface PermissionMetadata {
  readonly risk: string;
  readonly stepup: boolean;
  readonly scopes: readonly string[];
}

export function buildOpenapi(
  operations: readonly OperationDefinition[],
  permissions: ReadonlyMap<string, PermissionMetadata>,
): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const metadata = operation.permission === undefined ? undefined : permissions.get(operation.permission);
    const execution = operation.execution ?? 'sync';
    const failure = response('Error Contract', 'Error');
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method.toLowerCase()] = compact({
      operationId: operation.id,
      summary: operation.summary ?? operation.id,
      tags: [operation.owner],
      parameters: pathKeys(operation.path).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      })),
      requestBody: operation.method === 'GET' ? undefined : {
        required: operation.requestFields !== undefined,
        content: { 'application/json': { schema: reference(operation.requestSchema ?? 'JsonValue') } },
      },
      'x-audience': operation.audience,
      'x-availability': operation.availability ?? 'runtime',
      'x-execution': execution,
      'x-idempotency': operation.idempotency ?? (operation.method === 'GET' || operation.audience === 'provider' ? 'none' : 'required'),
      'x-idempotent': operation.idempotent,
      'x-expected-version': operation.expectedVersion ?? (operation.method === 'GET' ? 'none' : 'optional'),
      'x-permission': operation.permission ?? null,
      'x-requirements': operation.requirements,
      'x-risk': metadata?.risk ?? 'low',
      'x-schema-fidelity': operation.schema,
      'x-request-schema': operation.requestSchema,
      'x-response-schema': operation.responseSchema,
      'x-response-mode': operation.responseMode,
      'x-error-union': operation.errorUnion,
      'x-capability': operation.capability,
      'x-scope-resolver-ref': operation.scope_resolver_ref,
      'x-idempotency-scope': operation.idempotencyScope,
      'x-assurance-level': operation.assuranceLevel,
      'x-maker-checker': operation.makerChecker,
      'x-sensitive-fields': operation.sensitiveFields,
      'x-node-profiles-allowed': operation.node_profiles_allowed,
      'x-targets': operation.targets,
      'x-write-path': operation.writePath,
      'x-state-machine': operation.stateMachine,
      'x-business-number': operation.businessNumber,
      'x-operation-hash': operation.operationHash,
      'x-scope-kinds': metadata?.scopes ?? [],
      'x-stepup': operation.stepup ?? metadata?.stepup ?? false,
      security: operation.audience === 'public' || operation.audience === 'provider' ? [] : [{ session: [] }],
      responses: {
        [execution === 'async' ? '202' : '200']: response('Success', operation.responseSchema ?? 'JsonValue'),
        ...(execution === 'sync' ? { '204': { description: 'Success without content' } } : {}),
        '400': failure,
        '401': failure,
        '403': failure,
        '404': failure,
        '409': failure,
        '422': failure,
        '429': failure,
        '500': failure,
      },
    });
  }
  return stable({
    openapi: '3.1.0',
    info: { title: 'Shop Commerce API', version: '1.0.0' },
    servers: [{ url: '/' }],
    paths,
    components: {
      schemas: componentSchemas(operations),
      securitySchemes: { session: { type: 'http', scheme: 'bearer' } },
    },
  });
}

export function operationSource(
  values: readonly OperationDefinition[],
  permissions: ReadonlyMap<string, PermissionMetadata>,
): string {
  const definitions = values.map((item) => {
    const metadata = item.permission === undefined ? undefined : permissions.get(item.permission);
    return {
      id: item.id, method: item.method, path: item.path, module: item.owner, audience: item.audience,
      ...(item.permission === undefined ? {} : { permission: item.permission }), idempotent: item.idempotent,
      idempotency: item.idempotency!, expectedVersion: item.expectedVersion!, execution: item.execution!,
      availability: item.availability!, summary: item.summary!, risk: metadata?.risk ?? 'low', stepup: item.stepup ?? metadata?.stepup ?? false,
      scopeKinds: metadata?.scopes ?? [], schema: item.schema, title: item.title!, targets: item.targets!,
      node_profiles_allowed: item.node_profiles_allowed!, requestSchema: item.requestSchema!, responseSchema: item.responseSchema!,
      errorUnion: item.errorUnion!, capability: item.capability!, scope_resolver_ref: item.scope_resolver_ref!,
      idempotencyScope: item.idempotencyScope!, assuranceLevel: item.assuranceLevel!, makerChecker: item.makerChecker!,
      sensitiveFields: item.sensitiveFields!, csrfPolicy: item.csrfPolicy!, originPolicy: item.originPolicy!,
      targetPolicy: item.targetPolicy!, responseMode: item.responseMode!, cachePolicy: item.cachePolicy!, rateClass: item.rateClass!,
      timeout: item.timeout!, sdk: item.sdk!, writePath: item.writePath!, stateMachine: item.stateMachine!,
      businessNumber: item.businessNumber!, operationHash: item.operationHash!, requirements: item.requirements,
      ...(item.gates === undefined ? {} : { gates: item.gates }),
    };
  });
  return `// Generated from definitions/operations.yml. Do not edit.\nimport { operation } from '../Operation';\n\nconst definitions = ${JSON.stringify(definitions, null, 2)} as const;\n\nexport const COMMERCE_OPERATION_DEFINITIONS = Object.freeze(definitions.map((definition) => operation(definition)));\nexport const COMMERCE_OPERATIONS = Object.freeze(COMMERCE_OPERATION_DEFINITIONS.filter((definition) => definition.availability === 'runtime'));\nexport const FROZEN_OPERATIONS = Object.freeze(COMMERCE_OPERATION_DEFINITIONS.filter((definition) => definition.availability === 'frozen'));\n`;
}

export function schemaSource(values: readonly OperationDefinition[]): string {
  const rows = values.map((item) => {
    const keys = JSON.stringify(pathKeys(item.path));
    return `  ${JSON.stringify(item.id)}: Object.freeze({ input: namedOperationInput(${keys} as const, ${JSON.stringify(item.requestSchema)}, ${JSON.stringify(item.requestFields ?? null)}), output: namedOperationOutput(${JSON.stringify(item.responseSchema)}, ${JSON.stringify(item.responseFields ?? null)}), fidelity: ${JSON.stringify(item.schema)} }),`;
  }).join('\n');
  const runtimeIds = values.filter((item) => (item.availability ?? 'runtime') === 'runtime')
    .map((item) => `  ${JSON.stringify(item.id)},`).join('\n');
  return `// Generated from definitions/operations.yml. Do not edit.\nimport type { OperationId } from '../OperationCatalog';\nimport { namedOperationInput, namedOperationOutput, type SchemaOutput } from '../schema';\n\nconst ALL_OPERATION_SCHEMAS = Object.freeze({\n${rows}\n});\n\nconst RUNTIME_OPERATION_IDS = Object.freeze([\n${runtimeIds}\n] as const);\ntype RuntimeOperationId = (typeof RUNTIME_OPERATION_IDS)[number];\n\nexport const OPERATION_SCHEMAS = Object.freeze(Object.fromEntries(\n  RUNTIME_OPERATION_IDS.map((id) => [id, ALL_OPERATION_SCHEMAS[id]]),\n) as { readonly [TKey in RuntimeOperationId]: (typeof ALL_OPERATION_SCHEMAS)[TKey] });\n\nexport type OperationInputFor<TKey extends OperationId> = SchemaOutput<(typeof ALL_OPERATION_SCHEMAS)[TKey]['input']>;\nexport type OperationOutputFor<TKey extends OperationId> = SchemaOutput<(typeof ALL_OPERATION_SCHEMAS)[TKey]['output']>;\n\nexport function operationSchema<TKey extends OperationId>(id: TKey): (typeof ALL_OPERATION_SCHEMAS)[TKey] {\n  return ALL_OPERATION_SCHEMAS[id];\n}\n`;
}

export function sdkSource(values: readonly OperationDefinition[]): string {
  const groups = groupOperations(values);
  const imports = [...groups].map(([domain]) => `import { create${typeName(domain)}Operations, type ${typeName(domain)}Operations } from './${domain}';`).join('\n');
  const exports = [...groups].map(([domain]) => `export type { ${typeName(domain)}Operations } from './${domain}';`).join('\n');
  const clientFields = [...groups].map(([domain]) => `  readonly ${domain}: ${typeName(domain)}Operations;`).join('\n');
  const factories = [...groups].map(([domain]) => `    ${domain}: create${typeName(domain)}Operations(client),`).join('\n');
  const ids = values.map(({ id }) => `  ${JSON.stringify(id)},`).join('\n');
  return `// Generated from definitions/operations.yml. Do not edit.\nimport type { OperationId } from '@shop/contract';\nimport type { OperationExecutor } from '../OperationDescriptor';\n${imports}\n\n${exports}\nexport type { OperationMethod } from '../OperationDescriptor';\n\nexport const SDK_OPERATION_IDS = /* @__PURE__ */ Object.freeze([\n${ids}\n] as const satisfies readonly OperationId[]);\n\nexport interface CommerceClient {\n${clientFields}\n}\n\nexport function createCommerceClient(client: OperationExecutor): CommerceClient {\n  return Object.freeze({\n${factories}\n  });\n}\n`;
}

export function sdkDomainSources(values: readonly OperationDefinition[]): ReadonlyMap<string, string> {
  return new Map([...groupOperations(values)].map(([domain, operations]) => [domain, sdkDomainSource(domain, operations)]));
}

function sdkDomainSource(domain: string, operations: readonly OperationDefinition[]): string {
  const name = typeName(domain);
  const ids = operations.map(({ id }) => `  ${JSON.stringify(id)},`).join('\n');
  const methods = operations.map((operation) => `  readonly ${methodName(operation.id)}: OperationMethod<${JSON.stringify(operation.id)}>;`).join('\n');
  const bindings = operations.map((operation) => `    ${methodName(operation.id)}: bind${typeName(methodName(operation.id))}(client),`).join('\n');
  const operationFactories = operations.map((operation) => {
    const method = typeName(methodName(operation.id));
    const descriptor = JSON.stringify({
      id: operation.id,
      method: operation.method,
      path: operation.path,
      audience: operation.audience,
      idempotent: operation.idempotent,
      idempotency: operation.idempotency ?? (operation.method === 'GET' || operation.audience === 'provider' ? 'none' : 'required'),
      expectedVersion: operation.expectedVersion ?? (operation.method === 'GET' ? 'none' : 'optional'),
      execution: operation.execution ?? 'sync',
      availability: operation.availability ?? 'runtime',
    });
    return `export function createFetch${name}${method}(baseUrl: string): OperationMethod<${JSON.stringify(operation.id)}> {\n  return bind${method}(new ApiClient(baseUrl, new FetchTransport()));\n}\n\nfunction bind${method}(client: OperationExecutor): OperationMethod<${JSON.stringify(operation.id)}> {\n  return bindOperation(client, defineContractOperation(${descriptor}));\n}`;
  }).join('\n\n');
  return `// Generated from definitions/operations.yml. Do not edit.\nimport type { OperationId } from '@shop/contract';\nimport { ApiClient } from '../ApiClient';\nimport { FetchTransport } from '../FetchTransport';\nimport { bindOperation, defineContractOperation, type OperationExecutor, type OperationMethod } from '../OperationDescriptor';\n\nexport const ${domain.toUpperCase()}_OPERATION_IDS = /* @__PURE__ */ Object.freeze([\n${ids}\n] as const satisfies readonly OperationId[]);\n\nexport interface ${name}Operations {\n${methods}\n}\n\nexport function createFetch${name}(baseUrl: string): ${name}Operations {\n  return create${name}Operations(new ApiClient(baseUrl, new FetchTransport()));\n}\n\nexport function create${name}Operations(client: OperationExecutor): ${name}Operations {\n  return Object.freeze({\n${bindings}\n  });\n}\n\n${operationFactories}\n`;
}

function componentSchemas(operations: readonly OperationDefinition[]): Readonly<Record<string, unknown>> {
  const schemas: Record<string, unknown> = {
    Error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        requestId: { type: 'string', minLength: 1 },
        retryable: { type: 'boolean' },
        details: { type: 'object', additionalProperties: reference('JsonValue') },
      },
    },
    JsonValue: {
      oneOf: [
        { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
        { type: 'array', items: reference('JsonValue') },
        { type: 'object', additionalProperties: reference('JsonValue') },
      ],
    },
  };
  for (const operation of operations) {
    schemas[operation.requestSchema!] = namedObjectComponent(operation.requestFields);
    schemas[operation.responseSchema!] = operation.responseMode === 'empty'
      ? { type: 'null' }
      : namedObjectComponent(operation.responseFields);
  }
  return schemas;
}

function namedObjectComponent(fields: readonly string[] | undefined): unknown {
  return fields === undefined
    ? { type: 'object', additionalProperties: reference('JsonValue') }
    : {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(fields.map((field) => [field, reference('JsonValue')])),
      };
}

function response(description: string, schema: string): unknown {
  return { description, content: { 'application/json': { schema: reference(schema) } } };
}

function reference(name: string): Readonly<{ $ref: string }> {
  return { $ref: `#/components/schemas/${name}` };
}

function pathKeys(path: string): readonly string[] {
  return [...path.matchAll(/\{([a-z][a-z0-9]*)\}/g)].map((match) => match[1]!);
}

function groupOperations(values: readonly OperationDefinition[]): ReadonlyMap<string, readonly OperationDefinition[]> {
  const result = new Map<string, OperationDefinition[]>();
  for (const operation of values) {
    const domain = operation.id.split('.')[0]!;
    const current = result.get(domain) ?? [];
    current.push(operation);
    result.set(domain, current);
  }
  return result;
}

function methodName(id: string): string {
  const [, ...segments] = id.split('.');
  return segments.map((segment, index) => index === 0 ? segment : `${segment[0]!.toUpperCase()}${segment.slice(1)}`).join('');
}

function typeName(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function compact(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}
