import { COMMERCE_EVENTS, OperationCatalog } from '@shop/contract';
import { RUNTIME_CONTRACT_CHECKSUM } from '@shop/config/server';
import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '../foundation/persistence/Pool';
import type { ExtensionRegistry } from './ExtensionRegistry';
import { assertRuntimeCompatibility, runtimeCompatibility } from './RuntimeCompatibility';

function pool(state: Readonly<Record<string, unknown>>): DatabasePool {
  return { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({
    query: async (statement: string) => statement.startsWith('select not pg_is_in_recovery')
      ? { rows: [state], rowCount: 1 }
      : { rows: [], rowCount: 0 },
    release: () => undefined,
  }) } as unknown as DatabasePool;
}

function extensions(state: 'healthy' | 'degraded' = 'healthy'): ExtensionRegistry {
  return {
    healthAll: async () => Object.freeze([{ provider: 'jdproduct', scope: 'mall:1', state, checkedAt: '2026-08-21T00:00:00.000Z' }]),
  } as unknown as ExtensionRegistry;
}

describe('runtime compatibility', () => {
  it('reports the legacy contract without granting it runtime blocking authority', async () => {
    const state = await runtimeCompatibility(pool({
      writable: true,
      schema: true,
      contract: true,
      scope_resolver: true,
      operations: OperationCatalog.all().length,
      capabilities: OperationCatalog.all().length,
      events: COMMERCE_EVENTS.length,
    }), extensions());
    expect(state.healthy).toBe(true);
    expect(state.contract).toEqual({ checksum: RUNTIME_CONTRACT_CHECKSUM, matches: true });
    expect(state.registries.jobs).toBeGreaterThan(0);

    const drifted = await runtimeCompatibility(pool({
      writable: true,
      schema: true,
      contract: false,
      scope_resolver: true,
      operations: 0,
      capabilities: 0,
      events: 0,
    }), extensions());
    expect(drifted.healthy).toBe(true);
    expect(drifted.contract.matches).toBe(false);
  });

  it('fails closed when an enabled extension is degraded', async () => {
    const state = await runtimeCompatibility(pool({
      writable: true,
      schema: true,
      contract: true,
      scope_resolver: true,
      operations: OperationCatalog.all().length,
      capabilities: OperationCatalog.all().length,
      events: COMMERCE_EVENTS.length,
    }), extensions('degraded'));
    expect(state.healthy).toBe(false);
  });

  it('fails closed when the target schema is missing', async () => {
    const state = await runtimeCompatibility(pool({
      writable: true,
      schema: false,
      contract: true,
      scope_resolver: true,
      operations: OperationCatalog.all().length,
      capabilities: OperationCatalog.all().length,
      events: COMMERCE_EVENTS.length,
    }), extensions());
    expect(state.healthy).toBe(false);
  });

  it('requires an available cache for jobs without changing API degradation semantics', async () => {
    const database = pool({
      writable: true,
      schema: true,
      contract: true,
      scope_resolver: true,
      operations: OperationCatalog.all().length,
      capabilities: OperationCatalog.all().length,
      events: COMMERCE_EVENTS.length,
    });
    await expect(runtimeCompatibility(database, extensions(), 'jobs', { available: false, reason: 'ECONNREFUSED' }))
      .resolves.toMatchObject({ healthy: false, cache: { available: false, reason: 'ECONNREFUSED' } });
    await expect(runtimeCompatibility(database, extensions(), 'jobs', { available: true }))
      .resolves.toMatchObject({ healthy: true, cache: { available: true } });
    await expect(runtimeCompatibility(database, extensions(), 'api', { available: false, reason: 'ECONNREFUSED' }))
      .resolves.toMatchObject({ healthy: true });
  });

  it('fails closed when the four-argument scope resolver is missing', async () => {
    const state = await runtimeCompatibility(pool({
      writable: true,
      schema: true,
      contract: true,
      scope_resolver: false,
      operations: OperationCatalog.all().length,
      capabilities: OperationCatalog.all().length,
      events: COMMERCE_EVENTS.length,
    }), extensions());
    expect(state.healthy).toBe(false);
  });

});

