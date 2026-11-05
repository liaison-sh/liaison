// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE UNATTENDED RUN PATH: a node SESSION (P1-T36, spec S13, S14, D26, D27,
// D30, D31; L6-L9, L11, L18, L25).
//
// A node job is one run of a session, started by the shell with
// `--unattended <job file>` and nobody at the computer. It runs as raw Claude
// Code under the level guard:
//
// - `permissionMode: "default"`, set explicitly; bypass is never allowed, and
//   a mode change on the control line is refused.
// - Owner runs load the user, project and local settings, the user source
//   being the node's mirror of the owner's ~/.claude (D26); isolated runs
//   (agent_tag, event-triggered routines) load only the node's local settings
//   over an empty config dir (D27, D51: no project walk-up above the folder).
// - The level decides, whatever the settings say: the PreToolUse guard
//   (levelPreToolUseHook), the OS sandbox around every shell command (failing
//   closed), the dangerous keys pinned in the flag layer and in
//   managedSettings, MCP servers per level (D25).
// - The CLI environment is an allowlist: no Liaison access or refresh token
//   ever reaches it (S8).
// - The executable is the installed Claude Code when it is newer and lives
//   in a write-denied install path, else the bundled one (D30, D44).
// - The system prompt's append is exactly three facts (S13); no agent
//   definition, plugin or runtime note is added by code (L7, L11). The one
//   exception is D52: an isolated session in a repo gets that repo's own
//   tracked CLAUDE.md in a fenced block of the append and its .claude skills,
//   agents and commands as a node-built local plugin, since "project" is off
//   for it (repo-content.ts).
// - The owner's own sessions (a dispatch or an app session on the owner's
//   config) work in the shared folder itself, on its current branch, and
//   write their transcript to the owner's projects (S48, S49, owner D13).
//   Sessions run for others (routines, agent tags) work in a worktree or a
//   clone the node made, on a `node/` branch, behind the pre-push guard (D17,
//   D31).
//
// Refused before anything starts, each with its R9 code: no sandbox for
// Strict or Standard (`sandbox_unavailable`), Liaison tools with no
// connection (`auth_required`), the workspace step's codes (T33), and a
// model the SDK does not offer (`model_unavailable`, never a downgrade, L18).
//
// The run ends with one `job_done` line: done, token_limit (the hard limit
// stopped it, partial text kept), stopped, restart (a level change), aborted
// (the shell said stop), refused or error. `done` says the run ended, not
// that the session is Done: that is the completion signal it carries (the
// session's mark_done or needs_you host tool, or the owner's Mark done,
// latched by session-host-tools.ts). A turn that ends with no SDK task and no
// unread owner message is decided by turn-end.ts (`decideTurnEnd`, P2): the
// latch first, then this session's Atelier state, then, when autonomous, a
// bounded continue with a fixed message, else Needs you with a reason code; a
// done that owes a pull request needs one the node verified (S57). A guided
// run that ends with no signal leaves the session Needs you. Its text never
// decides (S1, S10, D1).

import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import path from "node:path"
import type {
  CanUseTool,
  HookCallback,
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { NODE_IMPORT_LIMITS } from "../../../packages/shared/src/node-import"
import {
  isLevelRaise,
  isNodeLevel,
  levelRow,
  minLevel,
  NODE_LEVELS,
  NODE_PROTECTED_BRANCHES,
  type NodeLevel,
  type NodeLevelRow,
} from "../../../packages/shared/src/node-levels"
import { currentNodeModels, exactOfferedModel } from "../../../packages/shared/src/node-models"
import {
  AUTO_CONTINUE_MAX,
  AUTO_CONTINUE_TEXT,
  AUTONOMY_LEVELS,
  type Autonomy,
  capEvent,
  DRIVEN_ELSEWHERE_CODE,
  EFFORT_LEVELS,
  type EffortLevel,
  FINISH_WITH,
  type FinishWith,
  HOST_MCP_SERVER,
  NODE_PROTOCOL_AUTONOMY,
  NODE_SESSION_CONFIG_KINDS,
  NODE_SESSION_SOURCES,
  type NodeSessionCompletion,
  type NodeSessionConfigKind,
  type NodeSessionEventIn,
  type NodeSessionEventType,
  type NodeSessionSource,
  singleQuestion,
} from "../../../packages/shared/src/node-session-protocol"
import { redactImportEvent } from "../../../packages/shared/src/secret-redaction"
import {
  type AtelierHooks,
  type AtelierSource,
  atelierHooksStatus,
  atelierSourceFor,
  ensureBundledAtelier,
} from "./atelier-bundle"
import { browserTestFilesChanged, browserTestReason } from "./browser-test-card"
import {
  type ChooseClaudeBinaryArgs,
  chooseClaudeBinary,
  claudeInstallPaths,
} from "./claude-binary"
import { appDataDir, realClaudeConfigDir } from "./config-isolation"
import type { McpConfigFile } from "./index"
import { PERMISSION_MODE_REFUSED, readLines, serializeEvent } from "./index"
import {
  findGh,
  findGit,
  folderRelativeCwd,
  hostGitEnv,
  makeInPlaceBranch,
  OWNER_REPO_GUARD,
  parseRemote,
  prepareSessionWorkspace,
  readGhLoginToken,
  refreshPrePushHook,
  type SessionFolder,
  type SessionWorkspace,
  type SessionWorkspaceArgs,
  sessionRunsInPlace,
  WorkspaceError,
  WorkspaceNeedsYou,
} from "./job-workspace"
import { runInteractiveJob } from "./node-interactive"
import { type RepoContent, readRepoContent, repoMemoryBlock } from "./repo-content"
import { readRegularFileNoFollow } from "./safe-read"
import { type LocalModel, liaisonMcpServer, localModelsFrom, readMcpConfig } from "./sdk-runner"
import { SessionAsks, SessionRules } from "./session-asks"
import { AtelierWatch, isAtelierStatePath } from "./session-atelier"
import {
  mirrorReads,
  OWNER_SESSION_ENTRYPOINT,
  prepareSessionConfig,
  ranForServer,
  recordOwnerRun,
  type SessionConfig,
} from "./session-config"
import { SessionControl, SessionInput } from "./session-control"
import {
  type BrokerGh,
  type BrokerRepo,
  type CredentialBroker,
  type CredentialScope,
  readSshConfig,
  remoteRepoPath,
  sshRemoteTarget,
  startCredentialBroker,
  writeGhShim,
  writeGitPushShim,
} from "./session-credentials"
import { type DriverProbe, drivenElsewhere, guardOwnClaude } from "./session-driver"
import { createNormalizeState, EventBatcher, normalize, spillWriter } from "./session-events"
import { CompletionLatch, HOST_TOOL_LINES, hostTools } from "./session-host-tools"
import { readHead } from "./session-import"
import { sessionMcpServers } from "./session-mcp"
import { countLines, lineStart, TranscriptFollow, transcriptFile } from "./transcript-follow"
import {
  AutoContinue,
  decideTurnEnd,
  forgeHostOf,
  refTips,
  type SessionBaseline,
  type TurnEndDecision,
  verifyPr,
} from "./turn-end"
import {
  agentFolderName,
  browserTestCommand,
  gitCredentialFor,
  type JobContext,
  jobShellHome,
  levelPreToolUseHook,
  levelProfile,
  levelSandboxSettings,
  pinnedSettings,
  prepareJobShellHome,
  type SessionGitInfo,
  sandboxSupported,
  sessionEnv,
  untrustedBlock,
} from "./unattended-profile"

/** The flag the shell starts a job with. */
export const UNATTENDED_FLAG = "--unattended"

/** The reason a mode change is refused with while a job runs. */
export const UNATTENDED_JOB = "UnattendedJob"

/**
 * P1-T28 (D18): a session job's profile is its guardrails only, the level
 * and the Liaison tools toggle.
 */
export interface SessionJobProfile {
  level: NodeLevel
  liaisonTools: boolean
}

/**
 * The session a job runs (R7, the shell's job document): what the server
 * resolved at dispatch. Folders on this computer are keyed by its id (L5).
 */
export interface JobSession {
  id: string
  source: NodeSessionSource
  /** An advertised folder (absolute), when the session works in one. */
  folderPath?: string
  folderName?: string
  /** A git URL or a shared repo name (D49), cloned for this session. */
  repo?: string
  model: string
  /** The level this session runs at. */
  level: NodeLevel
  /** The agent's profile level, the node's pin baseline. */
  profileLevel: NodeLevel
  /** D27: the owner's ~/.claude through the mirror, or an empty config. */
  configKind: NodeSessionConfigKind
  liaisonTools: boolean
  /** P3-T05 (R7, D36): this run resumes the session's SDK session. */
  resume?: SessionResume
  /** P3-T23 (D34): this run restarts the session at a new level, from this one. */
  levelChange?: { from: NodeLevel }
  /** Walk D7: the models this node offers (the owner's picker), as the shell names them. */
  offeredModels?: string[]
  /** S24: the reasoning level this run starts at; absent or null, the model's default. */
  effort?: EffortLevel | null
  /**
   * S30: the session's autonomy. `sessionOf` always sets it (guided when the
   * job file names none); absent on a hand-built session means guided.
   */
  autonomy?: Autonomy
  /** S57: how the session finishes; null (a PR in a repo) when the job file names none. */
  finishWith?: FinishWith | null
  /**
   * D43 F10: the node protocol the claiming server advertised; below 4 (a
   * server older than wave 2) no finish step is enforced. Absent: this one.
   */
  serverProtocol?: number
  /**
   * A44 (W3): an import's recorded cwd below its shared folder (relative);
   * the run works there or is refused `unsafe_subdir`. Absent: the folder.
   */
  cwdSubdir?: string
  /**
   * D53: the shared folder's own git worktree outside it that the import ran
   * in (`cwdSubdir` is then relative to it); the workspace accepts it only
   * among the worktrees git lists for the folder, else `unsafe_subdir`.
   */
  worktreePath?: string
  /**
   * W2-D5: another in-place Liaison session holds the folder's checkout (the
   * server's display line); the node then never switches the folder's branch
   * for this session (D40) and parks it on the owner instead.
   */
  folderHeldBy?: string
}

/**
 * S57 (D43 F10): the finish step a repository session owes: the session's
 * choice, a PR by default; none against a server older than wave 2, which
 * offers no choice and expects wave 1's end.
 */
export function finishFor(session: JobSession): FinishWith | null {
  if (session.serverProtocol !== undefined && session.serverProtocol < NODE_PROTOCOL_AUTONOMY) {
    return null
  }
  return session.finishWith ?? "pr"
}

/** Why a run resumes its session (D36, G1; S33 `autonomy`, A28). */
export const RESUME_REASONS = ["offline", "message", "crash", "level", "autonomy"] as const
export type ResumeReason = (typeof RESUME_REASONS)[number]

export interface SessionResume {
  /**
   * Walk D3: absent when the server knows no SDK session (the process ended
   * before its init): the run starts fresh, and a message it carries is
   * still this run's, acked when read.
   */
  sdkSessionId?: string
  after: ResumeReason
  /** `message`: the owner's message command this run starts with. */
  commandId?: string
  /** S51 (D28): the owner sent it confirmed while another Claude Code drove the session. */
  confirmDrivenElsewhere?: true
  /**
   * A62: a taken-over import's first resume: the transcript byte offset its
   * replay reached. Before the SDK starts, the run replays from there.
   */
  catchUpFrom?: number
}

/**
 * G1: the message a run resumed for any reason but the owner's own message
 * starts with (a streaming query needs one to go on).
 */
export function resumeMessage(after: ResumeReason): string {
  const reason =
    after === "offline"
      ? "the computer was offline"
      : after === "level"
        ? "its level changed"
        : after === "autonomy"
          ? "its autonomy changed"
          : "its process ended"
  return `The session was interrupted (${reason}). Continue where you left off.`
}

function resumeOf(raw: unknown): SessionResume | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const known = r.sdkSessionId !== undefined && r.sdkSessionId !== null
  if (
    known &&
    (typeof r.sdkSessionId !== "string" || !/^[A-Za-z0-9-]{1,200}$/.test(r.sdkSessionId))
  )
    return null
  if (!(RESUME_REASONS as readonly unknown[]).includes(r.after)) return null
  if (r.commandId !== undefined && r.commandId !== null) {
    if (typeof r.commandId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(r.commandId)) return null
  }
  return {
    ...(known ? { sdkSessionId: r.sdkSessionId as string } : {}),
    after: r.after as ResumeReason,
    ...(typeof r.commandId === "string" ? { commandId: r.commandId } : {}),
    ...(r.confirmDrivenElsewhere === true ? { confirmDrivenElsewhere: true as const } : {}),
    ...(typeof r.catchUpFrom === "number" &&
    Number.isSafeInteger(r.catchUpFrom) &&
    r.catchUpFrom >= 0
      ? { catchUpFrom: r.catchUpFrom }
      : {}),
  }
}

/** The job file the shell writes (0600) for one run. */
export interface UnattendedJob {
  jobId: string
  /** The Liaison server the job came from (keys the node's secrets file). */
  server: string
  agentId: string
  agentName: string
  /** Informational only: isolation is on whatever it says. */
  agentKind?: string
  model: string
  /**
   * A session job's level profile. An older shell wrote a `{template, config}`
   * shape for My node chat turns, which is still read for them (CAV2); a job
   * file for an unattended job never carries it.
   */
  profile: SessionJobProfile | LegacyChatProfile
  /** Every unattended job runs a session; My node chat turns carry none. */
  session?: JobSession
  /** The folders this node advertises (T38): their config files are write-denied (D25, D31). */
  sharedFolders?: SessionFolder[]
  prompt: string
  trigger?: unknown
  hardTokenLimit?: number | null
  /** `~/Liaison Node` when absent. */
  nodeRoot: string
  /** Present only when the profile has Liaison tools. */
  mcpConfigPath?: string | null
  agentDefinition?: string
  /**
   * An interactive node chat turn (S24, node-interactive.ts) or an unattended
   * job (absent). Interactive turns carry the chat's permission mode and the
   * SDK session they resume.
   */
  kind?: "unattended" | "interactive"
  permissionMode?: "auto" | "manual" | "edit" | "plan"
  resumeSessionId?: string | null
  /** Tests only: the home directory. */
  home?: string
}

/** The profile shape an older shell wrote for My node chat turns (CAV2): read, never acted on. */
export interface LegacyChatProfile {
  template: string
  config: Record<string, unknown>
}

function isLegacyChatProfile(profile: unknown): profile is LegacyChatProfile {
  return (
    !!profile &&
    typeof profile === "object" &&
    typeof (profile as Partial<LegacyChatProfile>).template === "string"
  )
}

function sharedFoldersOf(raw: unknown): SessionFolder[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((f): SessionFolder[] => {
    if (!f || typeof f !== "object") return []
    const { name, path: p, kind } = f as Record<string, unknown>
    if (typeof name !== "string" || typeof p !== "string" || !path.isAbsolute(p)) return []
    if (kind !== "root" && kind !== "repo") return []
    return [{ name, path: p, kind }]
  })
}

/** K25: the user's access token lives in the shell's memory only, never in a job file. */
const ACCESS_TOKEN_KEYS = ["accessToken", "access_token"]

function levelProfileOf(raw: unknown): SessionJobProfile | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  if ("template" in p || "config" in p) return null
  if (!isNodeLevel(p.level) || typeof p.liaisonTools !== "boolean") return null
  return { level: p.level, liaisonTools: p.liaisonTools }
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  return typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : null
}

