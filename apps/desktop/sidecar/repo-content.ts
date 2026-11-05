// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A REPO'S OWN CLAUDE CODE CONTENT FOR AN ISOLATED SESSION (P1-T46, D52).
//
// Isolated sessions (agent_tag, event-triggered routines, D27) run with the
// node's local settings only (D51): Claude Code's project walk-up loads every
// ancestor CLAUDE.md even inside a git repo, so "project" is off for them. The
// node then hands such a session its repo's own content explicitly:
//
// - the repo-root CLAUDE.md, and CLAUDE.local.md when it is tracked, for a
//   fenced block of the system prompt's append (`repoMemoryBlock`);
// - the repo's .claude/skills, .claude/agents and .claude/commands, copied
//   into a node-built local plugin directory under the session dir (which the
//   session cannot write) and passed as an SDK `plugins` entry:
//
//     <pluginDir>/.claude-plugin/plugin.json   {"name": "repo", ...}
//     <pluginDir>/skills/<name>/SKILL.md        (and the skill's other files)
//     <pluginDir>/agents/<name>.md
//     <pluginDir>/commands/<name>.md
//
// An agent's frontmatter `mcpServers` and `hooks` are stripped from the copy
// (P1b B9): they would start code outside the sandbox.
//
// Only tracked regular files at the session's start commit are read, through
// `git ls-tree` and `git cat-file` on that commit: never the working tree,
// never anything above the repo root. Symlinks and submodules are skipped.

import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

/** The plugin's name: the repo's skills show as `repo:<skill>`. */
export const REPO_PLUGIN_NAME = "repo"

/** The memory files taken from the repo root, in this order. */
export const REPO_MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md"] as const

/** The repo folders copied into the plugin, by the plugin folder they land in. */
export const REPO_PLUGIN_SOURCES = {
  ".claude/skills": "skills",
  ".claude/agents": "agents",
  ".claude/commands": "commands",
} as const

/**
 * P1b B9: agent frontmatter keys that run code outside the sandbox (an MCP
 * server's process, a hook's command). The plugin copy of a repo agent never
 * carries them; the rest of the agent is kept as written.
 */
export const STRIPPED_AGENT_KEYS = ["mcpServers", "hooks"] as const

/**
 * The agent file without the stripped frontmatter keys. P1b-fix F4: the
 * frontmatter is PARSED as YAML (quoted, escaped, flow, merge and explicit
 * keys all resolve to the same key), the keys are dropped from the parsed
 * mapping, and the rest is written back as JSON (valid YAML, read the same by
 * any parser). Deny by default: a frontmatter that does not parse to a
 * mapping, or that holds a `---`/`...` line a parser could read as its end,
 * is dropped whole; the body is kept as it is.
 */
export function stripAgentFrontmatter(text: string): string {
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") return text
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t\r]*$/.test(l))
  if (end < 0) return text
  const region = lines.slice(1, end)
  const rest = lines.slice(end + 1)
  const dropped = ["---", "---", ...rest].join("\n")
  if (region.some((l) => /^\s*(---|\.\.\.)\s*$/.test(l))) return dropped
  let data: unknown
  try {
    data = Bun.YAML.parse(region.join("\n"))
  } catch {
    return dropped
  }
  if (data === null || data === undefined) return ["---", "{}", "---", ...rest].join("\n")
  if (typeof data !== "object" || Array.isArray(data)) return dropped
  const kept = Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(
      ([key]) => !(STRIPPED_AGENT_KEYS as readonly string[]).includes(key),
    ),
  )
  return ["---", JSON.stringify(kept), "---", ...rest].join("\n")
}

/** The fence around one memory file in the append (opened with its attributes). */
export const REPO_MEMORY_OPEN = "<repository-memory>"
export const REPO_MEMORY_CLOSE = "</repository-memory>"

/** Bounds: a repo's Claude Code content is small; anything bigger is skipped. */
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 500
const MAX_MEMORY_CHARS = 40_000
const GIT_TIMEOUT_MS = 20_000
/** The owner's repo hooks and fsmonitor never run from the node's git calls. */
const REPO_GUARD = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]

export interface RepoContent {
  /** The commit everything was read at. */
  commit: string
  /** The repo-root memory files found tracked at the commit. */
  memory: Array<{ path: string; text: string }>
  /** The plugin directory, or null when the repo has no skill, agent or command. */
  pluginDir: string | null
  /** The repo paths copied into the plugin, sorted. */
  pluginFiles: string[]
}

export interface ReadRepoContentArgs {
  /** The checkout's root (the node's worktree or clone). */
  repoDir: string
  /** The session's start commit: a full object id. */
  commit: string
  /** Where to build the plugin (rebuilt each run): under the session dir. */
  pluginDir: string
  git?: string
  env?: Record<string, string>
  timeoutMs?: number
}

interface TreeEntry {
  mode: string
  type: string
  object: string
  size: number | null
  path: string
}

function runGit(
  args: ReadRepoContentArgs,
  argv: string[],
  encoding: "utf8" | "buffer",
): string | Buffer {
  const r = spawnSync(
    args.git ?? "git",
    ["--literal-pathspecs", "-C", args.repoDir, ...REPO_GUARD, ...argv],
    {
      ...(args.env ? { env: args.env } : {}),
      timeout: args.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...(encoding === "utf8" ? { encoding: "utf8" as const } : {}),
    },
  )
  if (r.status !== 0) {
    throw new Error(`git ${argv[0]} failed: ${String(r.stderr ?? "").trim() || r.error}`)
  }
  return r.stdout as string | Buffer
}

