// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE A NODE SESSION WORKS (D17, D31; P1-T33). A session in a git
// repository works in a checkout the node makes before the session starts,
// on a `node/` branch, never in the owner's own working tree:
//
//   <nodeRoot>/worktrees/<folder>-<short>      a worktree of a shared repo
//   <agentDir>/sessions/<short>/<repo>         a clone of a named repository
//   (no generated file in the checkout: the guard's settings are flag-layer, D53)
//   <nodeRoot>/.sessions/<short>/hooks/pre-push the node's own push guard
//
// The node runs git here OUTSIDE the sandbox, with none of the owner's git
// config and no prompt. Pushing uses this computer's own credentials for the
// session's remote (P1-T30); the guard is the level's rules, the pre-push hook
// and the sandbox, not the absence of a credential.

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import { safeSubdir, safeWorktreePath } from "../../../packages/shared/src/node-import"
import {
  levelRow,
  NODE_PROTECTED_BRANCHES,
  type NodeLevel,
} from "../../../packages/shared/src/node-levels"
import { IN_PLACE_NEW_BRANCH_BELOW_OPEN } from "../../../packages/shared/src/node-session-protocol"
import { filterOwnerSettings } from "./session-config"
import { type CredentialScope, nodeCloneAuthEnv, remoteRepoPath } from "./session-credentials"
import type { JobSession, SessionJobContext } from "./unattended"
import { type OwnBranch, prePushHookScript } from "./unattended-profile"

/** P1-T33: the node fail codes a session's workspace step reports (R9). */
export type WorkspaceErrorCode =
  | "folder_missing"
  | "worktree_failed"
  | "settings_refused"
  | "timeout"
  /** A44 (W3): an import's recorded cwd is not a folder inside its shared folder. */
  | "unsafe_subdir"

export class WorkspaceError extends Error {
  /** True when the repository itself is why the job does not start (a refusal, not a fault). */
  readonly refused: boolean
  /** The session's fail code (P1-T33); absent on the template path. */
  readonly code?: WorkspaceErrorCode
  constructor(message: string, refused = false, code?: WorkspaceErrorCode) {
    super(message)
    this.name = "WorkspaceError"
    this.refused = refused
    if (code) this.code = code
  }
}

/**
 * D56 F1: the session cannot start until the owner acts on their folder (a
 * resume's switch back to the session's branch would overwrite their
 * uncommitted changes). Not a fault: the session parks Needs you with git's
 * own words as its reason, and the next send tries again. No reason code: a
 * server's completion schema is a strict enum, so a new code would make an
 * older server refuse the result, and a code's line would hide git's words.
 */
export class WorkspaceNeedsYou extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceNeedsYou"
  }
}

/**
 * The keys a repository's own `.claude/settings.json` or `settings.local.json`
 * may carry on Strict and Standard (fix8 H1, H2): nothing that runs code (a
 * hook, a helper, a status line, an MCP server), sets the environment, or
 * loosens a rule (allow, ask, a default mode, the sandbox, extra folders).
 * The project's settings load in the job's session, and some run on the
 * owner's computer before any guard (`apiKeyHelper`), so the node reads them
 * BEFORE the session starts and refuses the job on anything else. Unknown keys
 * are refused too: a key Claude Code adds tomorrow is unsafe until someone
 * decides it is not.
 */
export const INERT_REPO_SETTINGS = new Set([
  "$schema",
  "attribution",
  "includeCoAuthoredBy",
  "includeGitInstructions",
  "cleanupPeriodDays",
  "respectGitignore",
  "outputStyle",
  "language",
  "spinnerTipsEnabled",
  "viewMode",
])

/** The repository settings files the node checks (fix8). */
export const REPO_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const

function entryKind(p: string): "none" | "file" | "symlink" | "directory" | "other" {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return "symlink"
    if (st.isFile()) return "file"
    if (st.isDirectory()) return "directory"
    return "other"
  } catch {
    return "none"
  }
}

