// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX1: WHAT THE SESSION IS DOING, out of the protocol lines that say so.
//
// The rows the page renders used to be built in `bridge.ts` from a line shaped
// `{ type: "tool_use", id, toolName, summary }`. The sidecar emits no such
// line. Every tool call arrives as `{ type: "message", event: "tool_use", payload }`
// with the blocks inside the SDK message the line carries
// (`sidecar-ipc-contract.md`), which is exactly what the overlay's own pane
// already read. So the bridge matched nothing and the activity rows were dead
// in the product, green against a fake bridge that pushed the state directly.
//
// It is a MODULE rather than a method on either side because both readers need
// it and one of them (`ToolActivityPane`) is deleted by P6d-T16a: a helper that
// lives inside a component about to be removed is a helper about to be
// duplicated.
//
// Pure: rows in, rows out. No store, no component, no subscription.

import type { DesktopToolActivity } from "@liaison/web/lib/desktop-shell-contract"
import type { SidecarEvent } from "./sidecar-client"

/** How much of the argument summary one line shows before it is cut. */
export const ARGUMENT_SUMMARY_LIMIT = 80

/** One content block of an SDK message, as far as a row cares. */
export interface ToolContentBlock {
  type?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
}

/** Whether this line carries tool blocks at all. */
export function isToolEvent(event: SidecarEvent): boolean {
  return event.type === "message" && (event.event === "tool_use" || event.event === "tool_result")
}

export function toolBlocksOf(event: SidecarEvent): ToolContentBlock[] {
  const payload = event.payload as { message?: { content?: unknown } } | undefined
  const content = payload?.message?.content
  return Array.isArray(content) ? (content as ToolContentBlock[]) : []
}

/** `command: ls, timeout: 5000`, cut at the limit. One line, always. */
export function summarizeArguments(input: Record<string, unknown> | undefined): string {
  const parts = Object.entries(input ?? {}).map(([name, value]) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value)
    return `${name}: ${rendered}`
  })
  const line = parts.join(", ").replace(/\s+/g, " ")
  return line.length > ARGUMENT_SUMMARY_LIMIT ? `${line.slice(0, ARGUMENT_SUMMARY_LIMIT)}...` : line
}

/**
 * The rows after this line, keyed by the SDK's own `tool_use` id.
 *
 * A `tool_result` UPDATES the row its `tool_use_id` names rather than
 * appending a second one, and nothing ever moves: a tool that finished fast
 * must not jump ahead of the one that started before it, or the reader cannot
 * tell what caused what. A result carrying `is_error` is a FAILED tool and
 * says so: reporting it as completed is the one wrong answer here, because the
 * turn that follows makes no sense next to a row claiming the tool worked.
 */
export function applyToolEvent(
  rows: DesktopToolActivity[],
  event: SidecarEvent,
  now: number = Date.now(),
): DesktopToolActivity[] {
  let next = rows
  for (const block of toolBlocksOf(event)) {
    if (block.type === "tool_use" && block.id) {
      const id = block.id
      const toolName = typeof block.name === "string" && block.name ? block.name : "tool"
      const existing = next.findIndex((row) => row.id === id)
      const row: DesktopToolActivity = {
        id,
        toolName,
        summary: summarizeArguments(block.input) || toolName,
        status: "running",
        // A second `tool_use` for an id already on screen is the same call
        // being re-reported, never a new one: it keeps the moment it began.
        startedAt: existing >= 0 ? next[existing].startedAt : now,
      }
      next =
        existing >= 0 ? next.map((old, index) => (index === existing ? row : old)) : [...next, row]
      continue
    }
    if (block.type === "tool_result" && block.tool_use_id) {
      const status: DesktopToolActivity["status"] = block.is_error ? "error" : "done"
      next = next.map((row) => (row.id === block.tool_use_id ? { ...row, status } : row))
    }
  }
  return next
}

/**
 * The tools whose call WRITES a file, by the name the SDK reports, lowercased.
 *
 * A closed list rather than a guess at the shape of an input: every other tool
 * that happens to carry a path (`Read`, `Grep`) names a file it did not make,
 * and offering one of those as "a file this session produced" is a lie the
 * user cannot check.
 */
const FILE_WRITING_TOOLS = new Set(["write", "create", "edit", "multiedit", "notebookedit"])

/** The input keys those tools name their target with. */
const PATH_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path"] as const

/** The bare tool name, with any MCP server prefix (`mcp__server__write`) cut. */
function bareToolName(name: string): string {
  const parts = name.split("__")
  return (parts[parts.length - 1] ?? name).toLowerCase()
}

/** Whether `path` is the folder itself or something inside it. */
export function isInsideFolder(path: string, folder: string): boolean {
  if (!folder) return false
  const base = folder.endsWith("/") ? folder.slice(0, -1) : folder
  return path === base || path.startsWith(`${base}/`)
}

/**
 * THE FILES THIS LINE SAYS THE SESSION WROTE (P6d-FX8).
 *
 * `noteProducedFile` had exactly one caller, a test, so `producedFiles` was
 * empty for the whole life of every real session and the attach control, which
 * renders nothing for an empty list, could not mount in the shipped app. The
 * stream is the only place a running session says it wrote anything, so it is
 * read here: the write-shaped tools only, the path exactly as the call gave it,
 * and only under the folder the session runs in, which is also the only place
 * the shell will read a file back from (`read_local_file`,
 * `OutsideSessionFolder`). Offering a path the shell would refuse is offering
 * a file that is not there.
 */
export function producedFilePathsOf(event: SidecarEvent, folder: string | null): string[] {
  if (!folder) return []
  const paths: string[] = []
  for (const block of toolBlocksOf(event)) {
    if (block.type !== "tool_use") continue
    const name = typeof block.name === "string" ? block.name : ""
    if (!FILE_WRITING_TOOLS.has(bareToolName(name))) continue
    for (const key of PATH_KEYS) {
      const value = block.input?.[key]
      if (typeof value !== "string" || !value.trim()) continue
      const path = value.trim()
      if (isInsideFolder(path, folder)) paths.push(path)
      break
    }
  }
  return paths
}
