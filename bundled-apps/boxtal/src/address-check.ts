// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which address a shipment draft ships to, and how it compares with the customer's VERIFIED
// delivery address from the contact's address book.
//
// The location (street, city, postal code, country, state) comes from ONE source. Precedence:
//   operator choice > order-less prep recipient > the order's own ship-to
//   > a verified delivery address (only when the order carries no address)
//   > the address copied onto the contact > the customer's default address > the invoice parse.
// The order's own ship-to wins over an address copied onto the contact: the copy is unverified
// and can be stale or belong to another site of the same customer, while the order says where
// THIS parcel goes. A verified address never silently replaces the order's address; when both
// exist and differ the draft says so (`differs`) and a person decides.
//
// Other sources may fill fields the winner lacks (a phone, an email, a state) only when their
// own location MATCHES the winner's, so a draft never carries a street from one address and a
// postal code or phone from another.
//
// The comparison is deliberately strict: country, postal code, city and street must all be
// present and equal once case, accents, whitespace, punctuation and common abbreviations are
// folded, and house numbers must be identical. The city counts because several communes share
// one postal code and the same street names ("Grande Rue" in two villages of one canton).
// Anything it cannot decide counts as a difference.
import type { RecipientAddressInput } from "./shipment"

export type AddressSourceKind =
  | "operator_choice"
  | "prep_recipient"
  | "order"
  | "verified"
  | "contact"
  | "customer_default"
  | "invoice"

/** A verified delivery address read from the contact's address book. */
export interface VerifiedAddress {
  id: string
  address: RecipientAddressInput
  verified_at: string | null
  verified_by_name: string | null
  verification_source: string | null
}

export type AddressCheckState = "match" | "differs" | "no_verified" | "verified_only"

export interface AddressCheck {
  /** match: the order's address equals a verified one. differs: the order carries an address
   *  and the verified one is different. verified_only: the order carries none, the verified
   *  address is used. no_verified: the customer has no verified delivery address. */
  state: AddressCheckState
  used: {
    source: AddressSourceKind
    address_id?: string
    verified_at?: string | null
    verified_by_name?: string | null
    verification_source?: string | null
  } | null
  order_address: RecipientAddressInput | null
  verified_address: VerifiedAddressView | null
  /** Set when the two differ and a person picked which one the label goes to, and that pick
   *  still holds (neither address changed since). */
  choice?: { pick: AddressPick; chosen_at: string | null }
  /** Set on a draft built for a label whose order read failed: nobody knows where the order
   *  ships, so the label buy refuses (shipment.ts addressPickBlock) instead of guessing. */
  order_read?: "failed"
}

/** The verified address the order is compared with, and who verified it when. */
export type VerifiedAddressView = RecipientAddressInput & {
  id: string
  verified_at?: string | null
  verified_by_name?: string | null
  verification_source?: string | null
}

/** Which address a person picked when the order and the verified address differ. */
export type AddressPick = "order" | "verified"

/** A person's pick as stored on the order's prep state (`prep_order_state.address_choice`). The
 *  hash covers both addresses as they were when the pick was made, so a change to either one
 *  voids the pick and the row is held again. */
export interface AddressChoiceRecord {
  pick: AddressPick
  address_id: string | null
  hash: string
  chosen_at: string
  /** The approver when the pick was staged by an agent and approved by a person. */
  chosen_by: string | null
}

export interface AddressSources {
  /** T5: the address a person picked when the order and the verified address differ. */
  choice?: { address: RecipientAddressInput; address_id?: string } | null
  prep: RecipientAddressInput | null
  order: RecipientAddressInput | null
  /** The draft has a store order whose address could not be read (a worklist build with no
   *  cached ship-to, or a failed read). The order may well carry an address, so a verified one
   *  must not stand in for it, and nothing can be said to match. */
  orderUnknown?: boolean
  verified: VerifiedAddress[]
  contact: RecipientAddressInput | null
  customerDefault: RecipientAddressInput | null
  invoice: RecipientAddressInput | null
}

const FIELDS = ["name", "company", "email", "phone", "street", "city", "postalCode", "countryIsoCode", "state"] as const
type Field = (typeof FIELDS)[number]
const PERSON_FIELDS: ReadonlySet<Field> = new Set(["name", "company", "phone", "email"])

