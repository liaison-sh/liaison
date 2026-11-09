// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The carrier tracking number, read off the label itself.
//
// Boxtal's tracking endpoint answers 404 until the carrier's first scan. For FedEx Regional Economy
// and FedEx Domestic Express that scan comes hours (sometimes a day) after the label is bought, yet
// the label PDF Boxtal hands us already prints the AWB ("TRK# 8777 4092 5574"). Until the scan the
// shipment row had no tracking number, so the Shopify order could not be fulfilled with one and the
// operator read the empty cell as "no tracking was issued".
//
// The label is the carrier's own document, so the number printed on it is authoritative. This
// module reads it out: decode the PDF content streams (ASCII85 and Flate, the filters Boxtal's FedEx
// labels use), collect the text the page draws, and return the one number printed next to "TRK#".
// It returns null rather than guess: no TRK# marker, no candidate, or two different candidates.
//
// Other carriers (UPS, DHL Express) are read the same way when their label carries text, and
// through the host's document analysis when it is an image (a UPS label is one picture). A number
// from either is kept only when it has the carrier's format and check digit AND the label's
// postcode is the recipient's: a misread digit or another parcel's label is refused, never stored.
//
// Runs inside the app sandbox, so it carries its own small inflate (no zlib, no npm dependency).

import type { BoxtalToolCtx } from "./ctx"
import { getClientOrError } from "./lib/get-client"

// ── DEFLATE (RFC 1951) ─────────────────────────────────────────────────────────
//
// PLAIN ARRAYS ONLY, no typed arrays, no TextDecoder: the app sandbox deletes ArrayBuffer and every
// typed array constructor before app code runs (they allocate outside QuickJS's memory accounting,
// see the kernel sandbox pool). The first version used Uint8Array, threw a ReferenceError on the
// first stream in production, and the per-stream catch turned that into "no number on the label".

/** Bytes as a plain array of 0..255. */
export type Bytes = number[]

interface Huffman {
  counts: number[]
  symbols: number[]
}

function zeros(n: number, fill = 0): number[] {
  const a = new Array<number>(n)
  for (let i = 0; i < n; i++) a[i] = fill
  return a
}

