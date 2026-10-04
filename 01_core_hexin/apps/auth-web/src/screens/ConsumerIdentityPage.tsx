import React, { useEffect, useState } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT, PASSWORD_POLICY_MESSAGE, passwordMeetsPolicy } from '@shop/contract/password-policy';
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronRight, Eye, EyeOff, FileText, KeyRound, LoaderCircle, LogIn, ShieldCheck, Smartphone, UserPlus, X } from 'lucide-react';
import { automaticL6DisplayName } from '../services/consumerRegistration';
import {
  createCanonicalPasswordResetChallenge,
  loginCanonicalStorefrontEntry,
  resetCanonicalPassword,
} from '../services/canonicalIdentity';
import {
  createCanonicalMember,
  createCanonicalRegistrationChallenge,
  resolveCanonicalInvite,
  resolveCanonicalStorefrontRegistration,
  type CanonicalInvitation,
  type CanonicalStorefrontRegistration,
} from '../services/canonicalRegistration';
import { useIdentityActions } from './useIdentityActions';
import { MorviaIdentityShell } from './MorviaIdentityShell';

type IdentityMode = 'login' | 'register' | 'reset';
type RecoveryStep = 'account' | 'verify' | 'password' | 'success';
type ConsumerActionKey = 'consumer-login' | 'consumer-register' | 'consumer-registration-code' | 'consumer-reset-code' | 'consumer-reset';

