// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card numbers and payment processor keys, masked before text is stored.
//
// One function for every place text enters the product (mail and ticket
// messages, staff notes, thread messages, the sealed mailbox's agent context),
// so a rule fixed here is fixed everywhere and no second copy drifts.
//
// A CARD NUMBER is 13 to 19 digits, written in one run or in groups split by a
// space or a dash, that passes the Luhn check AND starts with the issuer prefix
// of one of the six common networks (Visa, Mastercard, American Express,
// Discover, JCB, Diners Club). Both conditions: a 16 digit order number that
// fails Luhn stays, and so does a serial that passes Luhn by chance but starts
// like no card. It becomes bullets plus its last four digits. A security code
// (CVC, CVV, cryptogramme, security code) written within 40 characters of a
// masked number becomes bullets too.
//
// A KEY is a restricted or secret key (`rk_` or `sk_`, then `live_` or
// `test_`) or a webhook signing secret (`whsec_`), followed by 10 or more key
// characters. It keeps its prefix and loses the rest.
//
// What is NOT a card, on purpose: an IBAN (its digits are skipped as a whole),
// a run glued to letters (a tracking number, a reference like `ORD123...`),
// and a run longer than 19 digits with no separator (an id, not a card).

const BULLETS = "•••• •••• ••••"
const CODE_BULLETS = "•••"
const KEY_BULLETS = "••••••••"

/** The Luhn check over a string of digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function inRange(digits: string, len: number, lo: number, hi: number): boolean {
  const n = Number(digits.slice(0, len))
  return n >= lo && n <= hi
}

/** Whether `digits` starts with an issuer prefix of a common card network. */
export function hasCardPrefix(digits: string): boolean {
  if (digits.startsWith("4")) return true // Visa
  if (inRange(digits, 2, 51, 55) || inRange(digits, 4, 2221, 2720)) return true // Mastercard
  if (digits.startsWith("34") || digits.startsWith("37")) return true // American Express
  if (
    digits.startsWith("6011") ||
    digits.startsWith("65") ||
    inRange(digits, 3, 644, 649) ||
    inRange(digits, 6, 622126, 622925)
  )
    return true // Discover
  if (inRange(digits, 4, 3528, 3589)) return true // JCB
  if (inRange(digits, 3, 300, 305) || digits.startsWith("36") || inRange(digits, 2, 38, 39))
    return true // Diners Club
  return false
}

/** Whether `digits` (separators removed) is a card number. */
export function isCardNumber(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && hasCardPrefix(digits) && luhnValid(digits)
}

export interface MaskResult {
  text: string
  /** How many values were replaced. */
  masked: number
}

// A digit group, then more groups each after one or two separators.
const TEXT_SEPARATOR = "[ \\u00a0\\t-]{1,2}"
// In HTML a number can also be split by tags or `&nbsp;`.
const HTML_SEPARATOR = "(?:[ \\u00a0\\t-]|&nbsp;|<[^<>]{0,200}>){1,6}"
// An IBAN: two letters, two check digits, then groups of letters and digits.
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g

interface Span {
  start: number
  end: number
}

function ibanSpans(text: string): Span[] {
  const spans: Span[] = []
  for (const m of text.matchAll(IBAN)) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return spans
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start)
}

/**
 * The card numbers in `text`, as spans. A run of digit groups is tried group by
 * group: from each starting group, the longest stretch of whole groups that is
 * a card number wins, so a card written after an order number in the same run
 * of digits is still found.
 */
function cardSpans(text: string, separator: string): Span[] {
  const run = new RegExp(`(?<![A-Za-z0-9])\\d+(?:${separator}\\d+)*(?![A-Za-z0-9])`, "g")
  const ibans = ibanSpans(text)
  const out: Span[] = []
  for (const m of text.matchAll(run)) {
    const base = m.index ?? 0
    const groups: Array<{ start: number; end: number; digits: string }> = []
    for (const g of m[0].matchAll(/\d+/g)) {
      const start = base + (g.index ?? 0)
      groups.push({ start, end: start + g[0].length, digits: g[0] })
    }
    let i = 0
    while (i < groups.length) {
      let found = -1
      let digits = ""
      for (let j = i; j < groups.length; j++) {
        digits += (groups[j] as { digits: string }).digits
        if (digits.length > 19) break
        if (isCardNumber(digits)) found = j
      }
      if (found >= 0) {
        const start = (groups[i] as Span).start
        const end = (groups[found] as Span).end
        if (!overlaps(ibans, start, end)) out.push({ start, end })
        i = found + 1
      } else {
        i++
      }
    }
  }
  return out
}

