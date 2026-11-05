// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Read the visible text back out of rendered PDF bytes.
//
// Test-support, but it lives in src rather than beside one test because several
// suites need it, and because of what it exists to prevent: asserting on DRAW
// COMMANDS is exactly what let a wrong artifact ship twice. Both times the
// command list was correct and what reached the page was not -- a customer name
// stripped to "?" by the font layer, an order reference absent from a document
// whose template emitted it. The only assertion that catches either reads the
// finished bytes.
//
// Uses pdf.js rather than parsing by hand. The first cut here did parse by
// hand and got two things wrong that are worth recording, because both produced
// confident nonsense rather than an error: "endstream" contains "stream", so a
// naive scanner re-matches inside its own terminator and walks the file at a
// shifted offset forever; and a subset-embedded font writes GLYPH INDICES, not
// characters, so its ToUnicode CMap is mandatory -- and the CMaps of different
// faces collide, so merging them across fonts decodes bold text with the
// regular map and yields plausible-looking garbage ("EMBODIDNOVCFN").
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"

/**
 * Extract page text from PDF bytes.
 *
 * Text-positioning is not reconstructed: pdf.js returns the text items in
 * content-stream order and this joins them with newlines, so words that share a
 * visual line come back as separate lines. Assert on substrings, not spacing.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({
    // pdf.js mutates the buffer it is given; hand it a copy so a caller can
    // still inspect or re-load the same bytes afterwards.
    data: new Uint8Array(bytes),
    // No canvas, no system fonts: this only ever reads text, and the rendering
    // paths would pull optional native dependencies that have no business being
    // required by a test helper.
    useSystemFonts: false,
    disableFontFace: true,
  }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter((s) => s !== "")
        .join("\n"),
    )
  }
  // `cleanup` on the proxy, not `destroy` on the loading task -- releasing the
  // worker's page caches is what matters when a suite renders many documents.
  await doc.cleanup()
  return pages.join("\n")
}
