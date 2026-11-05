// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Minimal line-level diff (LCS) for rendering a git-style old -> new comparison
 * in the approval card and a node session's Files changed (web and API). No dependency: the inputs are bounded skill bodies (a
 * few KB), so an O(n*m) LCS over lines is cheap. A guard falls back to
 * "whole block replaced" for pathologically large inputs so a giant paste can
 * never lock the UI thread.
 */

export type DiffType = "same" | "add" | "del"
export interface DiffLine {
  type: DiffType
  text: string
}
/** A collapsed run of unchanged lines, rendered as a single "N unchanged" marker. */
export interface DiffGap {
  type: "gap"
  count: number
}
export type DiffRow = DiffLine | DiffGap

/** Above this combined line count we skip the O(n*m) LCS and just show the old
 *  block removed then the new block added. Correct, only non-minimal. */
const MAX_LINES = 4000

/** Line-level LCS diff. Returns one row per line in reading order. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length === 0 ? [] : oldText.split("\n")
  const b = newText.length === 0 ? [] : newText.split("\n")

  if (a.length + b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ]
  }

  const n = a.length
  const m = b.length
  // dp[i][j] = length of the LCS of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] })
      i++
    } else {
      out.push({ type: "add", text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] })
  while (j < m) out.push({ type: "add", text: b[j++] })
  return out
}

/** Count of added / removed lines, for the "+N -M" diff header. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === "add") added++
    else if (l.type === "del") removed++
  }
  return { added, removed }
}

/**
 * Collapse long runs of unchanged lines into a single `gap` marker, keeping
 * `context` lines on each side of every change — the git-hunk look. Runs at the
 * very start/end keep no leading/trailing context (nothing to anchor to).
 */
export function withCollapsedContext(lines: DiffLine[], context = 3): DiffRow[] {
  const rows: DiffRow[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== "same") {
      rows.push(lines[i])
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j].type === "same") j++
    const runLen = j - i
    const lead = i === 0 ? 0 : context
    const trail = j === lines.length ? 0 : context
    if (runLen <= lead + trail + 1) {
      for (let k = i; k < j; k++) rows.push(lines[k])
    } else {
      for (let k = i; k < i + lead; k++) rows.push(lines[k])
      rows.push({ type: "gap", count: runLen - lead - trail })
      for (let k = j - trail; k < j; k++) rows.push(lines[k])
    }
    i = j
  }
  return rows
}
