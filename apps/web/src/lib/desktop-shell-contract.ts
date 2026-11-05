// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT THIS PAGE SHARES WITH THE DESKTOP SHELL, and nothing else.
//
// The shell (apps/desktop) wraps this app unmodified and runs one injected
// script in its page. That script publishes ONE plain object on the window;
// this file is the type of that object, the resolver that finds it, and the
// empty state a browser gets instead.
//
// It used to be something else, and the difference is the whole of A33. The
// shell drew its own UI over this page and, to know which agent the user was
// talking to, it GUESSED: it scraped the thread header, then it read identity
// attributes this app published for it. Both halves of that are gone. The page
// renders every pixel of a local session itself, in its own components, so
// there is nothing left to guess and nothing left to announce: no
// `data-liaison-*` attributes, no reserved slot for a badge the shell draws,
// no document event carrying a new message.
//
// The division of labour, in one sentence each:
//
//   - The PAGE renders. Every pixel of a local session is an apps/web
//     component, on apps/web's tokens, inside the surfaces the user knows.
//   - The SHELL acts. Picking a folder, spawning the sidecar, sending a turn,
//     answering a permission prompt: all of it is a Tauri command, and the
//     bridge is a facade over exactly the commands the shell already has. It
//     adds none.
//
// A BROWSER HAS NO BRIDGE AND THEREFORE NO DESKTOP UI. `getDesktopBridge`
// answers null there, every surface below renders nothing rather than
// rendering disabled, and the browser's markup is byte identical to what it
// was before this slice (the pin is modules/desktop/browser-baseline.snap).
//
// Nothing crosses this boundary that either side would have to own: every
// field is a string, a number, a boolean, or an array of plain objects of
// those. No Solid signal, no store, no DOM node, no class instance.

import { EFFORT_LEVELS, type EffortLevel } from "@liaison/shared"

/** The bridge shape this build of apps/web understands. Bumped on a break. */
export const DESKTOP_BRIDGE_VERSION = 1

/** The window property the shell publishes itself on. */
export const DESKTOP_BRIDGE_KEY = "__LIAISON_DESKTOP__"

/**
 * The window property THE PAGE publishes for the shell's Reload (menu, Ctrl+R,
 * F5). The shell calls it with the reload it would do; the page answers true
 * when it took the reload over (it asks first, because a draft or a staged
 * file would be lost, and calls `proceed` only if the person confirms), false
 * when the shell may reload at once.
 */
export const PAGE_RELOAD_GUARD_KEY = "__LIAISON_RELOAD_GUARD__"

export type PageReloadGuard = (proceed: () => void) => boolean

/**
 * THE EVENT THAT SAYS THE BRIDGE IS THERE NOW (P6d-FX3, W1).
 *
 * The shell publishes the bridge from an initialization script, so in the
 * product it is on the window before any page module runs and the store's own
 * read at module load finds it. That ordering is the shell's to keep, and a
 * shell that ever loses it used to cost the window every desktop surface until
 * the user signed out and back in, because the store resolved the bridge once
 * and nothing re-resolved it.
 *
 * So the shell also ANNOUNCES the publication on the window, and the store
 * listens. Both orders work now: the page that loads second reads, the page
 * that loaded first hears.
 */
export const DESKTOP_BRIDGE_EVENT = "liaison:desktop-bridge"

/** Where the turns of a conversation execute. */
export type DesktopRuntimeLocation = "local" | "liaison"

/**
 * THE MODELS A TURN ON THIS MACHINE CAN RUN ON, and nothing else.
 *
 * A local turn runs on the user's own Claude Code login through the Agent SDK,
 * so the only models it can reach are Claude models, named by the ids the SDK
 * takes (`Options.model`). The list is the SDK's own: the sidecar asks the
 * running session (`Query.supportedModels()`) and the shell offers what it
 * answered, so a model the installed SDK knows appears without a change here.
 * The Liaison models are a different list with a different owner: some of
 * their ids are Claude ids too (`claude-haiku-4-5`), which is exactly why the
 * two choices are kept in two separate places and the shell refuses anything
 * that is not in the local one. Labels are product names and are not
 * translated.
 */
export interface DesktopLocalModel {
  id: string
  label: string
  /** S25: the reasoning levels the model takes (the SDK's); absent, it takes none. */
  efforts?: EffortLevel[]
}

/**
 * WHAT IS OFFERED UNTIL THE SDK HAS ANSWERED, and whenever it cannot: before
 * the shell's launch discovery (`claude_local_models`) returns, after one
 * that failed or timed out, and by a shell that predates discovery. Every id
 * here is one the SDK accepts as `Options.model`: the ids its family aliases
 * resolved to on SDK 0.3.296.
 */
export const DESKTOP_FALLBACK_LOCAL_MODELS: readonly DesktopLocalModel[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
]

/**
 * THE IDS A PAGE OLDER THAN DISCOVERY NAMES: the fallback it was built with.
 * Kept startable and labelled (`isStartableLocalModel`), never offered.
 */
export const DESKTOP_LEGACY_LOCAL_MODELS: readonly DesktopLocalModel[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
]

// The model matcher lives in packages/shared so the API checks the same
// rules (P1-T03); re-exported here under the same names for every page caller.
export {
  DESKTOP_DEFAULT_LOCAL_MODEL,
  defaultLocalModel,
  offeredLocalModelFor,
} from "@liaison/shared"

/** The longest model id or label accepted from the sidecar or from storage. */
const MAX_LOCAL_MODEL_FIELD = 200

/**
 * Whether a value is shaped like a model id: a non-empty string of bounded
 * length. It says nothing about whether the id is OFFERED, which is the check
 * that keeps a Liaison model away from the sidecar (`isOfferedLocalModel`).
 */
export function isLocalModelId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_LOCAL_MODEL_FIELD
}

/** Whether an id is one of the offered local models (and therefore safe for the sidecar). */
export function isOfferedLocalModel(
  id: unknown,
  offered: readonly DesktopLocalModel[],
): id is string {
  return isLocalModelId(id) && offered.some((model) => model.id === id)
}

/**
 * Whether the shell starts a session on this id: one it offers, or one of the
 * fallback or legacy ids. The legacy ids stay accepted because a page older
 * than discovery names them (its default is `claude-haiku-4-5`, which the SDK
 * may offer only as a dated snapshot), and they are ids the SDK takes as
 * `Options.model`. Accepted as named, not mapped: that page restarts the
 * session whenever the state's model differs from the one it asked for.
 */