function sessionOf(raw: unknown): JobSession | null {
  if (!raw || typeof raw !== "object") return null
  const s = raw as Record<string, unknown>
  if (typeof s.id !== "string" || !/^[0-9a-fA-F-]{8,}$/.test(s.id)) return null
  if (!(NODE_SESSION_SOURCES as readonly unknown[]).includes(s.source)) return null
  if (typeof s.model !== "string" || s.model.length === 0) return null
  if (!isNodeLevel(s.level) || !isNodeLevel(s.profileLevel)) return null
  if (!(NODE_SESSION_CONFIG_KINDS as readonly unknown[]).includes(s.configKind)) return null
  if (typeof s.liaisonTools !== "boolean") return null
  const folderPath = optionalText(s.folderPath)
  const folderName = optionalText(s.folderName)
  const repo = optionalText(s.repo)
  if (folderPath === null || folderName === null || repo === null) return null
  if (folderPath !== undefined && !path.isAbsolute(folderPath)) return null
  const resume = resumeOf(s.resume)
  if (resume === null) return null
  let levelChange: { from: NodeLevel } | undefined
  if (s.levelChange !== undefined && s.levelChange !== null) {
    const from = (s.levelChange as { from?: unknown }).from
    if (!isNodeLevel(from)) return null
    levelChange = { from }
  }
  const offeredModels = Array.isArray(s.offeredModels)
    ? s.offeredModels.filter((m): m is string => typeof m === "string" && m.length > 0)
    : undefined
  const effort = s.effort ?? null
  if (effort !== null && !(EFFORT_LEVELS as readonly unknown[]).includes(effort)) return null
  // S30, S57: an unknown value reads as the default, never as autonomous.
  const autonomy: Autonomy = (AUTONOMY_LEVELS as readonly unknown[]).includes(s.autonomy)
    ? (s.autonomy as Autonomy)
    : "guided"
  const finishWith: FinishWith | null = (FINISH_WITH as readonly unknown[]).includes(s.finishWith)
    ? (s.finishWith as FinishWith)
    : null
  const serverProtocol =
    typeof s.serverProtocol === "number" &&
    Number.isInteger(s.serverProtocol) &&
    s.serverProtocol > 0
      ? s.serverProtocol
      : undefined
  // A44: a string the workspace checks (an unsafe one refuses the run there).
  const cwdSubdir = typeof s.cwdSubdir === "string" && s.cwdSubdir !== "" ? s.cwdSubdir : undefined
  if (cwdSubdir !== undefined && cwdSubdir.length > 1024) return null
  // D53: kept as given (even empty) so a bad one refuses the run, never drops to the folder.
  const worktreePath = typeof s.worktreePath === "string" ? s.worktreePath : undefined
  if (worktreePath !== undefined && worktreePath.length > 4096) return null
  // W2-D5: display text only; anything else reads as nobody holding the folder.
  const folderHeldBy =
    typeof s.folderHeldBy === "string" && s.folderHeldBy.trim()
      ? Array.from(s.folderHeldBy.replace(/\p{Cc}+/gu, " ").trim())
          .slice(0, 200)
          .join("")
      : undefined
  return {
    id: s.id,
    source: s.source as NodeSessionSource,
    ...(folderPath ? { folderPath } : {}),
    ...(folderName ? { folderName } : {}),
    ...(repo ? { repo } : {}),
    model: s.model,
    level: s.level,
    profileLevel: s.profileLevel,
    configKind: s.configKind as NodeSessionConfigKind,
    liaisonTools: s.liaisonTools,
    ...(resume ? { resume } : {}),
    ...(levelChange ? { levelChange } : {}),
    ...(offeredModels ? { offeredModels } : {}),
    ...(effort ? { effort: effort as EffortLevel } : {}),
    autonomy,
    finishWith,
    ...(serverProtocol !== undefined ? { serverProtocol } : {}),
    ...(cwdSubdir !== undefined ? { cwdSubdir } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(folderHeldBy ? { folderHeldBy } : {}),
  }
}

export function readJobFile(file: string): UnattendedJob {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UnattendedJob> &
    Record<string, unknown>
  const missing = (["jobId", "server", "agentId", "model", "prompt"] as const).filter(
    (k) => typeof parsed[k] !== "string" || (parsed[k] as string).length === 0,
  )
  if (missing.length > 0) throw new Error(`${file}: missing ${missing.join(", ")}`)
  const session = parsed.session as Record<string, unknown> | undefined
  if (
    ACCESS_TOKEN_KEYS.some(
      (k) => k in parsed || (session && typeof session === "object" && k in session),
    )
  ) {
    throw new Error(`${file}: a job file never carries an access token`)
  }
  const nodeRoot = parsed.nodeRoot || path.join(parsed.home ?? homedir(), "Liaison Node")
  const base = { ...(parsed as UnattendedJob), agentName: parsed.agentName ?? "", nodeRoot }
  if (parsed.kind === "interactive") {
    // CAV2: My node chat turns read as today, template profile included.
    const level = levelProfileOf(parsed.profile)
    if (level) return { ...base, profile: level }
    if (!isLegacyChatProfile(parsed.profile)) {
      throw new Error(`${file}: missing profile`)
    }
    return {
      ...base,
      profile: { template: parsed.profile.template, config: parsed.profile.config ?? {} },
    }
  }
  const profile = levelProfileOf(parsed.profile)
  if (!profile) throw new Error(`${file}: the profile must be {level, liaisonTools}`)
  const parsedSession = sessionOf(parsed.session)
  if (!parsedSession) throw new Error(`${file}: missing or invalid session`)
  const sharedFolders = sharedFoldersOf(parsed.sharedFolders)
  return {
    ...base,
    profile,
    session: parsedSession,
    ...(sharedFolders ? { sharedFolders } : {}),
  }
}

/** A session's folders on this computer: its id without dashes, first 12. */
export function sessionShortName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "session"
}

function folderSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "folder"
}

/** The clone folder's name: the repository's last path segment, never a path. */
export function repoFolderName(repo: string): string {
  const last = repo
    .trim()
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .pop()
    ?.replace(/\.git$/, "")
  return last && /^[A-Za-z0-9._-]+$/.test(last) && !last.startsWith(".") ? last : "repo"
}

/** Where one job runs: today's context, plus the session's own folders (T28). */
export interface SessionJobContext extends JobContext {
  /** The default cwd when the workspace step (T33) picks no checkout. */
  cwd: string
  /** `<nodeRoot>/.sessions/<short>`: guard, mirror and spill files (K8). */
  sessionDir?: string
  /** `<sessionDir>/hooks`: the pre-push hook dir, outside every checkout (K8). */
  hooksDir?: string
  /** `<agentDir>/sessions/<short>/<repo name>`: this session's clone (L5). */
  cloneDir?: string
  /** `<nodeRoot>/worktrees/<folder slug>-<short>`: this session's worktree (D17). */
  worktreeDir?: string
}

export function jobContextFor(job: UnattendedJob, platform: NodeJS.Platform): SessionJobContext {
  const home = job.home ?? homedir()
  const agentDir = path.join(job.nodeRoot, agentFolderName(job.agentName, job.agentId))
  const base = {
    home,
    nodeRoot: job.nodeRoot,
    agentDir,
    ...(job.mcpConfigPath ? { mcpConfigPath: job.mcpConfigPath } : {}),
    platform,
  }
  const session = job.session
  // My node chat: the agent's folder.
  if (!session) return { ...base, cwd: agentDir }
  // L5: every folder is keyed by the session, so a resumed run (a new job of
  // the same session) finds its checkout, edits and transcript again.
  const short = sessionShortName(session.id)
  const sessionDir = path.join(job.nodeRoot, ".sessions", short)
  const cwd =
    session.source === "app" && !session.folderPath && !session.repo
      ? path.join(job.nodeRoot, "sessions", session.id)
      : agentDir
  return {
    ...base,
    cwd,
    sessionDir,
    hooksDir: path.join(sessionDir, "hooks"),
    ...(session.repo
      ? { cloneDir: path.join(agentDir, "sessions", short, repoFolderName(session.repo)) }
      : {}),
    ...(session.folderPath
      ? {
          worktreeDir: path.join(
            job.nodeRoot,
            "worktrees",
            `${folderSlug(session.folderName ?? path.basename(session.folderPath))}-${short}`,
          ),
        }
      : {}),
  }
}

/**
 * S50.7: true when removing `target` would remove one of a workspace's
 * folders (it is that folder or an ancestor of it). Every cleanup of the
 * node's own per-session state checks it; the owner's folder is never one.
 */
export function removesWorkspace(
  target: string,
  workspace: { cwd?: string; repoDir?: string; sourceRepo?: string },
): boolean {
  const t = path.resolve(target)
  return [workspace.cwd, workspace.repoDir, workspace.sourceRepo].some((p) => {
    if (!p) return false
    const rel = path.relative(t, path.resolve(p))
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  })
}

/** One refused tool call, as the job result lists it. */
export interface Refusal {
  tool: string
  reason: string
  detail?: string
}

export interface JobUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * The S17 counter (A34): input tokens, cached ones included, plus output
 * tokens, over every API message of the run (a subagent's included). A
 * streamed message repeats its usage per content block, so it counts once,
 * with its latest figures.
 */
export class UsageCounter {
  private readonly byMessage = new Map<string, JobUsage>()
  /** Walk D19: the results' own totals, per process (modelUsage is cumulative per process). */
  private endedProcesses: JobUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
  private thisProcess: JobUsage | null = null
  constructor(private readonly limit: number | null | undefined) {}

  add(message: unknown): void {
    const m = message as {
      type?: string
      subtype?: string
      modelUsage?: Record<string, Record<string, unknown>>
      message?: { id?: string; usage?: Record<string, number | null | undefined> }
    }
    // Walk D19: a streamed message carries only its start's output count; the
    // result's modelUsage holds the real totals of the process so far.
    if (m?.type === "system" && m.subtype === "init" && this.thisProcess) {
      this.endedProcesses = addUsage(this.endedProcesses, this.thisProcess)
      this.thisProcess = null
      return
    }
    if (m?.type === "result" && m.modelUsage && typeof m.modelUsage === "object") {
      this.thisProcess = modelUsageTotals(m.modelUsage)
      return
    }
    if (m?.type !== "assistant" || !m.message?.usage) return
    const u = m.message.usage
    const cached = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const input = (u.input_tokens ?? 0) + cached
    const output = u.output_tokens ?? 0
    const id = m.message.id ?? `anon-${this.byMessage.size}`
    this.byMessage.set(id, {
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      totalTokens: input + output,
    })
  }

  snapshot(): JobUsage {
    const total: JobUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    for (const u of this.byMessage.values()) {
      total.inputTokens += u.inputTokens
      total.cachedInputTokens += u.cachedInputTokens
      total.outputTokens += u.outputTokens
      total.totalTokens += u.totalTokens
    }
    const fromResults = this.thisProcess
      ? addUsage(this.endedProcesses, this.thisProcess)
      : this.endedProcesses
    const best: JobUsage = {
      inputTokens: Math.max(total.inputTokens, fromResults.inputTokens),
      cachedInputTokens: Math.max(total.cachedInputTokens, fromResults.cachedInputTokens),
      outputTokens: Math.max(total.outputTokens, fromResults.outputTokens),
      totalTokens: 0,
    }
    best.totalTokens = best.inputTokens + best.outputTokens
    return best
  }

  get exceeded(): boolean {
    return (
      typeof this.limit === "number" && this.limit > 0 && this.snapshot().totalTokens >= this.limit
    )
  }
}

function addUsage(a: JobUsage, b: JobUsage): JobUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/** Walk D19: a result's modelUsage (every model the process called), as the job's usage. */
function modelUsageTotals(byModel: Record<string, Record<string, unknown>>): JobUsage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const out: JobUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }
  for (const u of Object.values(byModel)) {
    if (!u || typeof u !== "object") continue
    const cached = n(u.cacheReadInputTokens) + n(u.cacheCreationInputTokens)
    out.inputTokens += n(u.inputTokens) + cached
    out.cachedInputTokens += cached
    out.outputTokens += n(u.outputTokens)
  }
  out.totalTokens = out.inputTokens + out.outputTokens
  return out
}

/**
 * A62: the events of a transcript's bytes `[from, its size now)`, redacted
 * (S43), read through `TranscriptFollow` (O_NOFOLLOW, the line cap). A
 * transcript gone, not a regular file or shorter than `from` yields one
 * `follow ended transcript_gone` note and nothing else.
 *
 * D49 F5: capped like the import's window (A43, OPEN-9): at most the last
 * `historyBytes` before the resume, from a line start; the lines skipped
 * before it get one `Older lines not imported (N)` note. A generator: each
 * poll's events are handed on before the next read, so the catch-up is
 * streamed into the batcher, never collected whole.
 */
export function* catchUpEvents(
  file: string | null,
  from: number,
  o: { historyBytes?: number; lineBytes?: number } = {},
): Generator<NodeSessionEventIn> {
  const historyBytes = o.historyBytes ?? NODE_IMPORT_LIMITS.historyBytes
  const redact = (e: NodeSessionEventIn): NodeSessionEventIn => capEvent(redactImportEvent(e))
  const note = (text: string, data: Record<string, unknown>) =>
    redact({
      at: new Date().toISOString(),
      type: "system",
      payload: { subtype: "follow", text, data },
    })
  const gone = () =>
    note("The transcript is shorter than what was imported: nothing to catch up", {
      state: "ended",
      why: "transcript_gone",
    })
  let size: number
  try {
    const st = file ? lstatSync(file) : null
    if (!st?.isFile()) {
      yield gone()
      return
    }
    size = st.size
  } catch {
    yield gone()
    return
  }
  if (size < from || !file) {
    yield gone()
    return
  }
  const start = size - from > historyBytes ? lineStart(file, size - historyBytes) : from
  if (start > from) {
    const older = countLines(file, from, start)
    yield note(`Older lines not imported (${older})`, {
      state: "started",
      olderLinesOmitted: older,
    })
  }
  let out: NodeSessionEventIn[] = []
  const follow = new TranscriptFollow({
    file,
    offset: start,
    emit: (events) => out.push(...events),
    state: { ...createNormalizeState(), redact: redactImportEvent },
    transform: redact,
    noFollowOpen: true,
    onShrink: "end",
    maxLineBytes: o.lineBytes ?? NODE_IMPORT_LIMITS.lineBytes,
  })
  while (follow.offset < size && !follow.shrunk) {
    const before = follow.offset
    follow.poll()
    if (follow.shrunk) break
    const batch = out
    out = []
    yield* batch
    if (follow.offset === before) break
  }
  if (follow.shrunk) yield gone()
}

/** S13: where the session's result goes, the append's third line, per source. */
export const RESULT_LINES: Record<NodeSessionSource, string> = {
  dispatch:
    "Your final message is the session's result, shown in Sessions and summarised on the card in the conversation that asked for it.",
  app: "Your final message is the session's result, shown in Sessions.",
  routine: "Your final message is the session's result, posted to the routine's conversation.",
  agent_tag: "Your final message is the session's result, posted back to the person who asked.",
  import: "Your final message is the session's result, shown in Sessions.",
}

/** The level names an owner reads, for the S47 lines. */
const LEVEL_NAMES: Record<NodeLevel, string> = {
  strict: "Strict",
  standard: "Standard",
  open: "Open",
}