function buildHuffman(lengths: ArrayLike<number>, offset: number, n: number): Huffman {
  const counts = zeros(16)
  const symbols = zeros(n)
  for (let i = 0; i < n; i++) counts[lengths[offset + i]!]!++
  counts[0] = 0
  const offs = zeros(16)
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!
  for (let i = 0; i < n; i++) {
    const len = lengths[offset + i]!
    if (len) symbols[offs[len]!++] = i
  }
  return { counts, symbols }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** Inflate a raw DEFLATE stream. Throws on malformed input. */
export function inflateRaw(src: ArrayLike<number>): Bytes {
  let pos = 0
  let bitBuf = 0
  let bitCnt = 0
  const out: Bytes = []

  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error("inflate: unexpected end of data")
      bitBuf |= src[pos++]! << bitCnt
      bitCnt += 8
    }
    const v = bitBuf & ((1 << n) - 1)
    bitBuf >>>= n
    bitCnt -= n
    return v
  }
  const decode = (h: Huffman): number => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len++) {
      code |= bits(1)
      const count = h.counts[len]!
      if (code - first < count) return h.symbols[index + code - first]!
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error("inflate: bad huffman code")
  }

  const fixedLit = (() => {
    const l = zeros(288)
    for (let i = 0; i < 144; i++) l[i] = 8
    for (let i = 144; i < 256; i++) l[i] = 9
    for (let i = 256; i < 280; i++) l[i] = 7
    for (let i = 280; i < 288; i++) l[i] = 8
    return buildHuffman(l, 0, 288)
  })()
  const fixedDist = buildHuffman(zeros(30, 5), 0, 30)

  let last = 0
  while (!last) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      bitBuf = 0
      bitCnt = 0
      if (pos + 4 > src.length) throw new Error("inflate: truncated stored block")
      const len = src[pos]! | (src[pos + 1]! << 8)
      pos += 4
      if (pos + len > src.length) throw new Error("inflate: truncated stored block")
      for (let k = 0; k < len; k++) out.push(src[pos + k]!)
      pos += len
      continue
    }
    let lit: Huffman
    let dist: Huffman
    if (type === 1) {
      lit = fixedLit
      dist = fixedDist
    } else if (type === 2) {
      const hlit = bits(5) + 257
      const hdist = bits(5) + 1
      const hclen = bits(4) + 4
      const cl = zeros(19)
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3)
      const clh = buildHuffman(cl, 0, 19)
      const lengths = zeros(hlit + hdist)
      let i = 0
      while (i < hlit + hdist) {
        const sym = decode(clh)
        if (sym < 16) {
          lengths[i++] = sym
        } else {
          let rep = 0
          let val = 0
          if (sym === 16) {
            if (i === 0) throw new Error("inflate: repeat with no previous length")
            val = lengths[i - 1]!
            rep = 3 + bits(2)
          } else if (sym === 17) {
            rep = 3 + bits(3)
          } else {
            rep = 11 + bits(7)
          }
          if (i + rep > hlit + hdist) throw new Error("inflate: too many lengths")
          while (rep--) lengths[i++] = val
        }
      }
      lit = buildHuffman(lengths, 0, hlit)
      dist = buildHuffman(lengths, hlit, hdist)
    } else {
      throw new Error("inflate: invalid block type")
    }
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) {
        out.push(sym)
      } else if (sym === 256) {
        break
      } else {
        const li = sym - 257
        if (li >= 29) throw new Error("inflate: bad length symbol")
        const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!)
        const di = decode(dist)
        if (di >= 30) throw new Error("inflate: bad distance symbol")
        const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!)
        if (d > out.length) throw new Error("inflate: distance too far back")
        for (let k = 0; k < len; k++) out.push(out[out.length - d]!)
      }
    }
  }
  return out
}

/** Inflate a zlib-wrapped stream (the PDF FlateDecode format): 2 header bytes, DEFLATE, checksum. */
export function inflateZlib(src: ArrayLike<number>): Bytes {
  if (src.length < 2) throw new Error("inflate: zlib header missing")
  const cmf = src[0]!
  const flg = src[1]!
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new Error("inflate: not a zlib stream")
  const rest: Bytes = []
  for (let i = 2; i < src.length; i++) rest.push(src[i]!)
  return inflateRaw(rest)
}

// ── ASCII85 ────────────────────────────────────────────────────────────────────

export function ascii85Decode(text: string): Bytes {
  let s = text.replace(/\s+/g, "")
  if (s.startsWith("<~")) s = s.slice(2)
  const end = s.indexOf("~>")
  if (end >= 0) s = s.slice(0, end)
  const out: Bytes = []
  let group: number[] = []
  const flush = (g: number[], n: number) => {
    let v = 0
    for (const c of g) v = v * 85 + c
    const bytes = [Math.floor(v / 16777216) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
    for (let i = 0; i < n; i++) out.push(bytes[i]!)
  }
  for (const ch of s) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    const c = ch.charCodeAt(0) - 33
    if (c < 0 || c > 84) throw new Error("ascii85: invalid character")
    group.push(c)
    if (group.length === 5) {
      flush(group, 4)
      group = []
    }
  }
  if (group.length > 0) {
    const n = group.length - 1
    while (group.length < 5) group.push(84)
    flush(group, n)
  }
  return out
}

// ── PDF text ───────────────────────────────────────────────────────────────────

function latin1Bytes(s: string): Bytes {
  const b: Bytes = []
  for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xff)
  return b
}