export function isStartableLocalModel(
  id: unknown,
  offered: readonly DesktopLocalModel[],
): id is string {
  return (
    isOfferedLocalModel(id, offered) ||
    isOfferedLocalModel(id, DESKTOP_FALLBACK_LOCAL_MODELS) ||
    isOfferedLocalModel(id, DESKTOP_LEGACY_LOCAL_MODELS)
  )
}

/** The display name of a local model id among those offered, or null. */
export function desktopLocalModelLabel(
  id: string | null | undefined,
  offered: readonly DesktopLocalModel[],
): string | null {
  return offered.find((model) => model.id === id)?.label ?? null
}

/**
 * A list of local models read from somewhere this side does not control (the
 * sidecar's `local_models` line, a stored copy of it), or null when it is not
 * one. Malformed rows are dropped, duplicates keep their first row, and an
 * empty result is null: an empty list would offer nothing at all, which is
 * never better than the fallback.
 */
export function parseLocalModels(value: unknown): DesktopLocalModel[] | null {
  if (!Array.isArray(value)) return null
  const models: DesktopLocalModel[] = []
  for (const row of value) {
    const { id, label, efforts } = (row ?? {}) as {
      id?: unknown
      label?: unknown
      efforts?: unknown
    }
    if (!isLocalModelId(id) || models.some((model) => model.id === id)) continue
    const named =
      typeof label === "string" && label.length > 0 && label.length <= MAX_LOCAL_MODEL_FIELD
    // S25: only levels the SDK names; unknown ones are dropped, none left is none.
    const levels = Array.isArray(efforts)
      ? EFFORT_LEVELS.filter((level) => efforts.includes(level))
      : []
    models.push({
      id,
      label: named ? label : id,
      ...(levels.length > 0 ? { efforts: levels } : {}),
    })
  }
  return models.length > 0 ? models : null
}

/** The five modes, as the sidecar maps them. Auto is the default. */
export type DesktopPermissionMode = "auto" | "manual" | "edit" | "plan" | "bypass"

/** The mode a session is in before anybody chose one. */
export const DEFAULT_DESKTOP_PERMISSION_MODE: DesktopPermissionMode = "auto"

/** Whether the window still believes it is talking to a live sidecar. */
export type DesktopSessionStatus = "idle" | "starting" | "running" | "stopped"

/** What the user can answer a permission prompt with. */
export type DesktopPermissionDecision = "allow" | "deny"

/** One tool call the local session has made, as an activity row renders it. */
export interface DesktopToolActivity {
  /** Stable for the life of the call, so a row can update rather than repeat. */
  id: string
  toolName: string
  /** A one line summary the shell already computed. Never a raw input blob. */
  summary: string
  status: "running" | "done" | "error"
  /** Epoch milliseconds, so the row can order itself without a clock of its own. */
  startedAt: number
  /**
   * THIS CALL WAS ALLOWED BY THE MODE CHANGE, not by the user (P6d-FX2, SK-5).
   *
   * Switching to Bypass while a prompt is parked answers that prompt, because
   * Bypass means allow and the SDK is parked on a question that is about to
   * have no card. Who said yes is not the same fact as that yes happened, so
   * the row that raised the prompt carries it.
   */
  allowedByBypass?: boolean
}

/** One prompt the session is blocked on. */
export interface DesktopPermissionRequest {
  requestId: string
  toolName: string
  /** A one line summary of what is being asked for. */
  summary: string
  /**
   * THE ROW THIS CARD BELONGS IN, by the SDK's own tool use id.
   *
   * Placement used to be guessed from the tool's NAME: the last row still
   * running under it. Two calls to the same tool in one turn therefore both
   * resolved to the second row, and a prompt whose tool had no row yet drew no
   * card at all, which stalls the turn with a question nobody can answer. The
   * shell resolves the id instead, and guarantees a row exists for it.
   */
  toolUseId: string
}

/**
 * What the window can SEE about the gated call it is waiting on.
 *
 * Three states, never collapsed into two: pending means somebody has to
 * decide, `unknown` means the window could not find out (the status tool
 * failed, the request is not known to the server, or the server answered
 * something this build has never heard of), and null means there is nothing
 * to say. Telling a user their request is queued when it may have been lost
 * is worse than admitting the window cannot see, which is the whole reason
 * the status path exists (P6d-T13).
 */
export type DesktopApprovalStatus = "pending" | "unknown"

/**
 * EVERY WAY A START CAN REFUSE, as one vocabulary (P6d-FX5, W8).
 *
 * Six of them the shell decides on its own before anything is asked of the
 * server, four come from the three server steps a start makes
 * (`session/start-local-session.ts`), seven are the shell's own `start_session`
 * variants (`sidecar-ipc-contract.md`), and the last is everything else.
 *
 * The state's `startError` is a plain string rather than this union, the way
 * `reconnectReason` is: a shell of another build may name a refusal this page
 * has never heard of, and a page that typed that away would be claiming a
 * completeness neither half can keep. The copy map has a fallback, and the
 * fallback is still a sentence.
 */
export type DesktopStartRefusal =
  /** A start is already in flight in this window. */
  | "AlreadyStarting"
  /** The caller named a PATH, which is the shape that let a page root a session. */
  | "PathNotAllowed"
  /** A folder handle this shell never issued. */
  | "UnknownFolder"
  /** No folder has been chosen yet. */
  | "NoFolderChosen"
  /** No conversation to answer in: a session claims a (thread, agent) pair. */
  | "NoConversation"
  /** No server bound, or no session token: nothing to audit or claim with. */
  | "NotSignedIn"
  /** The account may not read this agent's definition. */
  | "AgentDefinitionRefused"
  /** The start could not be audited, and an unaudited session never runs. */
  | "AuditRefused"
  /** Another machine is already running this conversation. */
  | "ConversationClaimed"
  /** This window's OWN lease still holds the conversation: a release that
   *  never reached the server, and nothing to go and stop anywhere. */
  | "ClaimHeldHere"
  /** The claim was refused for any other reason. */
  | "ClaimRefused"
  /** The shell's own `start_session` variants. */
  | "UnknownPermissionMode"
  | "CwdNotADirectory"
  | "BypassDeclined"
  /** Auto or Edit was not confirmed in the shell's own dialog (D11). */
  | "ModeDeclined"
  | "TokenRefreshFailed"
  | "ConfigUnwritable"
  | "SidecarSpawnFailed"
  | "NotApproved"
  /** The server refuses to start a device grant for the desktop at all: its
   *  `DEVICE_FLOW_CLIENTS` does not admit it. An administrator has to act. */
  | "DeviceClientNotAllowed"
  /** The device grant was refused for another reason the server named. */
  | "GrantFailed"
  /** The Liaison server could not be reached to grant the token. */
  | "Unreachable"
  /** A model that is not one of the offered local models (a Liaison model, say). */
  | "UnknownModel"
  /** The sidecar exited before its first line: it refused its arguments, or
   *  crashed on start. `startErrorDetail` carries what it wrote to stderr. */
  | "SidecarExited"
  /** Claude on this computer is not signed in: a local turn cannot run until
   *  the person signs in (`claudeSignInNeeded` says for which conversation). */
  | "ClaudeSignInRequired"
  /** Anything else that threw on the way to a running sidecar. */
  | "StartFailed"

