// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE JOB CLIENT (P4 N-D T5; spec-node.md protocol, A19, A20, A21, A23,
// F10; P1-T39 sessions, D33, D46, L14, L18, L24). The page hears
// `node_job_offer` frames on its socket and hands them here; this runs them on
// this computer, side by side up to the node's cap (P3-T10, D35: 4 live, 2 of
// them background by default; a My node chat turn counts and runs one at a
// time, G9), first offered first:
//
//   (read the job: its kind and source) -> claim -> (shell starts the job's
//   own sidecar) -> started -> heartbeat every 30 s -> (session event
//   batches, in order) -> result | fail
//
// Every call after the claim carries the claim's `leaseGeneration`. A 409 on
// any of them means another claim holds the job now: the local run is stopped
// and nothing is posted. A lost network never stops a run (L4): heartbeats go
// on failing until the network is back, the process and its unsent events
// are kept, and the server pauses the session meanwhile.
//
// An unattended job runs a SESSION: the claim names its folder, model and
// level. The model runs as named or the job fails `model_unavailable` (never a
// downgrade); the session's events are posted in order, one batch in flight,
// and the result waits for the last one. An agent with no Liaison connection
// here is connected with no dialog before the claim.
//
// The shell refuses a job before it starts when its level is above this
// computer's pin without a confirmation (`level_unconfirmed`), when the agent
// has no Liaison connection here (`auth_required`, never a device grant), or
// when Strict or Standard meets a computer without a sandbox
// (`sandbox_unavailable`). My node chat's `auth_required` asks the owner, on
// this computer, right after.
//
// A FOLLOW job (W3: S41, A45, A53) runs no Claude Code: the shell's one
// follow host reads a Claude Code transcript and streams it, redacted, as the
// session's events. Its claim names the transcript, never a model or a
// profile; it starts with `start_node_follow`, heartbeats, posts its batches
// and ends with `/result {follow: {why, endOffset?}}`, like a run otherwise.
// Follows have their own cap (8 per node) and never take a run's slot. The
// owner's Stop reaches it as `stop_node_follow`; a reloaded page re-adopts
// the follows the shell holds, as follows (never as runs that died).
//
// On start, jobs that queued while no node of the owner was live (backlog)
// are not offered by the server: `startup()` offers them, once per launch and
// again on every reconnect, with no dialog (L19): they show as queued in
// Sessions meanwhile.

import {
  NODE_IMPORT_LIMITS,
  type NodeFollowClaim,
  type NodeFollowResult,
  nodeFollowClaimSchema,
} from "@liaison/shared/node-import"
import {
  currentNodeModels,
  exactOfferedModel,
  type OfferedNodeModel,
} from "@liaison/shared/node-models"
import {
  type Autonomy,
  capEvent,
  type EffortLevel,
  eventBytes,
  type FinishWith,
  NODE_EVENT_LIMITS,
  NODE_PROTOCOL_AUTONOMY,
  NODE_SESSION_DEFAULT_CAPS,
  type NodeSessionCompletion,
  type NodeSessionEventIn,
  parseCommandLine,
  splitIntoBatches,
  TOOL_USE_ID_RE,
  toProtocol3Completion,
} from "@liaison/shared/node-session-protocol"
import { createCommandDelivery, type PulledCommand } from "./commands"

export const HEARTBEAT_MS = 30_000
/**
 * W2-D4: the waits between tries of a run's end post (result or fail), about
 * 100 s in all, inside the lease the heartbeat keeps alive meanwhile. One
 * lost post (a 401 during a token rotation, a network blip) used to leave
 * the job `running` with the session paused and the owner's reply unheard.
 */
export const END_POST_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000] as const

/** A failure worth another try: network, 401 (token rotation), 408, 429, 5xx. */
export function isTransientPostError(error: unknown): boolean {
  if (!(error instanceof NodeHttpError)) return true
  if (error.code === "signed_out" || error.code === "no_node_credential") return true
  return error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500
}
/** How often a relayed permission prompt's decision is read (S24, A24). */
export const PERMISSION_POLL_MS = 3_000
/** A relayed prompt nobody answers is denied after this (A24; the server says the same). */
export const PERMISSION_TIMEOUT_MS = 10 * 60_000
/** The modes an interactive node chat may run in: never bypass (A24). */
export const NODE_CHAT_MODES = ["auto", "manual", "edit", "plan"] as const
export type NodeChatMode = (typeof NODE_CHAT_MODES)[number]
/** A claim answered `node_busy` with nothing running here is tried again after this. */
export const CLAIM_RETRY_MS = 30_000

/** The node's live caps (D35): the claim's once the server answers them, else the defaults. */
export interface NodeCaps {
  maxLive: number
  maxBackground: number
}

/** A run that resumes its session (D36; the shell writes it into the job file). */
export interface SessionResume {
  /** Null from the claim means start fresh (no SDK session to resume). */
  sdkSessionId: string | null
  after: "offline" | "message" | "crash" | "level" | "autonomy"
  commandId?: string
  /** S51 (D28): the message was sent confirmed while another Claude Code drove the session. */
  confirmDrivenElsewhere?: true
  /**
   * A62: a taken-over import's first resume: the transcript byte offset its
   * replay reached; the sidecar replays from there before the SDK starts.
   */
  catchUpFrom?: number
}

/** The level profile a claim carries (D18): the level and the Liaison tools toggle. */
export interface ClaimedProfile {
  level: string
  liaisonTools: boolean
}

/** What a claim tells the node about the session it runs (the server's ClaimedSession). */
export interface ClaimedSession {
  id: string
  /** This node's own path for the folder (K9); null: none, or the node fails folder_missing. */
  folderPath: string | null
  folderName: string | null
  /** A git URL or a shared repo name the node clones (D49). */
  repo: string | null
  model: string
  level: string
  profileLevel: string
  configKind: string
  liaisonTools: boolean
  profileConfirmationId?: string
  sessionConfirmationId?: string
  /** A resume run: the SDK session it continues (P3). */
  resume?: SessionResume
  /** S23: the session's reasoning level; null or absent, the model's default. */
  effort?: EffortLevel | null
  /** S30: the session's autonomy; absent from a server older than wave 2 (guided). */
  autonomy?: Autonomy
  /** S57: how the session finishes; null, a PR in a repo. */
  finishWith?: FinishWith | null
  /** A44: an import's recorded cwd below its shared folder; absent, the folder. */
  cwdSubdir?: string
  /** D53: the shared repo's own worktree outside the folder that `cwdSubdir` is below. */
  worktreePath?: string
  /** W2-D5: another in-place session holds this folder's checkout (one display line). */
  folderHeldBy?: string
}

export interface ClaimedJob {
  job: {
    id: string
    agentId: string
    agentName: string | null
    /** dispatch, app, routine or agent_tag for a session's job. */
    source?: string
    /** The conversation the job answers in (the server's job view carries it). */
    threadId?: string | null
    prompt: string
    trigger: unknown
    hardTokenLimit: number | null
    /** `interactive`: a node chat turn the owner drives remotely (S24). */
    kind?: "unattended" | "interactive" | "follow"
    /** Interactive only: the chat's mode (the server never sends bypass; A24). */
    permissionMode?: string | null
    /** Interactive only: the SDK session this turn resumes. */
    sdkSessionId?: string | null
    /** The model the job's agent (or routine) asks for; null: Auto. */
    agentModel?: string | null
  }
  leaseGeneration: number
  profile: ClaimedProfile
  /** Every unattended job runs a session; My node chat turns carry none. */
  session?: ClaimedSession
  /** The node's live caps (P3-T18); absent from servers before it. */
  caps?: NodeCaps
  /**
   * D43 F2: the node protocol the server speaks, as it advertises it (4 from
   * wave 2); absent from servers before it, which speak 3.
   */
  serverProtocol?: number
  /** B2-1 (D52): the server that answered this claim (set by the HTTP adapter). */
  claimedFrom?: string
}

/**
 * A follow job's claim (A45, A58): the session it streams and the transcript
 * it follows; no profile, model or caps.
 */
export interface ClaimedFollow {
  kind: "follow"
  job: ClaimedJob["job"]
  leaseGeneration: number
  session: ClaimedSession
  follow: NodeFollowClaim
  serverProtocol?: number
  /** B2-1 (D52): the server that answered this claim (set by the HTTP adapter). */
  claimedFrom?: string
}

export function isFollowClaim(claim: ClaimedJob | ClaimedFollow): claim is ClaimedFollow {
  return (claim as { kind?: unknown }).kind === "follow"
}

/** What the shell's follow host starts (node_follow.rs `FollowRequest`). */
export interface StartFollowRequest extends NodeFollowClaim {
  sessionId: string
  jobId: string
  leaseGeneration: number
  /**
   * B2-1 (D52): the server that answered the claim. The shell refuses
   * (`server_changed`) when it is not the shell's current server, and tags
   * the follow with it.
   */
  server?: string
}

/** The server's view of one job (GET /nodes/jobs/:id). */
export interface NodeJobView {
  id: string
  agentId: string
  kind?: "unattended" | "interactive" | "follow" | null
  /** dispatch, app, routine or agent_tag: routines and agent tags are background (D35). */
  source?: string | null
  status?: string
}

