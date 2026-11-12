// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Address assembly for the v3 create body.
//
// Boxtal requires STRUCTURED postal addresses (`{ street, city, postalCode,
// countryIsoCode }`) plus a real `{ firstName/lastName, phone, email }` contact
// on BOTH the sender (fromAddress) and recipient (toAddress). Neither the kernel
// contact record nor the invoice carries a structured postal address (the
// contact has only name/email/phone; the invoice carries a free-text address
// string + an ISO country), so the structured fields cannot be auto-derived.
//
// Resolution (grounded in what each surface actually stores):
//   - SENDER  — the org's ship-from address, persisted once in `app_config` under
//     key `sender_address` (the Boxtal settings surface) as a `PostalParty`.
//   - RECIPIENT — supplied on the create draft / approval card as explicit
//     params, with the recipient NAME + COUNTRY pre-filled from the invoice and
//     the PHONE pre-fillable from the contact. The operator confirms/edits the
//     street/city/postal/phone the structured Boxtal body needs.
//
// `assembleAddress` produces a Boxtal `BoxtalAddress` from a `PostalParty`, and
// `validateParty` returns the list of missing-but-required fields so the create
// path can HARD-FAIL with a precise error instead of POSTing empties.

import type { BoxtalAddress } from "./lib/boxtal-v3-client"

/** Structured postal party — the minimum a Boxtal address needs. */
export interface PostalParty {
  name?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  city?: string | null
  postalCode?: string | null
  countryIsoCode?: string | null
  /** State/province code (e.g. "PA", "QC") — REQUIRED by carriers for US/CA
   *  destinations; a shipping-order without it comes back as an opaque Boxtal
   *  400 BAD_REQUEST (observed in prod on a US FedEx label, 2026-07-20). */
  state?: string | null
  /** "BUSINESS" (default) or "RESIDENTIAL". */
  type?: "BUSINESS" | "RESIDENTIAL"
}

/** Countries whose carrier labels require a state/province code. */
const STATE_REQUIRED_COUNTRIES = new Set(["US", "CA"])

// Full-name → code maps so an invoice/contact address carrying "Pennsylvania"
// or "Québec" still yields the 2-letter code the carrier API wants.
const US_STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "puerto rico": "PR",
}
const CA_PROVINCES: Record<string, string> = {
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "nova scotia": "NS",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  québec: "QC",
  saskatchewan: "SK",
  "northwest territories": "NT",
  nunavut: "NU",
  yukon: "YT",
}

/** Normalize a state/province value to its 2-letter code for US/CA: a 2-letter
 *  code passes through uppercased; a full name maps via the tables above; other
 *  countries pass the value through as-is. Null when nothing usable. */
export function normalizeRegion(
  countryIsoCode: string | null | undefined,
  value: string | null | undefined,
): string | null {
  const v = (value ?? "").trim()
  if (v === "") return null
  const country = (countryIsoCode ?? "").trim().toUpperCase()
  if (!STATE_REQUIRED_COUNTRIES.has(country)) return v
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase()
  const table = country === "US" ? US_STATES : CA_PROVINCES
  return table[v.toLowerCase()] ?? null
}

/** True when this party's country requires a state/province code on the label. */
export function stateRequired(countryIsoCode: string | null | undefined): boolean {
  return STATE_REQUIRED_COUNTRIES.has((countryIsoCode ?? "").trim().toUpperCase())
}

/**
 * Destination-aware recipient phone validation. US/CA carrier labels (Boxtal
 * routing to FedEx et al.) 422 at buy time on a non-North-American phone
 * ("A valid North American phone number is required"), an error only the logs
 * saw AFTER approval. Enforce the NANP shape at STAGE time instead: 10 digits
 * (optionally prefixed by 1 / +1), with area code and exchange starting 2-9.
 * Returns a readable error message, or null when the phone is acceptable.
 * A BLANK phone returns null here: missing-ness is the required-fields check's
 * job (validateParty), this rule only judges a phone that is present. Countries
 * outside US/CA carry no rule (any national format ships fine).
 */