// Street words folded to one spelling. German compounds ("Lilienthalstr.") are handled by the
// suffix rule in foldWord; these are whole-word abbreviations. "St" and "Ste" are not here: they
// read as a saint in most of Europe and as a street or a suite in English (foldSt decides).
const ABBREVIATIONS: Record<string, string> = {
  str: "strasse",
  ave: "avenue",
  av: "avenue",
  bd: "boulevard",
  blvd: "boulevard",
  boul: "boulevard",
  rd: "road",
  dr: "drive",
  ln: "lane",
  ct: "court",
  pl: "place",
  sq: "square",
  hwy: "highway",
  pkwy: "parkway",
  ch: "chemin",
  imp: "impasse",
  rte: "route",
  fbg: "faubourg",
  pza: "piazza",
  c: "calle",
  avda: "avenida",
}

// "St", "Ste", "Saint" and "Sainte" name the same saint ("rue St-Michel" is "rue Saint Michel");
// the genders fold together because typed addresses mix them freely.
const SAINT_FORMS: ReadonlySet<string> = new Set(["saint", "sainte"])
const UNIT_WORDS: ReadonlySet<string> = new Set(["ste", "suite", "apt", "unit"])

/** "St" and "Ste" by position. A saint is followed by its name ("St Michel", "Ste Catherine").
 *  The English "St" (street) ends the street or comes right before a number or a unit ("Main St",
 *  "Main St 5", "Main St Ste 200"), and the unit "Ste" is followed by its number ("Ste 200").
 *  Null for any other word. */
function foldSt(token: string, next: string | undefined): string | null {
  const nextIsNumber = next !== undefined && /^\d/.test(next)
  if (token === "st") return next === undefined || nextIsNumber || UNIT_WORDS.has(next) ? "street" : "saint"
  if (token === "ste") return nextIsNumber ? "suite" : "saint"
  return SAINT_FORMS.has(token) ? "saint" : null
}

function foldWord(word: string, next?: string): string {
  const w = foldSt(word, next) ?? ABBREVIATIONS[word] ?? word
  // "lilienthalstr" -> "lilienthalstrasse"; "hauptstrasse" stays.
  if (w.length > 3 && w.endsWith("str")) return `${w}asse`
  return w
}

function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
}

/** A street as comparable parts: its house numbers in order, and its words joined without
 *  separators ("Zeppelin Str. 6" and "Zeppelinstrasse 6" give the same parts). */
export function streetKey(street: string): { numbers: string[]; words: string } {
  const tokens = foldText(street)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "")
  const numbers: string[] = []
  const words: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (/^\d/.test(t)) {
      // "6a" and "6 a" are the same house number.
      const next = tokens[i + 1]
      if (/^\d+$/.test(t) && next && /^[a-z]$/.test(next)) {
        numbers.push(`${t}${next}`)
        i++
      } else numbers.push(t)
    } else words.push(foldWord(t, tokens[i + 1]))
  }
  return { numbers, words: words.join("") }
}

/** A city as one comparable word: folded like a street, saints folded ("St-Etienne" is "Saint
 *  Etienne"), a French CEDEX suffix dropped (a delivery office, not another town). */
export function cityKey(city: string): string {
  const tokens = foldText(city)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "")
  const cedex = tokens.indexOf("cedex")
  const kept = cedex > 0 ? tokens.slice(0, cedex) : tokens
  return kept.map((t, i) => foldSt(t, kept[i + 1]) === "saint" ? "saint" : t).join("")
}

function postalKey(postal: string): string {
  return foldText(postal).replace(/[^a-z0-9]/g, "")
}

function present(v: string | null | undefined): string | null {
  const t = (v ?? "").trim()
  return t === "" ? null : t
}

/** Do two addresses name the same place? Country, postal code, city and street must all be
 *  present on both and equal after folding; house numbers must be identical. Ambiguity is a
 *  mismatch. */
export function sameLocation(a: RecipientAddressInput | null, b: RecipientAddressInput | null): boolean {
  if (!a || !b) return false
  const ca = present(a.countryIsoCode)
  const cb = present(b.countryIsoCode)
  const pa = present(a.postalCode)
  const pb = present(b.postalCode)
  const sa = present(a.street)
  const sb = present(b.street)
  const ta = present(a.city)
  const tb = present(b.city)
  if (!ca || !cb || !pa || !pb || !sa || !sb || !ta || !tb) return false
  if (ca.toUpperCase() !== cb.toUpperCase()) return false
  if (postalKey(pa) !== postalKey(pb)) return false
  if (cityKey(ta) !== cityKey(tb)) return false
  const ka = streetKey(sa)
  const kb = streetKey(sb)
  if (ka.numbers.length === 0 || ka.numbers.join(" ") !== kb.numbers.join(" ")) return false
  return ka.words === kb.words
}

/** A comparable key for an address's place: country, postal code, city and street (folded the
 *  same way sameLocation folds them, so a re-spelling of the same place keeps the key). */