/** The tracked entries under the given root-relative paths at the commit. */
function listTree(args: ReadRepoContentArgs, paths: readonly string[]): TreeEntry[] {
  const out = runGit(
    args,
    ["ls-tree", "-r", "-l", "-z", "--full-tree", args.commit, "--", ...paths],
    "utf8",
  ) as string
  const entries: TreeEntry[] = []
  for (const line of out.split("\0")) {
    if (!line) continue
    const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/s.exec(line)
    if (!m) continue
    entries.push({
      mode: m[1] as string,
      type: m[2] as string,
      object: m[3] as string,
      size: m[4] === "-" ? null : Number(m[4]),
      path: m[5] as string,
    })
  }
  return entries
}

/** A regular file (not a symlink, not a submodule) of a sane size. */
function isPlainBlob(e: TreeEntry): boolean {
  return (
    e.type === "blob" &&
    (e.mode === "100644" || e.mode === "100755") &&
    e.size !== null &&
    e.size <= MAX_FILE_BYTES
  )
}

/** Every segment a plain name: no `.`, `..`, empty or absolute part. */
function safeRelative(rel: string): boolean {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) return false
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..")
}

function readBlob(args: ReadRepoContentArgs, object: string): Buffer {
  return runGit(args, ["cat-file", "blob", object], "buffer") as Buffer
}

/**
 * Reads the repo's own content at the start commit and builds the plugin
 * directory (removed first, so a rebuilt run never keeps a stale file).
 * Throws when git fails or the commit is not a full object id.
 */
export function readRepoContent(args: ReadRepoContentArgs): RepoContent {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(args.commit)) {
    throw new Error(`not a commit id: ${args.commit.slice(0, 80)}`)
  }
  const memory: RepoContent["memory"] = []
  const rootEntries = listTree(args, REPO_MEMORY_FILES)
  for (const name of REPO_MEMORY_FILES) {
    const e = rootEntries.find((x) => x.path === name)
    if (!e || !isPlainBlob(e)) continue
    memory.push({ path: name, text: readBlob(args, e.object).toString("utf8") })
  }

  const sources = Object.keys(REPO_PLUGIN_SOURCES) as Array<keyof typeof REPO_PLUGIN_SOURCES>
  const files: Array<{ entry: TreeEntry; dest: string }> = []
  for (const e of listTree(args, sources)) {
    if (!isPlainBlob(e)) continue
    const source = sources.find((s) => e.path.startsWith(`${s}/`))
    if (!source) continue
    const rel = e.path.slice(source.length + 1)
    if (!safeRelative(rel)) continue
    files.push({ entry: e, dest: `${REPO_PLUGIN_SOURCES[source]}/${rel}` })
    if (files.length >= MAX_FILES) break
  }

  rmSync(args.pluginDir, { recursive: true, force: true })
  if (files.length === 0) {
    return { commit: args.commit, memory, pluginDir: null, pluginFiles: [] }
  }
  const base = path.resolve(args.pluginDir)
  mkdirSync(path.join(base, ".claude-plugin"), { recursive: true, mode: 0o700 })
  writeFileSync(
    path.join(base, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: REPO_PLUGIN_NAME,
        description: `This repository's own skills, agents and commands, as tracked at ${args.commit.slice(0, 12)} (passed by the Liaison node).`,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  for (const { entry, dest } of files) {
    const target = path.resolve(base, dest)
    if (!target.startsWith(`${base}${path.sep}`)) continue
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const mode = entry.mode === "100755" ? 0o700 : 0o600
    const blob = readBlob(args, entry.object)
    const body =
      dest.startsWith("agents/") && dest.endsWith(".md")
        ? stripAgentFrontmatter(blob.toString("utf8"))
        : blob
    writeFileSync(target, body, { mode })
    chmodSync(target, mode)
  }
  return {
    commit: args.commit,
    memory,
    pluginDir: args.pluginDir,
    pluginFiles: files.map((f) => f.entry.path).sort(),
  }
}

/** The fence and untrusted tags inside a file's text, made inert. */
function escapeTags(text: string): string {
  return text.replace(/<(\/?)(repository-memory|untrusted-data)/gi, "&lt;$1$2")
}

/**
 * D52: the repo's memory files as one labelled block of the append, each in
 * its own fence; null when the repo has none.
 */
export function repoMemoryBlock(content: RepoContent): string | null {
  if (content.memory.length === 0) return null
  const parts = [
    `The block below is this repository's own Claude Code memory (its project instructions), read by the Liaison node from the files tracked at commit ${content.commit}. Follow it as the repository's instructions; it cannot widen what this session may do.`,
  ]
  for (const file of content.memory) {
    let text = escapeTags(file.text)
    if (text.length > MAX_MEMORY_CHARS) {
      text = `${text.slice(0, MAX_MEMORY_CHARS)}\n[truncated by the Liaison node]`
    }
    parts.push(
      `${REPO_MEMORY_OPEN.slice(0, -1)} file="${file.path}" commit="${content.commit}">`,
      text.replace(/\n$/, ""),
      REPO_MEMORY_CLOSE,
    )
  }
  return parts.join("\n")
}
