// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PDF page-rotation normalization. Some upstream generators (observed: Boxtal
// carrier labels, whose content is authored upright on a landscape page) stamp
// a spurious page `/Rotate` that makes every viewer AND printer present the
// content sideways. For files we import and re-serve for PRINTING (labels),
// the readable orientation is the raw content, so callers can opt in to
// stripping the flag at import time.

import { degrees, PDFDocument } from "pdf-lib"
import { pdfLogger as log } from "~/lib/logger"

/**
 * Return the PDF bytes with every page's `/Rotate` cleared (content untouched).
 * Non-PDF input, unparseable input, or a document with no rotated page returns
 * the ORIGINAL buffer unchanged — never throws, so an import can apply this
 * unconditionally without risking the download.
 */
export async function stripPdfRotation(bytes: Buffer): Promise<Buffer> {
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return bytes
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    let touched = false
    for (const page of doc.getPages()) {
      if (((page.getRotation().angle % 360) + 360) % 360 !== 0) {
        page.setRotation(degrees(0))
        touched = true
      }
    }
    if (!touched) return bytes
    return Buffer.from(await doc.save({ useObjectStreams: false }))
  } catch (err) {
    log.warn({ err }, "pdf normalize: rotation strip failed, keeping original bytes")
    return bytes
  }
}
