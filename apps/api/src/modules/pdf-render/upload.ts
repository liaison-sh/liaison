// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The API side of an upload's freeze: size, the render service's checks and
// pictures, then what the API checks itself before anything is stored (each
// picture is a WebP of its stated size), then the virus scan. Detect only: the
// bytes handed back for storage are the uploaded bytes, untouched.

import { createHash } from "node:crypto"
import sharp from "sharp"
import { scanBytes } from "~/lib/clamav"
import { UPLOAD_PDF_MAX_BYTES } from "~/modules/documents/pdf-form-core"
import { callRenderService } from "./client"
import type { IntakeResult, PagePicture, PdfRenderCode } from "./protocol"

export type ScanState = "clean" | "not_run" | "infected"

export type UploadCheck =
  | {
      status: "ok"
      sha256: string
      byteSize: number
      pagesSha256: string
      scanState: Exclude<ScanState, "infected">
      intake: IntakeResult
    }
  | { status: "refused"; code: PdfRenderCode | "PDF_INFECTED"; message: string; signature?: string }

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** One fingerprint of what the renderer read: each page's pixels and text, in order. */
export function pagesFingerprint(
  pages: ReadonlyArray<{ n: number; rgbaSha256: string; text: string }>,
): string {
  return sha256Hex(pages.map((p) => `${p.n} ${p.rgbaSha256} ${sha256Hex(p.text)}`).join("\n"))
}

/** True when `base64` holds a WebP of exactly `width` x `height`. */
async function isWebpOfSize(base64: string, width: number, height: number): Promise<boolean> {
  const bytes = Buffer.from(base64, "base64")
  if (bytes.subarray(0, 4).toString("latin1") !== "RIFF") return false
  if (bytes.subarray(8, 12).toString("latin1") !== "WEBP") return false
  try {
    const meta = await sharp(bytes).metadata()
    return meta.format === "webp" && meta.width === width && meta.height === height
  } catch {
    return false
  }
}

async function picturesAreData(pages: PagePicture[]): Promise<boolean> {
  for (const p of pages) {
    if (!(await isWebpOfSize(p.reading, p.width, p.height))) return false
    if (!(await isWebpOfSize(p.small, p.smallWidth, p.smallHeight))) return false
  }
  return true
}

/** The checks of one uploaded file, in order. Never throws. */
export async function checkUploadedPdf(orgId: string, bytes: Uint8Array): Promise<UploadCheck> {
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-")
    return { status: "refused", code: "NOT_A_PDF", message: "the file is not a PDF" }
  if (bytes.byteLength > UPLOAD_PDF_MAX_BYTES)
    return {
      status: "refused",
      code: "PDF_TOO_LARGE",
      message: `the file is larger than ${UPLOAD_PDF_MAX_BYTES / (1024 * 1024)} MB`,
    }
  const out = await callRenderService<IntakeResult>({
    op: "intake",
    orgId,
    pdf: Buffer.from(bytes).toString("base64"),
  })
  if (!out.ok) return { status: "refused", code: out.code, message: out.message }
  if (!(await picturesAreData(out.result.pages)))
    return {
      status: "refused",
      code: "PDF_UNREADABLE",
      message: "the file reader answered something that is not a page picture",
    }
  const scan = await scanBytes(bytes)
  if (scan.status === "infected")
    return {
      status: "refused",
      code: "PDF_INFECTED",
      message: "the virus scanner refused this file",
      signature: scan.signature,
    }
  return {
    status: "ok",
    sha256: sha256Hex(bytes),
    byteSize: bytes.byteLength,
    pagesSha256: pagesFingerprint(out.result.pages),
    scanState: scan.status === "clean" ? "clean" : "not_run",
    intake: out.result,
  }
}
