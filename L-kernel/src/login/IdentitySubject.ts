const MOBILE = /^\+?[1-9][0-9]{7,14}$/;
const CHINA_NATIONAL = /^1[3-9][0-9]{9}$/;
const CHINA_COUNTRY = /^86(1[3-9][0-9]{9})$/;

export function canonicalMobile(value: string): string {
  const compact = value.trim().replace(/[\s()-]/g, '');
  if (!MOBILE.test(compact)) throw new Error('MOBILE_INVALID');
  if (CHINA_NATIONAL.test(compact)) return `+86${compact}`;
  const withoutPlus = compact.startsWith('+') ? compact.slice(1) : compact;
  const china = CHINA_COUNTRY.exec(withoutPlus);
  if (china) return `+86${china[1]}`;
  const canonical = compact.startsWith('+') ? compact : `+${compact}`;
  if (!MOBILE.test(canonical)) throw new Error('MOBILE_INVALID');
  return canonical;
}

export function canonicalIdentitySubject(value: string): string {
  const normalized = value.trim().toLowerCase();
  const compact = normalized.replace(/[\s()-]/g, '');
  if (MOBILE.test(compact)) return canonicalMobile(normalized);
  if (!normalized) throw new Error('IDENTITY_SUBJECT_INVALID');
  return normalized;
}

export function identitySubjectVariants(value: string): readonly string[] {
  const normalized = value.trim().toLowerCase();
  const canonical = canonicalIdentitySubject(value);
  const variants = new Set([canonical, normalized]);
  if (/^\+861[3-9][0-9]{9}$/.test(canonical)) variants.add(canonical.slice(3));
  return Object.freeze([...variants]);
}
