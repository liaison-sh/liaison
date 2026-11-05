// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T05: THE ONE PLACE apps/web READS THE DESKTOP FROM.
//
// Every desktop surface this slice adds asks the same two questions: is there
// a shell at all, and what is it doing right now. If each of them answered by
// reaching for the window itself there would be as many bridge resolutions as
// there are components, each with its own subscription and its own teardown,
// and a browser would pay for all of them. So the bridge is resolved once,
// here, and the surfaces read a signal.
//
// The actions are thin on purpose: nothing in this module decides anything.
// It calls the shell and lets the shell push the new state back, because the
// shell is the half that knows whether the folder was really picked, whether
// the sidecar really started and whether the claim was really taken. A store
// that guessed at those would be a second source of truth for a session it
// does not run.
//
// WITH NO BRIDGE every action is a no op that answers false and the state is
// the empty one, so a browser renders exactly what it rendered before this
// slice. That is not a convenience: it is the contract the browser baseline
// snapshot pins.
//
// Module shape follows modules/shell/panel-store.ts: module scope
// signals, one exported reset, registered with onSessionTeardown.

import { currentNodeModels, exactOfferedModel } from "@liaison/shared"
import { createSignal } from "solid-js"
import {
  DESKTOP_BRIDGE_EVENT,
  DESKTOP_FALLBACK_LOCAL_MODELS,
  DESKTOP_LEGACY_LOCAL_MODELS,
  type DesktopBridge,
  type DesktopFreshSession,
  type DesktopLocalModel,
  type DesktopLocalPathOutcome,
  type DesktopPermissionDecision,
  type DesktopPermissionMode,
  type DesktopRuntimeLocation,
  type DesktopServers,
  type DesktopSessionState,
  type DesktopTurnFailure,
  defaultLocalModel,
  desktopLocalModelLabel,
  emptyDesktopSessionState,
  getDesktopBridge,
  isLocalModelId,
  isOfferedLocalModel,
  offeredLocalModelFor,
  parseLocalModels,
} from "~/lib/desktop-shell-contract"
import { onSessionTeardown, runBeforeSignOut } from "~/lib/session-lifecycle"

let bridge: DesktopBridge | null = null
let unsubscribe: (() => void) | null = null

const [stateSignal, setState] = createSignal<DesktopSessionState>(emptyDesktopSessionState())
const [attachedSignal, setAttached] = createSignal(false)

/**
 * Resolves the bridge and starts following it. Called once at module load,
 * and again by the reset, which is also the seam the tests use to install a
 * fake bridge after this module is already in memory.
 */
export function attachDesktopBridge(): void {
  unsubscribe?.()
  unsubscribe = null
  bridge = getDesktopBridge()
  if (!bridge) {
    setAttached(false)
    setState(emptyDesktopSessionState())
    return
  }
  setAttached(true)
  setState(bridge.getState())
  unsubscribe = bridge.subscribe((next) => setState(next))
}

/** Test and sign-out seam: drops the subscription and resolves again. */
export function resetDesktopStore(): void {
  setLocalModelChoices({})
  lastRequested = null
  attachDesktopBridge()
}
onSessionTeardown(resetDesktopStore)

attachDesktopBridge()

/**
 * AND AGAIN WHEN THE SHELL SAYS SO (P6d-FX3, W1).
 *
 * The read above is the fast path and in the product it is the only one that
 * fires: the shell publishes the bridge from an initialization script, before
 * this module exists. It used to be the ONLY path, and that made a resolution
 * order a correctness requirement: a shell that published even one tick late
 * left `isDesktop()` false for the life of the window, because the single
 * re-attach was the sign-out teardown above. Every desktop surface was
 * therefore invisible until the user signed out and back in.
 *
 * Listening costs nothing in a browser, where the event is never fired.
 */
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener(DESKTOP_BRIDGE_EVENT, () => attachDesktopBridge())
}

/** Whether this window is wrapped by a desktop shell. False in a browser. */
export function isDesktop(): boolean {
  return attachedSignal()
}

/** What the shell is doing right now. The empty state in a browser. */
export const desktopState = stateSignal

/**
 * Whether the LIVE local session is the one for this conversation.
 *
 * Every surface below asks exactly this: the composer row, the activity rows
 * and the permission card all belong to one conversation, and a session
 * running for a different thread is none of their business. The agent alone
 * does not answer it, because the same agent is reachable from several
 * conversations (A32).
 */
