import { Button, Dialog, Form } from '@shop/design';
import { ApiError } from '@shop/sdk';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ConsoleContext } from '../../entity/session/ConsoleSession';
import { appConfig } from '../../shared/config/AppConfig';
import { Icon } from '../../shared/ui/Icon';
import {
  activeMemberInvitation,
  createMemberInvitation,
  replaceMemberInvitation,
  type ActiveMemberInvitation,
} from './MemberInvitationCommand';
import { MemberInvitationDraftSchema, type MemberInvitationDraft } from './MemberInvitationSchema';
import './MemberInvitation.css';

const DEFAULT_LABEL = '主打团管理员邀请';

type InvitationField = 'destination' | 'label' | 'tenantId';
type FieldErrors = Partial<Record<InvitationField, string>>;
type CopyTarget = 'code' | 'link';
type CopyFeedback = Readonly<{ target: CopyTarget; status: 'copied' | 'failed' }> | undefined;

export function MemberInvitationDialog({
  context,
  open,
  onClose,
  onCreated,
}: Readonly<{
  context: ConsoleContext;
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}>) {
  const [governanceLevel, setGovernanceLevel] = useState<MemberInvitationDraft['governanceLevel']>('administrator');
  const [destination, setDestination] = useState('');
  const [label, setLabel] = useState(DEFAULT_LABEL);
  const [validityDays, setValidityDays] = useState(7);
  const [tenantId, setTenantId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>();
  const [activeInvitation, setActiveInvitation] = useState<ActiveMemberInvitation>();
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof createMemberInvitation>>>();
  const [submittedDraft, setSubmittedDraft] = useState<MemberInvitationDraft>();
  const mutation = useMutation({
    mutationFn: (draft: MemberInvitationDraft) => createMemberInvitation(context, draft),
    onSuccess: (value) => {
      setReceipt(value);
      setActiveInvitation(undefined);
      onCreated?.();
    },
    onError: (error) => {
      const active = activeMemberInvitation(error);
      setActiveInvitation(active);
      const presentation = invitationErrorPresentation(error, context.scope.kind === 'platform');
      setFieldErrors(presentation.fields);
      setFormError(active === undefined ? presentation.form : undefined);
    },
  });
  const replacementMutation = useMutation({
    mutationFn: ({ draft, active }: Readonly<{ draft: MemberInvitationDraft; active: ActiveMemberInvitation }>) =>
      replaceMemberInvitation(context, draft, active),
    onSuccess: (value) => {
      setReceipt(value);
      setActiveInvitation(undefined);
      onCreated?.();
    },
    onError: (error) => {
      const presentation = invitationErrorPresentation(error, context.scope.kind === 'platform');
      setFieldErrors(presentation.fields);
      setFormError(presentation.form ?? '邀请码重新生成失败，请重试。');
    },
  });
  const pending = mutation.isPending || replacementMutation.isPending;
  const tenantScopes = context.scopes.filter((scope) => scope.kind === 'tenant' && scope.id === 'tenant-zhudatuan');
  const canSelectSenior = context.session.governance?.level === 'owner';
  const selectedScope = invitationScope(context, context.scope.kind === 'platform' ? tenantId : undefined);
  const submittedScope = invitationScope(context, submittedDraft?.tenantId);

  const reset = () => {
    mutation.reset();
    replacementMutation.reset();
    setGovernanceLevel('administrator');
    setDestination('');
    setLabel(DEFAULT_LABEL);
    setValidityDays(7);
    setTenantId('');
    setFieldErrors({});
    setFormError(undefined);
    setCopyFeedback(undefined);
    setActiveInvitation(undefined);
    setReceipt(undefined);
    setSubmittedDraft(undefined);
  };

  const resetAndClose = () => {
    reset();
    onClose();
  };

  const requestClose = () => {
    if (pending) return;
    resetAndClose();
  };

  const clearError = (field: InvitationField) => {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(undefined);
    setActiveInvitation(undefined);
    if (mutation.error !== null) mutation.reset();
    if (replacementMutation.error !== null) replacementMutation.reset();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setFieldErrors({});
    setFormError(undefined);
    setCopyFeedback(undefined);
    setActiveInvitation(undefined);
    const draft = MemberInvitationDraftSchema.safeParse({
      label,
      destination,
      governanceLevel,
      maxUses: 1,
      validityDays,
      ...(context.scope.kind === 'platform' ? { tenantId } : {}),
    });
    if (!draft.success) {
      const nextErrors = invitationFieldErrors(draft.error.issues);
      setFieldErrors(nextErrors);
      if (Object.keys(nextErrors).length === 0) setFormError('邀请信息不完整，请检查后重试。');
      return;
    }
    setSubmittedDraft(draft.data);
    mutation.mutate(draft.data);
  };

  const regenerate = () => {
    if (pending || activeInvitation === undefined || submittedDraft === undefined) return;
    setFormError(undefined);
    setCopyFeedback(undefined);
    replacementMutation.mutate({ draft: submittedDraft, active: activeInvitation });
  };

  const copy = async (value: string | undefined, target: CopyTarget) => {
    if (value === undefined || navigator.clipboard === undefined) {
      setCopyFeedback({ target, status: 'failed' });
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback({ target, status: 'copied' });
    } catch {
      setCopyFeedback({ target, status: 'failed' });
    }
  };

  const invitationLink = receipt === undefined ? undefined : memberInvitationLink(receipt.code);
  const visibleFieldErrors = fieldErrors;
  const visibleFormError = activeInvitation !== undefined ? undefined : formError ?? (
    mutation.error === null && replacementMutation.error === null
      ? undefined : '邀请生成失败，请确认信息后重试。'
  );

  return (
    <Dialog
      open={open}
      title={receipt === undefined ? '邀请管理员' : '管理员邀请已生成'}
      eyebrow="主打团管理员邀请"
      dismissable={!pending}
      onClose={requestClose}
    >
      {receipt === undefined ? (
        <Form className={`command memberinvitationform${pending ? ' memberinvitationformpending' : ''}`} label="邀请管理员" validationBehavior="aria" onSubmit={submit}>
          <div className="memberinvitationbody">
            <header className="memberinvitationintro">
              <div className="memberinvitationintroicon"><Icon name="shield" /></div>
              <div>
                <p>设置管理员身份、手机号和有效期，生成后即可发送邀请。</p>
                <strong>{selectedScope.label}</strong>
              </div>
            </header>

            <div className="memberinvitationgrid">
              <fieldset className="memberinvitationlevels">
                <legend>管理员级别</legend>
                <div>
                  <label className="memberinvitationlevel" data-selected={governanceLevel === 'administrator'}>
                    <input
                      name="governanceLevel"
                      type="radio"
                      value="administrator"
                      checked={governanceLevel === 'administrator'}
                      disabled={pending}
                      onChange={() => setGovernanceLevel('administrator')}
                    />
                    <span className="memberinvitationlevelicon"><Icon name="member" /></span>
                    <span className="memberinvitationlevelcopy">
                      <span><strong>普通管理员</strong><small>注册后等待授权</small></span>
                      <em>完成注册后进入管理后台，再由 Owner 或高级管理员分配角色、权限与数据范围。</em>
                    </span>
                    <i aria-hidden="true" />
                  </label>
                  {canSelectSenior ? (
                    <label className="memberinvitationlevel" data-selected={governanceLevel === 'senior_administrator'}>
                      <input
                        name="governanceLevel"
                        type="radio"
                        value="senior_administrator"
                        checked={governanceLevel === 'senior_administrator'}
                        disabled={pending}
                        onChange={() => setGovernanceLevel('senior_administrator')}
                      />
                      <span className="memberinvitationlevelicon"><Icon name="shield" /></span>
                      <span className="memberinvitationlevelcopy">
                        <span><strong>高级管理员</strong><small>当前范围全部业务权限</small></span>
                        <em>可管理当前商户业务，但不能管理 Owner，也不能任命同级管理员。</em>
                      </span>
                      <i aria-hidden="true" />
                    </label>
                  ) : null}
                </div>
              </fieldset>

              <section className="memberinvitationdetails" aria-label="邀请信息">
                {context.scope.kind === 'platform' ? (
                  <div className="memberinvitationfield">
                    <label htmlFor="memberinvitationtenant">授权范围</label>
                    <select
                      id="memberinvitationtenant"
                      name="tenantId"
                      value={tenantId}
                      disabled={pending}
                      aria-invalid={visibleFieldErrors.tenantId === undefined ? undefined : true}
                      aria-describedby={visibleFieldErrors.tenantId === undefined ? undefined : 'memberinvitationtenanterror'}
                      onChange={(event) => { setTenantId(event.target.value); clearError('tenantId'); }}
                    >
                      <option value="" disabled>请选择目标租户</option>
                      {tenantScopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.name ?? scope.id}</option>)}
                    </select>
                    {visibleFieldErrors.tenantId === undefined ? null : <small id="memberinvitationtenanterror" className="memberinvitationfielderror">{visibleFieldErrors.tenantId}</small>}
                  </div>
                ) : null}

                <div className="memberinvitationfield">
                  <label htmlFor="memberinvitationdestination">受邀管理员手机号</label>
                  <input
                    id="memberinvitationdestination"
                    name="destination"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    value={destination}
                    disabled={pending}
                    placeholder="请输入受邀管理员的 11 位手机号"
                    aria-invalid={visibleFieldErrors.destination === undefined ? undefined : true}
                    aria-describedby={`memberinvitationdestinationhint${visibleFieldErrors.destination === undefined ? '' : ' memberinvitationdestinationerror'}`}
                    onChange={(event) => { setDestination(event.target.value); clearError('destination'); }}
                  />
                  <small id="memberinvitationdestinationhint" className="memberinvitationfieldhint">该邀请仅限此手机号完成注册。</small>
                  {visibleFieldErrors.destination === undefined ? null : <small id="memberinvitationdestinationerror" className="memberinvitationfielderror">{visibleFieldErrors.destination}</small>}
                </div>

                <div className="memberinvitationfield">
                  <label htmlFor="memberinvitationlabel">邀请名称</label>
                  <input
                    id="memberinvitationlabel"
                    name="label"
                    value={label}
                    disabled={pending}
                    maxLength={80}
                    aria-invalid={visibleFieldErrors.label === undefined ? undefined : true}
                    aria-describedby={visibleFieldErrors.label === undefined ? undefined : 'memberinvitationlabelerror'}
                    onChange={(event) => { setLabel(event.target.value); clearError('label'); }}
                  />
                  {visibleFieldErrors.label === undefined ? null : <small id="memberinvitationlabelerror" className="memberinvitationfielderror">{visibleFieldErrors.label}</small>}
                </div>

                <div className="memberinvitationfield">
                  <label htmlFor="memberinvitationvalidity">有效期</label>
                  <select
                    id="memberinvitationvalidity"
                    name="validityDays"
                    value={validityDays}
                    disabled={pending}
                    onChange={(event) => setValidityDays(Number(event.target.value))}
                  >
                    <option value="1">1 天</option>
                    <option value="3">3 天</option>
                    <option value="7">7 天</option>
                    <option value="30">30 天</option>
                    <option value="90">90 天</option>
                  </select>
                </div>
              </section>
            </div>

            <section className="memberinvitationpolicy" aria-labelledby="memberinvitationpolicytitle">
              <div className="memberinvitationpolicyheading">
                <div><span>邀请摘要</span><strong id="memberinvitationpolicytitle">生成前确认</strong></div>
                <small>仅用于当前管理范围</small>
              </div>
              <dl>
                <div><dt>管理员身份</dt><dd>{governanceLabel(governanceLevel)}</dd></div>
                <div><dt>授权范围</dt><dd>{selectedScope.name}</dd></div>
                <div><dt>绑定手机号</dt><dd>{destination === '' ? '待填写' : maskPhone(destination)}</dd></div>
                <div><dt>可使用次数</dt><dd>1 次</dd></div>
                <div><dt>到期时间</dt><dd>{previewExpiry(validityDays)}</dd></div>
              </dl>
            </section>

            {activeInvitation === undefined ? null : (
              <section className="memberinvitationactive" role="status">
                <strong>该手机号已有一张未使用的管理员邀请</strong>
                <p>
                  {activeInvitation.destinationMasked ?? maskPhone(destination)} · 有效至 {formatDate(activeInvitation.expiresAt)}。
                  原邀请码只保存安全摘要，无法再次读取。重新生成后会立即显示新邀请码，旧邀请码同时失效。
                </p>
              </section>
            )}
            {visibleFormError === undefined ? null : <p className="memberinvitationerror" role="alert">{visibleFormError}</p>}
          </div>

          <footer className="memberinvitationfooter">
            <p className="memberinvitationfootnote">邀请码仅显示一次，请生成后立即复制或发送。</p>
            <div className="memberinvitationactions">
              <Button type="button" onPress={requestClose} isDisabled={pending}>取消</Button>
              {activeInvitation === undefined ? (
                <Button type="submit" tone="primary" isPending={pending} isDisabled={pending}>
                  {pending ? '正在生成…' : '生成管理员邀请'}
                </Button>
              ) : (
                <Button type="button" tone="primary" onPress={regenerate} isPending={pending} isDisabled={pending}>
                  {pending ? '正在重新生成…' : '重新生成并显示邀请码'}
                </Button>
              )}
            </div>
          </footer>
        </Form>
      ) : (
        <section className="memberinvitationreceipt" aria-live="polite">
          <header className="memberinvitationreceiptheading">
            <span><Icon name="shield" /></span>
            <div><strong>管理员邀请已生成</strong><p>请复制邀请码或邀请链接，并发送给受邀管理员。</p></div>
          </header>

          <button
            type="button"
            className="memberinvitationcode"
            data-copy-state={copyFeedback?.target === 'code' ? copyFeedback.status : 'idle'}
            aria-label={copyFeedback?.target === 'code' && copyFeedback.status === 'copied' ? '管理员邀请码已复制' : '复制管理员邀请码'}
            onClick={() => { void copy(receipt.code, 'code'); }}
          >
            <span>管理员邀请码</span>
            <code>{receipt.code}</code>
            <small>{copyFeedback?.target === 'code' && copyFeedback.status === 'copied' ? '已复制' : '点击复制'}</small>
          </button>

          <dl className="memberinvitationreceiptdetails">
            <div><dt>管理员身份</dt><dd>{governanceLabel(receipt.governanceLevel ?? submittedDraft?.governanceLevel ?? 'administrator')}</dd></div>
            <div><dt>绑定手机号</dt><dd>{maskPhone(submittedDraft?.destination ?? '')}</dd></div>
            <div><dt>授权范围</dt><dd>{submittedScope.name}</dd></div>
            <div><dt>当前状态</dt><dd>{receipt.use_count === 0 ? '未使用' : `已使用 ${receipt.use_count} 次`}</dd></div>
            <div><dt>到期时间</dt><dd>{formatDate(receipt.expires_at)}</dd></div>
          </dl>

          <div className="memberinvitationlinkpreview">
            <span>管理员注册链接</span>
            <code>{invitationLink}</code>
          </div>

          {copyFeedback === undefined ? null : (
            <p className="memberinvitationcopystatus" data-status={copyFeedback.status} role="status">
              {copyFeedback.status === 'copied'
                ? copyFeedback.target === 'code' ? '邀请码已复制，可以直接发送。' : '邀请链接已复制，可以直接发送。'
                : '复制失败，请手动选择上方邀请码或链接后复制。'}
            </p>
          )}

          <footer>
            <Button type="button" onPress={() => { void copy(receipt.code, 'code'); }}>
              {copyFeedback?.target === 'code' && copyFeedback.status === 'copied' ? '邀请码已复制' : '复制邀请码'}
            </Button>
            <Button type="button" onPress={() => { void copy(invitationLink, 'link'); }}>
              {copyFeedback?.target === 'link' && copyFeedback.status === 'copied' ? '链接已复制' : '复制邀请链接'}
            </Button>
            <Button type="button" tone="primary" onPress={resetAndClose}>完成</Button>
          </footer>
        </section>
      )}
    </Dialog>
  );
}