function bytesLatin1(b: ArrayLike<number>): string {
  let s = ""
  for (let i = 0; i < b.length; i += 4096) {
    const chunk: number[] = []
    for (let k = i; k < Math.min(b.length, i + 4096); k++) chunk.push(b[k]!)
    s += String.fromCharCode.apply(null, chunk)
  }
  return s
}

/** Decode one PDF literal string body (between the outer parentheses). */
function unescapeLiteral(body: string): string {
  return body.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, e: string) => {
    switch (e) {
      case "n":
        return "\n"
      case "r":
        return "\r"
      case "t":
        return "\t"
      case "b":
        return "\b"
      case "f":
        return "\f"
      case "(":
      case ")":
      case "\\":
        return e
      default:
        if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
        return ""
    }
  })
}

/** The literal strings a content stream draws with Tj / TJ / ' / ", in stream order. */
export function contentStreamStrings(content: string): string[] {
  const out: string[] = []
  const re = /\(((?:\\.|\\\r?\n|[^\\)])*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) out.push(unescapeLiteral(m[1]!))
  return out
}

/**
 * Every text string drawn by the PDF's content streams. Streams it cannot decode (an unknown
 * filter, a binary stream mangled in transit, an image) are skipped, never fatal.
 */
export function pdfTextStrings(pdf: string): string[] {
  const out: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pdf)) !== null) {
    // "endstream" contains "stream": skip the terminator, or the scan walks the file shifted.
    if (pdf.slice(Math.max(0, m.index - 3), m.index) === "end") continue
    const start = m.index + m[0].length
    const end = pdf.indexOf("endstream", start)
    if (end < 0) break
    re.lastIndex = end + "endstream".length
    // This stream's own dictionary: from its object header to the keyword, never a neighbour's.
    const objAt = pdf.lastIndexOf(" obj", m.index)
    const dict = pdf.slice(objAt < 0 ? 0 : objAt, m.index)
    if (/\/Subtype\s*\/Image/.test(dict)) continue
    const raw = pdf.slice(start, end)
    const filters = [...(dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] ?? "").matchAll(/\/(\w+)/g)].map((f) => f[1])
    try {
      let bytes: Bytes = latin1Bytes(raw)
      for (const f of filters) {
        if (f === "ASCII85Decode" || f === "A85") bytes = ascii85Decode(bytesLatin1(bytes))
        else if (f === "FlateDecode" || f === "Fl") bytes = inflateZlib(bytes)
        else throw new Error(`unsupported filter ${f}`)
      }
      out.push(...contentStreamStrings(bytesLatin1(bytes)))
    } catch {
      // Not decodable here: not the stream that carries the label text.
    }
  }
  return out
}

/**
 * A FedEx AWB as the label prints it: 12 digits (or 15) in groups of four, optionally after the
 * "TRK#" marker and before the 4-digit form code ("TRK# 3845 3157 8060 0430" when one run carries
 * all of it; the form code is not part of the number).
 */
