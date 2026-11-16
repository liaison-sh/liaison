// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The render service's work, run inside its child process only: the file
// checks of an upload, the page pictures, and the compare of the two readers.
// The page renderer (pdf.js on a native canvas) reads the frozen bytes through
// their cross-reference; the merge (pdf-lib, the one merge function of the
// signed copy) reads them its own way. A file both read the same way has one
// reading; anything else is refused at freeze and, again, at seal.
//
// Detect only: the frozen bytes are never normalised, flattened, stripped or
// re-saved. Pictures are made once, here, and never rebuilt.

import { createHash } from "node:crypto"
import { createCanvas } from "@napi-rs/canvas"
import { PageSizes, PDFDocument } from "pdf-lib"
import { AnnotationMode, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import sharp from "sharp"
import { appendSignaturePages } from "~/modules/agreement-evidence/signature-pages"
import {
  checkPdfStructure,
  inspectUploadedPdf,
  UploadPdfError,
} from "~/modules/documents/pdf-form-core"
import {
  type IntakeResult,
  type PagePicture,
  type PageReading,
  PdfRenderError,
  PICTURE_READING_WIDTH,
  PICTURE_SMALL_WIDTH,
  type SealMergeResult,
} from "./protocol"

/** Told before each page is rendered, so the parent can hold the page deadline. */
export type PageHook = (n: number) => void

interface RenderedPage extends PageReading {
  rgba: Uint8Array | null
}

const STANDARD_FONTS = new URL("./standard_fonts/", import.meta.resolve("pdfjs-dist/package.json"))
  .pathname

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Read the first `limit` pages (all when null) as the page renderer reads
 * them: size, raw RGBA at the reading width with its hash, and the text.
 */
export async function readPages(
  bytes: Uint8Array,
  opts: { limit?: number | null; keepRgba?: boolean; onPage?: PageHook } = {},
): Promise<{ pageCount: number; pages: RenderedPage[] }> {
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    // pdf.js 6 has no eval path left (no `isEvalSupported` option, no `new Function`
    // in its build): fonts are drawn from parsed outlines only.
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS,
    stopAtErrors: true,
  }).promise
  try {
    const count = opts.limit ? Math.min(opts.limit, doc.numPages) : doc.numPages
    const pages: RenderedPage[] = []
    for (let n = 1; n <= count; n++) {
      opts.onPage?.(n)
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: PICTURE_READING_WIDTH / base.width })
      const width = Math.round(viewport.width)
      const height = Math.round(viewport.height)
      const canvas = createCanvas(width, height)
      const context = canvas.getContext("2d")
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, width, height)
      // Annotations and filled fields are drawn from their appearance, as a reader shows them.
      await page.render({
        canvas: canvas as never,
        canvasContext: context as never,
        viewport,
        annotationMode: AnnotationMode.ENABLE,
      }).promise
      const rgba = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter((s) => s !== "")
        .join("\n")
      pages.push({
        n,
        width,
        height,
        rgbaSha256: sha256Hex(rgba),
        text,
        rgba: opts.keepRgba ? rgba : null,
      })
      page.cleanup()
    }
    return { pageCount: doc.numPages, pages }
  } finally {
    await doc.cleanup()
  }
}

/** The first page where two readings differ (size, pixels or text), or null. */
export function firstDifference(a: PageReading[], b: PageReading[]): number | null {
  for (const page of a) {
    const other = b.find((p) => p.n === page.n)
    if (
      !other ||
      other.width !== page.width ||
      other.height !== page.height ||
      other.rgbaSha256 !== page.rgbaSha256 ||
      other.text !== page.text
    )
      return page.n
  }
  return null
}

/** One blank A4 page: what a dry-run merge appends in place of the signature page. */
async function blankSignaturePage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage(PageSizes.A4)
  return doc.save({ useObjectStreams: false })
}

/**
 * The two checks of one reading, each replaceable on its own by a test, so
 * neither can be removed unnoticed: the structure rule on raw bytes, and the
 * compare of the renderer over the frozen bytes against the same renderer
 * over the merge.
 */
export const oneReadingChecks = {
  structure: checkPdfStructure,
  compare: firstDifference,
}

async function mergeOrRefuse(
  frozen: Uint8Array,
  signaturePages: Uint8Array,
  refusal: () => PdfRenderError,
) {
  try {
    return await appendSignaturePages(frozen, signaturePages)
  } catch {
    throw refusal()
  }
}