/**
 * WHY A NEW SERVER ADDRESS WAS REFUSED, as the shell names it. Anything else
 * (a scheme it will not store, a malformed address) reads as an invalid
 * address.
 */
/** One local turn the sidecar's death took with it. */
export interface DesktopTurnFailure {
  /** The conversation the dead session was answering. */
  threadId: string
  /** The agent it ran as, which a Retry starts again. */
  agentId: string
  /** The message whose turn died, or null when the session died between turns. */
  messageId: string | null
  /** What the sidecar said last, one line, or how it ended. */
  reason: string
  /**
   * `undelivered`: the turn FINISHED and its answer could not be posted; it is
   * kept on this computer and the Retry posts it rather than running the turn
   * again. `stopped` (the default, and what an older shell means): the turn
   * itself did not finish.
   */
  kind?: "stopped" | "undelivered"
}

/**
 * A LOCAL SESSION THAT STARTED NEW BECAUSE THE AGENT CHANGED (2026-09-23). The
 * shell resumes a stored session only under the definition it was created
 * with; when the org changed the agent, the next start is a new session, and
 * the conversation says so once, quietly, over that session's first turn.
 */
export interface DesktopFreshSession {
  threadId: string
  agentId: string
  reason: "definition_changed"
}

/**
 * THE CLAUDE ACCOUNT A LOCAL TURN RUNS ON (2026-09-24).
 *
 * A local turn runs on the Claude Code CLI inside the desktop app, with that
 * CLI's own sign-in. Somebody who only ever used the Claude desktop app has
 * none, and their first local turn failed with "Failed to authenticate". The
 * shell can now sign in from the app; this is what it knows about it.
 */
export interface DesktopClaudeAccount {
  loggedIn: boolean
  /** The account's email, when the CLI names one. */
  email: string | null
}

/**
 * Where a sign-in to Claude is. The page draws its dialog from this and
 * nothing else; the sign-in URL and the code never cross.
 *
 * - `starting`: the shell is starting the sign-in.
 * - `waiting`: the page is open in the browser, and a code may be pasted.
 * - `checking`: a code was handed over and the CLI is checking it.
 * - `codeRejected`: the CLI said that is not a whole code; it still waits.
 * - `failed`: the sign-in ended without an account (`reason` says how).
 */
export type DesktopClaudeSignInPhase =
  | "starting"
  | "waiting"
  | "checking"
  | "codeRejected"
  | "failed"

export interface DesktopClaudeSignIn {
  phase: DesktopClaudeSignInPhase
  /** For `failed`: `failed`, `timeout`, `cli_missing`, or the shell's own refusal. */
  reason?: string | null
  /** For `failed`: what the CLI said, one redacted line. */
  detail?: string | null
}

/**
 * A LOCAL TURN THAT NEEDS A CLAUDE SIGN-IN, or a start refused for want of
 * one, for this conversation. The page draws a notice with "Sign in to Claude"
 * over the composer; the turn's own failure line keeps its Retry.
 */
export interface DesktopClaudeSignInNeeded {
  threadId: string
  agentId: string
  /** The message whose turn failed, or null for a start that was refused. */
  messageId: string | null
}

/**
 * What a click on a local path did: opened it, revealed it in its folder (a
 * program is never run), found nothing there, refused it as a network path
 * (never touched, see `local_path.rs`), or could not show it.
 */
export type DesktopLocalPathOutcome = "opened" | "revealed" | "not_found" | "network" | "failed"

/** A folder this agent has run in before, newest first. */
export interface DesktopRecentFolder {
  /**
   * THE ONLY WAY THE PAGE MAY NAME A FOLDER (P6d-FX2, SK-1).
   *
   * An opaque handle the SHELL issued for a folder it chose itself. The page
   * hands one back to start a session; it never composes one, and a handle the
   * shell does not recognise starts nothing. The `path` beside it is for
   * DRAWING the row and nothing else.
   */
  id: string
  path: string
  /** The last segment, which is the only part a trigger ever shows. */
  name: string
}

/**
 * AN IN-APP UPDATE THE SHELL IS DOWNLOADING OR INSTALLING, as the shell's
 * `liaison-update-progress` event says it (`src-tauri/src/updater.rs`,
 * `update_progress_payload`). `percent` is null while the size is unknown and
 * for the whole install, which has no measure.
 */
export interface DesktopUpdateProgress {
  version: string
  phase: "downloading" | "installing"
  percent: number | null
}

/** A file the running session produced, offered to the composer's attach. */
export interface DesktopProducedFile {
  path: string
  name: string
}