function locationKey(a: RecipientAddressInput): string {
  const street = streetKey(present(a.street) ?? "")
  return [
    (present(a.countryIsoCode) ?? "").toUpperCase(),
    postalKey(present(a.postalCode) ?? ""),
    cityKey(present(a.city) ?? ""),
    street.numbers.join(" "),
    street.words,
  ].join("|")
}

/** The hash a person's pick is tied to: the order's address and the verified one (with its id). */
export function addressPairHash(order: RecipientAddressInput, verified: RecipientAddressInput & { id: string }): string {
  const raw = `${locationKey(order)}::${verified.id}::${locationKey(verified)}`
  // Small deterministic FNV-1a hash, the same as the quote cache key: no crypto needed.
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Read a stored pick back, or null when absent or malformed. */
export function addressChoiceOf(value: unknown): AddressChoiceRecord | null {
  let v = value
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if ((r.pick !== "order" && r.pick !== "verified") || typeof r.hash !== "string") return null
  return {
    pick: r.pick,
    address_id: typeof r.address_id === "string" ? r.address_id : null,
    hash: r.hash,
    chosen_at: typeof r.chosen_at === "string" ? r.chosen_at : "",
    chosen_by: typeof r.chosen_by === "string" ? r.chosen_by : null,
  }
}

/** The order and the verified address differ and both are known: the case a person must decide. */
export function needsAddressPick(check: AddressCheck | null | undefined): check is AddressCheck & {
  order_address: RecipientAddressInput
  verified_address: VerifiedAddressView
} {
  return Boolean(check && check.state === "differs" && check.order_address && check.verified_address)
}

/** Apply a stored pick to a resolution that came out `differs`. A pick made against other
 *  addresses (either one changed since) is ignored, so the row is held again. Pure. */
export function applyAddressChoice(
  sources: AddressSources,
  resolved: ResolvedRecipient,
  stored: AddressChoiceRecord | null,
): ResolvedRecipient {
  const check = resolved.check
  if (!stored || !needsAddressPick(check)) return resolved
  if (stored.hash !== addressPairHash(check.order_address, check.verified_address)) return resolved
  const { id, verified_at: _at, verified_by_name: _by, verification_source: _src, ...verifiedAddress } =
    check.verified_address
  if (stored.pick === "verified" && stored.address_id != null && stored.address_id !== id) return resolved
  const next = resolveRecipient({
    ...sources,
    choice:
      stored.pick === "order"
        ? { address: check.order_address }
        : { address: verifiedAddress, address_id: id },
  })
  return { ...next, check: { ...next.check, choice: { pick: stored.pick, chosen_at: stored.chosen_at || null } } }
}

/** Same country and postal code: enough for a state (it follows the postal code). */
function samePostalArea(a: RecipientAddressInput, b: RecipientAddressInput): boolean {
  const ca = present(a.countryIsoCode)
  const pa = present(a.postalCode)
  if (!ca || !pa) return false
  return ca.toUpperCase() === (present(b.countryIsoCode) ?? "").toUpperCase() && postalKey(pa) === postalKey(present(b.postalCode) ?? "")
}

function hasLocation(a: RecipientAddressInput | null | undefined): a is RecipientAddressInput {
  return Boolean(a && (present(a.street) || present(a.city) || present(a.postalCode)))
}

/** Does a stored address hold everything a label buy needs (street, city, postal code, phone)? */
export function hasLabelAddress(a: RecipientAddressInput | null): boolean {
  return Boolean(a?.street && a.city && a.postalCode && a.phone)
}

interface Candidate {
  source: AddressSourceKind
  address: RecipientAddressInput
  verified?: VerifiedAddress
}

export interface ResolvedRecipient {
  address: RecipientAddressInput | null
  check: AddressCheck
}

/** Pick the one source the draft ships to, fill its gaps from sources at the same place, and
 *  compare the order's address with the verified ones. Pure. */
export function resolveRecipient(sources: AddressSources): ResolvedRecipient {
  const { prep, order, contact, customerDefault, invoice } = sources
  const verified = sources.verified.filter((v) => hasLocation(v.address))
  const orderHasAddress = hasLocation(order)
  const orderMayHaveAddress = orderHasAddress || sources.orderUnknown === true
  const matchingVerified = orderHasAddress ? verified.find((v) => sameLocation(order, v.address)) : undefined

  const precedence: Candidate[] = []
  if (sources.choice && hasLocation(sources.choice.address)) {
    const picked = sources.choice.address_id
      ? verified.find((v) => v.id === sources.choice?.address_id)
      : undefined
    precedence.push({ source: "operator_choice", address: sources.choice.address, ...(picked ? { verified: picked } : {}) })
  }
  if (hasLocation(prep)) precedence.push({ source: "prep_recipient", address: prep })
  if (orderHasAddress) precedence.push({ source: "order", address: order })
  // A verified address is used outright ONLY when the order says nothing about where to ship.
  if (!orderMayHaveAddress && verified[0]) precedence.push({ source: "verified", address: verified[0].address, verified: verified[0] })
  if (hasLocation(contact)) precedence.push({ source: "contact", address: contact })
  if (hasLocation(customerDefault)) precedence.push({ source: "customer_default", address: customerDefault })
  if (hasLocation(invoice)) precedence.push({ source: "invoice", address: invoice })

  const winner = precedence[0] ?? null
  const check: AddressCheck = {
    state:
      verified.length === 0
        ? "no_verified"
        : !orderMayHaveAddress
          ? "verified_only"
          : matchingVerified
            ? "match"
            : "differs",
    used: winner ? usedOf(winner, winner.source === "order" ? matchingVerified : undefined) : null,
    order_address: orderHasAddress ? order : null,
    verified_address: (() => {
      const v = matchingVerified ?? verified[0]
      return v
        ? {
            ...v.address,
            id: v.id,
            verified_at: v.verified_at,
            verified_by_name: v.verified_by_name,
            verification_source: v.verification_source,
          }
        : null
    })(),
  }
  if (!winner) {
    // No source names a place; the invoice parse may still carry the name and email.
    return { address: invoice ? { ...invoice } : null, check }
  }

  // Fill order among the sources at the winner's place. It keeps the order the draft has always
  // used (the operator's prep recipient, then the contact copy, which carries the phone), so a
  // customer whose sources all agree gets exactly the address it got before.
  const contactComplete = hasLabelAddress(contact)
  const base: Array<Candidate | null> = [
    hasLocation(prep) ? { source: "prep_recipient", address: prep } : null,
    hasLocation(contact) ? { source: "contact", address: contact } : null,
    ...(contactComplete
      ? [inv(invoice), ord(order), def(customerDefault)]
      : [ord(order), def(customerDefault), inv(invoice)]),
    ...verified.map((v): Candidate => ({ source: "verified", address: v.address, verified: v })),
  ]
  const ordered = [winner, ...base.filter((c): c is Candidate => c != null && c.address !== winner.address)]
  // The winner's own position in the historical order decides ties between agreeing sources.
  const winnerIndex = base.findIndex((c) => c?.address === winner.address)
  const fillOrder =
    winner.source === "operator_choice" || winner.source === "verified" || winnerIndex < 0
      ? ordered
      : base.filter((c): c is Candidate => c != null)

  // An order-less row's recipient typed without any place (only a phone, say) names no location
  // to conflict with: the operator's own name, company, phone and email still come first.
  const typedContact = prep && !hasLocation(prep) ? prep : null
  const out: RecipientAddressInput = {}
  for (const field of FIELDS) {
    let value: string | null = typedContact && PERSON_FIELDS.has(field) ? present(typedContact[field]) : null
    for (const c of value == null ? fillOrder : []) {
      const v = present(c.address[field])
      if (v && (c.address === winner.address || allowedFill(field, c, winner))) {
        value = v
        break
      }
    }
    // Last resort for who to address: the invoice's name and email are the document's own, not
    // part of its address text, so they may fill even when the invoice text names another place.
    if (value == null && invoice && (field === "name" || field === "email")) value = present(invoice[field])
    out[field] = value
  }
  return { address: out, check }
}

function allowedFill(field: Field, c: Candidate, winner: Candidate): boolean {
  if (sameLocation(c.address, winner.address)) return true
  if (field === "state") return samePostalArea(c.address, winner.address)
  return false
}

function inv(a: RecipientAddressInput | null): Candidate | null {
  return hasLocation(a) ? { source: "invoice", address: a } : null
}
function ord(a: RecipientAddressInput | null): Candidate | null {
  return hasLocation(a) ? { source: "order", address: a } : null
}
function def(a: RecipientAddressInput | null): Candidate | null {
  return hasLocation(a) ? { source: "customer_default", address: a } : null
}

function usedOf(c: Candidate, alsoVerified?: VerifiedAddress): AddressCheck["used"] {
  const v = c.verified ?? alsoVerified
  return {
    source: c.source,
    ...(v
      ? {
          address_id: v.id,
          verified_at: v.verified_at,
          verified_by_name: v.verified_by_name,
          verification_source: v.verification_source,
        }
      : {}),
  }
}