export interface JobRefusal {
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

export interface ResultBody {
  leaseGeneration: number
  text: string
  refusals: JobRefusal[]
  usage?: JobUsage
  /** Interactive only: the SDK session the chat's next turn resumes. */
  sdkSessionId?: string
  /** The model the node actually ran the job on. */
  modelId?: string
  /** S1, S2: the run's explicit end signal; absent, the server ends it Needs you. */
  completion?: NodeSessionCompletion
  /** S4: the run stopped at its hard token limit (a completion sent with it still wins). */
  endedBy?: "token_limit"
}

/** A follow job's result (A45, A62): why it ended, never a completion. */
export interface FollowResultBody {
  leaseGeneration: number
  follow: NodeFollowResult
}

/** A permission prompt relayed to the owner (permission-prompts.ts). */
export interface PermissionRequestBody {
  leaseGeneration: number
  toolName: string
  summary: string
  /** The call's whole input, as the owner's card shows it (`promptDetail`). */
  detail?: string
}

export type PermissionStatus = "pending" | "allowed" | "denied"

/** One step of an interactive turn (sidecar/node-interactive.ts `progressEventsOf`). */
export type TurnProgressEvent =
  | { type: "tool_call"; id: string; toolName: string; summary?: string }
  | { type: "tool_result"; id: string; isError?: boolean }

/** A chat turn's steps, relayed so its chat shows them live (turn-progress-routes.ts). */
export interface TurnProgressBody {
  leaseGeneration: number
  events: TurnProgressEvent[]
}

export interface FailBody {
  leaseGeneration: number
  error: string
  code: string
  refusals?: JobRefusal[]
  usage?: JobUsage
}

export interface BacklogJob {
  id: string
  agentId: string
}

/** A server answer that is not a success: its status, error code and extra fields. */
export class NodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** The error's other fields (`expectedBatchNo`, `index`). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message ?? `${status} ${code}`)
    this.name = "NodeHttpError"
  }
}

/** One batch of a session's events, fenced by the run (spec-protocol.md §Ingest). */
export interface SessionEventsBody {
  jobId: string
  leaseGeneration: number
  batchNo: number
  events: NodeSessionEventIn[]
}

/** The shell refused to start a job, with the server's fail code. */
export class NodeShellRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "NodeShellRefusal"
  }
}

export interface NodeJobHttp {
  /** One of the owner's jobs (its agent and kind), or null when there is none. */
  getJob(jobId: string): Promise<NodeJobView | null>
  /** The claim names the MCP connection the job's tools will use (A18). */
  claim(jobId: string, mcpConnectionId: string | null): Promise<ClaimedJob | ClaimedFollow>
  started(jobId: string, generation: number): Promise<void>
  heartbeat(jobId: string, generation: number): Promise<void>
  result(jobId: string, body: ResultBody | FollowResultBody): Promise<void>
  fail(jobId: string, body: FailBody): Promise<void>
  backlog(): Promise<BacklogJob[]>
  /** The owner's re-run of a failed job (the owner confirmed on this computer). */
  rerun(jobId: string): Promise<void>
  /** `threadId`: the room the job answers in, so the definition is bound by its floor. */
  definition(agentId: string, threadId?: string | null): Promise<string>
  /** Posts one batch of a session's events (node credential, fenced by the run). */
  postEvents(sessionId: string, body: SessionEventsBody): Promise<{ lastSeq: number }>
  /** Relays one prompt of an interactive job to its owner (an Allow / Deny card). */
  permissionRequest(
    jobId: string,
    body: PermissionRequestBody,
  ): Promise<{ id: string; status: PermissionStatus; refused?: string }>
  /**
   * Relays an interactive job's steps to its chat (node credential, fenced by
   * the run). Optional: a test double without it relays nothing.
   */
  turnProgress?(jobId: string, body: TurnProgressBody): Promise<void>
  /** The owner's decision so far (the server denies it once 10 minutes pass). */
  permissionStatus(promptId: string): Promise<{ status: PermissionStatus }>
  /** P3: the node's unacked steering commands for its current runs, in (session, seq) order. */
  getCommands(): Promise<PulledCommand[]>
  /** P3 (D36): the runs alive here, on every (re)connect; the server answers its positions. */
  report(sessions: ReportedSession[]): Promise<{ sessions: ReportedPosition[] }>
  /** P3-T22 (S7): a cut tool output's full text for the owner; null: no longer here. */
  putFullOutput(sessionId: string, toolUseId: string, text: string | null): Promise<void>
}

/** One run this node holds alive (D36's report). */
export interface ReportedSession {
  id: string
  jobId: string
  leaseGeneration: number
  alive: boolean
}

export interface ReportedPosition {
  id: string
  lastBatchNo: number
  lastSeq: number
}

/** A run the shell holds (node_live_sessions), as a reloaded page finds it. */
export interface ShellLiveRun {
  sessionId: string | null
  jobId: string
  /** A53: `follow` for a follow the follow host holds (no pid, never interactive). */
  kind?: "run" | "follow"
  pid?: number
  interactive?: boolean
  background?: boolean
  leaseGeneration?: number | null
  /** The start request the shell kept (no access token), for a level restart (T24). */
  request?: StartJobRequest | StartFollowRequest | null
  /** How many lines its outbox holds. */
  lines: number
}

export interface StartJobRequest {
  jobId: string
  agentId: string
  agentName: string
  model: string
  profile: ClaimedProfile
  prompt: string
  trigger: unknown
  hardTokenLimit: number | null
  agentDefinition: string
  /** The connection the job was claimed with; the shell refuses a mismatch. */
  mcpConnectionId: string | null
  /** Interactive node chat turns only (S24). */
  kind?: "interactive"
  permissionMode?: NodeChatMode
  resumeSessionId?: string | null
  /** Unattended jobs: the session the shell's job document carries (R7). */
  sessionId?: string
  source?: string
  level?: string
  profileLevel?: string
  configKind?: string
  folderPath?: string | null
  folderName?: string | null
  repo?: string | null
  /** D41: the confirmations the shell consumes to raise its pin or admit this start. */
  profileConfirmationId?: string
  sessionConfirmationId?: string
  /** The caps the shell admits this start under (D35). */
  caps?: NodeCaps
  /** A resume run (D36). */
  resume?: SessionResume
  /** The claim's generation: the shell keeps it with the run for a reloaded page (L3). */
  leaseGeneration?: number
  /** P3-T24 (D34): a run restarted at a new level names the level it left. */
  levelChange?: { from: string }
  /** Walk D7: the models this node offers, so the session may switch to any of them. */
  offeredModels?: string[]
  /** S24: the reasoning level the run starts at; null, the model's default. */
  effort?: EffortLevel | null
  /** S30: the autonomy the run starts at. */
  autonomy?: Autonomy
  /** S57: how the session finishes; null, a PR in a repo. */
  finishWith?: FinishWith | null
  /** A44: an import's recorded cwd below its shared folder (the shell re-checks it). */
  cwdSubdir?: string
  /** D53: the shared repo's worktree `cwdSubdir` is below (the sidecar re-checks it). */
  worktreePath?: string
  /** W2-D5: another in-place session holds the folder's checkout: no branch switch. */
  folderHeldBy?: string
  /**
   * D43 F2: the protocol the claiming server advertised (3 when it named
   * none), kept with the run so a reattached run talks to that server alike.
   */
  serverProtocol?: number
  /**
   * B2-1 (D52): the server that answered the claim. The shell refuses
   * (`server_changed`) when it is not the shell's current server, and keeps
   * the run tagged with it (a reattached run's kept request carries it on).
   */
  server?: string
}

/** One stdout line of a run, tagged by the shell with its job and session. */
export interface RunLine {
  sessionId?: string
  jobId: string
  line: string
  /** A `session_events` line's ordinal in the run's outbox (node_runs.rs). */
  index?: number
}

/** A run's sidecar exited, or a follow ended (with why it ended, A45). */
export interface RunExit {
  sessionId?: string
  jobId: string
  follow?: NodeFollowResult
}

export interface NodeJobShell {
  startJob(request: StartJobRequest): Promise<void>
  /** Stops one run (a session's, or a job's); neither stops every run. */
  stopJob(sessionId?: string, jobId?: string): Promise<void>
  /**
   * A45: one follow in the node's follow host (node_follow.rs). Throws a
   * `NodeShellRefusal` with the shell's code (FOLLOW_AT_CAP, FOLLOW_RUNNING,
   * FOLDER_NOT_SHARED, unsafe_subdir).
   */
  startFollow(request: StartFollowRequest): Promise<void>
  /** Asks the host to end a follow; its end comes as an exit with `follow.why`. */
  stopFollow(sessionId: string, jobId: string): Promise<boolean>
  /** One control line to a live session's stdin; false when it has no live run here. */
  writeSession(sessionId: string, line: string): Promise<boolean>
  onLine(listener: (line: RunLine) => void): () => void
  onExit(listener: (exit: RunExit) => void): () => void
  /**
   * An unattended job's agent connected with no dialog (CAV14): the stored
   * connection, else one minted with the window's session. Null when it could
   * not be connected.
   */
  ensureConnection(agentId: string): Promise<string | null>
  /**
   * My node chat's `auth_required` recovery (D43): "Allow {agent} on this
   * computer?", then the agent's connection.
   */
  confirmConnection(
    agentId: string,
    agentName: string,
  ): Promise<{ confirmed: boolean; connected: boolean }>
  /** The connection confirmed for this agent on this node (F10), or null. */
  connectionFor(agentId: string): Promise<string | null>
  /** Answers a permission prompt of the running job (its sidecar's stdin). */
  answerPermission(requestId: string, allow: boolean, message?: string): Promise<void>
  /** P3 (L3): the runs the shell holds, for a reloaded page to reattach to. */
  liveSessions(): Promise<ShellLiveRun[]>
  /** A run's outbox lines from `fromIndex` (1-based), at most `max`. */
  outbox(
    sessionId: string,
    jobId: string,
    fromIndex: number,
    max: number,
  ): Promise<Array<{ index: number; line: string }>>
  /** Persists how far the server acknowledged a run's outbox (G6). */
  ack(sessionId: string, jobId: string, index: number, batchNo: number): Promise<void>
  /** The persisted ack, `{0, 0}` when none. */
  acked(sessionId: string, jobId: string): Promise<{ index: number; batchNo: number }>
  /** P3-T22: a cut tool output's spill file (node_session_spill); null when gone. */
  spill(sessionId: string, toolUseId: string): Promise<string | null>
}

