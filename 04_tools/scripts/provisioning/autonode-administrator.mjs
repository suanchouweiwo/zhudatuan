import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function initializeInstanceAdministrator(instance, administrator, controllerOrigin, run) {
  const root = `/opt/sfl/nodes/${instance.instance}`;
  const runtime = join(root, 'runtime');
  const marker = join(runtime, 'administrator.json');
  const existing = await readFile(marker, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) return existing;
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const identity = JSON.parse(await readFile(join(root, 'targets/identity-api/current/node-runtime/identity-node-projection.json'), 'utf8'));
  const node = identity.nodes.find((entry) => entry.nodeId === instance.node_id);
  const target = node.targets.find((entry) => entry.target === 'console');
  const environmentFile = join(runtime, 'identity-api.env');
  const environment = await readFile(environmentFile, 'utf8');
  const envValue = (name) => {
    const value = new RegExp(`^${name}=(.*)$`, 'm').exec(environment)?.[1].trim() ?? '';
    return value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/g, '');
  };
  const keyRef = envValue('IDENTITY_KEY_REF');
  const secrets = JSON.parse(await readFile(join(runtime, 'secrets.json'), 'utf8'));
  const subject = administrator.username.trim().replace(/^1([3-9]\d{9})$/, '+861$1').toLowerCase();
  const hash = createHmac('sha256', secrets[keyRef]).update(subject).digest('hex');
  const id = `instance-admin:${instance.instance}`;
  const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const tenant = target.membershipOrganizationId;
  const role = `role-senior-administrator-v1:${tenant}`;
  const principal = `principal:${id}`, member = `member:${id}`, account = `account:${id}`, membership = `membership:${id}`;
  const sql = `begin;
    insert into organization.node(id,line_id,sovereignty_tier,node_profile,realm_id,mall_id,status,created_at,updated_at)
      values(${q(node.nodeId)},${q(manifest.line_id)},'sovereign',${q(node.nodeProfile)},${q(node.realmId)},${q(node.mallId)},'active',clock_timestamp(),clock_timestamp()) on conflict(id) do nothing;
    insert into organization.noderelation(line_id,node_id,signed_level,host_sovereign_node_id,relation_version,effective_at)
      values(${q(manifest.line_id)},${q(node.nodeId)},'L0',${q(node.nodeId)},1,clock_timestamp()) on conflict do nothing;
    insert into organization.nodeclosure(line_id,descendant_node_id,ancestor_node_id,depth,descendant_relation_version,effective_at)
      values(${q(manifest.line_id)},${q(node.nodeId)},${q(node.nodeId)},0,1,clock_timestamp()) on conflict do nothing;
    insert into identity.principal(id,status,created_at,updated_at) values(${q(principal)},'active',clock_timestamp(),clock_timestamp()) on conflict(id) do nothing;
    insert into identity.account(id,realm_id,legacy_principal_id,status,created_at,updated_at)
      values(${q(account)},${q(node.realmId)},${q(principal)},'active',clock_timestamp(),clock_timestamp()) on conflict(id) do nothing;
    insert into identity.credential(id,principal_id,provider,subject_hash,secret_hash,status,created_at,realm_id,account_id)
      values(${q(`credential:${id}`)},${q(principal)},'password',${q(hash)},${q(administrator.passwordHash)},'active',clock_timestamp(),${q(node.realmId)},${q(account)}) on conflict(id) do nothing;
    insert into member.profile(id,principal_id,display_name,status,version,created_at,updated_at)
      values(${q(member)},${q(principal)},${q(administrator.displayName)},'active',1,clock_timestamp(),clock_timestamp()) on conflict(id) do nothing;
    insert into access.role(id,scope_id,name,status,version)
      values(${q(role)},${q(tenant)},'高级管理员','active',1) on conflict(id) do nothing;
    insert into access.rolepermission(role_id,permission_id,effect)
      select ${q(role)},permission_id,effect from access.rolepermission where role_id='role-senior-administrator-v1:tenant-zhudatuan' on conflict do nothing;
    insert into access.membership(id,member_id,organization_id,client,status,access_version,joined_at,realm_id,account_id,node_profile,operator_display_name)
      values(${q(membership)},${q(member)},${q(tenant)},'operator','active',1,clock_timestamp(),${q(node.realmId)},${q(account)},${q(node.nodeProfile)},${q(administrator.displayName)}) on conflict(id) do nothing;
    insert into access.membershiprole(membership_id,role_id,effective_at,assigned_scope_kind,assigned_scope_id,assigned_scope_path,scope_source)
      values(${q(membership)},${q(role)},clock_timestamp(),'tenant',${q(tenant)},${q(tenant)},'instance_bootstrap'),
        (${q(membership)},'role:self',clock_timestamp(),null,null,null,null) on conflict do nothing;
    insert into access.scopegrant(id,membership_id,scope_kind,scope_id,scope_path,effect,effective_at,access_version)
      values(${q(`scope:${id}:tenant`)},${q(membership)},'tenant',${q(tenant)},${q(tenant)},'allow',clock_timestamp(),1),
        (${q(`scope:${id}:self`)},${q(membership)},'self',${q(`self:${principal}`)},${q(`self:${principal}`)},'allow',clock_timestamp(),1) on conflict(id) do nothing;
    insert into access.administratoridentity(id,membership_id,realm_id,account_id,principal_id,host_node_id,status,version,created_at)
      values(${q(`administrator:${id}`)},${q(membership)},${q(node.realmId)},${q(account)},${q(principal)},${q(node.nodeId)},'active',1,clock_timestamp()) on conflict(id) do nothing;
    insert into access.administratorsegmentscope(scope_id,administrator_identity_id,scope_version,realm_id,line_id,root_node_id,segment,role_id,access_version,status,effective_at,granted_by_administrator_identity_id)
      values(${q(`administrator-scope:${id}`)},${q(`administrator:${id}`)},1,${q(node.realmId)},${q(manifest.line_id)},${q(node.nodeId)},'both_segments',${q(role)},1,'active',clock_timestamp(),${q(`administrator:${id}`)}) on conflict do nothing;
    commit;`;
  await run('docker', ['exec', '-i', `${instance.instance}-postgres`, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'zhudatuanroot', '-d', 'zhudatuan_registration'], { cwd: root, input: sql });
  if (controllerOrigin) {
    const origins = envValue('API_ALLOWED_ORIGINS').split(',').filter(Boolean);
    const next = environment.replace(/^API_ALLOWED_ORIGINS=.*$/m, `API_ALLOWED_ORIGINS=${JSON.stringify([...new Set([...origins, new URL(controllerOrigin).origin])].join(','))}`);
    await writeFile(environmentFile, next);
    await run('systemctl', ['restart', `sfl-identity-api@${instance.instance}.service`], { cwd: root });
  }
  const result = { principal, membership, realm: manifest.realm_ref.ref, initializedAt: new Date().toISOString() };
  await writeFile(marker, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  return result;
}
