// SPDX-License-Identifier: FSL-1.1-ALv2
// A search snippet cut into the parts the query's words match (shown marked) and the
// rest, accents and case aside. Plain text parts: nothing is ever read as HTML.

export interface HighlightPart {
  text: string
  match: boolean
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

export function highlighted(text: string, query: string): HighlightPart[] {
  const words = fold(query)
    .split(/\s+/)
    .filter((w) => w.length > 1)
  const folded = fold(text)
  // Folding changed the length: offsets would not map back, so nothing is marked.
  if (words.length === 0 || folded.length !== text.length) return [{ text, match: false }]
  const marks = new Array<boolean>(text.length).fill(false)
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length))
      marks.fill(true, at, at + w.length)
  }
  const parts: HighlightPart[] = []
  for (let i = 0; i < text.length; ) {
    let j = i
    while (j < text.length && marks[j] === marks[i]) j++
    parts.push({ text: text.slice(i, j), match: marks[i] ?? false })
    i = j
  }
  return parts
}