export function validateRecipientPhone(
  countryIsoCode: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  const country = (countryIsoCode ?? "").trim().toUpperCase()
  if (!STATE_REQUIRED_COUNTRIES.has(country)) return null
  const raw = (phone ?? "").trim()
  if (raw === "") return null
  // An explicit non-+1 international prefix can never be NANP.
  const plusOther = /^\+(?!1)/.test(raw)
  const digits = raw.replace(/\D/g, "")
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  // Area-code-level NANP shape only (10 digits, area code 2-9): strict enough to
  // catch every observed carrier rejection (a French 06/+33 number, a bare "+1"),
  // loose enough not to reject the odd real number with an unusual exchange.
  const nanp = !plusOther && national.length === 10 && /^[2-9]\d{9}$/.test(national)
  if (nanp) return null
  return (
    `Recipient phone "${raw}" is not a valid North American number, and the destination is ${country}: ` +
    `US/CA carriers reject the label without one. Provide a NANP phone (10 digits, e.g. +1 212 555 0100) reachable for the delivery.`
  )
}

/** Required structured fields (a Boxtal create 422s without these).
 *  `email` is included: Boxtal rejects `fromAddress.contact.email: missing
 *  value` (422 ValidationException.NotBlank) — observed in prod on an approved
 *  return label, where the FROM party is the customer. The create path
 *  auto-fills it (contact record → org sender email) before validating. */
const REQUIRED_FIELDS: ReadonlyArray<keyof PostalParty> = [
  "phone",
  "email",
  "street",
  "city",
  "postalCode",
  "countryIsoCode",
]

function blank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "")
}

/**
 * Countries with no postal code system (the address formats of Google's libaddressinput data,
 * which carry no postal code field for them). A recipient there has no postal code to give, and
 * Boxtal prices the route with it empty (live cotation to AE, 2026-11-09: offers returned with no
 * postal code). Anything a free-text parse took for one there (a PO box, a building number) is not
 * a postal code.
 */
const NO_POSTAL_CODE_COUNTRIES = new Set([
  "AE",
  "AG",
  "AO",
  "AW",
  "BF",
  "BI",
  "BJ",
  "BS",
  "BW",
  "BZ",
  "CD",
  "CF",
  "CG",
  "CI",
  "CK",
  "CM",
  "DJ",
  "DM",
  "ER",
  "FJ",
  "GA",
  "GD",
  "GH",
  "GM",
  "GQ",
  "GY",
  "HK",
  "KI",
  "KM",
  "KN",
  "KP",
  "LY",
  "ML",
  "MO",
  "MR",
  "MW",
  "NR",
  "NU",
  "QA",
  "RW",
  "SB",
  "SC",
  "SL",
  "SR",
  "ST",
  "SY",
  "TG",
  "TK",
  "TL",
  "TO",
  "TV",
  "UG",
  "VU",
  "YE",
  "ZW",
])

/** Whether an address in this country has a postal code (unknown country: yes). */
export function postalCodeRequired(countryIsoCode: string | null | undefined): boolean {
  return !NO_POSTAL_CODE_COUNTRIES.has((countryIsoCode ?? "").trim().toUpperCase())
}

