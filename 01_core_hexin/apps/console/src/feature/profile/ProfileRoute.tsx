import { Badge, Button, Surface } from '@shop/design';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { selectConsoleNavigationItems } from '../../entity/navigation/ConsoleNavigation';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import {
  normalizeConsoleCopy,
  scopeDisplayName,
  scopeIdentifierLabel,
  scopeKindLabel,
} from '../../entity/session/ScopePresentation';
import { consoleModules } from '../../route/ConsoleModuleRegistry';
import { accessKey, readAccess } from '../access/AccessQuery';
import {
  formatDateTime,
  partitionAssignedRoles,
  permissionGroupsOf,
  profileStatusOf,
  scopeTrailOf,
} from './ProfileModel';
import './profile.css';
import './profile-access.css';
import './profile-responsive.css';

export function Component() {
  const context = useConsoleContext();
  const businessWorkspaceAvailable = selectConsoleNavigationItems(consoleModules, context.scope.kind, context.session.capabilities)
    .some(({ placement, status }) => placement === 'main' && status === 'enabled');
  const canReadAssignments = context.session.permissions.includes('access.center.read');
  const accessQuery = useQuery({
    queryKey: accessKey(context),
    queryFn: ({ signal }) => readAccess(context, undefined, signal),
    enabled: canReadAssignments,
  });
  const membership = accessQuery.data?.items.find(({ id }) => id === context.session.membership);
  const roles = partitionAssignedRoles(membership?.roles ?? [], context.scope.kind, accessQuery.data?.roles ?? []);
  const permissionGroups = permissionGroupsOf(context.session.permissions);
  const permissionCount = permissionGroups.reduce((count, group) => count + group.permissions.length, 0);
  const profileStatus = profileStatusOf(context.profile.status);
  const scopeTrail = scopeTrailOf(context);
  const assignmentState = roleAssignmentState(canReadAssignments, accessQuery.isPending, accessQuery.isError, membership !== undefined);
  const phone = phoneLabel(context.session.security?.phoneMasked, context.profile.mobile_bound);
  const businessIdentity = assignmentState.ready
    ? roles.business.map(({ label }) => label).join(' + ') || '未分配业务身份'
    : assignmentState.label;
  const governanceIdentity = assignmentState.ready
    ? roles.governance.map(({ label }) => label).join(' + ')
    : '';

  const accountCard = (
    <Surface className="profilepanel profilebasicpanel" depth="low" padding="spacious" role="region" aria-labelledby="profilebasictitle">
      <SectionHeading eyebrow="ACCOUNT" title="账户资料" description="账户归属个人，不随工作范围切换。" id="profilebasictitle" />
      <dl className="profilefacts">
        <Fact label="员工号" value={context.profile.employee_no ?? '未设置'} />
        <Fact label="脱敏手机号" value={phone} />
        <Fact label="加入时间" value={formatDateTime(context.profile.joined_at)} />
        <Fact label="本地密码" value={credentialLabel(context.session.security?.hasLocalCredential)} />
        <Fact label="认证强度" value={`AAL${context.session.assurance.level}`} />
        <Fact label="会话同步" value={formatDateTime(context.session.syncedAt)} />
      </dl>
    </Surface>
  );

  const workspaceCard = (
    <Surface className="profilepanel profileworkspacepanel" depth="low" padding="spacious" role="region" aria-labelledby="profileworkspacetitle">
      <SectionHeading eyebrow="WORKSPACE" title="当前工作空间" description="切换后，菜单与数据按授权范围重新计算。" id="profileworkspacetitle" />
      <div className="profilecurrentscope">
        <span aria-hidden="true">{scopeAvatar(context.scope.kind)}</span>
        <div><strong>{scopeDisplayName(context.scope)}</strong><small>{scopeKindLabel(context.scope.kind)} · 可切换 {context.scopes.length} 个范围</small></div>
      </div>
      <dl className="profileworkspacefacts">
        <Fact label="当前范围" value={`${scopeKindLabel(context.scope.kind)} · ${scopeDisplayName(context.scope)}`} />
        <Fact label="组织路径" value={scopeTrail.map(({ name }) => name).join(' → ') || '未返回'} />
        <Fact label="路径层数" value={`${scopeTrail.length} 层`} />
      </dl>
    </Surface>
  );

  const profileDetail = <Surface className="profilepanel profileauthoritypanel" depth="low" padding="spacious" role="region" aria-labelledby="profileauthoritytitle">
    <SectionHeading eyebrow="IDENTITY & ACCESS" title="我的身份与实际权限" description="只展示当前范围内真正生效的结果。" id="profileauthoritytitle"
      trailing={<Badge tone="info">{permissionCount} 项权限生效</Badge>} />

    <div className="profileidentitysummary">
      <div className="profilegovernancecard">
        <span>治理级别</span>
        <RoleList roles={roles.governance} empty={assignmentState.ready ? '未分配治理级别' : assignmentState.description} />
        <small>决定是否可以授权、管理成员与身份。</small>
      </div>
      <div className="profilebusinesscard">
        <span>自定义业务身份</span>
        <RoleList roles={roles.business} empty={assignmentState.ready ? '暂未分配自定义业务身份' : assignmentState.description} />
        <small>身份名称只用于组织分工，不自动产生权限。</small>
      </div>
    </div>

    <div className="profileeffectivescope">
      <p>当前生效范围</p>
      <ol aria-label="当前组织路径">
        {scopeTrail.map((node, index) => <li key={node.key}>
          <span>{node.kind}</span><strong>{node.name}</strong>
          {index === scopeTrail.length - 1 ? null : <i aria-hidden="true">→</i>}
        </li>)}
      </ol>
      <small>范围由现有授权关系确定，身份名称不能自行扩大范围。</small>
    </div>

    <div className="profilepermissionsheading">
      <div><h3 id="profilepermissiontitle">权限组合</h3><p>按权威权限目录分组；每个代码均来自当前会话。</p></div>
      <Badge tone={assignmentState.tone}>{assignmentState.label}</Badge>
    </div>
    {permissionGroups.length === 0 ? <EmptyCopy>当前会话没有返回任何生效权限。</EmptyCopy> : (
      <div className="profilepermissiongroups" aria-labelledby="profilepermissiontitle">
        {permissionGroups.map((group) => <details key={group.category} className="profilepermissiongroup" open={permissionGroups.length <= 4}>
          <summary><span>{group.label}</span><Badge tone="neutral">{group.permissions.length} 项权限</Badge></summary>
          <ul>{group.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul>
        </details>)}
      </div>
    )}

    <div className="profilegrants">
      <h3>身份范围授权</h3>
      {membership === undefined ? <EmptyCopy>{assignmentState.description}</EmptyCopy> : membership.scopes.length === 0
        ? <EmptyCopy>当前身份没有单独返回范围授权。</EmptyCopy>
        : <ul>{membership.scopes.map((grant) => <li key={grant.id}>
          <Badge tone={grant.effect === 'allow' ? 'info' : 'danger'}>{grant.effect === 'allow' ? '允许' : '禁止'}</Badge>
          <span>{scopeKindLabel(grant.kind)} · {scopeIdentifierLabel(grant.kind, grant.scope)}</span>
          <small>{grant.expires === null ? '持续生效' : `至 ${formatDateTime(grant.expires)}`}</small>
        </li>)}</ul>}
    </div>

    <div className="profileformula">
      <div><span>最终工作身份</span><strong>{normalizeConsoleCopy(context.profile.display_name)} · {businessIdentity} · {scopeDisplayName(context.scope)}</strong></div>
      <p>= 自定义身份名称 + {permissionCount} 项实际权限 × {context.scopes.length} 个可切换范围</p>
    </div>
  </Surface>;

  return (
    <section className="profileworkspace" aria-label="个人信息工作台">
      <header className="profilehero">
        <div className="profileherotopline">
          <img src="/brand/morvia-compact-lockup.svg" alt="主打团" />
          <span>账户与工作身份</span>
        </div>
        <div className="profileherobody">
          <div className="profileherocopy">
            <p>PERSONAL CENTER</p>
            <h1>个人信息</h1>
            <span>一个页面看清账户、工作身份、授权范围与安全状态。</span>
          </div>
          <div className="profileidentityplate">
            <span className="profileavatar" aria-hidden="true">{avatarLetter(context.profile.display_name)}</span>
            <div className="profileidentitycopy">
              <span>当前账户</span>
              <strong>{normalizeConsoleCopy(context.profile.display_name)}</strong>
              <small>{businessIdentity} · {scopeDisplayName(context.scope)}</small>
            </div>
            <Badge tone={profileStatus.tone}>{profileStatus.label}</Badge>
            <div className="profileidentitymetrics">
              <div role={governanceIdentity === '' ? undefined : 'status'}
                aria-label={governanceIdentity === '' ? undefined : `当前治理身份：${governanceIdentity}`}>
                <span>治理身份</span><strong>{governanceIdentity || '未分配'}</strong>
              </div>
              <div><span>有效权限</span><strong>{permissionCount} 项</strong></div>
              <div><span>认证强度</span><strong>AAL{context.session.assurance.level}</strong></div>
            </div>
          </div>
        </div>
      </header>

      {businessWorkspaceAvailable ? null : (
        <Surface className="profiledegradednotice" depth="low" padding="compact" role="status">
          <strong>待授权管理员</strong>
          <span>账号已开通，正在等待 Owner 或高级管理员分配业务身份；授权后菜单、待办与业务数据会按实际权限出现。</span>
        </Surface>
      )}
      {context.profileState === 'unavailable' ? (
        <Surface className="profiledegradednotice" depth="low" padding="compact" role="status">
          <strong>个人资料暂不可用</strong>
          <span>工作空间和业务功能仍可继续使用，请稍后刷新重试。</span>
        </Surface>
      ) : null}

      <Surface className="profileinfobanner" depth="flat" padding="default" radius="large">
        <span className="profileinfoicon" aria-hidden="true">01</span>
        <div><strong>身份名称用于表达分工，权限与范围决定实际能力</strong><p>例如“财务”只是组织名称，不会自行扩大任何系统权限。</p></div>
        <Button tone="quiet" onPress={() => document.getElementById('profilepermissiontitle')?.scrollIntoView({ block: 'start' })}>
          查看权限明细
        </Button>
      </Surface>

      <div className="profileoverviewgrid" aria-label="账户与当前工作空间">
        {accountCard}
        {workspaceCard}
      </div>

      {profileDetail}
    </section>
  );
}

function SectionHeading({ description, eyebrow, id, title, trailing }: Readonly<{
  description: string;
  eyebrow: string;
  id: string;
  title: string;
  trailing?: ReactNode;
}>) {
  return <div className="profilesectionheading"><div><p>{eyebrow}</p><h2 id={id}>{title}</h2><span>{description}</span></div>{trailing}</div>;
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div className="profilefact"><dt>{label}</dt><dd>{value}</dd></div>;
}

function RoleList({ empty, roles }: Readonly<{
  empty: string;
  roles: readonly Readonly<{ id: string; label: string }>[];
}>) {
  return roles.length === 0 ? <EmptyCopy>{empty}</EmptyCopy> : <div className="profilechips">
    {roles.map((role) => <Badge key={role.id} tone="info">{role.label}</Badge>)}
  </div>;
}

function EmptyCopy({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="profileempty">{children}</p>;
}

function roleAssignmentState(canRead: boolean, pending: boolean, failed: boolean, found: boolean) {
  if (!canRead) return { ready: false, label: '未授权读取', description: '当前会话未授权读取身份分配。', tone: 'neutral' as const };
  if (pending) return { ready: false, label: '正在读取', description: '正在读取当前身份分配。', tone: 'neutral' as const };
  if (failed) return { ready: false, label: '读取失败', description: '身份分配暂时无法读取，请稍后重试。', tone: 'warning' as const };
  if (!found) return { ready: false, label: '未找到', description: '当前会员未出现在此范围的身份列表中。', tone: 'warning' as const };
  return { ready: true, label: '已同步', description: '来自管理与权限中心。', tone: 'success' as const };
}

function phoneLabel(masked: string | null | undefined, bound: boolean | undefined): string {
  if (masked !== null && masked !== undefined) return masked;
  if (bound === true) return '已绑定，号码未返回';
  if (bound === false) return '未绑定';
  return '未返回';
}

function credentialLabel(hasLocalCredential: boolean | undefined): string {
  if (hasLocalCredential === true) return '已设置';
  if (hasLocalCredential === false) return '未设置';
  return '未返回';
}

function scopeAvatar(kind: string): string {
  const labels: Readonly<Record<string, string>> = { platform: '平', distributor: '分', tenant: '商', enterprise: '集', mall: '城' };
  return labels[kind] ?? '域';
}

function avatarLetter(displayName: string): string {
  return displayName.match(/[A-Za-z]/)?.[0]?.toUpperCase() ?? (displayName.trim().slice(0, 1) || '主');
}
