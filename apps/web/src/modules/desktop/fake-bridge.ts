// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE FAKE SHELL, for every test that needs one.
//
// Seven surfaces in this slice render only when a desktop shell is wrapping
// the page, so seven test files need a bridge to install. Seven hand written
// fakes would be seven places to forget a method the day the contract grows
// one, and the failure of a stale fake is a type error in a test file rather
// than anything a reader would connect to the contract. So there is one, here,
// typed as `DesktopBridge`: a method added to the contract breaks this file and
// nothing else.
//
// It writes the real window property rather than going through a test runner
// seam, because that is what the shell does and what `getDesktopBridge` reads.
// `uninstallFakeBridge` puts the window back the way a browser has it, which
// is the precondition the browser baseline asserts.

import {
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  type DesktopBridge,
  type DesktopClaimHolder,
  type DesktopLocalPathOutcome,
  type DesktopPermissionDecision,
  type DesktopPermissionMode,
  type DesktopRecentFolder,
  type DesktopRuntimeLocation,
  type DesktopServers,
  type DesktopSessionState,
  type DesktopStartSessionInput,
  emptyDesktopSessionState,
} from "~/lib/desktop-shell-contract"
import { attachDesktopBridge, resetDesktopStore } from "./desktop-store"

/** Everything the fake shell was asked to do, in the order it was asked. */
export interface FakeBridgeCalls {
  started: DesktopStartSessionInput[]
  stopped: number
  /** The message ids the page asked the shell to run, in order. */
  turns: string[]
  interrupted: number
  modes: DesktopPermissionMode[]
  locations: DesktopRuntimeLocation[]
  permissions: Array<{ requestId: string; decision: DesktopPermissionDecision }>
  pickedFolder: number
  /** The agent each pick named, so a pick filed under nobody is visible. */
  pickedFolderAgents: Array<string | undefined>
  /** The agents the control asked the shell for a recent list for. */
  recentFolderReads: string[]
  /** How many times the page gave up on the device code (P6d-FX5, W5). */
  clearedDeviceApprovals: number
  /** How many times the page closed the connect step with nothing applied. */
  dismissedConnects: number
  serverAddresses: string[]
  readFiles: string[]
  /** The URLs the page asked the shell to open in the system browser. */
  openedAuthUrls: string[]
  /** The conversation each pick was made for, in order. */
  pickedFolderThreads: Array<string | undefined>
  /** Every `restoreThreadFolder` asked, as `threadId:agentId`. */
  restoredThreadFolders: string[]
  /** Every approval page the page asked the shell to open. */
  openedApprovalUrls: string[]
  /** Every external link the page asked the shell to open. */
  openedExternalUrls: string[]
  /** Claude sign-ins the page started, codes it handed over, and the rest. */
  claudeSignIns: number
  /** How many times the page asked the shell's Claude sign out question. */
  claudeSignOuts: number
  claudeCodes: string[]
  claudeCancels: number
  claudeReopens: number
  claudeNeededDismissals: number
  /** Every local path the page asked the shell to open, as sent. */
  openedLocalPaths: string[]
  /** Every fetched file the page handed the shell to open, as sent. */
  openedDownloadedFiles: Array<{ name: string; bytes: Uint8Array }>
}