const AWB_GROUPED = /^\s*(?:TRK#\s*)?(\d{4}\s\d{4}\s\d{4}(?:\s\d{3})?)(?:\s+\d{4})?\s*$/i
/** The same number printed without its groups. A bare digit run is weaker evidence: an
 *  international label also prints the recipient's phone as one (a UK mobile is 12 digits). */
const AWB_BARE = /^\s*(?:TRK#\s*)?(\d{12}|\d{15})\s*$/i

/**
 * The tracking number printed on a carrier label, or null.
 *
 * Only a label that carries the "TRK#" marker is read (the FedEx label layout), and only an
 * unambiguous number is returned. The grouped spelling is how FedEx prints the AWB, so when the
 * page draws one, bare digit runs (phone numbers, account numbers) are not candidates; if it draws
 * two different numbers of the same kind, which one is the parcel's cannot be told from the text
 * alone, so nothing is returned.
 */
export function trackingNumberFromLabelText(strings: string[]): string | null {
  if (!strings.some((s) => s.replace(/\s+/g, "").toUpperCase().startsWith("TRK#"))) return null
  const grouped = new Set<string>()
  const bare = new Set<string>()
  for (const s of strings) {
    const g = AWB_GROUPED.exec(s)
    if (g) {
      grouped.add(g[1]!.replace(/\s+/g, ""))
      continue
    }
    const b = AWB_BARE.exec(s)
    if (b) bare.add(b[1]!)
  }
  const found = grouped.size > 0 ? grouped : bare
  if (found.size !== 1) return null
  return [...found][0]!
}

export function trackingNumberFromLabelPdf(pdf: string): string | null {
  return trackingNumberFromLabelText(pdfTextStrings(pdf))
}

// ── carriers: format and check digit ───────────────────────────────────────────

/** The carriers whose label we can read a tracking number from. */
export type LabelCarrier = "fedex" | "ups" | "dhl_express"

/** Which carrier a Boxtal offer code belongs to (its operator prefix), or null when we have no
 *  reader for it. */
export function labelCarrierOf(offerCode: string | null | undefined): LabelCarrier | null {
  const code = (offerCode ?? "").toUpperCase()
  if (code.startsWith("FEDX")) return "fedex"
  if (code.startsWith("UPS")) return "ups"
  if (code.startsWith("DHLE")) return "dhl_express"
  return null
}

/** UPS "1Z": 1Z + 6 shipper characters + 2 service digits + 7 package digits + 1 check digit.
 *  The check digit is the mod-10 of the 15 characters after "1Z" (letters mapped to (code-63)%10,
 *  odd positions doubled). */
export function isValidUpsTracking(raw: string): boolean {
  const n = raw.replace(/\s+/g, "").toUpperCase()
  if (!/^1Z[0-9A-Z]{16}$/.test(n)) return false
  const body = n.slice(2, 17)
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    const v = c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : (c.charCodeAt(0) - 63) % 10
    sum += i % 2 === 1 ? v * 2 : v
  }
  return (10 - (sum % 10)) % 10 === n.charCodeAt(17) - 48
}

/** DHL Express waybill: 10 digits, the last is the first nine mod 7. */
export function isValidDhlExpressWaybill(raw: string): boolean {
  const n = raw.replace(/\s+/g, "")
  if (!/^\d{10}$/.test(n)) return false
  return Number(n.slice(0, 9)) % 7 === Number(n[9])
}

/** The carrier's own format + check digit, for a number read off a label. */
export function isValidCarrierTracking(carrier: LabelCarrier, raw: string): boolean {
  if (carrier === "ups") return isValidUpsTracking(raw)
  if (carrier === "dhl_express") return isValidDhlExpressWaybill(raw)
  return /^(\d{12}|\d{15})$/.test(raw.replace(/\s+/g, ""))
}

/** A postcode reduced to what two spellings of it share: uppercase, no spaces or dashes, and for
 *  the US the five-digit ZIP (a ZIP+4 is the same address). */
export function comparablePostcode(postcode: string | null | undefined, countryIso2?: string | null): string | null {
  const v = String(postcode ?? "").toUpperCase().replace(/[\s-]+/g, "")
  if (!v) return null
  if ((countryIso2 ?? "").toUpperCase() === "US") {
    const m = /^(\d{5})(\d{4})?$/.exec(v)
    if (m) return m[1]!
    if (/^\d{4}$/.test(v)) return `0${v}`
  }
  return v
}

/** Whether a postcode read from a label is the recipient's. */
export function postcodesMatch(
  read: string | null | undefined,
  expected: string | null | undefined,
  countryIso2?: string | null,
): boolean {
  const a = comparablePostcode(read, countryIso2)
  const b = comparablePostcode(expected, countryIso2)
  return a != null && b != null && a === b
}

// ── non-FedEx text labels ──────────────────────────────────────────────────────

/**
 * The tracking number a text label prints for a UPS or DHL Express parcel, or null. Every run is
 * read with its spaces removed (labels group the number: "1Z W49 41Y 04 9253 0257"); only numbers
 * that pass the carrier's check digit count, and two different valid numbers return null.
 */
export function carrierTrackingFromLabelText(carrier: LabelCarrier, strings: string[]): string | null {
  if (carrier === "fedex") return trackingNumberFromLabelText(strings)
  const found = new Set<string>()
  for (const s of strings) {
    const compact = s.replace(/\s+/g, "").toUpperCase()
    const re = carrier === "ups" ? /1Z[0-9A-Z]{16}/g : /(?<!\d)\d{10}(?!\d)/g
    for (const m of compact.matchAll(re)) {
      if (isValidCarrierTracking(carrier, m[0])) found.add(m[0])
    }
  }
  if (carrier === "dhl_express" && !strings.some((s) => /WAYBILL/i.test(s))) return null
  if (found.size !== 1) return null
  return [...found][0]!
}

/** Whether the label's text shows the recipient's postcode (outside the tracking number itself). */
export function labelTextShowsPostcode(
  strings: string[],
  postcode: string | null | undefined,
  countryIso2: string | null | undefined,
  trackingNumber: string,
): boolean {
  const pc = comparablePostcode(postcode, countryIso2)
  if (!pc || pc.length < 3) return false
  return strings.some((s) => {
    const compact = s.toUpperCase().replace(/[\s-]+/g, "")
    if (compact.includes(trackingNumber)) return false
    return compact.includes(pc)
  })
}

// ── image labels: the host's document analysis ─────────────────────────────────

/** The question asked of a label the app cannot read as text. The answer is outside content:
 *  only a number that passes validation is kept, nothing else of it is stored. */
export const LABEL_ANALYSIS_PROMPT =
  "This is a parcel shipping label. Answer with ONE JSON object and nothing else: " +
  '{"tracking_number": "<the carrier tracking number printed on the label, without spaces>", ' +
  '"recipient_postcode": "<the postal code of the SHIP TO / recipient address>"}. ' +
  "Use null for a value you cannot read with certainty. Never guess a character."

/** Pull `{ tracking_number, recipient_postcode }` out of the model's answer, or null. */
export function parseLabelAnalysis(text: string): { tracking_number: string | null; recipient_postcode: string | null } | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
    return { tracking_number: str(obj.tracking_number), recipient_postcode: str(obj.recipient_postcode) }
  } catch {
    return null
  }
}