/** Everything a desktop surface renders from. Plain data, all of it. */
export interface DesktopSessionState {
  runtimeLocation: DesktopRuntimeLocation
  /** The folder the live or next session runs in, or null. */
  folderPath: string | null
  permissionMode: DesktopPermissionMode
  sessionStatus: DesktopSessionStatus
  /** The conversation the live session answers in, or null. */
  threadId: string | null
  /** The agent whose turns the live session runs, or null. */
  agentId: string | null
  /** Folders this agent has run in, newest first, capped by the shell at five. */
  recentFolders: DesktopRecentFolder[]
  toolActivity: DesktopToolActivity[]
  /**
   * Every prompt the session is waiting on, in arrival order.
   *
   * A LIST and not one slot: the shell held a single `pendingPermission`, so a
   * second prompt arriving before the first was answered overwrote it, and the
   * first was left unanswered and unanswerable from the UI until the sidecar's
   * own timeout. Two prompts in flight are both answerable, in order.
   */
  pendingPermissions: DesktopPermissionRequest[]
  /** The gated call the session is waiting on, or null. */
  pendingApprovalRequestId: string | null
  /**
   * What the shell last learned about that call. Optional because the shell
   * half that polls for it is wired in P6d-T16a, when the banner that polls
   * today is deleted; a shell that does not answer it leaves the page saying
   * "waiting" and never "unknown", which is the safe half of the pair.
   */
  approvalStatus?: DesktopApprovalStatus | null
  /** Why the shell gave up on the session, or null. */
  reconnectReason: string | null
  /**
   * WHY THE LAST START REFUSED, as the shell's own reason code, or null
   * (P6d-FX5, W8).
   *
   * `startSession` answers false for a dozen different reasons and used to say
   * nothing else at all: a user who asked for a session on this machine got a
   * window identical to the one before the click, with no toast, no line in
   * the control and no way to tell a refusal from a control that does not
   * work. The shell names the refusal here and the page turns it into a
   * sentence (`modules/desktop/desktop-notices.ts`).
   *
   * A CODE, never a sentence: the copy a person reads belongs to the page, the
   * same way the reconnect reasons are handled. Optional because an older
   * shell around this page fills it with nothing, which is the window that
   * existed before this field.
   */
  startError?: string | null
  /**
   * What the sidecar itself said when the last start refused with
   * `SidecarExited`, as one line of its stderr, or null. Plain text from a
   * process on this machine, never a code: the page shows it after its own
   * sentence rather than instead of one.
   */
  startErrorDetail?: string | null
  /**
   * Who holds the conversation when the last start refused with
   * `ConversationClaimed`, or null. Optional: an older shell never says, and
   * the page then words the refusal without a name.
   */
  startClaimHolder?: DesktopClaimHolder | null
  /**
   * A LOCAL TURN THAT DIED WITH ITS SIDECAR (2026-09-23), or null.
   *
   * A sidecar that exits while a session is running takes the turn with it,
   * and the window used to go on waiting for a reply nobody was going to send:
   * no error, no reply, and the claim still keeping the server away from the
   * conversation. The shell now ends the session, releases the claim and
   * names what happened here, and the page draws it on the conversation with
   * a Retry. Optional because an older shell never says.
   */
  turnFailure?: DesktopTurnFailure | null
  /**
   * The running session started new because the agent's definition changed,
   * or null. Cleared when its first turn ends. Optional: an older shell never
   * says, and the page then draws nothing.
   */
  freshSession?: DesktopFreshSession | null
  /**
   * The Claude account local turns run on, or null while the shell has not
   * asked. Optional: an older shell never says.
   */
  claudeAccount?: DesktopClaudeAccount | null
  /**
   * The local models on offer, with their labels: what the installed Agent SDK
   * advertised, or the fallback list until it has. Optional: an older shell
   * never says, and the page then labels `DesktopBridge.localModels` itself.
   */
  localModels?: DesktopLocalModel[]
  /** A sign-in to Claude in progress, or null. Optional, like every late field. */
  claudeSignIn?: DesktopClaudeSignIn | null
  /** The conversation that needs a Claude sign-in, or null. */
  claudeSignInNeeded?: DesktopClaudeSignInNeeded | null
  /** The verification URI the shell is waiting to have approved, or null. */
  deviceApproval: string | null
  /**
   * The update being downloaded or installed, or null. The page covers the
   * whole window with it, on every screen, because the title bar and the
   * taskbar progress it replaces went unnoticed. Optional: an older shell
   * never says.
   */
  updateProgress?: DesktopUpdateProgress | null
  /**
   * An address a `liaison://connect` link proposed, NOT yet applied.
   *
   * The operating system hands the app that link on behalf of whatever page
   * asked for it, so the address is shown and the user confirms it with a
   * click (FX1). Optional because the shell half that forwards it into this
   * state is wired in P6d-T16a, when the overlay's own first launch panel is
   * deleted; until then the field is simply absent and the step asks.
   */
  deepLinkAddress?: string | null
  /**
   * THE USER ASKED TO ADD A SERVER, from the Servers switcher's "Add a
   * server...".
   *
   * The address is asked for here: the page draws its connect step (a dialog over a signed in window,
   * the login card's first step otherwise), and the address goes to
   * `setServerAddress` like any other. Optional: an older shell has no such step.
   */
  addingServer?: boolean
  producedFiles: DesktopProducedFile[]
  /**
   * The model the live session runs on, or null with none running. Optional
   * because a shell that predates the local model choice never says, and the
   * page then has nothing to reconcile against.
   */
  model?: string | null
  /**
   * Whether a turn is RUNNING on this machine right now.
   *
   * The tool activity rows outlive the turn that made them on purpose: they
   * are the only place a local turn's calls are drawn, so clearing them at the
   * end would erase what the turn did. The page used to read that same list as
   * "a turn is live", which left every finished local turn with a permanent
   * streaming block, and its "Generating...", under the agent's own reply.
   * This says when the turn is over; the rows say what it did.
   */
  turnActive: boolean
}

/**
 * What the page asks the shell to start.
 *
 * THERE IS NO PATH HERE, and that is the point (P6d-FX2, SK-1). It used to
 * carry `folderPath`, an arbitrary string: the folder a session starts in is
 * the root `readLocalFile` is bounded by, so a page script naming it could
 * root a session at `/` and then read anything on the machine through the
 * shell. The page names a folder the SHELL chose, by the handle the shell
 * issued for it (the native picker's answer, or a row of `recentFolders`), and
 * the shell refuses a handle it did not issue. Omitting it means the folder
 * already in the state, which got there the same way.
 */
export interface DesktopStartSessionInput {
  agentId: string
  /** The conversation whose turns this session takes over (A32). */
  threadId: string
  /** A `DesktopRecentFolder["id"]`, or the id `pickFolder` last answered with. */
  folderId?: string
  /**
   * The local model this conversation runs on, one of the offered local models.
   * Omitted means the shell's default. The shell refuses any other id rather
   * than hand a Liaison model to the sidecar.
   */
  model?: string
  /**
   * Take the conversation from the machine that holds it, on purpose and in
   * the open (the server audits it). Only ever sent after the person pressed
   * "Take over" on a `ConversationClaimed` refusal; never the default.
   */
  takeOver?: boolean
}

/**
 * WHO HOLDS A CONVERSATION THIS WINDOW WAS REFUSED (2026-09-23), as the server
 * said it on the 409. "Another machine" alone sent a person looking for a
 * computer that, after a relaunch, was their own; the page now says whose.
 */
export interface DesktopClaimHolder {
  /** The same account, on another computer (or another install). */
  sameUser: boolean
  /** The holder's name when it is somebody else, or null. */
  holderName: string | null
  /** Whether an explicit takeover would be accepted. */
  canTakeOver: boolean
}