const CODE_LABEL =
  /\b(?:cvc2?|cvv2?|cvn|cryptogramme(?: visuel)?|security code|code de s[ée]curit[ée])\b[^\d\n]{0,15}?(\d{3,4})(?!\d)/gi

function replaceSpans(text: string, spans: Array<Span & { with: string }>): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let out = ""
  let at = 0
  for (const s of sorted) {
    if (s.start < at) continue
    out += text.slice(at, s.start) + s.with
    at = s.end
  }
  return out + text.slice(at)
}

function maskCards(text: string, separator: string): MaskResult {
  if (!/\d/.test(text)) return { text, masked: 0 }
  const cards = cardSpans(text, separator)
  if (cards.length === 0) return { text, masked: 0 }
  const edits: Array<Span & { with: string }> = cards.map((c) => {
    const digits = text.slice(c.start, c.end).replace(/\D/g, "")
    return { ...c, with: `${BULLETS} ${digits.slice(-4)}` }
  })
  // A security code near a masked number: within 40 characters of it, on
  // either side, measured from the label.
  for (const m of text.matchAll(CODE_LABEL)) {
    const labelStart = m.index ?? 0
    const labelEnd = labelStart + m[0].length
    const near = cards.some((c) => labelStart - c.end <= 40 && c.start - labelEnd <= 40)
    if (!near) continue
    const value = m[1] as string
    const valueStart = labelEnd - value.length
    if (overlaps(cards, valueStart, labelEnd)) continue
    edits.push({ start: valueStart, end: labelEnd, with: CODE_BULLETS })
  }
  return { text: replaceSpans(text, edits), masked: cards.length }
}

/** Card numbers (and a security code near one) in plain text, masked. */
export function maskCardNumbers(text: string): MaskResult {
  return maskCards(text, TEXT_SEPARATOR)
}

const VENDOR_KEY = /(?<![A-Za-z0-9])((?:rk|sk)_(?:live|test)_|whsec_)[A-Za-z0-9]{10,}/g

/** Restricted keys, secret keys and webhook signing secrets, masked. */
export function maskVendorKeys(text: string): MaskResult {
  let masked = 0
  const out = text.replace(VENDOR_KEY, (_all, prefix: string) => {
    masked++
    return `${prefix}${KEY_BULLETS}`
  })
  return { text: masked > 0 ? out : text, masked }
}

/** Whether `text` holds a key that `maskVendorKeys` would mask. */
export function hasVendorKey(text: string): boolean {
  return new RegExp(VENDOR_KEY.source).test(text)
}

export interface PaymentMaskResult {
  text: string
  /** Card numbers masked. */
  cards: number
  /** Keys masked. */
  keys: number
}

/** Both masks, on plain text. */
export function maskPaymentSecrets(text: string): PaymentMaskResult {
  const keys = maskVendorKeys(text)
  const cards = maskCardNumbers(keys.text)
  return { text: cards.text, cards: cards.masked, keys: keys.masked }
}

/** Both masks, on HTML: a number split by tags or `&nbsp;` is still found. */
export function maskPaymentSecretsHtml(html: string): PaymentMaskResult {
  const keys = maskVendorKeys(html)
  const cards = maskCards(keys.text, HTML_SEPARATOR)
  return { text: cards.text, cards: cards.masked, keys: keys.masked }
}

/** The note a masked message carries, or null when nothing was masked. */
export function paymentMaskNote(r: { cards: number; keys: number }): string | null {
  if (r.cards > 0 && r.keys > 0) return "A card number and a key were hidden."
  if (r.cards > 1) return "Card numbers were hidden."
  if (r.cards === 1) return "A card number was hidden."
  if (r.keys > 0) return "A key was hidden."
  return null
}

/**
 * Plain text masked, with its note on a line of its own at the end, so every
 * reader (a person, an agent, an export) sees that something was taken out.
 */
export function maskWithNote(text: string): PaymentMaskResult {
  const r = maskPaymentSecrets(text)
  const note = paymentMaskNote(r)
  return note ? { ...r, text: `${r.text}\n\n[${note}]` } : r
}

/** HTML masked, with its note as a last paragraph. */
export function maskHtmlWithNote(html: string): PaymentMaskResult {
  const r = maskPaymentSecretsHtml(html)
  const note = paymentMaskNote(r)
  return note ? { ...r, text: `${r.text}<p>[${note}]</p>` } : r
}
