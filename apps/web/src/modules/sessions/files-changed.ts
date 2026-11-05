// SPDX-License-Identifier: FSL-1.1-ALv2
// FILES CHANGED: shared with the API, which serves the summary from every
// event, subagents included (S53, D29). See @liaison/shared node-session-files.
import { type FileChange, filesChanged, type NodeSessionEvent } from "@liaison/shared"

export { callHunks, type FileChange, filesChanged } from "@liaison/shared"

type PathContext = Parameters<typeof filesChanged>[1]

/**
 * The client's own Files changed, for an API without the summary (batch-4
 * F7): from the held events, skipping every call whose input was elided (S56:
 * its content and strings are blanked, so its +/- and hunks would be wrong).
 */
export function clientFilesChanged(
  events: readonly NodeSessionEvent[],
  ctx: PathContext,
): FileChange[] {
  const whole = events.filter((e) => !(e.type === "tool_call" && e.payload?.inputElided))
  return filesChanged(whole, ctx)
}