export function localSessionFor(threadId: string | null, agentId: string | null): boolean {
  const state = stateSignal()
  if (state.sessionStatus !== "running" && state.sessionStatus !== "starting") return false
  if (!threadId || !agentId) return false
  return state.threadId === threadId && state.agentId === agentId
}

/**
 * WHICH OS THIS WINDOW IS RUNNING ON, as the SHELL says (P6d-T15).
 *
 * Never `navigator.userAgent`: the webview's user agent describes the engine,
 * and a packaged build can be handed a string that says nothing about the
 * host. Null in a browser.
 */
export function platform(): DesktopBridge["platform"] | null {
  return attachedSignal() && bridge ? bridge.platform : null
}

/** The Liaison this install is bound to, as the shell last answered. */
export function serverAddress(): string | null {
  return attachedSignal() && bridge ? bridge.getServerAddress() : null
}

/**
 * THE DESKTOP'S SAVED SERVERS, when the shell published them, for the servers
 * group in Settings and the sidebar's account menu. Null in a browser and
 * under an older shell, and null when any member is not really a function.
 */
export function desktopServers(): DesktopServers | null {
  if (!attachedSignal() || !bridge) return null
  const servers = bridge.servers
  if (typeof servers !== "object" || servers === null) return null
  for (const name of ["list", "add", "switchTo", "remove", "signOut"] as const) {
    if (typeof servers[name] !== "function") return null
  }
  // The shell signs out by itself, as the phone's does (lib/native-bridge.ts):
  // the page's before-sign-out work runs first, while the session still
  // authenticates it.
  const signOut = async (): Promise<void> => {
    await runBeforeSignOut()
    await servers.signOut()
  }
  return Object.assign(Object.create(servers) as DesktopServers, { signOut })
}

/**
 * Binds this install to a server. REJECTS the way the shell rejects: a scheme
 * it refuses throws, and the caller decides what to say about it.
 */
export async function setServerAddress(url: string): Promise<void> {
  if (!bridge) return
  await bridge.setServerAddress(url)
}

/**
 * Closes the connect step "Add a server..." or a connect link opened,
 * with nothing applied. A shell without the method has no such step to close.
 */
export function dismissConnect(): void {
  if (!bridge || typeof bridge.dismissConnect !== "function") return
  bridge.dismissConnect()
}

/**
 * Opens the shell's folder picker. False when there is no shell, or no pick.
 *
 * The agent is named because the shell files the pick in that agent's recent
 * list and, with nothing running, the shell knows no agent (P6d-FX3, W3).
 */
export async function chooseFolder(agentId?: string, threadId?: string): Promise<boolean> {
  return (await chooseFolderHandle(agentId, threadId)) !== null
}

/**
 * The same pick, answering the HANDLE. The conversation is named so the shell
 * remembers the folder for it across a relaunch.
 */
async function chooseFolderHandle(agentId?: string, threadId?: string): Promise<string | null> {
  if (!bridge) return null
  const picked =
    threadId === undefined
      ? await bridge.pickFolder(agentId)
      : await bridge.pickFolder(agentId, threadId)
  return typeof picked === "string" && picked.length > 0 ? picked : null
}

/**
 * Puts back the folder this conversation last ran in (it survives a relaunch),
 * and answers its handle, or null when there is none to restore or the shell
 * predates the memory.
 */
export async function restoreThreadFolder(
  threadId: string,
  agentId: string,
): Promise<string | null> {
  if (!bridge || typeof bridge.restoreThreadFolder !== "function") return null
  try {
    return (await bridge.restoreThreadFolder(threadId, agentId)) ?? null
  } catch {
    return null
  }
}

/**
 * Opens the device approval page in the user's own browser. False when there
 * is no shell able to, and the caller falls back to a plain link.
 */
export async function openDeviceApprovalPage(url: string): Promise<boolean> {
  if (!bridge || typeof bridge.openDeviceApproval !== "function") return false
  try {
    return (await bridge.openDeviceApproval(url)) === true
  } catch {
    return false
  }
}

/** Whether this shell can open the approval page itself. */
export function canOpenDeviceApproval(): boolean {
  return bridge !== null && typeof bridge.openDeviceApproval === "function"
}

