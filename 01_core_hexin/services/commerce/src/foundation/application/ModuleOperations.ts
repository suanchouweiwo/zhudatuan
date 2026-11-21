import { createHash, randomUUID } from 'node:crypto';
import { permissionDefinition } from '@shop/authz';
import { OperationCatalog, type OperationId } from '@shop/contract';
import { Redactor } from '@shop/telemetry';
import type { QueryResult, QueryResultRow } from 'pg';
import type { DatabasePool } from '../persistence/Pool';
import { PgUnitOfWork } from '../infrastructure/PgUnitOfWork';
import type { OperationRequest, OperationResult, OperationUsecase } from './OperationHandler';
import { TransactionRunner } from './TransactionRunner';
import type { AuditSink } from './AuditSink';
import { ExecutionKernel, inheritEnforcedWriteResult, operationRequestHash } from './ExecutionKernel';

export { operationRequestHash } from './ExecutionKernel';

export interface OperationDatabase {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export type OperationAction = (request: OperationRequest, database: OperationDatabase) => Promise<OperationResult>;
export interface OperationLifecycle<T = unknown> {
  prepare?(request: OperationRequest): Promise<T>;
  shortCircuit?(request: OperationRequest, preparation: T): OperationResult | undefined;
  execute(request: OperationRequest, database: OperationDatabase, preparation: T): Promise<OperationResult>;
  finalize?(request: OperationRequest, result: OperationResult, preparation: T): Promise<OperationResult>;
  discard?(request: OperationRequest, preparation: T, cause: unknown): Promise<void>;
}
type OperationEntry = OperationAction | OperationLifecycle;
export type OperationActions = Readonly<Partial<Record<OperationId, OperationEntry>>>;

const IDENTITY_AUDIT_INPUT_ALLOWLIST: Readonly<Partial<Record<OperationId, readonly string[]>>> = Object.freeze({
  'identity.sessions.create': Object.freeze(['provider', 'target', 'membership']),
  'identity.loginintents.create': Object.freeze(['targetNodeId', 'targetSurface', 'targetApplication']),
  'identity.tickets.exchange': Object.freeze([]),
  'identity.challenges.create': Object.freeze(['purpose']),
  'identity.invitations.read': Object.freeze([]),
  'identity.storefronts.read': Object.freeze([]),
  'identity.invitations.create': Object.freeze(['label', 'targetClient', 'governanceLevel', 'maxUses', 'expiresAt', 'storefrontOrganization']),
  'identity.invitations.revoke': Object.freeze([]),
  'identity.members.create': Object.freeze(['termsAccepted', 'termsHash']),
  'identity.members.manage': Object.freeze(['action', 'status', 'departmentId']),
  'identity.password.change': Object.freeze([]),
  'identity.password.verify': Object.freeze([]),
  'identity.password.reset': Object.freeze([]),
  'identity.mobile.challenge': Object.freeze([]),
  'identity.mobile.manage': Object.freeze([]),
  'identity.stepup.start': Object.freeze([]),
  'identity.stepup.complete': Object.freeze([]),
  'identity.wechat.session': Object.freeze(['scene', 'action']),
  'identity.wechat.bind': Object.freeze([]),
});

const IDENTITY_AUDIT_OUTPUT_FIELDS: Readonly<Partial<Record<OperationId, readonly string[]>>> = Object.freeze({
  'access.ownership.transfers.preview': Object.freeze(['proof']),
  'access.ownership.transfers.accept.preview': Object.freeze(['proof']),
  'access.ownership.transfers.cancel.preview': Object.freeze(['proof']),
  'identity.invitations.create': Object.freeze(['code']),
  'identity.tickets.exchange': Object.freeze(['proof']),
});

export function operationLifecycle<T>(definition: OperationLifecycle<T>): OperationLifecycle {
  return definition as OperationLifecycle;
}

export class OperationRejection extends Error {
  constructor(readonly result: OperationResult) {
    super(String((result.body as { code?: unknown } | undefined)?.code ?? 'OPERATION_REJECTED'));
    this.name = 'OperationRejection';
  }
}

export function reject(status: number, code: string, details?: unknown): never {
  throw new OperationRejection({ status, body: { code, ...(details === undefined ? {} : { details }) } });
}

export class ModuleOperations implements OperationUsecase {
  private readonly actions: ReadonlyMap<OperationId, OperationEntry>;
  private readonly query: TransactionRunner;
  private readonly command: TransactionRunner;
  private readonly kernel: ExecutionKernel;

  constructor(private readonly module: string, private readonly pool: DatabasePool, private readonly audit: AuditSink,
    actions: OperationActions, owned?: readonly OperationId[]) {
    this.actions = new Map(Object.entries(actions) as [OperationId, OperationEntry][]);
    const expected = [...(owned ?? OperationCatalog.all().filter((operation) => operation.module === module).map((operation) => operation.id))].sort();
    const actual = [...this.actions.keys()].sort();
    if (expected.join('\n') !== actual.join('\n')) throw new Error(`MODULE_OPERATION_CATALOG_MISMATCH:${module}`);
    this.query = new TransactionRunner(new PgUnitOfWork(pool.workload('query')));
    this.command = new TransactionRunner(new PgUnitOfWork(pool.workload('command')));
    this.kernel = new ExecutionKernel(audit, appendOperationAudit);
  }

