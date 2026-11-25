// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signature pages appended to a signed agreement: each signer, the stated
// capacity, the words typed when the sender asked for them, the date and time,
// the level, and the frozen file's fingerprint. They are numbered on their own
// ("Page de signature 1 sur 2"), so the frozen pages' "Page X sur Y" stays true,
// and they are in the document's language.
//
// Text only: every value is drawn as plain text after control characters are
// removed, never parsed as markup, an annotation, a link or a form field. A
// value is the signer's own typing, so nothing in it can act on the page.

import fontkit from "@pdf-lib/fontkit"
import { PDFDocument, type PDFFont, rgb } from "pdf-lib"
import { serverT } from "~/modules/i18n/server-i18n"
import {
  embedUnicodeFace,
  faceBytes,
  needsCjkFace,
  splitByFace,
  type UnicodeFace,
} from "~/modules/pdf/unicode-fonts"

export type SignatureLang = "en" | "fr"

export interface SignaturePageSigner {
  name: string
  capacity: string
  /** The words the sender asked the signer to type, as typed; null when none were asked. */
  typedPhrase: string | null
  /** When the signature was recorded. */
  signedAt: Date
  /** `ses` (simple electronic signature) or `demo`. */
  level: string
}

export interface SignaturePagesInput {
  lang: SignatureLang
  /** Lowercase hex SHA-256 of the frozen file. */
  documentSha256: string
  /** "AG-2026-001" and the version number, printed in each page's header. */
  agreement: string
  version: number
  signers: SignaturePageSigner[]
}

export class SignaturePageError extends Error {
  constructor(
    readonly code: "SIGNATURE_NAME_NOT_DRAWABLE" | "NO_SIGNERS",
    message: string,
  ) {
    super(message)
    this.name = "SignaturePageError"
  }
}

/** Signers per page: six blocks fit an A4 page with the header and the fingerprint. */
export const SIGNERS_PER_PAGE = 6

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 56

/** The page words, from the `agreement-evidence` locale files, in the document's language. */
function wordsFor(lang: SignatureLang) {
  const t = (key: string, params?: Record<string, string | number>) =>
    serverT(lang, `agreement-evidence.pages.${key}`, params)
  return {
    page: (n: number, of: number) => t("page", { n, of }),
    heading: t("heading"),
    capacity: t("capacity"),
    typed: t("typed"),
    at: t("at"),
    level: (l: string) => (l === "demo" ? t("level_demo") : t("level_ses")),
    fingerprint: t("fingerprint"),
    document: (agreement: string, version: number) => t("document", { agreement, version }),
  }
}

/** Removes control characters (C0, DEL, C1) and bidirectional overrides; collapses spaces. */
export function plainText(value: string): string {
  let out = ""
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    const control =
      cp <= 0x1f ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x200e ||
      cp === 0x200f ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069)
    out += control ? " " : ch
  }
  return out.replace(/\s+/g, " ").trim()
}

let glyphFonts: { latin: fontkit.Font; cjk: fontkit.Font } | null = null
function fontsForGlyphs() {
  if (!glyphFonts) {
    glyphFonts = {
      latin: fontkit.create(Buffer.from(faceBytes("regular"))) as fontkit.Font,
      cjk: fontkit.create(Buffer.from(faceBytes("cjk"))) as fontkit.Font,
    }
  }
  return glyphFonts
}

/**
 * Whether every character of a typed name has a glyph in an embedded face.
 * A name that cannot be drawn is refused at the name step and typed again in
 * Latin letters, so the page never shows a hollow box for a signer's name.
 */
export function canDrawText(value: string): boolean {
  const fonts = fontsForGlyphs()
  for (const ch of plainText(value)) {
    if (ch === " ") continue
    const cp = ch.codePointAt(0) ?? 0
    const font = needsCjkFace(ch) ? fonts.cjk : fonts.latin
    if (!font.hasGlyphForCodePoint(cp)) return false
  }
  return true
}

function formatAt(at: Date, lang: SignatureLang): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  return lang === "fr" ? `${day} à ${time} UTC` : `${day} at ${time} UTC`
}