function invitationFieldErrors(issues: readonly Readonly<{ path: readonly PropertyKey[] }>[]): FieldErrors {
  return issues.reduce<FieldErrors>((errors, issue) => {
    const field = issue.path[0];
    if (field === 'destination') errors.destination = '请输入正确的 11 位手机号。';
    if (field === 'label') errors.label = '邀请名称请填写 2–80 个字符。';
    if (field === 'tenantId') errors.tenantId = '请选择可用的邀请范围。';
    return errors;
  }, {});
}

function invitationErrorPresentation(error: unknown, scopeSelectable: boolean): Readonly<{ fields: FieldErrors; form?: string }> {
  if (error === null || error === undefined) return { fields: {} };
  const code = error instanceof ApiError ? error.code.toUpperCase() : error instanceof Error ? error.message.toUpperCase() : '';
  if (code.includes('ADMINISTRATOR_ALREADY_EXISTS')) return { fields: {}, form: '该手机号已经是当前商城的管理员，无需重复邀请。' };
  if (code.includes('ADMINISTRATOR_INVITATION_ALREADY_ACTIVE')) return { fields: {}, form: '该手机号已有一张未使用的管理员邀请，请前往邀请记录查看或撤销后重发。' };
  if (code.includes('DESTINATION') || code.includes('PHONE') || code.includes('MOBILE')) return { fields: { destination: '该手机号不可用，请核对后重试。' } };
  if (code.includes('LABEL')) return { fields: { label: '邀请名称不完整，请修改后重试。' } };
  if (code.includes('TENANT') || code.includes('SCOPE')) return scopeSelectable
    ? { fields: { tenantId: '邀请范围不可用，请重新选择。' } }
    : { fields: {}, form: '当前邀请范围不可用，请刷新页面后重试。' };
  if (code.includes('LEVEL_NOT_AVAILABLE') || (error instanceof ApiError && error.status === 403)) return { fields: {}, form: '当前身份不能邀请该级别管理员。' };
  if (code.includes('INVITATION_NOT_AVAILABLE') || code.includes('CSRF_MISSING')) return { fields: {}, form: '当前邀请范围不可用，请刷新页面后重试。' };
  if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) return { fields: {}, form: '网络请求失败，请稍后重试。' };
  return { fields: {}, form: '邀请生成失败，请确认信息后重试。' };
}

function invitationScope(context: ConsoleContext, tenantId?: string): Readonly<{ name: string; label: string }> {
  const scope = context.scope.kind === 'platform'
    ? context.scopes.find((candidate) => candidate.kind === 'tenant' && candidate.id === tenantId)
    : context.scope;
  const name = scope?.name ?? scope?.id ?? '请选择授权范围';
  const kind = scope?.kind === 'platform' ? '平台管理范围' : scope?.kind === 'store' ? '门店管理范围' : '商城管理范围';
  return { name, label: `${name} · ${kind}` };
}

function governanceLabel(level: MemberInvitationDraft['governanceLevel']): string {
  return level === 'senior_administrator' ? '高级管理员' : '普通管理员';
}

function maskPhone(value: string): string {
  return /^1[3-9]\d{9}$/.test(value) ? `${value.slice(0, 3)} **** ${value.slice(-4)}` : value || '未返回';
}

function previewExpiry(validityDays: number): string {
  return `${validityDays} 天后 · ${formatDate(new Date(Date.now() + validityDays * 86_400_000).toISOString())}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function memberInvitationLink(code: string): string {
  const url = new URL(appConfig.identityEntryUrl, window.location.origin);
  url.searchParams.set('invite', code);
  return url.toString();
}