// ── sourcing onto the shipment row ─────────────────────────────────────────────

interface LabelSourceRow {
  id: string | number
  boxtal_order_id?: string | null
  tracking_number?: string | null
  /** The Boxtal offer code (FEDX-..., UPSE-...). */
  offer_code?: string | null
  /** Set once a label read gave no number we could accept: the row says "tracking to confirm". */
  tracking_to_confirm?: boolean | null
  /** Buy-time snapshot; carries the label's TO postcode and country (queue-facts.ts). */
  queue_facts?: unknown
  /** The recipient's kernel contact: its stored address stands in for a row bought before the
   *  label postcode was frozen on it (or adopted from Boxtal). */
  contact_ref?: string | null
  /** "return": the label is printed for our own address, not the contact's. */
  kind?: string | null
  /** Label reads that failed for a passing reason (timeout, storage); bounded by MAX_LABEL_READS. */
  tracking_label_attempts?: number | null
}

/**
 * Whether this carrier's label is one we know how to read. FedEx prints the "TRK#" layout; UPS and
 * DHL Express numbers carry a check digit, so a read can be validated. Any other carrier's label
 * is a download for nothing. An unknown offer is given the benefit of the doubt (FedEx reader).
 */
export function labelCarriesReadableTracking(offerCode: string | null | undefined): boolean {
  if (!offerCode) return true
  return labelCarrierOf(offerCode) != null
}