export interface FakeBridgeOptions {
  platform?: DesktopBridge["platform"]
  /** What the OS folder picker answers. Null is the user closing it. */
  pickFolderResult?: string | null
  /** What `readLocalFile` hands back for any path. */
  readLocalFileResult?: Blob | null
  /** The address the shell says this install is bound to. */
  serverAddress?: string | null
  /** Rejects `setServerAddress`, the way the shell rejects a bad scheme. */
  rejectServerAddress?: string
  /**
   * The shell REFUSES a mode change, the way a declined native bypass
   * confirmation refuses it: nothing is remembered and nothing is applied.
   */
  refusePermissionMode?: boolean
  /**
   * What the SHELL has on file for an agent, keyed by agent id. It is the
   * list a fresh window knows nothing about until it asks (P6d-FX3, W3).
   */
  storedRecentFolders?: Record<string, DesktopRecentFolder[]>
  /** The shell cannot open the system browser (no default browser, a refusal). */
  refuseOpenAuth?: boolean
  /**
   * The shell REFUSES every start with this reason, as its own `startError`
   * (a denied device grant is `NotApproved`, a sidecar that would not spawn
   * is `SidecarSpawnFailed`).
   */
  refuseStart?: string
  /**
   * The local model ids the shell advertises. Absent is a shell that predates
   * the choice, which is what every older test models.
   */
  localModels?: readonly string[]
  /** The folder the shell remembers per conversation, as `restoreThreadFolder` answers it. */
  threadFolders?: Record<string, DesktopRecentFolder>
  /** A shell that predates `openDeviceApproval` (the approval step is a plain link). */
  withoutApprovalOpener?: boolean
  /** A shell that predates `openExternalUrl` (external links do nothing). */
  withoutExternalOpener?: boolean
  /**
   * The refusal also arrives as the reconnect reason, in the same snapshot:
   * what the real shell does for a failed device grant.
   */
  refuseStartAsReconnect?: boolean
  /** Who holds the conversation, on a `ConversationClaimed` refusal. */
  refuseStartHolder?: DesktopClaimHolder
  /** A start that says `takeOver` is NOT refused, as the server accepts it. */
  takeOverSucceeds?: boolean
  /** A shell older than the in-app Claude sign-in: none of its methods. */
  withoutClaudeSignIn?: boolean
  /** The shell refuses a code the way it refuses a malformed one. */
  refuseClaudeCode?: boolean
  /** What `openLocalPath` answers. Defaults to `opened`. */
  localPathOutcome?: DesktopLocalPathOutcome
  /** A shell that predates `openLocalPath` (paths stay plain text). */
  withoutLocalPathOpener?: boolean
  /** A shell that predates `openDownloadedFile`. */
  withoutDownloadedFileOpener?: boolean
  /** The shell refuses every downloaded file (`openDownloadedFile` answers false). */
  refuseDownloadedFile?: boolean
  /** The saved servers the shell publishes for the page's servers UI. */
  servers?: DesktopServers
}

export interface FakeBridgeHandle {
  bridge: DesktopBridge
  calls: FakeBridgeCalls
  /** The snapshot the fake shell is holding right now. */
  state(): DesktopSessionState
  /** Pushes a new snapshot to every subscriber, as a real state change would. */
  push(next: Partial<DesktopSessionState>): void
  /** Hands the page a `liaison://oauth-complete` link, as the OS would. */
  deliverOAuthLink(link: string): void
}

/**
 * Publishes a fake shell on the window and points the desktop store at it.
 * Call `uninstallFakeBridge` in an `afterEach`, always: a leaked bridge makes
 * the next file's browser test render desktop UI.
 */