/** Letters Unicode decomposition does not split into a base letter and an accent. */
const LATIN_FOLDS: Array<[RegExp, string]> = [
  [/ß/g, "ss"],
  [/ẞ/g, "SS"],
  [/ł/g, "l"],
  [/Ł/g, "L"],
  [/ø/g, "o"],
  [/Ø/g, "O"],
  [/æ/g, "ae"],
  [/Æ/g, "AE"],
  [/œ/g, "oe"],
  [/Œ/g, "OE"],
  [/đ/g, "d"],
  [/Đ/g, "D"],
  [/ð/g, "d"],
  [/Ð/g, "D"],
  [/þ/g, "th"],
  [/Þ/g, "Th"],
  [/ı/g, "i"],
  [/[‘’‚‛ʼ´`]/g, "'"],
  [/[‐‑‒–—―−]/g, "-"],
  [/[“”„‟«»‹›"]/g, ""],
]

/**
 * A name or address field in the character set Boxtal's carriers accept: accents transliterated
 * ("Zoë" -> "Zoe", "Straße" -> "Strasse"), typographic quotes and dashes made ASCII, and what has
 * no Latin form (another script, emoji, control or zero-width characters) dropped, spaces
 * collapsed. Labels refused for a name or street character are the failure this prevents.
 */
export function boxtalText(value: string | null | undefined): string {
  let v = String(value ?? "")
  for (const [re, to] of LATIN_FOLDS) v = v.replace(re, to)
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Return the names of required-but-empty fields on a party (empty → valid). A text field whose
 *  Boxtal-safe form is empty (a name in another script only) is as missing as a blank one. */
export function validateParty(party: PostalParty): string[] {
  const missing = REQUIRED_FIELDS.filter((f) => {
    if (f === "postalCode" && !postalCodeRequired(party.countryIsoCode)) return false
    if (f === "street" || f === "city" || f === "postalCode") return boxtalText(party[f]) === ""
    return blank(party[f])
  }) as string[]
  // A name OR a company is required so the label carries an addressee.
  if (boxtalText(party.name) === "" && boxtalText(party.company) === "") missing.push("name")
  // US/CA labels require a state/province code — without it Boxtal's
  // shipping-order rejects with an opaque 400, so fail precisely here instead.
  if (stateRequired(party.countryIsoCode) && blank(party.state)) missing.push("state")
  return missing
}

/** Split a free-text name into first/last (Boxtal wants both, non-empty). */
function splitName(
  name: string | null | undefined,
  company: string | null | undefined,
): {
  firstName: string
  lastName: string
} {
  const trimmed = (name ?? "").trim()
  if (trimmed) {
    const parts = trimmed.split(/\s+/)
    if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! }
    return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") }
  }
  // Fall back to the company name when no person name is set.
  const c = (company ?? "").trim() || "Recipient"
  return { firstName: c, lastName: c }
}

/**
 * Map a validated `PostalParty` to a Boxtal `BoxtalAddress`. Callers MUST run
 * `validateParty` first and hard-fail on a non-empty result — this builder does
 * not invent values; it maps what is present.
 */
export function assembleAddress(party: PostalParty): BoxtalAddress {
  // Names and the address go out in Boxtal's character set (boxtalText); email and phone are
  // left as they are (their own formats are validated elsewhere).
  const company = boxtalText(party.company)
  const { firstName, lastName } = splitName(boxtalText(party.name), company)
  return {
    type: party.type ?? "BUSINESS",
    contact: {
      email: (party.email ?? "").trim(),
      phone: (party.phone ?? "").trim(),
      ...(company ? { company } : {}),
      firstName,
      lastName,
    },
    location: {
      city: boxtalText(party.city),
      street: boxtalText(party.street),
      // A country with no postal codes gets none, whatever a parse put there.
      postalCode: postalCodeRequired(party.countryIsoCode) ? boxtalText(party.postalCode) : "",
      countryIsoCode: (party.countryIsoCode ?? "").trim().toUpperCase(),
      ...(party.state && party.state.trim() !== "" ? { state: party.state.trim() } : {}),
    },
  }
}

/** Coerce an unknown `app_config.value` JSON blob into a `PostalParty`. */
export function partyFromConfig(value: unknown): PostalParty | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const str = (k: string): string | null => {
    const x = v[k]
    return typeof x === "string" ? x : null
  }
  return {
    name: str("name"),
    company: str("company"),
    email: str("email"),
    phone: str("phone"),
    street: str("street"),
    city: str("city"),
    postalCode: str("postalCode") ?? str("postal_code"),
    countryIsoCode: str("countryIsoCode") ?? str("country") ?? str("country_iso_code"),
    state: str("state") ?? str("province"),
    type: v.type === "RESIDENTIAL" ? "RESIDENTIAL" : "BUSINESS",
  }
}
