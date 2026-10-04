export const PRODUCT_BRAND_ZH = '主打团' as const;
export const PRODUCT_BRAND_EN = '主打团' as const;

const LEGACY_BRAND_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/MORVIA(?:\s*·?\s*(?:zhudatuan\s*)?主打团)?/gi, PRODUCT_BRAND_ZH],
  [/\bzhudatuan\b(?!\.[a-z])/gi, PRODUCT_BRAND_ZH],
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
  return canonicalizeProductBrand(value).replace(/^主打团福利商城\s*[-—–·]\s*/, '');
}