/**
 * Opens an external link in the user's own browser through the shell. False
 * when there is no shell able to, or it refused the URL.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!bridge || typeof bridge.openExternalUrl !== "function") return false
  try {
    return (await bridge.openExternalUrl(url)) === true
  } catch {
    return false
  }
}

/** Whether this shell can open external links itself. */
export function canOpenExternalUrl(): boolean {
  return bridge !== null && typeof bridge.openExternalUrl === "function"
}

/**
 * Whether a local path in a message can be a link: a shell, and one that has
 * the opener. False in a browser, where a path stays the text it was.
 */
export function canOpenLocalPaths(): boolean {
  return attachedSignal() && bridge !== null && typeof bridge.openLocalPath === "function"
}

/**
 * The folder THIS conversation's local session runs in, which a relative path
 * in its messages resolves against, or null: no session for it, or no folder.
 */
export function localFolderFor(threadId: string | null | undefined): string | null {
  const state = stateSignal()
  if (!threadId || state.threadId !== threadId) return null
  return state.folderPath && state.folderPath.length > 0 ? state.folderPath : null
}

/**
 * Asks the SHELL to open a path a message named. The shell, not this page,
 * decides that a program is revealed rather than run.
 */
export async function openLocalPath(path: string): Promise<DesktopLocalPathOutcome> {
  if (!bridge || typeof bridge.openLocalPath !== "function") return "failed"
  try {
    return await bridge.openLocalPath(path)
  } catch {
    return "failed"
  }
}

/**
 * Whether this shell opens a fetched file itself (`openDownloadedFile`).
 * False in a browser, where the file goes to a `blob:` tab as it always did.
 */
export function canOpenDownloadedFile(): boolean {
  return bridge !== null && typeof bridge.openDownloadedFile === "function"
}

/**
 * Asks the SHELL to save a fetched file and open it in its default
 * application. False when there is no shell able to, or it refused.
 */
export async function openDownloadedFile(bytes: Uint8Array, name: string): Promise<boolean> {
  if (!bridge || typeof bridge.openDownloadedFile !== "function") return false
  try {
    return (await bridge.openDownloadedFile(bytes, name)) === true
  } catch {
    return false
  }
}

/**
 * Asks the shell for the folders this agent has run in (P6d-FX3, W3).
 *
 * The list lives in an owner-only file the shell keeps across launches and
 * nothing read it back, so a freshly opened window offered none of it. Guarded
 * on the method rather than the bridge: an older shell around this page
 * publishes a bridge without it, and an absent list is what that window had
 * anyway.
 */
export async function loadRecentFolders(agentId: string): Promise<void> {
  if (!bridge || typeof bridge.loadRecentFolders !== "function") return
  await bridge.loadRecentFolders(agentId)
}

/**
 * ASKS THE SHELL to change how this session asks before it acts.
 *
 * The shell owns both halves: the native confirmation for Bypass, which is
 * the one a page script cannot skip, and the control line that reaches the
 * running session. False is a refusal (a declined bypass, no shell at all),
 * and the caller renders the mode the state still reports rather than the one
 * it asked for.
 */
export async function setPermissionMode(mode: DesktopPermissionMode): Promise<boolean> {
  if (!bridge) return false
  return await bridge.setPermissionMode(mode)
}

/**
 * GIVES UP ON THE DEVICE CODE the shell is waiting on (P6d-FX5, W5).
 *
 * Guarded on the method rather than on the bridge, the way the recent folder
 * read is: an older shell around this page publishes a bridge without it, and
 * a window with no way to cancel is the window that existed before.
 */
export function clearDeviceApproval(): void {
  if (!bridge || typeof bridge.clearDeviceApproval !== "function") return
  bridge.clearDeviceApproval()
}

/**
 * WHETHER THIS SHELL SIGNS IN THROUGH THE SYSTEM BROWSER. Guarded on the
 * methods rather than the bridge, the way the device code cancel is: a shell
 * without them is a window that signs in the way it always did.
 */
export function canSignInWithSystemBrowser(): boolean {
  return (
    bridge !== null &&
    typeof bridge.openAuthInBrowser === "function" &&
    typeof bridge.onOAuthComplete === "function"
  )
}

