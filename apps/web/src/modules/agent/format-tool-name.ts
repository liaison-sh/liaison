// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE SPELLING OF A TOOL'S NAME, in a module of its own.
//
// It lived in `ToolCallRow.tsx` until P6d-T18. The local session's permission
// card names the same tools in the same rows and imports it, and ToolCallRow
// renders that card, so the two files imported each other: a cycle a bundler
// resolves by handing one of them a half-initialized module, which is the kind
// of failure that shows up as an undefined function at runtime and nowhere in
// a test.
//
// A pure function neither of them owns has no such problem, and a second
// formatter is how two surfaces start spelling one tool two ways.

/**
 * Formats a raw tool name like "kernel__user_memory_set" into "User Memory
 * Set". Strips the app prefix (everything before the first `__`), then
 * converts underscores to spaces and title-cases each word.
 */
export function formatToolName(raw: string): string {
  const withoutPrefix = raw.includes("__") ? raw.slice(raw.indexOf("__") + 2) : raw
  return withoutPrefix
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ")
}
