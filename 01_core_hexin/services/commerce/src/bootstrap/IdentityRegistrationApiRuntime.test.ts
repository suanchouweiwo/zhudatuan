import { readFile } from 'node:fs/promises';
import { parseNodeManifest } from '@shop/config/server';
import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '../foundation/persistence/Pool';
import {
  assertIdentityRegistrationNodeManifest,
  assertIdentityRegistrationRuntimeCompatibility,
} from './IdentityRegistrationApiRuntime';
import { expectedIdentityNodeDatabaseManifest } from './IdentityNodeManifestRuntime';

describe('identity registration API runtime', () => {
  it('binds origins and secret references to exactly one node manifest', async () => {
    const path = new URL('../../../../../02_platform_pingtai/config/node-manifests/hbbtzn-l1.json', import.meta.url);
    const manifest = await parseNodeManifest(JSON.parse(await readFile(path, 'utf8')));
    const environment = {
      APP_ENV: 'production',
      API_ALLOWED_ORIGINS: 'https://accounts.hbbtzn.com,https://console.hbbtzn.com,https://h5.hbbtzn.com,https://h6.hbbtzn.com,https://hbbtzn.com,https://mall.hbbtzn.com,https://www.hbbtzn.com',
      DATABASE_API_CONNECTION_REF: 'hbbtzn/nodes/l1/database/identity-api',
      SESSION_KEY_REF: 'hbbtzn/nodes/l1/identity/session',
      IDENTITY_KEY_REF: 'hbbtzn/nodes/l1/identity/index',
      WECHAT_APPLICATION_CONFIG_REF: 'hbbtzn/nodes/l1/identity/wechat-applications',
      WECHAT_IDENTITY_CONFIG_REF: 'hbbtzn/nodes/l1/identity/wechat',
    };
    expect(() => assertIdentityRegistrationNodeManifest(manifest, environment)).not.toThrow();
    const {
      WECHAT_APPLICATION_CONFIG_REF: _wechatApplications,
      WECHAT_IDENTITY_CONFIG_REF: _wechatIdentity,
      ...environmentWithoutWechat
    } = environment;
    expect(() => assertIdentityRegistrationNodeManifest(manifest, environmentWithoutWechat)).not.toThrow();
    expect(() => assertIdentityRegistrationNodeManifest(manifest, {
      ...environment, API_ALLOWED_ORIGINS: `${environment.API_ALLOWED_ORIGINS},https://zhudatuan.com`,
    })).toThrow('IDENTITY_NODE_ORIGIN_MISMATCH');
    expect(() => assertIdentityRegistrationNodeManifest(manifest, {
      ...environment, SESSION_KEY_REF: 'zhudatuan/nodes/l0/identity/session',
    })).toThrow('IDENTITY_NODE_SECRET_BINDING_MISMATCH');
  });

  it('requires the dedicated writable registration database role and registration relations', async () => {
    const healthy = { current_user: 'zhudatuanidentityapi', writable: true, schema: true, contract: true,
      registration: true, operator_invitation: true, relations: true, functions: true };
    let compatibilityStatement = '';
    const pool = (state: typeof healthy) => ({ query: async (statement: string) => {
      const manifest = expectedIdentityNodeDatabaseManifest();
      if (statement.includes('from identity.realm order by id')) return result(manifest.realms, manifest.realms.length);
      if (statement.includes('from identity.realmentry order by host')) return result(manifest.entries, manifest.entries.length);
      if (statement.includes('from identity.realmtarget order by realm_id,target')) return result(manifest.targets, manifest.targets.length);
      if (statement.includes('select current_user')) compatibilityStatement = statement;
      return result([state], 1);
    } }) as unknown as DatabasePool;
    await expect(assertIdentityRegistrationRuntimeCompatibility(pool(healthy))).resolves.toBeUndefined();
    expect(compatibilityStatement).toContain("version='20260829060000'");
    expect(compatibilityStatement).toContain("checksum='b1e238eb8de569b0de9d1d2766620e1f661268d2f9260e646208d4f24715b37a'");
    expect(compatibilityStatement).toContain("access.resolve_session_scope(text,text,text,text,text,text,text)");
    await expect(assertIdentityRegistrationRuntimeCompatibility(pool({ ...healthy, current_user: 'shopjob' })))
      .rejects.toThrow('IDENTITY_REGISTRATION_RUNTIME_COMPATIBILITY_FAILED');
    await expect(assertIdentityRegistrationRuntimeCompatibility(pool({ ...healthy, relations: false })))
      .rejects.toThrow('IDENTITY_REGISTRATION_RUNTIME_COMPATIBILITY_FAILED');
    await expect(assertIdentityRegistrationRuntimeCompatibility(pool({ ...healthy, registration: false })))
      .rejects.toThrow('IDENTITY_REGISTRATION_RUNTIME_COMPATIBILITY_FAILED');
    await expect(assertIdentityRegistrationRuntimeCompatibility(pool({ ...healthy, operator_invitation: false })))
      .rejects.toThrow('IDENTITY_REGISTRATION_RUNTIME_COMPATIBILITY_FAILED');
    await expect(assertIdentityRegistrationRuntimeCompatibility(pool({ ...healthy, functions: false })))
      .rejects.toThrow('IDENTITY_REGISTRATION_RUNTIME_COMPATIBILITY_FAILED');
  });
});


function result(rows: readonly unknown[], rowCount: number) {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}
