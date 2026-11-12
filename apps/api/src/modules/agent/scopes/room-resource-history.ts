// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ROOM FLOOR REACHES A SHARED RESOURCE IN THE HISTORY TOO (scope-taint.ts, rule 15e).
//
// A turn replays the earlier turns of its conversation, their tool calls and results included.
// A read of a dashboard table made while everyone in the room could read it (or in a direct
// message with the agent, before someone was added) carries the table's cells in its stored
// result, and the answer that followed may quote them. Once someone who may not read the table is
// in the room, a later turn must not see those cells, just as it does not see a row stamped with
// a scope the room floor took away (context.ts, filterByVisibility). So the message holding such
// a read leaves the history: judged per stored call, by the tool's own declaration (its
// `readsFromTable` is a shareable resource type, its arguments name the resource) against the
// resource's readers NOW. A call that failed read nothing and is kept.

import { roomWithheldResourceRead } from "~/modules/agent/scopes/taint-approval-audience"
import { canonicalToolNamesBySdkName } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { targetRowIds } from "./scope-taint"

interface StoredToolCall {
  toolName?: unknown
  args?: unknown
  status?: unknown
}

/** `rows` without the messages whose stored reads reached a resource some of `roomPeople` may not read. */
export async function withoutRoomWithheldResourceReads<T extends { metadata?: unknown }>(
  orgId: string,
  rows: T[],
  roomPeople: readonly string[],
): Promise<T[]> {
  let canonicalBySdkName: Map<string, string> | undefined
  const kept: T[] = []
  for (const row of rows) {
    const calls = (row.metadata as { toolCalls?: unknown } | null)?.toolCalls
    let withheld = false
    if (Array.isArray(calls)) {
      for (const tc of calls as StoredToolCall[]) {
        if (typeof tc?.toolName !== "string" || tc.status === "error") continue
        if (!tc.toolName.includes(":") && canonicalBySdkName === undefined) {
          canonicalBySdkName = canonicalToolNamesBySdkName(orgId)
        }
        const canonical = tc.toolName.includes(":")
          ? tc.toolName
          : canonicalBySdkName?.get(tc.toolName)
        const idx = canonical?.indexOf(":") ?? -1
        if (!canonical || idx <= 0) continue
        const tool = toolRegistry.get([orgId, canonical.slice(0, idx), canonical.slice(idx + 1)])
        if (typeof tool?.readsFromTable !== "string") continue
        const scope = await roomWithheldResourceRead({
          orgId,
          resourceType: tool.readsFromTable,
          resourceIds: targetRowIds(tool, tc.args),
          roomPeople,
        })
        if (scope !== null) {
          withheld = true
          break
        }
      }
    }
    if (!withheld) kept.push(row)
  }
  return kept
}
