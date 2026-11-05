// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side draw-command replayer — the RCE-free security boundary.
//
// A template runs in the QuickJS app sandbox and emits a JSON `DrawCommand[]`.
// This module validates that list against the shared zod schema, bounds-checks
// it, then executes the equivalent pdf-lib calls on the host. The host NEVER
// evaluates template-authored code: there is no `eval`, no `new Function`, and
// no `data`-sourced bytes here. Every command field was schema-validated before
// it reaches a pdf-lib call.

import {
  type DrawCommand,
  DrawCommandsSchema,
  MAX_EMBED_IMAGES,
  MAX_IMAGE_BYTES,
} from "@liaison/shared"
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb, StandardFonts } from "pdf-lib"
import { finalizePdfA, jpegComponents, type PdfAOptions } from "~/modules/pdf/pdfa/finalize"
import {
  embedUnicodeFace,
  HELVETICA_FACE,
  splitByFace,
  type UnicodeFace,
} from "~/modules/pdf/unicode-fonts"

export type PdfReplayErrorCode = "invalid_commands" | "too_many_pages" | "pdfa_font_not_embeddable"

/** Mirrors `PdfRenderError` — carries a stable `code` the pool/render map. */
export class PdfReplayError extends Error {
  readonly code: PdfReplayErrorCode
  constructor(code: PdfReplayErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = "PdfReplayError"
  }
}

/** Hard cap on pages created by a single program (DoS bound). */
export const MAX_PAGES = 2000

// Map the allowlisted enum names to pdf-lib's StandardFonts. Keyed by the
// schema's `STANDARD_FONTS` values so an un-allowlisted name can never reach
// `embedStandardFont`.
const STANDARD_FONT_MAP: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  HelveticaBold: StandardFonts.HelveticaBold,
  HelveticaOblique: StandardFonts.HelveticaOblique,
  HelveticaBoldOblique: StandardFonts.HelveticaBoldOblique,
  TimesRoman: StandardFonts.TimesRoman,
  TimesRomanBold: StandardFonts.TimesRomanBold,
  TimesRomanItalic: StandardFonts.TimesRomanItalic,
  TimesRomanBoldItalic: StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  CourierBold: StandardFonts.CourierBold,
  CourierOblique: StandardFonts.CourierOblique,
  CourierBoldOblique: StandardFonts.CourierBoldOblique,
}

/** An embedded image's bytes + MIME, as resolved from a `kernel.files` id. */
export interface ResolvedImage {
  bytes: Uint8Array
  mime: string
}

export interface ReplayDrawCommandsOptions {
  /**
   * Resolve an `embedImage` command's `fileId` to bytes + mime, scoped to the
   * render's org (fail-closed: cross-org or not-found → `null`). Missing
   * `resolveImage` (or a `null`/rejected resolution) means the embed is
   * SKIPPED — a missing/inaccessible logo must never fail a render.
   */
  resolveImage?: (fileId: string) => Promise<ResolvedImage | null>
  /**
   * Produce a PDF/A-3B file natively (see ./pdfa/finalize.ts): metadata is never rewritten by
   * pdf-lib, every font is embedded (a non-Helvetica base-14 font is refused), a CMYK JPEG is
   * skipped like any other unusable image, and the document is finalised with XMP, an sRGB
   * OutputIntent, associated files and a trailer ID.
   */
  pdfa?: PdfAOptions
}

/**
 * Compute the CONTAIN-fit scaled dimensions of an `imgW x imgH` image inside
 * a `maxW x maxH` box, preserving aspect ratio. Pure — no pdf-lib dependency —
 * so it is directly unit-testable and reused by the replay loop.
 */
export function fitContain(
  imgW: number,
  imgH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (imgW <= 0 || imgH <= 0 || maxW <= 0 || maxH <= 0) {
    return { width: 0, height: 0 }
  }
  const scale = Math.min(maxW / imgW, maxH / imgH)
  return { width: imgW * scale, height: imgH * scale }
}

const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg"])

/**
 * Validate + replay a sandbox-emitted draw-command list against pdf-lib and
 * return the serialized PDF bytes. Throws `PdfReplayError` (with a stable
 * `code`) on any schema violation or bound breach — fail-closed, no pdf-lib
 * mutation on a rejected program.
 */