export interface Clock {
  now(): number
  /** Calls `fn` every `ms`; the answer cancels. */
  every(ms: number, fn: () => void): () => void
}

const realClock: Clock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
}

export interface NodeJobRunnerOptions {
  http: NodeJobHttp
  shell: NodeJobShell
  /**
   * My node chat's model: the one its agent names when this computer's
   * Claude offers it, else the node's default (local Haiku). A session runs
   * the model its claim names, never this.
   */
  model: (agentModel: string | null) => string
  /** The models this computer's Claude offers: a session's model must be one (L18). */
  offeredModels?: () => readonly OfferedNodeModel[]
  /** After each unattended start: a consumed confirmation may have moved a pin (D42). */
  onUnattendedStart?: () => void
  clock?: Clock
  log?: (message: string, detail?: unknown) => void
}

/** What the job's sidecar says when the run is over (sidecar/unattended.ts). */
interface JobDone {
  type: "job_done"
  jobId: string
  status: "done" | "token_limit" | "aborted" | "refused" | "error" | "stopped" | "restart"
  code?: string
  text: string
  refusals: JobRefusal[]
  usage: JobUsage
  error?: string
  sdkSessionId?: string | null
  /** The model the SDK said it ran on. */
  model?: string
  /** `restart` (D34): the level the session restarts at. */
  level?: string
  /** `restart` (S24): the reasoning level last applied in the run, which the next process starts at. */
  effort?: EffortLevel | null
  /** `restart` (S33): the autonomy the next process starts at. */
  autonomy?: Autonomy
  /** `restart` (S33): an autonomy switch alone (the level is the current one). */
  restartFor?: "level" | "autonomy"
  /** S1, S4, S7: the run's explicit end signal (sidecar/session-host-tools.ts). */
  completion?: NodeSessionCompletion
}

/** The steps the job's sidecar reports (sidecar/node-interactive.ts). */
interface TurnProgressLine {
  type: "turn_progress"
  jobId?: string
  events: TurnProgressEvent[]
}

/** The most steps one progress post carries (the server takes 50). */
const TURN_PROGRESS_BATCH = 50

/** A permission prompt the job's sidecar asks (sidecar/node-interactive.ts). */
interface PermissionAsk {
  type: "permission_request"
  jobId?: string
  requestId: string
  toolName: string
  input?: Record<string, unknown>
}

export const BYPASS_REFUSED_REMOTE =
  "Bypass is not available for a chat that runs on your computer: nobody is at the computer to watch what it does."

/**
 * What the owner reads on the card: the command, the file or the address the
 * tool acts on, else its input. The server redacts secrets from it.
 */
export function promptSummary(toolName: string, input: Record<string, unknown> = {}): string {
  const value =
    toolName === "Bash"
      ? input.command
      : (input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.query)
  const text = typeof value === "string" ? value : JSON.stringify(input)
  return (text ?? "").slice(0, 1000)
}

/**
 * What the owner approves, whole: a command as it runs, any other call's input
 * as pretty JSON (a file's content included). This computer asks no question
 * of its own for a node chat, so the card is where the call is seen; the
 * server refuses chat approval of one it cannot show whole or that holds a
 * secret.
 */
export function promptDetail(toolName: string, input: Record<string, unknown> = {}): string {
  if (toolName === "Bash" && typeof input.command === "string") return input.command
  return JSON.stringify(input, null, 2) ?? ""
}

function isNodeChatMode(value: unknown): value is NodeChatMode {
  return typeof value === "string" && (NODE_CHAT_MODES as readonly string[]).includes(value)
}

/** The shell's answer when the job's sidecar does not boot in time (node_job.rs, L25). */
export const BOOT_TIMEOUT_TEXT = "Claude Code did not start within 30 s"

/** The fail codes a shell refusal reports as is (R9); anything else is `error`. */
export const KNOWN_REFUSALS = [
  "auth_required",
  "sandbox_unavailable",
  "level_unconfirmed",
  "model_unavailable",
  "folder_missing",
  "worktree_failed",
  "settings_refused",
  "timeout",
  "node_outdated",
] as const

function isStale(error: unknown): boolean {
  return error instanceof NodeHttpError && error.status === 409
}

/** B2-1 (D52): the shell's (and a frozen runner's) refusal of a start claimed from another server. */
export const SERVER_CHANGED = "server_changed"

function isNodeBusy(error: unknown): boolean {
  return error instanceof NodeHttpError && error.status === 409 && error.code === "node_busy"
}

/** A routine's or an agent tag's session counts toward the background cap (D35). */
export function isBackgroundSource(source: string | null | undefined): boolean {
  return source === "routine" || source === "agent_tag"
}

function validCaps(caps: unknown): NodeCaps | null {
  const c = caps as Partial<NodeCaps> | null | undefined
  return c &&
    Number.isInteger(c.maxLive) &&
    Number.isInteger(c.maxBackground) &&
    (c.maxLive as number) >= 1 &&
    (c.maxBackground as number) >= 0
    ? { maxLive: c.maxLive as number, maxBackground: c.maxBackground as number }
    : null
}

export interface NodeJobRunner {
  /** A `node_job_offer` frame: queue it (once). The offer names the job's agent. */
  offer(jobId: string, agentId?: string): void
  /** Offers the backlog, once per launch, with no dialog (L19). */
  startup(): Promise<void>
  /** The jobs running here now. */
  running(): string[]
  /** A `node_session_command` frame: pull the commands and deliver them (C5). */
  wake(sessionId?: string): Promise<void>
  /** The socket connected again: report the live runs, then pull (D36). */
  reconnected(): Promise<void>
  /** Done once the runs a reloaded page found in the shell are reattached and reported. */
  ready: Promise<void>
  /** A `node_session_full_output` frame: send the owner a cut output's full text (S7). */
  fullOutput(sessionId: string, toolUseId: string): Promise<void>
  /**
   * D49 F9, D50: a server switch. The shell ended every follow (`host_exit`)
   * and stopped every run; resolves once each posted its end to the server
   * being left, or after `timeoutMs`, whichever comes first (best effort: the
   * lease sweep is the backstop).
   */
  settleNodeJobs(timeoutMs: number): Promise<void>
  /**
   * B2-1 (D52): a server switch is about to start. From now on nothing is
   * claimed or started: the queue is dropped, offers are ignored, and a claim
   * already answered is failed on the server that answered it, never started.
   * Called BEFORE the shell switches, so no start can carry the old server's
   * claim (and token) to the next one.
   */
  freezeNodeJobs(): void
  /** B2-1: the shell refused the switch: the runner claims again (the backlog is read anew). */
  thawNodeJobs(): void
}

/** A run found alive in the shell after a page reload (L3). */
interface AttachedRun {
  sessionId: string
  generation: number
  /** The request it started with, as the shell kept it. */
  request?: StartJobRequest
}

interface QueueEntry {
  jobId: string
  agentId?: string
  /** The job as the server holds it: its kind and source decide its slot. */
  view?: NodeJobView
  reading?: boolean
}

interface LiveSlot {
  jobId: string
  interactive: boolean
  background: boolean
  /** A follow job: its own cap, never a run's slot (A45). */
  follow?: boolean
  /** Known once claimed (or reattached): what delivery and the report name. */
  sessionId?: string
  generation?: number
}

