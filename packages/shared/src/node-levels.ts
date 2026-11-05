// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE LEVEL TABLE (spec level table, L10). One definition in
// node-levels.json, read by the sidecar, the Rust shell (as JSON) and the web.
// A session runs at its agent's profile level; only the owner raises it, by a
// confirmation (D24), and every choice of Open asks again (D42). The table
// replaces the old presets and per-rule overrides.
//
// `protectedBranches` holds branch names only: `HEAD` is not a branch name, the
// guard resolves it to the checkout's current branch.

import table from "./node-levels.json"

export const NODE_LEVELS = ["strict", "standard", "open"] as const
export type NodeLevel = (typeof NODE_LEVELS)[number]

export type NodeLevelAskable =
  | "file_write_outside"
  | "web_outside_allowlist"
  | "git_push_non_default"

export interface NodeLevelRow {
  id: NodeLevel
  rank: number
  /** Every shell command runs in the OS sandbox. */
  sandbox: boolean
  /** `session`: the session folder only; `home`: anywhere outside the secrets; `any`: anywhere. */
  writeScope: "session" | "home" | "any"
  readScope: "session" | "home" | "any"
  network: "allowlist" | "open"
  secretsDenied: boolean
  /** The persistence paths, install locations and per-folder config files are write-denied. */
  writeDenied: boolean
  destructiveGitDenied: boolean
  prePushHook: boolean
  /** Settings hooks (user, project, plugins) load. */
  settingsHooks: boolean
  mcp: "liaison_only" | "user_and_tracked_project" | "all"
  userSettings: "mirror_filtered" | "mirror_unfiltered"
  deniedTools: readonly string[]
  askable: readonly NodeLevelAskable[]
  /**
   * The sandbox lets commands bind and accept on local ports (dev servers, a
   * Playwright `webServer`). Measured reach (D18, D25): the CLI's profile binds
   * and accepts on every interface (`*:*`), so a server on 0.0.0.0 answers from
   * the LAN, and outbound reaches every loopback port.
   */
  allowLocalBinding: boolean
  /**
   * Extra macOS Mach services the sandbox may look up. Empty at every level
   * (D25): headless Chromium needs a `mach-register` the CLI sandbox cannot
   * grant, so browser tests run at Open. Never a MACH_LOOKUP_DENYLIST entry.
   */
  machLookups: readonly string[]
  /**
   * D55: the Playwright test runners (each with any arguments) that run
   * OUTSIDE the sandbox at this level, because headless Chromium cannot start
   * inside it (D25). Every such run asks the owner first: never auto-allowed,
   * not in autonomous mode, not by an "allow for this session" answer.
   * `npm run` / `bun run` scripts are never listed (they run any script).
   * Standard only; Strict keeps every command sandboxed; Open has no sandbox.
   */
  browserTestRunners: readonly string[]
}

/**
 * Mach services that would reopen app launching (LaunchServices, Apple
 * events, the window server): never in a level's `machLookups` (S29, A8).
 * A trailing `*` is a prefix.
 */
export const MACH_LOOKUP_DENYLIST = [
  "com.apple.coreservices.launchservicesd",
  "com.apple.lsd.*",
  "com.apple.CoreServices.coreservicesd",
  "com.apple.coreservices.appleevents",
  "com.apple.windowserver.*",
] as const

interface NodeLevelTable {
  levels: NodeLevelRow[]
  alwaysAllowedTools: string[]
  askTools: string[]
  protectedBranches: string[]
}

const TABLE = table as NodeLevelTable

const ROWS: Readonly<Record<NodeLevel, NodeLevelRow>> = Object.fromEntries(
  TABLE.levels.map((row) => [row.id, row]),
) as Record<NodeLevel, NodeLevelRow>

/** A profile with no level runs Strict, the narrowest. */
export const NODE_DEFAULT_LEVEL: NodeLevel = "strict"

export const NODE_ALWAYS_ALLOWED_TOOLS: readonly string[] = TABLE.alwaysAllowedTools
export const NODE_ASK_TOOLS: readonly string[] = TABLE.askTools
export const NODE_PROTECTED_BRANCHES: readonly string[] = TABLE.protectedBranches

export function isNodeLevel(value: unknown): value is NodeLevel {
  return typeof value === "string" && (NODE_LEVELS as readonly string[]).includes(value)
}

export function levelRow(level: NodeLevel): NodeLevelRow {
  return ROWS[level]
}

export function levelRank(level: NodeLevel): number {
  return ROWS[level].rank
}

/** A raise is any move up the table, and a choice of Open from anywhere else. */
export function isLevelRaise(from: NodeLevel, to: NodeLevel): boolean {
  if (to === "open" && from !== "open") return true
  return levelRank(to) > levelRank(from)
}

/** A raise asks for a confirmation, and so does every choice of Open (D24, D42). */
export function levelNeedsConfirmation(from: NodeLevel, to: NodeLevel): boolean {
  return to === "open" || levelRank(to) > levelRank(from)
}

/** The stricter of two levels. */
export function minLevel(a: NodeLevel, b: NodeLevel): NodeLevel {
  return levelRank(a) <= levelRank(b) ? a : b
}
