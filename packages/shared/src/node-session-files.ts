// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FILES CHANGED (P2-T07; S8; S53, D29). What a node session changed, per
// file, from its Edit, MultiEdit and Write calls, subagents' included: each
// call is a hunk (lineDiff of the old and new text; a Write is all added).
// Only applied calls count: a call with no result yet (waiting on a
// permission) or an error result changed nothing. A call whose event was cut
// at 64 KB marks its file `cut`. Paths are shown relative to the session
// (displayPath), never absolute. Shared: the API computes the summary from
// every event (the web holds the main thread only, D29) and the web renders
// the same shapes.

import { type DiffLine, diffStats, lineDiff } from "./line-diff"
import { displayPath, type PathContext, relativizePaths } from "./node-session-paths"
import type { NodeSessionEvent } from "./node-session-protocol"

export interface FileChange {
  path: string
  added: number
  removed: number
  hunks: DiffLine[][]
  cut: boolean
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * The diff hunks one Edit, MultiEdit or Write call makes (empty for any other
 * tool). Each line's text is relativized: a diff is display text too.
 */
export function callHunks(name: string, input: unknown, ctx: PathContext): DiffLine[][] {
  return hunksOf(name, rec(input), ctx)
}

function hunksOf(name: string, input: Record<string, unknown>, ctx: PathContext): DiffLine[][] {
  return rawHunks(name, input).map((h) =>
    h.map((l) => ({ ...l, text: relativizePaths(l.text, ctx) })),
  )
}

function rawHunks(name: string, input: Record<string, unknown>): DiffLine[][] {
  switch (name) {
    case "Edit":
      return [lineDiff(str(input.old_string), str(input.new_string))]
    case "MultiEdit":
      return Array.isArray(input.edits)
        ? input.edits.map((e) => lineDiff(str(rec(e).old_string), str(rec(e).new_string)))
        : []
    case "Write":
      return [lineDiff("", str(input.content))]
    default:
      return []
  }
}

/** Per file, in the order first changed. */
export function filesChanged(
  events: readonly Pick<NodeSessionEvent, "seq" | "type" | "payload" | "truncated">[],
  ctx: PathContext,
): FileChange[] {
  // Walk D11: only an applied change counts, i.e. a call whose result came
  // back without an error. A call still waiting (on the owner's permission,
  // or mid-run) has changed nothing yet.
  const applied = new Set<string>()
  for (const e of events) {
    if (e.type === "tool_result" && e.payload.isError !== true) applied.add(str(e.payload.id))
  }
  const files = new Map<string, FileChange>()
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== "tool_call") continue
    const name = str(e.payload.name)
    if (name !== "Edit" && name !== "MultiEdit" && name !== "Write") continue
    if (!applied.has(str(e.payload.id))) continue
    const input = rec(e.payload.input)
    const raw = str(input.file_path)
    if (!raw) continue
    const path = displayPath(raw, ctx)
    const hunks = hunksOf(name, input, ctx).filter((h) => h.some((l) => l.type !== "same"))
    const file = files.get(path) ?? { path, added: 0, removed: 0, hunks: [], cut: false }
    for (const h of hunks) {
      const s = diffStats(h)
      file.added += s.added
      file.removed += s.removed
      file.hunks.push(h)
    }
    if (e.truncated) file.cut = true
    files.set(path, file)
  }
  return [...files.values()]
}

/** The session's working directory, when the start `system` event names it (P3 seam). */
export function sessionStartCwd(
  events: readonly Pick<NodeSessionEvent, "type" | "payload">[],
): string | null {
  for (const e of events) {
    if (e.type !== "system" || e.payload.subtype !== "start") continue
    const data = rec(e.payload.data)
    if (typeof data.cwd === "string" && data.cwd) return data.cwd
  }
  return null
}
