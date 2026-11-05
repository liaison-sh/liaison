// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Folder import for `knowledge.documents[]`: a `{ dir, collection }` entry
 * becomes one document per matching text file under `dir`. Used for what a
 * setup harness gathers in bulk (a crawled website, a repo's docs, manuals
 * converted to Markdown) so the config does not list hundreds of files.
 *
 * Pure file-system work, no database: the knowledge provisioner turns the
 * result into documents with the same (collection, title) idempotency as a
 * single `contentFile` entry. A re-run over the same tree is a no-op because
 * every title is a deterministic function of the file (front matter, first
 * heading, or path).
 *
 * Safety: `dir` must stay inside the config file's directory, also once both
 * are resolved through symlinks; every matched file is resolved through
 * symlinks and must stay inside `dir`; dot files and `node_modules` are never
 * read; a file's size is checked before it is read; the file count is capped.
 */
import { realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import { ConfigError } from "~/cli/config/parse"
import { DEFAULT_KNOWLEDGE_DIR_INCLUDE } from "~/cli/config/schema"
import { withOpenFile } from "~/lib/read-checked-file"

/** Same cap as the knowledge document body schema. */
export const MAX_KNOWLEDGE_BODY_CHARS = 1_000_000
/** Same cap as the knowledge document title schema. */
const MAX_TITLE_CHARS = 240
/** A guard against pointing `dir` at a whole disk by mistake. */
export const MAX_KNOWLEDGE_DIR_FILES = 5000

export interface KnowledgeDirEntry {
  dir: string
  collection: string
  include?: string[]
  exclude?: string[]
}

export interface DirDocument {
  /** Path relative to the config directory, for logs and reports. */
  path: string
  title: string
  body: string
}

export interface DirExpansion {
  documents: DirDocument[]
  /** Files matched but not imported (empty, or over the body size cap). */
  skipped: Array<{ path: string; reason: string }>
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

/** Resolve `dir` against the config directory; reject absolute and escaping paths. */
export function resolveKnowledgeDir(configDir: string, dir: string): string {
  if (isAbsolute(dir)) {
    throw new ConfigError(
      `knowledge: dir '${dir}' must be a path relative to the config file directory (absolute paths are rejected)`,
    )
  }
  const base = resolve(configDir)
  const target = resolve(base, dir)
  if (!isInside(base, target)) {
    throw new ConfigError(
      `knowledge: dir '${dir}' escapes the config file directory (path traversal rejected)`,
    )
  }
  return target
}

interface ParsedFile {
  title: string | null
  source: string | null
  body: string
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Split YAML front matter from the body; tolerate malformed front matter. */
export function parseKnowledgeFile(text: string): ParsedFile {
  const content = text.replace(/^﻿/, "")
  let body = content
  let title: string | null = null
  let source: string | null = null
  const match = FRONT_MATTER_RE.exec(content)
  if (match) {
    let meta: unknown = null
    try {
      meta = parseYaml(match[1] ?? "")
    } catch {
      meta = null
    }
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      body = content.slice(match[0].length)
      const record: Record<string, unknown> = Object.fromEntries(Object.entries(meta))
      if (typeof record.title === "string" && record.title.trim() !== "") {
        title = record.title.trim()
      }
      for (const key of ["source", "url", "source_url"]) {
        const value = record[key]
        if (typeof value === "string" && value.trim() !== "") {
          source = value.trim()
          break
        }
      }
    }
  }
  if (title === null) {
    for (const rawLine of body.split("\n")) {
      const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(rawLine.trim())
      if (heading?.[1]) {
        title = heading[1].trim()
        break
      }
    }
  }
  return { title, source, body }
}

function titleFromFileName(path: string): string {
  return basename(path, extname(path))
}

function clampTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim()
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1)}…` : oneLine
}

function isIgnoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith("."))
}

/**
 * Expand one `{ dir, collection }` entry into documents. Throws
 * `ConfigError` (exit 2) for a missing/escaping dir or too many files, so the
 * run aborts before any write.
 */
export async function expandKnowledgeDir(
  configDir: string,
  entry: KnowledgeDirEntry,
): Promise<DirExpansion> {
  const root = resolveKnowledgeDir(configDir, entry.dir)
  let rootStat: Awaited<ReturnType<typeof stat>>
  try {
    rootStat = await stat(root)
  } catch {
    throw new ConfigError(`knowledge: dir '${entry.dir}' does not exist`)
  }
  if (!rootStat.isDirectory()) {
    throw new ConfigError(`knowledge: dir '${entry.dir}' is not a directory`)
  }
  const realRoot = await realpath(root)
  // `dir` itself may be (or sit under) a symlink: what it RESOLVES to must
  // still be inside the config directory.
  const realConfigDir = await realpath(resolve(configDir))
  if (!isInside(realConfigDir, realRoot)) {
    throw new ConfigError(
      `knowledge: dir '${entry.dir}' resolves outside the config file directory (rejected)`,
    )
  }

  const includes = entry.include ?? [DEFAULT_KNOWLEDGE_DIR_INCLUDE]
  const excludes = (entry.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const matched = new Set<string>()
  for (const pattern of includes) {
    for await (const rel of new Bun.Glob(pattern).scan({
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymlinks: false,
    })) {
      const normalized = rel.split(sep).join("/")
      if (isIgnoredPath(normalized)) continue
      if (excludes.some((glob) => glob.match(normalized))) continue
      matched.add(normalized)
      if (matched.size > MAX_KNOWLEDGE_DIR_FILES) {
        throw new ConfigError(
          `knowledge: dir '${entry.dir}' matches more than ${MAX_KNOWLEDGE_DIR_FILES} files; narrow it with include/exclude`,
        )
      }
    }
  }

  const documents: DirDocument[] = []
  const skipped: DirExpansion["skipped"] = []
  const configRoot = resolve(configDir)
  for (const rel of [...matched].sort()) {
    const absolute = resolve(root, rel)
    const display = relative(configRoot, absolute).split(sep).join("/")
    const real = await realpath(absolute)
    if (!isInside(realRoot, real)) {
      throw new ConfigError(`knowledge: '${display}' links outside dir '${entry.dir}' (rejected)`)
    }
    // Read nothing larger than a document can be (UTF-8 is at least one byte
    // per character, so more bytes than the cap can still fit after decoding
    // only in multibyte text; four bytes per character bounds it).
    // Sized and read through one descriptor: the file measured is the file read.
    const text = await withOpenFile(real, async ({ size }, read) =>
      size > MAX_KNOWLEDGE_BODY_CHARS * 4 ? null : (await read()).toString("utf8"),
    )
    if (text === null) {
      skipped.push({
        path: display,
        reason: `larger than ${MAX_KNOWLEDGE_BODY_CHARS} characters; split it into smaller files`,
      })
      continue
    }
    const parsed = parseKnowledgeFile(text)
    const content = parsed.body.trim()
    if (content === "") {
      skipped.push({ path: display, reason: "empty" })
      continue
    }
    const body = parsed.source ? `Source: ${parsed.source}\n\n${content}\n` : `${content}\n`
    if (body.length > MAX_KNOWLEDGE_BODY_CHARS) {
      skipped.push({
        path: display,
        reason: `larger than ${MAX_KNOWLEDGE_BODY_CHARS} characters; split it into smaller files`,
      })
      continue
    }
    documents.push({
      path: display,
      title: clampTitle(parsed.title ?? titleFromFileName(rel)),
      body,
    })
  }
  return { documents, skipped }
}

/**
 * Make titles unique within one collection: when two documents would share a
 * title (two READMEs both titled after the project), each folder document
 * with that title gets its path appended. Deterministic, so re-runs agree.
 * `fixed` titles (single `contentFile` entries) are never renamed.
 */
export function disambiguateTitles(
  fixed: readonly string[],
  fromDirs: readonly DirDocument[],
): DirDocument[] {
  const counts = new Map<string, number>()
  for (const t of fixed) counts.set(t, (counts.get(t) ?? 0) + 1)
  for (const d of fromDirs) counts.set(d.title, (counts.get(d.title) ?? 0) + 1)
  return fromDirs.map((d) =>
    (counts.get(d.title) ?? 0) > 1 ? { ...d, title: clampTitle(`${d.title} (${d.path})`) } : d,
  )
}