/**
 * WHETHER THIS SHELL CONNECTS APPS THROUGH THE SYSTEM BROWSER: it opens the
 * provider's page there (as an external link) and hands back the
 * `liaison://oauth-complete` link that ends the flow (settings/oauth-connect.ts).
 */
export function canConnectWithSystemBrowser(): boolean {
  return (
    bridge !== null &&
    typeof bridge.openExternalUrl === "function" &&
    typeof bridge.onOAuthComplete === "function"
  )
}

/** Asks the shell to open a sign-in URL in the system browser. */
export async function openAuthInBrowser(url: string): Promise<boolean> {
  if (!bridge || typeof bridge.openAuthInBrowser !== "function") return false
  try {
    return (await bridge.openAuthInBrowser(url)) === true
  } catch {
    return false
  }
}

/** Follows the `liaison://oauth-complete` links the OS hands the app. */
export function onOAuthCompleteLink(listener: (link: string) => void): () => void {
  if (!bridge || typeof bridge.onOAuthComplete !== "function") return () => {}
  return bridge.onOAuthComplete(listener)
}

// ---------------------------------------------------------------------------
// THE CLAUDE ACCOUNT A LOCAL TURN RUNS ON (2026-09-24).
//
// Every method is optional on the bridge: a shell older than the in-app
// sign-in has none, and the page then offers nothing it cannot do.

/** Whether this shell can sign in to Claude from the app. */
export function canSignInToClaude(): boolean {
  return attachedSignal() && bridge !== null && typeof bridge.startClaudeSignIn === "function"
}

/**
 * The conversation's need for a Claude sign-in, when it is THIS one's: a turn
 * that failed for want of one, or a start refused for it.
 */
export function claudeSignInNeededFor(threadId: string | null | undefined) {
  const needed = stateSignal().claudeSignInNeeded ?? null
  if (!needed || !threadId || needed.threadId !== threadId) return null
  return needed
}

/** The Claude account on the state, or null until the shell has said. */
export function claudeAccount() {
  return stateSignal().claudeAccount ?? null
}

/** Whether this shell can ask its own "Sign out of Claude" question. */
export function canSignOutOfClaude(): boolean {
  return attachedSignal() && bridge !== null && typeof bridge.signOutOfClaude === "function"
}

/** Asks the shell to sign out of Claude, behind its own native question. */
export async function signOutOfClaude(): Promise<void> {
  if (!bridge || typeof bridge.signOutOfClaude !== "function") return
  await bridge.signOutOfClaude().catch(() => undefined)
}

/** Reads the Claude account from the CLI again and puts it on the state. */
export async function checkClaudeAccount(): Promise<void> {
  if (!bridge || typeof bridge.checkClaudeAccount !== "function") return
  await bridge.checkClaudeAccount().catch(() => null)
}

/** Opens the Claude sign-in. False when the shell could not start it. */
export async function startClaudeSignIn(): Promise<boolean> {
  if (!bridge || typeof bridge.startClaudeSignIn !== "function") return false
  try {
    return (await bridge.startClaudeSignIn()) === true
  } catch {
    return false
  }
}

/** Hands the running sign-in the code Claude's page shows. */
export async function submitClaudeSignInCode(code: string): Promise<boolean> {
  if (!bridge || typeof bridge.submitClaudeSignInCode !== "function") return false
  try {
    return (await bridge.submitClaudeSignInCode(code)) === true
  } catch {
    return false
  }
}

/** Gives up on the running sign-in. */
export async function cancelClaudeSignIn(): Promise<void> {
  if (!bridge || typeof bridge.cancelClaudeSignIn !== "function") return
  await bridge.cancelClaudeSignIn().catch(() => undefined)
}

/** Opens the sign-in page again, in the browser. */
export async function reopenClaudeSignIn(): Promise<boolean> {
  if (!bridge || typeof bridge.reopenClaudeSignIn !== "function") return false
  try {
    return (await bridge.reopenClaudeSignIn()) === true
  } catch {
    return false
  }
}

/** Takes the sign-in notice down, with nothing done. */
export function dismissClaudeSignInNeeded(): void {
  if (!bridge || typeof bridge.dismissClaudeSignInNeeded !== "function") return
  bridge.dismissClaudeSignInNeeded()
}

