// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure tool-id helpers, importable from anywhere without the approvals
// event layer (database, threads) coming along.

export function splitToolName(toolName: string): { appName: string; toolShortName: string } {
  const idx = toolName.indexOf(":")
  if (idx === -1) return { appName: toolName, toolShortName: "" }
  return { appName: toolName.slice(0, idx), toolShortName: toolName.slice(idx + 1) }
}

/**
 * Human-readable action title derived from a raw tool id, for surfaces that
 * have no author-supplied summary (attention tiles, digests). A tool id like
 * "invoicing:documents_mark_paid" must never reach user copy verbatim; this
 * turns it into "Invoicing: mark document paid" (app name, then the verb words
 * with the pluralised entity noun singularised so it reads as an imperative).
 * Deterministic and side-effect-free so it can back a fallback anywhere.
 */
export function humanizeToolName(toolName: string): string {
  const { appName, toolShortName } = splitToolName(toolName)
  const appLabel = appDisplayName(appName)
  if (!toolShortName) return appLabel
  const words = toolShortName.split(/[_.]+/).filter(Boolean)
  if (words.length === 0) return appLabel
  // A leading plural entity noun ("documents", "orders") reads better as an
  // imperative when the verb moves first: "documents_mark_paid" -> "mark
  // document paid". Detect the common `<entity>_<verb>...` shape and reorder.
  const KNOWN_VERBS = new Set([
    "create",
    "issue",
    "mark",
    "send",
    "update",
    "delete",
    "cancel",
    "record",
    "convert",
    "assign",
    "close",
    "reply",
    "refund",
    "approve",
    "reject",
  ])
  let ordered = words
  if (words.length >= 2 && !KNOWN_VERBS.has(words[0]!) && KNOWN_VERBS.has(words[1]!)) {
    ordered = [words[1]!, singularise(words[0]!), ...words.slice(2)]
  }
  const phrase = ordered.join(" ").toLowerCase()
  return `${appLabel}: ${phrase}`
}

/**
 * The name a person reads for an app id. The kernel's own actions (skills,
 * roles, contacts) belong to the workspace, not to an app called "Kernel":
 * the same word the web client's catalog uses (`kernel.capabilities.apps.kernel`).
 */
function appDisplayName(appName: string): string {
  if (appName === "kernel") return "Workspace"
  return titleCaseWords(appName)
}

function titleCaseWords(s: string): string {
  return s
    .split(/[_.\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function singularise(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.endsWith("ses")) return word.slice(0, -2)
  // "status" is not the plural of "statu" — an -us noun is already singular.
  // (projects:status_update humanized to "update statu" on every approval
  // row and facet chip.)
  if (word.endsWith("us") || word.endsWith("ss")) return word
  if (word.endsWith("s")) return word.slice(0, -1)
  return word
}