export const ConsumerIdentityPage: React.FC<{
  application: string;
  brandName?: string;
  mallName?: string;
  brand: 'morvia' | 'hongtai';
  onAudienceSwitch: () => void;
}> = ({ application, brandName, mallName, brand, onAudienceSwitch }) => {
  const [inviteCode] = useState(() => new URLSearchParams(window.location.search).get('invite')?.trim().toUpperCase() ?? '');
  const [mode, setMode] = useState<IdentityMode>(inviteCode ? 'register' : 'login');
  const [context, setContext] = useState<CanonicalStorefrontRegistration | CanonicalInvitation | null>(null);
  const [registrationChallenge, setRegistrationChallenge] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');
  const [registrationIdentityExists, setRegistrationIdentityExists] = useState(false);
  const [memberships, setMemberships] = useState<readonly string[]>([]);
  const [contextError, setContextError] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetChallenge, setResetChallenge] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>('account');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [policy, setPolicy] = useState<'terms' | 'privacy' | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const identityActions = useIdentityActions<ConsumerActionKey>();

  useEffect(() => {
    const controller = new AbortController();
    setContext(null);
    setContextError('');
    const resolution = inviteCode
      ? resolveCanonicalInvite(inviteCode, controller.signal)
      : resolveCanonicalStorefrontRegistration(application, controller.signal);
    void resolution
      .then((resolved) => {
        if (resolved.target !== 'storefront') throw new Error('这是运营会员邀请，请切换至运营入口');
        setContext(resolved);
        document.title = `${mallName ?? resolved.organizationName}会员登录｜${brandName ?? (brand === 'hongtai' ? '宏泰甄选' : '主打团')}`;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setContextError(messageOf(error));
      });
    return () => controller.abort();
  }, [application, brand, brandName, mallName, inviteCode]);

  useEffect(() => {
    identityActions.cancel('consumer-login');
    setMemberships([]);
  }, [mobile, password, mode, identityActions.cancel]);

  useEffect(() => {
    identityActions.cancel('consumer-registration-code');
    setRegistrationChallenge('');
    setRegistrationCode('');
    setRegistrationIdentityExists(false);
  }, [mobile, mode, identityActions.cancel]);

  const switchMode = (next: IdentityMode) => {
    identityActions.cancel();
    setMode(next);
    setFormError('');
    setNotice('');
    setConfirmPassword('');
    setResetConfirm('');
    if (next === 'reset') setRecoveryStep('account');
    if (next !== 'reset') {
      setResetCode('');
      setResetChallenge('');
      setRecoveryStep('account');
    }
  };

  const submitLogin = (membership?: string) => {
    const loginMobile = mobile.trim();
    if (!loginMobile) return setFormError('请输入登录手机号');
    if (!password) return setFormError('请输入密码');
    setFormError('');
    identityActions.run(
      'consumer-login',
      (signal) => loginCanonicalStorefrontEntry(loginMobile, password, application, signal, membership),
      {
        completionStages: (result) => 'kind' in result ? ['server-response'] : ['server-response', 'session-exchange', 'redirect'],
        onSuccess: (result) => {
          if ('kind' in result) setMemberships(result.memberships);
          else window.location.assign(result.redirectUrl);
        },
        onError: (error) => setFormError(messageOf(error)),
      },
    );
  };

  const sendRegistrationCode = () => {
    setFormError('');
    identityActions.run('consumer-registration-code',
      (signal) => createCanonicalRegistrationChallenge(mobile, inviteCode, signal), {
        onSuccess: (challenge) => {
          setRegistrationChallenge(challenge.challengeId);
          setRegistrationCode('');
          setRegistrationIdentityExists(challenge.identityExists);
          setNotice(challenge.identityExists ? '已识别现有账号，验证手机号后加入受邀会员身份，继续使用原密码。' : '验证码已发送，请填写短信验证码');
        },
        onError: (error) => setFormError(messageOf(error)),
      });
  };

  const submitRegistration = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const registrationContext = context;
    if (registrationContext === null) return setFormError(contextError || '商城注册入口正在读取，请稍后重试');
    if (!registrationIdentityExists && !passwordMeetsPolicy(password)) return setFormError(PASSWORD_POLICY_MESSAGE);
    if (!registrationIdentityExists && password !== confirmPassword) return setFormError('两次输入的密码不一致');
    if (!acceptedTerms) return setFormError('请先阅读并同意服务协议与隐私政策');
    if (inviteCode && (!registrationChallenge || registrationCode.length !== 6)) return setFormError('请获取并填写邀请注册的短信验证码');
    setFormError('');
    identityActions.run(
      'consumer-register',
      async (signal) => {
        const created = await createCanonicalMember({
          subject: mobile,
          ...(registrationIdentityExists ? {} : { password }),
          displayName: automaticL6DisplayName(mobile),
          ...(inviteCode ? { inviteCode, challengeId: registrationChallenge, code: registrationCode }
            : { applicationSlug: (registrationContext as CanonicalStorefrontRegistration).applicationSlug, deferPhoneVerification: true }),
          termsAccepted: true,
          termsHash: registrationContext.termsHash,
          directLogin: true,
        }, signal);
        if (!created.redirectUrl) throw new Error('账号已创建，但登录会话未能建立，请直接登录');
        return created;
      },
      {
        completionStages: ['server-response', 'session-exchange', 'redirect'],
        onSuccess: (created) => window.location.assign(created.redirectUrl!),
        onError: (error) => setFormError(messageOf(error)),
      },
    );
  };

  const sendResetCode = () => {
    setFormError('');
    setNotice('');
    identityActions.run(
      'consumer-reset-code',
      (signal) => createCanonicalPasswordResetChallenge(mobile, signal),
      {
        onSuccess: (challenge) => {
          setResetChallenge(challenge.challengeId);
          setResetCode('');
          setRecoveryStep('verify');
        },
        onError: (error) => setFormError(messageOf(error)),
      },
    );
  };

  const continueResetVerification = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (resetCode.length !== 6) return setFormError('请输入完整的 6 位短信验证码');
    setFormError('');
    setRecoveryStep('password');
  };

  const resetPassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetChallenge) return setFormError('请先获取验证码');
    if (!passwordMeetsPolicy(password)) return setFormError(PASSWORD_POLICY_MESSAGE);
    if (password !== resetConfirm) return setFormError('两次输入的密码不一致');
    setFormError('');
    setNotice('');
    identityActions.run(
      'consumer-reset',
      (signal) => resetCanonicalPassword(resetChallenge, resetCode, password, signal),
      {
        onSuccess: () => {
          setPassword('');
          setResetConfirm('');
          setRecoveryStep('success');
        },
        onError: (error) => {
          setRecoveryStep('verify');
          setFormError(messageOf(error));
        },
      },
    );
  };

  const organizationName = mallName ?? context?.organizationName ?? brandName ?? (brand === 'hongtai' ? '宏泰甄选' : '主打团');
  const submitting = identityActions.isBusy(mode === 'login' ? 'consumer-login' : mode === 'register' ? 'consumer-register' : 'consumer-reset');
  const resetCodeBusy = identityActions.isBusy('consumer-reset-code');
  const maskedMobile = maskMobile(mobile);
  const modeTitle = mode === 'login'
    ? organizationName
    : mode === 'register'
      ? '创建会员账号'
      : recoveryStep === 'account'
        ? '找回您的会员账号'
        : recoveryStep === 'verify'
          ? '验证手机号'
          : recoveryStep === 'password'
            ? '设置新密码'
            : '密码已更新';
  const modeDescription = mode === 'login'
    ? '登录后进入个人中心与福利商城'
    : mode === 'register'
      ? '使用手机号创建你的会员账号'
      : recoveryStep === 'account'
        ? '输入与会员账号绑定的手机号，我们将发送验证码'
        : recoveryStep === 'verify'
          ? `验证码已发送至 ${maskedMobile}，请完成身份验证`
          : recoveryStep === 'password'
            ? '手机号验证成功，请为会员账号设置一个新密码'
            : `现在可以使用新密码登录${organizationName}`;
  const busyLabel = mode === 'login' ? '正在登录…' : mode === 'register' ? '正在创建账号…' : '正在重置密码…';

  return (
    <>
      <MorviaIdentityShell audience="consumer" brand={brand} brandName={brandName} contextLabel={organizationName} onAudienceSwitch={onAudienceSwitch}>
        <div className="mb-7">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--sw-brand)]">
            {mode === 'reset' ? <KeyRound className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            {mode === 'reset' ? '账号恢复' : '会员渠道'}
          </div>
          <h2 className="mt-2 font-['MORVIA_Title'] text-3xl font-bold tracking-[-0.035em] text-[#111111]">{modeTitle}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">{modeDescription}</p>
        </div>

          {((mode === 'register' && contextError) || formError) && (
            <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{formError || contextError}</span>
            </div>
          )}

          {notice && (
            <div role="status" className="mb-5 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          {mode !== 'reset' && <form onSubmit={mode === 'login' ? (event) => event.preventDefault() : submitRegistration} className="space-y-4">
            <label className="block space-y-1.5 text-xs font-semibold text-slate-700">
              {mode === 'register' && !inviteCode ? '登录手机号（付款时验证）' : '登录手机号'}
              <input type="tel" inputMode="tel" autoComplete="tel" required value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="请输入 11 位手机号" className="w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm outline-none transition focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
            </label>
            {!(mode === 'register' && registrationIdentityExists) && <div className="block space-y-1.5 text-xs font-semibold text-slate-700">
              <span className="flex items-center justify-between">
                <span>{mode === 'register' ? '设置密码' : '密码'}</span>
                {mode === 'login' && <button type="button" onClick={() => switchMode('reset')} className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-bold text-[var(--sw-brand)] shadow-sm transition hover:border-blue-300 hover:bg-blue-100">忘记密码？</button>}
              </span>
              <span className="relative block">
                <input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={mode === 'register' ? PASSWORD_MIN_LENGTH : undefined} maxLength={PASSWORD_MAX_LENGTH} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'register' ? PASSWORD_POLICY_HINT : '请输入密码'} className="w-full rounded-xl border border-slate-200 px-3.5 py-3 pr-11 text-sm outline-none transition focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
                <button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? '隐藏密码' : '显示密码'} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </span>
            </div>}

            {mode === 'register' && (
              <>
                {!registrationIdentityExists && <label className="block space-y-1.5 text-xs font-semibold text-slate-700">
                  确认密码
                  <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" className="w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm outline-none transition focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
                </label>}
                {inviteCode ? <div className="space-y-2">
                  <p className="text-xs text-slate-500">受邀加入：{context?.organizationName} · {inviteCode}</p>
                  <label className="block space-y-1.5 text-xs font-semibold text-slate-700">短信验证码
                    <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="请输入 6 位验证码" className="w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm" />
                  </label>
                  <button type="button" disabled={!context || identityActions.isBusy('consumer-registration-code')} onClick={sendRegistrationCode} className="text-xs font-semibold text-[var(--sw-brand)]">{identityActions.isBusy('consumer-registration-code') ? '正在发送…' : '获取验证码'}</button>
                </div> : <p className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">本步不发送验证码；首次付款时验证该手机号。</p>}
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-slate-500">
                  <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} disabled={context === null} className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-[var(--sw-brand)]" />
                  <span>我已阅读并同意<button type="button" disabled={context === null} onClick={() => setPolicy('terms')} className="text-[var(--sw-brand)] hover:underline disabled:text-slate-400">《用户服务协议》</button>和<button type="button" disabled={context === null} onClick={() => setPolicy('privacy')} className="text-[var(--sw-brand)] hover:underline disabled:text-slate-400">《隐私保护政策》</button></span>
                </label>
              </>
            )}

            <button
              type={mode === 'login' ? 'button' : 'submit'}
              disabled={submitting || (mode === 'register' && (context === null || !acceptedTerms))}
              onPointerDown={() => identityActions.pointerDown(mode === 'login' ? 'consumer-login' : 'consumer-register')}
              onClick={mode === 'login' ? () => submitLogin() : undefined}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--sw-brand)] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/15 transition hover:bg-[var(--sw-brand-dark)] disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : mode === 'login' ? <LogIn className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
              {submitting ? busyLabel : mode === 'login' ? '登录并进入商城' : '创建账号并进入商城'}
            </button>
            {mode === 'login' && memberships.length > 0 && <div className="space-y-2" role="group" aria-label="选择会员身份">
              <p className="text-xs text-slate-500">请选择本次使用的会员身份</p>
              {memberships.map((membership, index) => <button key={membership} type="button" disabled={submitting} onClick={() => submitLogin(membership)} className="w-full rounded-xl border border-blue-200 px-3 py-2 text-left text-xs text-[var(--sw-brand)]">会员身份 {index + 1} · {membership}</button>)}
            </div>}
            {mode === 'login' && <button type="button" onClick={() => switchMode('register')} className="flex w-full items-center justify-center gap-2 rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-bold text-[var(--sw-brand)] shadow-sm transition hover:border-blue-300 hover:bg-blue-50"><UserPlus className="h-4 w-4" />注册会员</button>}
            {mode === 'register' && <button type="button" onClick={() => switchMode('login')} className="flex w-full items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-[var(--sw-brand)]"><ArrowLeft className="h-3.5 w-3.5" />返回登录</button>}
          </form>}

          {mode === 'reset' && (
            <div>
              {recoveryStep !== 'success' && <div className="mb-6 flex items-center gap-2" aria-label={`找回密码第 ${recoveryStep === 'account' ? 1 : recoveryStep === 'verify' ? 2 : 3} 步，共 3 步`}>
                <span className="h-1.5 flex-1 rounded-full bg-[var(--sw-brand)]" />
                <span className={`h-1.5 flex-1 rounded-full ${recoveryStep !== 'account' ? 'bg-[var(--sw-brand)]' : 'bg-slate-200'}`} />
                <span className={`h-1.5 flex-1 rounded-full ${recoveryStep === 'password' ? 'bg-[var(--sw-brand)]' : 'bg-slate-200'}`} />
                <span className="ml-2 text-[11px] font-semibold text-slate-400">{recoveryStep === 'account' ? '1 / 3' : recoveryStep === 'verify' ? '2 / 3' : '3 / 3'}</span>
              </div>}

              {recoveryStep === 'account' && (
                <form onSubmit={(event) => { event.preventDefault(); sendResetCode(); }} className="space-y-5">
                  <label className="block space-y-2 text-xs font-semibold text-slate-700">
                    手机号
                    <span className="relative block">
                      <Smartphone className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input type="tel" inputMode="tel" autoComplete="tel" autoFocus required value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="请输入绑定的手机号" className="w-full rounded-xl border border-slate-200 py-3.5 pl-11 pr-4 text-sm outline-none transition focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
                    </span>
                  </label>
                  <button type="submit" disabled={resetCodeBusy || !mobile.trim()} onPointerDown={() => identityActions.pointerDown('consumer-reset-code')} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--sw-brand)] px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-blue-500/15 transition hover:bg-[var(--sw-brand-dark)] disabled:cursor-not-allowed disabled:bg-slate-300">
                    {resetCodeBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                    {resetCodeBusy ? '正在发送验证码…' : '继续'}
                  </button>
                </form>
              )}

              {recoveryStep === 'verify' && (
                <form onSubmit={continueResetVerification} className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <span className="flex items-center gap-2 text-xs font-semibold text-slate-700"><Smartphone className="h-4 w-4 text-[var(--sw-brand)]" />{maskedMobile}</span>
                    <button type="button" onClick={() => { setResetChallenge(''); setResetCode(''); setFormError(''); setRecoveryStep('account'); }} className="text-xs font-semibold text-[var(--sw-brand)] hover:underline">更换手机号</button>
                  </div>
                  <label className="block space-y-1.5 text-xs font-semibold text-slate-700">
                    短信验证码
                    <input required inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={resetCode} onChange={(event) => setResetCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="请输入 6 位验证码" className="w-full rounded-xl border border-slate-200 px-4 py-3 text-center text-lg font-bold tracking-[0.42em] outline-none transition placeholder:text-sm placeholder:font-normal placeholder:tracking-normal focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
                  </label>
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>没有收到验证码？</span>
                    <button type="button" disabled={resetCodeBusy} onPointerDown={() => identityActions.pointerDown('consumer-reset-code')} onClick={sendResetCode} className="font-semibold text-[var(--sw-brand)] hover:underline disabled:opacity-50">{resetCodeBusy ? '正在发送…' : '重新发送'}</button>
                  </div>
                  <button type="submit" className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--sw-brand)] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/15 transition hover:bg-[var(--sw-brand-dark)]">
                    验证并继续<ChevronRight className="h-4 w-4" />
                  </button>
                </form>
              )}

              {recoveryStep === 'password' && (
                <form onSubmit={resetPassword} className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                    <span className="flex items-center gap-2 text-xs font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" />{maskedMobile}</span>
                    <span className="text-[11px] font-bold text-emerald-700">已验证</span>
                  </div>
                  <label className="block space-y-1.5 text-xs font-semibold text-slate-700">
                    新密码
                    <span className="relative block">
                      <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={PASSWORD_POLICY_HINT} className="w-full rounded-xl border border-slate-200 px-3.5 py-3 pr-11 text-sm outline-none transition focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
                      <button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? '隐藏密码' : '显示密码'} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                    </span>
                  </label>
                  <label className="block space-y-1.5 text-xs font-semibold text-slate-700">
                    确认新密码
                    <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} value={resetConfirm} onChange={(event) => setResetConfirm(event.target.value)} placeholder="再次输入新密码" className="w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm outline-none transition focus:border-[var(--sw-brand)] focus:ring-2 focus:ring-blue-100" />
                  </label>
                  <button type="submit" disabled={submitting} onPointerDown={() => identityActions.pointerDown('consumer-reset')} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--sw-brand)] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/15 transition hover:bg-[var(--sw-brand-dark)] disabled:cursor-not-allowed disabled:bg-slate-300">
                    {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                    {submitting ? busyLabel : '保存新密码'}
                  </button>
                </form>
              )}

              {recoveryStep === 'success' && (
                <div className="py-6 text-center">
                  <span className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-[12px] ring-emerald-50/60"><CheckCircle2 className="h-9 w-9" /></span>
                  <p className="mt-7 text-sm leading-6 text-slate-500">会员资料和订单不会受到影响。</p>
                  <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left"><span className="block text-[11px] font-bold text-slate-700">会员账号</span><span className="mt-1 block text-xs text-slate-500">{maskedMobile}</span></div>
                  <button type="button" onClick={() => switchMode('login')} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--sw-brand)] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/15">使用新密码登录<ChevronRight className="h-4 w-4" /></button>
                </div>
              )}

              {recoveryStep !== 'success' && <button type="button" onClick={() => {
                if (recoveryStep === 'password') setRecoveryStep('verify');
                else if (recoveryStep === 'verify') setRecoveryStep('account');
                else switchMode('login');
                setFormError('');
              }} className="mt-5 flex w-full items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-[var(--sw-brand)]"><ArrowLeft className="h-3.5 w-3.5" />{recoveryStep === 'account' ? '返回登录' : '返回上一步'}</button>}
            </div>
          )}
      </MorviaIdentityShell>

      {policy !== null && context !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[82vh] w-full max-w-lg flex-col rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="flex items-center gap-2 font-bold text-slate-900"><FileText className="h-5 w-5 text-[var(--sw-brand)]" />{policy === 'terms' ? context.termsTitle : context.privacyTitle}</h3>
              <button type="button" onClick={() => setPolicy(null)} aria-label="关闭" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto whitespace-pre-wrap pr-2 text-xs leading-6 text-slate-600">{policy === 'terms' ? context.termsBody : context.privacyBody}</div>
            <button type="button" onClick={() => setPolicy(null)} className="mt-5 self-end rounded-xl bg-[var(--sw-brand)] px-5 py-2 text-xs font-semibold text-white">关闭</button>
          </div>
        </div>
      )}
    </>
  );
};

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== 'Failed to fetch') return error.message;
  return '商城服务暂时未连接，请稍后重试';
}

function maskMobile(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return value;
  return `${digits.slice(0, 3)} **** ${digits.slice(-4)}`;
}
