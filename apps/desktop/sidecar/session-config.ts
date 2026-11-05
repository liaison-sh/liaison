// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION CONFIG DIR (P1-T31; D26, D27, D48, L9, L16).
//
// Every session runs with `CLAUDE_CONFIG_DIR` pointed at a directory the node
// builds, never at the owner's real ~/.claude:
//
// - An OWNER run (the owner's dispatch, an app session, their own scheduled
//   routine, D27) gets a mirror: read-only links to the owner's CLAUDE.md,
//   skills, agents, commands and plugins (CV3: the CLI follows a symlinked
//   `skills`), and a settings.json the node writes. Below Open that file holds
//   only the inert keys a repository may carry (INERT_REPO_SETTINGS), the
//   owner's deny rules and enabledPlugins. Array keys merge across setting
//   sources and the flag layer cannot remove them (CV11: a user
//   `sandbox.filesystem.allowWrite: ["~"]` widened the flag layer's sandbox on
//   this Mac), so the widening keys never reach the CLI at all (D48): no
//   `sandbox.*`, `permissions.allow`, `permissions.defaultMode`, `hooks`,
//   `disableAllHooks`, `env` or `apiKeyHelper`. At Open the owner's file is
//   copied as it is (the level table's "mirror, unfiltered").
// - An ISOLATED run (agent_tag, an event-triggered routine: anything carrying
//   an untrusted-request block) gets the credential and nothing else.
//
// The dir is keyed by the session and reused (D26: the config dir is pinned
// on the session for its whole life), so a resume after a level change finds
// its transcript under `projects/`. The credential is carried like the
// isolated config's (config-isolation.ts: on macOS the login is a keychain
// item, kept through CLAUDE_SECURESTORAGE_CONFIG_DIR="").

import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { NodeLevel } from "../../../packages/shared/src/node-levels"
import type { NodeSessionConfigKind } from "../../../packages/shared/src/node-session-protocol"
import { appDataDir, prepareIsolatedConfig, realClaudeConfigDir } from "./config-isolation"
import { INERT_REPO_SETTINGS } from "./job-workspace"

/** The owner's config entries an owner run reads, through a link (D26). */
export const MIRRORED_ENTRIES = ["CLAUDE.md", "skills", "agents", "commands", "plugins"] as const

/** Where the CLI writes its transcripts, inside its config dir (S49). */
export const PROJECTS_ENTRY = "projects"

/**
 * S49, D26b: the CLAUDE_CODE_ENTRYPOINT of an owner session whose transcript
 * lands in the owner's projects. VS Code's and the terminal's /resume pickers
 * hide transcripts whose entrypoint is sdk-ts, sdk-py or sdk-cli (the CLI and
 * the SDK's `listSessions({includeProgrammatic:false})`); the CLI rewrites
 * "cli" to "sdk-cli" in print mode, and "claude-vscode" would make the CLI
 * act as the VS Code extension (host OAuth refresh, IDE client, feedback
 * surveys). A value the CLI does not know is kept as it is in the transcript
 * and only turns off what the CLI gates on an SDK entrypoint: the Artifact
 * tool's SDK default (CLAUDE_CODE_ARTIFACT=1 is set anyway), child-process
 * memory telemetry and its exit summary, the EACCES/EPERM/EROFS error
 * classification, the feedback-draft and survey prompts. Measured on CLI
 * 2.1.286 and 2.1.296 (session-inplace.realquery.test.ts): listed, and
 * streaming, canUseTool, the PreToolUse hook and Artifact unchanged.
 */
export const OWNER_SESSION_ENTRYPOINT = "liaison-node"

/**
 * D49 F6: in an owner session's config dir, which server ran it and the SDK
 * session ids it ran (a liaison-node transcript is this node's own work, and
 * only the server that ran it may follow it in place).
 */
export const OWNER_RUN_FILE = "liaison-owner-run.json"
/** At most this many SDK ids are kept per session (a fork per resume at most). */
const OWNER_RUN_IDS_MAX = 64

/** The settings file the CLI reads from its config dir. */
const SETTINGS_FILE = "settings.json"

