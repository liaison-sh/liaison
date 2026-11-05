// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The keyword leg, in process. Production ranks the transcript in Meili over
// two document namespaces: one document per message, plus a sliding window
// document every third message covering the last five
// (`message-indexer.ts:36`, MESSAGE_WINDOW_EVERY = 3, MESSAGE_WINDOW_SIZE = 5).
// The bench mirrors that document shape so a ranking measured here means
// something for production, and scores it with plain BM25 so the bench owns
// its own ranking and needs no search server.
import type { CorpusRow, Hit } from "./types"

export const WINDOW_EVERY = 3
export const WINDOW_SIZE = 5

const K1 = 1.2
const B = 0.75

export interface BenchDoc {
  docId: string
  rowIds: string[]
  text: string
  ts: string
  author: string
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
}

/** Message documents plus the sliding window documents, in row order. */
export function buildDocs(rows: CorpusRow[]): BenchDoc[] {
  const docs: BenchDoc[] = rows.map((r) => ({
    docId: r.id,
    rowIds: [r.id],
    text: r.content,
    ts: r.ts,
    author: r.author,
  }))
  for (let i = 0; i < rows.length; i++) {
    if ((i + 1) % WINDOW_EVERY !== 0) continue
    const window = rows.slice(Math.max(0, i + 1 - WINDOW_SIZE), i + 1)
    const anchor = rows[i] as CorpusRow
    docs.push({
      docId: `win:${anchor.id}`,
      rowIds: window.map((r) => r.id),
      text: window.map((r) => r.content).join(" "),
      ts: anchor.ts,
      author: anchor.author,
    })
  }
  return docs
}

export class Bm25Index {
  private readonly docs: BenchDoc[]
  private readonly terms: string[][]
  private readonly df = new Map<string, number>()
  private readonly avgLen: number

  constructor(docs: BenchDoc[]) {
    this.docs = docs
    this.terms = docs.map((d) => tokenize(d.text))
    for (const t of this.terms) {
      for (const term of new Set(t)) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }
    const total = this.terms.reduce((sum, t) => sum + t.length, 0)
    this.avgLen = this.terms.length > 0 ? total / this.terms.length : 1
  }

  search(query: string, limit: number): Hit[] {
    const q = tokenize(query)
    const n = this.docs.length
    if (n === 0 || q.length === 0) return []
    const scored: Hit[] = []
    for (let i = 0; i < n; i++) {
      const terms = this.terms[i] as string[]
      if (terms.length === 0) continue
      const counts = new Map<string, number>()
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1)
      let score = 0
      for (const term of q) {
        const tf = counts.get(term)
        if (!tf) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * terms.length) / this.avgLen)))
      }
      if (score <= 0) continue
      const doc = this.docs[i] as BenchDoc
      scored.push({
        docId: doc.docId,
        rowIds: doc.rowIds,
        score,
        snippet: doc.text.slice(0, 280),
        ts: doc.ts,
        author: doc.author,
      })
    }
    // Ties broken by document id so a run is reproducible.
    scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    return scored.slice(0, limit)
  }
}
