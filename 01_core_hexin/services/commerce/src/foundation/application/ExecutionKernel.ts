import { createHash } from 'node:crypto';
import { OperationCatalog } from '@shop/contract';
import type { QueryResultRow } from 'pg';
import type { AuditSink } from './AuditSink';
import type { OperationRequest, OperationResult } from './OperationHandler';
import { assertActiveWriteTx, closeWriteTx, openWriteTx, type Transaction, type TransactionContext, type WriteTx } from './UnitOfWork';

type OperationDatabase = Transaction;
type OperationAction = (request: OperationRequest, database: OperationDatabase) => Promise<OperationResult>;
type ExecutionAuditWriter = (audit: AuditSink, database: OperationDatabase, request: OperationRequest, module: string,
  result: OperationResult, actor: string, scope: string, requestHash: string) => Promise<void>;

export type ExecutionState = 'started' | 'completed' | 'compensation_required';

export interface CriticalWriteClaim {
  readonly actor: string;
  readonly scope: string;
  readonly requestHash: string;
  readonly businessNumber: string;
  readonly replay?: OperationResult;
}

export interface CriticalWriteTransaction {
  run<T>(context: TransactionContext, operation: (transaction: Transaction) => Promise<T>): Promise<T>;
}

const enforcedResults = new WeakSet<object>();
const requestWriteTransactions = new WeakMap<object, WriteTx>();
const transitions = Object.freeze({
  started: Object.freeze(['completed', 'compensation_required'] as const),
  completed: Object.freeze([] as const),
  compensation_required: Object.freeze(['completed'] as const),
}) satisfies Readonly<Record<ExecutionState, readonly ExecutionState[]>>;

export class ExecutionKernel {
  constructor(private readonly audit: AuditSink, private readonly writeAudit: ExecutionAuditWriter) {}

  execute(request: OperationRequest, module: string, transaction: CriticalWriteTransaction, context: TransactionContext,
    action: OperationAction, replayProjection: (request: OperationRequest, result: OperationResult) => OperationResult): Promise<OperationResult> {
    const operation = OperationCatalog.get(request.type);
    if (operation.writePath !== 'transactional') throw new Error(`EXECUTION_KERNEL_PATH_INVALID:${request.type}`);
    return transaction.run(context, async (database) => {
      const claim = await claimCriticalWrite(database, request, module);
      if (claim.replay !== undefined) return markEnforcedWriteResult(normalizeOperationResult(request, claim.replay));
      const writeTx = openOperationWriteTx(request, claim);
      requestWriteTransactions.set(request, writeTx);
      try {
        let result: OperationResult;
        try {
          result = await action(request, database);
        } catch (cause) {
          if (!isOperationRejection(cause)) throw cause;
          result = cause.result;
        }
        const normalized = withBusinessNumber(normalizeOperationResult(request, result), claim.businessNumber);
        await this.writeAudit(this.audit, database, request, module, normalized, claim.actor, claim.scope, claim.requestHash);
        return await completeCriticalWrite(database, request, claim, normalized, replayProjection(request, normalized));
      } catch (cause) {
        throw cause;
      } finally {
        requestWriteTransactions.delete(request);
        closeWriteTx(writeTx);
      }
    });
  }
}

export function currentWriteTx(request: OperationRequest): WriteTx {
  const context = requestWriteTransactions.get(request);
  if (context === undefined) throw new Error('TRANSACTION_CONTEXT_MISSING');
  assertActiveWriteTx(context);
  return context;
}