/** One native notification, as the page asks the shell for it. */
export interface DesktopNotification {
  title: string
  body: string
  /** Collapses a burst in the browser; the desktop plugin ignores it. */
  tag: string
  /**
   * Where a click opens the item (LIF-18): `thread/<id>[?replyRoot=<id>]` or
   * `attention/<app>/<type>/<id>`, resolved by the page
   * (modules/notifications/open-route.ts). A shell that hears the click
   * (`notificationClickSupport`) hands it back through `onNotificationClick`;
   * one that does not carries it unused, and the page offers the item itself.
   */
  route?: string
  /**
   * Plays the system's default sound: true for a direct message or a mention
   * (notification group `direct`), absent or false for the rest. The user
   * still silences the app in the system's notification settings.
   */
  sound?: boolean
}

/** The notification permission, in the browser's own three words. */
export type DesktopNotificationPermission = "granted" | "denied" | "default"

/**
 * THIS COMPUTER AS THE USER'S NODE (P4 N-D T4, S19): what the shell keeps for
 * the current server after "Use this computer as my node" registered it. The
 * credential is the server's node credential (A25), kept by the shell in a
 * 0600 file per server, never in the page's storage.
 */
export interface DesktopNodeRecord {
  nodeId: string
  credential: string
  /** The switch. Off keeps the credential (turning back on is a PATCH). */
  enabled: boolean
}

/** Keep awake while on power, as the shell holds it. */
export interface DesktopKeepAwake {
  /** The user's choice. */
  enabled: boolean
  /** False on an OS where the shell cannot hold a power assertion. */
  supported: boolean
  /** Whether the node is on for the current server. */
  nodeOn: boolean
  power: "ac" | "battery" | "unknown"
  /** Whether the machine is being kept awake right now. */
  held: boolean
}

/** Where node jobs run on this computer (P4 N-D T5). */
export interface DesktopNodeRoot {
  path: string
  isDefault: boolean
}

/**
 * The folders this node shares (L21): the roots the owner chose, or the
 * desktop's recent folders when `isDefault`. Full paths, shown to the owner
 * only in a tooltip; the server only ever gets their names.
 */
export interface DesktopSharedRoots {
  roots: string[]
  isDefault: boolean
  /** The roots no longer on disk: listed so the owner can remove them, never offered to sessions. */
  missing: string[]
  /** The roots that confine nothing (the home folder or above it): marked, never offered. */
  refused?: string[]
  /** The roots the last change dropped for that reason (a note says which). */
  dropped?: string[]
  /** The roots that are git repositories, with their default branch when known. */
  repos?: Array<{ path: string; defaultBranch: string | null }>
}

/** One saved server, as the desktop shell keeps it. */
export interface DesktopSavedServer {
  address: string
  /** The organisation's own name, or null until the server has said it. */
  label: string | null
}

/**
 * THE SERVERS THIS COMPUTER KNOWS (`src-tauri/src/account.rs`), the same
 * shape the phone's shell publishes (`lib/native-bridge.ts` `NativeServers`)
 * so one servers UI serves both. The shell draws no Account menu on any OS:
 * the page's servers UI is the only switcher.
 *
 * Every change of server starts the page again on the new one. `add` rejects
 * with the shell's refusal (`DesktopConnectRefusal`, or `InvalidAddress`).
 */
export interface DesktopServers {
  list(): Promise<{ current: string | null; servers: DesktopSavedServer[] }>
  add(url: string): Promise<void>
  switchTo(address: string): Promise<void>
  /**
   * ASKS the shell to remove a server: the shell confirms in its own native
   * dialog, which a page script cannot answer, and removes it on a yes. It
   * resolves once the question is asked, not once the server is gone.
   */
  remove(address: string): Promise<void>
  signOut(): Promise<void>
  /** True: the shell asks its own removal question, so the page asks none. */
  confirmsRemoval?: boolean
  /** Opens the page's connect step, where a new address is typed and checked. */
  beginAdd?(): void
}

/**
 * THE ONE WAY apps/web REACHES THE SHELL.
 *
 * Shaped around exactly the Tauri commands that already exist
 * (`src-tauri/src/main.rs`): every method here is one of them, or a small
 * composition of them the shell already performs.
 */
/** A first-party app UI the shell verified (`verifyFirstPartyApp`). */
export interface VerifiedFirstPartyApp {
  /** Where the shell serves the verified bytes: `liaison-app://localhost/<sha256>.js`. */
  url: string
  sha256: string
  /** The manifest the statement vouches for. */
  manifest: Record<string, unknown>
}

export interface DesktopBridge {
  version: typeof DESKTOP_BRIDGE_VERSION
  platform: "macos" | "windows" | "linux"

  /**
   * The local model ids this shell can start a session on, the ones
   * `startSession` accepts as `model`: the SDK's own list once a session has
   * said it, the fallback before that. Their labels are on the state
   * (`localModels`). Optional, like every member added after the first shell:
   * a shell without it runs one fixed model and the picker offers it as the
   * single "Your Claude Code login" entry it always had. Kept as bare ids so a
   * page older than discovery still reads it.
   */
  localModels?: readonly string[]

  /**
   * Opens the OS folder picker. Null when the user closed it.
   *
   * Answers the HANDLE for what the user chose, not its path: the path of the
   * folder now in the state is on the state, and a handle is what
   * `startSession` takes (P6d-FX2, SK-1).
   *
   * THE AGENT IS NAMED BY THE CALLER (P6d-FX3, W3). The shell files a pick in
   * that agent's recent list, and while no session is running the shell knows
   * no agent: a pick made from an idle menu was therefore filed under nobody
   * and the list could never fill. The control that opened the picker knows
   * which agent it belongs to, so it says.
   */
  pickFolder(agentId?: string, threadId?: string): Promise<string | null>

  /**
   * THE FOLDER THIS CONVERSATION LAST RAN IN, PUT BACK ON THE STATE.
   *
   * A pick lived only in the window's memory, so a relaunch forgot it and the
   * next send opened the picker again for a conversation that had one. The
   * shell remembers the folder per conversation, and gives it back only when
   * it is still one of this agent's own recent folders (the list the shell
   * keeps, which is the set a session may start in anyway). Answers the handle,
   * or null when there is nothing to restore. Optional: an older shell has no
   * such memory.
   */
  restoreThreadFolder?(threadId: string, agentId: string): Promise<string | null>

  /**
   * Puts the folders this agent has run in onto the state (P6d-FX3, W3).
   *
   * The list is the SHELL's, in an owner-only file that outlives the window,
   * and nothing read it back: `recentFolders` was filled by a pick and by a
   * start and by nothing else, so a freshly opened window offered an empty
   * list however many folders the agent had run in. The control asks when it
   * opens.
   */
  loadRecentFolders(agentId: string): Promise<void>

