// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Address reading shared by the business-buyer check (buyer-vat.ts) and the document search and
// customer history reads: normalise, split into house number / street / postcode / city, compare.

/** Lower-cased, accent-free, punctuation-free words: "Via Roma, 12 - 20121 Milano" -> "via roma 12 20121 milano". */
export function normaliseAddress(a: string | null | undefined): string {
  return (a ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

// Country names (English and native) and codes an address may end with; dropped before comparing.
const COUNTRY_WORDS = new Set(
  (
    "austria osterreich belgium belgique belgie bulgaria croatia hrvatska cyprus czechia czech republic " +
    "denmark danmark estonia eesti finland suomi france germany deutschland greece hellas ellada hungary " +
    "magyarorszag ireland eire italy italia latvia latvija lithuania lietuva luxembourg malta netherlands " +
    "nederland holland poland polska portugal romania slovakia slovensko slovenia slovenija spain espana " +
    "sweden sverige switzerland suisse schweiz svizzera norway norge united kingdom uk gb usa " +
    "at be bg hr cy cz dk ee fi fr de gr el hu ie it lv lt lu mt nl pl pt ro sk si es se ch no"
  ).split(" "),
)

/** What an address says, read the way a person reads it. */
export interface AddressParts {
  /** The house number ("8", "12bis"). */
  number: string | null
  /** The street's words, without the number ("via esempio nuova"). */
  street: string[]
  postcode: string | null
  city: string | null
}

/**
 * Parse an address into house number, street, postcode and city, whatever its layout: lines or
 * commas, the number in its own segment ("Via Roma, 8") or not ("8 rue de la Paix"), a person's or
 * company's name in front, a country (or none) at the end. Null when no house number can be read.
 */
export function addressParts(a: string | null | undefined): AddressParts | null {
  const segs = (a ?? "")
    .split(/[\n,;]/)
    .map((s) => normaliseAddress(s).split(" ").filter(Boolean))
    .filter((s) => s.length > 0)
  // A trailing country: a last segment made only of country words, or country words ending it.
  while (segs.length > 1 && segs[segs.length - 1]!.every((t) => COUNTRY_WORDS.has(t))) segs.pop()
  const last = segs[segs.length - 1]
  while (last && last.length > 1 && COUNTRY_WORDS.has(last[last.length - 1]!) && !/\d/.test(last[last.length - 1]!)) last.pop()
  const flat: Array<{ t: string; seg: number; i: number }> = []
  segs.forEach((s, seg) => s.forEach((t, i) => flat.push({ t, seg, i })))
  // The postcode: the last 4-5 digit token. The house number: the first short number before or
  // around it that is not the postcode.
  const pc = [...flat].reverse().find((x) => /^\d{4,5}$/.test(x.t)) ?? null
  const num = flat.find((x) => x !== pc && /^\d{1,4}[a-z]{0,3}$/.test(x.t) && !(pc && x.seg === pc.seg && x.i > pc.i)) ?? null
  if (!num) return null
  const isWord = (t: string) => !/\d/.test(t)
  const seg = segs[num.seg]!
  // The street: the words of the number's segment (before the postcode when it shares it); a
  // number alone in its segment belongs to the segment before it ("Via Roma, 8").
  let street = seg.filter((t, i) => isWord(t) && !(pc && pc.seg === num.seg && i > pc.i))
  if (street.length === 0 && num.seg > 0) street = segs[num.seg - 1]!.filter(isWord)
  let city: string | null = null
  if (pc) {
    const pcSeg = segs[pc.seg]!
    city = pcSeg.slice(pc.i + 1).find(isWord) ?? null
    if (!city && pc.seg !== num.seg) city = [...pcSeg.slice(0, pc.i)].reverse().find(isWord) ?? null
    if (!city) city = segs[pc.seg + 1]?.find(isWord) ?? null
  }
  return { number: num.t, street, postcode: pc?.t ?? null, city }
}

/** Same street: equal word sequences, or one ends the other (a name written in front of it). */
function sameStreet(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.join("").length < 4) return false
  const tail = long.slice(long.length - short.length)
  return tail.join(" ") === short.join(" ")
}

/**
 * How two addresses match: "full" (house number, street and postcode, and the city when both say
 * one), "street" (house number and street, another or no postcode), or null.
 */
export function addressMatch(a: string | null | undefined, b: string | null | undefined): "full" | "street" | null {
  const na = normaliseAddress(a)
  const nb = normaliseAddress(b)
  if (!na || !nb) return null
  const pa = addressParts(a)
  const pb = addressParts(b)
  if (!pa || !pb) return na === nb ? "full" : null
  if (pa.number !== pb.number || !sameStreet(pa.street, pb.street)) return null
  if (!pa.postcode || !pb.postcode || pa.postcode !== pb.postcode) return "street"
  if (pa.city && pb.city && pa.city !== pb.city) return "street"
  return "full"
}

/** Same street and house number (the postcode may differ or be missing). */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return addressMatch(a, b) !== null
}

/** Same house number, street and postcode (and city): the strong match that may fill in a VAT number. */
export function sameFullAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return addressMatch(a, b) === "full"
}
