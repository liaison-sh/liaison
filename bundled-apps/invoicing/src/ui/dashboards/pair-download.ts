// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Download both halves of a split order in one action.
//
// The two PDFs are separate FILES and must stay separate -- merging them into
// one document would put the software lines in front of the customs officer
// reading the goods invoice, which is exactly what the split exists to prevent.
// So this fetches both and saves both, named by document number, never a merge.
//
// Sequential, not Promise.all: two PDF renders on one order are not worth a
// burst, and a browser that blocks the second concurrent programmatic download
// silently drops it -- which looks like the button half-working.

export interface PairDownloadDeps {
  /** Resolve a document's PDF url (invokes documents_download_pdf). */
  resolveUrl: (documentId: string) => Promise<string | null>
  /** Fetch the bytes at an already-resolved url. */
  fetchBlob: (url: string) => Promise<Blob>
  /** Hand a blob to the user under a filename. */
  save: (blob: Blob, filename: string) => void | Promise<void>
}

export interface PairDownloadResult {
  saved: string[]
  failed: string[]
}

/**
 * Download every document in a pair. One half failing must NOT cancel the
 * other: an operator who gets the goods invoice and a clear "software half
 * failed" can retry that one, whereas an all-or-nothing abort leaves them with
 * nothing and no idea which half broke.
 */
export async function downloadPair(
  docs: Array<{ id: string; number?: string | null }>,
  deps: PairDownloadDeps,
): Promise<PairDownloadResult> {
  const result: PairDownloadResult = { saved: [], failed: [] }
  for (const doc of docs) {
    const label = doc.number ?? doc.id
    try {
      const url = await deps.resolveUrl(doc.id)
      if (!url) {
        result.failed.push(label)
        continue
      }
      const blob = await deps.fetchBlob(url)
      const pdf = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" })
      await deps.save(pdf, `${label}.pdf`)
      result.saved.push(label)
    } catch {
      result.failed.push(label)
    }
  }
  return result
}
