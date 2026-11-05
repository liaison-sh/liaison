// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The composer's level note (S46, D11): "Raised to Standard: the session
// restarts at the end of this step" is true only until a run reports the new
// level. It is derived from the session's events and state, never from a
// local one-shot flag.

export interface LevelNoteEvent {
  seq: number
  type: string
  payload?: Record<string, unknown>
}

/** The level the owner last asked for, and the last event seq held when they asked. */
export interface LevelRequest {
  level: string
  afterSeq: number
}

/** The level an event reports: `level_changed.to`, or a run's `system` start line. */
function reportedLevel(e: LevelNoteEvent): unknown {
  if (e.type === "level_changed") return e.payload?.to
  if (e.type === "system") {
    const data = e.payload?.data as { level?: unknown } | undefined
    return data?.level
  }
  return undefined
}

/** "pending" while the requested level is not yet reported and the session is live. */
export function levelNoteState(
  events: readonly LevelNoteEvent[],
  request: LevelRequest | null,
  state: string,
): "pending" | "none" {
  if (!request) return "none"
  if (state !== "running" && state !== "waiting") return "none"
  const applied = events.some((e) => e.seq > request.afterSeq && reportedLevel(e) === request.level)
  return applied ? "none" : "pending"
}