/** The environment the NODE's git runs with: none of the owner's config, no prompt. */
export function hostGitEnv(source: Record<string, string | undefined> = process.env) {
  return {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    HOME: source.HOME ?? "/",
    LANG: source.LANG ?? "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
}

/**
 * This computer's GitHub login, read OUTSIDE the sandbox (D17): `gh auth
 * token` with the owner's real environment. Null when gh is missing or not
 * signed in.
 */
export function readGhLoginToken(
  source: Record<string, string | undefined> = process.env,
  gh: string = findGh(source),
): string | null {
  const out = spawnSync(gh, ["auth", "token", "--hostname", "github.com"], {
    env: {
      PATH: source.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
      HOME: source.HOME ?? "",
      USER: source.USER ?? "",
      LANG: source.LANG ?? "en_US.UTF-8",
    },
    encoding: "utf8",
    timeout: 20_000,
  })
  const token = out.status === 0 ? (out.stdout ?? "").trim() : ""
  return /^[A-Za-z0-9_]{20,255}$/.test(token) ? token : null
}

/** gh's path: on PATH, else where Homebrew and the installer put it. */
export function findGh(source: Record<string, string | undefined> = process.env): string {
  const dirs = [
    ...(source.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, "gh")
    if (existsSync(candidate)) return candidate
  }
  return "gh"
}
/** The node's git, as an absolute path (final walk F2: the session's push shim runs it). */
export function findGit(source: Record<string, string | undefined> = process.env): string | null {
  const dirs = [
    ...(source.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ]
  for (const dir of dirs.filter((d) => path.isAbsolute(d))) {
    const candidate = path.join(dir, "git")
    if (existsSync(candidate)) return candidate
  }
  return null
}
// ── P1-T33: where a session works (S2, S15, D16, D17, D26, D31, L5, L12, L25) ──
//
//   folder, a git repo, Strict/Standard  a worktree of it under the node root,
//                                        on node/<slug>-<4hex> (never the
//                                        repo's own working tree)
//   repo (a URL or a shared repo name)   a clone keyed by the session, on the
//                                        same kind of branch
//   folder at Open, or not a repo        the folder itself
//   neither                              the session's default folder
//
// Every folder is keyed by the session, so a resumed run (a new job of the same
// session) finds its checkout and its edits again (L5, K23). The pre-push hook
// lives in the session dir, outside every checkout (K8); the session's git
// reaches it through core.hooksPath in the environment (P1-T30).

/** A folder this node advertises (P1-T38's `node_shared_folders`). */
export interface SessionFolder {
  name: string
  path: string
  kind: "root" | "repo"
}

/** Where the session works, and the git facts its sandbox and env need (P1-T30 `SessionGitInfo`). */
export interface SessionWorkspace {
  cwd: string
  kind: "worktree" | "clone" | "folder" | "default"
  /** The node-made checkout (worktree or clone). */
  repoDir?: string
  /** The owner's repository a worktree was made from. */
  sourceRepo?: string
  commonDir?: string
  gitDir?: string
  branch?: string
  defaultBranch?: string
  remoteHost?: string
  remoteKind?: "ssh" | "https"
  /** The `origin` URL, and its repository path (`owner/repo`), for the credential broker (D53). */
  remoteUrl?: string
  remotePath?: string
  /** `<sessionDir>/hooks`, holding the pre-push hook (Strict and Standard). */
  hooksDir?: string
  /** The commit the checkout started from, kept across resumes (P1-T32's `.mcp.json` check). */
  startCommit?: string
  /** P1b-fix F6: the checkout tracks `.claude/settings.local.json`: the session never loads the local source. */
  localSettingsTracked?: true
  /**
   * S50.4: an in-place folder holds the owner's own `.claude/settings.local.json`
   * (never judged, never written): below Open the session never loads the
   * local source.
   */
  localSettingsDropped?: true
  /** S48: the session runs in the owner's folder itself (no node worktree, branch or clone). */
  inPlace?: true
  /** D40: the branch the node made for this run in the owner's folder, and the one it left. */
  nodeBranch?: { name: string; from: string }
  /**
   * A44 (W3): the shared folder when `cwd` is the import's recorded subfolder
   * of it: the level's write scope stays the folder, not the subfolder.
   */
  writeDir?: string
  /**
   * Every initialised submodule (recursively) whose own git dir lives under
   * its parent's: the session commits and pushes there as in the folder's own
   * checkout. A submodule whose git dir points elsewhere is never one.
   */
  nested?: NestedGitRepo[]
  /** The git dirs of submodules refused above: their config and hooks stay write-denied. */
  foreignGitDirs?: string[]
}

/** One initialised submodule of the session's checkout (real paths). */
export interface NestedGitRepo {
  /** The submodule's working tree. */
  checkout: string
  /** Its own git dir (`<parent common>/modules/<name>`); a submodule is its own common dir. */
  commonDir: string
  gitDir: string
  /**
   * The branch the session commits on: its checked-out one, or the one the
   * node made for it (makeInPlaceBranch); none when detached or on its default.
   */
  branch?: string
  /** Its default branch, protected like the parent's (never pushed to). */
  defaultBranch?: string
  /** Its `origin` remote. */
  remoteUrl?: string
  remoteHost?: string
  remoteKind?: "ssh" | "https"
  /** The remote's port as the URL gives it (else 22 for ssh, 443 for https). */
  remotePort?: number
  remotePath?: string
}

export interface SessionWorkspaceArgs {
  session: JobSession
  level: NodeLevel
  ctx: SessionJobContext
  /**
   * S48 (owner D13): an owner run (dispatch or app, owner config) works in
   * the shared folder itself at every level, like Claude Code in VS Code. A
   * repo the session names that is one of the shared folders resolves to that
   * folder; only a URL is cloned. A session that already has a node worktree
   * or clone keeps it. Isolated runs: false (their own worktree or clone).
   */
  inPlace?: boolean
  /** The node's shared folders: a `repo` naming one of them clones its origin. */
  folders?: readonly SessionFolder[]
  /** The mirror's link targets (P1-T31): the generated deny rules leave them readable. */
  mirrorReads?: readonly string[]
  git?: string
  hostEnv?: Record<string, string>
  /** Where to clone a URL from (tests point it at a local bare repository). */
  sourceFor?: (url: string) => string
  /**
   * D53 (B4): this computer's credential for a URL the node clones, read
   * outside the sandbox. It reaches the node's own `git clone` through that
   * process's environment only, never the session's.
   */
  cloneAuth?: (url: string) => CredentialScope | null
  timeouts?: { cloneMs?: number; worktreeMs?: number; gitMs?: number }
}

const CLONE_TIMEOUT_MS = 300_000
const WORKTREE_TIMEOUT_MS = 60_000
const GIT_TIMEOUT_MS = 20_000

/**
 * The settings keys that make a folder the node did not make unsafe to run in
 * at Strict and Standard (D26): they would widen the level or run code.
 */
function widenedSettings(folder: string): string[] {
  const dirKind = entryKind(path.join(folder, ".claude"))
  if (dirKind === "none") return []
  if (dirKind !== "directory") return [`.claude (${dirKind})`]
  const found: string[] = []
  for (const rel of REPO_SETTINGS_FILES) {
    const file = path.join(folder, rel)
    const kind = entryKind(file)
    if (kind === "none") continue
    if (kind !== "file") {
      found.push(`${rel} (${kind})`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const settings = parsed as Record<string, unknown>
    const permissions = settings.permissions as Record<string, unknown> | undefined
    if (permissions && typeof permissions === "object" && "allow" in permissions) {
      found.push(`${rel}:permissions.allow`)
    }
    if ("hooks" in settings) found.push(`${rel}:hooks`)
    if ("env" in settings) found.push(`${rel}:env`)
  }
  return found
}

/**
 * D26a: the owner's own `.claude/settings.json` in a folder a session runs in
 * IN PLACE below Open, judged read-only (never rewritten, never hidden from
 * git: it is the owner's working tree). It loads as the project source, so
 * the keys that loosen the level or run code refuse the session, as the
 * filter of a node-made checkout would have dropped them (`filterOwnerSettings`):
 * `permissions.allow`, `ask`, `additionalDirectories`, `defaultMode`, `env`,
 * helpers, status line, MCP, sandbox, and any key not known to be inert.
 * Except `hooks`: the flag layer's `disableAllHooks` (pinnedSettings) keeps a
 * project hook from running below Open, measured on both CLIs
 * (session-inplace.realquery.test.ts). `.claude/settings.local.json` is not
 * judged: the session never loads the local source (`localSettingsDropped`).
 */
export function inPlaceWidenedSettings(folder: string): string[] {
  const dirKind = entryKind(path.join(folder, ".claude"))
  if (dirKind === "none") return []
  if (dirKind !== "directory") return [`.claude (${dirKind})`]
  const rel = ".claude/settings.json"
  const kind = entryKind(path.join(folder, rel))
  if (kind === "none") return []
  if (kind !== "file") return [`${rel} (${kind})`]
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.join(folder, rel), "utf8"))
  } catch {
    return []
  }
  const { filtered } = filterOwnerSettings(parsed)
  return filtered.filter((key) => key !== "hooks").map((key) => `${rel}:${key}`)
}

/**
 * S48 (owner D13): the owner's own runs (a dispatch or an app session on the
 * owner's config) work in the shared folder itself. Sessions run for others
 * (agent_tag, event routines: the isolated config) keep their own checkout.
 */
export function sessionRunsInPlace(session: Pick<JobSession, "source" | "configKind">): boolean {
  // A44 (W3): a taken-over import is an owner session in place too.
  return (
    session.configKind === "owner" &&
    (session.source === "dispatch" || session.source === "app" || session.source === "import")
  )
}

function refuseWidenedInPlace(folder: string): void {
  const widened = inPlaceWidenedSettings(folder)
  if (widened.length === 0) return
  throw new WorkspaceError(
    `settings_refused: ${widened.join(", ")}. This folder's own Claude settings would widen the session's level; run it at Open, or remove those keys.`,
    true,
    "settings_refused",
  )
}

/** A git remote's kind and host: `https://…`, `ssh://…` or scp-like `user@host:path`. */
export function parseRemote(url: string): { kind: "ssh" | "https"; host: string } | null {
  const u = url.trim()
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)[^\s]+$/.exec(u)
  if (scp && !u.includes("://") && !path.isAbsolute(u)) {
    return { kind: "ssh", host: (scp[1] as string).toLowerCase() }
  }
  try {
    const parsed = new URL(u)
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
    if (!host) return null
    if (parsed.protocol === "https:") return { kind: "https", host }
    if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") return { kind: "ssh", host }
  } catch {
    return null
  }
  return null
}

/**
 * P1b B8: a URL the node clones for a session: https or ssh (scp-like or
 * ssh://) only. Never a local path, file://, a transport helper (`ext::`,
 * `fd::`) or anything git would read as an option.
 */
export function isCloneableUrl(url: string): boolean {
  const u = url.trim()
  if (!u || u.startsWith("-") || /\s/.test(u)) return false
  if (/^[A-Za-z0-9+.-]+::/.test(u)) return false
  return parseRemote(u) !== null
}

/**
 * True when `target` (resolved through links) is inside one of the folders,
 * each resolved through its own links first (P1b-fix F5). Deny by default: a
 * folder that resolves to the home itself or above it (a link to ~, /,
 * /Users) confines nothing.
 */