/**
 * The file checks of an upload, then its pictures: the structure rule, the
 * raw scan and pdf-lib's graph (inspectUploadedPdf), equal page counts from
 * both readers, every page rendered and hashed, a dry-run merge with a blank
 * signature page, and the renderer agreeing on every page of the frozen file
 * between the frozen bytes and the merge.
 */
export async function intakeUpload(bytes: Uint8Array, onPage?: PageHook): Promise<IntakeResult> {
  const report = await inspectUploadedPdf(bytes, { structure: oneReadingChecks.structure })
  let frozen: Awaited<ReturnType<typeof readPages>>
  try {
    frozen = await readPages(bytes, { keepRgba: true, ...(onPage ? { onPage } : {}) })
  } catch {
    throw new PdfRenderError("PDF_UNREADABLE", "the page renderer could not read the file")
  }
  if (frozen.pageCount !== report.pageCount)
    throw new PdfRenderError(
      "PDF_VARIES_BY_VIEWER",
      `the two readers count ${report.pageCount} and ${frozen.pageCount} pages`,
    )
  const merge = await mergeOrRefuse(
    bytes,
    await blankSignaturePage(),
    () =>
      new PdfRenderError("PDF_VARIES_BY_VIEWER", "the file cannot be merged into a signed copy"),
  )
  let merged: Awaited<ReturnType<typeof readPages>>
  try {
    merged = await readPages(merge.bytes, { limit: frozen.pageCount })
  } catch {
    throw new PdfRenderError("PDF_VARIES_BY_VIEWER", "the merged copy cannot be read back")
  }
  const differs = oneReadingChecks.compare(frozen.pages, merged.pages)
  if (differs !== null)
    throw new PdfRenderError(
      "PDF_VARIES_BY_VIEWER",
      `page ${differs} reads differently once merged into a signed copy`,
    )
  const pages: PagePicture[] = []
  for (const page of frozen.pages) {
    const rgba = page.rgba as Uint8Array
    const raw = { raw: { width: page.width, height: page.height, channels: 4 as const } }
    const reading = await sharp(Buffer.from(rgba), raw).webp({ quality: 82 }).toBuffer()
    const small = await sharp(Buffer.from(rgba), raw)
      .resize({ width: PICTURE_SMALL_WIDTH })
      .webp({ quality: 78 })
      .toBuffer({ resolveWithObject: true })
    pages.push({
      n: page.n,
      width: page.width,
      height: page.height,
      rgbaSha256: page.rgbaSha256,
      text: page.text,
      reading: reading.toString("base64"),
      small: small.data.toString("base64"),
      smallWidth: small.info.width,
      smallHeight: small.info.height,
    })
  }
  return { report, pages, scanned: pages.every((p) => p.text.trim() === "") }
}

/**
 * The signed copy of an upload, built by the one merge function, then the
 * frozen file and the first pages of the merge rendered by this moment's
 * renderer and compared. A difference answers `COPY_DIFFERS` and no bytes:
 * nothing is sealed, nothing is repaired.
 */
export async function sealMerge(
  frozen: Uint8Array,
  signaturePages: Uint8Array,
  onPage?: PageHook,
): Promise<SealMergeResult> {
  const out = await mergeOrRefuse(
    frozen,
    signaturePages,
    () => new PdfRenderError("COPY_DIFFERS", "the signed copy could not be built from the file"),
  )
  const before = await readPages(frozen, onPage ? { onPage } : {})
  const after = await readPages(out.bytes, { limit: before.pageCount })
  if (oneReadingChecks.compare(before.pages, after.pages) !== null)
    throw new PdfRenderError("COPY_DIFFERS", "the signed copy does not read as the frozen file")
  return {
    merged: Buffer.from(out.bytes).toString("base64"),
    pageCount: out.pageCount,
    signaturePageCount: out.signaturePageCount,
  }
}

/** Map a check's throw to the service's code; never throws. */
export function renderCodeOf(err: unknown): { code: PdfRenderError["code"]; message: string } {
  if (err instanceof PdfRenderError || err instanceof UploadPdfError)
    return { code: err.code, message: err.message }
  return { code: "PDF_UNREADABLE", message: err instanceof Error ? err.message : String(err) }
}
