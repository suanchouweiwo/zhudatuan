export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function sessionExpiresIn(sessionExpiresAt: Date, at = Date.now()): number {
  return Math.max(1, Math.min(SESSION_MAX_AGE_SECONDS, Math.floor((sessionExpiresAt.getTime() - at) / 1_000)));
}
