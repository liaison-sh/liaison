// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared PDF text layout: Helvetica AFM width tables, measured width, greedy wrapping and
// run-aware wrapping (a run keeps its color/weight across line breaks). Ported from the
// invoicing templates so host-rendered documents wrap identically; the invoicing copy is
// untouched and a parity test pins the two together.

const HELV_WIDTHS: Record<string, number> = {
  " ": 278,
  "!": 278,
  '"': 355,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 667,
  "'": 191,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 278,
  ";": 278,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 556,
  "@": 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 278,
  "\\": 278,
  "]": 278,
  "^": 469,
  _: 556,
  "`": 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  "{": 334,
  "|": 260,
  "}": 334,
  "~": 584,
}

const HELV_BOLD_WIDTHS: Record<string, number> = {
  " ": 278,
  "!": 333,
  '"': 474,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 722,
  "'": 238,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 333,
  ";": 333,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 611,
  "@": 975,
  A: 722,
  B: 722,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 556,
  K: 722,
  L: 611,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 333,
  "\\": 278,
  "]": 333,
  "^": 584,
  _: 556,
  "`": 333,
  a: 556,
  b: 611,
  c: 556,
  d: 611,
  e: 556,
  f: 333,
  g: 611,
  h: 611,
  i: 278,
  j: 278,
  k: 556,
  l: 278,
  m: 889,
  n: 611,
  o: 611,
  p: 611,
  q: 611,
  r: 389,
  s: 556,
  t: 333,
  u: 611,
  v: 556,
  w: 778,
  x: 556,
  y: 556,
  z: 500,
  "{": 389,
  "|": 280,
  "}": 389,
  "~": 584,
}

const DEFAULT_CHAR_WIDTH = 556
/** One em, the advance of a CJK ideograph or kana. */
const FULL_WIDTH_CHAR_WIDTH = 1000

/** True for CJK / full-width code points, which advance about one em. */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60)
  )
}

/** Measured text width in points, using real Helvetica AFM metrics. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD_WIDTHS : HELV_WIDTHS
  let units = 0
  for (const ch of text) {
    const known = table[ch]
    if (known !== undefined) units += known
    else units += isFullWidth(ch.codePointAt(0) ?? 0) ? FULL_WIDTH_CHAR_WIDTH : DEFAULT_CHAR_WIDTH
  }
  return (units / 1000) * size
}

/**
 * Greedy word-wrap by MEASURED width (not a character-count budget). Breaks
 * a single word wider than `maxWidth` by character so ultra-long tokens
 * (a 500-char run with no whitespace) still terminate.
 */
export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  if (!text) return [""]
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let cur = ""

  const pushWord = (word: string) => {
    // A single word wider than maxWidth on its own: break by character.
    if (textWidth(word, size, bold) > maxWidth) {
      // The line already in progress comes first, then the word's chunks.
      if (cur) {
        lines.push(cur)
        cur = ""
      }
      let chunk = ""
      for (const ch of word) {
        const candidate = chunk + ch
        if (textWidth(candidate, size, bold) > maxWidth && chunk) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk = candidate
        }
      }
      if (chunk) cur = chunk
      return
    }
    const candidate = cur ? `${cur} ${word}` : word
    if (textWidth(candidate, size, bold) <= maxWidth) {
      cur = candidate
    } else {
      if (cur) lines.push(cur)
      cur = word
    }
  }

  for (const word of words) pushWord(word)
  if (cur) lines.push(cur)
  return lines.length > 0 ? lines : [""]
}

/** A styled stretch of text inside a paragraph. */
export interface TextRun {
  text: string
  /** Opaque to the layout; carried through to every line piece the run produces. */
  color?: string
  bold?: boolean
}

/** One drawn piece of a wrapped line: a run fragment with its own style. */
export interface LinePiece {
  text: string
  color?: string
  bold: boolean
}

/**
 * Greedy word-wrap across styled runs. Words are measured with the table of their own run
 * (bold uses the bold table); a run keeps its color and weight on every line it spans.
 * A single word wider than `maxWidth` is broken by character, like `wrapText`. Adjacent
 * runs with no whitespace between them stay glued (a placeholder directly after a word).
 * Each line is a list of pieces; consecutive pieces of the same style are merged, and the
 * single space joining two words is placed inside the earlier piece. Empty input gives one
 * empty line.
 */
export function wrapRuns(runs: readonly TextRun[], maxWidth: number, size: number): LinePiece[][] {
  interface Atom {
    text: string
    color?: string
    bold: boolean
  }
  // Split into words; a word is a list of atoms (one per run it touches).
  const words: Atom[][] = []
  let word: Atom[] = []
  const flush = () => {
    if (word.length > 0) words.push(word)
    word = []
  }
  for (const run of runs) {
    const bold = run.bold === true
    for (const part of run.text.split(/(\s+)/)) {
      if (part === "") continue
      if (/^\s+$/.test(part)) flush()
      else word.push({ text: part, color: run.color, bold })
    }
  }
  flush()
  if (words.length === 0) return [[]]

  const atomWidth = (a: Atom) => textWidth(a.text, size, a.bold)
  const wordWidth = (w: Atom[]) => w.reduce((s, a) => s + atomWidth(a), 0)
  const spaceWidth = (bold: boolean) => textWidth(" ", size, bold)

  const lines: LinePiece[][] = []
  let cur: LinePiece[] = []
  let curWidth = 0

  const append = (list: LinePiece[], text: string, color: string | undefined, bold: boolean) => {
    const last = list[list.length - 1]
    if (last && last.color === color && last.bold === bold) last.text += text
    else list.push({ text, color, bold })
  }
  const endLine = () => {
    lines.push(cur)
    cur = []
    curWidth = 0
  }

  for (const w of words) {
    const ww = wordWidth(w)
    if (ww > maxWidth) {
      // Break by character, starting on a fresh line when the current one has content.
      if (cur.length > 0) endLine()
      for (const atom of w) {
        for (const ch of atom.text) {
          const cw = textWidth(ch, size, atom.bold)
          if (curWidth + cw > maxWidth && cur.length > 0) endLine()
          append(cur, ch, atom.color, atom.bold)
          curWidth += cw
        }
      }
      continue
    }
    const lead = w[0]
    const gap = cur.length > 0 && lead ? spaceWidth(lead.bold) : 0
    if (cur.length > 0 && curWidth + gap + ww > maxWidth) endLine()
    else if (cur.length > 0 && lead) {
      append(cur, " ", lead.color, lead.bold)
      curWidth += gap
    }
    for (const atom of w) {
      append(cur, atom.text, atom.color, atom.bold)
      curWidth += atomWidth(atom)
    }
  }
  if (cur.length > 0) lines.push(cur)
  return lines
}