// ---------------------------------------------------------------------------
// WHICH CLAUDE MODEL A TURN ON THIS MACHINE RUNS ON, per conversation.
//
// It is NOT the conversation's Liaison model. That one lives on the server and
// is sent to Liaison's own runtime; this one is sent to the sidecar, and only
// ids the shell offers are ever written here or used from here. The two
// lists overlap (`claude-haiku-4-5` is both), so keeping them in two slots is
// what makes "a Liaison model never reaches the sidecar, and the reverse" a
// property of the storage rather than of every caller's care.
//
// Kept in `localStorage` beside the runtime mirror, so the choice survives the
// reloads the device grant and the connect card cause, exactly as the runtime
// choice does.

/** Where one conversation's local model is remembered. */
export const LOCAL_MODEL_STORAGE_PREFIX = "liaison:desktop:local-model:"

const [localModelChoices, setLocalModelChoices] = createSignal<Record<string, string>>({})

/**
 * The stored choice, kept even while it is not offered: the shell offers its
 * fallback until a session says what the SDK offers, and a choice made from
 * the SDK's list must still be there when that list comes back.
 */
function rememberedLocalModel(threadId: string): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(LOCAL_MODEL_STORAGE_PREFIX + threadId)
    return isLocalModelId(stored) ? stored : null
  } catch {
    return null
  }
}

/**
 * EVERY local model this shell can run, in the shell's order: whatever the
 * installed Agent SDK advertised, pinned older versions included, labelled as
 * the shell labels them, with nothing filtered out by a list of this page's
 * own (a model newer than the page is still there). A shell older than the
 * labelled list says bare ids, labelled from the fallback where it knows
 * them. Empty for a shell that predates the choice (it runs one fixed model)
 * and in a browser. What a conversation may keep running on, never what is
 * offered (`localModelOptions`).
 */
export function runnableLocalModels(): DesktopLocalModel[] {
  if (!attachedSignal() || !bridge || !Array.isArray(bridge.localModels)) return []
  const labelled = parseLocalModels(stateSignal().localModels)
  if (labelled) return labelled
  return bridge.localModels.filter(isLocalModelId).map((id) => ({
    id,
    label:
      desktopLocalModelLabel(id, DESKTOP_FALLBACK_LOCAL_MODELS) ??
      desktopLocalModelLabel(id, DESKTOP_LEGACY_LOCAL_MODELS) ??
      id,
  }))
}

/**
 * The local models OFFERED: each family's current model among those the
 * shell runs (`currentNodeModels`). The SDK lists every pinned older version
 * too (twelve models on SDK 0.3.296), and nobody should be offered one.
 */
export function localModelOptions(): DesktopLocalModel[] {
  return currentNodeModels(runnableLocalModels())
}

/**
 * The local model this conversation runs on: its own choice while the shell
 * runs it (an older version picked before stays on it, as the contract's
 * `isStartableLocalModel` accepts it), else what stands for it among what is
 * offered (its dated id, or the newest of its family: `offeredLocalModelFor`),
 * else the default among what is offered (`defaultLocalModel`).
 */
export function localModelFor(threadId: string | null | undefined): string {
  const offered = localModelOptions()
  const fallback = defaultLocalModel(offered)
  if (!threadId) return fallback
  const chosen = localModelChoices()[threadId] ?? rememberedLocalModel(threadId)
  if (!chosen) return fallback
  if (offered.length === 0) return chosen
  return (
    exactOfferedModel(chosen, runnableLocalModels()) ??
    offeredLocalModelFor(chosen, offered) ??
    fallback
  )
}

/**
 * Records the local model for one conversation. Refuses (false) anything the
 * shell does not offer, so a Liaison id can never be stored here.
 */
export function chooseLocalModel(threadId: string | null | undefined, modelId: string): boolean {
  if (!threadId || !isOfferedLocalModel(modelId, localModelOptions())) return false
  setLocalModelChoices((current) => ({ ...current, [threadId]: modelId }))
  try {
    globalThis.localStorage?.setItem(LOCAL_MODEL_STORAGE_PREFIX + threadId, modelId)
  } catch {
    // A refused store costs the next window's memory, never the pick.
  }
  return true
}

