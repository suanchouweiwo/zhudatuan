export type AuthTarget = 'console' | 'storefront' | 'store' | 'supplier';

export function authTarget(value: string): AuthTarget {
  const target = value === 'operator' ? 'console' : value;
  if (!['console', 'storefront', 'store', 'supplier'].includes(target)) throw new Error('AUTH_RETURN_TARGET_INVALID');
  return target as AuthTarget;
}

export function authMembershipTarget(target: AuthTarget): AuthTarget {
  return target;
}
