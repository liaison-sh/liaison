// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THREE-WAY MERGE OF A PAGE'S TEXT. Two people edited the same page from the same
// stored text (the base); the second save meets the first. When their edits touch
// different blocks, both are kept and nobody is asked. When they changed the same
// block differently, the merge is refused and the person chooses (ConflictDialog).
//
// A block is one line of the page's markdown as the editor writes it (a paragraph, a
// heading, a list item, a to-do, a table row, a blank separator), except a fenced code
// block, which is one block from its opening fence to its closing one. Nothing in a
// merged text is invented: every block comes from the base, mine or theirs.

/** A page's text: its title and its markdown. */
export interface MergeText {
  title: string
  body: string
}

/** Past this many block comparisons the merge is not tried (the person chooses). */
const MAX_CELLS = 16_000_000

/** The page's markdown cut into blocks (see the header). */
export function blocksOf(body: string): string[] {
  const lines = body.split("\n")
  const out: string[] = []
  let fence: { marker: string; lines: string[] } | null = null
  for (const line of lines) {
    if (fence) {
      fence.lines.push(line)
      if (line.trimStart().startsWith(fence.marker)) {
        out.push(fence.lines.join("\n"))
        fence = null
      }
      continue
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line)
    if (open) {
      fence = { marker: open[1]!, lines: [line] }
      continue
    }
    out.push(line)
  }
  // An unclosed fence runs to the end of the text, as markdown reads it.
  if (fence) out.push(fence.lines.join("\n"))
  return out
}

/** One side's change: base blocks [start, end) became `blocks`. */
interface Hunk {
  side: "mine" | "theirs"
  start: number
  end: number
  blocks: string[]
}

/** The changes from `base` to `next`, as hunks over base positions (an LCS diff). */
function hunksOf(base: string[], next: string[], side: Hunk["side"]): Hunk[] | null {
  let pre = 0
  while (pre < base.length && pre < next.length && base[pre] === next[pre]) pre++
  let suf = 0
  while (
    suf < base.length - pre &&
    suf < next.length - pre &&
    base[base.length - 1 - suf] === next[next.length - 1 - suf]
  )
    suf++
  const a = base.slice(pre, base.length - suf)
  const b = next.slice(pre, next.length - suf)
  if (a.length === 0 && b.length === 0) return []
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const w = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | null = null
  const close = () => {
    if (open) hunks.push(open)
    open = null
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close()
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      open ??= { side, start: pre + i, end: pre + i, blocks: [] }
      open.blocks.push(b[j]!)
      j++
    } else {
      open ??= { side, start: pre + i, end: pre + i, blocks: [] }
      open.end = pre + i + 1
      i++
    }
  }
  close()
  return hunks
}

/** Whether two hunks of different sides touch the same base blocks. */
function clash(x: Hunk, y: Hunk): boolean {
  const xIns = x.start === x.end
  const yIns = y.start === y.end
  if (xIns && yIns) return x.start === y.start
  if (xIns) return y.start < x.start && x.start < y.end
  if (yIns) return x.start < y.start && y.start < x.end
  return x.start < y.end && y.start < x.end
}

/** One side's text for base blocks [start, end), with its hunks in that range applied. */
function sideText(base: string[], hunks: Hunk[], start: number, end: number): string[] {
  const out: string[] = []
  let at = start
  for (const h of hunks) {
    out.push(...base.slice(at, h.start), ...h.blocks)
    at = h.end
  }
  out.push(...base.slice(at, end))
  return out
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, k) => v === y[k])

/**
 * Both edits of `base`'s markdown, or null when they changed the same block
 * differently (or the page is too long to compare). Edits at the same place that add
 * blocks without changing any (two new paragraphs at the end) are both kept, theirs
 * first: they saved first.
 */
export function mergeBodies(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs) return mine
  if (mine === base) return theirs
  if (theirs === base) return mine
  const b = blocksOf(base)
  const m = hunksOf(b, blocksOf(mine), "mine")
  const t = hunksOf(b, blocksOf(theirs), "theirs")
  if (!m || !t) return null
  const all = [...t, ...m].sort((x, y) => x.start - y.start || x.end - y.end)
  const out: string[] = []
  let at = 0
  let k = 0
  while (k < all.length) {
    // A group: hunks that clash with one another, transitively.
    const group = [all[k]!]
    let start = all[k]!.start
    let end = all[k]!.end
    k++
    while (k < all.length && group.some((g) => clash(g, all[k]!))) {
      start = Math.min(start, all[k]!.start)
      end = Math.max(end, all[k]!.end)
      group.push(all[k]!)
      k++
    }
    out.push(...b.slice(at, start))
    at = end
    const mineHunks = group.filter((g) => g.side === "mine")
    const theirHunks = group.filter((g) => g.side === "theirs")
    if (mineHunks.length === 0 || theirHunks.length === 0) {
      out.push(...sideText(b, group, start, end))
      continue
    }
    const mineText = sideText(b, mineHunks, start, end)
    const theirText = sideText(b, theirHunks, start, end)
    if (same(mineText, theirText)) {
      out.push(...mineText)
      continue
    }
    // Both added blocks at the same place without touching any: both kept.
    if (start === end && group.every((g) => g.start === g.end)) {
      out.push(...theirText, ...mineText)
      continue
    }
    return null
  }
  out.push(...b.slice(at))
  return out.join("\n")
}

/** Both titles: one side's rename is kept; two different renames do not merge. */
export function mergeTitles(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs || mine === base) return theirs
  if (theirs === base) return mine
  return null
}

/** Both edits of a page, or null when they cannot both be kept. */
export function mergeTexts(base: MergeText, mine: MergeText, theirs: MergeText): MergeText | null {
  const title = mergeTitles(base.title, mine.title, theirs.title)
  if (title === null) return null
  const body = mergeBodies(base.body, mine.body, theirs.body)
  if (body === null) return null
  return { title, body }
}