  /** The Liaison this install is bound to, as the shell last answered. */
  getServerAddress(): string | null

  /**
   * The saved servers, for the page's own servers UI (Settings and the
   * sidebar's Servers switcher). Optional, like every late member: an older
   * shell has none.
   */
  servers?: DesktopServers
  /**
   * Moves this install to a server: the first launch's address, the connect
   * card, a confirmed connect link and the servers UI's "Add a server" all
   * end here.
   *
   * A REQUEST, never a setter. The shell refuses an address that cannot carry
   * a token, and one that does not answer as a Liaison, with the reason as a
   * code (`DesktopConnectRefusal`) the page turns into words. On success the
   * server joins the shell's saved list, the local session (if any) is stopped
   * and the page starts again on the new server; nothing of the server being
   * left (its tokens, its folders, the page's own storage) reaches the new one.
   */
  setServerAddress(url: string): Promise<void>

  /**
   * Closes the connect step "Add a server..." or a connect link opened, with
   * nothing changed. Optional, like every member added after the first shell.
   */
  dismissConnect?(): void

  /** Starts a local session for one conversation. False when it did not start. */
  startSession(input: DesktopStartSessionInput): Promise<boolean>
  stopSession(): Promise<void>
  /**
   * Runs one turn on this machine, naming the MESSAGE it answers.
   *
   * Never the text: this object lives on the window, so anything that can run
   * a script in this page could otherwise run an arbitrary prompt on the
   * user's own Claude Code login. The shell re-reads the message by id from
   * the server, in the conversation the session claimed, and refuses one that
   * is not a human's (P6d-FX1, the guard FX11 landed on the event path).
   */
  sendTurn(messageId: string): Promise<void>
  interruptTurn(): Promise<void>

  /** Answers one outstanding prompt. Not answering is a denial, not a hang. */
  respondToPermission(requestId: string, decision: DesktopPermissionDecision): Promise<void>

  /** Reads a file the session produced, so the composer can attach it. */
  readLocalFile(path: string): Promise<Blob | null>

  /**
   * OPENS A FILE OR FOLDER AN AGENT'S MESSAGE NAMED, as double clicking it
   * would. The page finds the path in the text; the SHELL decides what a click
   * may do with it. A folder opens in the file manager and a document in its
   * default application, but anything executable or script like is only
   * revealed in its folder, never run: the path comes from the agent's text,
   * so that rule is the shell's security boundary, not the page's.
   *
   * The path is sent as the message wrote it (absolute, `~/...` or `file://`),
   * or already joined to the session folder for a relative one. Optional, like
   * every late method: a shell without it renders paths as plain text.
   */
  openLocalPath?(path: string): Promise<DesktopLocalPathOutcome>

  /**
   * OPENS A FILE THE PAGE FETCHED (a shipping label, an invoice PDF) in the
   * system's default application. In a browser such bytes go to a new tab as a
   * `blob:` URL; this webview opens no tab and the shell refuses `blob:` as an
   * external link, so the bytes and a file name go to the shell instead, which
   * writes them to a new temporary folder and opens them. The SHELL sanitizes
   * the name and opens only document types. False when it refused or could not
   * open the file. Optional, like every late method.
   */
  openDownloadedFile?(bytes: Uint8Array, name: string): Promise<boolean>

  /**
   * VERIFIES A FIRST-PARTY APP'S UI BEFORE IT RUNS IN THIS PAGE (S13). The
   * SHELL fetches `ui.js`, `statement.json`, `statement.sig` and
   * `manifest.json` of `name@version` from the bound server itself, checks the
   * signed statement against the keys compiled into the shell, the revocation
   * floor and list, the hashes and the single-file rule, and keeps the bytes it
   * checked. It answers where it serves exactly those bytes (a `liaison-app:`
   * URL, by sha256) and the manifest they were signed with; the page imports
   * that URL and registers the app from that manifest (A9). Null is a refusal
   * (unsigned, unpinned key, tampered, revoked, unreachable): the app then runs
   * in the sandbox frame. Optional, like every late method: an older shell has
   * no verifier, and frames every server UI.
   */
  verifyFirstPartyApp?(name: string, version: string): Promise<VerifiedFirstPartyApp | null>

  /**
   * Asks the SHELL to change the mode, for the running session and the next.
   *
   * It is a request and not a setter: Bypass silences every permission prompt
   * the user is relying on, so the shell asks its own native confirmation
   * (which a page script cannot answer for the user) and remembers nothing
   * until it is accepted. False means refused, and the mode is unchanged.
   */
  setPermissionMode(mode: DesktopPermissionMode): Promise<boolean>
  /** Says where this conversation's turns run. UI state, nothing privileged. */
  setRuntimeLocation(location: DesktopRuntimeLocation): void

  /**
   * GIVES UP ON THE DEVICE CODE THE SHELL IS WAITING ON (P6d-FX5, W5).
   *
   * The shell drops the code itself once the grant is answered or has expired.
   * This is the third way it ends: the user closes the step. It takes the code
   * off the state and puts the runtime control back to idle, and it releases
   * NOTHING: no claim was taken, and the grant the shell is polling is the
   * shell's own business to finish or time out.
   */
  clearDeviceApproval(): void

  /**
   * OPENS A SIGN-IN PAGE IN THE USER'S OWN BROWSER (RFC 8252).
   *
   * An identity provider's page must never run inside this window: Google
   * refuses embedded user agents, and its passkey sign-in cannot reach the
   * platform passkey store from here, so a user with a passkey or 2FA could
   * not sign in at all. The shell opens the URL with the system browser, and
   * only a URL that is this install's own server's authorize route asking for
   * the desktop flow. False when the shell refused or could not open it.
   *
   * Optional, like every method added after the first shell: a shell without
   * it is a window that signs in the way it always did.
   */
  openAuthInBrowser?(url: string): Promise<boolean>

  /**
   * OPENS THE DEVICE APPROVAL PAGE IN THE USER'S OWN BROWSER.
   *
   * The approval is a page of this install's own server, where the user is
   * signed in; a `target=_blank` link does nothing inside the desktop webview.
   * The shell opens only its bound server's `/auth/device?code=` page. False
   * when it refused or could not open it. Optional, like every late method.
   */
  openDeviceApproval?(url: string): Promise<boolean>

