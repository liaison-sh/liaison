// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Alias-tolerant intake for Shopify's `MailingAddressInput`.
//
// Shopify's input takes ISO codes: `countryCode` (2-letter) and `provinceCode`.
// Everything upstream of it speaks human: a Shopify ORDER read renders
// `country: "United States"` / `province: "California"`, a customer pastes
// "USA", and an agent copying an address across from a read hands the mutation
// exactly those words. The normaliser used to strip anything outside the
// input's own allowlist, so `country: "United States"` was DROPPED and the
// physical-goods guard then refused the draft for having no `countryCode`
// (prod, ticket-10280: an address with address1/city/zip/province/country all
// present came back as "needs a shipping address (address1, city,
// countryCode)"). Mapping the human spelling onto the code is the fix; the
// allowlist strip stays, it just runs after the aliases have been folded in.
//
// Deliberately a table, not `Intl.DisplayNames`: bundled apps run inside the
// sandbox, and a normaliser that silently degrades when an Intl locale is
// unavailable is worse than one that plainly does not know a country.

/** ISO 3166-1 alpha-3 -> alpha-2, for the codes an upstream system may hand us. */
const ALPHA3: Record<string, string> = {
  AUS: "AU", AUT: "AT", BEL: "BE", BGR: "BG", BRA: "BR", CAN: "CA", CHE: "CH",
  CHL: "CL", CHN: "CN", COL: "CO", CYP: "CY", CZE: "CZ", DEU: "DE", DNK: "DK",
  ESP: "ES", EST: "EE", FIN: "FI", FRA: "FR", GBR: "GB", GRC: "GR", HKG: "HK",
  HRV: "HR", HUN: "HU", IDN: "ID", IND: "IN", IRL: "IE", ISL: "IS", ISR: "IL",
  ITA: "IT", JPN: "JP", KOR: "KR", LTU: "LT", LUX: "LU", LVA: "LV", MAR: "MA",
  MEX: "MX", MLT: "MT", MYS: "MY", NLD: "NL", NOR: "NO", NZL: "NZ", PER: "PE",
  PHL: "PH", POL: "PL", PRT: "PT", ROU: "RO", RUS: "RU", SGP: "SG", SVK: "SK",
  SVN: "SI", SWE: "SE", THA: "TH", TUR: "TR", TWN: "TW", UKR: "UA", USA: "US",
  VNM: "VN", ZAF: "ZA", ARE: "AE", ARG: "AR", SRB: "RS", GEO: "GE",
}

/** Lower-cased country NAME (and the common informal spellings) -> alpha-2. */
const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  "u.s.": "US",
  "u.s.a.": "US",
  usa: "US",
  us: "US",
  america: "US",
  "united kingdom": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  uk: "GB",
  france: "FR",
  germany: "DE",
  deutschland: "DE",
  allemagne: "DE",
  spain: "ES",
  espagne: "ES",
  "españa": "ES",
  italy: "IT",
  italie: "IT",
  italia: "IT",
  netherlands: "NL",
  "the netherlands": "NL",
  holland: "NL",
  "pays-bas": "NL",
  belgium: "BE",
  belgique: "BE",
  luxembourg: "LU",
  ireland: "IE",
  irlande: "IE",
  portugal: "PT",
  switzerland: "CH",
  suisse: "CH",
  austria: "AT",
  autriche: "AT",
  denmark: "DK",
  danemark: "DK",
  sweden: "SE",
  "suède": "SE",
  norway: "NO",
  "norvège": "NO",
  finland: "FI",
  finlande: "FI",
  iceland: "IS",
  poland: "PL",
  pologne: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  slovakia: "SK",
  slovenia: "SI",
  hungary: "HU",
  hongrie: "HU",
  romania: "RO",
  roumanie: "RO",
  bulgaria: "BG",
  croatia: "HR",
  greece: "GR",
  "grèce": "GR",
  cyprus: "CY",
  malta: "MT",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  serbia: "RS",
  ukraine: "UA",
  russia: "RU",
  "russian federation": "RU",
  turkey: "TR",
  "türkiye": "TR",
  turquie: "TR",
  israel: "IL",
  "united arab emirates": "AE",
  uae: "AE",
  "south africa": "ZA",
  morocco: "MA",
  maroc: "MA",
  canada: "CA",
  mexico: "MX",
  mexique: "MX",
  brazil: "BR",
  "brésil": "BR",
  bresil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  peru: "PE",
  australia: "AU",
  australie: "AU",
  "new zealand": "NZ",
  "nouvelle-zélande": "NZ",
  japan: "JP",
  japon: "JP",
  china: "CN",
  chine: "CN",
  "hong kong": "HK",
  taiwan: "TW",
  "south korea": "KR",
  "korea, republic of": "KR",
  "republic of korea": "KR",
  "corée du sud": "KR",
  singapore: "SG",
  malaysia: "MY",
  thailand: "TH",
  "thaïlande": "TH",
  indonesia: "ID",
  philippines: "PH",
  vietnam: "VN",
  "viet nam": "VN",
  india: "IN",
  inde: "IN",
  georgia: "GE",
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
}

const CA_PROVINCES: Record<string, string> = {
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", "northwest territories": "NT",
  "nova scotia": "NS", nunavut: "NU", ontario: "ON", "prince edward island": "PE",
  quebec: "QC", "québec": "QC", saskatchewan: "SK", yukon: "YT",
}

const PROVINCE_TABLES: Record<string, Record<string, string>> = {
  US: US_STATES,
  CA: CA_PROVINCES,
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

/**
 * Resolve a country expressed as an alpha-2 code, an alpha-3 code, or a name
 * (English or French) to its alpha-2 code. Returns null when unrecognised —
 * the caller then leaves the field alone rather than inventing a code, so the
 * guard still refuses rather than shipping a parcel to the wrong country.
 */
export function toCountryCode(v: unknown): string | null {
  const raw = text(v)
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper)) return upper
  if (/^[A-Z]{3}$/.test(upper)) return ALPHA3[upper] ?? null
  return COUNTRY_NAMES[raw.toLowerCase().replace(/\s+/g, " ")] ?? null
}

/**
 * Resolve a state/province to its code, for the countries whose codes we know.
 * A 2-or-3 character token is passed through upper-cased (Shopify's
 * `provinceCode` is what it already is); a full name is looked up in that
 * country's table. Unknown country, or unknown name: null.
 */
export function toProvinceCode(v: unknown, countryCode: string | null): string | null {
  const raw = text(v)
  if (!raw) return null
  const table = countryCode ? PROVINCE_TABLES[countryCode.toUpperCase()] : undefined
  const named = table?.[raw.toLowerCase().replace(/\s+/g, " ")]
  if (named) return named
  if (/^[A-Za-z]{2,3}$/.test(raw)) return raw.toUpperCase()
  return null
}
