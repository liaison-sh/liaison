// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The width of the memory vectors, one value for the whole instance.
//
// The search index is shared by every org of the instance and Meili's
// `userProvided` embedder declares ONE fixed width, so the document vectors,
// the query vectors and the embedder settings all follow EMBEDDING_DIMENSIONS
// (lib/env.ts). Gemini's embedding model is trained so that the opening of its
// vector is itself a usable embedding (Matryoshka representation learning):
// 768 keeps nearly all of the retrieval quality at a quarter of 3072's memory.
// A vector cut below the model's full width is no longer unit length, so it is
// L2 normalised again (Google's guidance for a truncated output), and the
// cosine and dot product scores the index computes stay comparable.
//
// Every provider path asks for the configured width (`outputDimensionality`
// on Google, `dimensions` on OpenRouter) AND cuts and normalises what comes
// back here, so a provider that ignores the request still stores the right
// width.
import { env } from "~/lib/env"

/** The widths a provider path can produce. */
export const SUPPORTED_EMBEDDING_DIMENSIONS = [768, 1536, 3072] as const
export type EmbeddingDimensions = (typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number]
export const DEFAULT_EMBEDDING_DIMENSIONS: EmbeddingDimensions = 768

/** The widest output of each model. A model not listed is taken to reach 3072. */
const MAX_DIMENSIONS_BY_MODEL: Record<string, number> = {
  "gemini-embedding-001": 3072,
  "text-embedding-004": 768,
}
const FALLBACK_MAX_DIMENSIONS = 3072

export function isSupportedEmbeddingDimensions(n: number): n is EmbeddingDimensions {
  return (SUPPORTED_EMBEDDING_DIMENSIONS as readonly number[]).includes(n)
}

/** The instance's configured width (EMBEDDING_DIMENSIONS, default 768). */
export function configuredEmbeddingDimensions(): EmbeddingDimensions {
  const n = Number(env.EMBEDDING_DIMENSIONS)
  return isSupportedEmbeddingDimensions(n) ? n : DEFAULT_EMBEDDING_DIMENSIONS
}

/**
 * The width a model embeds at on this instance: the configured one, or null
 * when the model cannot produce it (text-embedding-004 stops at 768). Null
 * means that org searches keyword only, never that it writes a vector of
 * another width into the shared index.
 */
export function embeddingDimensionsFor(
  modelId: string,
  configured: number = configuredEmbeddingDimensions(),
): number | null {
  const max = MAX_DIMENSIONS_BY_MODEL[modelId] ?? FALLBACK_MAX_DIMENSIONS
  return configured <= max ? configured : null
}

/**
 * One provider vector at `dimensions`: the opening `dimensions` values, L2
 * normalised. Null for a vector shorter than that (or not a vector), which the
 * caller leaves out rather than storing.
 */
export function fitEmbedding(vector: unknown, dimensions: number): number[] | null {
  if (!Array.isArray(vector) || vector.length < dimensions) return null
  const cut = vector.length === dimensions ? (vector as number[]) : vector.slice(0, dimensions)
  let sumSquares = 0
  for (const v of cut) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null
    sumSquares += v * v
  }
  if (sumSquares === 0) return null
  const norm = Math.sqrt(sumSquares)
  return cut.map((v) => (v as number) / norm)
}

/** `fitEmbedding` over a batch, keeping positions (a misfit is left undefined). */
export function fitEmbeddings(vectors: unknown[], dimensions: number): number[][] {
  const out: number[][] = new Array(vectors.length)
  vectors.forEach((v, i) => {
    const fitted = fitEmbedding(v, dimensions)
    if (fitted) out[i] = fitted
  })
  return out
}