  async invoke(request: OperationRequest): Promise<OperationResult> {
    if (request.input.signal.aborted || request.input.deadline <= Date.now()) throw request.input.signal.reason ?? new Error('DEADLINE_EXCEEDED');
    const operation = OperationCatalog.get(request.type);
    if (operation.module !== this.module) throw new Error(`MODULE_OPERATION_OWNER_MISMATCH:${request.type}`);
    const action = this.actions.get(request.type);
    if (!action) throw new Error(`OPERATION_ACTION_MISSING:${request.type}`);
    const lifecycle = typeof action === 'function' ? undefined : action;
    const preparation = lifecycle?.prepare ? await lifecycle.prepare(request) : undefined;
    const immediate = lifecycle?.shortCircuit?.(request, preparation);
    if (immediate) {
      if (operation.method !== 'GET') throw new Error('WRITE_SHORT_CIRCUIT_FORBIDDEN');
      return immediate;
    }
    const execute: OperationAction = typeof action === 'function'
      ? action
      : (preparedRequest, database) => action.execute(preparedRequest, database, preparation);
    try {
      const result = operation.method === 'GET'
        ? await this.read(request, execute)
        : operation.writePath === 'transactional'
          ? await this.kernel.execute(request, this.module, this.command, transactionContext(request, this.module, 'command'), execute,
            idempotencyReplayResponse)
          : await this.write(request, execute);
      return lifecycle?.finalize
        ? lifecycle.finalize(request, result, preparation).then((finalized) => inheritEnforcedWriteResult(result, finalized))
        : result;
    } catch (cause) {
      await lifecycle?.discard?.(request, preparation, cause);
      throw cause;
    }
  }

  private read(request: OperationRequest, action: OperationAction): Promise<OperationResult> {
    return this.query.run(transactionContext(request, this.module, 'query'), async (client) => {
      const result = await action(request, client);
      const operation = OperationCatalog.get(request.type);
      if (request.access && operation.permission && ['high','critical'].includes(permissionDefinition(operation.permission).risk)) {
        await this.audit.access(client, { scope:request.access.scope.id, actor:request.access.actor.id, actorType:request.access.actor.target,
          resourceType:this.module, resource:Object.values(request.input.path)[0] ?? request.access.scope.id,
          fields:{ operation:request.type, permission:operation.permission, projection:projection(result.body) }, purpose:request.type,
          trace:request.access.trace });
      }
      return result;
    });
  }

  private write(request: OperationRequest, action: OperationAction): Promise<OperationResult> {
    const key = request.input.idempotency;
    if (!key) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    return this.command.run(transactionContext(request, this.module, 'command'), async (client) => {
      const hash = operationRequestHash(request);
      const actor = request.access?.actor.id ?? `public:${request.type}`;
      const scope = request.access?.scope.id ?? `public:${this.module}`;
      await client.query(`insert into runtime.idempotency(scope,actor_id,key,request_hash,state,expires_at)
        values($1,$2,$3,$4,'started',clock_timestamp()+interval '24 hours') on conflict do nothing`, [scope, actor, key, hash]);
      const accepted = await client.query<{ request_hash: string; state: string; response: OperationResult | null }>(
        'select request_hash,state,response from runtime.idempotency where scope=$1 and actor_id=$2 and key=$3 for update', [scope, actor, key],
      );
      const record = accepted.rows[0];
      if (!record || record.request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
      if (record.state === 'completed' && record.response !== null) {
        return record.response;
      }
      let result: OperationResult;
      try {
        result = await action(request, client);
      } catch (cause) {
        if (!(cause instanceof OperationRejection)) throw cause;
        result = cause.result;
      }
      await appendOperationAudit(this.audit, client, request, this.module, result, actor, scope, hash);
      const replay = idempotencyReplayResponse(request, result);
      await client.query(`update runtime.idempotency set state='completed',response=$4::jsonb
        where scope=$1 and actor_id=$2 and key=$3`, [scope, actor, key, JSON.stringify(replay)]);
      return result;
    });
  }
}

export async function appendOperationAudit(audit: AuditSink, client: OperationDatabase, request: OperationRequest, module: string,
  result: OperationResult, actor: string, scope: string, requestHashValue: string): Promise<void> {
  const body = request.input.body && typeof request.input.body === 'object' && !Array.isArray(request.input.body)
    ? request.input.body as Record<string, unknown> : {};
  const resource = Object.values(request.input.path)[0] ?? null;
  const operation = OperationCatalog.get(request.type);
  const redactor = new Redactor();
  const auditBody = operation.module === 'observability' ? { redacted: true }
    : projectAuditBody(request.input.body, IDENTITY_AUDIT_INPUT_ALLOWLIST[operation.id]);
  const auditResult = redactAuditFields(result.body, IDENTITY_AUDIT_OUTPUT_FIELDS[operation.id]);
  const before = redactor.redact({ path:request.input.path, query:request.input.query, body:auditBody,
    expectedVersion:request.input.expectedVersion ?? null });
  const after = redactor.redact(auditResult ?? null);
  const identitySensitive = IDENTITY_AUDIT_INPUT_ALLOWLIST[operation.id] !== undefined;
  const auditRequestHash = identitySensitive ? digest(JSON.stringify({ operation:operation.id, before })) : requestHashValue;
  const rawReason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
  const reason = identitySensitive || rawReason === null ? null : redactor.redact(rawReason, 'reason');
  const auditIdempotency = identitySensitive ? '[REDACTED]' : request.input.idempotency;
  const auditTrace = identitySensitive ? `audit:${randomUUID()}` : request.access?.trace ?? requestHashValue;
  await audit.record(client, { scope, actor, actorType:request.access?.actor.target ?? 'public', action:request.type, resourceType:module,
    resource, before, after, evidence:{ status:result.status, idempotency:auditIdempotency, requestHash:auditRequestHash, reason,
      permission:operation.permission ?? null, capabilities:request.access?.capabilities ?? [] },
    trace:auditTrace });
}

function projectAuditBody(value: unknown, allowlist: readonly string[] | undefined): unknown {
  if (allowlist === undefined) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { redacted:true };
  const record = value as Record<string, unknown>;
  return Object.fromEntries([
    ...allowlist.filter((key) => Object.hasOwn(record, key)).map((key) => [key, auditScalar(record[key])] as const),
    ['redacted', true] as const,
  ]);
}

function auditScalar(value: unknown): unknown {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : '[REDACTED]';
}

function redactAuditFields(value: unknown, fields: readonly string[] | undefined): unknown {
  if (fields === undefined || value === null || typeof value !== 'object') return value;
  const names = new Set(fields);
  if (Array.isArray(value)) return value.map((item) => redactAuditFields(item, fields));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    names.has(key) ? '[REDACTED]' : redactAuditFields(item, fields),
  ]));
}