export function installFakeBridge(
  initial: Partial<DesktopSessionState> = {},
  options: FakeBridgeOptions = {},
): FakeBridgeHandle {
  const calls: FakeBridgeCalls = {
    started: [],
    stopped: 0,
    turns: [],
    interrupted: 0,
    modes: [],
    locations: [],
    permissions: [],
    pickedFolder: 0,
    pickedFolderAgents: [],
    recentFolderReads: [],
    clearedDeviceApprovals: 0,
    dismissedConnects: 0,
    serverAddresses: [],
    readFiles: [],
    openedAuthUrls: [],
    pickedFolderThreads: [],
    restoredThreadFolders: [],
    openedApprovalUrls: [],
    openedExternalUrls: [],
    claudeSignIns: 0,
    claudeSignOuts: 0,
    claudeCodes: [],
    claudeCancels: 0,
    claudeReopens: 0,
    claudeNeededDismissals: 0,
    openedLocalPaths: [],
    openedDownloadedFiles: [],
  }
  const oauthListeners = new Set<(link: string) => void>()
  let snapshot: DesktopSessionState = { ...emptyDesktopSessionState(), ...initial }
  const listeners = new Set<(state: DesktopSessionState) => void>()
  /** The folder handles this fake shell has issued, as the real one keeps them. */
  const handles = new Set<string>((initial.recentFolders ?? []).map((folder) => folder.id))

  const publish = () => {
    for (const listener of Array.from(listeners)) listener(snapshot)
  }

  const bridge: DesktopBridge = {
    version: DESKTOP_BRIDGE_VERSION,
    platform: options.platform ?? "macos",
    ...(options.localModels ? { localModels: options.localModels } : {}),
    ...(options.servers ? { servers: options.servers } : {}),
    pickFolder: async (agentId?: string, threadId?: string) => {
      calls.pickedFolder += 1
      calls.pickedFolderAgents.push(agentId)
      calls.pickedFolderThreads.push(threadId)
      const chosen = options.pickFolderResult ?? null
      if (chosen === null) return null
      // The shell answers a HANDLE, and holds the path itself; the path lands
      // on the state, which is what makes a later start with no handle work.
      handles.add(chosen)
      snapshot = { ...snapshot, folderPath: chosen, runtimeLocation: "local" }
      publish()
      return chosen
    },
    /**
     * The shell's persisted list for this agent, as the real shell answers it:
     * from `FakeBridgeOptions.storedRecentFolders`, which stands in for the
     * owner-only file that outlives a window.
     */
    restoreThreadFolder: async (threadId: string, agentId: string) => {
      calls.restoredThreadFolders.push(`${threadId}:${agentId}`)
      const folder = options.threadFolders?.[threadId]
      if (!folder) return null
      handles.add(folder.id)
      snapshot = {
        ...snapshot,
        folderPath: folder.path,
        recentFolders: snapshot.recentFolders.some((row) => row.id === folder.id)
          ? snapshot.recentFolders
          : [folder, ...snapshot.recentFolders],
      }
      publish()
      return folder.id
    },
    loadRecentFolders: async (agentId: string) => {
      calls.recentFolderReads.push(agentId)
      const stored = options.storedRecentFolders?.[agentId]
      if (!stored) return
      for (const folder of stored) handles.add(folder.id)
      snapshot = { ...snapshot, recentFolders: stored }
      publish()
    },
    getServerAddress: () => options.serverAddress ?? null,
    setServerAddress: async (url: string) => {
      calls.serverAddresses.push(url)
      if (options.rejectServerAddress) throw new Error(options.rejectServerAddress)
    },
    startSession: async (input: DesktopStartSessionInput) => {
      calls.started.push(input)
      // THE SHELL'S OWN REFUSALS, modelled (P6d-FX2, SK-1): a path is not an
      // argument, and a handle the shell never issued names no folder. A fake
      // that started anything would let a caller regress to a path and stay
      // green.
      if (Object.hasOwn(input as object, "folderPath")) return false
      if (input.folderId !== undefined && !handles.has(input.folderId)) return false
      if (options.refuseStart && !(options.takeOverSucceeds && input.takeOver === true)) {
        snapshot = {
          ...snapshot,
          sessionStatus: "idle",
          startError: options.refuseStart,
          startClaimHolder: options.refuseStartHolder ?? null,
          ...(options.refuseStartAsReconnect ? { reconnectReason: options.refuseStart } : {}),
        }
        publish()
        return false
      }
      // The real shell refuses a start with no folder on its state and no
      // handle, and a successful one publishes the running session BEFORE it
      // answers true: a caller that reads the state right after sees it.
      const folder =
        input.folderId !== undefined
          ? (snapshot.recentFolders.find((row) => row.id === input.folderId)?.path ??
            input.folderId)
          : snapshot.folderPath
      if (!folder) {
        snapshot = { ...snapshot, sessionStatus: "idle", startError: "NoFolderChosen" }
        publish()
        return false
      }
      snapshot = {
        ...snapshot,
        runtimeLocation: "local",
        sessionStatus: "running",
        threadId: input.threadId,
        agentId: input.agentId,
        folderPath: folder,
        startError: null,
        startClaimHolder: null,
        // A running session is the answer to a turn that died with the last one.
        turnFailure: null,
      }
      publish()
      return true
    },
    stopSession: async () => {
      calls.stopped += 1
    },
    sendTurn: async (messageId: string) => {
      calls.turns.push(messageId)
    },
    interruptTurn: async () => {
      calls.interrupted += 1
    },
    respondToPermission: async (requestId: string, decision: DesktopPermissionDecision) => {
      calls.permissions.push({ requestId, decision })
    },
    readLocalFile: async (path: string) => {
      calls.readFiles.push(path)
      return options.readLocalFileResult ?? null
    },
    setPermissionMode: async (mode: DesktopPermissionMode) => {
      calls.modes.push(mode)
      if (options.refusePermissionMode) return false
      // BYPASS ANSWERS WHAT IS PARKED (P6d-FX2, SK-5). The real shell allows
      // every outstanding prompt when the user switches to Bypass, because
      // Bypass means allow and the SDK is parked on a question the card is
      // about to stop drawing. A fake that only moved the pill would leave
      // every surface green over a turn that hangs.
      if (mode === "bypass") {
        for (const prompt of snapshot.pendingPermissions) {
          calls.permissions.push({ requestId: prompt.requestId, decision: "allow" })
        }
        snapshot = { ...snapshot, permissionMode: mode, pendingPermissions: [] }
      } else if (mode === "auto") {
        // Auto answers the parked Liaison calls it would not have asked about;
        // a shell command stays on its card (apps/desktop bridge.ts).
        const liaison = snapshot.pendingPermissions.filter((p) =>
          p.toolName.startsWith("mcp__liaison__"),
        )
        for (const prompt of liaison) {
          calls.permissions.push({ requestId: prompt.requestId, decision: "allow" })
        }
        snapshot = {
          ...snapshot,
          permissionMode: mode,
          pendingPermissions: snapshot.pendingPermissions.filter((p) => !liaison.includes(p)),
        }
      } else {
        snapshot = { ...snapshot, permissionMode: mode }
      }
      publish()
      return true
    },
    /**
     * The shell drops the code and puts the control back to idle, releasing
     * nothing: no claim is taken before the grant is answered.
     */
    dismissConnect: () => {
      calls.dismissedConnects += 1
      snapshot = { ...snapshot, addingServer: false, deepLinkAddress: null }
      publish()
    },
    clearDeviceApproval: () => {
      calls.clearedDeviceApprovals += 1
      snapshot = { ...snapshot, deviceApproval: null, sessionStatus: "idle" }
      publish()
    },
    setRuntimeLocation: (location: DesktopRuntimeLocation) => {
      calls.locations.push(location)
      snapshot = { ...snapshot, runtimeLocation: location }
      publish()
    },
    openAuthInBrowser: async (url: string) => {
      calls.openedAuthUrls.push(url)
      return !options.refuseOpenAuth
    },
    ...(options.withoutApprovalOpener
      ? {}
      : {
          openDeviceApproval: async (url: string) => {
            calls.openedApprovalUrls.push(url)
            return true
          },
        }),
    ...(options.withoutExternalOpener
      ? {}
      : {
          openExternalUrl: async (url: string) => {
            calls.openedExternalUrls.push(url)
            return true
          },
        }),
    ...(options.withoutClaudeSignIn
      ? {}
      : {
          checkClaudeAccount: async () => snapshot.claudeAccount ?? null,
          signOutOfClaude: async () => {
            calls.claudeSignOuts += 1
          },
          /** The shell opens the page and says it is waiting, as the real one does. */
          startClaudeSignIn: async () => {
            calls.claudeSignIns += 1
            snapshot = { ...snapshot, claudeSignIn: { phase: "waiting" } }
            publish()
            return true
          },
          submitClaudeSignInCode: async (code: string) => {
            calls.claudeCodes.push(code)
            snapshot = {
              ...snapshot,
              claudeSignIn: { phase: options.refuseClaudeCode ? "codeRejected" : "checking" },
            }
            publish()
            return !options.refuseClaudeCode
          },
          cancelClaudeSignIn: async () => {
            calls.claudeCancels += 1
            snapshot = { ...snapshot, claudeSignIn: null }
            publish()
          },
          reopenClaudeSignIn: async () => {
            calls.claudeReopens += 1
            return true
          },
          dismissClaudeSignInNeeded: () => {
            calls.claudeNeededDismissals += 1
            snapshot = { ...snapshot, claudeSignInNeeded: null }
            publish()
          },
        }),
    ...(options.withoutLocalPathOpener
      ? {}
      : {
          openLocalPath: async (path: string) => {
            calls.openedLocalPaths.push(path)
            return options.localPathOutcome ?? "opened"
          },
        }),
    ...(options.withoutDownloadedFileOpener
      ? {}
      : {
          openDownloadedFile: async (bytes: Uint8Array, name: string) => {
            calls.openedDownloadedFiles.push({ name, bytes })
            return !options.refuseDownloadedFile
          },
        }),
    onOAuthComplete: (listener) => {
      oauthListeners.add(listener)
      return () => oauthListeners.delete(listener)
    },
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = bridge
  attachDesktopBridge()

  return {
    bridge,
    calls,
    state: () => snapshot,
    push: (next: Partial<DesktopSessionState>) => {
      snapshot = { ...snapshot, ...next }
      publish()
    },
    deliverOAuthLink: (link: string) => {
      for (const listener of Array.from(oauthListeners)) listener(link)
    },
  }
}

/** Puts the window back the way a browser has it and drops the subscription. */
export function uninstallFakeBridge(): void {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  resetDesktopStore()
}

/** A live local session for one conversation, which is what most surfaces need. */
export function liveSession(
  threadId: string,
  agentId: string,
  extra: Partial<DesktopSessionState> = {},
): Partial<DesktopSessionState> {
  return {
    runtimeLocation: "local",
    sessionStatus: "running",
    threadId,
    agentId,
    folderPath: "/Users/someone/code/acme-monorepo",
    ...extra,
  }
}
