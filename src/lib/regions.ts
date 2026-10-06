export const REGIONS = ["Europe", "Americas", "Asia Pacific", "Middle East & Africa"] as const;
export type Region = (typeof REGIONS)[number];

const BY_REGION: Record<Region, string[]> = {
  Europe: [
    "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS",
    "IE", "IT", "XK", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU",
    "SM", "RS", "SK", "SI", "ES", "SE", "CH", "UA", "GB", "VA",
  ],
  Americas: [
    "AR", "BS", "BB", "BZ", "BO", "BR", "CA", "CL", "CO", "CR", "CU", "DO", "EC", "SV", "GT", "GY", "HT", "HN",
    "JM", "MX", "NI", "PA", "PY", "PE", "PR", "SR", "TT", "US", "UY", "VE",
  ],
  "Asia Pacific": [
    "AU", "BD", "BT", "BN", "KH", "CN", "FJ", "HK", "IN", "ID", "JP", "KZ", "KG", "LA", "MO", "MY", "MV", "MN",
    "MM", "NP", "NZ", "PK", "PH", "SG", "KR", "LK", "TW", "TJ", "TH", "TM", "UZ", "VN",
  ],
  "Middle East & Africa": [
    "DZ", "AO", "BH", "BJ", "BW", "CM", "CD", "EG", "ET", "GH", "IR", "IQ", "IL", "JO", "KE", "KW", "LB", "LY",
    "MA", "MZ", "NA", "NG", "OM", "QA", "SA", "SN", "ZA", "TZ", "TN", "TR", "UG", "AE", "ZM", "ZW",
  ],
};

const REGION_OF = new Map<string, Region>();
for (const region of REGIONS) for (const code of BY_REGION[region]) REGION_OF.set(code, region);

export function regionOf(countryCode: string): Region | null {
  return REGION_OF.get(countryCode.toUpperCase()) ?? null;
}

export function countryName(countryCode: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode.toUpperCase()) ?? countryCode;
  } catch {
    return countryCode;
  }
}
