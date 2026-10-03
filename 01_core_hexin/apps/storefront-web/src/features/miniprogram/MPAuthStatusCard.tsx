import React from 'react';
import type { SessionStatus } from '../../context/MallContext.types';
import type { UserProfile } from '../../types';

interface MPAuthStatusCardProps {
  authHref?: string;
  onRetry?: () => void;
  sessionError?: string | null;
  sessionStatus: SessionStatus;
  user: UserProfile;
}

const cardClassName = 'flex h-[68px] w-full items-center border border-white/20 bg-white px-3.5 text-left shadow-sm transition-[border-color,box-shadow,background-color]';

export const AUTH_WELCOME_HOLD_MS = 2200;
export const AUTH_WELCOME_FADE_MS = 720;
export const AUTH_WELCOME_COLLAPSE_MS = 520;
export const AUTH_WELCOME_EXIT_MS = AUTH_WELCOME_FADE_MS + AUTH_WELCOME_COLLAPSE_MS;
export const AUTH_LOGIN_TRANSITION_MS = 420;

function FrostDewVisual() {
  return (
    <span
      data-auth-loader="visual"
      data-auth-loader-style="frost-dew"
      aria-hidden="true"
      className="sw-auth-frost-dew h-9 w-24"
    >
      <span className="sw-auth-frost-dew-ring" />
      <span className="sw-auth-frost-dew-orb" />
    </span>
  );
}

export function MPAuthStatusCard({ authHref, onRetry, sessionError, sessionStatus, user }: MPAuthStatusCardProps) {
  const [welcomePhase, setWelcomePhase] = React.useState<'visible' | 'fading' | 'collapsing' | 'hidden'>('visible');
  const [isEnteringLogin, setIsEnteringLogin] = React.useState(false);
  const loginTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const resetLoginTransition = () => {
      if (loginTimerRef.current !== null) window.clearTimeout(loginTimerRef.current);
      loginTimerRef.current = null;
      setIsEnteringLogin(false);
    };
    window.addEventListener('pageshow', resetLoginTransition);
    return () => {
      window.removeEventListener('pageshow', resetLoginTransition);
      if (loginTimerRef.current !== null) window.clearTimeout(loginTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setWelcomePhase('visible');
      return undefined;
    }

    setWelcomePhase('visible');
    const fadeTimer = window.setTimeout(() => setWelcomePhase('fading'), AUTH_WELCOME_HOLD_MS);
    const collapseTimer = window.setTimeout(
      () => setWelcomePhase('collapsing'),
      AUTH_WELCOME_HOLD_MS + AUTH_WELCOME_FADE_MS,
    );
    const hideTimer = window.setTimeout(() => setWelcomePhase('hidden'), AUTH_WELCOME_HOLD_MS + AUTH_WELCOME_EXIT_MS);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(collapseTimer);
      window.clearTimeout(hideTimer);
    };
  }, [sessionStatus, user.id]);

  if (sessionStatus === 'authenticated' && welcomePhase === 'hidden') return null;

  const isWelcomeFading = sessionStatus === 'authenticated' && (welcomePhase === 'fading' || welcomePhase === 'collapsing');
  const isWelcomeCollapsing = sessionStatus === 'authenticated' && welcomePhase === 'collapsing';
  const enterLogin = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!authHref || isEnteringLogin || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setIsEnteringLogin(true);
    loginTimerRef.current = window.setTimeout(() => {
      loginTimerRef.current = null;
      window.location.assign(authHref);
    }, AUTH_LOGIN_TRANSITION_MS);
  };

  return (
    <div
      className={`overflow-hidden bg-[var(--sw-brand-dark)] px-3 transition-[height,padding-bottom] duration-[520ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
        isWelcomeCollapsing ? 'pointer-events-none h-0 pb-0' : 'h-20 pb-3'
      }`}
      data-auth-shell={sessionStatus === 'guest' && isEnteringLogin ? 'checking' : sessionStatus}
      data-auth-phase={welcomePhase}
    >
      {sessionStatus === 'checking' ? (
        <div
          className={`${cardClassName} justify-center gap-2.5`}
          role="status"
          aria-label={sessionError ?? '正在确认会员身份'}
          aria-live="polite"
          aria-busy="true"
        >
          <FrostDewVisual />
          {sessionError ? (
            <>
              <span className="max-w-36 truncate text-xs font-semibold text-slate-600" title={sessionError}>
                {sessionError}
              </span>
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="shrink-0 rounded-full border border-blue-200 px-2.5 py-1 text-xs font-semibold text-blue-700"
                >
                  重试
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : sessionStatus === 'guest' ? (
        <a
          href={authHref}
          onClick={enterLogin}
          aria-label={isEnteringLogin ? '正在进入MORVIA 账户' : '进入MORVIA 账户'}
          aria-busy={isEnteringLogin || undefined}
          data-auth-action="login"
          data-auth-state={isEnteringLogin ? 'entering' : 'idle'}
          className={`${cardClassName} relative justify-center overflow-hidden ${
            isEnteringLogin ? 'pointer-events-none border-blue-200 bg-blue-50/40 shadow-md' : 'hover:border-blue-200 hover:shadow-md'
          }`}
        >
          <span
            data-auth-prompt="login"
            className={`text-sm font-semibold tracking-[0.12em] text-slate-700 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
              isEnteringLogin ? 'opacity-0' : 'opacity-100'
            }`}
          >
            轻轻一点，恰逢所喜。
          </span>
          <span
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
              isEnteringLogin ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <FrostDewVisual />
          </span>
        </a>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className={`${cardClassName} justify-center transition-opacity duration-[720ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
            isWelcomeFading
              ? 'pointer-events-none opacity-0'
              : 'sw-auth-welcome-card opacity-100'
          }`}
        >
          <span className="truncate text-sm font-semibold tracking-[0.08em] text-slate-700">欢迎 {user.name} 回来</span>
        </div>
      )}
    </div>
  );
}