export function createNodeJobRunner(options: NodeJobRunnerOptions): NodeJobRunner {
  const { http, shell } = options
  const clock = options.clock ?? realClock
  const log = options.log ?? (() => {})
  const queue: QueueEntry[] = []
  const live = new Map<string, LiveSlot>()
  let caps: NodeCaps = { ...NODE_SESSION_DEFAULT_CAPS }
  /** A claim was answered node_busy: nothing is claimed until a run ends (or a while passes). */
  let busy = false
  let busyRetry: (() => void) | null = null
  /** The same for follows, which the server counts apart (A45). */
  let followBusy = false
  let followRetry: (() => void) | null = null
  let backlogRead = false
  /** B2-1 (D52): a server switch is under way: nothing is claimed or started. */
  let frozen = false

  function offer(jobId: string, agentId?: string): void {
    if (frozen) return
    // An offer for the job still winding down here is kept (it was re-queued
    // once its owner confirmed): the claim after it decides, never this check.
    if (!jobId || queue.some((q) => q.jobId === jobId)) return
    queue.push({ jobId, ...(agentId ? { agentId } : {}) })
    pump()
  }

  function admissible(view: NodeJobView): boolean {
    const all = Array.from(live.values())
    // A45: a follow counts against the follows only, and runs never against it.
    if (view.kind === "follow") {
      return all.filter((s) => s.follow).length < NODE_IMPORT_LIMITS.followsPerNode
    }
    const slots = all.filter((s) => !s.follow)
    if (slots.length >= caps.maxLive) return false
    if (view.kind === "interactive" && slots.some((s) => s.interactive)) return false
    if (
      isBackgroundSource(view.source) &&
      slots.filter((s) => s.background).length >= caps.maxBackground
    ) {
      return false
    }
    return true
  }

  /** Reads a queued job (its agent, kind and source), then pumps again. */
  function read(entry: QueueEntry): void {
    entry.reading = true
    http.getJob(entry.jobId).then(
      (view) => {
        entry.reading = false
        if (!view) {
          // The job went away.
          queue.splice(queue.indexOf(entry), 1)
        } else {
          entry.view = view
        }
        pump()
      },
      (error) => {
        log("node job not read", error)
        queue.splice(queue.indexOf(entry), 1)
        pump()
      },
    )
  }

  /** Starts every queued job a slot is free for, first offered first. */
  function pump(): void {
    if (frozen) return
    for (const entry of Array.from(queue)) {
      if (!entry.view) {
        if (!entry.reading) read(entry)
        continue
      }
      if (entry.view.kind === "follow" ? followBusy : busy) continue
      if (!admissible(entry.view)) continue
      queue.splice(queue.indexOf(entry), 1)
      const view = entry.view
      launch(entry, {
        jobId: entry.jobId,
        interactive: view.kind === "interactive",
        background: isBackgroundSource(view.source),
        ...(view.kind === "follow" ? { follow: true } : {}),
      })
    }
  }

  /** A follow claim answered node_busy: follows wait until one ends here (or a while passes). */
  function followsBusy(): void {
    followBusy = true
    followRetry?.()
    followRetry = clock.every(CLAIM_RETRY_MS, () => {
      followRetry?.()
      followRetry = null
      followBusy = false
      pump()
    })
  }

  /** D49 F9, D50: called each time a run's or a follow's slot is freed. */
  const settleWaiters = new Set<() => void>()
  const slotFreed = () => {
    for (const check of [...settleWaiters]) check()
  }

  function freezeNodeJobs(): void {
    frozen = true
    queue.length = 0
    busyRetry?.()
    busyRetry = null
    followRetry?.()
    followRetry = null
  }

  function thawNodeJobs(): void {
    if (!frozen) return
    frozen = false
    busy = false
    followBusy = false
    // What was dropped at the freeze is still the server's backlog.
    backlogRead = false
    void startup()
  }

  function settleNodeJobs(timeoutMs: number): Promise<void> {
    if (live.size === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let cancel: (() => void) | null = null
      const done = () => {
        settleWaiters.delete(check)
        cancel?.()
        resolve()
      }
      const check = () => {
        if (live.size === 0) done()
      }
      settleWaiters.add(check)
      cancel = clock.every(timeoutMs, done)
    })
  }

  /** Holds a slot for one run until it is over, then frees it and pumps. */
  function launch(entry: QueueEntry, slot: LiveSlot, attached?: AttachedRun): void {
    // A run the shell already holds is re-adopted; nothing new launches frozen.
    if (frozen && !attached) return
    live.set(entry.jobId, slot)
    void (
      slot.follow && attached
        ? runFollow(entry.jobId, slot, { attached })
        : runOne(entry, slot, attached)
    )
      .then(
        (outcome) => {
          if (outcome === "busy") {
            // The server holds this node to fewer runs than this side
            // thought: the offer goes back first in line, tried again when
            // a run ends here (or after a while, when none runs).
            queue.unshift(entry)
            return "busy" as const
          }
          return "done" as const
        },
        (error) => {
          log("node job failed to run", error)
          return "done" as const
        },
      )
      .then((outcome) => {
        live.delete(entry.jobId)
        delivery.runsChanged()
        slotFreed()
        if (slot.follow) {
          // A follow's end frees a follow's place only: the runs' wait stays.
          if (outcome === "busy") followsBusy()
          else {
            followBusy = false
            followRetry?.()
            followRetry = null
          }
          pump()
          return
        }
        if (outcome === "busy") {
          busy = true
          if (live.size === 0) {
            busyRetry?.()
            busyRetry = clock.every(CLAIM_RETRY_MS, () => {
              busyRetry?.()
              busyRetry = null
              busy = false
              pump()
            })
          }
          return
        }
        busy = false
        busyRetry?.()
        busyRetry = null
        pump()
      })
  }

  async function runOne(
    entry: QueueEntry,
    slot: LiveSlot,
    attached?: AttachedRun,
  ): Promise<"busy" | undefined> {
    const jobId = entry.jobId
    // A18: the claim names the job's MCP connection, so the server keys the
    // job's taint by it. The agent comes with the offer, else from the job
    // itself. An unattended job's agent with no connection here is connected
    // first, with no dialog (CAV14); My node chat keeps its own recovery.
    let connection: string | null = null
    let claim: ClaimedJob
    if (attached) {
      // L3: a run the shell kept through a page reload. Its claim is not read
      // again: only its session and generation matter from here on.
      claim = attachedClaim(jobId, attached)
    } else
      try {
        const view = entry.view as NodeJobView
        const agentId = entry.agentId ?? view.agentId
        // A45: a follow uses no Liaison tools: it claims with no connection.
        if (view.kind !== "follow") {
          connection = await shell.connectionFor(agentId).catch(() => null)
          if (!connection && view.kind !== "interactive") {
            connection = await shell.ensureConnection(agentId).catch(() => null)
          }
        }
        const answer = await http.claim(jobId, connection)
        if (isFollowClaim(answer)) return runFollow(jobId, slot, { claim: answer })
        claim = answer
      } catch (error) {
        if (isNodeBusy(error)) return "busy"
        // P1-walk D12: the session token was refused even after a refresh
        // (the adapter retries once). The offer is kept and claimed again
        // after a while, never dropped until a restart.
        if (error instanceof NodeHttpError && error.status === 401) {
          log("node job not claimed yet: the session token was refused", error)
          return "busy"
        }
        // Another node won the claim, the job went away, or the node is off
        // (a 409 node_outdated is never expected from this runner: logged).
        log("node job not claimed", error)
        return
      }
    const claimedCaps = validCaps(claim.caps)
    if (claimedCaps) caps = claimedCaps
    // The claim is the authority on what this job is.
    if (!attached) {
      slot.interactive = claim.job.kind === "interactive"
      if (claim.job.source !== undefined) slot.background = isBackgroundSource(claim.job.source)
    }
    const generation = claim.leaseGeneration
    const agentName = claim.job.agentName ?? ""
    const interactive = claim.job.kind === "interactive"
    const chatMode = claim.job.permissionMode ?? "manual"
    const session = interactive ? undefined : claim.session
    // From here the run is this node's: the report names it and commands reach it.
    slot.generation = generation
    if (session) slot.sessionId = session.id
    delivery.runsChanged()
    /** The last outbox index enqueued: a line seen twice (outbox and live) is posted once. */
    let lastIndex = 0
    /** While a reattached run reads its outbox, live lines wait here. */
    let seeding: Array<{ events: NodeSessionEventIn[]; index?: number }> | null = attached
      ? []
      : null
    const enqueue = (events: NodeSessionEventIn[], index?: number) => {
      if (index !== undefined) {
        if (index <= lastIndex) return
        lastIndex = index
      }
      poster?.enqueue(events, index)
    }
    let poster: EventPoster | null = null
    let aborted = false
    let over = false
    const pendingAsks = new Set<() => void>()
    let settle: (done: JobDone | null) => void = () => {}
    const arm = () =>
      new Promise<JobDone | null>((resolve) => {
        settle = resolve
      })
    let finished = arm()
    /** D34: after a `restart` job_done, the old process's exit is awaited, not a failure. */
    let exitWaiter: (() => void) | null = null
    let exited: Promise<void> | null = null

    const stopRun = () => shell.stopJob(session?.id, jobId).catch(() => undefined)
    const abort = (why: string) => {
      if (aborted) return
      aborted = true
      log(`node job ${jobId} aborted: ${why}`)
      poster?.stop()
      void stopRun()
      settle(null)
    }

    // L4: only a stale lease stops the run. A lost network does not: the
    // heartbeat keeps trying every 30 s, and the run and its unsent events
    // are kept until the network is back.
    const stopHeartbeat = clock.every(HEARTBEAT_MS, () => {
      void http.heartbeat(jobId, generation).then(
        () => undefined,
        (error) => {
          if (isStale(error)) abort("stale lease")
        },
      )
    })
    const offLine = shell.onLine((run) => {
      // Only this run's own process speaks for it.
      if (run.jobId !== jobId) return
      let parsed: Partial<JobDone>
      try {
        parsed = JSON.parse(run.line)
      } catch {
        return
      }
      if (parsed.type === "job_done" && parsed.jobId === jobId) {
        if (parsed.status === "restart") {
          exited = new Promise<void>((resolve) => {
            exitWaiter = resolve
          })
        }
        settle(parsed as JobDone)
      }
      const batch = parsed as unknown as Partial<SessionEventsLine>
      if (
        batch.type === "session_events" &&
        session &&
        batch.sessionId === session.id &&
        Array.isArray(batch.events)
      ) {
        if (seeding) seeding.push({ events: batch.events, index: run.index })
        else enqueue(batch.events, run.index)
      }
      const ask = parsed as unknown as Partial<PermissionAsk>
      if (ask.type === "permission_request" && typeof ask.requestId === "string") {
        void relay(ask as PermissionAsk)
      }
      const progress = parsed as unknown as Partial<TurnProgressLine>
      if (progress.type === "turn_progress" && interactive && Array.isArray(progress.events)) {
        relayProgress(progress.events)
      }
    })

    /**
     * S24: a chat turn's steps reach its chat as they happen, in order (one
     * post at a time). Best effort: a lost step is only a live line, the
     * answer is the result. A server without the route (404) or a stale
     * lease ends the relaying for this run.
     */
    let progressChain: Promise<void> = Promise.resolve()
    let progressOff = false
    function relayProgress(events: TurnProgressEvent[]): void {
      const post = http.turnProgress?.bind(http)
      if (!post || progressOff || events.length === 0) return
      progressChain = progressChain.then(async () => {
        if (progressOff || aborted || over) return
        for (let i = 0; i < events.length; i += TURN_PROGRESS_BATCH) {
          try {
            await post(jobId, {
              leaseGeneration: generation,
              events: events.slice(i, i + TURN_PROGRESS_BATCH),
            })
          } catch (error) {
            if (error instanceof NodeHttpError && (error.status === 404 || error.status === 409)) {
              progressOff = true
            }
            log("node job turn progress not delivered", error)
            return
          }
        }
      })
    }

    /**
     * S24, A24: one prompt of an interactive job goes to its owner, wherever
     * they are, and the job gets their answer. No answer in 10 minutes, a
     * prompt that cannot reach them, or a job that ends first: deny. Nothing
     * here ever answers yes on its own.
     */
    async function relay(ask: PermissionAsk): Promise<void> {
      const answer = (allow: boolean, message?: string) =>
        shell.answerPermission(ask.requestId, allow, message).catch((error) => {
          log("node job permission answer not delivered", error)
        })
      if (!interactive) {
        await answer(false, "An unattended job never asks: refused.")
        return
      }
      let prompt: { id: string; status?: PermissionStatus; refused?: string }
      try {
        prompt = await http.permissionRequest(jobId, {
          leaseGeneration: generation,
          toolName: ask.toolName,
          summary: promptSummary(ask.toolName, ask.input),
          detail: promptDetail(ask.toolName, ask.input),
        })
      } catch (error) {
        await answer(false, "The request could not reach the owner: denied.")
        if (isStale(error)) abort("stale lease at a permission prompt")
        return
      }
      // A call the chat cannot show whole, or whose input holds a secret, is
      // never approvable from there: the server denied it at once.
      if (prompt.status === "denied") {
        await answer(
          false,
          prompt.refused === "secret"
            ? "Denied: its input contains a secret, so it cannot be approved from the chat."
            : "Denied: its input is too long to show whole, so it cannot be approved from the chat.",
        )
        return
      }
      const deadline = clock.now() + PERMISSION_TIMEOUT_MS
      const outcome = await new Promise<PermissionStatus | "timeout" | "over">((resolve) => {
        let busy = false
        let done = false
        const finishAsk = (value: PermissionStatus | "timeout" | "over") => {
          if (done) return
          done = true
          cancel()
          pendingAsks.delete(stopAsk)
          resolve(value)
        }
        const stopAsk = () => finishAsk("over")
        pendingAsks.add(stopAsk)
        const cancel = clock.every(PERMISSION_POLL_MS, () => {
          if (aborted || over) return finishAsk("over")
          if (busy) return
          busy = true
          http.permissionStatus(prompt.id).then(
            ({ status }) => {
              busy = false
              if (status === "allowed" || status === "denied") finishAsk(status)
              else if (clock.now() >= deadline) finishAsk("timeout")
            },
            () => {
              busy = false
              if (clock.now() >= deadline) finishAsk("timeout")
            },
          )
        })
      })
      if (outcome === "allowed") await answer(true)
      else if (outcome === "denied") await answer(false, "The owner denied this.")
      else if (outcome === "timeout") {
        await answer(false, "No answer from the owner within 10 minutes: denied.")
      }
      // "over": the job ended; its sidecar denies whatever is still waiting.
    }
    const offExit = shell.onExit((exit) => {
      if (exit.jobId !== jobId) return
      if (exitWaiter) {
        const waiter = exitWaiter
        exitWaiter = null
        waiter()
        return
      }
      settle(null)
    })

    /**
     * W2-D4: the run's end post, tried again on a transient failure until it
     * lands, the lease goes stale (409, or the heartbeat's abort) or the
     * tries run out. Each try re-reads the token, so a refreshed one is used.
     */
    const postEnd = async (what: string, post: () => Promise<unknown>): Promise<boolean> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await post()
          return true
        } catch (err) {
          const delay = END_POST_RETRY_MS[attempt]
          if (!isTransientPostError(err) || delay === undefined || over || aborted) {
            log(`node job ${what} not posted`, err)
            return false
          }
          log(`node job ${what} not posted, trying again in ${delay} ms`, err)
          await new Promise<void>((resolve) => {
            const cancel = clock.every(delay, () => {
              cancel()
              resolve()
            })
          })
        }
      }
    }
    const fail = async (code: string, error: string, extra: Partial<FailBody> = {}) => {
      await postEnd("fail", () =>
        http.fail(jobId, { leaseGeneration: generation, code, error, ...extra }),
      )
    }

    let startRequest: StartJobRequest | null = attached?.request ?? null
    let sessionLevel = attached?.request?.level ?? session?.level ?? null
    // COR-4 (A39, D43 F2): a server older than wave 2 validates the result's
    // completion strictly: it gets the protocol-3 shape. What the server
    // advertised in its claim decides, never what the claim happens to carry;
    // a reattached run reads it from the request the shell kept (none: 3).
    const serverProtocol = attached
      ? (attached.request?.serverProtocol ?? LEGACY_SERVER_PROTOCOL)
      : serverProtocolOf(claim)
    const serverKnowsAutonomy = serverProtocol >= NODE_PROTOCOL_AUTONOMY

    async function restart(done: JobDone): Promise<true | { code: string; error: string }> {
      const level = done.level
      const sdkSessionId = done.sdkSessionId
      if (!startRequest || !session || !level || !NODE_LEVEL_IDS.includes(level) || !sdkSessionId) {
        return { code: "error", error: "The session could not restart at its new level here." }
      }
      // The old process ends first: one process per session (node_runs.rs).
      if (exited) await exited
      exited = null
      const raise = levelRequests.get(session.id)
      levelRequests.delete(session.id)
      const {
        profileConfirmationId: _profile,
        sessionConfirmationId: _session,
        ...base
      } = startRequest
      // S24: a set_effort applied in the old process holds in the new one.
      if (done.effort !== undefined) base.effort = done.effort
      // S33: so does an autonomy switch.
      if (done.autonomy !== undefined) base.autonomy = done.autonomy
      // S33 (GF-50): an autonomy switch alone keeps the level: no level change to name.
      const forAutonomy = done.restartFor === "autonomy"
      const next: StartJobRequest = {
        ...base,
        level,
        resume: { sdkSessionId, after: forAutonomy ? "autonomy" : "level" },
        ...(sessionLevel && !forAutonomy ? { levelChange: { from: sessionLevel } } : {}),
        ...(raise?.level === level && raise.confirmationId
          ? { sessionConfirmationId: raise.confirmationId }
          : {}),
        caps,
        leaseGeneration: generation,
      }
      finished = arm()
      try {
        if (frozen) throw new NodeShellRefusal(SERVER_CHANGED)
        await shell.startJob(next)
      } catch (error) {
        const code = error instanceof NodeShellRefusal ? error.code : "error"
        const known = (KNOWN_REFUSALS as readonly string[]).includes(code)
        return { code: known ? code : "error", error: refusalText(code, error) }
      }
      startRequest = { ...base, level, caps, leaseGeneration: generation }
      sessionLevel = level
      // What the old process had not applied goes to the new one.
      delivery.forget(session.id)
      void delivery.pull()
      return true
    }

    const makePoster = (sessionId: string, firstBatchNo: number) =>
      new EventPoster({
        post: (batchNo, events) =>
          http.postEvents(sessionId, { jobId, leaseGeneration: generation, batchNo, events }),
        clock,
        log,
        firstBatchNo,
        // G6: how far the server holds this run's outbox survives a reload.
        onAcked: (index, batchNo) => {
          void shell.ack(sessionId, jobId, index, batchNo).catch((error) => {
            log("node session ack not persisted", error)
          })
        },
        onConflict: () => {
          void stopRun()
          settle(null)
        },
        onStale: () => abort("stale lease at ingest"),
      })

    try {
      if (attached) {
        // L3: post on from what the server acknowledged, outbox first, then
        // the lines heard live meanwhile (each index once).
        const acked = await shell
          .acked(attached.sessionId, jobId)
          .catch(() => ({ index: 0, batchNo: 0 }))
        poster = makePoster(attached.sessionId, acked.batchNo + 1)
        lastIndex = acked.index
        for (;;) {
          const page = await shell
            .outbox(attached.sessionId, jobId, lastIndex + 1, OUTBOX_PAGE)
            .catch((error) => {
              log("node session outbox not read", error)
              return []
            })
          for (const { index, line } of page) {
            const parsed = parseEventsLine(line, attached.sessionId)
            if (parsed) enqueue(parsed, index)
            else if (index > lastIndex) lastIndex = index
          }
          if (page.length < OUTBOX_PAGE) break
        }
        const heard = seeding ?? []
        seeding = null
        for (const line of heard) enqueue(line.events, line.index)
      }
      // A24, on this side too: a remotely driven chat never runs bypassed,
      // whatever the claim says.
      if (attached) {
        // Nothing to validate or start: the shell has run it all along.
      } else if (interactive && !isNodeChatMode(chatMode)) {
        await fail(
          "error",
          chatMode === "bypass"
            ? BYPASS_REFUSED_REMOTE
            : `Unknown permission mode for a node chat: ${chatMode}.`,
        )
        return
      }
      if (!interactive && !session) {
        await fail(
          "error",
          "The claim named no session: this computer's Liaison is newer than the server's.",
        )
        return
      }
      if (!attached && session && options.offeredModels) {
        // L18: the model runs as named or not at all, never a local fallback.
        const offered = options.offeredModels()
        if (!exactOfferedModel(session.model, offered)) {
          await fail(
            "model_unavailable",
            // Only what is offered is listed: never an older version to pick.
            `${session.model} is not offered by Claude Code on this computer (offered: ${
              currentNodeModels(offered)
                .map((m) => m.id)
                .join(", ") || "none"
            }).`,
          )
          return
        }
      }
      // My node chat runs the agent's definition; a session runs raw Claude
      // Code, with none (S13, L7).
      let agentDefinition = ""
      if (interactive) {
        try {
          agentDefinition = await http.definition(claim.job.agentId, claim.job.threadId ?? null)
        } catch (error) {
          await fail(
            "error",
            `The agent's definition could not be read: ${(error as Error).message}`,
          )
          return
        }
      }
      if (!attached && session) poster = makePoster(session.id, 1)
      if (!attached)
        try {
          startRequest = {
            jobId,
            agentId: claim.job.agentId,
            agentName,
            model: session ? session.model : options.model(claim.job.agentModel ?? null),
            profile: claim.profile,
            prompt: claim.job.prompt,
            trigger: claim.job.trigger ?? null,
            hardTokenLimit: claim.job.hardTokenLimit ?? null,
            agentDefinition,
            mcpConnectionId: connection,
            ...(interactive
              ? {
                  kind: "interactive" as const,
                  permissionMode: chatMode as NodeChatMode,
                  resumeSessionId: claim.job.sdkSessionId ?? null,
                }
              : {}),
            ...(session
              ? {
                  sessionId: session.id,
                  ...(claim.job.source ? { source: claim.job.source } : {}),
                  level: session.level,
                  profileLevel: session.profileLevel,
                  configKind: session.configKind,
                  folderPath: session.folderPath,
                  folderName: session.folderName,
                  repo: session.repo,
                  ...(session.profileConfirmationId
                    ? { profileConfirmationId: session.profileConfirmationId }
                    : {}),
                  ...(session.sessionConfirmationId
                    ? { sessionConfirmationId: session.sessionConfirmationId }
                    : {}),
                  ...(options.offeredModels
                    ? { offeredModels: options.offeredModels().map((m) => m.id) }
                    : {}),
                  effort: session.effort ?? null,
                  autonomy: session.autonomy ?? "guided",
                  finishWith: session.finishWith ?? null,
                  ...(typeof session.cwdSubdir === "string" && session.cwdSubdir
                    ? { cwdSubdir: session.cwdSubdir }
                    : {}),
                  ...(typeof session.worktreePath === "string"
                    ? { worktreePath: session.worktreePath }
                    : {}),
                  ...(typeof session.folderHeldBy === "string" && session.folderHeldBy
                    ? { folderHeldBy: session.folderHeldBy }
                    : {}),
                  serverProtocol,
                  // A resume with no SDK session starts fresh (the server's null);
                  // walk D3: a message it carries still goes, so the run acks it.
                  ...(session.resume?.sdkSessionId || session.resume?.commandId
                    ? { resume: session.resume }
                    : {}),
                }
              : {}),
            caps,
            leaseGeneration: generation,
            ...(claim.claimedFrom ? { server: claim.claimedFrom } : {}),
          }
          // B2-1: a claim answered after the freeze belongs to the server
          // being left: failed there, never started under the next one.
          if (frozen) throw new NodeShellRefusal(SERVER_CHANGED)
          await shell.startJob(startRequest)
        } catch (error) {
          poster?.stop()
          const code = error instanceof NodeShellRefusal ? error.code : "error"
          const known = (KNOWN_REFUSALS as readonly string[]).includes(code)
          await fail(known ? code : "error", refusalText(code, error))
          if (interactive && code === "auth_required") {
            // My node chat (D43): the owner decides on this computer. The job
            // has failed: nothing keeps its lease while the dialog is open, and
            // once the owner allows it (and the agent is connected) it is
            // queued again.
            stopHeartbeat()
            const answer = await shell
              .confirmConnection(claim.job.agentId, agentName)
              .catch(() => null)
            if (answer?.confirmed && answer.connected) {
              await http.rerun(jobId).catch((error) => log("node job not re-queued", error))
            }
          }
          return
        }
      if (!attached) {
        if (!interactive) options.onUnattendedStart?.()
        try {
          await http.started(jobId, generation)
        } catch (error) {
          if (isStale(error)) abort("stale lease at start")
        }
      }
      // Commands that waited for this run reach it now (C5).
      if (session) void delivery.pull()
      let done = await finished
      // D34: a level switch ends the process and starts it again at the new
      // level, resuming its SDK session: same job, same poster, same numbering.
      while (done?.status === "restart" && session && !aborted) {
        const restarted = await restart(done)
        if (restarted !== true) {
          await fail(restarted.code, restarted.error)
          return
        }
        done = await finished
      }
      if (aborted) return
      if (poster) {
        // The result waits for the last batch (at most 30 s).
        const drained = await poster.drain()
        if (poster.conflicted) {
          await fail("error", "The session's events conflicted with what the server holds.")
          return
        }
        if (aborted) return
        if (!drained) log(`node job ${jobId}: events still unsent after ${EVENT_DRAIN_MS} ms`)
      }
      if (!done) {
        await fail("error", "The job's process on this computer ended before it answered.")
        return
      }
      if (done.status === "done" || done.status === "token_limit") {
        const posted = await postEnd("result", () =>
          http.result(jobId, {
            leaseGeneration: generation,
            text: done.text,
            refusals: done.refusals ?? [],
            ...(done.usage ? { usage: done.usage } : {}),
            ...(interactive && done.sdkSessionId ? { sdkSessionId: done.sdkSessionId } : {}),
            ...(typeof done.model === "string" && done.model ? { modelId: done.model } : {}),
            ...(done.completion
              ? {
                  completion: serverKnowsAutonomy
                    ? done.completion
                    : toProtocol3Completion(done.completion),
                }
              : {}),
            ...(done.status === "token_limit" ? { endedBy: "token_limit" as const } : {}),
          }),
        )
        if (!posted) log(`node job ${jobId}: result lost; the server's lease sweep ends the job`)
      } else if (done.status === "stopped") {
        // G7: the owner's Stop; the server ends the session `stopped`.
        await fail("stopped", "Stopped by you.", {
          refusals: done.refusals ?? [],
          ...(done.usage ? { usage: done.usage } : {}),
        })
      } else if (done.status !== "aborted") {
        await fail(done.code ?? "error", done.error ?? "The job failed on this computer.", {
          refusals: done.refusals ?? [],
          ...(done.usage ? { usage: done.usage } : {}),
        })
      }
    } finally {
      over = true
      poster?.stop()
      for (const stop of Array.from(pendingAsks)) stop()
      stopHeartbeat()
      offLine()
      offExit()
    }
  }

  /**
   * A54: a command for a session a follow holds. Stop and Mark done end the
   * follow (`stop_node_follow`; its end posts `why: owner` with the offset it
   * reached); nothing else reaches a follow (the server applies it when the
   * follow ends), so it is taken without being written anywhere.
   */
  async function followCommand(sessionId: string, jobId: string, line: string): Promise<boolean> {
    const type = parseCommandLine(line)?.command.type
    if (type === "stop" || type === "mark_done") {
      await shell.stopFollow(sessionId, jobId)
    }
    return true
  }

  /**
   * One follow job (A45, A53): started in the shell's follow host from its
   * claim, or re-adopted after a page reload; heartbeated every 30 s; its
   * lines posted in order; its end posted as `/result {follow}` after the
   * last batch. A stale lease removes the follow and posts nothing.
   */
  async function runFollow(
    jobId: string,
    slot: LiveSlot,
    start: { claim: ClaimedFollow } | { attached: AttachedRun },
  ): Promise<undefined> {
    const attached = "attached" in start ? start.attached : null
    const sessionId = attached
      ? attached.sessionId
      : (start as { claim: ClaimedFollow }).claim.session.id
    const generation = attached
      ? attached.generation
      : (start as { claim: ClaimedFollow }).claim.leaseGeneration
    slot.follow = true
    slot.interactive = false
    slot.sessionId = sessionId
    slot.generation = generation
    delivery.runsChanged()
    let lastIndex = 0
    let seeding: Array<{ events: NodeSessionEventIn[]; index?: number }> | null = attached
      ? []
      : null
    let poster: EventPoster | null = null
    const enqueue = (events: NodeSessionEventIn[], index?: number) => {
      if (index !== undefined) {
        if (index <= lastIndex) return
        lastIndex = index
      }
      poster?.enqueue(events, index)
    }
    let aborted = false
    let settle: (end: NodeFollowResult | null) => void = () => {}
    const finished = new Promise<NodeFollowResult | null>((resolve) => {
      settle = resolve
    })
    const stopFollow = () => shell.stopFollow(sessionId, jobId).catch(() => false)
    const abort = (why: string) => {
      if (aborted) return
      aborted = true
      log(`node follow ${jobId} aborted: ${why}`)
      poster?.stop()
      void stopFollow()
      settle(null)
    }
    const fail = async (code: string, error: string) => {
      try {
        await http.fail(jobId, { leaseGeneration: generation, code, error })
      } catch (err) {
        log("node follow fail not recorded", err)
      }
    }
    const stopHeartbeat = clock.every(HEARTBEAT_MS, () => {
      void http.heartbeat(jobId, generation).then(
        () => undefined,
        (error) => {
          if (isStale(error)) abort("stale lease")
        },
      )
    })
    const offLine = shell.onLine((run) => {
      if (run.jobId !== jobId) return
      const events = parseEventsLine(run.line, sessionId)
      if (!events) return
      if (seeding) seeding.push({ events, index: run.index })
      else enqueue(events, run.index)
    })
    const offExit = shell.onExit((exit) => {
      if (exit.jobId !== jobId) return
      // An end the shell names no why for is the host's own exit.
      settle(exit.follow ?? { why: "host_exit" })
    })
    const makePoster = (firstBatchNo: number) =>
      new EventPoster({
        post: (batchNo, events) =>
          http.postEvents(sessionId, { jobId, leaseGeneration: generation, batchNo, events }),
        clock,
        log,
        firstBatchNo,
        onAcked: (index, batchNo) => {
          void shell.ack(sessionId, jobId, index, batchNo).catch((error) => {
            log("node session ack not persisted", error)
          })
        },
        onConflict: () => {
          void stopFollow()
          settle(null)
        },
        onStale: () => abort("stale lease at ingest"),
      })
    try {
      if (attached) {
        // As a reattached run: post on from what the server acknowledged.
        const acked = await shell.acked(sessionId, jobId).catch(() => ({ index: 0, batchNo: 0 }))
        poster = makePoster(acked.batchNo + 1)
        lastIndex = acked.index
        for (;;) {
          const page = await shell
            .outbox(sessionId, jobId, lastIndex + 1, OUTBOX_PAGE)
            .catch((error) => {
              log("node session outbox not read", error)
              return []
            })
          for (const { index, line } of page) {
            const events = parseEventsLine(line, sessionId)
            if (events) enqueue(events, index)
            else if (index > lastIndex) lastIndex = index
          }
          if (page.length < OUTBOX_PAGE) break
        }
        const heard = seeding ?? []
        seeding = null
        for (const line of heard) enqueue(line.events, line.index)
      } else {
        const claim = (start as { claim: ClaimedFollow }).claim
        const follow = nodeFollowClaimSchema.safeParse(claim.follow)
        if (!follow.success) {
          await fail("error", "The follow's claim names no transcript this computer can follow.")
          return
        }
        poster = makePoster(1)
        try {
          if (frozen) throw new NodeShellRefusal(SERVER_CHANGED)
          await shell.startFollow({
            sessionId,
            jobId,
            leaseGeneration: generation,
            ...follow.data,
            ...(claim.claimedFrom ? { server: claim.claimedFrom } : {}),
          })
        } catch (error) {
          poster.stop()
          const code = error instanceof NodeShellRefusal ? error.code : "error"
          await fail(
            code === FOLDER_NOT_SHARED
              ? "folder_missing"
              : code === UNSAFE_SUBDIR
                ? UNSAFE_SUBDIR
                : "error",
            `The follow could not start on this computer (${code}).`,
          )
          return
        }
        try {
          await http.started(jobId, generation)
        } catch (error) {
          if (isStale(error)) abort("stale lease at start")
        }
      }
      // Commands that waited for this session reach the follow now.
      void delivery.pull()
      const end = await finished
      if (aborted) return
      const drained = await poster.drain()
      if (poster.conflicted) {
        await fail("error", "The session's events conflicted with what the server holds.")
        return
      }
      if (aborted) return
      if (!drained) log(`node follow ${jobId}: events still unsent after ${EVENT_DRAIN_MS} ms`)
      if (!end) {
        await fail("error", "The follow on this computer ended before it answered.")
        return
      }
      try {
        await http.result(jobId, { leaseGeneration: generation, follow: end })
      } catch (error) {
        log("node follow result not posted", error)
      }
    } finally {
      poster?.stop()
      stopHeartbeat()
      offLine()
      offExit()
    }
  }

  async function startup(): Promise<void> {
    if (backlogRead) return
    backlogRead = true
    let jobs: BacklogJob[]
    try {
      jobs = await http.backlog()
    } catch (error) {
      backlogRead = false
      log("node backlog not read", error)
      return
    }
    // L19: no dialog. Each job is offered; it shows as queued in Sessions
    // until a slot is free. A job already running here is not offered again.
    for (const job of jobs) if (!live.has(job.id)) offer(job.id, job.agentId)
  }

  /** D36: the session runs alive here; the server pauses or resumes the rest. */
  async function report(): Promise<void> {
    const sessions: ReportedSession[] = []
    for (const slot of live.values()) {
      if (slot.interactive || !slot.sessionId || slot.generation === undefined) continue
      sessions.push({
        id: slot.sessionId,
        jobId: slot.jobId,
        leaseGeneration: slot.generation,
        alive: true,
      })
    }
    try {
      await http.report(sessions)
    } catch (error) {
      log("node sessions not reported", error)
    }
  }

  /** L3: rebuild the runs the shell kept through a page reload, then report. */
  async function reattach(): Promise<void> {
    let found: ShellLiveRun[] = []
    try {
      found = await shell.liveSessions()
    } catch (error) {
      log("node live runs not read", error)
    }
    for (const run of found) {
      if (!run || typeof run.jobId !== "string" || live.has(run.jobId)) continue
      const generation = run.leaseGeneration
      if (run.kind === "follow") {
        // C1, A53: a follow the shell holds is re-adopted as a follow: it is
        // heartbeated, posts its outbox, and the report names it alive.
        if (!run.sessionId || typeof generation !== "number") continue
        launch(
          { jobId: run.jobId },
          {
            jobId: run.jobId,
            interactive: false,
            background: false,
            follow: true,
            sessionId: run.sessionId,
            generation,
          },
          { sessionId: run.sessionId, generation },
        )
        continue
      }
      if (run.interactive || !run.sessionId || typeof generation !== "number") {
        // My node chat is not reattached (D29): its turn still holds a slot
        // until its process exits.
        const slot: LiveSlot = { jobId: run.jobId, interactive: true, background: false }
        live.set(run.jobId, slot)
        const off = shell.onExit((exit) => {
          if (exit.jobId !== run.jobId) return
          off()
          live.delete(run.jobId)
          slotFreed()
          pump()
        })
        continue
      }
      launch(
        { jobId: run.jobId },
        {
          jobId: run.jobId,
          interactive: false,
          background: run.background === true,
          sessionId: run.sessionId,
          generation,
        },
        {
          sessionId: run.sessionId,
          generation,
          ...(run.request && typeof run.request === "object" && run.request.jobId === run.jobId
            ? { request: run.request as StartJobRequest }
            : {}),
        },
      )
    }
    await report()
    delivery.runsChanged()
    await delivery.pull()
  }

  /** D34: the level each session was last switched to, with a raise's confirmation. */
  const levelRequests = new Map<string, { level: string; confirmationId?: string }>()

  const delivery = createCommandDelivery({
    onWritten: (written) => {
      if (written.command.type === "set_level") {
        const { level, confirmationId } = written.command.payload
        levelRequests.set(written.sessionId, {
          level,
          ...(confirmationId ? { confirmationId } : {}),
        })
      }
    },
    pull: () => http.getCommands(),
    write: (sessionId, line) => {
      const follow = Array.from(live.values()).find((s) => s.follow && s.sessionId === sessionId)
      return follow
        ? followCommand(sessionId, follow.jobId, line)
        : shell.writeSession(sessionId, line)
    },
    live: () => {
      const sessions = new Map<string, string>()
      for (const slot of live.values()) {
        if (slot.sessionId && slot.generation !== undefined && !slot.interactive) {
          sessions.set(slot.sessionId, slot.jobId)
        }
      }
      return sessions
    },
    clock,
    log,
  })

  const ready = reattach()

  return {
    offer,
    startup,
    running: () => Array.from(live.keys()),
    wake: async (sessionId) => {
      await ready
      // W2-D4: a wake for a session this computer runs nothing for (its run
      // ended here while its result never reached the server, so the server
      // shows it paused): the report tells the server which runs are alive,
      // and it ends the dead one and resumes the session with the command.
      if (sessionId && !Array.from(live.values()).some((slot) => slot.sessionId === sessionId)) {
        await report()
      }
      await delivery.pull()
    },
    reconnected: async () => {
      await ready
      await report()
      // Walk D4: what queued while this node was away is offered now, not at
      // the next launch (the backlog is read again once a launch read it).
      if (backlogRead) {
        backlogRead = false
        await startup()
      }
      await delivery.pull()
    },
    ready,
    settleNodeJobs,
    freezeNodeJobs,
    thawNodeJobs,
    fullOutput: async (sessionId, toolUseId) => {
      if (!UUID_RE.test(sessionId) || !TOOL_USE_ID_RE.test(toolUseId)) return
      let text: string | null
      try {
        text = await shell.spill(sessionId, toolUseId)
      } catch (error) {
        log("node session spill not read", error)
        text = null
      }
      try {
        await http.putFullOutput(sessionId, toolUseId, text)
      } catch (error) {
        log("node session full output not sent", error)
      }
    },
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The levels a session may run at (node-levels.json). */
const NODE_LEVEL_IDS: readonly string[] = ["strict", "standard", "open"]

/** The shell's refusal of a follow whose folder is not shared here (node_follow.rs). */
const FOLDER_NOT_SHARED = "FOLDER_NOT_SHARED"
/** A44: the shell refused the follow's cwd below its folder (a node fail code the web words). */
const UNSAFE_SUBDIR = "unsafe_subdir"

/** The outbox lines read per page when a run is reattached. */
const OUTBOX_PAGE = 200

/** A reattached run's claim: only the session and generation are used. */
/** The protocol of a server that advertises none: the one before wave 2. */
const LEGACY_SERVER_PROTOCOL = 3

/** D43 F2: the protocol the claiming server advertised (a positive integer), else 3. */
function serverProtocolOf(claim: ClaimedJob): number {
  const p = claim.serverProtocol
  return typeof p === "number" && Number.isInteger(p) && p > 0 ? p : LEGACY_SERVER_PROTOCOL
}

function attachedClaim(jobId: string, attached: AttachedRun): ClaimedJob {
  return {
    job: {
      id: jobId,
      agentId: "",
      agentName: null,
      prompt: "",
      trigger: null,
      hardTokenLimit: null,
      kind: "unattended",
    },
    leaseGeneration: attached.generation,
    profile: { level: "", liaisonTools: false },
    session: {
      id: attached.sessionId,
      folderPath: null,
      folderName: null,
      repo: null,
      model: "",
      level: "",
      profileLevel: "",
      configKind: "",
      liaisonTools: false,
    },
  }
}

/** A `session_events` outbox line's events, for this session only. */
function parseEventsLine(line: string, sessionId: string): NodeSessionEventIn[] | null {
  try {
    const parsed = JSON.parse(line) as Partial<SessionEventsLine>
    return parsed.type === "session_events" &&
      parsed.sessionId === sessionId &&
      Array.isArray(parsed.events)
      ? parsed.events
      : null
  } catch {
    return null
  }
}

function refusalText(code: string, error: unknown): string {
  switch (code) {
    case "level_unconfirmed":
      return "This agent's level is above what this computer has confirmed. Confirm it in Settings > Computers > Agents, then run it again."
    case "auth_required":
      return "This agent has no Liaison connection on this computer."
    case "sandbox_unavailable":
      return "Strict and Standard run every command in a sandbox, and this computer has none."
    case "timeout":
      return BOOT_TIMEOUT_TEXT
    case SERVER_CHANGED:
      return "This computer moved to another server before the job could start here."
    default:
      return (error as Error)?.message || "The job could not start on this computer."
  }
}

// ── a session's events, posted in order (spec-protocol.md §Ingest, D33, K4) ──

/** Retries back off 1, 2, 4 … 30 s. */
export const EVENT_RETRY_FIRST_MS = 1_000
export const EVENT_RETRY_MAX_MS = 30_000
/** How long the result waits for the last batch. */
export const EVENT_DRAIN_MS = 30_000

/** The sidecar's line carrying one flushed batch (sidecar/session-events.ts). */
interface SessionEventsLine {
  type: "session_events"
  sessionId: string
  events: NodeSessionEventIn[]
}

export interface EventPosterOptions {
  post: (batchNo: number, events: NodeSessionEventIn[]) => Promise<unknown>
  clock: Clock
  log?: (message: string, detail?: unknown) => void
  /** The first batch number (a reattached run posts on from its persisted ack). */
  firstBatchNo?: number
  /** A line's last batch was stored as `batchNo` (G6: persisted by the shell). */
  onAcked?: (index: number, batchNo: number) => void
  /** 409 conflict: terminal, the run is failed (the server failed it too). */
  onConflict: () => void
  /** 409 stale (or the session is not this node's): the run is aborted. */
  onStale: () => void
}

/** An event re-capped for a 413; if it is still over the limit, only its ids are kept. */
function recapped(e: NodeSessionEventIn): NodeSessionEventIn {
  const capped = capEvent(e)
  if (eventBytes(capped) <= NODE_EVENT_LIMITS.eventBytes) return capped
  const kept: Record<string, unknown> = { omitted: true }
  for (const key of ["id", "requestId", "toolUseId"]) {
    if (key in e.payload) kept[key] = e.payload[key]
  }
  return { at: e.at, type: e.type, payload: kept, truncated: true, fullBytes: eventBytes(e) }
}

/**
 * One run's event poster: batches numbered from 1, one in flight, the next
 * only after a 200. A gap re-sends from the batch the server expects (the
 * unacknowledged batches are kept); a 413 re-caps the named event, or splits
 * the batch in two, under the same batch number; a network error retries with
 * backoff, keeping the order.
 */
/** One queued batch: its events, and the outbox line it ends (G6), if any. */
interface QueuedBatch {
  events: NodeSessionEventIn[]
  /** The outbox index of the line this batch belongs to. */
  index?: number
  /** Whether it is that line's last batch. */
  last: boolean
}

export class EventPoster {
  private readonly queue: QueuedBatch[] = []
  /** The batch number of `queue[0]`. */
  private base = 1
  private inFlight = false
  private stopped = false
  private backoff = EVENT_RETRY_FIRST_MS
  private retryCancel: (() => void) | null = null
  private readonly idleWaiters = new Set<() => void>()
  conflicted = false

  constructor(private readonly o: EventPosterOptions) {
    if (Number.isInteger(o.firstBatchNo) && (o.firstBatchNo as number) >= 1) {
      this.base = o.firstBatchNo as number
    }
  }

  /** One sidecar line's events; `index` is its outbox ordinal (G6). */
  enqueue(events: readonly NodeSessionEventIn[], index?: number): void {
    if (this.stopped) return
    if (events.length === 0) {
      // Nothing to send: the line is done as soon as everything before it is.
      if (index !== undefined && this.queue.length === 0 && !this.inFlight) {
        this.o.onAcked?.(index, this.base - 1)
      }
      return
    }
    const batches = splitIntoBatches(events.map(capEvent))
    batches.forEach((events, i) => {
      this.queue.push({
        events,
        ...(index !== undefined ? { index } : {}),
        last: i === batches.length - 1,
      })
    })
    this.pump()
  }

  /** A batch that ends its line was stored as `batchNo`. */
  private acked(batch: QueuedBatch, batchNo: number): void {
    if (batch.last && batch.index !== undefined) this.o.onAcked?.(batch.index, batchNo)
  }

  /** Nothing waits to be sent, or the poster stopped. */
  get idle(): boolean {
    return this.stopped || (this.queue.length === 0 && !this.inFlight)
  }

  stop(): void {
    this.stopped = true
    this.retryCancel?.()
    this.retryCancel = null
    this.notify()
  }

  /** Resolves true once every batch was acknowledged, false on a stop or after `ms`. */
  drain(ms: number = EVENT_DRAIN_MS): Promise<boolean> {
    const settled = () => this.queue.length === 0 && !this.inFlight && !this.conflicted
    if (this.idle) return Promise.resolve(settled())
    return new Promise((resolve) => {
      let cancel = () => {}
      const done = () => {
        this.idleWaiters.delete(done)
        cancel()
        resolve(settled())
      }
      this.idleWaiters.add(done)
      cancel = this.o.clock.every(ms, done)
    })
  }

  private notify(): void {
    if (!this.idle) return
    for (const waiter of Array.from(this.idleWaiters)) waiter()
  }

  private pump(): void {
    if (this.stopped || this.inFlight || this.retryCancel || this.queue.length === 0) {
      this.notify()
      return
    }
    const batch = this.queue[0] as QueuedBatch
    const batchNo = this.base
    this.inFlight = true
    this.o.post(batchNo, batch.events).then(
      () => {
        this.inFlight = false
        if (this.queue[0] === batch) {
          this.queue.shift()
          this.base++
          this.acked(batch, batchNo)
        }
        this.backoff = EVENT_RETRY_FIRST_MS
        this.pump()
      },
      (error) => {
        this.inFlight = false
        this.failed(error, batch)
      },
    )
  }

  private failed(error: unknown, batch: QueuedBatch): void {
    if (this.stopped) {
      this.notify()
      return
    }
    const http = error instanceof NodeHttpError ? error : null
    if (http?.status === 409 && http.code === "gap") {
      const expected = Number(http.details.expectedBatchNo)
      if (Number.isInteger(expected) && expected >= 1) {
        // The server holds everything before `expected`: the batches below it
        // were stored (their answer was lost) and are dropped; otherwise the
        // first unacknowledged batch is sent again as `expected`.
        if (expected > this.base) {
          const dropped = this.queue.splice(0, Math.min(expected - this.base, this.queue.length))
          for (const [i, stored] of dropped.entries()) this.acked(stored, this.base + i)
        }
        this.base = expected
        this.pump()
        return
      }
    }
    if (http?.status === 409 && http.code === "conflict") {
      this.conflicted = true
      this.o.log?.("node session events: conflict, the run is failed", http)
      this.stop()
      this.o.onConflict()
      return
    }
    if (
      (http?.status === 409 && http.code === "stale") ||
      http?.status === 403 ||
      http?.status === 404
    ) {
      this.o.log?.("node session events: not this run's any more", http)
      this.stop()
      this.o.onStale()
      return
    }
    if (http?.status === 413 && this.queue[0] === batch) {
      // Nothing of the batch was stored: it goes again under the same number.
      const events = batch.events
      const index = Number(http.details.index)
      if (http.code === "event_too_large" && Number.isInteger(index) && events[index]) {
        events[index] = recapped(events[index] as NodeSessionEventIn)
        this.pump()
        return
      }
      if (events.length > 1) {
        // G6: the split shifts the numbering of what follows; the ack of the
        // line's last half persists the shift.
        const half = Math.ceil(events.length / 2)
        const line = batch.index !== undefined ? { index: batch.index } : {}
        this.queue.splice(
          0,
          1,
          { events: events.slice(0, half), ...line, last: false },
          { events: events.slice(half), ...line, last: batch.last },
        )
        this.pump()
        return
      }
      events[0] = recapped(events[0] as NodeSessionEventIn)
      this.pump()
      return
    }
    if (http?.status === 400 && this.queue[0] === batch) {
      // A batch the server's schema refuses would be refused forever: logged,
      // dropped, and the next one takes its number.
      this.o.log?.("node session events: a batch was refused and dropped", http)
      this.queue.shift()
      this.acked(batch, this.base - 1)
      this.pump()
      return
    }
    // The network, a 5xx, a lapsed session: again, in order, with backoff.
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, EVENT_RETRY_MAX_MS)
    this.retryCancel = this.o.clock.every(delay, () => {
      this.retryCancel?.()
      this.retryCancel = null
      this.pump()
    })
  }
}
