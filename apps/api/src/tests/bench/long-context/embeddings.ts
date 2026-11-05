// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The embedding leg of S4 to S6. One vector per bench document (message docs
// and window docs alike), computed once and cached to disk under the run's out
// directory, keyed by the corpus hash, so a second run of the same corpus pays
// nothing. Gemini `text-embedding-004` on GOOGLE_API_KEY, the only key this
// bench ever reads.
//
// When the embedding call fails, the failure is returned, never swallowed: the
// strategies that need it report "not run" with the reason instead of quietly
// degrading to keyword only and being scored as if they were hybrid.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createGoogle } from "@ai-sdk/google"
import { embed, embedMany } from "ai"
import type { BenchDoc } from "./bm25"
import type { Hit } from "./types"

export const EMBEDDING_MODEL_ID = "gemini-embedding-001"
const BATCH = 96
/** How many batches land before the cache file is rewritten. */
const CHECKPOINT_BATCHES = 10

export interface EmbeddingLeg {
  modelId: string
  search(query: string, limit: number): Promise<Hit[]>
}

interface CacheFile {
  model: string
  vectors: Record<string, number[]>
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export async function buildEmbeddingLeg(params: {
  docs: BenchDoc[]
  outDir: string
  corpusHash: string
  apiKey: string
  modelId?: string
}): Promise<EmbeddingLeg> {
  const modelId = params.modelId ?? EMBEDDING_MODEL_ID
  const google = createGoogle({ apiKey: params.apiKey })
  const model = google.textEmbeddingModel(modelId)
  const cacheDir = join(params.outDir, "embedding-cache")
  mkdirSync(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, `${params.corpusHash}-${modelId}.json`)
  let cache: CacheFile = { model: modelId, vectors: {} }
  if (existsSync(cachePath)) {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile
    } catch {
      cache = { model: modelId, vectors: {} }
    }
  }
  const missing = params.docs.filter((d) => !cache.vectors[d.docId])
  // The cache file is a hundred megabytes on a real corpus, so it is flushed
  // every CHECKPOINT batches rather than after each one: rewriting it per
  // batch made the embedding pass quadratic in its own I/O.
  let sinceFlush = 0
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH)
    const { embeddings } = await embedMany({
      model,
      values: slice.map((d) => d.text.slice(0, 8000)),
    })
    slice.forEach((doc, index) => {
      cache.vectors[doc.docId] = embeddings[index] as number[]
    })
    if (++sinceFlush >= CHECKPOINT_BATCHES) {
      writeFileSync(cachePath, JSON.stringify(cache))
      sinceFlush = 0
    }
  }
  if (missing.length > 0) writeFileSync(cachePath, JSON.stringify(cache))

  const byId = new Map(params.docs.map((d) => [d.docId, d]))
  return {
    modelId,
    async search(query: string, limit: number): Promise<Hit[]> {
      const { embedding } = await embed({ model, value: query })
      const scored: Hit[] = []
      for (const [docId, vector] of Object.entries(cache.vectors)) {
        const doc = byId.get(docId)
        if (!doc) continue
        scored.push({
          docId,
          rowIds: doc.rowIds,
          score: cosine(embedding as number[], vector),
          snippet: doc.text.slice(0, 280),
          ts: doc.ts,
          author: doc.author,
        })
      }
      scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      return scored.slice(0, limit)
    },
  }
}