/** S47: the levels, lowest first, whose row allows what `allows` tests, as "Standard or Open". */
function levelsAllowing(allows: (row: NodeLevelRow) => boolean): string {
  const names = NODE_LEVELS.map(levelRow)
    .filter(allows)
    .sort((a, b) => a.rank - b.rank)
    .map((row) => LEVEL_NAMES[row.id])
  return names.join(" or ")
}

const servesLocal = (row: NodeLevelRow) => !row.sandbox || row.allowLocalBinding
const startsBrowser = (row: NodeLevelRow) => !row.sandbox || row.machLookups.length > 0

/**
 * S47 (D12): what the session's level allows, generated from its level-table
 * row so the session gives the owner real options (a level) and never invents
 * a settings change. Measured reach (D18, D25): local binding listens on every
 * interface; headless Chromium needs a Mach registration the CLI sandbox does
 * not grant; app launching and Apple events stay outside every sandboxed level.
 * Never names a settings key.
 */
export function levelLines(
  row: NodeLevelRow,
  workspace: {
    /**
     * The session's git runs with Liaison's `core.hooksPath` (a repository
     * with the pre-push guard). Unset: whatever the level row implies.
     */
    pushHook?: boolean
    /** S50.2: the session runs in the owner's own folder (not a worktree). */
    inPlace?: boolean
    /** D40 (OPEN-5, G4): the branch the node made for the session in the owner's folder. */
    nodeBranch?: string
  } = {},
): string[] {
  if (!row.sandbox) {
    return [
      "At this level commands run outside the sandbox: local servers, headless browsers, launching apps and git all work.",
      LEVEL_PINNED_OPEN_LINE,
    ]
  }
  const lines = [
    servesLocal(row)
      ? "At this level you can run local dev servers and test-runner web servers; they listen on all network interfaces, not only localhost."
      : `Local servers cannot listen on a port at this level, not even on localhost: a dev server or a test runner's web server fails to bind, and that needs the owner to switch this session to ${levelsAllowing(servesLocal)} from Liaison.`,
    startsBrowser(row)
      ? "Headless browsers (Playwright, Chromium) can start at this level."
      : row.browserTestRunners.length > 0
        ? // D55: the runners leave the sandbox, one owner approval per run.
          `Headless browsers cannot start inside the sandbox, so a browser test asks the owner first: run the Playwright test runner on its own (${row.browserTestRunners.join(", ")}, with plain arguments, nothing chained, piped or redirected); the owner approves each run, which then runs unsandboxed. Scripts run through npm run or bun run stay sandboxed, where a headless browser cannot start.`
        : `Headless browsers (Playwright, Chromium) cannot start at this level; browser tests need the owner to switch this session to ${levelsAllowing(startsBrowser)}.`,
    `Launching apps (the open command) and Apple events work only at ${levelsAllowing((r) => !r.sandbox)}.`,
  ]
  if (row.destructiveGitDenied || row.prePushHook) {
    const git: string[] = []
    if (row.destructiveGitDenied) git.push("Destructive git commands are refused at this level")
    if (row.prePushHook) {
      git.push(
        `pushing to ${NODE_PROTECTED_BRANCHES.join(", ")} or the repository's default branch is refused: push a branch of your own`,
      )
    }
    lines.push(`${git.join("; ")}.`)
  }
  // S50.2 (F1): in the owner's folder the guard refuses every branch switch;
  // D40: the node made the session's own branch at run start, when it had to.
  if (workspace.inPlace && row.destructiveGitDenied) {
    lines.push(
      workspace.nodeBranch
        ? `You work in the owner's own folder: git commands that switch its branch or rewrite its files (checkout or switch of a branch, rebase, merge, pull, cherry-pick, revert, am, bisect) are refused at this level and need the owner to switch this session to Open. Liaison made the branch ${workspace.nodeBranch} for this session and checked it out: commit on it, then git push origin ${workspace.nodeBranch}.`
        : "You work in the owner's own folder: git commands that switch its branch or rewrite its files (checkout or switch of a branch, rebase, merge, pull, cherry-pick, revert, am, bisect) are refused at this level and need the owner to switch this session to Open. To push your commits, run git branch <name> (it does not switch), then git push origin <name>.",
    )
  }
  // S50.3: only where the session's git actually runs with that hook path.
  if (row.prePushHook && (workspace.pushHook ?? true)) {
    lines.push(
      "Your git commands run with Liaison's push hook; the repository's own git hooks do not run.",
    )
  }
  lines.push(...LEVEL_PINNED_LINES)
  return lines
}

/**
 * W1-D4 (S47): what is pinned, said so the session never offers a settings
 * change as a way out (walk W1: "allow sandbox.network.allowLocalBinding",
 * "allow standalone sleeps in this session's Bash configuration"). Names no
 * settings key: the options it gives are the level and waiting.
 */
export const LEVEL_PINNED_LINES = [
  "The sandbox and permissions are set by Liaison and cannot be changed from settings files: the sandbox's file, network and local-binding rules, the permissions and the Bash tool's rules are fixed for this level. Never propose or make such a change, not in this session and not as advice to the owner: it has no effect.",
  "The Bash tool refuses a standalone sleep, and that rule is fixed too: to wait for something, run a foreground loop that ends when it is true (until <check>; do sleep 2; done), or start a long command with run_in_background; Monitor is not available here.",
  "When something is refused or blocked, do not look for a way around it and do not suggest a configuration change: tell the owner which level it needs (they raise this session's level from Liaison, for example to Open), or that it waits for a level change. Those are the only options; say so in your summary.",
] as const

/** W1-D4: at Open nothing is sandboxed, and the level is still Liaison's to set. */
export const LEVEL_PINNED_OPEN_LINE =
  "Liaison sets this session's level and permissions: never propose editing settings files to change them; if something is still refused, tell the owner."

/** S31 (D3, D17): the fixed block of an autonomous run. */
export const AUTONOMY_LINES = [
  `You run autonomously: never ask the person a question. Decide with sensible, reversible defaults and record your assumptions. Call mcp__${HOST_MCP_SERVER}__needs_you only when you are truly blocked, with the reason. Call mcp__${HOST_MCP_SERVER}__mark_done with a one-line summary when the task is finished.`,
  "Workflow, Monitor, SendMessage and TaskStop are not available here: run subagents with Agent calls in one message, at most 4 at once.",
] as const

/** A32: when Atelier is loaded in the session. */
export const ATELIER_LINE =
  "For a code change, drive it with the Atelier flow (/atelier:atelier <task>) at the depth it warrants."

/** OPEN-6: how a session on another forge reports its merge request. */
export const MERGE_REQUEST_LINE =
  "This repository is not on GitHub, and glab cannot reach its API from this session: after you push your branch, pass the merge-request link that git push prints as prUrl to mark_done; if git push prints none, call needs_you saying so."

/** The tools an autonomous run starts without: each waits on the person (A27). */
export const AUTONOMOUS_DISALLOWED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]

/** S33: the fixed answer to a question tool once the run switched to autonomous. */
export const AUTONOMY_SWITCH_DENIAL =
  "This session is now autonomous: decide with a sensible default and record the assumption."

/**
 * S57 (D32, A29, A40): how a repository session finishes. In place below
 * Open, the branch sentence names the branch the node made (D40, G4), else
 * it is W1's `git branch` line.
 */
export function finishingLines(
  finish: FinishWith,
  opts: { branchSentence: boolean; nodeBranch?: string; remoteHost?: string },
): string[] {
  if (finish === "none") {
    return [
      "When the work is finished, leave the changes uncommitted, then call mark_done with a one-line summary.",
    ]
  }
  const own = `commit on a branch of your own, never the default branch or a protected one (${NODE_PROTECTED_BRANCHES.join(", ")}); never commit .atelier/`
  const lines =
    finish === "pr"
      ? [
          `When the work is finished: run the repository's own checks that guard what may be published (named in its CLAUDE.md or CONTRIBUTING), fix or report what they find; ${own}; push that branch, never the default branch; open a pull request whose body is your summary (outcome, what was tested); the title and body follow the same rules as the code: no absolute or home-relative local paths, no session ids, no names the repository's checks forbid; then call mark_done with the summary and prUrl = the pull request's URL. If the push or the pull request fails, call needs_you with the error and code push_failed instead; never mark_done without the pull request.`,
        ]
      : [
          `When the work is finished: ${own}; do not push; then call mark_done with a one-line summary.`,
        ]
  // OPEN-6 (measured in P2-T09): from a Standard session glab finds its token
  // but its API calls fail TLS verification under the sandbox, so a non-GitHub
  // session reports the link `git push` prints (A29 checks its host).
  if (finish === "pr" && opts.remoteHost && opts.remoteHost !== "github.com") {
    lines.push(MERGE_REQUEST_LINE)
  }
  if (opts.branchSentence) {
    lines.push(
      opts.nodeBranch
        ? `Liaison made the branch ${opts.nodeBranch} for this session: commit on it, never on the default branch.`
        : finish === "pr"
          ? "If you are on the default or a protected branch, run git branch <name>, which does not switch, then git push origin <name>."
          : "If you are on the default or a protected branch, run git branch <name>, which does not switch.",
    )
  }
  return lines
}

/**
 * S13, L7, L8: the system prompt's append is exactly three facts (the node,
 * Sessions, where the result goes), the host-tool lines (S5), what the level
 * allows (S47), then the repo's own memory block of an
 * isolated session in a repo (D52), the untrusted block of a trigger and the
 * token limit, each only when the run carries it. No agent definition,
 * charter, owner memory or runtime note.
 */
export function sessionAppend(
  job: UnattendedJob,
  session: JobSession,
  owner: string,
  repoBlock?: string | null,
  workspace: {
    pushHook?: boolean
    inPlace?: boolean
    /** S57: the session's folder is a git repository (a finish step applies). */
    repo?: boolean
    /** A32: Atelier is loaded in the session (bundled or the user's). */
    atelier?: boolean
    /** D40: the branch the node made for the session in the owner's folder. */
    nodeBranch?: string
    /** OPEN-6: the origin remote's host. */
    remoteHost?: string
  } = {},
): string {
  const row = levelRow(session.level)
  const lines = [
    `This session runs on ${owner}'s Liaison node, their own computer.`,
    `${owner} follows it live in the Sessions app of Liaison.`,
    RESULT_LINES[session.source],
    // S5: the session's own end signal (D1).
    ...HOST_TOOL_LINES,
  ]
  // S31: an autonomous run never asks (D3) and fans out in-turn (D17).
  if (session.autonomy === "autonomous") lines.push(...AUTONOMY_LINES)
  // S57: a repository session finishes by shipping (D32), when the server asks it to.
  const finish = workspace.repo ? finishFor(session) : null
  if (finish) {
    lines.push(
      ...finishingLines(finish, {
        branchSentence: workspace.inPlace === true && row.destructiveGitDenied,
        ...(workspace.nodeBranch ? { nodeBranch: workspace.nodeBranch } : {}),
        ...(workspace.remoteHost ? { remoteHost: workspace.remoteHost } : {}),
      }),
    )
  }
  if (workspace.atelier) lines.push(ATELIER_LINE)
  // S47: what this level allows, from the level table.
  lines.push(
    ...levelLines(row, {
      pushHook: workspace.pushHook,
      inPlace: workspace.inPlace,
      ...(workspace.nodeBranch ? { nodeBranch: workspace.nodeBranch } : {}),
    }),
  )
  if (repoBlock) lines.push(repoBlock)
  const block = untrustedBlock(job.trigger)
  if (block) lines.push(block)
  if (typeof job.hardTokenLimit === "number" && job.hardTokenLimit > 0) {
    lines.push(`This session stops at ${job.hardTokenLimit} tokens.`)
  }
  return lines.join("\n")
}

function refusalDetail(tool: string, input: Record<string, unknown>): string | undefined {
  const value =
    tool === "Bash"
      ? input.command
      : (input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.query)
  return typeof value === "string" ? value.slice(0, 500) : undefined
}

/**
 * D52: the repo an isolated session runs in, and the commit its content is
 * read at: the node's worktree or clone at its kept start commit, or (Open)
 * the owner's own repo folder at its HEAD when the run starts. Null otherwise.
 */
function repoCheckout(
  workspace: SessionWorkspace,
  deps?: Pick<SessionWorkspaceArgs, "git" | "hostEnv">,
): { dir: string; commit: string } | null {
  if (workspace.repoDir && workspace.startCommit) {
    return { dir: workspace.repoDir, commit: workspace.startCommit }
  }
  if (workspace.kind !== "folder" || !existsSync(path.join(workspace.cwd, ".git"))) return null
  const head = spawnSync(
    deps?.git ?? "git",
    [
      "-C",
      workspace.cwd,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "rev-parse",
      "HEAD",
    ],
    { env: deps?.hostEnv ?? hostGitEnv(), encoding: "utf8", timeout: 20_000 },
  )
  const commit = head.status === 0 ? (head.stdout ?? "").trim() : ""
  return commit ? { dir: workspace.cwd, commit } : null
}

function currentUser(): string {
  try {
    return userInfo().username || "the owner"
  } catch {
    return "the owner"
  }
}

/** `npm prefix -g`, run once at start outside the sandbox (T34's install paths), 5 s at most. */
export function globalNpmPrefix(source: Record<string, string | undefined>): string | null {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (typeof v === "string") env[k] = v
  try {
    const r = spawnSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      env,
    })
    const out = r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : ""
    return out && path.isAbsolute(out) && !out.includes("\n") ? out : null
  } catch {
    return null
  }
}

function uniqPaths(values: Array<string | undefined | null>): string[] {
  const out: string[] = []
  for (const v of values) if (v && !out.includes(v)) out.push(v)
  return out
}

export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query

export type JobStatus =
  | "done"
  | "token_limit"
  | "aborted"
  | "stopped"
  | "restart"
  | "refused"
  | "error"

/** B2-3 (D52): a job naming a liaison-node session another server ran (job-routes.ts NODE_FAIL_CODES). */
export const ALREADY_LIAISON = "already_liaison"

export interface UnattendedOutcome {
  status: JobStatus
  /** The node's fail code for refused / error (job-routes.ts NODE_FAIL_CODES). */
  code?: string
  text: string
  refusals: Refusal[]
  usage: JobUsage
  error?: string
  /** The model the SDK said it ran on (its init message), else the one asked for. */
  model?: string
  /** restart (D34): the level the session restarts at, and the SDK session it resumes. */
  level?: NodeLevel
  /**
   * restart (D34, S24): the reasoning level last applied in this run, which
   * the restarted process starts at (null: the model's default). Absent when
   * no set_effort was applied: the job's own effort stands.
   */
  effort?: EffortLevel | null
  /** restart (S33): the autonomy the restarted process starts at, when set_autonomy was applied. */
  autonomy?: Autonomy
  /** restart (S33): an autonomy switch alone (the level is the current one: no level change). */
  restartFor?: "autonomy"
  /** Same shape as My node chat's outcome (node-interactive.ts). */
  sdkSessionId?: string | null
  /**
   * S1, S6, S7: the run's explicit end signal: the session's host tool
   * (latched, on done or token_limit) or the owner's Mark done (on stopped).
   * Absent: no signal, the server ends the session Needs you.
   */
  completion?: NodeSessionCompletion
}

