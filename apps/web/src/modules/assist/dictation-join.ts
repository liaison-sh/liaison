// SPDX-License-Identifier: FSL-1.1-ALv2
//
// JOINING A LONG TAKE'S PIECES. Consecutive segments overlap by about a second
// of audio (dictation-recorder.ts), so the words of that second come back at
// the end of one piece and the start of the next. The join drops the repeat:
// the longest run of tokens that ends one piece and starts the next, compared
// without case or punctuation, never more than MAX_OVERLAP_TOKENS (a second
// of speech is two or three words; a longer match is speech said twice).

/** The most tokens one seam may drop. */
export const MAX_OVERLAP_TOKENS = 8

function comparable(token: string): string {
  return token.toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, "")
}

/** How many leading tokens of `next` repeat the trailing tokens of `prev`. */
function overlapOf(prev: string[], next: string[]): number {
  const most = Math.min(MAX_OVERLAP_TOKENS, prev.length, next.length)
  for (let k = most; k > 0; k--) {
    let same = true
    for (let i = 0; i < k && same; i++) {
      same = comparable(prev[prev.length - k + i] as string) === comparable(next[i] as string)
    }
    if (same) return k
  }
  return 0
}

/** The pieces of one take, in order, as one text with each seam's repeat dropped. */
export function joinTranscripts(pieces: string[]): string {
  const tokens: string[] = []
  for (const piece of pieces) {
    const next = piece.trim().split(/\s+/).filter(Boolean)
    if (next.length === 0) continue
    tokens.push(...next.slice(overlapOf(tokens, next)))
  }
  return tokens.join(" ")
}
