import React, { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { productionApi, ProductionApiError } from '../../services/productionApi';

const RESEND_SECONDS = 45;

type PaymentPhoneVerificationModalProps = Readonly<{
  phone: string;
  onClose: () => void;
  onVerified: () => Promise<void>;
} & ({ purpose?: 'payment' | 'account'; bindingToken?: never } | { purpose: 'wechat-binding'; bindingToken: string })>;

export function PaymentPhoneVerificationModal(props: PaymentPhoneVerificationModalProps) {
  const { phone, onClose, onVerified, purpose = 'payment' } = props;
  const bindingToken = props.purpose === 'wechat-binding' ? props.bindingToken : undefined;
  const isWechatBinding = purpose === 'wechat-binding';
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [seconds, setSeconds] = useState(RESEND_SECONDS);
  const [sending, setSending] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  const requestCode = async () => {
    if (sending) return;
    setSending(true);
    setError('');
    try {
      const challenge = await productionApi.startPaymentPhoneVerification();
      setChallengeId(challenge.challengeId);
      setSeconds(RESEND_SECONDS);
    } catch (cause) {
      setSeconds(0);
      setError(cause instanceof ProductionApiError ? cause.message : '验证码发送失败，请稍后重试');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    let active = true;
    void productionApi.startPaymentPhoneVerification().then((challenge) => {
      if (!active) return;
      setChallengeId(challenge.challengeId);
      setSeconds(RESEND_SECONDS);
    }).catch((cause) => {
      if (!active) return;
      setSeconds(0);
      setError(cause instanceof ProductionApiError ? cause.message : '验证码发送失败，请稍后重试');
    }).finally(() => {
      if (active) setSending(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setInterval(() => setSeconds((current) => Math.max(0, current - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [seconds > 0]);

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challengeId || !/^\d{6}$/.test(code) || verifying) return;
    setVerifying(true);
    setError('');
    try {
      await productionApi.completePaymentPhoneVerification(challengeId, code, bindingToken);
      await onVerified();
    } catch (cause) {
      setError(cause instanceof ProductionApiError ? cause.message : '手机验证失败，请重试');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/45 p-3 sm:items-center">
      <form onSubmit={verify} className="w-full max-w-[400px] rounded-3xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex gap-3"><div className="rounded-2xl bg-blue-50 p-2 text-[var(--sw-brand)]"><ShieldCheck className="h-6 w-6" /></div>
            <div><h2 className="text-base font-black">{isWechatBinding ? '微信改绑验证' : purpose === 'account' ? '验证当前手机号' : '支付前验证手机号'}</h2><p className="mt-1 text-[11px] text-gray-500">{sending ? '正在提交验证码请求' : '验证码请求已提交'} · {phone}</p></div></div>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded-full p-1 text-gray-400"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-4 flex gap-2">
          <input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="输入 6 位验证码"
            className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-3 text-base font-bold tracking-[0.3em] outline-none focus:border-blue-400" />
          <button type="button" onClick={requestCode} disabled={sending || seconds > 0} className="w-28 rounded-xl border border-blue-200 bg-blue-50 px-2 text-xs font-bold text-[var(--sw-brand)] disabled:text-gray-400">
            {sending ? '发送中…' : seconds > 0 ? `重发 ${seconds}s` : '重新获取'}
          </button>
        </div>
        {error && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-700">{error}</p>}
        <button type="submit" disabled={!challengeId || code.length !== 6 || verifying} className="mt-4 w-full rounded-xl bg-[var(--sw-brand)] py-3 text-sm font-black text-white disabled:bg-gray-300">
          {verifying ? '正在验证…' : isWechatBinding ? '验证并完成微信改绑' : purpose === 'account' ? '完成验证' : '验证并继续支付'}
        </button>
        <p className="mt-3 text-center text-[10px] text-gray-400">收到短信即可立即验证，无需等待倒计时</p>
      </form>
    </div>
  );
}
