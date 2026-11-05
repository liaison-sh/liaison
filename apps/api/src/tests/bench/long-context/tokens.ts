// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bench's token ruler. chars/4, the same estimator production compaction
// uses (`compaction.ts:85`), reimplemented here so the bench tree imports no
// database bound module.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Cut a text to a token budget on a character boundary. */
export function clipToTokens(text: string, budget: number): string {
  const maxChars = budget * 4
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}
