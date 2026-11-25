// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the render service is asked and answers. The service parses uploaded
// PDFs and nothing else: the file checks, the page pictures, the compare of
// the two readers, and the merge of an upload at seal. Bytes cross as base64;
// every answer is data, never a throw.

import type { UploadPdfCode, UploadPdfReport } from "~/modules/documents/pdf-form-core"

/** Reading width of a page picture, in pixels; the hashes are taken at it. */
export const PICTURE_READING_WIDTH = 1240
/** The small picture, for a phone's first paint. */
export const PICTURE_SMALL_WIDTH = 620
/** A page's render may take this long before the child is killed. */
export const PDF_RENDER_PAGE_MS = 10_000
/** A whole file's work may take this long before the child is killed. */
export const PDF_RENDER_FILE_MS = 120_000
/** Resident memory the child may reach before it is killed. */
export const PDF_RENDER_MAX_RSS_BYTES = 1024 * 1024 * 1024
/** Children running at once in one service; not shared with form filling. */
export const PDF_RENDER_SLOTS = 2
/** Per organization: one running, three waiting, then busy. */
export const PDF_RENDER_ORG_RUNNING = 1
export const PDF_RENDER_ORG_WAITING = 3

export type PdfRenderCode =
  | UploadPdfCode
  | "PDF_RENDER_UNAVAILABLE"
  | "PDF_RENDER_BUSY"
  /** At seal: the signed copy does not read as the frozen file did. */
  | "COPY_DIFFERS"

export type PdfRenderRequest =
  | { op: "intake"; orgId: string; pdf: string }
  | { op: "seal_merge"; orgId: string; frozen: string; signaturePages: string }

/** One page as the renderer read it. */
export interface PageReading {
  n: number
  width: number
  height: number
  /** SHA-256 of the raw RGBA at the reading width, before encoding. */
  rgbaSha256: string
  text: string
}

export interface PagePicture extends PageReading {
  /** WebP at the reading width, base64. */
  reading: string
  /** WebP at the small width, base64. */
  small: string
  smallWidth: number
  smallHeight: number
}

export interface IntakeResult {
  report: UploadPdfReport
  pages: PagePicture[]
  /** True when no page has any text: kept, read as pictures only. */
  scanned: boolean
}

export interface SealMergeResult {
  merged: string
  pageCount: number
  signaturePageCount: number
}

export type PdfRenderResponse<T> =
  | { ok: true; result: T }
  | { ok: false; code: PdfRenderCode; message: string }

export class PdfRenderError extends Error {
  readonly code: PdfRenderCode
  constructor(code: PdfRenderCode, message: string) {
    super(message)
    this.code = code
    this.name = "PdfRenderError"
  }
}
