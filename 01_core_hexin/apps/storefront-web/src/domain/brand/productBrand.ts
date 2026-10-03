export const PRODUCT_BRAND_ZH = 'MORVIA' as const;
export const PRODUCT_BRAND_EN = 'MORVIA' as const;

const LEGACY_BRAND_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/智慧翼/g, PRODUCT_BRAND_ZH],
  [/[築筑]大团/g, '主打团'],
  [/smart\s*[-_]?\s*wing/gi, PRODUCT_BRAND_EN],
];

/**
 * Historical records may still contain a retired display name. Canonicalize
 * only the presentation copy; identifiers, domains and persisted values stay
 * untouched.
 */
export function canonicalizeProductBrand(value: string): string {
  return LEGACY_BRAND_REPLACEMENTS.reduce(
    (canonical, [pattern, replacement]) => canonical.replace(pattern, replacement),
    value,
  );
}

export function mallShortName(value: string): string {
  return canonicalizeProductBrand(value).replace(/^(?:MORVIA|主打团)福利商城\s*[-—–·]\s*/, '');
}
