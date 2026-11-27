import type { QueryResultRow } from 'pg';
import type { Transaction } from '../application/UnitOfWork';
import type { DatabasePool } from '../persistence/Pool';
import { retryDelay } from '../performance/Retry';
import type { DomainEvent } from '../domain/DomainEvent';
import { DeadletterStore } from './DeadletterStore';
import { PgUnitOfWork } from './PgUnitOfWork';

export interface OutboxEvent extends QueryResultRow {
  readonly id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_id: string;
  readonly scope_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly trace_id: string;
  readonly attempts: number;
}

export interface OutboxSelection {
  readonly scope: string;
  readonly eventType: string;
}

export class OutboxStore {
  private readonly unit: PgUnitOfWork;

  constructor(private readonly pool: DatabasePool, private readonly deadletters = new DeadletterStore()) {
    this.unit = new PgUnitOfWork(pool);
  }

  claim(owner: string, batch: number, leaseSeconds = 30, selection?: OutboxSelection): Promise<readonly OutboxEvent[]> {
    if (!owner || !Number.isSafeInteger(batch) || batch < 1 || batch > 1000 || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) {
      throw new Error('OUTBOX_CLAIM_INVALID');
    }
    return this.unit.execute(runtimeContext(owner), async (transaction) => {
      const result = await transaction.query<OutboxEvent>(`with eligible as (
        select target.id,row_number() over(partition by target.aggregate_id order by target.occurred_at,target.id) aggregate_sequence
        from runtime.outbox target where target.published_at is null and target.failed_at is null and target.available_at<=clock_timestamp()
          and ($4::text is null or target.scope_id=$4) and ($5::text is null or target.event_type=$5)
          and (target.claim_until is null or target.claim_until<=clock_timestamp())
          and not exists(select 1 from runtime.outbox earlier where earlier.aggregate_id=target.aggregate_id and earlier.published_at is null
            and earlier.failed_at is null and (earlier.occurred_at,earlier.id)<(target.occurred_at,target.id))
      ), candidates as (
        select id from eligible where aggregate_sequence=1 order by id for update skip locked limit $1
      ) update runtime.outbox target set claimed_by=$2,claim_until=clock_timestamp()+make_interval(secs=>$3),attempts=target.attempts+1
        from candidates where target.id=candidates.id returning target.id,target.event_type,target.event_version,target.aggregate_id,target.scope_id,
        target.payload,target.trace_id,target.attempts`, [batch, owner, leaseSeconds, selection?.scope ?? null, selection?.eventType ?? null]);
      return result.rows;
    });
  }

  async published(event: string, owner: string): Promise<void> {
    const result = await this.pool.query(`update runtime.outbox set published_at=clock_timestamp(),claimed_by=null,claim_until=null
      where id=$1 and claimed_by=$2 and published_at is null`, [event, owner]);
    if (result.rowCount !== 1) throw new Error('OUTBOX_LEASE_LOST');
  }

  fail(event: OutboxEvent, owner: string, cause: unknown, maximumAttempts = 8): Promise<void> {
    const error = cause instanceof Error ? cause.message.slice(0, 200) : 'OUTBOX_PUBLISH_FAILED';
    const terminal = event.attempts >= maximumAttempts;
    return this.unit.execute(runtimeContext(owner), async (transaction) => {
      if (terminal) await this.deadletters.record(transaction, { id: `outbox:${event.id}`, kind: 'outbox', source: event.id, owner: 'runtime',
        payload: event.payload, error, attempts: event.attempts });
      const delay = retryDelay(event.attempts, 250, 60_000);
      const result = await transaction.query(`update runtime.outbox set claimed_by=null,claim_until=null,error_code=$3,
        failed_at=case when $4 then clock_timestamp() else null end,
        available_at=case when $4 then available_at else clock_timestamp()+make_interval(secs=>$5::double precision/1000) end
        where id=$1 and claimed_by=$2`, [event.id, owner, error, terminal, delay]);
      if (result.rowCount !== 1) throw new Error('OUTBOX_LEASE_LOST');
    });
  }
}

export async function appendOutbox(transaction: Transaction, event: DomainEvent): Promise<void> {
  await transaction.query(`insert into runtime.outbox(id,event_type,event_version,aggregate_type,aggregate_id,scope_id,payload,trace_id,occurred_at,available_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,clock_timestamp())`, [event.event, event.type, event.version, event.aggregate.type,
    event.aggregate.id, event.tenant, JSON.stringify(event.payload), event.trace, event.occurred]);
}

function runtimeContext(owner: string) {
  return { tenant: '', membership: '', scope: 'runtime', actor: owner, trace: `outbox:${owner}`, workload: 'worker' } as const;
}