  /**
   * OPENS A CLICKED EXTERNAL LINK IN THE USER'S OWN BROWSER (or mail client).
   *
   * A `target=_blank` link and `window.open` do nothing inside the desktop
   * webview. The shell opens only `http`, `https` and `mailto` URLs with no
   * credentials in them. False when it refused or could not open it.
   * Optional, like every late method.
   */
  openExternalUrl?(url: string): Promise<boolean>

  /**
   * Calls back with every `liaison://oauth-complete?...` link the operating
   * system hands the app: the end of a system-browser sign-in, or of an app
   * connection started from this window (settings/oauth-connect.ts). The link is
   * passed as it arrived, already checked for shape by the shell; matching its
   * `state` and redeeming its code is the page's job. A link that arrives with
   * nobody subscribed is held for the first subscriber. The return value stops
   * the subscription.
   */
  onOAuthComplete?(listener: (link: string) => void): () => void

  /**
   * THE CLAUDE ACCOUNT LOCAL TURNS RUN ON, asked of the CLI now and put on the
   * state (`claudeAccount`). Null when the shell could not tell. Optional,
   * like every late method: an older shell has no in-app Claude sign-in.
   */
  checkClaudeAccount?(): Promise<DesktopClaudeAccount | null>

  /**
   * STARTS A SIGN-IN TO CLAUDE: the shell opens Claude's page in the browser
   * and follows it on `claudeSignIn`, which it clears when the sign-in
   * succeeded (with `claudeAccount` updated) or was cancelled. False when it
   * could not start.
   */
  startClaudeSignIn?(): Promise<boolean>

  /** Hands the running sign-in the code Claude's page shows. False when refused. */
  submitClaudeSignInCode?(code: string): Promise<boolean>

  /** Gives up on the running sign-in. */
  cancelClaudeSignIn?(): Promise<void>

  /** Opens the running sign-in's page again, the one that shows a code. */
  reopenClaudeSignIn?(): Promise<boolean>

  /**
   * ASKS the shell to sign out of Claude. Signing out signs the whole computer
   * out, the person's own Claude Code included, so the shell asks its own
   * native question (which a page script cannot answer) and signs out only on
   * a yes; `claudeAccount` then says signed out. Resolves once the question is
   * asked. Settings offers it on every desktop OS, and it is the only way.
   * Optional, like every late method.
   */
  signOutOfClaude?(): Promise<void>

  /** Takes the sign-in notice down, with nothing done. */
  dismissClaudeSignInNeeded?(): void

  /**
   * RAISES A NATIVE OS NOTIFICATION (S7), through the shell, so it shows
   * with the window hidden or minimised. True when the shell handed it to the
   * OS. On a bundled macOS app the shell raises it with its `route` and
   * reports the click (`onNotificationClick`), and `tag` replaces an earlier
   * notification with the same tag; elsewhere a click only activates the app.
   * Optional: an older shell has none, and the page falls back to the
   * browser API.
   */
  raiseNotification?(notification: DesktopNotification): Promise<boolean>

  /**
   * THE APP ICON'S BADGE: the number of unread direct messages and mentions
   * (dock tile on macOS, launcher entry on Linux, a taskbar overlay on
   * Windows). Zero clears it. Optional: an older shell has none.
   */
  setUnreadBadge?(count: number): Promise<void>

  /**
   * The OS permission, as the SYSTEM answers it (P1-T6): the shell asks the
   * notification center itself, because the plugin answers "granted" on a
   * desktop whatever the system says. "default" is not decided yet.
   */
  notificationPermission?(): Promise<DesktopNotificationPermission>

  /** Asks the OS for the permission, from a click. */
  requestNotificationPermission?(): Promise<DesktopNotificationPermission>

  /**
   * Calls back when the system setting changes (the user flipping Liaison
   * off in the system's notification settings). Returns the unsubscribe.
   */
  onNotificationPermissionChange?(
    listener: (permission: DesktopNotificationPermission) => void,
  ): () => void

  /**
   * Whether a click on a notification this shell raised is reported through
   * `onNotificationClick` (LIF-18): true on a bundled macOS app, false where
   * the system's notification reports no click (the page then offers the
   * item itself).
   */
  notificationClickSupport?(): Promise<boolean>

  /**
   * Calls back with the `route` of a clicked notification, once per click,
   * after the shell brought its window forward; a click that launched the
   * app is delivered when this subscribes. Returns the unsubscribe.
   */
  onNotificationClick?(listener: (route: string) => void): () => void

  /**
   * THIS INSTALL'S NOTIFICATION DEVICE ID (`d.<hex>`), stable for the
   * install and published by the shell before the page loads, so the first
   * WS hello can carry it. Never kept in the page's storage, which a sign out
   * clears. Null from a shell that published none.
   */
  notificationDeviceId?(): string | null

  /**
   * The device's receipt-only credential, kept BY THE SHELL per server (the
   * named server must be the current one). An empty string removes it.
   */
  storeNotificationCredential?(server: string, credential: string): Promise<void>
  loadNotificationCredential?(server: string): Promise<string | null>

  /** Launch at login: what the OS login item says, and the switch. */
  launchAtLogin?(): Promise<boolean>
  setLaunchAtLogin?(enabled: boolean): Promise<boolean>

  /**
   * RUN THE SHELL'S UPDATE CHECK NOW (src-tauri/src/updater.rs), rather than
   * at its next six hourly turn. The page asks when an app runs in
   * compatibility mode because the server moved past the web build this app
   * carries (framework/compat-mode.ts). `manual: false` is the quiet check (nothing said
   * when there is nothing to install, a declined version not offered again);
   * `manual: true` is the menu's "Check for Updates", for a click. Either way
   * nothing installs without the user's yes. Optional: an older shell has no
   * such command, and the page then only says the app is out of date.
   */
  checkForUpdates?(options: { manual: boolean }): Promise<void>

  /**
   * THIS APP'S OWN VERSION (Tauri's app version, e.g. "0.1.35"), which the
   * page compares with the oldest version the server supports
   * (lib/client-version.ts). Optional: an older shell does not say it, and
   * the page then neither names itself nor shows the notice.
   */
  appVersion?(): Promise<string>

  /**
   * THE NODE CREDENTIAL (P4 N-D T4), kept BY THE SHELL per server (the named
   * server must be the current one; a refusal rejects). Null removes it.
   * Storing answers nothing: the shell re-evaluates keep awake on its own.
   */
  storeNodeCredential?(server: string, node: DesktopNodeRecord | null): Promise<void>
  loadNodeCredential?(server: string): Promise<DesktopNodeRecord | null>

  /** Keep awake while on power: the status, and the switch. */
  keepAwake?(): Promise<DesktopKeepAwake>
  setKeepAwake?(enabled: boolean): Promise<DesktopKeepAwake>