export async function replayDrawCommands(
  raw: unknown,
  opts: ReplayDrawCommandsOptions = {},
): Promise<Uint8Array> {
  const parsed = DrawCommandsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PdfReplayError("invalid_commands", parsed.error.message)
  }
  const commands: DrawCommand[] = parsed.data

  // Bound the page count before touching pdf-lib.
  const pageOps = commands.filter((c) => c.op === "addPage").length
  if (pageOps > MAX_PAGES) {
    throw new PdfReplayError(
      "too_many_pages",
      `program creates ${pageOps} pages (cap ${MAX_PAGES})`,
    )
  }

  // PDF/A: Info and XMP must agree, so pdf-lib must not stamp its own Producer / dates.
  const doc = await PDFDocument.create(opts.pdfa ? { updateMetadata: false } : {})
  const fonts = new Map<string, PDFFont>()
  // Keyed by FACE, not by ref: a template embeds Helvetica three times under
  // three refs, and embedding the same subset three times would triple the
  // font bytes in the output for no gain.
  const unicodeFonts = new Map<UnicodeFace, PDFFont>()
  const pages: PDFPage[] = []
  // Refs that resolved to an embedded pdf-lib image — a `drawImage` whose ref
  // is absent from this map (missing resolveImage, resolution failed, over
  // cap, unsupported mime) is a silent no-op, never a throw.
  const images = new Map<string, PDFImage>()
  let embedImageCount = 0

  const pageAt = (index: number): PDFPage => {
    const page = pages[index]
    if (!page) {
      throw new PdfReplayError("invalid_commands", `draw op references missing page ${index}`)
    }
    return page
  }
  const fontFor = (ref: string): PDFFont => {
    const font = fonts.get(ref)
    if (!font) {
      throw new PdfReplayError("invalid_commands", `draw op references unembedded font '${ref}'`)
    }
    return font
  }

  for (const cmd of commands) {
    switch (cmd.op) {
      case "setMetadata": {
        // H2 — map to all three pdf-lib metadata calls explicitly.
        if (cmd.title) doc.setTitle(cmd.title)
        if (cmd.producer) doc.setProducer(cmd.producer)
        if (cmd.creator) doc.setCreator(cmd.creator)
        break
      }
      case "embedFont": {
        // The Helvetica family is served by an embedded, metrically identical
        // Liberation Sans so text above Latin-1 renders instead of being
        // stripped to "?" by the template. Everything else keeps its base-14
        // font: a template asking for Times or Courier wants a serif or a
        // monospace, and substituting a sans to widen the charset would be a
        // worse answer than the ceiling.
        const face: UnicodeFace | undefined = HELVETICA_FACE[cmd.standardFont]
        if (face) {
          fonts.set(cmd.ref, await embedUnicodeFace(doc, face, unicodeFonts))
          break
        }
        if (opts.pdfa) {
          // A base-14 font is referenced, not embedded: forbidden in PDF/A.
          throw new PdfReplayError(
            "pdfa_font_not_embeddable",
            `font '${cmd.standardFont}' cannot be embedded in a PDF/A document`,
          )
        }
        const std = STANDARD_FONT_MAP[cmd.standardFont]
        // Schema's enum guarantees membership, but guard defensively.
        if (!std) {
          throw new PdfReplayError("invalid_commands", `unknown font '${cmd.standardFont}'`)
        }
        fonts.set(cmd.ref, await doc.embedFont(std))
        break
      }
      case "addPage": {
        pages.push(doc.addPage([cmd.width, cmd.height]))
        break
      }
      case "drawText": {
        const page = pageAt(cmd.page)
        const font = fontFor(cmd.font)
        const color = cmd.color ? { color: rgb(cmd.color.r, cmd.color.g, cmd.color.b) } : {}
        // Split the string into runs of one face each and lay them out
        // left to right. A single drawText takes ONE font, and real values mix
        // scripts inside one string ("株式会社アイシン YYSystem事業推進部"), so a
        // string is not necessarily one font's worth of text.
        //
        // The common case -- no CJK at all -- must stay a single drawText, both
        // for output size and because re-laying-out Latin text run by run would
        // accumulate rounding against the template's own measurements.
        const runs = splitByFace(cmd.text)
        if (runs.length <= 1 && !runs[0]?.cjk) {
          page.drawText(cmd.text, { x: cmd.x, y: cmd.y, size: cmd.size, font, ...color })
          break
        }
        const cjkFont = await embedUnicodeFace(doc, "cjk", unicodeFonts)
        let x = cmd.x
        for (const run of runs) {
          const runFont = run.cjk ? cjkFont : font
          page.drawText(run.text, { x, y: cmd.y, size: cmd.size, font: runFont, ...color })
          // Advance by what was actually drawn, so the next run starts where
          // this one ended rather than at a position the template guessed.
          x += runFont.widthOfTextAtSize(run.text, cmd.size)
        }
        break
      }
      case "drawLine": {
        const page = pageAt(cmd.page)
        page.drawLine({
          start: cmd.start,
          end: cmd.end,
          ...(cmd.thickness !== undefined ? { thickness: cmd.thickness } : {}),
          ...(cmd.color ? { color: rgb(cmd.color.r, cmd.color.g, cmd.color.b) } : {}),
        })
        break
      }
      case "drawRectangle": {
        const page = pageAt(cmd.page)
        page.drawRectangle({
          x: cmd.x,
          y: cmd.y,
          width: cmd.width,
          height: cmd.height,
          ...(cmd.color ? { color: rgb(cmd.color.r, cmd.color.g, cmd.color.b) } : {}),
          ...(cmd.borderColor
            ? { borderColor: rgb(cmd.borderColor.r, cmd.borderColor.g, cmd.borderColor.b) }
            : {}),
          ...(cmd.borderWidth !== undefined ? { borderWidth: cmd.borderWidth } : {}),
        })
        break
      }
      case "embedImage": {
        // A missing logo/image must NEVER fail an invoice render — every
        // failure path here (no resolver, cap exceeded, resolver returns
        // null/throws, oversized bytes, unsupported mime, corrupt bytes)
        // silently skips the embed. `drawImage` referencing this ref later
        // becomes a no-op because `images` never gets the entry.
        if (!opts.resolveImage) break
        if (embedImageCount >= MAX_EMBED_IMAGES) break
        embedImageCount += 1
        const resolved = await opts.resolveImage(cmd.fileId).catch(() => null)
        if (!resolved) break
        if (resolved.bytes.byteLength > MAX_IMAGE_BYTES) break
        if (!SUPPORTED_IMAGE_MIMES.has(resolved.mime)) break
        // PDF/A with an sRGB OutputIntent: a CMYK JPEG would be a DeviceCMYK image. Skipped, like
        // any other image the render cannot use; the document still renders.
        if (opts.pdfa && resolved.mime === "image/jpeg" && jpegComponents(resolved.bytes) === 4)
          break
        try {
          const image =
            resolved.mime === "image/png"
              ? await doc.embedPng(resolved.bytes)
              : await doc.embedJpg(resolved.bytes)
          images.set(cmd.ref, image)
        } catch {
          // Corrupt / undecodable bytes — skip, don't fail the render.
        }
        break
      }
      case "drawImage": {
        const image = images.get(cmd.ref)
        if (!image) break // unresolved/skipped embed — silent no-op
        const page = pageAt(cmd.page)
        const { width, height } = fitContain(image.width, image.height, cmd.maxWidth, cmd.maxHeight)
        if (width <= 0 || height <= 0) break
        // DSL convention: `cmd.y` is the TOP of the box; pdf-lib's `drawImage`
        // `y` is the bottom-left origin of the drawn image.
        page.drawImage(image, { x: cmd.x, y: cmd.y - height, width, height })
        break
      }
    }
  }

  // `save()` does NOT touch metadata (only the create/load constructor does via
  // `updateMetadata`), so the explicit Producer/Creator set above survive into
  // the bytes (H2 — producer parity). `useObjectStreams: false` keeps the info
  // dict in plain text so `pdf-parse` can read it back.
  if (opts.pdfa) await finalizePdfA(doc, opts.pdfa)
  return await doc.save({ useObjectStreams: false })
}
