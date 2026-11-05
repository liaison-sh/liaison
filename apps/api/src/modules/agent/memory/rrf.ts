// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reciprocal rank fusion, k = 60 (P4c-T48).
//
// MOVED FROM THE BENCH, NOT REWRITTEN. The long-context bench
// (`tests/bench/long-context/rrf.ts`) measured the hybrid strategies with this
// exact arithmetic and this exact constant; production now fuses its legs with
// the same function rather than a second copy that could drift from the numbers
// the bench reported. A document's score is the sum of `1 / (k + rank)` over
// every leg it appears in, ranks one based.
//
// WHY k = 60. It is the constant the original RRF paper reports and the one
// Knowledge's federated fusion already uses; changing it is a measured
// decision, not a tuning knob.
//
// TIE BREAK. Two documents with the same fused score keep their FIRST SEEN
// order (leg order, then rank inside the leg), which makes the fusion stable
// and its tests deterministic. A caller that needs a different tie break (the
// memory legs order equal scores by key, so a fused list does not depend on
// which leg happened to run first) passes its own comparator.

export const RRF_K = 60

/** The minimum a fusable document must carry: an identity to fuse on. */
export interface RrfDoc {
  docId: string
}

export interface FuseOptions<T extends RrfDoc> {
  /** The fusion constant. Defaults to `RRF_K`. */
  k?: number
  /**
   * Comparator applied to documents whose fused scores are equal. Defaults to
   * first-seen order.
   */
  tieBreak?: (a: T, b: T) => number
}

/**
 * Fuse ranked lists. Pure: no index, no database, no clock behind it, so the
 * constant and the arithmetic are testable on their own.
 */
export function fuse<T extends RrfDoc>(
  lists: T[][],
  options: FuseOptions<T> = {},
): Array<T & { score: number }> {
  const k = options.k ?? RRF_K
  const scores = new Map<string, number>()
  const byId = new Map<string, T>()
  const firstSeen = new Map<string, number>()
  let order = 0
  for (const list of lists) {
    list.forEach((hit, index) => {
      scores.set(hit.docId, (scores.get(hit.docId) ?? 0) + 1 / (k + index + 1))
      if (!byId.has(hit.docId)) {
        byId.set(hit.docId, hit)
        firstSeen.set(hit.docId, order++)
      }
    })
  }
  const tieBreak =
    options.tieBreak ??
    ((a: T, b: T) => (firstSeen.get(a.docId) ?? 0) - (firstSeen.get(b.docId) ?? 0))
  return [...scores.entries()]
    .map(([docId, score]) => ({ ...(byId.get(docId) as T), score }))
    .sort((a, b) => b.score - a.score || tieBreak(a, b))
}

/**
 * Cosine similarity of two vectors. Lives here because both consumers of the
 * fusion (the vector leg's diversity pass and the near-duplicate clusterer)
 * need the same measure, and a second copy is a second thing to get wrong.
 * Zero for a zero vector, never NaN.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** The diversity/relevance trade-off of the MMR pass. 1 is pure relevance. */
export const MMR_LAMBDA = 0.7

/**
 * Maximal marginal relevance over an already ranked list: repeatedly take the
 * candidate maximising `lambda * relevance - (1 - lambda) * maxSimilarityToPicked`.
 *
 * Relevance is the candidate's rank in the incoming list, normalised to
 * `[0, 1]`, NOT its fused score: fused scores live in a narrow band around
 * `1/60` and a raw-score MMR would be pure diversity in practice.
 *
 * A candidate with no vector is never penalised for similarity it cannot be
 * measured on (a document indexed before the backfill reached it), so the pass
 * degrades to plain ranking rather than to arbitrary reordering.
 */
export function mmr<T>(
  candidates: T[],
  vectorOf: (item: T) => readonly number[] | null | undefined,
  limit: number,
  lambda: number = MMR_LAMBDA,
): T[] {
  const picked: T[] = []
  const rest = [...candidates]
  const span = Math.max(1, candidates.length - 1)
  const relevance = new Map<T, number>()
  for (let i = 0; i < candidates.length; i++) {
    relevance.set(candidates[i] as T, 1 - i / span)
  }

  while (picked.length < Math.min(limit, candidates.length) && rest.length > 0) {
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let i = 0; i < rest.length; i++) {
      const item = rest[i] as T
      const vector = vectorOf(item)
      let maxSim = 0
      if (vector) {
        for (const chosen of picked) {
          const other = vectorOf(chosen)
          if (other) maxSim = Math.max(maxSim, cosine(vector, other))
        }
      }
      const score = lambda * (relevance.get(item) ?? 0) - (1 - lambda) * maxSim
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    picked.push(rest[bestIndex] as T)
    rest.splice(bestIndex, 1)
  }
  return picked
}