function insideAny(target: string, folders: readonly SessionFolder[], home: string): boolean {
  const real = (p: string): string | null => {
    try {
      return realpathSync.native(p)
    } catch {
      return null
    }
  }
  const t = real(target) ?? path.resolve(target)
  const realHome = real(home) ?? path.resolve(home)
  const within = (child: string, parent: string) => {
    const rel = path.relative(parent, child)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  }
  return folders.some((f) => {
    // A root that is gone matches only a target that is gone too (then: folder_missing).
    const root = real(f.path) ?? path.resolve(f.path)
    if (within(realHome, root)) return false
    return within(t, root)
  })
}

/**
 * S52 (batch-4 F5): the session's cwd below the shared folder its row names,
 * `/`-separated ("" for the folder itself), matched by real path against the
 * one shared folder of that name, never by looking for the name in the cwd
 * (a subfolder may bear the folder's own name). Null when the node shares no
 * single folder of that name, or the cwd is not inside it: "Open in VS Code"
 * then opens the folder itself.
 */
export function folderRelativeCwd(
  folders: readonly SessionFolder[],
  folderName: string,
  cwd: string,
): string | null {
  const named = folders.filter((f) => f.name === folderName)
  if (named.length !== 1) return null
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return path.resolve(p)
    }
  }
  const rel = path.relative(real((named[0] as SessionFolder).path), real(cwd))
  if (rel === "") return ""
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) return null
  return rel.split(path.sep).join("/")
}

/** The session's branch suffix: the first 4 hex digits of its id, stable per session. */
function sessionHex(id: string): string {
  return `${id.toLowerCase().replace(/[^0-9a-f]/g, "")}0000`.slice(0, 4)
}

function branchSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "session"
}

/**
 * D40 (OPEN-5, G4): an in-place owner session below Open that finishes with a
 * commit or a pull request never commits on the folder's default or protected
 * branch. HEAD stays write-denied in the session's sandbox, so the node, as
 * trusted code outside it, starts the session's branch at run start:
 * `git switch -c liaison/<session>-<folder>` (a new branch at HEAD: no file or
 * index change, the owner's uncommitted work carried). On any other branch,
 * nothing happens. Behind the G4 flag (`IN_PLACE_NEW_BRANCH_BELOW_OPEN`).
 * Returns the branch made (and sets it on the workspace), or null.
 */
export function makeInPlaceBranch(args: InPlaceBranchArgs): { name: string; from: string } | null {
  const made = parentInPlaceBranch(args)
  makeNestedBranches(args)
  return made
}

type InPlaceBranchArgs = Parameters<typeof parentInPlaceBranch>[0]

/** The session dir's record of the branches the node made in submodules: work tree (relative) → name. */
const NESTED_BRANCH_FILE = "node-branch-nested.json"