export function rowResult<T extends QueryResultRow>(result: QueryResult<T>, status = 200): OperationResult {
  const row = result.rows[0];
  if (!row) throw new Error('RESOURCE_NOT_FOUND');
  return { status, body: row, ...(Reflect.has(row, 'version') ? { headers: { etag: `\"${String(Reflect.get(row, 'version'))}\"` } } : {}) };
}

export function pageResult<T extends QueryResultRow>(result: QueryResult<T>): OperationResult {
  return { status: 200, body: { items: result.rows, count: result.rows.length } };
}


export function requireAccess(request: OperationRequest) {
  if (!request.access) throw new Error('AUTHENTICATION_REQUIRED');
  return request.access;
}

function transactionContext(request: OperationRequest, module: string, workload: 'query' | 'command') {
  const access = request.access;
  const mall = access?.mallContext?.mall_id ?? access?.mall_id;
  const serializationKeys = request.type === 'order.orders.create' && mall
    ? [`inventory:${mall}`]
    : request.type === 'provisioning.malls.create'
      ? ['hbbtzn:h5-domain-sequence:v1']
      : undefined;
  return { tenant: access?.scope.tenant ?? '', membership: access?.membership.id ?? '', scope: access?.scope.id ?? `public:${module}`,
    actor: access?.actor.id ?? 'public', trace: access?.trace ?? `public:${request.type}`, workload,
    ...(serializationKeys === undefined ? {} : { serializationKeys }) } as const;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function idempotencyReplayResponse(request: OperationRequest, result: OperationResult): OperationResult {
  if (request.type === 'identity.sessions.create' || request.type === 'identity.tickets.exchange'
    || request.type === 'access.ownership.transfers.preview'
    || request.type === 'access.ownership.transfers.accept.preview'
    || request.type === 'access.ownership.transfers.cancel.preview') {
    return { status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'IDENTITY_CREDENTIAL_RESPONSE_ONE_TIME' } };
  }
  if (request.type === 'identity.invitations.create') {
    return { status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'IDENTITY_INVITATION_RESPONSE_ONE_TIME' } };
  }
  if (request.type === 'identity.stepup.complete' && containsActionProof(result.body)) {
    return { status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'ACTION_PROOF_ONE_TIME_RESPONSE' } };
  }
  return result;
}

function containsActionProof(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const actionProof = Reflect.get(body, 'actionProof');
  return actionProof !== null && typeof actionProof === 'object' && !Array.isArray(actionProof)
    && typeof Reflect.get(actionProof, 'proof') === 'string';
}

function projection(value: unknown): readonly string[] {
  if (!value || typeof value!=='object') return [];
  if (Array.isArray(value)) return value.length===0 ? [] : projection(value[0]);
  return Object.keys(value as Record<string, unknown>).sort().slice(0,100);
}