export interface RunUnattendedArgs {
  job: UnattendedJob
  emit: (event: Record<string, unknown>) => void
  control?: AsyncIterable<string>
  /** The bundled Claude Code the sidecar ships (T34's fallback). */
  cliPath?: string | null
  queryFn?: QueryFn
  platform?: NodeJS.Platform
  sourceEnv?: Record<string, string | undefined>
  /** The app's data dir (session config dirs, the shell's home); tests point it at a temp dir. */
  dataDir?: string
  /** The owner's own Claude config dir, mirrored for owner runs (D26). */
  realConfigDir?: string
  /** S51: who else drives an in-place session (tests: a fixed process table). */
  driverProbe?: DriverProbe
  /** W1-D3: ties each claude this run starts to the runner's life (tests: a fake). */
  claudeGuard?: (configDir: string, sessionId: string, watched: Set<number>) => number[]
  /** GF-53: whether Atelier's hooks can run on a PATH (tests: a fixed answer). */
  atelierHooks?: (pathValue: string) => AtelierHooks
  /** `npm prefix -g`; undefined: asked of npm at start. */
  npmPrefix?: string | null
  /** T34's install search, for tests (brew prefixes, the version probe, the bundled version). */
  claudeBinary?: Pick<ChooseClaudeBinaryArgs, "brewPrefixes" | "run" | "bundledVersion">
  /** T33's workspace step, for tests (git, its env, where a URL clones from). */
  workspaceDeps?: Pick<SessionWorkspaceArgs, "git" | "hostEnv" | "sourceFor" | "timeouts">
  /** github.com remotes: this computer's GitHub login, read outside the sandbox. */
  readGhToken?: () => string | null
  /** D43 F4: the ssh config `ssh -G` reads (`-F`), for a fixture; absent, the owner's. */
  sshConfigFile?: string
  /** HTTPS remotes elsewhere: git's own credential for the host (D31). */
  gitCredential?: (host: string) => { username: string; password: string } | null
  /** The real gh behind the session's shim (D53); null: none. Found on the node's PATH when absent. */
  ghPath?: string | null
  /** Where the credential broker's socket folder is made (D53); the system temp dir when absent. */
  credentialSocketBase?: string
  /** How long the SDK's model list may take before the run goes on unchecked. */
  modelCheckMs?: number
  /** The session's waiting requests (P3 resolves them from the owner's commands). */
  asks?: SessionAsks
  /** How long a Stop waits for the interrupted turn's result before closing (D36: 10 s). */
  stopGraceMs?: number
}

const MODEL_CHECK_MS = 30_000
const STOP_GRACE_MS = 10_000