/** The label's TO postcode and country, as frozen on the row at buy time. */
function labelDestination(row: LabelSourceRow): { postcode: string | null; country: string | null } {
  const raw = row.queue_facts
  let facts: Record<string, unknown> | null = null
  if (raw && typeof raw === "object") facts = raw as Record<string, unknown>
  else if (typeof raw === "string") {
    try {
      facts = JSON.parse(raw) as Record<string, unknown>
    } catch {
      facts = null
    }
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null)
  return { postcode: str(facts?.to_postcode), country: str(facts?.to_country) ?? str(facts?.destination) }
}

/** Errors of the analysis seam that are final: not available here (capability, the org's toggle,
 *  credit, demo), or a file it will never read. Anything else (a timeout, a model or storage
 *  error) passes, and the next pass asks again. */
const ANALYSIS_UNAVAILABLE = new Set([
  "CAPABILITY_NOT_DECLARED",
  "analysis_disabled",
  "precheck_failed",
  "demo_reserved",
  "unsupported_surface",
  "unsupported",
  "not_found",
  "invalid_params",
  "too_large",
  "empty_file",
])

/** Label reads that failed for a passing reason before the row says "tracking to confirm". */
export const MAX_LABEL_READS = 3

/** The recipient's postcode from its kernel contact's stored shipping address, for a row that
 *  never froze the label's own. Null for a return (its label is printed for us) or on any miss. */
async function contactPostcode(
  ctx: BoxtalToolCtx,
  row: LabelSourceRow,
): Promise<{ postcode: string | null; country: string | null }> {
  const none = { postcode: null, country: null }
  if (row.kind === "return" || !row.contact_ref) return none
  try {
    const env = (await ctx.executeTool("kernel:contacts_read", { contactId: row.contact_ref })) as {
      status?: string
      result?: unknown
    }
    if (env.status !== "completed") return none
    const contact = (env.result as { contact?: { metadata?: unknown } } | null)?.contact
    let meta: unknown = contact?.metadata
    if (typeof meta === "string") meta = JSON.parse(meta)
    const addr = (meta as { shipping_address?: Record<string, unknown> } | null)?.shipping_address
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
    return {
      postcode: str(addr?.postalCode) ?? str(addr?.postal_code),
      country: str(addr?.countryIsoCode) ?? str(addr?.country_iso_code) ?? str(addr?.country),
    }
  } catch {
    return none
  }
}

/** The label's kernel file id: the one already stored on the shipment, else imported now. */
async function labelFileIdFor(
  ctx: BoxtalToolCtx,
  row: LabelSourceRow,
  url: string,
  known: string | null | undefined,
): Promise<string | null> {
  if (known) return known
  try {
    if (ctx.files_listAttachments) {
      const files = JSON.parse(
        await ctx.files_listAttachments(
          JSON.stringify({ app: "boxtal", entityType: "shipment", entityId: String(row.id) }),
        ),
      ) as Array<{ id?: string; mimeType?: string; filename?: string }>
      const label = files.find((f) => f.mimeType === "application/pdf" && /^label-/.test(f.filename ?? ""))
      if (label?.id) return label.id
    }
    if (!ctx.files_importFromUrl) return null
    const res = JSON.parse(
      await ctx.files_importFromUrl(
        JSON.stringify({
          targetApp: "boxtal",
          targetEntityType: "shipment",
          targetEntityId: String(row.id),
          url,
          filename: `label-${row.boxtal_order_id}.pdf`,
          mimeType: "application/pdf",
          pdfStripRotation: true,
        }),
      ),
    ) as { id?: string }
    return typeof res.id === "string" && res.id ? res.id : null
  } catch {
    return null
  }
}

type VisionOutcome = { number: string } | { unavailable: true } | { rejected: string } | { transient: string }