export async function claimCriticalWrite(database: OperationDatabase, request: OperationRequest, module: string,
  scopeOverride?: string, actorOverride?: string): Promise<CriticalWriteClaim> {
  const operation = OperationCatalog.get(request.type);
  if (operation.writePath === 'none') throw new Error(`EXECUTION_KERNEL_NOT_REQUIRED:${request.type}`);
  const key = request.input.idempotency;
  if (!key && operation.writePath !== 'provider') throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  const requestHash = operationRequestHash(request);
  const actor = actorOverride ?? request.access?.actor.id ?? `public:${request.type}`;
  const scope = scopeOverride ?? request.access?.scope.id ?? `public:${module}`;
  const effectiveKey = scopedIdempotencyKey(request, key ?? providerBusinessKey(request));
  const businessNumber = operationBusinessNumber(request.type, scope, actor, effectiveKey);
  await database.query(`insert into runtime.idempotency(
      scope,actor_id,key,request_hash,state,response,created_at,expires_at,operation_id,business_number,execution_state,
      realm_id,node_id,membership_id,operation_hash
    ) values($1,$2,$3,$4,'started',null,clock_timestamp(),clock_timestamp()+interval '24 hours',$5,$6,'started',$7,$8,$9,$10)
    on conflict do nothing`, [scope, actor, effectiveKey, requestHash, request.type, businessNumber,
    request.access?.actor.realm ?? null, request.access?.actor.nodeContext?.node_id ?? null, request.access?.membership.id ?? null,
    operation.operationHash]);
  const accepted = await database.query<IdempotencyRow>(`select request_hash,state,response from runtime.idempotency
    where scope=$1 and actor_id=$2 and key=$3 for update`, [scope, actor, effectiveKey]);
  const record = accepted.rows[0];
  if (!record || record.request_hash !== requestHash) throw new Error('IDEMPOTENCY_KEY_REUSED');
  if (record.state === 'completed' && record.response !== null) {
    return Object.freeze({ actor, scope, requestHash, businessNumber, replay: record.response });
  }
  assertExecutionTransition('started', 'completed');
  return Object.freeze({ actor, scope, requestHash, businessNumber });
}

export async function completeCriticalWrite(database: OperationDatabase, request: OperationRequest, claim: CriticalWriteClaim,
  result: OperationResult, replayResult: OperationResult = result): Promise<OperationResult> {
  assertExecutionTransition('started', 'completed');
  const key = scopedIdempotencyKey(request, request.input.idempotency ?? providerBusinessKey(request));
  const eventId = `event:operation:${digest(`${claim.scope}:${claim.actor}:${key}`).slice(0, 40)}`;
  await database.query(`insert into runtime.outbox(
      id,event_type,event_version,aggregate_type,aggregate_id,scope_id,payload,trace_id,occurred_at,available_at
    ) values($1,'runtime.operation.completed',1,'operation',$2,$3,$4::jsonb,$5,clock_timestamp(),clock_timestamp())
    on conflict(id) do nothing`, [eventId, claim.businessNumber, claim.scope, JSON.stringify({
    operation: request.type, operationHash: OperationCatalog.get(request.type).operationHash, businessNumber: claim.businessNumber,
    requestHash: claim.requestHash, status: result.status,
  }), request.access?.trace ?? request.input.headers['request-id'] ?? claim.requestHash]);
  const updated = await database.query(`update runtime.idempotency set state='completed',execution_state='completed',response=$4::jsonb,
      completed_at=clock_timestamp()
    where scope=$1 and actor_id=$2 and key=$3 and request_hash=$5 and execution_state in('started','compensation_required')`,
  [claim.scope, claim.actor, key, JSON.stringify(replayResult), claim.requestHash]);
  if (updated.rowCount !== 1) throw new Error('EXECUTION_CHECKPOINT_LOST');
  return markEnforcedWriteResult(result);
}

export function normalizeOperationResult(_request: OperationRequest, result: OperationResult): OperationResult {
  return Object.freeze({ status: result.status, ...(result.body === undefined ? {} : { body: result.body }),
    ...(result.headers === undefined ? {} : { headers: Object.freeze({ ...result.headers }) }) });
}

export function markEnforcedWriteResult<T extends OperationResult>(result: T): T {
  enforcedResults.add(result);
  return result;
}