/** The models the started query's SDK offers, or null when it does not say in time. */
async function sdkOfferedModels(run: Query, timeoutMs: number): Promise<LocalModel[] | null> {
  const list = (run as Partial<Query>).supportedModels
  if (typeof list !== "function") return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const infos = await Promise.race([list.call(run), timedOut])
    if (!infos) return null
    return localModelsFrom(infos)
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Every path a Strict or Standard session of this node can write (T34's `writable`). */
function nodeWritable(
  ctx: SessionJobContext,
  advertised: readonly string[],
  source: Record<string, string | undefined>,
): string[] {
  return uniqPaths([
    ctx.nodeRoot,
    ...advertised,
    tmpdir(),
    source.TMPDIR,
    "/tmp",
    "/private/tmp",
    "/private/var/folders",
  ])
}

// P3-T08: the waiting requests and their answers live in session-asks.ts.
export { SessionAsks, sanitizePermissionResult } from "./session-asks"

/** S15: what the result reports about the session's branch (K17). */
export interface SessionResultFacts {
  branch?: string
  pushed?: boolean
  prUrl?: string
}

const RESULT_GIT_MS = 10_000

/**
 * The branch the checkout is on, whether it was pushed, and the PR URL when
 * one was opened. Pushed (K17): `refs/remotes/origin/<branch>` equals HEAD
 * (git updates it on `git push origin <branch>`, with or without -u), else
 * `git ls-remote origin refs/heads/<branch>` (outside the sandbox, 10 s) does.
 * The PR URL only through gh on the session's own PATH, for a github.com remote.
 */
export function sessionResultFacts(
  workspace: SessionWorkspace,
  source: Record<string, string | undefined>,
  sessionPath: string | undefined,
  /**
   * P1-walk D1: whether the session ran a push. Without one the local
   * tracking ref is the answer, and no remote is read (`ls-remote` is a
   * network call, about 2 s, that held the turn's last events).
   */
  readRemote = true,
  /** D43 F4: origin's host with an ssh alias resolved; absent, the URL's. */
  forgeHost?: string,
): SessionResultFacts {
  if (!workspace.repoDir) return {}
  const env: Record<string, string> = { ...hostGitEnv(source) }
  if (source.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = source.SSH_AUTH_SOCK
  const git = (gitArgs: string[]) =>
    spawnSync("git", ["-C", workspace.cwd, ...OWNER_REPO_GUARD, ...gitArgs], {
      env,
      encoding: "utf8",
      timeout: RESULT_GIT_MS,
      killSignal: "SIGKILL",
    })
  const current = git(["symbolic-ref", "--short", "-q", "HEAD"])
  const branch =
    current.status === 0 && typeof current.stdout === "string" && current.stdout.trim()
      ? current.stdout.trim()
      : workspace.branch
  if (!branch) return {}
  const headOut = git(["rev-parse", "HEAD"])
  const head = headOut.status === 0 ? String(headOut.stdout).trim() : ""
  let pushed = false
  if (head) {
    const tracking = git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`])
    if (tracking.status === 0 && String(tracking.stdout).trim() === head) pushed = true
    else if (readRemote) {
      const listed = git(["ls-remote", "origin", `refs/heads/${branch}`])
      if (listed.status === 0 && String(listed.stdout).split(/\s+/)[0] === head) pushed = true
    }
  }
  const facts: SessionResultFacts = { branch, pushed }
  const gh = (sessionPath ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => path.join(dir, "gh"))
    .find((candidate) => existsSync(candidate))
  if (pushed && gh && (forgeHost ?? workspace.remoteHost) === "github.com") {
    const view = spawnSync(gh, ["pr", "view", branch, "--json", "url", "-q", ".url"], {
      cwd: workspace.cwd,
      env: { ...env, HOME: source.HOME ?? env.HOME, GH_PROMPT_DISABLED: "1" },
      encoding: "utf8",
      timeout: RESULT_GIT_MS,
      killSignal: "SIGKILL",
    })
    const url = view.status === 0 ? String(view.stdout).trim() : ""
    if (/^https:\/\/\S+$/.test(url)) facts.prUrl = url
  }
  return facts
}

/**
 * P2-T09: git in the session's cwd and the node's own gh, outside the
 * sandbox, as `sessionResultFacts` runs them (10 s each), for the turn end's
 * PR check (A37). gh is null when the session's PATH has none.
 */
function resultExecs(
  workspace: SessionWorkspace,
  source: Record<string, string | undefined>,
  sessionPath: string | undefined,
) {
  const env: Record<string, string> = { ...hostGitEnv(source) }
  if (source.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = source.SSH_AUTH_SOCK
  const out = (r: ReturnType<typeof spawnSync>) => ({
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
  })
  const git = (gitArgs: string[], input?: string) =>
    out(
      spawnSync("git", ["-C", workspace.cwd, ...OWNER_REPO_GUARD, ...gitArgs], {
        env,
        encoding: "utf8",
        timeout: RESULT_GIT_MS,
        killSignal: "SIGKILL",
        ...(input !== undefined ? { input } : {}),
      }),
    )
  const ghPath = (sessionPath ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => path.join(dir, "gh"))
    .find((candidate) => existsSync(candidate))
  const gh = ghPath
    ? (ghArgs: string[]) =>
        out(
          spawnSync(ghPath, ghArgs, {
            cwd: workspace.cwd,
            env: { ...env, HOME: source.HOME ?? env.HOME ?? "/", GH_PROMPT_DISABLED: "1" },
            encoding: "utf8",
            timeout: RESULT_GIT_MS,
            killSignal: "SIGKILL",
          }),
        )
    : null
  return { git, gh }
}

/** Where the node keeps a session's start for the PR check, in its write-denied session dir. */
export const SESSION_BASELINE_FILE = "finish-baseline.json"

/**
 * D43 F3: when the session started, its cwd's HEAD and every ref's tip then, written by the
 * node at the session's first run and read back by every later run (a resume,
 * a level restart), so a PR the session opened in an earlier run still counts
 * and nothing older ever does. Without a session dir: this run's start.
 */
export function sessionBaseline(
  sessionDir: string | null,
  cwd: string,
  env: Record<string, string>,
  now: () => number = Date.now,
): SessionBaseline {
  const file = sessionDir ? path.join(sessionDir, SESSION_BASELINE_FILE) : null
  if (file) {
    try {
      const kept = JSON.parse(readFileSync(file, "utf8")) as {
        head?: unknown
        at?: unknown
        tips?: unknown
      }
      const head =
        typeof kept.head === "string" && /^[0-9a-f]{40,64}$/.test(kept.head) ? kept.head : null
      if ((head !== null || kept.head === null) && typeof kept.at === "number") {
        const tips = Array.isArray(kept.tips)
          ? kept.tips.filter(
              (t): t is string => typeof t === "string" && /^[0-9a-f]{40,64}$/.test(t),
            )
          : null
        return { head, at: kept.at, ...(tips ? { tips } : {}) }
      }
    } catch {
      // None yet (the first run), or unreadable: written now.
    }
  }
  const git = (gitArgs: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...OWNER_REPO_GUARD, ...gitArgs], {
      env,
      encoding: "utf8",
      timeout: RESULT_GIT_MS,
      killSignal: "SIGKILL",
    })
    return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" }
  }
  const r = git(["rev-parse", "-q", "--verify", "HEAD^{commit}"])
  const out = r.status === 0 ? r.stdout.trim() : ""
  const baseline: SessionBaseline = {
    head: /^[0-9a-f]{40,64}$/.test(out) ? out : null,
    at: now(),
    // Batch-2 F1: every ref's tip at the start, so no branch made before counts.
    tips: refTips(git),
  }
  if (file) {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify(baseline), { mode: 0o600 })
    } catch {
      // Not kept: the next run measures its own start (stricter, never looser).
    }
  }
  return baseline
}

/** S32: the cwd's `git status --porcelain`, as a sha256 (5 s); null outside a repo or on failure. */
function statusFingerprint(
  workspace: SessionWorkspace,
  source: Record<string, string | undefined>,
): string | null {
  if (!workspace.repoDir) return null
  const r = spawnSync("git", ["-C", workspace.cwd, ...OWNER_REPO_GUARD, "status", "--porcelain"], {
    env: hostGitEnv(source),
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
  })
  if (r.status !== 0 || typeof r.stdout !== "string") return null
  return createHash("sha256").update(r.stdout).digest("hex")
}

/** S32: the tools whose successful result is progress. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** A Bash tool call whose command names git and push (D1: worth reading the remote for). */
function ranPush(payload: Record<string, unknown>): boolean {
  if (payload.name !== "Bash") return false
  const command = (payload.input as { command?: unknown } | null)?.command
  return typeof command === "string" && /\bgit\b/.test(command) && /\bpush\b/.test(command)
}

export async function runUnattended(args: RunUnattendedArgs): Promise<UnattendedOutcome> {
  const { job, emit } = args
  const platform = args.platform ?? process.platform
  const refusals: Refusal[] = []
  const counter = new UsageCounter(job.hardTokenLimit)
  let ranOn: string | null = null
  // The session's event stream (T35's batcher), flushed before job_done.
  let batcher: EventBatcher | null = null
  // D53: the session's credential broker, closed with the run.
  let broker: CredentialBroker | null = null
  // Walk D3: events held until the SDK's init go out before the run ends.
  let beforeFinish: (() => void) | null = null
  /** S51: records the transcript's mtime as the node's own last write, once a run ran. */
  let recordOwnWrite: (() => void) | null = null
  // Walk D5: the run's own shell home goes with it.
  let shellHomeToRemove: string | null = null
  const finish = (outcome: Omit<UnattendedOutcome, "refusals" | "usage">): UnattendedOutcome => {
    beforeFinish?.()
    beforeFinish = null
    recordOwnWrite?.()
    recordOwnWrite = null
    const full = { ...outcome, refusals, usage: counter.snapshot(), model: ranOn ?? job.model }
    // Set only once removesWorkspace cleared it, before it was first emptied (S50.7).
    if (shellHomeToRemove) rmSync(shellHomeToRemove, { recursive: true, force: true })
    shellHomeToRemove = null
    batcher?.stop()
    broker?.close()
    broker = null
    emit({ type: "job_done", jobId: job.jobId, ...full })
    return full
  }
  const session = job.session
  if (!session) {
    return finish({
      status: "error",
      code: "error",
      text: "",
      error: "An unattended job runs a session, and this one names none.",
    })
  }
  const ctx = jobContextFor(job, platform)
  const row = levelRow(session.level)
  const sourceEnv = args.sourceEnv ?? process.env

  // ── refusals before anything starts ──
  if (row.sandbox && !sandboxSupported(platform)) {
    return finish({
      status: "refused",
      code: "sandbox_unavailable",
      text: "",
      error: `${row.id === "strict" ? "Strict" : "Standard"} runs every command in a sandbox, and this computer has none.`,
    })
  }
  let mcpFile: McpConfigFile | null = null
  if (session.liaisonTools) {
    if (!job.mcpConfigPath) {
      return finish({
        status: "refused",
        code: "auth_required",
        text: "",
        error: "No Liaison connection for this agent on this node.",
      })
    }
    mcpFile = readMcpConfig(job.mcpConfigPath)
  }

  // ── the session's config, workspace, MCP servers and binary ──
  const realHome = ctx.home
  const dataDir = args.dataDir ?? appDataDir()
  const ownerConfigDir = args.realConfigDir ?? realClaudeConfigDir()
  let config: SessionConfig
  try {
    config = prepareSessionConfig({
      sessionId: session.id,
      configKind: session.configKind,
      level: session.level,
      realConfigDir: ownerConfigDir,
      dataDir,
    })
  } catch (error) {
    return finish({
      status: "error",
      code: "error",
      text: "",
      error: `The session's Claude config could not be prepared: ${(error as Error).message}`,
    })
  }
  // S38 (A14, D4): an owner session gets the bundled Atelier unless its own
  // settings enable the owner's; an isolated run never gets it. The bundled
  // tree is read like the mirror (Strict lists the folders it reads).
  let atelierSource: AtelierSource = atelierSourceFor({
    configKind: session.configKind,
    settingsFile: path.join(config.dir, "settings.json"),
  })
  let bundledAtelier: string | null = null
  let atelierError: string | null = null
  if (atelierSource === "bundled") {
    try {
      bundledAtelier = ensureBundledAtelier(dataDir)
    } catch (error) {
      atelierSource = "none"
      atelierError = (error as Error).message
    }
  }
  const reads = [...mirrorReads(config.dir), ...(bundledAtelier ? [bundledAtelier] : [])]
  const folders = job.sharedFolders ?? []
  const advertised = uniqPaths([...folders.map((f) => f.path), session.folderPath])
  // D53: this computer's credential for a remote, read outside the sandbox
  // once, and kept in the sidecar's memory (never in the session's env).
  let ghToken: string | null | undefined
  const ghLogin = () => {
    if (ghToken === undefined) {
      ghToken = (args.readGhToken ?? (() => readGhLoginToken(sourceEnv)))()
    }
    return ghToken
  }
  const hostCredentials = new Map<string, { username: string; password: string } | null>()
  const hostCredential = (h: string) => {
    if (!hostCredentials.has(h)) {
      hostCredentials.set(
        h,
        (args.gitCredential ?? ((x: string) => gitCredentialFor(x, { env: sourceEnv })))(h),
      )
    }
    return hostCredentials.get(h) ?? null
  }
  const scopeFor = (url: string | undefined): CredentialScope | null => {
    const parsed = url ? parseRemote(url) : null
    const repoPath = url ? remoteRepoPath(url) : null
    if (!parsed || !repoPath) return null
    const github = parsed.host === "github.com"
    const token = github ? ghLogin() : null
    const git =
      parsed.kind !== "https"
        ? null
        : github
          ? token
            ? { username: "x-access-token", password: token }
            : null
          : hostCredential(parsed.host)
    return { host: parsed.host, repoPath, git, ghToken: token }
  }
  let workspace: SessionWorkspace
  try {
    workspace = prepareSessionWorkspace({
      session,
      level: session.level,
      ctx,
      folders,
      // S48 (owner D13): the owner's own runs work in the shared folder itself.
      inPlace: sessionRunsInPlace(session),
      mirrorReads: reads,
      cloneAuth: scopeFor,
      ...args.workspaceDeps,
    })
    // D40 (G4): in the owner's folder below Open, the node itself starts the
    // session's branch when the folder sits on its default or a protected one.
    makeInPlaceBranch({
      workspace,
      session,
      ...(ctx.sessionDir ? { sessionDir: ctx.sessionDir } : {}),
      ...(args.workspaceDeps?.git ? { git: args.workspaceDeps.git } : {}),
      ...(args.workspaceDeps?.hostEnv ? { hostEnv: args.workspaceDeps.hostEnv } : {}),
    })
    // The push hook again, with the session's own branch in each repository
    // now final: an SSH push names that branch only, as the broker holds an
    // HTTPS one. A failure here ends the run (no run without its hook).
    refreshPrePushHook(workspace, workspace.hooksDir, findGit(sourceEnv) ?? undefined)
  } catch (error) {
    // D56 F1: the owner acts first (their changes block the branch switch):
    // the session ends Needs you with git's words, never worktree_failed. The
    // code tells the reader these are the computer's words, not the model's.
    if (error instanceof WorkspaceNeedsYou) {
      return finish({
        status: "done",
        text: error.message,
        completion: { by: "needs_you", reason: error.message, reasonCode: "workspace_blocked" },
      })
    }
    if (error instanceof WorkspaceError) {
      return finish({
        status: error.refused ? "refused" : "error",
        code: error.code ?? "worktree_failed",
        text: "",
        error: error.message,
      })
    }
    return finish({
      status: "error",
      code: "worktree_failed",
      text: "",
      error: `The session's folder could not be prepared: ${String(error)}`,
    })
  }
  // D43 F3: when the session started (its first run), for the PR check.
  const baseline: SessionBaseline = workspace.repoDir
    ? sessionBaseline(ctx.sessionDir ?? null, workspace.cwd, hostGitEnv(sourceEnv))
    : { head: null, at: Date.now() }
  const scratch = path.join(ctx.nodeRoot, ".scratch", sessionShortName(session.id))
  const tmpDir = path.join(scratch, "tmp")
  const cacheDir = path.join(scratch, "cache")
  for (const dir of [tmpDir, cacheDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })

  const mcp = sessionMcpServers({
    level: session.level,
    configKind: session.configKind,
    ...(mcpFile && job.mcpConfigPath
      ? {
          liaison: {
            name: "liaison" as const,
            config: liaisonMcpServer(mcpFile, job.mcpConfigPath),
          },
        }
      : {}),
    ...(workspace.kind !== "default"
      ? {
          folder: {
            path: workspace.cwd,
            isRepoClone: workspace.kind === "clone",
            ...(workspace.startCommit ? { startCommit: workspace.startCommit } : {}),
          },
        }
      : {}),
    realHome,
  })
  // S5: the in-process host server rides beside the configured ones (built
  // once the event stream exists, below); `sessionMcpServers` already skipped
  // any configured server of that name.
  const mcpLoaded = [...mcp.loaded, HOST_MCP_SERVER]

  const npmPrefix = args.npmPrefix !== undefined ? args.npmPrefix : globalNpmPrefix(sourceEnv)
  const installArgs = {
    home: realHome,
    npmPrefix,
    ...(args.claudeBinary?.brewPrefixes ? { brewPrefixes: args.claudeBinary.brewPrefixes } : {}),
  }
  const binary = await chooseClaudeBinary({
    ...installArgs,
    bundledPath: args.cliPath ?? "",
    writable: nodeWritable(ctx, advertised, sourceEnv),
    ...(args.claudeBinary?.run ? { run: args.claudeBinary.run } : {}),
    ...(args.claudeBinary && "bundledVersion" in args.claudeBinary
      ? { bundledVersion: args.claudeBinary.bundledVersion }
      : {}),
  })

  // Walk D2: where ssh really goes for an SSH remote (an alias's HostName, its port).
  const sshTarget =
    workspace.remoteKind === "ssh" && workspace.remoteHost && workspace.remoteUrl
      ? sshRemoteTarget(workspace.remoteUrl, workspace.remoteHost, realHome, (host) =>
          readSshConfig(host, args.sshConfigFile),
        )
      : null
  // D43 F4: the forge the origin is on, an ssh alias resolved to its HostName,
  // for every GitHub-or-not decision and the PR check's host match.
  // Batch-2 F2: ssh.github.com (ssh over 443) is still github.com.
  const forgeHost = forgeHostOf(workspace.remoteHost, sshTarget?.hostname)
  // The hosts the submodules' HTTPS remotes are on, for the Strict allowlist.
  // An SSH remote adds none: the broker pushes it, outside the sandbox.
  const nestedHosts = (workspace.nested ?? []).flatMap((n) =>
    n.remoteKind === "https" && n.remoteHost ? [n.remoteHost] : [],
  )

  // ── the guard: the level profile, the sandbox, the environment, the pins ──
  const profileOpts: Parameters<typeof levelProfile>[2] = {
    // A44: an import in its recorded subfolder still writes in the whole folder.
    sessionFolder: workspace.writeDir ?? workspace.cwd,
    scratch: [scratch],
    ...(workspace.commonDir ? { commonDir: workspace.commonDir } : {}),
    ...(workspace.remoteHost ? { repoHost: workspace.remoteHost } : {}),
    ...(nestedHosts.length > 0 ? { nestedHosts } : {}),
    ...(workspace.remotePath ? { repoPath: workspace.remotePath } : {}),
    // The submodules' default branches are protected too (never pushed to).
    defaultBranches: [
      ...new Set([
        ...(workspace.defaultBranch ? [workspace.defaultBranch] : []),
        ...(workspace.nested ?? []).flatMap((n) => (n.defaultBranch ? [n.defaultBranch] : [])),
      ]),
    ],
    passedMcp: new Set(mcpLoaded),
    mirrorReads: reads,
    advertisedFolders: advertised,
    installPaths: claudeInstallPaths(installArgs),
    ...(ctx.sessionDir ? { sessionDir: ctx.sessionDir } : {}),
    configDir: config.dir,
    ...(workspace.inPlace ? { inPlace: true } : {}),
    ...(workspace.nodeBranch ? { nodeBranch: workspace.nodeBranch.name } : {}),
    // D44: the bundled Atelier, read-only at every level.
    ...(bundledAtelier ? { atelierBundle: bundledAtelier } : {}),
  }
  const p = levelProfile(
    { level: session.level, liaisonTools: session.liaisonTools },
    ctx,
    profileOpts,
  )
  // D53 (B1): the action broker. The node pushes and fetches the session's
  // HTTPS repositories (the origin's and each submodule's) and runs gh,
  // outside the sandbox and with this computer's credentials; the session's
  // git and gh shims send it the arguments and get back only the output.
  let credentialBin: string | undefined
  let ghBinary: string | undefined
  let gitBinary: string | undefined
  const scope = scopeFor(workspace.remoteUrl)
  const realGit = workspace.repoDir ? findGit(sourceEnv) : null
  const protectedNames = [...p.protectedBranches]
  const brokerRepos: BrokerRepo[] = []
  // An SSH remote too (2026-10-22): the node's git signs with the owner's
  // agent; the session holds neither the agent nor a way to the SSH port.
  if (workspace.remoteKind && workspace.remoteUrl && workspace.gitDir) {
    brokerRepos.push({
      gitDir: workspace.gitDir,
      url: workspace.remoteUrl,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      protected: protectedNames,
      credential: scope?.git ?? null,
    })
  }
  for (const n of workspace.nested ?? []) {
    if (!n.remoteKind || !n.remoteUrl) continue
    brokerRepos.push({
      gitDir: n.gitDir,
      url: n.remoteUrl,
      ...(n.branch ? { branch: n.branch } : {}),
      protected: protectedNames,
      credential: scopeFor(n.remoteUrl)?.git ?? null,
    })
  }
  const gh = args.ghPath !== undefined ? args.ghPath : findGh(sourceEnv)
  const ghBin = gh && path.isAbsolute(gh) ? gh : null
  // gh for each repository on github.com: the checkout's, then each submodule's
  // (a GitLab monorepo's GitHub submodule opens its pull request there), each
  // pinned to its own repository and the session's branch in it.
  const ghPlans: BrokerGh[] = []
  if (ghBin && scope?.ghToken && workspace.remotePath && workspace.repoDir) {
    ghPlans.push({
      bin: ghBin,
      token: scope.ghToken,
      repoPath: workspace.remotePath,
      cwd: workspace.cwd,
      branch: workspace.branch ?? null,
      // Unread, it matches no claim: the checkout's plan is still the fallback.
      gitDir: workspace.gitDir ?? "",
      origin: true,
    })
  }
  for (const n of workspace.nested ?? []) {
    const token = scopeFor(n.remoteUrl)?.ghToken
    if (!ghBin || !token || !n.remotePath) continue
    ghPlans.push({
      bin: ghBin,
      token,
      repoPath: n.remotePath,
      cwd: n.checkout,
      branch: n.branch ?? null,
      gitDir: n.gitDir,
    })
  }
  if (realGit && (brokerRepos.length > 0 || ghPlans.length > 0) && ctx.sessionDir) {
    try {
      broker = await startCredentialBroker({
        plan: {
          git: realGit,
          repos: brokerRepos,
          gh: ghPlans,
          // The owner's agent, for an SSH remote: in the node, never the session.
          // ssh picks the key from ~/.ssh/config (write-denied to every session);
          // an ssh command only from this app's own environment: the node's git
          // reads no global git config.
          env: {
            ...hostGitEnv(sourceEnv),
            ...(sourceEnv.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: sourceEnv.SSH_AUTH_SOCK } : {}),
            ...(sourceEnv.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: sourceEnv.GIT_SSH_COMMAND } : {}),
          },
        },
        ...(args.credentialSocketBase ? { socketBase: args.credentialSocketBase } : {}),
      })
      const binDir = path.join(ctx.sessionDir, "bin")
      const firstGh = ghPlans[0]
      if (firstGh && writeGhShim({ binDir, socket: broker.socket, git: realGit })) {
        ghBinary = firstGh.bin
      }
      gitBinary = realGit
      credentialBin = binDir
    } catch {
      // No broker: a push fails for want of a credential (none is in the session).
      broker?.close()
      broker = null
    }
  }
  // An SSH remote is the broker's too (2026-10-22): no SSH proxy and no agent
  // in the sandbox. The nc shim an earlier version left is removed.
  if (ctx.sessionDir) rmSync(path.join(ctx.sessionDir, "bin", "nc"), { force: true })
  // The session's git: push, fetch and pull through the broker; `git push -u`
  // without the config write a session never makes (final walk F2).
  if (realGit && ctx.sessionDir) {
    try {
      const binDir = path.join(ctx.sessionDir, "bin")
      writeGitPushShim({ binDir, git: realGit, ...(broker ? { socket: broker.socket } : {}) })
      credentialBin = binDir
    } catch {
      // No shim: `-u` prints its config error as before; an SSH push still runs.
    }
  }
  const git: SessionGitInfo = {
    ...(credentialBin ? { credentialBin } : {}),
    ...(broker && credentialBin ? { credentialSocket: broker.socket } : {}),
    ...(ghBinary ? { ghBinary } : {}),
    ...(gitBinary ? { gitBinary } : {}),
    ...(workspace.commonDir ? { commonDir: workspace.commonDir } : {}),
    ...(workspace.gitDir ? { gitDir: workspace.gitDir } : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.remoteHost ? { remoteHost: workspace.remoteHost } : {}),
    ...(workspace.remoteKind ? { remoteKind: workspace.remoteKind } : {}),
    ...(workspace.hooksDir ? { hooksDir: workspace.hooksDir } : {}),
    ...(workspace.nested && workspace.nested.length > 0
      ? {
          nested: workspace.nested.map((n) => ({
            checkout: n.checkout,
            commonDir: n.commonDir,
            gitDir: n.gitDir,
            ...(n.branch ? { branch: n.branch } : {}),
            ...(n.remoteHost ? { remoteHost: n.remoteHost } : {}),
            ...(n.remoteKind ? { remoteKind: n.remoteKind } : {}),
          })),
        }
      : {}),
    ...(workspace.foreignGitDirs && workspace.foreignGitDirs.length > 0
      ? { foreignGitDirs: workspace.foreignGitDirs }
      : {}),
  }
  const sandbox = levelSandboxSettings(p, ctx, git)
  // S50.7 (F4): the shell home is emptied now and removed at the end; a session
  // folder at or inside it would go with it, so such a run never starts.
  const shellHomeDir = jobShellHome(dataDir, job.jobId)
  if (removesWorkspace(shellHomeDir, workspace)) {
    return finish({
      status: "error",
      code: "worktree_failed",
      text: "",
      error:
        "The session's folder is inside the node's own run folder, which is emptied for every run.",
    })
  }
  const shellHome = prepareJobShellHome(realHome, shellHomeDir, platform)
  shellHomeToRemove = shellHome
  const env = sessionEnv(p, ctx, sourceEnv, {
    git,
    configDir: config.dir,
    shellHome,
    tmpDir,
    cacheDir,
    author: workspace.repoDir
      ? {
          name: `${job.agentName || "Liaison agent"} (Liaison node)`,
          email: "liaison-node@users.noreply.github.com",
        }
      : null,
    // S31, A26: the Atelier host contract.
    host: {
      autonomy: session.autonomy ?? "guided",
      ...(workspace.repoDir ? { finish: finishFor(session) ?? undefined } : {}),
    },
  })
  // S49 (D26b): an owner session's transcript lands in the owner's projects;
  // a non-SDK entrypoint lets VS Code's and the terminal's /resume pickers
  // list it (they hide sdk-ts/sdk-py/sdk-cli transcripts).
  if (config.projects === "linked") env.CLAUDE_CODE_ENTRYPOINT = OWNER_SESSION_ENTRYPOINT
  const pinned = pinnedSettings(p, sandbox, env)

  /**
   * The level guard at one level (P3-T23: a level change swaps it at once).
   * D56 F2: the runners the running CLI (started at the session's level)
   * still excludes from its sandbox, and this level does not, are refused
   * until the restart.
   */
  const hookFor = (level: NodeLevel) => {
    const own = levelRow(level).browserTestRunners
    const pendingRunners = levelRow(session.level).browserTestRunners.filter(
      (r) => !own.includes(r),
    )
    return levelPreToolUseHook(
      level === session.level
        ? p
        : levelProfile({ level, liaisonTools: session.liaisonTools }, ctx, profileOpts),
      ctx,
      {
        ...(pendingRunners.length > 0 ? { pendingRunners } : {}),
        onDecision: (tool, input, decision) => {
          if (decision.decision !== "deny") return
          const refusal: Refusal = {
            tool,
            reason: decision.reason ?? `${tool}: refused at ${level}`,
            ...(refusalDetail(tool, input) ? { detail: refusalDetail(tool, input) } : {}),
          }
          refusals.push(refusal)
          emit({ type: "job_refusal", jobId: job.jobId, ...refusal })
        },
      },
    )
  }
  let activeHook = hookFor(session.level)
  const hook = (input: unknown, ...rest: unknown[]) => activeHook(input, ...rest)
  // ── the event stream (S5, protocol §Events) ──
  const events = new EventBatcher({
    sessionId: session.id,
    flush: (line) => emit(line as unknown as Record<string, unknown>),
  })
  batcher = events
  const state = createNormalizeState()
  // P3-T19 (S7): a cut tool output stays whole in the session dir.
  if (ctx.sessionDir) state.spill = spillWriter(ctx.sessionDir)
  // Walk D8: Claude Code persists large outputs under the session's config dir.
  state.persistedRoot = config.dir
  // Walk D3: the start facts carry the SDK session id (the server keeps it to
  // resume the session), and the id comes with the SDK's init. Anything the
  // run says before that (a rate-limit notice the CLI sends while its MCP
  // servers connect, a message read, a command applied) waits for it, so the
  // start facts are still the first events.
  let started = false
  const preStart: NodeSessionEventIn[] = []
  const pushEvent = (event: NodeSessionEventIn) => {
    if (started) events.push(event)
    else preStart.push(event)
  }
  const push = (type: NodeSessionEventType, payload: Record<string, unknown>) =>
    pushEvent(capEvent({ at: state.now(), type, payload }))
  // S5, S6: the session's end signal, latched for this run.
  const latch = new CompletionLatch()
  const hostServer = hostTools(latch, (event) => {
    push("system", { subtype: event.subtype, text: event.text })
    events.flushNow()
  })
  // D51: an isolated session (agent_tag, event routine, D27) runs on the node's
  // generated local settings only. With "project", Claude Code walks up the
  // cwd: outside a git repo it reaches ~/.claude/skills as an ancestor
  // project's, and even inside one it loads every ancestor CLAUDE.md (real
  // query, P1 caveats), so a git root is no boundary and "project" goes.
  // P1b-fix F6: a checkout that tracks .claude/settings.local.json keeps it as
  // the repository's and never loads it: the local source is off.
  const settingSources: NonNullable<Options["settingSources"]> = (
    session.configKind === "owner" ? (["user", "project", "local"] as const) : (["local"] as const)
  ).filter(
    (s) =>
      // S50.4: in place, the owner's own settings.local.json is never loaded below Open.
      !((workspace.localSettingsTracked || workspace.localSettingsDropped) && s === "local"),
  )
  // D52: so an isolated session in a repo gets the repo's own content
  // explicitly, from its tracked files at the start commit only.
  let repoContent: RepoContent | null = null
  let repoContentError: string | null = null
  if (session.configKind === "isolated" && ctx.sessionDir) {
    const repo = repoCheckout(workspace, args.workspaceDeps)
    if (repo) {
      try {
        repoContent = readRepoContent({
          repoDir: repo.dir,
          commit: repo.commit,
          pluginDir: path.join(ctx.sessionDir, "repo-plugin"),
          git: args.workspaceDeps?.git ?? "git",
          env: args.workspaceDeps?.hostEnv ?? hostGitEnv(),
        })
      } catch (error) {
        repoContentError = (error as Error).message
      }
    }
  }
  const claudeCode = [binary.version ?? "unknown", binary.source, binary.path]
    .filter(Boolean)
    .join(" ")
  // Set from the control reader too, so never narrowed by the compiler.
  let stop = null as "aborted" | "token_limit" | null
  /** The owner's Stop is under way (D36). */
  let stopping = false
  // ── P3-T05: the owner's commands (D36) and the session's input ──
  const resume = session.resume
  // Walk D3: with no SDK session to continue, the run starts fresh on its prompt.
  const continues = !!resume?.sdkSessionId
  const firstPrompt =
    resume && continues && resume.after !== "message" ? resumeMessage(resume.after) : job.prompt
  // Assigned once the query starts; the control reader starts after that.
  let run = null as unknown as Query
  const control = new SessionControl({
    ...(ctx.sessionDir ? { sessionDir: ctx.sessionDir } : {}),
    jobId: job.jobId,
    emitApplied: (payload) => {
      push("command_applied", payload)
      events.flushNow()
    },
    onOther: (parsed) => {
      if (parsed.type === "set_permission_mode") {
        emit({ type: PERMISSION_MODE_REFUSED, mode: parsed.mode, reason: UNATTENDED_JOB })
      } else if (parsed.type === "abort" || parsed.type === "shutdown") {
        stop = stop ?? "aborted"
        asks.denyAll("The session was stopped.", { outcome: "expired", by: "process_exit" })
        input.close()
        run.close()
      }
    },
  })
  // M1: the message this resume carries is this run's from the start; the
  // runner re-sends it while unacked, and that copy must not reach the CLI.
  if (resume?.after === "message" && resume.commandId) {
    control.take(resume.commandId, 0, "message")
  }
  // ── S51 (owner D13, D28): one driver at a time ──
  // An in-place owner session's transcript is the owner's, so VS Code or a
  // terminal may hold it. Before resuming it, the node checks; held elsewhere
  // and not confirmed by the owner, no run starts: the session says who
  // drives, the message it carried settles `driven_elsewhere` (the web asks
  // for a confirmed resend), and the run ends without a completion, so the
  // session shows Needs you with the reason.
  // ── B2-3 (D52): whose SDK session this is ──
  // A liaison-node transcript is this node's work for the server that ran it
  // (D49 F6). A job that names one (a resume, a Take over and its catch-up)
  // runs only for that server: its session's own record must tie the SDK id
  // to the claiming server. Checked before the transcript is read for
  // anything, so another server's job uploads none of it and never records
  // it as its own.
  if (resume?.sdkSessionId && config.projects === "linked") {
    const file = transcriptFile(ownerConfigDir, workspace.cwd, resume.sdkSessionId)
    const head = file ? await readHead(file) : null
    if (
      head?.entrypoint === OWNER_SESSION_ENTRYPOINT &&
      !ranForServer(session.id, resume.sdkSessionId, job.server, dataDir)
    ) {
      return finish({
        status: "refused",
        code: ALREADY_LIAISON,
        text: "",
        error:
          "This session was run on this computer for another Liaison server: only that server can continue it.",
      })
    }
  }
  const ownTranscript =
    workspace.inPlace && session.configKind === "owner" && ctx.sessionDir
      ? (sdkId: string) => transcriptFile(ownerConfigDir, workspace.cwd, sdkId)
      : null
  const ownWriteFile = ctx.sessionDir ? path.join(ctx.sessionDir, "driver.json") : null
  // W1-D3: every resume also looks for this node's own earlier run of the
  // session still alive (a runner killed outright leaves its claude running):
  // in place against the owner's registry and transcript as well, elsewhere
  // against the session's own config dir alone.
  const inPlaceDriver = ownTranscript !== null && ownWriteFile !== null
  if (resume?.sdkSessionId && !resume.confirmDrivenElsewhere) {
    const verdict = drivenElsewhere(
      {
        jsonl: inPlaceDriver ? (ownTranscript(resume.sdkSessionId) ?? "") : "",
        sessionId: resume.sdkSessionId,
        configDir: inPlaceDriver ? ownerConfigDir : config.dir,
        nodeConfigDir: config.dir,
        ownPids: new Set([process.pid]),
        ownLastWriteMs: inPlaceDriver ? readOwnWrite(ownWriteFile) : null,
        now: Date.now(),
      },
      args.driverProbe,
    )
    if (verdict.elsewhere) {
      const orphan = verdict.orphanPid
      const by =
        orphan !== undefined
          ? `An orphaned Claude process (pid ${orphan})`
          : verdict.via === "vscode"
            ? "VS Code"
            : "another Claude Code"
      // No SDK start: these are the run's only events.
      started = true
      push("system", {
        subtype: "driver",
        text: orphan !== undefined ? `${by} holds this session` : `Driven from ${by}`,
        // D33: an orphan is named by its pid and the CLI's session id, which
        // the desktop's "Stop it" re-checks against the registry and the
        // process table before it signals anything.
        data: {
          elsewhere: true,
          via: verdict.via,
          ...(orphan !== undefined ? { orphanPid: orphan, cliSessionId: resume.sdkSessionId } : {}),
        },
      })
      if (resume.after === "message" && resume.commandId) {
        control.settle(resume.commandId, "failed", DRIVEN_ELSEWHERE_CODE)
      }
      events.flushNow()
      return finish({
        status: "done",
        text:
          orphan !== undefined
            ? `${by} holds this session. Stop it from the desktop app, or send again to resume it here as well.`
            : `${by} is driving this session. Send again to resume it here as well.`,
      })
    }
  }
  // ── A62: a taken-over import's catch-up ──
  // What VS Code or a terminal appended after the import's replay stopped
  // reaches Liaison before this run's own events: the transcript's bytes from
  // the replay's end to its end now, redacted like any import (S43).
  if (
    session.source === "import" &&
    ownTranscript &&
    resume?.sdkSessionId &&
    resume.catchUpFrom !== undefined
  ) {
    for (const event of catchUpEvents(ownTranscript(resume.sdkSessionId), resume.catchUpFrom)) {
      events.push(event)
    }
    events.flushNow()
  }
  // S32 (D15, A2, A36): the auto-continue counters of this run.
  const autoContinue = new AutoContinue()
  const input = new SessionInput({
    onDelivered: (message) => {
      if (!message.commandId) return
      // S6: an owner message reached the CLI: the next turn decides again.
      latch.clear()
      // S32: and it is progress (the continue push, with no commandId, never is).
      autoContinue.progress()
      push("user_message", { text: message.text, commandId: message.commandId })
      control.settle(message.commandId, "applied")
    },
  })

  const startFolderRel = session.folderName
    ? folderRelativeCwd(folders, session.folderName, workspace.cwd)
    : null
  /** The start facts, what was not applied, then the prompt: before any SDK event. */
  const startEvents = (sdkSessionId?: string, tools?: unknown) => {
    if (started) return
    started = true
    if (resume && continues) push("resumed", { after: resume.after })
    // S27, spec §6: the session asks for Artifact (CLAUDE_CODE_ARTIFACT); the
    // start event records whether the CLI's init lists it, and a CLI that does
    // not says so on its own line, never silently.
    const artifact = Array.isArray(tools)
      ? tools.includes("Artifact")
        ? "available"
        : "unavailable"
      : null
    push("system", {
      subtype: "start",
      text: `Claude Code ${binary.version ?? ""} (${binary.source}) started at ${session.level}`
        .replace(/\s+/g, " ")
        .trim(),
      data: {
        ...(sdkSessionId ? { sessionId: sdkSessionId } : {}),
        // P2's seam: the working directory display paths are made relative to.
        cwd: workspace.cwd,
        // S52 (batch-4 F5): the cwd below the session's shared folder, matched
        // by real path here, where the folder's path is known.
        ...(startFolderRel !== null ? { folderRelPath: startFolderRel } : {}),
        // Final walk F1: the session's branch from its first event, not its result.
        ...(workspace.branch ? { branch: workspace.branch } : {}),
        // D40: the branch the node made in the owner's folder, and the one it left.
        ...(workspace.nodeBranch ? { nodeBranch: workspace.nodeBranch } : {}),
        claudeCode,
        claudeCodePath: binary.path || null,
        claudeCodeVersion: binary.version,
        claudeCodeSource: binary.source,
        // D15: the level as a code, so the web says the line in its language.
        level: session.level,
        // S30: the autonomy applied, and the finish step (null: no repository).
        autonomy: session.autonomy ?? "guided",
        finishWith: workspace.repoDir ? finishFor(session) : null,
        configKind: session.configKind,
        configDir: config.dir,
        settingSources,
        mcp: { loaded: mcpLoaded, skipped: mcp.skipped },
        ...(artifact ? { artifact } : {}),
        ...(repoContent
          ? {
              repoContent: {
                commit: repoContent.commit,
                memory: repoContent.memory.map((m) => m.path),
                pluginFiles: repoContent.pluginFiles,
              },
            }
          : {}),
        ...(repoContentError ? { repoContentError } : {}),
        // S38: which Atelier the session has; at Open, where its hooks run
        // (GF-21), whether they can (GF-53).
        atelierSource,
        ...(atelierSource !== "none" && session.level === "open"
          ? { atelierHooks: (args.atelierHooks ?? atelierHooksStatus)(env.PATH ?? "") }
          : {}),
        ...(atelierError ? { atelierError } : {}),
      },
    })
    if (artifact === "unavailable") {
      // The web says it from data (display.ts); the text is for older clients.
      push("system", {
        subtype: "artifact_unavailable",
        text: `Artifact unavailable on CLI ${binary.version ?? "unknown"}`,
        data: { claudeCodeVersion: binary.version },
      })
    }
    if (session.level !== "open") {
      const hooksOff = !row.settingsHooks
      push("system", {
        subtype: "settings_filtered",
        text: [
          hooksOff ? "Hooks are off" : null,
          config.filtered.length > 0 ? `not applied: ${config.filtered.join(", ")}` : null,
          mcp.skipped.length > 0
            ? `MCP servers skipped: ${mcp.skipped.map((m) => m.name).join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join("; "),
        data: { hooksOff, userKeysNotMirrored: config.filtered, mcpSkipped: mcp.skipped },
      })
    }
    // P3-T23 (D34): a run restarted at a new level says so.
    if (session.levelChange) {
      push("level_changed", { from: session.levelChange.from, to: session.level })
    }
    if (resume?.after === "message" && resume.commandId) {
      push("user_message", { text: job.prompt, commandId: resume.commandId })
      control.recordApplied(resume.commandId, 0, "message", "applied")
    } else if (resume && continues) push("user_message", { text: firstPrompt, synthetic: true })
    else push("user_message", { text: job.prompt })
    for (const event of preStart.splice(0)) events.push(event)
  }
  beforeFinish = () => {
    startEvents()
    events.flushNow()
  }

  // ── the waiting requests (S12, D39): no timeout; the owner's commands answer them (T08) ──
  const asks = args.asks ?? new SessionAsks()
  asks.onDecision = (decision) => {
    push("decision", decision as unknown as Record<string, unknown>)
    events.flushNow()
  }
  asks.rules = new SessionRules(ctx.sessionDir, { home: ctx.home, cwd: workspace.cwd })
  // S33: set_autonomy applied in this run (null: none); the next run starts at it.
  let pendingAutonomy = null as Autonomy | null
  const canUseTool: CanUseTool = async (tool, input, opts) => {
    // A stopped session asks nothing more.
    if (stopping) return { behavior: "deny", message: "The session was stopped.", interrupt: true }
    // S31, S33: an autonomous session (from the start, or switched to it in this
    // run) has no question wait on the person: `disallowedTools` takes these
    // tools away, and this denies them too if any path still offers one.
    if (
      (pendingAutonomy ?? session.autonomy ?? "guided") === "autonomous" &&
      AUTONOMOUS_DISALLOWED_TOOLS.includes(tool)
    ) {
      return { behavior: "deny", message: AUTONOMY_SWITCH_DENIAL }
    }
    const requestId = opts.toolUseID || `ask-${randomUUID()}`
    const kind =
      tool === "AskUserQuestion" ? "question" : tool === "ExitPlanMode" ? "plan" : "permission"
    startEvents()
    // D55: a browser test runner leaves the sandbox, so every run asks the
    // owner: no "allow for this session" answer covers it.
    const everyRunAsks =
      tool === "Bash" &&
      typeof input.command === "string" &&
      browserTestCommand(levelRow(session.level), input.command) === "runner"
    // G2: the owner allowed this tool on this target for the session.
    if (kind === "permission" && !everyRunAsks && asks.rules.match(tool, input)) {
      push("system", {
        subtype: "allowed_for_session",
        text: `Allowed for this session: ${tool}`,
        data: { tool },
      })
      push("decision", { requestId, outcome: "allow_session", by: "owner" })
      events.flushNow()
      return { behavior: "allow", updatedInput: input }
    }
    const waiting = asks.ask(requestId, { tool, input, kind }, opts.signal)
    // Walk D18: a confirmed raise waiting for this step restarts now instead.
    queueMicrotask(() => restartIfSafe("ask"))
    if (tool === "AskUserQuestion") push("question", { requestId, questions: input.questions })
    else if (tool === "ExitPlanMode") {
      push("plan_request", { requestId, plan: planText(input, path.join(config.dir, "plans")) })
    } else if (everyRunAsks) {
      // D56 F3: the card says the repository's own code runs with the owner's
      // full rights, and lists the files of that kind changed here.
      const changed = browserTestFilesChanged({
        cwd: workspace.cwd,
        sinceHead: baseline.head,
        sinceMs: baseline.at,
        env: hostGitEnv(sourceEnv),
      })
      push("permission_request", {
        requestId,
        tool,
        input,
        reason: browserTestReason(changed),
        browserTest: changed,
      })
    } else {
      push("permission_request", {
        requestId,
        tool,
        input,
        reason: opts.decisionReason || opts.title || `${tool}: the owner decides`,
      })
    }
    events.flushNow()
    return waiting
  }

  const options: Options = {
    cwd: workspace.cwd,
    model: session.model,
    ...(binary.path ? { pathToClaudeCodeExecutable: binary.path } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: sessionAppend(
        job,
        session,
        currentUser(),
        repoContent ? repoMemoryBlock(repoContent) : null,
        {
          pushHook: !!workspace.hooksDir,
          inPlace: workspace.inPlace === true,
          repo: !!workspace.repoDir,
          ...(workspace.nodeBranch ? { nodeBranch: workspace.nodeBranch.name } : {}),
          ...(forgeHost ? { remoteHost: forgeHost } : {}),
          atelier: atelierSource !== "none",
        },
      ),
    },
    settingSources,
    // S38: merged, never replacing the repo-content entry (an isolated run's).
    ...(repoContent?.pluginDir || bundledAtelier
      ? {
          plugins: [
            ...(repoContent?.pluginDir
              ? [{ type: "local" as const, path: repoContent.pluginDir, skipMcpDiscovery: true }]
              : []),
            ...(bundledAtelier ? [{ type: "local" as const, path: bundledAtelier }] : []),
          ],
        }
      : {}),
    env,
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    settings: pinned.settings as Options["settings"],
    managedSettings: pinned.managedSettings as Options["managedSettings"],
    ...(sandbox ? { sandbox } : {}),
    ...(resume?.sdkSessionId ? { resume: resume.sdkSessionId } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    mcpServers: { ...mcp.servers, [HOST_MCP_SERVER]: hostServer },
    strictMcpConfig: mcp.strictMcpConfig,
    hooks: { PreToolUse: [{ hooks: [hook as HookCallback] }] },
    canUseTool,
    // S31, A27: an autonomous run starts without the tools that wait on the person.
    ...(session.autonomy === "autonomous"
      ? { disallowedTools: [...AUTONOMOUS_DISALLOWED_TOOLS] }
      : {}),
  }

  run = (args.queryFn ?? ((a) => sdkQuery(a)))({ prompt: input, options })

  // L18: the model runs as named or not at all, checked on the started query
  // before the prompt is yielded (no turn is spent on a refusal).
  let offered = await sdkOfferedModels(run, args.modelCheckMs ?? MODEL_CHECK_MS)
  // Walk D7: the session's own CLI may list its models otherwise (aliases
  // resolved under the session's config) than the node's picker, which the
  // owner chose from: a model either offers runs as named.
  const nodeOffered = (session.offeredModels ?? []).map((id) => ({ id }))
  const offeredModel = (model: string, sdk: LocalModel[] | null): string | null =>
    (sdk ? exactOfferedModel(model, sdk) : null) ?? exactOfferedModel(model, nodeOffered)
  if (offered && !offeredModel(session.model, offered)) {
    input.close()
    run.close()
    return finish({
      status: "refused",
      code: "model_unavailable",
      text: "",
      // Only what is offered is listed: never an older version to pick.
      error: `${session.model} is not offered by Claude Code on this computer (offered: ${
        currentNodeModels(offered)
          .map((m) => m.id)
          .join(", ") || "none"
      }).`,
    })
  }
  input.push(firstPrompt)
  let lastText = ""

  // ── the owner's commands (D36) ──
  let currentModel = session.model
  control.handlers.message = ({ payload }, line) => {
    if (stopping) return { outcome: "cancelled" }
    // S9: while exactly one single-question AskUserQuestion waits, the text is its answer.
    const only = singleQuestion(
      asks
        .open()
        .filter((r) => r.kind === "question")
        .map((r) => ({
          type: "question" as const,
          payload: { requestId: r.requestId, questions: r.input.questions },
        })),
    )
    if (only) {
      return asks.decide({
        type: "answer",
        payload: { requestId: only.requestId, answers: { [only.question]: payload.text } },
      })
    }
    input.push(payload.text, line.commandId)
    return null
  }
  control.handlers.permission_decision = (command) =>
    stopping ? { outcome: "noop" } : asks.decide(command)
  control.handlers.answer = (command) => (stopping ? { outcome: "noop" } : asks.decide(command))
  control.handlers.set_model = async ({ payload }) => {
    if (stopping) return { outcome: "noop" }
    offered = offered ?? (await sdkOfferedModels(run, args.modelCheckMs ?? MODEL_CHECK_MS))
    const model = offeredModel(payload.model, offered)
    if (!model) return { outcome: "failed", error: "model_unavailable" }
    if (model === currentModel) return { outcome: "noop" }
    await run.setModel(model)
    push("model_changed", { from: currentModel, to: model })
    currentModel = model
    return { outcome: "applied" }
  }
  // D36's four steps: stop reading queued messages, deny what waits, interrupt,
  // then end the input and close after the next result or 10 s.
  let stopDone: Promise<void> | null = null
  let resultSeen: (() => void) | null = null
  /** S7: the owner's Mark done, which stops the run as Stop does. */
  let ownerDone = null as NodeSessionCompletion | null
  const stopRun = async (line: { commandId: string }) => {
    if (stopping) return { outcome: "noop" as const }
    stopping = true
    let finished: () => void = () => {}
    stopDone = new Promise<void>((resolve) => {
      finished = resolve
    })
    const nextResult = new Promise<void>((resolve) => {
      resultSeen = resolve
    })
    for (const m of input.cancelOutstanding()) {
      if (m.commandId) control.settle(m.commandId, "cancelled")
    }
    asks.denyAll("The session was stopped.", { outcome: "deny", by: "stop" })
    events.flushNow()
    // One deadline bounds the whole stop: the interrupt's receipt may never
    // come (a turn the interrupting deny already ended), the result neither.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), args.stopGraceMs ?? STOP_GRACE_MS)
    })
    // The rest runs apart from the control reader, so a command that comes
    // meanwhile settles at once (a second stop: noop; a message: cancelled).
    void (async () => {
      const receipt = (await Promise.race([run.interrupt().catch(() => undefined), deadline])) as
        | { still_queued?: unknown }
        | undefined
      if (Array.isArray(receipt?.still_queued) && receipt.still_queued.length > 0) {
        push("system", {
          subtype: "still_queued",
          text: `Still queued when stopped: ${receipt.still_queued.length}`,
          data: { count: receipt.still_queued.length },
        })
      }
      await Promise.race([nextResult, deadline])
      if (timer) clearTimeout(timer)
      input.close()
      run.close()
      control.settle(line.commandId, "applied")
      finished()
    })()
    return null
  }
  control.handlers.stop = (_command, line) => stopRun(line)
  // S24: the reasoning level changes in place, from the next API request,
  // through the flag settings (only that key: the pinned settings, the
  // permissions and the sandbox are untouched). The latest applied level
  // travels to a level restart's process (D34).
  let currentEffort: EffortLevel | null = session.effort ?? null
  let effortApplied = false
  control.handlers.set_effort = async ({ payload }) => {
    if (stopping) return { outcome: "noop" }
    const to = payload.effort
    currentEffort = to
    effortApplied = true
    // W1-D9: the server already appended `effort_changed` when it took the
    // command (commands.ts setEffort), so the node adds no second line.
    try {
      await run.applyFlagSettings({ effortLevel: to })
    } catch {
      // An older CLI: the run goes on at its level; the next run starts at this one.
      return { outcome: "applied", error: "applies from the next run" }
    }
    return { outcome: "applied" }
  }
  // S54 (D21): stop one subagent; the SDK emits its task_notification
  // `stopped` and the run goes on.
  control.handlers.stop_task = async ({ payload }) => {
    if (stopping) return { outcome: "noop" }
    try {
      await run.stopTask(payload.taskId)
    } catch {
      return { outcome: "failed", error: "the subagent could not be stopped" }
    }
    return { outcome: "applied" }
  }
  control.handlers.mark_done = ({ payload }, line) => {
    if (stopping) return { outcome: "noop" }
    ownerDone = { by: "owner", ...(payload.summary ? { summary: payload.summary } : {}) }
    return stopRun(line)
  }
  // P3-T23 (D34): a level change restarts the process at the new level. The
  // guard decides at the stricter of the two at once; a lowering restarts
  // now, a raise at the next safe point (walk D18): the end of the current
  // step (a tool's result, with no other tool still running), or at once when
  // the session only waits on the owner; the turn's end, as before, when no
  // tool runs before it. Never in the middle of a tool or of the model's text.
  let currentLevel = session.level
  let restartTo = null as NodeLevel | null
  /** S33 (GF-50): the pending restart is for an autonomy switch alone (restartTo = the current level). */
  let restartFor = null as "autonomy" | null
  let sdkSession = resume?.sdkSessionId ?? null
  // S35: this session's Atelier pipeline, matched on every SDK session id it
  // has had (the resumed one and each init's), read after a tool wrote its
  // state.json and at every turn end; never written.
  const atelier = new AtelierWatch(workspace.cwd)
  if (sdkSession) atelier.ids.add(sdkSession)
  const atelierWrites = new Set<string>()
  const emitAtelier = () => {
    for (const e of atelier.check().events) {
      push("system", {
        subtype: e.subtype,
        text: e.subtype === "atelier" ? `Atelier: ${e.data.phase}` : "Atelier state unreadable",
        data: e.data,
      })
    }
  }
  if (ownTranscript && ownWriteFile) {
    recordOwnWrite = () => {
      const file = sdkSession ? ownTranscript(sdkSession) : null
      if (!file) return
      try {
        writeFileSync(ownWriteFile, JSON.stringify({ ownLastWriteMs: statSync(file).mtimeMs }), {
          mode: 0o600,
        })
      } catch {
        // No transcript yet (nothing ran) or no session dir: nothing of ours to remember.
      }
    }
  }
  /** The process is being restarted (not a final result, even if one comes). */
  let restarting = false
  /** Tool calls started and not yet returned (a call waiting on the owner is not running). */
  const executing = new Set<string>()
  let raisePending = false
  const restartIfSafe = (at: "step" | "ask") => {
    if (!raisePending || stopping || restarting) return
    const asking = new Set(asks.open().map((r) => r.requestId))
    if ([...executing].some((id) => !asking.has(id))) return
    if (at === "ask" && asking.size === 0) return
    raisePending = false
    void restartNow()
  }
  const restartNow = async () => {
    restarting = true
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      run.interrupt().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, args.stopGraceMs ?? STOP_GRACE_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    input.close()
    run.close()
  }
  control.handlers.set_level = ({ payload }) => {
    // S33: a pending autonomy-only restart is taken over (the level wins the resume reason).
    if (stopping || (restartTo && restartFor !== "autonomy")) return { outcome: "noop" }
    const to = payload.level
    if (to === currentLevel) return { outcome: "noop" }
    // A restart resumes the SDK session: none yet, nothing to resume.
    if (!sdkSession) return { outcome: "failed", error: "the session has not started yet" }
    activeHook = hookFor(minLevel(currentLevel, to))
    restartTo = to
    restartFor = null
    if (!isLevelRaise(currentLevel, to)) void restartNow()
    else {
      raisePending = true
      // After this command's ack goes out: at once when only the owner is awaited.
      queueMicrotask(() => restartIfSafe("ask"))
    }
    currentLevel = minLevel(currentLevel, to)
    return { outcome: "applied" }
  }
  // P2-T10 (S33): an autonomy switch restarts the process (the question tools
  // are a query-start option, GF-48) through the level-restart path, at the
  // next safe point. A pending restart is reused, never dropped (COR-6).
  control.handlers.set_autonomy = ({ payload }) => {
    if (stopping) return { outcome: "noop" }
    const to = payload.autonomy
    const from: Autonomy = pendingAutonomy ?? session.autonomy ?? "guided"
    if (to === from) return { outcome: "noop" }
    pendingAutonomy = to
    if (to === "autonomous") {
      // What already waits on the person is answered now, as the next one will be.
      for (const ask of asks.open()) {
        if (!AUTONOMOUS_DISALLOWED_TOOLS.includes(ask.tool)) continue
        asks.resolve(
          ask.requestId,
          { behavior: "deny", message: AUTONOMY_SWITCH_DENIAL },
          { outcome: "deny", by: "owner" },
        )
      }
    }
    if (!restartTo) {
      // The current level: runner.restart accepts it, and no level change is named (GF-50).
      restartTo = currentLevel
      restartFor = "autonomy"
      raisePending = true
      queueMicrotask(() => restartIfSafe("ask"))
    }
    push("system", {
      subtype: "autonomy_changed",
      text: to === "autonomous" ? "Autonomy: autonomous" : "Autonomy: guided",
      data: { from, to, applied: true },
    })
    events.flushNow()
    return { outcome: "applied" }
  }
  if (args.control) void control.run(args.control)

  // G11: background work the CLI tracks as tasks; the run is not done while one is open.
  const openTasks = new Set<string>()
  /** Nothing left open at a result: the turn end is decided (`decideTurnEnd`). */
  const doneNow = () =>
    !stopping && stop === null && openTasks.size === 0 && input.outstanding().length === 0

  type ResultLike = {
    subtype?: string
    is_error?: boolean
    result?: string
    permission_denials?: unknown[]
    errors?: string[]
  }
  let result = null as ResultLike | null
  let failure = null as string | null
  /** D1: a Bash call in this run named a git push (the result then reads the remote). */
  let pushRan = false
  // ── P2-T09: the turn-end decision (S32, S36, S57, spec §3.6) ──
  const autonomy: Autonomy = session.autonomy ?? "guided"
  /** S33: the turn end decides at the autonomy the person set last (the restart applies it). */
  const turnAutonomy = (): Autonomy => pendingAutonomy ?? autonomy
  /** S57: the finish step due; none in a folder that is no repository. */
  const finishDue: FinishWith | null = workspace.repoDir ? finishFor(session) : null
  const guardedBranches = [
    ...NODE_PROTECTED_BRANCHES,
    ...(workspace.defaultBranch ? [workspace.defaultBranch] : []),
  ].map((b) => b.toLowerCase())
  /** Edit-like calls under way, by tool_use id (their success is progress). */
  const editCalls = new Set<string>()
  /** The last result's cwd facts (the PR check's no-URL path). */
  let cwdFacts: SessionResultFacts = {}
  /** The node's PATH without the session's shim dir (the owner's gh, never the broker's). */
  const nodePath = () =>
    (env.PATH ?? "")
      .split(":")
      .filter((dir) => dir !== credentialBin)
      .join(":")
  /** Whether this turn end's decision may need the remote: a done with a PR due. */
  const prCheckDue = () =>
    finishDue === "pr" &&
    (latch.completion()?.by === "session" || atelier.state?.status === "complete")
  /** The run's final decision; a path that ends the run without one decides then. */
  let decision = null as TurnEndDecision | null
  const decide = (): TurnEndDecision => {
    const state = atelier.state
    const autonomy = turnAutonomy()
    if (autonomy === "autonomous") {
      autoContinue.turnEnd({
        git: statusFingerprint(workspace, sourceEnv),
        atelier: state ? JSON.stringify([state.phase, state.done]) : null,
      })
    }
    return decideTurnEnd({
      latch: latch.completion(),
      atelier: state,
      autonomy,
      emptyContinues: autoContinue.empty,
      totalContinues: autoContinue.total,
      finish: finishDue,
      pr: () => {
        const { git, gh } = resultExecs(workspace, sourceEnv, nodePath())
        return verifyPr({
          ...(latch.completion()?.prUrl ? { reportedUrl: latch.completion()?.prUrl } : {}),
          cwdFacts,
          guarded: guardedBranches,
          git,
          gh,
          since: baseline,
          ...(forgeHost ? { forgeHost } : {}),
        })
      },
      lastText,
    })
  }
  /** S32: send the fixed continue (no commandId: never the owner's) and mark it. */
  const continueRun = () => {
    autoContinue.continued()
    push("system", {
      subtype: "auto_continue",
      text: `Continuing on its own (${autoContinue.empty} of ${AUTO_CONTINUE_MAX})`,
      data: { n: autoContinue.empty, total: autoContinue.total },
    })
    events.flushNow()
    input.push(AUTO_CONTINUE_TEXT)
  }
  // W1-D3: the claude this run starts dies with the runner. Looked up from the
  // init on (the CLI has registered by then), a few messages at most.
  const guardClaude = args.claudeGuard ?? guardOwnClaude
  const guarded = new Set<number>()
  let guardLooks = 0
  try {
    for await (const message of run) {
      if (stop) break
      counter.add(message)
      const m = message as {
        type?: string
        subtype?: string
        model?: string
        session_id?: string
        command_uuid?: string
        state?: string
        task_id?: string
        skip_transcript?: boolean
        tools?: unknown
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (m.type === "command_lifecycle") {
        if (typeof m.command_uuid === "string" && typeof m.state === "string") {
          input.lifecycleEvent(m.command_uuid, m.state)
        }
        continue
      }
      if (m.type === "system" && typeof m.task_id === "string") {
        if (m.subtype === "task_started" && m.skip_transcript !== true) openTasks.add(m.task_id)
        else if (m.subtype === "task_notification") openTasks.delete(m.task_id)
      }
      if (m.type === "system" && m.subtype === "init") {
        if (typeof m.model === "string") ranOn = m.model
        if (typeof m.session_id === "string" && m.session_id) {
          sdkSession = m.session_id
          atelier.ids.add(m.session_id)
          // D49 F6: an owner session's transcript is this node's work for this
          // server; the follow host lets only that server follow it in place.
          if (config.projects === "linked") {
            try {
              recordOwnerRun(config.dir, job.server, m.session_id)
            } catch {
              // Best effort: without the record, an in-place follow is refused.
            }
          }
        }
        startEvents(typeof m.session_id === "string" ? m.session_id : undefined, m.tools)
        // A level restart's new process gets its own look.
        guardLooks = 3
      } else if (m.type === "assistant" || m.type === "user" || m.type === "result") {
        // The turn itself: the init came first, or never will.
        startEvents()
      }
      if (guardLooks > 0 && sdkSession) {
        guardLooks--
        try {
          if (guardClaude(config.dir, sdkSession, guarded).length > 0) guardLooks = 0
        } catch {
          // Best effort: the driver check still sees a leftover (W1-D3).
        }
      }
      let stepEnded = false
      for (const event of normalize(message, state)) {
        let atelierWritten = false
        if (event.type === "tool_call" && typeof event.payload.id === "string") {
          executing.add(event.payload.id)
          const name = event.payload.name
          // S32: progress the counter judges structurally.
          if (typeof name === "string" && EDIT_TOOLS.has(name)) editCalls.add(event.payload.id)
          if (name === "TodoWrite") {
            const todos = (event.payload.input as { todos?: unknown } | null)?.todos
            if (Array.isArray(todos)) {
              autoContinue.todo(
                todos.filter((t) => (t as { status?: unknown } | null)?.status === "completed")
                  .length,
              )
            }
          }
          const filePath = (event.payload.input as { file_path?: unknown } | null)?.file_path
          if (
            (name === "Write" || name === "Edit" || name === "MultiEdit") &&
            isAtelierStatePath(filePath)
          ) {
            atelierWrites.add(event.payload.id)
          }
        } else if (event.type === "tool_result" && typeof event.payload.id === "string") {
          executing.delete(event.payload.id)
          stepEnded = true
          if (editCalls.delete(event.payload.id) && event.payload.isError !== true) {
            autoContinue.progress()
          }
          atelierWritten = atelierWrites.delete(event.payload.id)
        }
        if (event.type === "tool_call" && !pushRan && ranPush(event.payload)) pushRan = true
        if (event.type === "result") {
          // D1: the turn's last events go now, not after the facts below.
          events.flushNow()
          // S15: the branch, whether it was pushed, and the PR URL (K17).
          // The node's own gh (outside the sandbox, the owner's login), never the shim:
          // the broker cannot answer while the node waits on it.
          // S35: the turn end reads the state (a write through Bash shows here),
          // first, as the decision's PR check depends on it (P2-T09).
          emitAtelier()
          // P2-T09: the remote is read too when this turn end may need a PR.
          cwdFacts = sessionResultFacts(
            workspace,
            sourceEnv,
            nodePath(),
            pushRan || prCheckDue(),
            forgeHost,
          )
          Object.assign(event.payload, cwdFacts)
          pushEvent(event)
          events.flushNow()
          continue
        }
        pushEvent(event)
        // S35: after the tool that wrote this session's state.json returned.
        if (atelierWritten) emitAtelier()
      }
      // Walk D18: a step ended (a tool returned): a confirmed raise restarts here.
      if (stepEnded) restartIfSafe("step")
      if (m.type === "assistant") {
        const text = (m.message?.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
        if (text) lastText = text
      }
      if (m.type === "result") {
        // A later result replaces an earlier one (a session runs many turns).
        result = message as unknown as ResultLike
        if (stopping) {
          ;(resultSeen as (() => void) | null)?.()
          break
        }
        // P2-T09 (A37, COR-2): the turn end decides on every result path,
        // before the restart branch, when nothing is left open and the turn
        // succeeded (an error result ends as an error, as before).
        const r = message as unknown as ResultLike
        const turnEnd = doneNow() && r.subtype === "success" && r.is_error !== true
        const now = turnEnd ? decide() : null
        // A raise restarts at the turn boundary.
        if (restartTo) {
          // P3-fix m2: after the session's final result a restart would only
          // add a turn ("continue where you left off") nobody asked for: the
          // session ends with its decision, and its next run starts at the new
          // level. A continue takes the restart instead: its resume is the continue.
          if (!restarting && now && now.kind !== "continue") {
            // S33: an autonomy switch alone changed no level; the row holds the autonomy.
            if (restartFor !== "autonomy") {
              push("level_changed", { from: session.level, to: restartTo })
            }
            restartTo = null
            restartFor = null
            decision = now
          }
          input.close()
          run.close()
          break
        }
        if (doneNow()) {
          if (now?.kind === "continue") {
            continueRun()
            continue
          }
          decision = now ?? { kind: "close" }
          input.close()
          run.close()
          break
        }
        continue
      }
      if (counter.exceeded) {
        stop = "token_limit"
        await run.interrupt().catch(() => undefined)
        run.close()
        break
      }
    }
  } catch (error) {
    if (!stop && !stopping && !restartTo) failure = (error as Error).message || String(error)
  } finally {
    input.close()
    // The process ends: what still waits is dropped, each with its decision (D36).
    asks.denyAll("The session ended.", { outcome: "expired", by: "process_exit" })
  }

  // After the finally above, so its decisions are flushed before job_done.
  if (failure !== null) {
    return finish({ status: "error", code: "error", text: lastText, error: failure })
  }
  if (stopping) {
    ;(resultSeen as (() => void) | null)?.()
    await (stopDone as Promise<void> | null)
    return finish({
      status: "stopped",
      text: lastText,
      ...(ownerDone ? { completion: ownerDone } : {}),
    })
  }
  if (restartTo && stop === null) {
    // Messages the CLI never read go to the restarted run (same job, D34).
    for (const m of input.cancelOutstanding()) if (m.commandId) control.release(m.commandId)
    return finish({
      status: "restart",
      text: lastText,
      level: restartTo,
      ...(sdkSession ? { sdkSessionId: sdkSession } : {}),
      ...(effortApplied ? { effort: currentEffort } : {}),
      ...(pendingAutonomy ? { autonomy: pendingAutonomy } : {}),
      ...(restartFor ? { restartFor } : {}),
    })
  }
  if (stop === "aborted") return finish({ status: "aborted", text: lastText })
  if (stop === "token_limit") {
    const limit = job.hardTokenLimit as number
    return finish({
      status: "token_limit",
      code: "token_limit",
      text: `${lastText}\n\nStopped: this session reached its hard limit of ${limit} tokens (${counter.snapshot().totalTokens} used).`.trim(),
      ...withCompletion(latch),
    })
  }
  if (!result)
    return finish({
      status: "error",
      code: "error",
      text: lastText,
      error: "the run ended without a result",
    })
  // Denials the SDK made without the hook: the SDK's own list is the record.
  for (const denial of (result.permission_denials ?? []) as Array<{
    tool_name?: string
    tool_input?: Record<string, unknown>
  }>) {
    const tool = String(denial.tool_name ?? "")
    const detail = refusalDetail(tool, denial.tool_input ?? {})
    if (!refusals.some((r) => r.tool === tool && r.detail === detail)) {
      refusals.push({
        tool,
        reason: `${tool}: denied`,
        ...(detail ? { detail } : {}),
      })
    }
  }
  // fix8 H2: a session that never really started still ends with a result
  // marked as an error: never a done job.
  if (result.subtype !== "success" || result.is_error === true) {
    return finish({
      status: "error",
      code: "error",
      text: lastText,
      error:
        (result.errors ?? []).join("; ") ||
        (result.is_error && typeof result.result === "string" ? result.result : "") ||
        String(result.subtype),
    })
  }
  // P2-T09: the run ends with its decision; one that ended without deciding
  // (the CLI closed its stream) decides now, with no continue left to send.
  const ended = decision ?? decide()
  if (ended.kind === "fail") {
    return finish({ status: "error", code: "error", text: lastText, error: ended.reason })
  }
  return finish({
    status: "done",
    text: typeof result.result === "string" ? result.result : lastText,
    ...(ended.kind === "close" && ended.completion ? { completion: ended.completion } : {}),
  })
}

/**
 * S1, S6: the latched completion, as a spread (absent when the run set none).
 * The session's own `prUrl` stays behind: only a PR the turn end verified
 * leaves the node (S57).
 */
function withCompletion(latch: CompletionLatch): { completion?: NodeSessionCompletion } {
  const latched = latch.completion()
  if (!latched) return {}
  const { prUrl: _reported, ...completion } = latched
  return { completion }
}

/**
 * Walk D6: the plan an ExitPlanMode call asks the owner to approve. Claude
 * Code passes it in the input when it has one; otherwise it is the plan file
 * plan mode had the model write (the one the input names, else the newest
 * `.md` in the session's plan dir). Empty when there is none.
 */
export function planText(input: Record<string, unknown>, planDir: string): string {
  if (typeof input.plan === "string" && input.plan.trim()) return input.plan
  const named = typeof input.planFilePath === "string" ? input.planFilePath : null
  let file: string | null = null
  if (named && path.dirname(path.resolve(named)) === path.resolve(planDir)) file = named
  if (!file) {
    try {
      const newest = readdirSync(planDir)
        .filter((n) => n.endsWith(".md"))
        .map((n) => ({ n, at: statSync(path.join(planDir, n)).mtimeMs }))
        .sort((a, b) => b.at - a.at)[0]
      if (newest) file = path.join(planDir, newest.n)
    } catch {
      return ""
    }
  }
  if (!file) return ""
  // Opened once, no symlink followed; 400 KB of UTF-8 always holds the first
  // 100,000 UTF-16 units kept.
  return (readRegularFileNoFollow(file, 400_000, { truncate: true }) ?? "").slice(0, 100_000)
}

/** `liaison-sidecar --unattended <job file>`: one job, framed on stdout. */
export function unattendedJobPath(argv: string[]): string | null {
  const i = argv.indexOf(UNATTENDED_FLAG)
  if (i < 0) return null
  const value = argv[i + 1]
  return value && !value.startsWith("--") ? value : ""
}

export async function unattendedMain(argv: string[], cliPath: string | null): Promise<number> {
  const write = (event: Record<string, unknown>) => process.stdout.write(serializeEvent(event))
  const file = unattendedJobPath(argv)
  if (!file || argv.length !== 2) {
    process.stderr.write(`usage: liaison-sidecar ${UNATTENDED_FLAG} <job file>\n`)
    return 2
  }
  let job: UnattendedJob
  try {
    job = readJobFile(file)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  write({ type: "boot", protocolVersion: 2, unattended: true, jobId: job.jobId, cliPath })
  const control = readLines(Bun.stdin.stream())
  // An interactive node chat turn (S24) resumes the chat's session and relays
  // its permission prompts; anything else runs unattended under its profile.
  const outcome =
    job.kind === "interactive"
      ? await runInteractiveJob({ job, emit: write, cliPath, control })
      : await runUnattended({ job, emit: write, cliPath, control })
  write({ type: "done" })
  return outcome.status === "error" ? 1 : 0
}

/** S51: the transcript mtime the node's own last run left, or null. */
function readOwnWrite(file: string): number | null {
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { ownLastWriteMs?: unknown })
      .ownLastWriteMs
    return typeof v === "number" && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}