/** Render the signature pages as a PDF of their own. */
export async function renderSignaturePages(input: SignaturePagesInput): Promise<Uint8Array> {
  if (input.signers.length === 0) throw new SignaturePageError("NO_SIGNERS", "No signer to list.")
  for (const s of input.signers) {
    if (!canDrawText(s.name))
      throw new SignaturePageError(
        "SIGNATURE_NAME_NOT_DRAWABLE",
        "A signer's name has characters no embedded font can draw; it must be typed in Latin letters.",
      )
  }
  const w = wordsFor(input.lang)
  const doc = await PDFDocument.create()
  const cache = new Map<UnicodeFace, PDFFont>()
  const regular = await embedUnicodeFace(doc, "regular", cache)
  const bold = await embedUnicodeFace(doc, "bold", cache)
  // The CJK face is embedded only when a value needs it (an unused subset fails to encode).
  const needsCjk = input.signers.some((s) =>
    [s.name, s.capacity, s.typedPhrase ?? ""].some((v) =>
      splitByFace(plainText(v)).some((r) => r.cjk),
    ),
  )
  const cjk = needsCjk ? await embedUnicodeFace(doc, "cjk", cache) : regular
  const draw = (
    page: ReturnType<PDFDocument["addPage"]>,
    text: string,
    x: number,
    y: number,
    size: number,
    font: PDFFont,
  ) => {
    let cursor = x
    for (const run of splitByFace(plainText(text))) {
      const f = run.cjk ? cjk : font
      page.drawText(run.text, { x: cursor, y, size, font: f, color: rgb(0.1, 0.1, 0.1) })
      cursor += f.widthOfTextAtSize(run.text, size)
    }
  }
  const pages = Math.ceil(input.signers.length / SIGNERS_PER_PAGE)
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4)
    const [, height] = A4
    let y = height - MARGIN
    draw(page, w.heading, MARGIN, y, 16, bold)
    y -= 20
    draw(page, w.document(input.agreement, input.version), MARGIN, y, 10, regular)
    y -= 28
    for (const s of input.signers.slice(p * SIGNERS_PER_PAGE, (p + 1) * SIGNERS_PER_PAGE)) {
      draw(page, s.name, MARGIN, y, 12, bold)
      y -= 15
      draw(page, `${w.capacity}: ${s.capacity}`, MARGIN, y, 10, regular)
      y -= 13
      if (s.typedPhrase) {
        draw(page, `${w.typed}: ${s.typedPhrase}`, MARGIN, y, 10, regular)
        y -= 13
      }
      draw(page, `${w.at} ${formatAt(s.signedAt, input.lang)}`, MARGIN, y, 10, regular)
      y -= 13
      draw(page, w.level(s.level), MARGIN, y, 10, regular)
      y -= 26
    }
    draw(page, w.fingerprint, MARGIN, MARGIN + 30, 9, bold)
    draw(page, input.documentSha256, MARGIN, MARGIN + 18, 8, regular)
    draw(page, w.page(p + 1, pages), A4[0] - MARGIN - 140, MARGIN, 9, regular)
  }
  return doc.save({ useObjectStreams: false })
}

/**
 * The signed copy: the frozen file's pages unchanged, then the signature pages.
 * The frozen bytes are read and copied, never re-saved in place.
 */
export async function appendSignaturePages(
  frozen: Uint8Array,
  signaturePages: Uint8Array,
): Promise<{ bytes: Uint8Array; pageCount: number; signaturePageCount: number }> {
  const out = await PDFDocument.create()
  const src = await PDFDocument.load(frozen, { ignoreEncryption: true })
  for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page)
  const sig = await PDFDocument.load(signaturePages)
  for (const page of await out.copyPages(sig, sig.getPageIndices())) out.addPage(page)
  const title = src.getTitle()
  if (title) out.setTitle(title)
  const bytes = await out.save({ useObjectStreams: false })
  return { bytes, pageCount: out.getPageCount(), signaturePageCount: sig.getPageCount() }
}
