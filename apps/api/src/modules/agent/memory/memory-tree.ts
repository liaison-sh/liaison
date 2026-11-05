// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The memory tree: an `agent_memory` row seen as the plain Markdown file the
 * model and the humans read, and back again.
 *
 * The file is a YAML frontmatter block RENDERED from the row's columns
 * followed by the stored `content` as the Markdown body. Parsing a written
 * file puts the frontmatter BACK into the columns, so the columns stay the
 * source of truth for RLS and scopes: a body that claims a wider
 * `requiredScopes` about itself changes nothing, because only the first
 * frontmatter block is ever read.
 *
 * This module is PURE. It touches no database, so every path guard and every
 * rendering rule is unit testable without an RLS context.
 */
import { isLegalMemoryPath, MEMORY_INDEX_PATH } from "@liaison/shared"

/** The root every agent's tree hangs from, as the model sees it. */
export function memoryRoot(handle: string): string {
  return `/memories/${normalizeHandle(handle)}/`
}

/** Handles are stored with a leading `@`; paths never carry it. */
function normalizeHandle(handle: string): string {
  return handle.startsWith("@") ? handle.slice(1) : handle
}

export interface MemoryRowLike {
  type: string
  name: string
  path?: string | null
}

export interface MemoryFileRow extends MemoryRowLike {
  description: string
  content: string
  requiredScopes: string[]
  updatedAt: Date | string
  sourceThreadId?: string | null
  sourceMessageId?: string | null
  supersedesId?: string | null
}

export interface MemoryFile {
  path: string
  body: string
}

export interface ParsedMemoryFile {
  path: string
  type: string
  name: string
  description: string
  content: string
  requiredScopes: string[]
  sources: string[]
  supersedes: string | null
  modified: string | null
}

/** `MEMORY.md` for the reserved index row, `<type>/<name>.md` for the rest. */
export function pathForRow(row: MemoryRowLike): string {
  if (row.path) return row.path
  if (row.type === "_index" || row.name === "_index") return MEMORY_INDEX_PATH
  return `${row.type}/${row.name}.md`
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().slice(0, 10)
}

function sourcesForRow(row: MemoryFileRow): string[] {
  const sources: string[] = []
  if (row.sourceThreadId) sources.push(`thread:${row.sourceThreadId}`)
  if (row.sourceMessageId) sources.push(`message:${row.sourceMessageId}`)
  return sources
}

/** A YAML scalar that cannot be mistaken for a structure or a comment. */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

function yamlList(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(",")}]`
}

/** The file the model reads: frontmatter from the columns, content as body. */
export function rowToFile(row: MemoryFileRow): MemoryFile {
  const frontmatter = [
    "---",
    `name: ${row.name}`,
    `description: ${yamlScalar(row.description)}`,
    `type: ${row.type}`,
    `modified: ${isoDate(row.updatedAt)}`,
    `requiredScopes: ${yamlList(row.requiredScopes)}`,
    `sources: ${yamlList(sourcesForRow(row))}`,
    `supersedes: ${row.supersedesId ? yamlScalar(row.supersedesId) : "null"}`,
    "---",
    "",
  ].join("\n")
  return { path: pathForRow(row), body: `${frontmatter}${row.content}` }
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === "string" ? parsed : trimmed
    } catch {
      return trimmed
    }
  }
  return trimmed
}

function parseList(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("[")) return trimmed === "" ? [] : [trimmed]
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

/**
 * Parse a written file back into the columns. ONLY the first frontmatter block
 * is read: everything after the closing fence is body, however much it looks
 * like frontmatter, which is what stops a body from declaring its own scopes.
 */
export function fileToRow(path: string, body: string): ParsedMemoryFile {
  const lines = body.split("\n")
  const fields = new Map<string, string>()
  let content = body
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
    if (close > 0) {
      for (const line of lines.slice(1, close)) {
        const separator = line.indexOf(":")
        if (separator <= 0) continue
        fields.set(line.slice(0, separator).trim(), line.slice(separator + 1))
      }
      content = lines
        .slice(close + 1)
        .join("\n")
        .replace(/^\n/, "")
    }
  }

  const fallbackName = path.split("/").pop()?.replace(/\.md$/, "") ?? ""
  const fallbackType = path.includes("/") ? path.split("/")[0] : "_index"
  const supersedes = fields.has("supersedes") ? parseScalar(fields.get("supersedes") ?? "") : ""
  return {
    path,
    type: fields.has("type") ? parseScalar(fields.get("type") ?? "") : fallbackType,
    name: fields.has("name") ? parseScalar(fields.get("name") ?? "") : fallbackName,
    description: fields.has("description") ? parseScalar(fields.get("description") ?? "") : "",
    content,
    requiredScopes: parseList(fields.get("requiredScopes") ?? "[]"),
    sources: parseList(fields.get("sources") ?? "[]"),
    supersedes: supersedes === "" || supersedes === "null" ? null : supersedes,
    modified: fields.has("modified") ? parseScalar(fields.get("modified") ?? "") : null,
  }
}

/**
 * Validate a model supplied path and return it relative to this agent's own
 * root. An absolute form is accepted only when it names THIS agent's root, so
 * `/memories/<other>/...` is refused rather than silently rebased.
 */
export function resolvePath(handle: string, path: string): string {
  const root = memoryRoot(handle)
  let relative = path
  if (path.startsWith("/")) {
    if (!path.startsWith(root)) {
      throw new Error(`Path is outside your memory tree: ${path}`)
    }
    relative = path.slice(root.length)
  }
  if (!isLegalMemoryPath(relative)) {
    throw new Error(`Not a path inside your memory tree: ${path}`)
  }
  return relative
}

/**
 * The immediate children of a folder, sorted: the listing `memory_view`
 * returns for a directory. Subfolders are returned with a trailing slash so a
 * caller can tell them from files without another lookup.
 */
export function listDirectory(handle: string, dirPath: string, paths: string[]): string[] {
  const prefix = dirPath === "" || dirPath === "." ? "" : `${dirPath.replace(/\/$/, "")}/`
  const children = new Set<string>()
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (rest === "") continue
    const slash = rest.indexOf("/")
    children.add(slash === -1 ? `${prefix}${rest}` : `${prefix}${rest.slice(0, slash)}/`)
  }
  // `handle` is not needed to list a tree that is already this agent's, but it
  // is on the signature so every tree entry point reads the same way and a
  // later per agent virtual folder has it available.
  void handle
  return [...children].sort()
}