/** Keys of the owner's settings that pass below Open, besides the inert ones (D26). */
const PASSED_KEYS = new Set(["enabledPlugins"])

export interface SessionConfig {
  /** `<dataDir>/session-config/<sessionId>`: the session's CLAUDE_CONFIG_DIR. */
  dir: string
  /** The owner's settings keys not written into the mirror (`permissions.<k>` for sub-keys). */
  filtered: string[]
  /** The mirrored entries linked from the owner's config dir. */
  linked: string[]
  /**
   * What the session's `projects` is (S49): `linked` to the owner's
   * `<config>/projects` (an owner run), `legacy` (a real directory holding an
   * older session's transcripts, kept), or `own` (an isolated run).
   */
  projects: "linked" | "legacy" | "own"
}

export function sessionConfigDir(sessionId: string, dataDir: string = appDataDir()): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, "")
  if (!safe) throw new Error("a session config dir needs a session id")
  return path.join(dataDir, "session-config", safe)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface OwnerRun {
  server: string
  sdkSessionIds: string[]
}

function readOwnerRun(dir: string): OwnerRun | null {
  const file = path.join(dir, OWNER_RUN_FILE)
  let fd: number
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return null
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(16 * 1024 + 1)
    const got = readSync(fd, buf, 0, buf.length, 0)
    if (got > 16 * 1024) return null
    const raw = JSON.parse(buf.toString("utf8", 0, got)) as Partial<OwnerRun>
    if (typeof raw.server !== "string" || !Array.isArray(raw.sdkSessionIds)) return null
    const ids = raw.sdkSessionIds.filter((id): id is string => typeof id === "string")
    return { server: raw.server, sdkSessionIds: ids }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** D49 F6: records that this owner session ran `sdkSessionId` for `server`. */
export function recordOwnerRun(dir: string, server: string, sdkSessionId: string): void {
  const prior = readOwnerRun(dir)
  const ids = prior && prior.server === server ? prior.sdkSessionIds : []
  if (ids.includes(sdkSessionId)) return
  const run: OwnerRun = { server, sdkSessionIds: [...ids, sdkSessionId].slice(-OWNER_RUN_IDS_MAX) }
  const file = path.join(dir, OWNER_RUN_FILE)
  clear(file)
  writeFileSync(file, `${JSON.stringify(run)}\n`, { mode: 0o600, flag: "wx" })
}

/**
 * D49 F6: true when the Liaison session `sessionId` ran `sdkSessionId` on
 * this node for `server` (its own config dir's record says so).
 */
export function ranForServer(
  sessionId: string,
  sdkSessionId: string,
  server: string,
  dataDir: string = appDataDir(),
): boolean {
  let dir: string
  try {
    dir = sessionConfigDir(sessionId, dataDir)
  } catch {
    return false
  }
  const run = readOwnerRun(dir)
  return !!run && run.server === server && run.sdkSessionIds.includes(sdkSessionId)
}

/**
 * The owner's settings below Open: inert keys, deny rules and enabledPlugins
 * only; every other key is named in `filtered`.
 */
export function filterOwnerSettings(raw: unknown): {
  settings: Record<string, unknown>
  filtered: string[]
} {
  const settings: Record<string, unknown> = {}
  const filtered: string[] = []
  if (!isPlainObject(raw)) return { settings, filtered: [SETTINGS_FILE] }
  for (const [key, value] of Object.entries(raw)) {
    if (INERT_REPO_SETTINGS.has(key) || PASSED_KEYS.has(key)) {
      settings[key] = value
      continue
    }
    if (key === "permissions" && isPlainObject(value)) {
      for (const sub of Object.keys(value)) {
        if (sub !== "deny") filtered.push(`permissions.${sub}`)
      }
      const deny = Array.isArray(value.deny)
        ? value.deny.filter((rule): rule is string => typeof rule === "string")
        : []
      if (deny.length > 0) settings.permissions = { deny }
      continue
    }
    filtered.push(key)
  }
  return { settings, filtered }
}

function readOwnerSettings(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Replaces whatever sits at `at` (a link or a file the node wrote), never following it. */
function clear(at: string): void {
  try {
    lstatSync(at)
  } catch {
    return
  }
  rmSync(at, { recursive: true, force: true })
}

function writeSettings(dir: string, body: string): void {
  const file = path.join(dir, SETTINGS_FILE)
  clear(file)
  writeFileSync(file, body, { mode: 0o600, flag: "wx" })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: the inherited ACL stands.
  }
}

/**
 * Builds (or refreshes) a session's config dir. Never writes in the real
 * config dir. Called at every start and resume: the links follow what exists
 * now, and the settings follow the session's current level.
 */
export function prepareSessionConfig(args: {
  sessionId: string
  configKind: NodeSessionConfigKind
  level: NodeLevel
  realConfigDir?: string
  dataDir?: string
}): SessionConfig {
  const realConfigDir = args.realConfigDir ?? realClaudeConfigDir()
  const dir = sessionConfigDir(args.sessionId, args.dataDir ?? appDataDir())
  prepareIsolatedConfig({ realConfigDir, isolatedDir: dir })
  if (args.configKind === "isolated") return { dir, filtered: [], linked: [], projects: "own" }
  const projects = linkOwnerProjects(dir, realConfigDir)

  const linked: string[] = []
  for (const name of MIRRORED_ENTRIES) {
    const at = path.join(dir, name)
    const target = path.join(realConfigDir, name)
    clear(at)
    if (!existsSync(target)) continue
    symlinkSync(target, at)
    linked.push(name)
  }

  const ownerFile = path.join(realConfigDir, SETTINGS_FILE)
  if (args.level === "open") {
    // The level table: at Open the mirror's settings are the owner's, as is.
    clear(path.join(dir, SETTINGS_FILE))
    if (existsSync(ownerFile)) {
      copyFileSync(ownerFile, path.join(dir, SETTINGS_FILE))
      try {
        chmodSync(path.join(dir, SETTINGS_FILE), 0o600)
      } catch {
        // Windows: the inherited ACL stands.
      }
    }
    return { dir, filtered: [], linked, projects }
  }
  const owner = existsSync(ownerFile) ? readOwnerSettings(ownerFile) : {}
  const { settings, filtered } = filterOwnerSettings(owner)
  writeSettings(dir, `${JSON.stringify(settings, null, 2)}\n`)
  return { dir, filtered, linked, projects }
}

/**
 * S49 (owner D13, A18): an owner session's transcripts go to the owner's own
 * `<config>/projects`, so VS Code and the CLI opened on the folder list and
 * resume them. The mirror's `projects` becomes a link there. A real
 * `projects` holding an older session's transcripts is kept (no move of live
 * work). Nothing under the link target is ever removed: a stale link is
 * unlinked, never followed.
 */
function linkOwnerProjects(dir: string, realConfigDir: string): "linked" | "legacy" {
  const at = path.join(dir, PROJECTS_ENTRY)
  const target = path.join(realConfigDir, PROJECTS_ENTRY)
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true, mode: 0o700 })
    try {
      chmodSync(target, 0o700)
    } catch {
      // Windows: the inherited ACL stands.
    }
  }
  let stat: ReturnType<typeof lstatSync> | null = null
  try {
    stat = lstatSync(at)
  } catch {
    stat = null
  }
  if (stat?.isSymbolicLink()) {
    if (path.resolve(dir, readlinkSync(at)) === target) return "linked"
    unlinkSync(at)
  } else if (stat?.isDirectory()) {
    if (readdirSync(at).length > 0) return "legacy"
    rmdirSync(at)
  } else if (stat) {
    unlinkSync(at)
  }
  symlinkSync(target, at)
  return "linked"
}

/**
 * The mirror's link targets, for the sandbox's `allowRead` (D26): the real
 * paths the session reads through the mirror, and nothing else.
 */
export function mirrorReads(dir: string): string[] {
  const reads = new Set<string>()
  for (const name of MIRRORED_ENTRIES) {
    const at = path.join(dir, name)
    let target: string
    try {
      if (!lstatSync(at).isSymbolicLink()) continue
      target = path.resolve(dir, readlinkSync(at))
    } catch {
      continue
    }
    reads.add(target)
    try {
      reads.add(realpathSync(target))
    } catch {
      // A dangling link reads nothing.
    }
  }
  return [...reads]
}
