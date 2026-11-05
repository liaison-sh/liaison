// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reciprocal rank fusion, k = 60, the same constant production fuses its legs
// with (`memory-search.ts:34`).
import type { Hit } from "./types"

export const RRF_K = 60

/** Fuse ranked lists. A document's score is the sum of 1/(k + rank) per leg. */
export function fuse(lists: Hit[][], k = RRF_K): Hit[] {
  const scores = new Map<string, number>()
  const byId = new Map<string, Hit>()
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
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .map(([docId, score]) => ({ ...(byId.get(docId) as Hit), score }))
}