/** Says where this conversation's turns should run. */
export function setRuntimeLocation(location: DesktopRuntimeLocation): boolean {
  if (!bridge) return false
  bridge.setRuntimeLocation(location)
  return true
}

/**
 * Starts a local session for one conversation, in the folder already chosen.
 *
 * A FOLDER IS NAMED BY THE HANDLE THE SHELL ISSUED (P6d-FX2, SK-1), never by a
 * path: the folder a session starts in is the root `readLocalFile` is bounded
 * by, and a path from this side is a path from the page. Omitting it runs in
 * the folder already on the state.
 */
/**
 * THE LAST CONVERSATION A START WAS ASKED FOR. A start the shell refused (a
 * device grant that failed, say) leaves no conversation on the state, and the
 * Reconnect toast has to know what to reconnect.
 */
let lastRequested: { threadId: string; agentId: string } | null = null

export function lastStartRequest(): { threadId: string; agentId: string } | null {
  return lastRequested
}

export async function startLocalSession(
  threadId: string,
  agentId: string,
  folderId?: string,
  options: { takeOver?: boolean } = {},
): Promise<boolean> {
  if (!bridge) return false
  lastRequested = { threadId, agentId }
  // A shell that cannot choose a model is not handed one: it would ignore it at
  // best, and the page must not claim a model the session is not running on.
  const model = Array.isArray(bridge.localModels) ? localModelFor(threadId) : undefined
  return await bridge.startSession({
    threadId,
    agentId,
    ...(folderId !== undefined ? { folderId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(options.takeOver === true ? { takeOver: true } : {}),
  })
}

/**
 * Whether this window says turns run ON THIS MACHINE. False in a browser, and
 * false on a desktop whose runtime control says Liaison.
 */
export function isLocalRuntime(): boolean {
  return attachedSignal() && stateSignal().runtimeLocation === "local"
}

/**
 * Why a local send could not go ahead. `NoFolderChosen` is also what a picker
 * the user closed answers; every other value is the shell's own `startError`
 * (the notices already say it in words), or `StartFailed` when it named none.
 */
export type LocalSessionUnavailableReason = string

export type LocalSessionReadiness =
  | { ok: true }
  | { ok: false; reason: LocalSessionUnavailableReason }

/** Resolves once no start is in flight, whatever it ended in. */
function startSettled(): Promise<void> {
  if (stateSignal().sessionStatus !== "starting" || !bridge) return Promise.resolve()
  const shell = bridge
  return new Promise((resolve) => {
    const stop = shell.subscribe((next) => {
      if (next.sessionStatus === "starting") return
      stop()
      resolve()
    })
    // A snapshot pushed between the read above and the subscription is not
    // replayed, so look once more now that the listener is in place.
    if (shell.getState().sessionStatus !== "starting") {
      stop()
      resolve()
    }
  })
}

function runningFor(threadId: string, agentId: string): boolean {
  const state = stateSignal()
  return (
    state.sessionStatus === "running" && state.threadId === threadId && state.agentId === agentId
  )
}

/**
 * MAKES SURE A MESSAGE ABOUT TO BE SENT HAS A LOCAL SESSION TO ANSWER IT.
 *
 * Choosing "This machine" in the runtime control only records a preference:
 * the session, and with it the claim that stops the server from answering, is
 * taken by a START. Sending with no session running used to post the message
 * as if nothing had been chosen, the server held no claim, and its own agent
 * answered on its own model while the header still said "This machine". So
 * the send path asks for the session first and only posts once it runs.
 *
 * What is missing is asked for, in the order a start needs it: a folder
 * (the shell's own picker, when none is on the state), then the start itself,
 * which is where the device grant is shown and waited on. Anything that does
 * not end in a running session for THIS conversation answers `ok: false`, and
 * the caller must not post.
 */
export async function ensureLocalSessionFor(
  threadId: string,
  agentId: string,
): Promise<LocalSessionReadiness> {
  if (!bridge) return { ok: false, reason: "StartFailed" }
  // A start already in flight (the menu's own Start, or a send a moment ago)
  // is waited for rather than raced: a second start would be refused as
  // AlreadyStarting and the message dropped for nothing.
  await startSettled()
  // A session that lost its claim still reads "running", with the reason on
  // the state: the server may be answering again, so it is restarted (the
  // Reconnect toast's own action) rather than trusted.
  if (runningFor(threadId, agentId) && !stateSignal().reconnectReason) return { ok: true }
  // THE CONVERSATION'S OWN FOLDER FIRST, remembered across a relaunch; then
  // the one already on the state; only then the picker.
  let folderId: string | undefined = (await restoreThreadFolder(threadId, agentId)) ?? undefined
  if (folderId === undefined && !stateSignal().folderPath) {
    const picked = await chooseFolderHandle(agentId, threadId)
    if (!picked) return { ok: false, reason: "NoFolderChosen" }
    folderId = picked
  }
  const started = await startLocalSession(threadId, agentId, folderId)
  if (started && runningFor(threadId, agentId)) return { ok: true }
  return { ok: false, reason: stateSignal().startError ?? "StartFailed" }
}

/**
 * Stops the turn running on this machine, including one parked on a
 * permission question: the sidecar denies what is parked and interrupts the
 * SDK, so a stuck turn always has a way out from the window.
 */
export async function interruptLocalTurn(): Promise<boolean> {
  if (!bridge) return false
  await bridge.interruptTurn()
  return true
}

/**
 * THE LOCAL TURN OF THIS CONVERSATION THAT DIED WITH ITS SIDECAR, or null
 * (2026-09-23). The shell ended the session and released the claim; what is
 * left is to say so where the message is, and to offer the turn again.
 */
export function localTurnFailureFor(threadId: string | null): DesktopTurnFailure | null {
  const failure = stateSignal().turnFailure ?? null
  if (!failure || !threadId || failure.threadId !== threadId) return null
  return failure
}

/**
 * THE SESSION OF THIS CONVERSATION THAT STARTED NEW BECAUSE THE AGENT CHANGED,
 * or null (2026-09-23). The shell clears it when that session's first turn
 * ends, so the line it draws marks the boundary rather than every turn after.
 */
export function localFreshSessionFor(threadId: string | null): DesktopFreshSession | null {
  const fresh = stateSignal().freshSession ?? null
  if (!fresh || !threadId || fresh.threadId !== threadId) return null
  return fresh
}

/**
 * RETRY: a session for the conversation again, then the same message's turn.
 *
 * The message is already in the conversation (it was posted before the turn
 * ran), so nothing is posted: the shell re-reads it by id and runs it, exactly
 * as it did the first time. It goes to the bridge directly, past the record of
 * messages already asked for, because asking again is the whole point. False
 * when the session could not be had: the start's own refusal is already a toast.
 */
export async function retryLocalTurn(threadId: string): Promise<boolean> {
  if (!bridge) return false
  const failure = localTurnFailureFor(threadId)
  if (!failure) return false
  const ready = await ensureLocalSessionFor(failure.threadId, failure.agentId)
  if (!ready.ok) return false
  if (failure.messageId) await bridge.sendTurn(failure.messageId)
  return true
}

/**
 * Runs one turn on this machine, naming the message it answers. The shell
 * re-reads that message from the server before anything runs (P6d-FX1).
 */
export async function sendLocalTurn(messageId: string): Promise<boolean> {
  if (!bridge) return false
  await bridge.sendTurn(messageId)
  return true
}

// ---------------------------------------------------------------------------
// THE CONVERSATION IS THE INPUT (A32), and this is where it reaches the shell.
//
// Until P6d-T16b the message store announced every new message on the
// document and the overlay listened. There is no overlay to listen any more,
// and a document event anything in the page could dispatch was never the
// right shape for this: the shell is reached through the bridge now, by id.
//
// ONE TURN PER MESSAGE, whichever path learns about it first AND WHICHEVER
// WINDOW. A message reaches this window by two routes that race: the POST's
// own answer and the websocket frame. For a message the user typed here the
// POST usually wins, so a shell told only by the socket path never heard about
// the very messages the person in front of it was sending (driven walk, FX10).
// Both routes call this; the record below is what keeps it from running the
// turn twice.
//
// A module level Set is per window, and a second tab of the same app is a
// second window: two tabs open on one conversation ran the same message twice
// and paid for two turns. So the record is kept in `localStorage`, which every
// tab of this origin shares, with the in memory set as the fast path and as
// the fallback for a window that refuses storage. The shell's own check (it
// re-reads the message by id, in the conversation it claimed, before running
// anything) is what makes a duplicate that slips through harmless rather than
// expensive.

/** What the store knows about a message, which is all the shell is told. */
export interface LocalTurnMessage {
  threadId: string
  messageId: string
  /** `user`, `agent` or `system`, as the message row says. */
  authorKind: string
  /** The message as written, mention token included: the shell strips it. */
  text: string
}

const asked = new Set<string>()
const ASKED_CAP = 500
/** Where the tabs of this origin agree about what has been asked for. */
export const ASKED_STORAGE_KEY = "liaison:desktop:local-turn-messages"

/** The shared record, or null when this window has no usable storage. */
function sharedStore(): Storage | null {
  try {
    const store = globalThis.localStorage
    // Reading it is the test: a window that blocks site data throws HERE, not
    // at the first write, and a store that crashed on it would take the
    // message store with it.
    store?.getItem(ASKED_STORAGE_KEY)
    return store ?? null
  } catch {
    return null
  }
}

function readShared(store: Storage): string[] {
  try {
    const raw = store.getItem(ASKED_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function alreadyAsked(messageId: string): boolean {
  if (asked.has(messageId)) return true
  asked.add(messageId)
  if (asked.size > ASKED_CAP) asked.delete(asked.values().next().value as string)
  const store = sharedStore()
  if (!store) return false
  const ids = readShared(store)
  if (ids.includes(messageId)) return true
  ids.push(messageId)
  try {
    store.setItem(ASKED_STORAGE_KEY, JSON.stringify(ids.slice(-ASKED_CAP)))
  } catch {
    // A full or refused store costs a duplicate ask at worst.
  }
  return false
}

/**
 * Asks the shell to run one message as a local turn, or does nothing when it
 * is not the shell's business. Returns whether it asked, so a caller can be
 * tested without a shell.
 *
 * An AGENT authored message is never sent: the agent's own reply is the output
 * of a local turn, and feeding it back in is a loop with no exit.
 */
export function runMessageAsLocalTurn(message: LocalTurnMessage): boolean {
  if (!bridge) return false
  if (message.authorKind === "agent") return false
  if (!message.threadId || !message.messageId) return false
  if (typeof message.text !== "string" || message.text.length === 0) return false
  // The live session has to be THIS conversation's. A session running for
  // another thread is none of this message's business, and the shell would
  // refuse it anyway once it re-read the row.
  if (!localSessionFor(message.threadId, stateSignal().agentId)) return false
  if (alreadyAsked(message.messageId)) return false
  // THE MODEL CHANGED SINCE THE SESSION STARTED. The session runs on the model
  // it was started with, so a new pick is applied by restarting this same
  // conversation (the SDK resumes its own transcript) before the turn is sent.
  // Never under a running turn: that one finishes on the model it began on and
  // this message queues behind it.
  const state = stateSignal()
  const agentId = state.agentId
  const wanted = localModelFor(message.threadId)
  if (agentId && typeof state.model === "string" && state.model !== wanted && !state.turnActive) {
    void startLocalSession(message.threadId, agentId).then(() => sendLocalTurn(message.messageId))
    return true
  }
  void sendLocalTurn(message.messageId)
  return true
}

/**
 * Test seam: forgets what THIS window has asked for, leaving the record the
 * tabs share alone. It is what a freshly opened second tab starts with.
 */
export function forgetLocalTurnsInThisWindow(): void {
  asked.clear()
}

/** Test seam: forgets what has been asked, in this window and in the shared record. */
export function resetLocalTurnMessages(): void {
  asked.clear()
  try {
    globalThis.localStorage?.removeItem(ASKED_STORAGE_KEY)
  } catch {
    // Nothing to forget in a window that has no storage.
  }
}

/**
 * Reads a file the session produced, so the composer can attach it (P6d-T14).
 * Null with no bridge, and null when the shell refused: the command is scoped
 * to the session's own folder and this side does not argue with it.
 */
export async function readLocalFile(path: string): Promise<Blob | null> {
  if (!bridge) return null
  return await bridge.readLocalFile(path)
}

/** Answers the prompt the session is blocked on. */
export async function answerPermission(
  requestId: string,
  decision: DesktopPermissionDecision,
): Promise<boolean> {
  if (!bridge) return false
  await bridge.respondToPermission(requestId, decision)
  return true
}