/** Ask the host to read the label image; keep the number only if it validates. */
async function readLabelByAnalysis(
  ctx: BoxtalToolCtx,
  carrier: LabelCarrier,
  fileId: string,
  dest: { postcode: string | null; country: string | null },
): Promise<VisionOutcome> {
  if (!ctx.files_analyzeDocument) return { unavailable: true }
  let answer: { text?: string; error?: { code?: string } }
  try {
    answer = JSON.parse(
      await ctx.files_analyzeDocument(JSON.stringify({ fileId, prompt: LABEL_ANALYSIS_PROMPT })),
    ) as { text?: string; error?: { code?: string } }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    return code && ANALYSIS_UNAVAILABLE.has(code) ? { unavailable: true } : { transient: "analysis_failed" }
  }
  if (answer.error) {
    return answer.error.code && ANALYSIS_UNAVAILABLE.has(answer.error.code)
      ? { unavailable: true }
      : { transient: answer.error.code ?? "analysis_failed" }
  }
  const read = parseLabelAnalysis(answer.text ?? "")
  const number = read?.tracking_number?.replace(/\s+/g, "").toUpperCase() ?? null
  if (!number || !isValidCarrierTracking(carrier, number)) return { rejected: "invalid_number" }
  if (!postcodesMatch(read?.recipient_postcode, dest.postcode, dest.country)) return { rejected: "postcode_mismatch" }
  return { number }
}

/**
 * Fill a shipment row's missing tracking number from its label. No-op when the row already has
 * one (the carrier's own number always wins), when Boxtal is not connected, or when the label is
 * not there yet. Returns the number now stored, or null. Never throws: a label that cannot be read
 * leaves the number empty and the next document, tracking or reconcile pass retries.
 *
 * FedEx: the "TRK#" text. UPS / DHL Express: the label text, then the host's document analysis
 * (`files.analyzeDocument`), each accepted only with a valid check digit and the recipient's
 * postcode on the label. The row is marked `tracking_to_confirm` (the operator sees it, and the
 * paid analysis is not asked again) when the model answered and the answer failed validation, when
 * the analysis is not available here, when no recipient postcode is known (nothing to check a read
 * against, so the analysis is never asked), or after MAX_LABEL_READS passing failures.
 */