export function inheritEnforcedWriteResult(source: OperationResult, result: OperationResult): OperationResult {
  if (enforcedResults.has(source)) enforcedResults.add(result);
  return result;
}

export function assertEnforcedWriteResult(request: OperationRequest, result: OperationResult): void {
  const operation = OperationCatalog.get(request.type);
  if (operation.writePath !== 'none' && !enforcedResults.has(result)) throw new Error(`ENFORCED_WRITE_PATH_BYPASSED:${request.type}`);
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  const allowed: readonly ExecutionState[] = transitions[from];
  if (!allowed.includes(to)) throw new Error(`STATE_INVALID:${from}:${to}`);
}

export function operationRequestHash(request: OperationRequest): string {
  return digest(JSON.stringify({ type:request.type, path:request.input.path, query:request.input.query,
    body:idempotencyBody(request), expectedVersion:request.input.expectedVersion ?? null }));
}

export function operationBusinessNumber(operation: string, scope: string, actor: string, key: string): string {
  const owner = operation.split('.')[0]!.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12);
  return `SFL-${owner}-${digest(`${operation}:${scope}:${actor}:${key}`).slice(0, 16).toUpperCase()}`;
}

function scopedIdempotencyKey(request: OperationRequest, key: string): string {
  const access = request.access;
  const node = access?.actor.nodeContext?.node_id ?? 'unbound-node';
  const realm = access?.actor.realm ?? 'unbound-realm';
  const membership = access?.membership.id ?? 'public';
  return `${request.type}|${realm}|${node}|${membership}|${key}`;
}

function providerBusinessKey(request: OperationRequest): string {
  const requestId = request.input.headers['request-id'];
  if (requestId) return requestId;
  return operationRequestHash(request);
}

function idempotencyBody(request: OperationRequest): unknown {
  if (request.type !== 'identity.invitations.create'
    || request.input.body === null
    || typeof request.input.body !== 'object'
    || Array.isArray(request.input.body)) return request.input.body;
  const { destination: _destination, ...nonSensitiveBody } = request.input.body as Record<string, unknown>;
  return { ...nonSensitiveBody, destination: '[SENSITIVE]' };
}

function openOperationWriteTx(request: OperationRequest, claim: CriticalWriteClaim): WriteTx {
  const access = request.access;
  const node = access?.actor.nodeContext;
  const nodeId = node?.node_id ?? '';
  const lineId = node?.line_id ?? '';
  const hostSovereignNodeId = node?.host_node_id ?? nodeId;
  return openWriteTx({ id:claim.businessNumber, lineId, nodeId, sovereigntyTier:node?.host_node_id ? 'hosted' : 'sovereign',
    hostSovereignNodeId, realmRef:access?.actor.realm ?? '', scope:claim.scope, membershipId:access?.membership.id ?? '',
    actorId:claim.actor, accessVersion:access?.accessVersion ?? 0,
    lineageDigest:digest(`${lineId}:${nodeId}:${hostSovereignNodeId}:${access?.accessVersion ?? 0}`),
    manifestDigest:node?.manifest_digest ?? '', runtimeInstanceId:node?.manifest.runtime_instance_id ?? '', operation:request.type,
    trace:access?.trace ?? claim.requestHash, deadline:request.input.deadline, signal:request.input.signal });
}

function withBusinessNumber(result: OperationResult, businessNumber: string): OperationResult {
  if (result.status >= 400) return result;
  return Object.freeze({ ...result, headers: Object.freeze({ ...(result.headers ?? {}), 'x-business-number': businessNumber }) });
}

function isOperationRejection(cause: unknown): cause is Error & Readonly<{ result: OperationResult }> {
  return cause instanceof Error && cause.name === 'OperationRejection' && 'result' in cause;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface IdempotencyRow extends QueryResultRow {
  readonly request_hash: string;
  readonly state: string;
  readonly response: OperationResult | null;
}