  /**
   * REMOTE AUTO: whether a node chat started from the web or a phone may run
   * in Auto or Edit on this computer. Off, such a chat runs in Manual. Kept by
   * the shell; turning it on is the shell's own native question, so a page can
   * ask for it but not answer it. Both answer the switch's state afterwards.
   */
  remoteAuto?(): Promise<boolean>
  setRemoteAuto?(enabled: boolean): Promise<boolean>

  /**
   * THIS COMPUTER RUNS ITS NODE JOBS (P4 N-D T5): called once the window
   * knows this computer is an enabled node. Asks "N jobs queued on this node,
   * launch?" once per launch for backlog jobs; `onReview` shows the queue.
   */
  startNodeJobs?(options: { onReview: () => void }): void

  /**
   * A `node_job_offer` frame reached this window: the shell claims and runs
   * it. The frame names the job's agent (P1-T40).
   */
  nodeJobOffered?(jobId: string, agentId?: string): void

  /**
   * P3 (C5): a `node_session_command` frame reached this window: one of this
   * node's sessions has a steering command waiting. The shell pulls the
   * node's commands and writes each to its live session.
   */
  nodeSessionCommand?(sessionId: string): void

  /**
   * P3 (D36): the window's socket connected again after a drop. The shell
   * reports its live session runs to the server (alive), then pulls commands.
   * Not called on the first connect: the runner reports when it starts.
   */
  nodeReconnected?(): void

  /**
   * P3-T22 (S7): the owner asked for a cut tool output's full text; the shell
   * reads it from this computer and sends it to the server (or says it is gone).
   */
  nodeFullOutputRequested?(sessionId: string, toolUseId: string): void
  /** A `node_folder_request` frame: the owner asked about this node's folders (any client). */
  nodeFolderRequest?(requestId: string): void
  /** S40: a `node_import_request` frame: the owner asked for this node's importable sessions. */
  nodeImportRequest?(requestId: string): void

  /**
   * The folder jobs run in, and the switch (null: back to `~/Liaison Node`).
   * A change is refused ("JobRunning") while a job runs, and an unsafe
   * folder is refused ("NodeRootRefused").
   */
  nodeRoot?(): Promise<DesktopNodeRoot>
  setNodeRoot?(path: string | null): Promise<DesktopNodeRoot>

  /**
   * The roots this node shares, and the switch (null: back to the recent
   * folders). A root that is not an existing folder below the home folder is
   * refused ("SharedRootRefused") and nothing changes. After a change the
   * shell publishes the node's capabilities again. A desktop before 0.1.21
   * lacks both, and the page hides the section.
   */
  sharedRoots?(): Promise<DesktopSharedRoots>
  setSharedRoots?(roots: string[] | null): Promise<DesktopSharedRoots>

  /**
   * "OPEN IN VS CODE" (S52, owner D13): opens one of this node's shared
   * folders in VS Code. The page names the folder as a session row carries it
   * (`folderName`); the SHELL finds its absolute path in its own shared-folder
   * map, so no absolute path comes from the page or the server. A session in
   * a subfolder adds `relativePath` (below that folder, `/`-separated); the
   * shell opens it only when it resolves inside the folder. True when it
   * opened; false for a name this node does not share, or shares twice, or a
   * relative path that leaves it. A desktop before it lacks it, and the page
   * hides the button; one before 0.1.29 ignores `relativePath` (the folder).
   */
  openFolderInEditor?(folderName: string, relativePath?: string): Promise<boolean>

  /**
   * "STOP IT" (D33): stops an orphaned Claude process (parent launchd) that
   * holds one of the owner's sessions, on the owner's click: SIGTERM, then
   * SIGKILL after 5 s. The page passes the CLI's session id and the pid the
   * node named; the SHELL signals it only when the CLI's registry entry and
   * the process table both tie that pid to that session id and it is a
   * `claude` binary. True once it is gone; false when refused or not stopped.
   * A desktop before it lacks it, and the page offers no button.
   */
  stopOrphanClaude?(cliSessionId: string, pid: number): Promise<boolean>

  /**
   * The native folder picker, answering with the chosen folder's path (node
   * settings only; `pickFolder` answers with a handle for a local session).
   */
  pickDirectory?(): Promise<string | null>

  /**
   * Opens the OS page where the person lets Liaison read protected folders
   * (macOS Privacy & Security > Files and Folders, Windows Security). False on
   * an OS that has none.
   */
  openPrivacySettings?(): Promise<boolean>

  /** The current snapshot. Cheap: the shell holds it, this copies it out. */
  getState(): DesktopSessionState

  /** Calls back on every change. The return value stops the subscription. */
  subscribe(listener: (state: DesktopSessionState) => void): () => void
}

/** A state with nothing in it, for a surface that has to render before a snapshot. */
export function emptyDesktopSessionState(): DesktopSessionState {
  return {
    runtimeLocation: "liaison",
    folderPath: null,
    permissionMode: DEFAULT_DESKTOP_PERMISSION_MODE,
    sessionStatus: "idle",
    threadId: null,
    agentId: null,
    recentFolders: [],
    toolActivity: [],
    pendingPermissions: [],
    pendingApprovalRequestId: null,
    approvalStatus: null,
    reconnectReason: null,
    startError: null,
    startErrorDetail: null,
    startClaimHolder: null,
    turnFailure: null,
    freshSession: null,
    claudeAccount: null,
    claudeSignIn: null,
    claudeSignInNeeded: null,
    deviceApproval: null,
    updateProgress: null,
    deepLinkAddress: null,
    addingServer: false,
    producedFiles: [],
    model: null,
    turnActive: false,
  }
}

/**
 * The bridge this window is wrapped by, or null.
 *
 * Null means a browser, and a browser renders no desktop UI at all. Null is
 * ALSO the answer for a shell whose bridge is a version this app does not
 * understand: a newer shell around an older page, or the reverse, is a
 * mismatch the page refuses rather than a set of methods it guesses at.
 *
 * `target` is a seam for the tests, which hand it a plain object rather than
 * writing onto the real window.
 */
export function getDesktopBridge(
  target: unknown = typeof globalThis === "undefined" ? null : globalThis,
): DesktopBridge | null {
  if (target === null || typeof target !== "object") return null
  const candidate = (target as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  if (candidate === null || typeof candidate !== "object") return null
  if ((candidate as { version?: unknown }).version !== DESKTOP_BRIDGE_VERSION) return null
  return candidate as unknown as DesktopBridge
}
