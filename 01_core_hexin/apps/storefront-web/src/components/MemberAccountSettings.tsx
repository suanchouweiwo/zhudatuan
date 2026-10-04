import React, { useState } from 'react';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_POLICY_HINT } from '@shop/contract/password-policy';
import { useMall } from '../context/MallContext';
import { productionApi } from '../services/productionApi';
import { PaymentPhoneVerificationModal } from './mobile/PaymentPhoneVerificationModal';

export function MemberAccountSettings() {
  const { user, sessionStatus, logout, refreshProductionData } = useMall();
  const [open, setOpen] = useState(false);
  const [verifyPhone, setVerifyPhone] = useState(false);
  const [mode, setMode] = useState<'password' | 'mobile'>('password');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mobile, setMobile] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (sessionStatus !== 'authenticated') return null;

  const close = () => { setOpen(false); setPassword(''); setNewPassword(''); setConfirmPassword(''); setChallenge(''); setCode(''); setMessage(''); };
  const sendCode = async () => {
    setBusy(true); setMessage('');
    try { setChallenge(await productionApi.startMemberMobileBinding(mobile, password)); setCode(''); setMessage('验证码已发送到新手机号'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '验证码发送失败'); }
    finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage('');
    if (mode === 'password' && newPassword !== confirmPassword) { setMessage('两次输入的新密码不一致'); return; }
    setBusy(true);
    try {
      if (mode === 'password') await productionApi.changeMemberPassword(password, newPassword);
      else await productionApi.completeMemberMobileBinding(mobile, challenge, code);
      setPassword(''); setNewPassword(''); setConfirmPassword(''); setCode('');
      close();
      await logout().catch(() => undefined);
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  };
  const inputClass = 'w-full rounded-xl border border-gray-200 p-3 text-sm text-gray-900';
  return <>
    <button type="button" onClick={() => setOpen(true)} className="mt-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-bold text-[var(--sw-brand)]">账号设置</button>
    {open && <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 p-3 text-gray-900">
      <form onSubmit={save} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex justify-between"><h2 className="font-bold">账号设置</h2><button type="button" disabled={busy} onClick={close}>关闭</button></div>
        <div className="flex gap-3">{(['password', 'mobile'] as const).map((value) => <button key={value} type="button" disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); setMessage(''); setChallenge(''); setCode(''); }} className="rounded-lg border px-3 py-2 text-sm">{value === 'password' ? '修改密码' : '绑定／更换手机'}</button>)}</div>
        <p className="text-xs text-gray-500">当前手机：{user.phone}</p>
        <button type="button" disabled={busy} onClick={() => setVerifyPhone(true)} className="text-xs text-[var(--sw-brand)]">验证当前手机号</button>
        <label className="block text-xs">当前密码<input required disabled={busy} type="password" autoComplete="current-password" value={password} onChange={(event) => { setPassword(event.target.value); setChallenge(''); }} className={inputClass} /></label>
        {mode === 'password' ? <>
          <label className="block text-xs">新密码<input required disabled={busy} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} placeholder={PASSWORD_POLICY_HINT} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className={inputClass} /></label>
          <label className="block text-xs">确认新密码<input required disabled={busy} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={inputClass} /></label>
          <p className="text-xs text-gray-500">保存成功后，请使用新密码重新登录。</p>
        </> : <>
          <label className="block text-xs">新手机号<input required disabled={busy} type="tel" autoComplete="tel" value={mobile} onChange={(event) => { setMobile(event.target.value); setChallenge(''); setCode(''); }} className={inputClass} /></label>
          <button type="button" disabled={busy || !mobile || !password} onClick={sendCode} className="text-sm text-[var(--sw-brand)]">获取新手机验证码</button>
          <label className="block text-xs">短信验证码<input required disabled={busy} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className={inputClass} /></label>
          <p className="text-xs text-gray-500">更换成功后请使用新手机号重新登录。</p>
        </>}
        {message && <p role="status" className="text-xs text-amber-700">{message}</p>}
        <button disabled={busy || (mode === 'mobile' && (!challenge || code.length !== 6))} className="w-full rounded-xl bg-[var(--sw-brand)] p-3 text-sm font-bold text-white">{busy ? '正在处理…' : '保存'}</button>
      </form>
    </div>}
    {verifyPhone && <PaymentPhoneVerificationModal purpose="account" phone={user.phone} onClose={() => setVerifyPhone(false)} onVerified={async () => { setVerifyPhone(false); await refreshProductionData(); setMessage('当前手机号已验证'); }} />}
  </>;
}