export async function sourceTrackingFromLabel(
  ctx: BoxtalToolCtx,
  row: LabelSourceRow,
  /** The label's signed URL when the caller already holds fresh document descriptors, and its
   *  kernel file id when the caller just imported it. */
  opts: { labelUrl?: string | null; labelFileId?: string | null } = {},
): Promise<string | null> {
  if (row.tracking_number) return row.tracking_number
  const orderId = row.boxtal_order_id
  if (!orderId) return null
  if (!labelCarriesReadableTracking(row.offer_code)) return null
  // Already read once without a number we could accept: the label has not changed, the operator
  // confirms (or the carrier's first scan brings the number).
  if (row.tracking_to_confirm) return null
  const carrier = labelCarrierOf(row.offer_code) ?? "fedex"
  try {
    let url = opts.labelUrl ?? null
    if (!url) {
      const client = await getClientOrError(ctx)
      if ("error" in client) return null
      const docs = await client.v3.getDocuments(orderId)
      url = docs.find((d) => d.type === "LABEL" && typeof d.url === "string" && d.url)?.url ?? null
    }
    if (!url) return null
    const res = await ctx.fetch(url, { method: "GET" })
    if (res.status < 200 || res.status >= 300) return null
    const strings = pdfTextStrings(res.body)
    const dest = labelDestination(row)
    let number: string | null = null
    if (carrier === "fedex") {
      number = trackingNumberFromLabelText(strings)
    } else {
      const fromText = carrierTrackingFromLabelText(carrier, strings)
      if (fromText && labelTextShowsPostcode(strings, dest.postcode, dest.country, fromText)) number = fromText
      // An image label (no readable number in its text): the host reads it, once.
      if (!number) {
        // A row bought before the label postcode was frozen on it: the recipient contact's. With
        // no postcode at all, no read could ever pass the check: never pay for one.
        const checked = dest.postcode ? dest : await contactPostcode(ctx, row)
        if (!checked.postcode) {
          ctx.logger?.info?.("boxtal: no recipient postcode to check a label read against, to confirm", {
            shipmentId: String(row.id),
            orderId,
          })
          await markToConfirm(ctx, row)
          return null
        }
        const checkDest = { postcode: checked.postcode, country: checked.country ?? dest.country }
        const fileId = await labelFileIdFor(ctx, row, url, opts.labelFileId)
        const outcome: VisionOutcome = fileId
          ? await readLabelByAnalysis(ctx, carrier, fileId, checkDest)
          : { transient: "label_file_unavailable" }
        if ("number" in outcome) number = outcome.number
        else if ("transient" in outcome) {
          await recordTransientRead(ctx, row, orderId, outcome.transient)
          return null
        } else {
          ctx.logger?.info?.("boxtal: no tracking number accepted from the label, to confirm", {
            shipmentId: String(row.id),
            orderId,
            reason: "unavailable" in outcome ? "analysis_unavailable" : outcome.rejected,
          })
          await markToConfirm(ctx, row)
          return null
        }
      }
    }
    if (!number) {
      ctx.logger?.info?.("boxtal: the label was read but carries no tracking number", {
        shipmentId: String(row.id),
        orderId,
        bytes: typeof res.body === "string" ? res.body.length : null,
      })
      return null
    }
    // Re-read so a webhook that landed while we were downloading is never overwritten.
    const fresh = (await ctx.db.findMany("shipment", { where: { id: String(row.id) }, limit: 1 })) as LabelSourceRow[]
    if (fresh[0]?.tracking_number) return fresh[0].tracking_number
    // Flagged: a number read off the label is shown and used by the operator's tick, but it is not
    // a carrier event, so it never triggers the automatic fulfillment (webhooks.ts).
    await ctx.db.update("shipment", String(row.id), {
      tracking_number: number,
      tracking_from_label: true,
      tracking_to_confirm: false,
    })
    ctx.logger?.info?.("boxtal: tracking number read from the label", { shipmentId: String(row.id), orderId })
    return number
  } catch (err) {
    ctx.logger?.warn?.("boxtal: could not read the tracking number from the label", {
      shipmentId: String(row.id),
      orderId,
      err: String(err),
    })
    return null
  }
}

/** A label read that failed for a passing reason: counted, and the row is left for the next pass
 *  until MAX_LABEL_READS, then it says "tracking to confirm". */
async function recordTransientRead(
  ctx: BoxtalToolCtx,
  row: LabelSourceRow,
  orderId: string,
  reason: string,
): Promise<void> {
  const fresh = (await ctx.db.findMany("shipment", { where: { id: String(row.id) }, limit: 1 })) as LabelSourceRow[]
  if (fresh[0]?.tracking_number) return
  const attempts = (fresh[0]?.tracking_label_attempts ?? row.tracking_label_attempts ?? 0) + 1
  const final = attempts >= MAX_LABEL_READS
  ctx.logger?.info?.("boxtal: the label read failed, retried on the next pass", {
    shipmentId: String(row.id),
    orderId,
    reason,
    attempts,
  })
  await ctx.db.update("shipment", String(row.id), {
    tracking_label_attempts: attempts,
    ...(final ? { tracking_to_confirm: true } : {}),
  })
}

/** Mark the row "tracking to confirm", unless a number landed meanwhile. */
async function markToConfirm(ctx: BoxtalToolCtx, row: LabelSourceRow): Promise<void> {
  const fresh = (await ctx.db.findMany("shipment", { where: { id: String(row.id) }, limit: 1 })) as LabelSourceRow[]
  if (fresh[0]?.tracking_number) return
  await ctx.db.update("shipment", String(row.id), { tracking_to_confirm: true })
}
