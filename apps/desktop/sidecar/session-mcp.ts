// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP SERVERS PER LEVEL (P1-T32; D21, D25, D27).
//
// An MCP server is a process the CLI starts OUTSIDE the Bash sandbox, with
// the owner's user rights. So below Open the sidecar builds the server list
// itself and passes it with `strictMcpConfig: true`: the CLI then loads
// nothing else (no project .mcp.json, user settings, plugin or agent
// frontmatter servers).
//
// - Strict: Liaison only (per the profile's toggle).
// - Standard: Liaison; the owner's user-scope servers from ~/.claude.json's
//   top-level `mcpServers` (owner runs only, D27; CV4 observed that shape);
//   and a SHARED-FOLDER repo's `.mcp.json`, only when it is committed and
//   unchanged since the session's start commit, its content read from that
//   commit (`git show`), never from the working copy a session can write.
//   A clone of an arbitrary URL never loads its `.mcp.json` below Open.
// - Open: `strictMcpConfig` off, so the project's `.mcp.json` and plugin
//   servers load as in Claude Code; Liaison and the owner's user-scope
//   servers are passed explicitly (the session's config dir is the node's,
//   not ~/.claude.json's home).
// - Isolated runs (agent_tag, event-triggered routines) never get the owner's
//   servers.
//
// Every server loaded and every one skipped, with the reason, is returned for
// the start `system` event. Values of ~/.claude.json (tokens in `env`) are
// never logged or put in a reason.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import type { NodeLevel } from "../../../packages/shared/src/node-levels"
import {
  HOST_MCP_SERVER,
  type NodeSessionConfigKind,
} from "../../../packages/shared/src/node-session-protocol"

/** The project MCP file Claude Code reads. */
const PROJECT_MCP_FILE = ".mcp.json"
const GIT_TIMEOUT_MS = 10_000

export interface SkippedMcp {
  /** A server name, `.mcp.json` for the whole project file, or `user` for the user config. */
  name: string
  reason: string
}

export interface SessionMcp {
  servers: Record<string, McpServerConfig>
  strictMcpConfig: boolean
  loaded: string[]
  skipped: SkippedMcp[]
}

export interface SessionMcpArgs {
  level: NodeLevel
  configKind: NodeSessionConfigKind
  /** Present when the profile's Liaison tools toggle is on. */
  liaison?: { name: "liaison"; config: McpServerConfig }
  /** The session's checkout: a worktree of a shared folder, or a clone. */
  folder?: { path: string; isRepoClone: boolean; startCommit?: string }
  /** The owner's home: `<realHome>/.claude.json` holds the user-scope servers. */
  realHome: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A server entry the CLI can start: a command, or a URL. Never inspected further. */
function isServerEntry(value: unknown): value is McpServerConfig {
  if (!isPlainObject(value)) return false
  return typeof value.command === "string" || typeof value.url === "string"
}

/** Reads a `{mcpServers: {...}}` document into valid entries and per-name skips. */
function serversOf(
  doc: unknown,
  origin: string,
): { servers: Record<string, McpServerConfig>; skipped: SkippedMcp[] } {
  const servers: Record<string, McpServerConfig> = {}
  const skipped: SkippedMcp[] = []
  if (!isPlainObject(doc) || doc.mcpServers === undefined) return { servers, skipped }
  if (!isPlainObject(doc.mcpServers)) {
    return { servers, skipped: [{ name: origin, reason: `${origin} mcpServers is not an object` }] }
  }
  for (const [name, entry] of Object.entries(doc.mcpServers)) {
    if (isServerEntry(entry)) servers[name] = entry
    else skipped.push({ name, reason: `not a server entry in ${origin}` })
  }
  return { servers, skipped }
}

/** The owner's user-scope servers (`~/.claude.json` top-level `mcpServers`, CV4). */
function userServers(realHome: string): {
  servers: Record<string, McpServerConfig>
  skipped: SkippedMcp[]
} {
  const file = path.join(realHome, ".claude.json")
  if (!existsSync(file)) return { servers: {}, skipped: [] }
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { servers: {}, skipped: [{ name: "user", reason: "user MCP config unreadable" }] }
  }
  return serversOf(doc, "the user config")
}

/**
 * git, run by the node outside the sandbox. The repo's own config may name
 * an fsmonitor, an external diff or a textconv command: none of them runs.
 */
function git(cwd: string, args: string[]): { ok: boolean; code: number | null; out: string } {
  const r = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", cwd, ...args],
    {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 1024 * 1024,
    },
  )
  return { ok: r.status === 0 && !r.error, code: r.status, out: r.stdout ?? "" }
}

/** D25 (b): a shared-folder repo's `.mcp.json`, committed and unchanged since the start commit. */
function projectServers(folder: { path: string; startCommit?: string }): {
  servers: Record<string, McpServerConfig>
  skipped: SkippedMcp[]
} {
  const none = { servers: {}, skipped: [] }
  const atStart =
    folder.startCommit !== undefined &&
    git(folder.path, ["cat-file", "-e", `${folder.startCommit}:${PROJECT_MCP_FILE}`]).ok
  if (!existsSync(path.join(folder.path, PROJECT_MCP_FILE)) && !atStart) return none
  const skip = (reason: string) => ({ servers: {}, skipped: [{ name: PROJECT_MCP_FILE, reason }] })
  if (!folder.startCommit) return skip("not in a git repository")
  if (!git(folder.path, ["ls-files", "--error-unmatch", "--", PROJECT_MCP_FILE]).ok) {
    return skip("not committed to the repository")
  }
  const diff = git(folder.path, [
    "diff",
    "--quiet",
    "--no-ext-diff",
    "--no-textconv",
    folder.startCommit,
    "--",
    PROJECT_MCP_FILE,
  ])
  if (!diff.ok || !atStart) return skip("modified since the session started")
  const shown = git(folder.path, [
    "show",
    "--no-textconv",
    `${folder.startCommit}:${PROJECT_MCP_FILE}`,
  ])
  if (!shown.ok) return skip("unreadable at the start commit")
  let doc: unknown
  try {
    doc = JSON.parse(shown.out)
  } catch {
    return skip("not valid JSON")
  }
  return serversOf(doc, PROJECT_MCP_FILE)
}

export function sessionMcpServers(args: SessionMcpArgs): SessionMcp {
  const servers: Record<string, McpServerConfig> = {}
  const skipped: SkippedMcp[] = []
  const add = (found: { servers: Record<string, McpServerConfig>; skipped: SkippedMcp[] }) => {
    skipped.push(...found.skipped)
    for (const [name, config] of Object.entries(found.servers)) {
      // S5 (A9): `liaison_session` is the node's own host server, reserved like `liaison`.
      if (name === "liaison" || name === HOST_MCP_SERVER) {
        skipped.push({ name, reason: "the name is Liaison's own" })
        continue
      }
      // Claude Code's precedence: the project's server outranks the user's.
      servers[name] = config
    }
  }

  if (args.liaison) servers.liaison = args.liaison.config
  if (args.level !== "strict" && args.configKind === "owner") add(userServers(args.realHome))
  if (args.level === "standard" && args.folder) {
    if (args.folder.isRepoClone) {
      if (existsSync(path.join(args.folder.path, PROJECT_MCP_FILE))) {
        skipped.push({
          name: PROJECT_MCP_FILE,
          reason: "a cloned repository's .mcp.json loads only at Open",
        })
      }
    } else {
      add(projectServers(args.folder))
    }
  }
  return {
    servers,
    strictMcpConfig: args.level !== "open",
    loaded: Object.keys(servers),
    skipped,
  }
}