function readNestedBranches(file: string | null): Record<string, string> {
  if (!file || entryKind(file) !== "file") return {}
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (!v || typeof v !== "object" || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, name] of Object.entries(v as Record<string, unknown>)) {
      if (typeof name === "string" && name.startsWith("liaison/")) out[k] = name
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The parent's branch step for each submodule (D40 for nested repos). A
 * submodule on its default or a protected branch, or detached (git's usual
 * state for one), gets a branch the node makes outside the sandbox:
 * `git switch -c liaison/<session>-<submodule>` at the same commit, its work
 * tree untouched; a resume switches back to the recorded one. HEAD stays
 * write-denied, so the session's grant there is that new ref only. When the
 * step does not apply (Open, no finish, the flag off), such a submodule gets
 * no branch at all: the session never moves its default branch.
 */
function makeNestedBranches(args: InPlaceBranchArgs): void {
  const { workspace: ws, session } = args
  const nested = ws.nested ?? []
  if (nested.length === 0) return
  const enabled = args.enabled ?? IN_PLACE_NEW_BRANCH_BELOW_OPEN
  const applies =
    enabled &&
    !!ws.inPlace &&
    levelRow(session.level).destructiveGitDenied &&
    (session.finishWith ?? "pr") !== "none"
  const git = args.git ?? "git"
  const env = args.hostEnv ?? hostGitEnv()
  const ms = args.gitMs ?? GIT_TIMEOUT_MS
  const short =
    session.id
      .toLowerCase()
      .replace(/[^0-9a-z]/g, "")
      .slice(0, 8) || "session"
  const recordFile = args.sessionDir ? path.join(args.sessionDir, NESTED_BRANCH_FILE) : null
  const recorded = readNestedBranches(recordFile)
  let changed = false
  const top = ws.repoDir ?? ws.cwd
  for (const n of nested) {
    const key = path.relative(top, n.checkout).split(path.sep).join("/")
    const guarded = new Set(
      [...NODE_PROTECTED_BRANCHES, ...(n.defaultBranch ? [n.defaultBranch] : [])].map((b) =>
        b.toLowerCase(),
      ),
    )
    const current = n.branch
    const rec = recorded[key]
    if (current && rec && current.toLowerCase() === rec.toLowerCase()) continue
    if (current && !guarded.has(current.toLowerCase())) continue
    delete n.branch
    if (!applies) continue
    if (session.folderHeldBy?.trim()) {
      throw new WorkspaceNeedsYou(
        `Another Liaison session, ${session.folderHeldBy.trim()}, is using this folder; this one would switch the branch of its submodule ${key} under it. Finish or stop that session, then reply.`.slice(
          0,
          300,
        ),
      )
    }
    const g = (gitArgs: string[]) =>
      spawnSync(git, ["-C", n.checkout, ...OWNER_REPO_GUARD, ...gitArgs], {
        env,
        encoding: "utf8",
        timeout: ms,
        killSignal: "SIGKILL",
      })
    if (rec && g(["show-ref", "--verify", "--quiet", `refs/heads/${rec}`]).status === 0) {
      const out = g(["switch", "-q", rec])
      if (out.status !== 0) {
        const text = (out.stderr || out.stdout || String(out.error ?? ""))
          .replace(/\s+/g, " ")
          .trim()
        throw new WorkspaceNeedsYou(
          `Could not switch the submodule ${key} back to the session's branch ${rec}: ${text}`.slice(
            0,
            300,
          ),
        )
      }
      n.branch = rec
      continue
    }
    const listed = g(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    if (listed.status !== 0) {
      throw new WorkspaceError(
        `the branches of the submodule ${key} could not be read to start the session's own`,
        false,
        "worktree_failed",
      )
    }
    const taken = new Set(
      (listed.stdout ?? "")
        .split("\n")
        .map((b) => b.trim().toLowerCase())
        .filter(Boolean),
    )
    const base = `liaison/${short}-${branchSlug(path.basename(n.checkout))}`
    let name = base
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`
    runStep(
      git,
      ["-C", n.checkout, ...OWNER_REPO_GUARD, "switch", "-q", "-c", name],
      env,
      "git switch",
      ms,
    )
    n.branch = name
    recorded[key] = name
    changed = true
  }
  if (changed && recordFile && args.sessionDir) {
    mkdirSync(args.sessionDir, { recursive: true, mode: 0o700 })
    writeNoFollow(recordFile, `${JSON.stringify(recorded)}\n`, 0o400)
  }
}

function parentInPlaceBranch(args: {
  workspace: SessionWorkspace
  session: Pick<JobSession, "id" | "level" | "finishWith" | "folderHeldBy">
  /** `<nodeRoot>/.sessions/<short>`: where the made branch is recorded, so a resume reuses it (W1-D2). */
  sessionDir?: string
  enabled?: boolean
  git?: string
  hostEnv?: Record<string, string>
  gitMs?: number
}): { name: string; from: string } | null {
  const { workspace: ws, session } = args
  const enabled = args.enabled ?? IN_PLACE_NEW_BRANCH_BELOW_OPEN
  const current = ws.branch
  if (!enabled || !ws.inPlace || !ws.repoDir || !current) return null
  if (!levelRow(session.level).destructiveGitDenied) return null
  if ((session.finishWith ?? "pr") === "none") return null
  const git = args.git ?? "git"
  const env = args.hostEnv ?? hostGitEnv()
  const ms = args.gitMs ?? GIT_TIMEOUT_MS
  const dir = ws.repoDir
  const short =
    session.id
      .toLowerCase()
      .replace(/[^0-9a-z]/g, "")
      .slice(0, 8) || "session"
  const base = `liaison/${short}-${branchSlug(path.basename(dir))}`
  const recordFile = args.sessionDir ? path.join(args.sessionDir, NODE_BRANCH_FILE) : null
  const recorded = recordFile ? readNodeBranch(recordFile) : null
  const exists = (name: string) =>
    spawnSync(
      git,
      ["-C", dir, ...OWNER_REPO_GUARD, "show-ref", "--verify", "--quiet", `refs/heads/${name}`],
      { env, encoding: "utf8", timeout: ms },
    ).status === 0
  // W1-D2: a resume of a session whose branch is already checked out keeps
  // it: the recorded one, or (sessions from before the record) a branch named
  // for this session.
  const fold = current.toLowerCase()
  if (recorded && recorded.name.toLowerCase() === fold) {
    ws.nodeBranch = recorded
    return ws.nodeBranch
  }
  if (!recorded && (fold === base.toLowerCase() || fold.startsWith(`${base.toLowerCase()}-`))) {
    ws.nodeBranch = { name: current, from: ws.defaultBranch ?? current }
    return ws.nodeBranch
  }
  const guarded = new Set(
    [...NODE_PROTECTED_BRANCHES, ...(ws.defaultBranch ? [ws.defaultBranch] : [])].map((b) =>
      b.toLowerCase(),
    ),
  )
  if (!guarded.has(fold)) return null
  // W2-D5: in place, one checkout serves every session in the folder. While
  // another Liaison session holds it (live, paused or waiting on the owner),
  // switching the branch would move that session's work under it: this one
  // parks on the owner with the reason, the checkout untouched.
  const heldBy = session.folderHeldBy?.trim()
  if (heldBy) {
    throw new WorkspaceNeedsYou(
      `Another Liaison session, ${heldBy}, is using this folder on ${current}; this one would switch the branch under it. Finish or stop that session, or switch the folder to another branch, then reply.`.slice(
        0,
        300,
      ),
    )
  }
  const from = current
  // W1-D2: back on the default branch with the session's branch still there:
  // switch to it again (no new branch, uncommitted work carried by git).
  // D56 F1: a switch git refuses (the owner's uncommitted changes would be
  // overwritten) parks the session on the owner, never a new branch.
  if (recorded && exists(recorded.name)) {
    const out = spawnSync(git, ["-C", dir, ...OWNER_REPO_GUARD, "switch", "-q", recorded.name], {
      env,
      encoding: "utf8",
      timeout: ms,
      killSignal: "SIGKILL",
    })
    const timedOut = (out.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
    if (timedOut || (out.status === null && out.signal === "SIGKILL")) {
      throw new WorkspaceError(`git switch timed out after ${ms / 1000} s`, false, "timeout")
    }
    if (out.status !== 0) {
      const text = (out.stderr || out.stdout || String(out.error ?? "")).replace(/\s+/g, " ").trim()
      // The completion's reason holds 300 characters at most.
      throw new WorkspaceNeedsYou(
        `Could not switch the folder back to the session's branch ${recorded.name}: ${text}`.slice(
          0,
          300,
        ),
      )
    }
    ws.branch = recorded.name
    ws.nodeBranch = recorded
    return ws.nodeBranch
  }
  // Existing branches, case-folded (APFS): a taken name gets the next suffix.
  const listed = spawnSync(
    git,
    ["-C", dir, ...OWNER_REPO_GUARD, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { env, encoding: "utf8", timeout: ms },
  )
  if (listed.status !== 0) {
    throw new WorkspaceError(
      "the folder's branches could not be read to start the session's own",
      false,
      "worktree_failed",
    )
  }
  const taken = new Set(
    (listed.stdout ?? "")
      .split("\n")
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean),
  )
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`
  runStep(git, ["-C", dir, ...OWNER_REPO_GUARD, "switch", "-q", "-c", name], env, "git switch", ms)
  ws.branch = name
  ws.nodeBranch = { name, from }
  if (recordFile && args.sessionDir) {
    mkdirSync(args.sessionDir, { recursive: true, mode: 0o700 })
    writeNoFollow(recordFile, `${JSON.stringify(ws.nodeBranch)}\n`, 0o400)
  }
  return ws.nodeBranch
}

/** The session dir's record of the branch the node made for it (W1-D2). */
const NODE_BRANCH_FILE = "node-branch.json"
/** The branch the folder had checked out when the session first started (W1-D2). */
const START_BRANCH_FILE = "start-branch"

function readNodeBranch(file: string): { name: string; from: string } | null {
  if (entryKind(file) !== "file") return null
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; from?: unknown }
    return typeof v.name === "string" && typeof v.from === "string" && v.name.startsWith("liaison/")
      ? { name: v.name, from: v.from }
      : null
  } catch {
    return null
  }
}

/** A branch name that may be a repository's default: never HEAD, a node worktree's or a session's own. */
const defaultBranchCandidate = (b: string | undefined): b is string =>
  !!b && b !== "HEAD" && !b.startsWith("node/") && !b.startsWith("liaison/")

/**
 * W1-D2: the branch the folder had checked out when the session first
 * started, recorded once in the session dir (write-denied to the session) and
 * read back on every resume. Never a node or session branch.
 */
function startBranchFor(
  sessionDir: string | undefined,
  repo: string,
  git: string,
  env: Record<string, string>,
  ms: number,
): string | undefined {
  const file = sessionDir ? path.join(sessionDir, START_BRANCH_FILE) : null
  if (file && entryKind(file) === "file") {
    const kept = readFileSync(file, "utf8").trim()
    return defaultBranchCandidate(kept) ? kept : undefined
  }
  const current = currentBranchOf(git, repo, env, ms)
  if (!defaultBranchCandidate(current)) return undefined
  if (file && sessionDir) {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    writeNoFollow(file, `${current}\n`, 0o400)
  }
  return current
}

/** Runs the node's own git (outside the sandbox) with a timeout that names the step. */
function runStep(
  git: string,
  args: string[],
  env: Record<string, string>,
  step: string,
  timeoutMs: number,
  failCode: WorkspaceErrorCode = "worktree_failed",
): string {
  const out = spawnSync(git, args, {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  })
  const timedOut = (out.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  if (timedOut || (out.status === null && out.signal === "SIGKILL")) {
    throw new WorkspaceError(`${step} timed out after ${timeoutMs / 1000} s`, false, "timeout")
  }
  if (out.status !== 0) {
    const text = (out.stderr || out.stdout || String(out.error ?? "")).trim().slice(0, 400)
    throw new WorkspaceError(`${step} failed: ${text}`, false, failCode)
  }
  return (out.stdout ?? "").trim()
}

/** git in the OWNER's repository: none of its hooks or fsmonitor run (D31). */
export const OWNER_REPO_GUARD = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]

/**
 * The repository's default branch, read in the SHARED repo (the owner's
 * checkout, or the node's clone): `origin/HEAD` with the remote stripped; else
 * origin's only branch; else (no remote) the branch the session first started
 * from; else a local `main` or `master`; else the repo's current branch. A
 * `node/` or `liaison/` branch is never the answer: the session's own branch
 * would then be protected, its push refused (P1-walk D11), and every resume
 * would branch again (W1-D2). The fixed protected names apply regardless.
 */
function detectDefaultBranch(
  git: string,
  repo: string,
  env: Record<string, string>,
  ms: number,
  startBranch?: string,
): string | undefined {
  const g = (args: string[]) => {
    const r = spawnSync(git, ["-C", repo, ...OWNER_REPO_GUARD, ...args], {
      env,
      encoding: "utf8",
      timeout: ms,
    })
    return r.status === 0 ? (r.stdout ?? "").trim() : ""
  }
  const usable = (b: string) => defaultBranchCandidate(b)
  const named = g(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).replace(
    /^[^/]+\//,
    "",
  )
  if (usable(named)) return named
  const tracked = g(["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin/"])
    .split("\n")
    .filter(usable)
  if (tracked.length === 1) return tracked[0]
  if (startBranch && usable(startBranch)) return startBranch
  for (const local of ["main", "master"]) {
    if (
      spawnSync(
        git,
        ["-C", repo, ...OWNER_REPO_GUARD, "show-ref", "--verify", "--quiet", `refs/heads/${local}`],
        { env, encoding: "utf8", timeout: ms },
      ).status === 0
    ) {
      return local
    }
  }
  const current = g(["symbolic-ref", "--short", "-q", "HEAD"])
  return usable(current) ? current : undefined
}

function originUrl(
  git: string,
  repo: string,
  env: Record<string, string>,
  ms: number,
): string | null {
  const r = spawnSync(git, ["-C", repo, ...OWNER_REPO_GUARD, "remote", "get-url", "origin"], {
    env,
    encoding: "utf8",
    timeout: ms,
  })
  const url = r.status === 0 ? (r.stdout ?? "").trim() : ""
  return url || null
}

/** Writes a file the node owns without following a link (fix8 H3); replaces a regular file. */
function writeNoFollow(file: string, body: string, mode: number): void {
  const kind = entryKind(file)
  if (kind !== "none" && kind !== "file") {
    throw new WorkspaceError(`settings_refused: ${file} (${kind})`, true, "settings_refused")
  }
  if (kind === "file") rmSync(file)
  const fd = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  )
  try {
    writeSync(fd, body)
  } finally {
    closeSync(fd)
  }
}

/**
 * D26: in a node-made checkout, the checked-out `.claude/settings.json` is
 * replaced by its filtered form (inert keys, deny rules, enabledPlugins) and
 * hidden from git (skip-worktree); a TRACKED `.claude/settings.local.json`
 * is replaced by the node's (hooks off, the level's deny rules) and hidden the
 * same way. Nothing untracked is ever written (D53, B3).
 */
function guardCheckout(
  checkout: string,
  git: string,
  env: Record<string, string>,
  ms: number,
): boolean {
  const claudeDir = path.join(checkout, ".claude")
  const dirKind = entryKind(claudeDir)
  // D53 (B3): nothing generated lands in the checkout. No .claude folder: the
  // repository tracks no settings, and the guard's own (hooks off, the deny
  // rules) travel in the flag layer (`Options.settings`, pinnedSettings).
  if (dirKind === "none") return false
  if (dirKind !== "directory") {
    throw new WorkspaceError(`settings_refused: .claude (${dirKind})`, true, "settings_refused")
  }
  const tracked = (rel: string) =>
    spawnSync(
      git,
      ["-C", checkout, ...OWNER_REPO_GUARD, "ls-files", "--error-unmatch", "--", rel],
      {
        env,
        encoding: "utf8",
        timeout: ms,
      },
    ).status === 0
  const hide = (rel: string) =>
    runStep(
      git,
      ["-C", checkout, ...OWNER_REPO_GUARD, "update-index", "--skip-worktree", "--", rel],
      env,
      "git update-index",
      ms,
    )
  const shared = path.join(claudeDir, "settings.json")
  if (entryKind(shared) !== "none") {
    let raw: unknown
    try {
      raw = entryKind(shared) === "file" ? JSON.parse(readFileSync(shared, "utf8")) : undefined
    } catch {
      raw = undefined
    }
    const { settings } = filterOwnerSettings(raw ?? {})
    writeNoFollow(shared, `${JSON.stringify(settings, null, 2)}\n`, 0o600)
    if (tracked(".claude/settings.json")) hide(".claude/settings.json")
  }
  // P1b-fix F6: a TRACKED settings.local.json is never rewritten, nor hidden:
  // it stays the repository's, byte for byte, so nothing of the node's can
  // ride an explicit-path commit. The session runs without the local source
  // instead (`localSettingsTracked`), and the node's guardrails travel in the
  // flag layer. An untracked one is never written either (D53, B3).
  if (!tracked(".claude/settings.local.json")) return false
  // Deny by default: a tracked one that is not a plain file is refused as before.
  const localKind = entryKind(path.join(claudeDir, "settings.local.json"))
  if (localKind !== "file") {
    throw new WorkspaceError(
      `settings_refused: .claude/settings.local.json (${localKind})`,
      true,
      "settings_refused",
    )
  }
  return true
}

/**
 * The pre-push hook in the session dir (K8), for the fixed list and the
 * detected default (L12), and the session's own branch in each repository.
 */
function writePrePushHook(
  hooksDir: string,
  defaults: readonly string[],
  opts: { own?: readonly OwnBranch[]; git?: string } = {},
): void {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
  const hook = path.join(hooksDir, "pre-push")
  writeNoFollow(hook, prePushHookScript([...new Set(defaults)], opts), 0o500)
  chmodSync(hook, 0o500)
}

/** Each repository of the workspace (the checkout's, then its submodules') with its own branch. */
function ownBranchesOf(ws: Pick<SessionWorkspace, "gitDir" | "branch" | "nested">): OwnBranch[] {
  return [
    ...(ws.gitDir && ws.branch ? [{ gitDir: ws.gitDir, branch: ws.branch }] : []),
    ...(ws.nested ?? []).flatMap((n) => (n.branch ? [{ gitDir: n.gitDir, branch: n.branch }] : [])),
  ]
}

/**
 * Writes the session's pre-push hook again once its branches are final (the
 * node may have made them after the workspace step, D40), with the real git
 * the hook asks. Only where the workspace step wrote one: a level without the
 * hook gets none.
 */
export function refreshPrePushHook(
  ws: SessionWorkspace,
  hooksDir: string | undefined,
  git?: string,
): void {
  if (!hooksDir || entryKind(path.join(hooksDir, "pre-push")) !== "file") return
  writePrePushHook(
    hooksDir,
    [
      ...(ws.defaultBranch ? [ws.defaultBranch] : []),
      ...(ws.nested ?? []).flatMap((n) => (n.defaultBranch ? [n.defaultBranch] : [])),
    ],
    { own: ownBranchesOf(ws), ...(git ? { git } : {}) },
  )
}

/** The start commit kept in the session dir (write-denied to the session), set once. */
function startCommitFor(
  sessionDir: string | undefined,
  checkout: string,
  git: string,
  env: Record<string, string>,
  ms: number,
): string | undefined {
  const file = sessionDir ? path.join(sessionDir, "start-commit") : null
  if (file && entryKind(file) === "file") {
    const kept = readFileSync(file, "utf8").trim()
    if (/^[0-9a-f]{40,64}$/.test(kept)) return kept
  }
  const head = spawnSync(git, ["-C", checkout, ...OWNER_REPO_GUARD, "rev-parse", "HEAD"], {
    env,
    encoding: "utf8",
    timeout: ms,
  })
  const commit = head.status === 0 ? (head.stdout ?? "").trim() : ""
  if (!commit) return undefined
  if (file && sessionDir) {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    writeNoFollow(file, `${commit}\n`, 0o400)
  }
  return commit
}

function gitFacts(
  git: string,
  checkout: string,
  env: Record<string, string>,
  ms: number,
): { commonDir?: string; gitDir?: string } {
  const r = spawnSync(
    git,
    [
      "-C",
      checkout,
      ...OWNER_REPO_GUARD,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-dir",
    ],
    { env, encoding: "utf8", timeout: ms },
  )
  if (r.status !== 0) return {}
  const [common, dir] = (r.stdout ?? "").trim().split("\n")
  const real = (p?: string) => {
    if (!p) return undefined
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return { commonDir: real(common), gitDir: real(dir) }
}

/** Submodules nest at most this deep (a loop or a pathological tree stops here). */
const NESTED_MAX_DEPTH = 8

/** `child` strictly inside `parent` (both real paths). */
function strictlyInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

/**
 * Every initialised submodule of a checkout, recursively, read by the node's
 * own git with the owner's hooks and fsmonitor off (OWNER_REPO_GUARD): the
 * gitlinks of its index, each one's work tree and git dir. Kept only when its
 * git dir is its own common dir and lies under the parent's `modules/` (a
 * `.git` file or a linked `modules` folder that points anywhere else is
 * refused, and its git dir reported in `foreign`).
 */
export function nestedGitRepos(
  git: string,
  checkout: string,
  parent: { commonDir?: string; gitDir?: string },
  env: Record<string, string>,
  ms: number,
): { nested: NestedGitRepo[]; foreign: string[] } {
  const nested: NestedGitRepo[] = []
  const foreign: string[] = []
  const seen = new Set<string>()
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const walk = (dir: string, commonDir: string, gitDir: string, depth: number) => {
    if (depth >= NESTED_MAX_DEPTH) return
    const ls = spawnSync(git, ["-C", dir, ...OWNER_REPO_GUARD, "ls-files", "--stage", "-z"], {
      env,
      encoding: "utf8",
      timeout: ms,
      maxBuffer: 256 * 1024 * 1024,
    })
    if (ls.status !== 0) return
    const bases = uniqPaths([commonDir, gitDir]).map((b) => path.join(b, "modules"))
    for (const entry of (ls.stdout ?? "").split("\0")) {
      const tab = entry.indexOf("\t")
      if (tab < 0 || !entry.startsWith("160000 ")) continue
      const rel = entry.slice(tab + 1)
      if (!rel || path.isAbsolute(rel) || rel.split("/").some((s) => s === ".." || s === "")) {
        continue
      }
      const sub = path.join(dir, rel)
      if (entryKind(path.join(sub, ".git")) === "none") continue
      // The work tree itself: never a link out of the parent's.
      const subReal = real(sub)
      if (!subReal || subReal !== sub) continue
      const r = spawnSync(
        git,
        [
          "-C",
          sub,
          ...OWNER_REPO_GUARD,
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-common-dir",
          "--git-dir",
        ],
        { env, encoding: "utf8", timeout: ms },
      )
      if (r.status !== 0) {
        // git cannot open it (a moved or linked git dir): still never granted.
        const target = gitfileTarget(sub)
        const d = target ? real(target) : null
        if (d && !seen.has(d) && d !== commonDir && d !== gitDir) foreign.push(d)
        continue
      }
      const [top, common, own] = (r.stdout ?? "").trim().split("\n")
      const subCommon = common ? real(common) : null
      const subGit = own ? real(own) : null
      if (!subCommon || !subGit) continue
      const under = bases.some((b) => strictlyInside(subGit, b))
      const ownTop = !!top && real(top) === subReal
      if (!ownTop || subCommon !== subGit || !under || seen.has(subGit)) {
        // Refused: never granted, its config and hooks denied (never the parent's own).
        for (const d of [subGit, subCommon]) {
          if (!seen.has(d) && d !== commonDir && d !== gitDir) foreign.push(d)
        }
        continue
      }
      seen.add(subGit)
      const branch = currentBranchOf(git, sub, env, ms)
      const defaultBranch = detectDefaultBranch(git, sub, env, ms)
      const remote = originUrl(git, sub, env, ms)
      const parsed = remote ? parseRemote(remote) : null
      const repoPath = remote && parsed ? remoteRepoPath(remote) : null
      nested.push({
        checkout: sub,
        commonDir: subCommon,
        gitDir: subGit,
        ...(branch ? { branch } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        ...(remote && parsed
          ? {
              remoteUrl: remote,
              remoteHost: parsed.host,
              remoteKind: parsed.kind,
              remotePort: urlPort(remote, parsed.kind),
            }
          : {}),
        ...(repoPath ? { remotePath: repoPath } : {}),
      })
      walk(sub, subCommon, subGit, depth + 1)
    }
  }
  const root = real(checkout)
  if (root && parent.commonDir && parent.gitDir) {
    walk(root, parent.commonDir, parent.gitDir, 0)
  }
  return { nested, foreign: uniqPaths(foreign) }
}

/** The git dir a work tree's `.git` file names (`gitdir: <path>`), absolute; null when none. */
function gitfileTarget(workTree: string): string | null {
  const file = path.join(workTree, ".git")
  if (entryKind(file) !== "file") return null
  let text: string
  try {
    text = readFileSync(file, "utf8").slice(0, 4096)
  } catch {
    return null
  }
  const m = /^gitdir: (.+)$/m.exec(text)
  const target = m?.[1]?.trim()
  return target ? path.resolve(workTree, target) : null
}

function uniqPaths(list: readonly string[]): string[] {
  return [...new Set(list)]
}

/** The port a remote URL names, else its protocol's default. */
function urlPort(url: string, kind: "ssh" | "https"): number {
  const fallback = kind === "ssh" ? 22 : 443
  if (!url.includes("://")) return fallback
  try {
    return Number(new URL(url).port) || fallback
  } catch {
    return fallback
  }
}

/** The checked-out branch of a folder, or undefined (detached HEAD, no repo). */
function currentBranchOf(
  git: string,
  checkout: string,
  env: Record<string, string>,
  ms: number,
): string | undefined {
  const r = spawnSync(
    git,
    ["-C", checkout, ...OWNER_REPO_GUARD, "symbolic-ref", "--short", "-q", "HEAD"],
    { env, encoding: "utf8", timeout: ms },
  )
  const name = r.status === 0 ? (r.stdout ?? "").trim() : ""
  return name || undefined
}

/**
 * D53: the real paths of the shared folder's own git worktrees that live
 * OUTSIDE it, the extra roots an import may list, follow and take over in.
 * Only when the folder is a working tree's top level (a subfolder of a repo
 * never opens the rest of that repo); the folder itself and any worktree
 * inside it are left out (the folder already covers them); a bare or gone
 * entry is skipped. Read by the node's own git at each check, with the
 * owner's config and hooks off; never a server or job value. [] when the
 * folder is not a repository or git fails.
 */
export function sharedRepoWorktrees(
  folder: string,
  deps: { git?: string; hostEnv?: Record<string, string>; gitMs?: number } = {},
): string[] {
  let root: string
  try {
    root = realpathSync(folder)
  } catch {
    return []
  }
  if (entryKind(path.join(root, ".git")) === "none") return []
  const git = deps.git ?? "git"
  const env = deps.hostEnv ?? hostGitEnv()
  const timeout = deps.gitMs ?? GIT_TIMEOUT_MS
  const run = (args: string[]) =>
    spawnSync(git, ["-C", root, ...OWNER_REPO_GUARD, ...args], { env, encoding: "utf8", timeout })
  const top = run(["rev-parse", "--show-toplevel"])
  if (top.status !== 0) return []
  try {
    if (realpathSync((top.stdout ?? "").trim()) !== root) return []
  } catch {
    return []
  }
  const listed = run(["worktree", "list", "--porcelain"])
  if (listed.status !== 0) return []
  const out: string[] = []
  for (const block of (listed.stdout ?? "").split("\n\n")) {
    const lines = block.split("\n")
    const at = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length)
    if (!at || lines.includes("bare")) continue
    let real: string
    try {
      real = realpathSync(at)
    } catch {
      continue
    }
    const inFolder =
      real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    if (!inFolder && !out.includes(real)) out.push(real)
  }
  return out
}

/** A registered worktree of `repo` at `dir` on `branch` (K23), from `git worktree list --porcelain`. */
function registeredWorktree(
  git: string,
  repo: string,
  dir: string,
  branch: string,
  env: Record<string, string>,
  ms: number,
): boolean {
  const r = spawnSync(git, ["-C", repo, ...OWNER_REPO_GUARD, "worktree", "list", "--porcelain"], {
    env,
    encoding: "utf8",
    timeout: ms,
  })
  if (r.status !== 0) return false
  let want: string
  try {
    want = realpathSync(dir)
  } catch {
    return false
  }
  for (const block of (r.stdout ?? "").split("\n\n")) {
    const lines = block.split("\n")
    const at = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length)
    const on = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length)
    if (!at || on !== `refs/heads/${branch}`) continue
    try {
      if (realpathSync(at) === want) return true
    } catch {
      // A stale entry: not this one.
    }
  }
  return false
}

/**
 * Prepares where one session works, before its process starts. Throws a
 * WorkspaceError with the session's fail code: `folder_missing`,
 * `worktree_failed` (git's text), `settings_refused` (the keys), `timeout`
 * (the step). Never writes into the owner's folder at Strict and Standard
 * except through git's own `worktree add` (isolated runs and sessions that
 * already have one). An in-place run (S48) writes nothing there at all: not
 * its settings, not its git index (D26a).
 */
export function prepareSessionWorkspace(args: SessionWorkspaceArgs): SessionWorkspace {
  const sub = args.session.cwdSubdir ?? ""
  if (sub !== "" && !safeSubdir(sub)) throw unsafeSubdir()
  if (args.session.worktreePath !== undefined) return prepareImportWorktree(args, sub)
  const ws = prepareWorkspaceAt(args)
  if (sub === "") return ws
  // A44: only in the owner's folder itself; never falls back to the folder,
  // since the transcript the run resumes is the subfolder's (its slug).
  if (!ws.inPlace || ws.kind !== "folder") throw unsafeSubdir()
  return { ...ws, cwd: subfolderOf(ws.cwd, sub), writeDir: ws.cwd }
}

/**
 * D53: a Take over of a session recorded in one of the shared folder's own
 * worktrees outside it. The worktree must be among the ones the node lists
 * itself for that shared folder (`sharedRepoWorktrees`), the folder must be
 * one this computer shares (P1b B8), and the run works in place in that
 * worktree (A44: never a node worktree or clone of it); `cwd` is the
 * recorded subfolder of the worktree by real path, the write scope the
 * worktree. Anything else refuses `unsafe_subdir`.
 */
function prepareImportWorktree(args: SessionWorkspaceArgs, sub: string): SessionWorkspace {
  const { session, ctx } = args
  const wt = session.worktreePath as string
  const folder = session.folderPath
  if (!args.inPlace || session.repo || !folder || !safeWorktreePath(wt)) throw unsafeSubdir()
  if (args.folders !== undefined && !insideAny(folder, args.folders, ctx.home)) {
    throw unsafeSubdir()
  }
  const deps = {
    ...(args.git ? { git: args.git } : {}),
    ...(args.hostEnv ? { hostEnv: args.hostEnv } : {}),
    ...(args.timeouts?.gitMs ? { gitMs: args.timeouts.gitMs } : {}),
  }
  if (!sharedRepoWorktrees(folder, deps).includes(wt)) throw unsafeSubdir()
  const ws = prepareWorkspaceAt({
    ...args,
    session: { ...session, folderPath: wt },
    // The worktree stands in for the folder it belongs to (checked above).
    ...(args.folders !== undefined
      ? {
          folders: [
            ...args.folders,
            { kind: "root" as const, name: session.folderName ?? wt, path: wt },
          ],
        }
      : {}),
  })
  if (!ws.inPlace || ws.kind !== "folder" || ws.cwd !== wt) throw unsafeSubdir()
  if (sub === "") return ws
  return { ...ws, cwd: subfolderOf(ws.cwd, sub), writeDir: ws.cwd }
}

function unsafeSubdir(): WorkspaceError {
  return new WorkspaceError(
    "The session's folder is no longer a folder inside the shared folder",
    true,
    "unsafe_subdir",
  )
}

/**
 * A44: `<folder>/<sub>` by real path, when it is a directory inside the
 * folder's real path (separator-bounded: `/x/app-two` is not in `/x/app`).
 * A symlink out of the folder, a file or a missing folder refuses the run.
 */
function subfolderOf(folder: string, sub: string): string {
  let root: string
  let real: string
  try {
    root = realpathSync(folder)
    real = realpathSync(path.join(folder, ...sub.split("/")))
  } catch {
    throw unsafeSubdir()
  }
  const inside = real !== root && real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  if (!inside) throw unsafeSubdir()
  let isDir = false
  try {
    isDir = statSync(real).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw unsafeSubdir()
  return real
}

function prepareWorkspaceAt(args: SessionWorkspaceArgs): SessionWorkspace {
  const { session, level, ctx } = args
  const row = levelRow(level)
  const guarded = row.id !== "open"
  const git = args.git ?? "git"
  const env = args.hostEnv ?? hostGitEnv()
  const gitMs = args.timeouts?.gitMs ?? GIT_TIMEOUT_MS
  const hex = sessionHex(session.id)
  const hooksDir = guarded && row.prePushHook ? ctx.hooksDir : undefined

  const finish = (
    kind: "worktree" | "clone" | "folder",
    checkout: string,
    extra: Partial<SessionWorkspace>,
  ): SessionWorkspace => {
    const inPlace = kind === "folder"
    // D26a: in place, the owner's settings are judged, never rewritten.
    if (inPlace && guarded) refuseWidenedInPlace(checkout)
    // D11: the shared repo's default, never the new worktree's own HEAD.
    const shared = extra.sourceRepo ?? checkout
    const startBranch = startBranchFor(ctx.sessionDir, shared, git, env, gitMs)
    const defaultBranch = detectDefaultBranch(git, shared, env, gitMs, startBranch)
    const remote = originUrl(git, extra.sourceRepo ?? checkout, env, gitMs)
    const parsed = remote ? parseRemote(remote) : null
    const facts = gitFacts(git, checkout, env, gitMs)
    const nested = guarded
      ? nestedGitRepos(git, checkout, facts, env, gitMs)
      : { nested: [], foreign: [] }
    // S50.2-3: in place, the session's own branch is whatever the folder has
    // checked out (its ref is the one the sandbox lets a commit move); none
    // when HEAD is detached.
    const current = inPlace ? currentBranchOf(git, checkout, env, gitMs) : undefined
    if (hooksDir) {
      const own = extra.branch ?? current
      writePrePushHook(
        hooksDir,
        [
          ...(defaultBranch ? [defaultBranch] : []),
          ...nested.nested.flatMap((n) => (n.defaultBranch ? [n.defaultBranch] : [])),
        ],
        {
          own: ownBranchesOf({ ...facts, ...(own ? { branch: own } : {}), nested: nested.nested }),
        },
      )
    }
    const localSettingsTracked = guarded && !inPlace && guardCheckout(checkout, git, env, gitMs)
    const localSettingsDropped =
      guarded &&
      inPlace &&
      entryKind(path.join(checkout, ".claude", "settings.local.json")) !== "none"
    return {
      cwd: checkout,
      kind,
      repoDir: checkout,
      ...(current ? { branch: current } : {}),
      ...extra,
      ...facts,
      ...(nested.nested.length > 0 ? { nested: nested.nested } : {}),
      ...(nested.foreign.length > 0 ? { foreignGitDirs: nested.foreign } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(parsed ? { remoteKind: parsed.kind, remoteHost: parsed.host } : {}),
      ...(remote && parsed ? { remoteUrl: remote } : {}),
      ...(remote && parsed && remoteRepoPath(remote)
        ? { remotePath: remoteRepoPath(remote) as string }
        : {}),
      ...(hooksDir ? { hooksDir } : {}),
      ...(localSettingsTracked ? { localSettingsTracked: true as const } : {}),
      ...(localSettingsDropped ? { localSettingsDropped: true as const } : {}),
      ...(inPlace ? { inPlace: true as const } : {}),
      startCommit: startCommitFor(ctx.sessionDir, checkout, git, env, gitMs),
    }
  }

  // A repository: a clone keyed by the session (L5), never re-cloned on resume.
  if (session.repo) {
    const cloneDir = ctx.cloneDir
    if (!cloneDir)
      throw new WorkspaceError("no clone folder for this session", false, "worktree_failed")
    const shared = args.folders?.find((f) => f.kind === "repo" && f.name === session.repo)
    // S48: an owner run on a shared repository works in its folder, unless
    // this session already has its clone (no move of live work).
    if (args.inPlace && shared && entryKind(path.join(cloneDir, ".git")) === "none") {
      return inPlaceFolder(shared.path, session.repo)
    }
    if (!shared && !isCloneableUrl(session.repo)) {
      throw new WorkspaceError(
        `${session.repo.slice(0, 200)} is not a repository URL this node clones (https or ssh), nor one of its shared repositories`,
        true,
        "worktree_failed",
      )
    }
    const url = shared ? originUrl(git, shared.path, env, gitMs) : session.repo
    if (!url) {
      throw new WorkspaceError(
        `${session.repo} has no origin remote to clone`,
        false,
        "worktree_failed",
      )
    }
    const branch = `node/${branchSlug(path.basename(cloneDir))}-${hex}`
    if (entryKind(path.join(cloneDir, ".git")) === "none") {
      mkdirSync(path.dirname(cloneDir), { recursive: true, mode: 0o700 })
      runStep(
        git,
        [
          "clone",
          "--quiet",
          "--no-recurse-submodules",
          "--",
          args.sourceFor ? args.sourceFor(url) : url,
          cloneDir,
        ],
        nodeCloneAuthEnv(args.cloneAuth?.(url) ?? null, env),
        "git clone",
        args.timeouts?.cloneMs ?? CLONE_TIMEOUT_MS,
      )
      runStep(git, ["-C", cloneDir, "switch", "-q", "-c", branch], env, "git switch", gitMs)
      if (args.sourceFor) {
        // The clone's origin is the URL the session named, not the test's stand-in.
        runStep(git, ["-C", cloneDir, "remote", "set-url", "origin", url], env, "git remote", gitMs)
      }
      if (hooksDir) {
        // fix8 H1c: also in the clone's own config (the node made it).
        runStep(
          git,
          ["-C", cloneDir, "config", "core.hooksPath", hooksDir],
          env,
          "git config",
          gitMs,
        )
      }
    }
    return finish("clone", cloneDir, { branch })
  }

  /**
   * S48, S50: the owner's folder itself. A repo: the session's git facts read
   * from it, nothing created (no worktree, no branch); the pre-push hook and
   * start commit live in the session dir. Not a repo: the folder as it is.
   */
  function inPlaceFolder(folder: string, label: string): SessionWorkspace {
    let isDir = false
    try {
      isDir = statSync(folder).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      throw new WorkspaceError(`${label} is not on this computer any more`, false, "folder_missing")
    }
    if (entryKind(path.join(folder, ".git")) !== "none") {
      return finish("folder", folder, { sourceRepo: folder })
    }
    if (guarded) refuseWidenedInPlace(folder)
    const dropLocal =
      guarded && entryKind(path.join(folder, ".claude", "settings.local.json")) !== "none"
    return {
      cwd: folder,
      kind: "folder",
      inPlace: true,
      ...(dropLocal ? { localSettingsDropped: true as const } : {}),
    }
  }

  if (session.folderPath) {
    const folder = session.folderPath
    // P1b B8: only inside a folder this computer shares (the job file carries them).
    if (args.folders !== undefined && !insideAny(folder, args.folders, ctx.home)) {
      throw new WorkspaceError(
        `${session.folderName ?? folder} is not inside one of this computer's shared folders`,
        true,
        "folder_missing",
      )
    }
    let isDir = false
    try {
      isDir = statSync(folder).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      throw new WorkspaceError(
        `${session.folderName ?? folder} is not on this computer any more`,
        false,
        "folder_missing",
      )
    }
    const isRepo = entryKind(path.join(folder, ".git")) !== "none"
    if (args.inPlace) {
      // S48: a session that already has its node worktree keeps it on resume.
      const worktreeDir = ctx.worktreeDir
      const branch = `node/${branchSlug(session.folderName ?? path.basename(folder))}-${hex}`
      if (
        guarded &&
        isRepo &&
        worktreeDir &&
        registeredWorktree(git, folder, worktreeDir, branch, env, gitMs)
      ) {
        return finish("worktree", worktreeDir, { branch, sourceRepo: folder })
      }
      return inPlaceFolder(folder, session.folderName ?? folder)
    }
    if (guarded && isRepo) {
      const worktreeDir = ctx.worktreeDir
      if (!worktreeDir) {
        throw new WorkspaceError("no worktree folder for this session", false, "worktree_failed")
      }
      const branch = `node/${branchSlug(session.folderName ?? path.basename(folder))}-${hex}`
      if (!registeredWorktree(git, folder, worktreeDir, branch, env, gitMs)) {
        mkdirSync(path.dirname(worktreeDir), { recursive: true, mode: 0o700 })
        const ms = args.timeouts?.worktreeMs ?? WORKTREE_TIMEOUT_MS
        const exists = spawnSync(
          git,
          [
            "-C",
            folder,
            ...OWNER_REPO_GUARD,
            "rev-parse",
            "--verify",
            "-q",
            `refs/heads/${branch}`,
          ],
          { env, encoding: "utf8", timeout: gitMs },
        )
        runStep(
          git,
          [
            "-C",
            folder,
            ...OWNER_REPO_GUARD,
            "worktree",
            "add",
            "--quiet",
            ...(exists.status === 0 ? [worktreeDir, branch] : ["-b", branch, worktreeDir, "HEAD"]),
          ],
          env,
          "git worktree add",
          ms,
        )
      }
      return finish("worktree", worktreeDir, { branch, sourceRepo: folder })
    }
    if (guarded) {
      const widened = widenedSettings(folder)
      if (widened.length > 0) {
        throw new WorkspaceError(
          `settings_refused: ${widened.join(", ")}`,
          true,
          "settings_refused",
        )
      }
    }
    return { cwd: folder, kind: "folder" }
  }

  mkdirSync(ctx.cwd, { recursive: true, mode: 0o700 })
  return { cwd: ctx.cwd, kind: "default" }
}
