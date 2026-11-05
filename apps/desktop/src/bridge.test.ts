// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T04: the shell publishes the bridge apps/web's contract declares.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The sidecar's stream, under this test's control: the turn loop waits for the
// sidecar to say a turn is done, and a stream that never says so is a hang.
const { startTurnMock, turnListeners, promptListeners } = vi.hoisted(() => ({
  startTurnMock: vi.fn(async (_prompt: string) => {}),
  turnListeners: new Set<(event: { type: string; [key: string]: unknown }) => void>(),
  promptListeners: new Set<(prompt: Record<string, unknown>) => void>(),
}))

function emitPermissionPrompt(prompt: Record<string, unknown>): void {
  for (const listener of Array.from(promptListeners)) listener(prompt)
}

function emitTurnEvent(event: { type: string; [key: string]: unknown }): void {
  for (const listener of Array.from(turnListeners)) listener(event)
}

// The shell's own signals, under this test's control: the bridge follows them
// and there is no Tauri event to fire under jsdom.
// The half of the shell that actually starts a child, under this test's
// control: a start must be observable as "was the sidecar asked to run in this
// folder", not as "did something throw".
// WHAT HAPPENED IN WHICH ORDER (P6d-FX5, W8). The previous session's claim
// and the new session's claim are on the same (thread, agent) pair, so a stop
// that runs after the start is a start the server refuses with a 409. The two
// halves are mocked, so the ordering is the only thing that can be asserted,
// and it is the whole defect.
const {
  startLocalSessionMock,
  endLocalSessionMock,
  startOrder,
  pickFolderMock,
  recentFoldersMock,
} = vi.hoisted(() => {
  const startOrder: string[] = []
  return {
    startOrder,
    startLocalSessionMock: vi.fn(async (_options: { folder: string }) => {
      startOrder.push("start")
      return {} as unknown
    }),
    endLocalSessionMock: vi.fn(async () => {
      startOrder.push("end")
    }),
    pickFolderMock: vi.fn(async (_agentId: string | null) => null as string | null),
    recentFoldersMock: vi.fn(async (_agentId: string) => [] as string[]),
  }
})

// The node job runner, under this test's control (P3-T14: the bridge only forwards).
const { runnerMock } = vi.hoisted(() => ({
  runnerMock: {
    offer: vi.fn(),
    startup: vi.fn(async () => {}),
    running: vi.fn(() => [] as string[]),
    wake: vi.fn(async (_sessionId?: string) => {}),
    reconnected: vi.fn(async () => {}),
    fullOutput: vi.fn(async (_sessionId: string, _toolUseId: string) => {}),
    ready: Promise.resolve(),
  },
}))

vi.mock("./node-jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-jobs/runner")>()),
  createNodeJobRunner: vi.fn(() => runnerMock),
}))

vi.mock("./session/start-local-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session/start-local-session")>()
  return {
    ...actual,
    startLocalSession: startLocalSessionMock,
    endLocalSession: endLocalSessionMock,
  }
})

// The Claude account the shell reads off the CLI (claude_auth.rs). Null is a
// shell that cannot tell, which is what every older case here runs on.
const { claudeSignOutAskMock, localModelsMock } = vi.hoisted(() => ({
  claudeSignOutAskMock: vi.fn(async () => {}),
  // The bundled SDK's list, asked with no session (`claude_local_models`).
  // Null is an SDK that did not say, which every older case here runs on.
  localModelsMock: vi.fn(async () => null as unknown),
}))
const { claudeStatusMock, claudeLoginMock, claudeCodeMock, claudeFailureMock } = vi.hoisted(() => ({
  claudeFailureMock: vi.fn(async () => {}),
  claudeStatusMock: vi.fn(
    async (_options?: { fresh?: boolean }) =>
      null as null | { loggedIn: boolean; email: string | null },
  ),
  claudeLoginMock: vi.fn(async () => {}),
  claudeCodeMock: vi.fn(async (_code: string) => {}),
}))

const { mcpMock, modeMock, serverMessage, shell } = vi.hoisted(() => ({
  mcpMock: vi.fn(async (_tool: string, _args: unknown) => ({}) as unknown),
  shell: {
    setDeviceApproval: (_uri: string | null) => {},
    setReconnectReason: (_reason: string | null) => {},
    setUpdateProgress: (_progress: unknown) => {},
  },
  modeMock: vi.fn(async (_mode: string) => {}),
  /** What the server answers for the one message id the shell re-reads. */
  serverMessage: {
    current: null as null | { id: string; threadId: string; authorKind: string; text: string },
  },
}))

vi.mock("./session/sidecar-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session/sidecar-client")>()
  const { createSignal } = await import("solid-js")
  const [device, setDevice] = createSignal<string | null>(null)
  const [reconnect, setReconnect] = createSignal<string | null>(null)
  const [update, setUpdate] = createSignal<unknown>(null)
  shell.setDeviceApproval = setDevice
  shell.setReconnectReason = setReconnect
  shell.setUpdateProgress = (progress) => setUpdate(() => progress)
  return {
    ...actual,
    deviceApproval: device,
    // The real one writes the real signal, and this file's `deviceApproval` is
    // a fake: without this the shell's own clear would be invisible here.
    clearDeviceApproval: () => setDevice(null),
    reconnectReason: reconnect,
    updateProgress: update,
    callMcpTool: mcpMock,
    setPermissionMode: modeMock,
    startTurn: startTurnMock,
    interrupt: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
    pickFolder: pickFolderMock,
    recentFolders: recentFoldersMock,
    getInstallSalt: vi.fn(async () => "f".repeat(32)),
    setServerAddress: vi.fn(async (url: string) => ({
      address: url.replace(/\/+$/, ""),
      storage: {},
    })),
    readLocalFile: vi.fn(async () => new Blob()),
    onTurnEvent: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
      turnListeners.add(listener)
      return () => turnListeners.delete(listener)
    },
    onPermissionPrompt: (callback: (prompt: Record<string, unknown>) => void) => {
      promptListeners.add(callback)
      return () => promptListeners.delete(callback)
    },
    armShellEvents: vi.fn(async () => {}),
    // The shell answers the decision it WROTE; by default the one asked for.
    respondToPermissionPrompt: vi.fn(async (_id: string, decision: "allow" | "deny") => decision),
    claudeAuthStatus: claudeStatusMock,
    claudeAuthLogin: claudeLoginMock,
    claudeAuthSubmitCode: claudeCodeMock,
    claudeAuthCancel: vi.fn(async () => {}),
    claudeAuthNoteFailure: claudeFailureMock,
    onClaudeAuth: vi.fn(async () => () => {}),
    confirmClaudeSignOut: claudeSignOutAskMock,
    claudeLocalModels: localModelsMock,
  }
})

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: true, json: async () => ({ data: serverMessage.current }) })),
)

import {
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  type DesktopBridge,
} from "@liaison/web/lib/desktop-shell-contract"
import {
  APPROVAL_POLL_INTERVAL_MS,
  applyClaudeAuthUpdate,
  approvalStatusFor,
  capabilityKeyOf,
  createCapabilityPublisher,
  createFolderEditor,
  createOrphanStopper,
  createSharedRoots,
  discoverLocalModels,
  LOCAL_MODELS_MIRROR_KEY,
  publishDesktopBridge,
  refreshWindowToken,
  releaseRuntimeLocation,
  resetDesktopBridge,
  setDesktopSessionState,
} from "./bridge"
import {
  connectDeepLinkAddress,
  noteDeepLink,
  pendingDeepLink,
  resetDeepLinks,
} from "./onboarding/DeepLinkHandler"
import {
  clearProducedFiles,
  noteProducedFile,
  noteServerAddress,
  noteSessionToken,
  RUNTIME_LOCATION_MIRROR_KEY,
  resetDesktopStore,
  setApprovalRequestId,
} from "./session/desktop-store"
import { LocalClaimError } from "./session/local-claim"
import { publishedServerAddress, SERVER_ADDRESS_MIRROR_KEY } from "./session/server-global"
import { setPageReloader } from "./session/server-switch"
import { StartSessionError } from "./session/sidecar-client"
import type { LocalSessionHandle } from "./session/start-local-session"
import { LocalSessionStartError } from "./session/start-local-session"
import { attachLocalTurns, replyRetry } from "./session/thread-turn-bridge"

// A server switch starts the page again; the runner's page stays where it is.
setPageReloader(() => undefined)

/** Every method apps/web's contract names, so a missing one is loud. */
const CONTRACT_METHODS = [
  "pickFolder",
  "loadRecentFolders",
  "getServerAddress",
  "setServerAddress",
  "startSession",
  "stopSession",
  "sendTurn",
  "interruptTurn",
  "respondToPermission",
  "clearDeviceApproval",
  "readLocalFile",
  "setPermissionMode",
  "setRuntimeLocation",
  "getState",
  "subscribe",
] as const

function fakeHandle(): LocalSessionHandle {
  return {
    agentId: "a1",
    auditSessionId: "s1",
    folderHash: "hash",
    mode: "manual",
    model: "claude-haiku-4-5",
    serverAddress: "https://liaison.example",
    accessToken: "token",
    threadId: "t1",
    claimHolderKey: null,
    finish: async () => {},
    systemPromptChecksum: async () => null,
  } as unknown as LocalSessionHandle
}

/** A bridge that has just been published, on a state with nothing left over. */
function freshBridge(): DesktopBridge {
  resetDesktopBridge()
  const target: Record<string, unknown> = {}
  publishDesktopBridge(target)
  return target[DESKTOP_BRIDGE_KEY] as DesktopBridge
}

// THE RUNTIME THE USER CHOSE SURVIVES A RELOAD.
//
// It lived in this module's store and in the overlay's signal, and both die
// with the window's JS context. The device grant and the connect card both
// reload the page, so a user who had just said "this machine", with nothing
// started, came back to a control that said Liaison and no way to tell why.
describe("the runtime location the user chose", () => {
  afterEach(() => {
    resetDesktopStore()
    resetDesktopBridge()
  })

  it("a window that comes up after a reload starts on the last choice", () => {
    freshBridge().setRuntimeLocation("local")
    expect(localStorage.getItem(RUNTIME_LOCATION_MIRROR_KEY)).toBe("local")

    // A RELOAD: nothing this window held survives, the mirror does.
    expect(freshBridge().getState().runtimeLocation).toBe("local")
  })

  it("a Liaison pick is mirrored too, so a reload never puts the turns back on the machine", () => {
    freshBridge().setRuntimeLocation("local")
    // Established: a window coming up now would run on this machine.
    expect(freshBridge().getState().runtimeLocation).toBe("local")

    freshBridge().setRuntimeLocation("liaison")

    expect(localStorage.getItem(RUNTIME_LOCATION_MIRROR_KEY)).toBe("liaison")
    expect(freshBridge().getState().runtimeLocation).toBe("liaison")
  })

  // The sign out path itself is the overlay's logout branch, proved in
  // overlay.test.tsx against the real fetch wrapper. This is its one guard: a
  // runtime that describes a LIVE session is not a preference to hand back.
  it("a release with a session still running keeps the runtime that describes it", () => {
    const bridge = freshBridge()
    bridge.setRuntimeLocation("local")
    expect(freshBridge().getState().runtimeLocation).toBe("local")
    setDesktopSessionState({ sessionStatus: "running" })

    releaseRuntimeLocation()

    expect(localStorage.getItem(RUNTIME_LOCATION_MIRROR_KEY)).toBe("local")
    expect(bridge.getState().runtimeLocation).toBe("local")
  })
})

describe("the desktop bridge", () => {
  beforeEach(() => {
    startTurnMock.mockClear()
    startLocalSessionMock.mockClear()
    startLocalSessionMock.mockResolvedValue({})
    pickFolderMock.mockClear()
    pickFolderMock.mockResolvedValue(null)
    recentFoldersMock.mockClear()
    recentFoldersMock.mockResolvedValue([])
    mcpMock.mockClear()
    modeMock.mockClear()
    modeMock.mockResolvedValue(undefined)
    serverMessage.current = null
    resetDeepLinks()
    clearProducedFiles()
    setApprovalRequestId(null)
    shell.setDeviceApproval(null)
    shell.setReconnectReason(null)
  })

  it("the bridge publishes a version 1 object on the window", () => {
    const target: Record<string, unknown> = {}
    publishDesktopBridge(target)
    const bridge = target[DESKTOP_BRIDGE_KEY] as DesktopBridge
    expect(bridge).toBeTruthy()
    expect(bridge.version).toBe(DESKTOP_BRIDGE_VERSION)
    expect(["macos", "windows", "linux"]).toContain(bridge.platform)
    for (const method of CONTRACT_METHODS) {
      expect(typeof (bridge as unknown as Record<string, unknown>)[method]).toBe("function")
    }
  })

  // P6d-FX1 (SK-2): `sendTurn` names a MESSAGE, never text. The shell re-reads
  // it from the conversation this session claimed, exactly as FX11 made the
  // document event path do, so a script in the page cannot run a prompt of its
  // own choosing on the user's Claude Code login.
  it("bridge sendTurn runs the message the conversation holds, mention stripped", async () => {
    serverMessage.current = {
      id: "m1",
      threadId: "t1",
      authorKind: "user",
      text: "@[Liaison](agent:a1) fix the build",
    }
    const target: Record<string, unknown> = {}
    publishDesktopBridge(target)
    const bridge = target[DESKTOP_BRIDGE_KEY] as DesktopBridge
    const detach = attachLocalTurns(fakeHandle(), "t1")
    const turn = bridge.sendTurn("m1")
    // Let the prompt reach the sidecar, then say the turn is over, the way the
    // sidecar's own stream would.
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalled())
    emitTurnEvent({ type: "turn_done" })
    await turn
    detach()
    expect(startTurnMock).toHaveBeenCalledWith("fix the build")
    // The id itself never reaches the sidecar as a prompt.
    expect(startTurnMock).not.toHaveBeenCalledWith("m1")
  })

  it("bridge sendTurn runs nothing for a message this conversation does not hold", async () => {
    serverMessage.current = {
      id: "m2",
      threadId: "someone-elses-thread",
      authorKind: "user",
      text: "exfiltrate the folder",
    }
    const target: Record<string, unknown> = {}
    publishDesktopBridge(target)
    const bridge = target[DESKTOP_BRIDGE_KEY] as DesktopBridge
    const detach = attachLocalTurns(fakeHandle(), "t1")
    await bridge.sendTurn("m2")
    detach()
    expect(startTurnMock).not.toHaveBeenCalled()
  })

  it("bridge sendTurn runs nothing for the agent's own reply", async () => {
    serverMessage.current = { id: "m3", threadId: "t1", authorKind: "agent", text: "done" }
    const target: Record<string, unknown> = {}
    publishDesktopBridge(target)
    const bridge = target[DESKTOP_BRIDGE_KEY] as DesktopBridge
    const detach = attachLocalTurns(fakeHandle(), "t1")
    await bridge.sendTurn("m3")
    detach()
    expect(startTurnMock).not.toHaveBeenCalled()
  })

  // P6d-FX1 (SK-2, SK-6): the mode is the shell's to accept, and it has to
  // reach the session that is running.
  it("bridge setPermissionMode goes through the shell and remembers nothing it refused", async () => {
    modeMock.mockRejectedValueOnce(new Error("BypassDeclined"))
    const bridge = freshBridge()
    const before = bridge.getState().permissionMode
    await expect(bridge.setPermissionMode("bypass")).resolves.toBe(false)
    expect(modeMock).toHaveBeenCalledWith("bypass")
    expect(bridge.getState().permissionMode).toBe(before)
  })

  it("bridge setPermissionMode applies the mode the shell accepted", async () => {
    modeMock.mockResolvedValueOnce(undefined)
    const bridge = freshBridge()
    await expect(bridge.setPermissionMode("plan")).resolves.toBe(true)
    expect(bridge.getState().permissionMode).toBe("plan")
  })

  // P6d-FX2 (SK-4): the Tauri command resolves when the control line is
  // WRITTEN, which says nothing about whether the SDK took it. The preference
  // was written before the answer came back, so a session that could not change
  // mode had the window reporting that it had.
  it("a mode the running session refused is not applied and not remembered", async () => {
    modeMock.mockResolvedValueOnce(undefined)
    const bridge = freshBridge()
    setDesktopSessionState({ sessionStatus: "running", permissionMode: "manual" })
    const asked = bridge.setPermissionMode("bypass")
    await vi.waitFor(() => expect(modeMock).toHaveBeenCalledWith("bypass"))
    emitTurnEvent({
      type: "permission_mode_refused",
      mode: "bypass",
      reason: "SessionCannotChangeMode",
    })
    await expect(asked).resolves.toBe(false)
    expect(bridge.getState().permissionMode).toBe("manual")
  })

  it("a mode the running session acknowledged is applied once it said so", async () => {
    modeMock.mockResolvedValueOnce(undefined)
    const bridge = freshBridge()
    setDesktopSessionState({ sessionStatus: "running", permissionMode: "manual" })
    const asked = bridge.setPermissionMode("plan")
    await vi.waitFor(() => expect(modeMock).toHaveBeenCalledWith("plan"))
    // Nothing is remembered on the way there.
    expect(bridge.getState().permissionMode).toBe("manual")
    emitTurnEvent({ type: "permission_mode", mode: "plan" })
    await expect(asked).resolves.toBe(true)
    expect(bridge.getState().permissionMode).toBe("plan")
  })

  it("a mode chosen between sessions is the preference the next one starts in", async () => {
    modeMock.mockResolvedValueOnce(undefined)
    const bridge = freshBridge()
    // Nothing running: there is no query to acknowledge it, and the shell
    // answers Ok because this is a preference rather than an escalation.
    expect(bridge.getState().sessionStatus).toBe("idle")
    await expect(bridge.setPermissionMode("edit")).resolves.toBe(true)
    expect(bridge.getState().permissionMode).toBe("edit")
  })

  // The shell refuses an address that cannot carry a token (not http(s)), and
  // the bridge must not swallow that, or the page would report a server it is
  // not bound to.
  it("bridge setServerAddress surfaces the shell's refusal rather than swallowing it", async () => {
    const client = await import("./session/sidecar-client")
    const refuse = vi
      .spyOn(client, "setServerAddress")
      .mockRejectedValueOnce(new Error("the server address must be an http or https URL"))
    const bridge = freshBridge()
    await expect(bridge.setServerAddress("javascript:alert(1)")).rejects.toThrow(
      "the server address must be an http or https URL",
    )
    expect(refuse).toHaveBeenCalledWith("javascript:alert(1)", expect.anything())
    refuse.mockRestore()
  })

  // The card that calls this reloads the window the moment it resolves, and
  // the page comes back up on the MIRROR (session/server-global.ts) before
  // the shell can answer. A mirror still naming the old host meant the
  // reloaded page landed straight back on the server the user was leaving.
  it("bridge setServerAddress mirrors the new origin before the page is reloaded", async () => {
    localStorage.removeItem(SERVER_ADDRESS_MIRROR_KEY)
    localStorage.setItem(SERVER_ADDRESS_MIRROR_KEY, "http://127.0.0.1:18080")
    const bridge = freshBridge()

    await bridge.setServerAddress("https://liaison.fabrikam.example/")

    // Synchronous with the resolution, so the reload the card runs next is
    // already the one on the new server.
    expect(localStorage.getItem(SERVER_ADDRESS_MIRROR_KEY)).toBe("https://liaison.fabrikam.example")
    expect(publishedServerAddress(globalThis)).toBe("https://liaison.fabrikam.example")
    localStorage.removeItem(SERVER_ADDRESS_MIRROR_KEY)
  })

  it("bridge subscribers receive a state snapshot when the session status changes", () => {
    const target: Record<string, unknown> = {}
    publishDesktopBridge(target)
    const bridge = target[DESKTOP_BRIDGE_KEY] as DesktopBridge
    const seen: string[] = []
    const stop = bridge.subscribe((state) => seen.push(state.sessionStatus))
    setDesktopSessionState({ sessionStatus: "running" })
    expect(seen).toContain("running")
    const soFar = seen.length
    stop()
    setDesktopSessionState({ sessionStatus: "stopped" })
    expect(seen.length).toBe(soFar)
    expect(bridge.getState().sessionStatus).toBe("stopped")
  })
})

// P6d-FX1 (SK-1): the five fields apps/web renders from that NOBODY wrote.
// Each case drives the half of the shell that actually learns the value and
// asserts it reaches the snapshot the page reads. Every one of them fails
// against a bridge that writes only the six session fields.
describe("the shell writes every field the page reads", () => {
  // The approval poll re-arms itself every two seconds for as long as a
  // request is pending, so a case that leaves one behind keeps the runner's
  // event loop alive for the rest of the file.
  afterEach(() => resetDesktopBridge())

  it("a device grant the shell is waiting on reaches the page state", async () => {
    const bridge = freshBridge()
    shell.setDeviceApproval("https://liaison.example/auth/device?code=ABCD-1234")
    await vi.waitFor(() =>
      expect(bridge.getState().deviceApproval).toBe(
        "https://liaison.example/auth/device?code=ABCD-1234",
      ),
    )
    shell.setDeviceApproval(null)
    await vi.waitFor(() => expect(bridge.getState().deviceApproval).toBeNull())
  })

  it("an update the shell is installing reaches the page state, and its end clears it", async () => {
    const bridge = freshBridge()
    expect(bridge.getState().updateProgress ?? null).toBeNull()
    shell.setUpdateProgress({ version: "0.2.0", phase: "downloading", percent: 42 })
    await vi.waitFor(() =>
      expect(bridge.getState().updateProgress).toEqual({
        version: "0.2.0",
        phase: "downloading",
        percent: 42,
      }),
    )
    shell.setUpdateProgress({ version: "0.2.0", phase: "installing", percent: null })
    await vi.waitFor(() =>
      expect(bridge.getState().updateProgress).toEqual({
        version: "0.2.0",
        phase: "installing",
        percent: null,
      }),
    )
    shell.setUpdateProgress(null)
    await vi.waitFor(() => expect(bridge.getState().updateProgress).toBeNull())
  })

  it("a reconnect reason the shell reports reaches the page state", async () => {
    const bridge = freshBridge()
    shell.setReconnectReason("TokenRefreshFailed")
    await vi.waitFor(() => expect(bridge.getState().reconnectReason).toBe("TokenRefreshFailed"))
  })

  it("a file produced AFTER the bridge was published reaches the page state", async () => {
    const bridge = freshBridge()
    expect(bridge.getState().producedFiles).toEqual([])
    noteProducedFile("/Users/someone/code/report.md")
    await vi.waitFor(() =>
      expect(bridge.getState().producedFiles).toEqual([
        { path: "/Users/someone/code/report.md", name: "report.md" },
      ]),
    )
  })

  // P6d-FX2 (SK-8): the shell held ONE produced file and mapped it into the
  // contract's array, so a session that produced two offered only the last and
  // the attach list was structurally one row long.
  it("a session that produced two files offers both, in the order it made them", async () => {
    const bridge = freshBridge()
    noteProducedFile("/Users/someone/code/report.md")
    noteProducedFile("/Users/someone/code/summary.csv")
    // The same file twice is the same file.
    noteProducedFile("/Users/someone/code/report.md")
    await vi.waitFor(() =>
      expect(bridge.getState().producedFiles).toEqual([
        { path: "/Users/someone/code/report.md", name: "report.md" },
        { path: "/Users/someone/code/summary.csv", name: "summary.csv" },
      ]),
    )
  })

  it("a connect deep link reaches the page state as a proposal", async () => {
    const bridge = freshBridge()
    noteDeepLink("liaison://connect?server=https://liaison.example")
    await vi.waitFor(() =>
      expect(bridge.getState().deepLinkAddress).toBe("https://liaison.example"),
    )
  })

  // THE END OF A SYSTEM-BROWSER SIGN-IN (RFC 8252). The OS hands the app a
  // `liaison://oauth-complete` link; it reaches the page's subscriber through
  // the bridge, and never the connect proposal.
  it("an oauth-complete deep link reaches the page's sign-in, not the connect proposal", async () => {
    resetDeepLinks()
    const bridge = freshBridge()
    const seen: string[] = []
    const stop = bridge.onOAuthComplete?.((link) => seen.push(link))
    const link =
      "liaison://oauth-complete?code=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&state=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg"
    noteDeepLink(link)
    expect(seen).toEqual([link])
    expect(connectDeepLinkAddress()).toBeNull()
    expect(pendingDeepLink()).toBeNull()
    stop?.()
  })

  it("offers the page a system-browser sign-in", () => {
    const bridge = freshBridge()
    expect(typeof bridge.openAuthInBrowser).toBe("function")
    expect(typeof bridge.onOAuthComplete).toBe("function")
  })

  it("a gated call reaches the page state, and the poll says what it is", async () => {
    mcpMock.mockResolvedValue({ structuredContent: { state: "pending" } })
    const bridge = freshBridge()
    setApprovalRequestId("appr-1")
    await vi.waitFor(() => expect(bridge.getState().pendingApprovalRequestId).toBe("appr-1"))
    await vi.waitFor(() => expect(bridge.getState().approvalStatus).toBe("pending"))
    expect(mcpMock).toHaveBeenCalledWith("liaison_approval_status", { approvalRequestId: "appr-1" })
  })

  it("a status the shell could not read is unknown and never pending", async () => {
    mcpMock.mockRejectedValue(new Error("the MCP relay failed"))
    const bridge = freshBridge()
    setApprovalRequestId("appr-2")
    await vi.waitFor(() => expect(bridge.getState().approvalStatus).toBe("unknown"))
  })

  it("a decided approval clears itself rather than waiting forever", async () => {
    mcpMock.mockResolvedValue({ structuredContent: { state: "approved" } })
    const bridge = freshBridge()
    setApprovalRequestId("appr-3")
    await vi.waitFor(() => expect(bridge.getState().pendingApprovalRequestId).toBeNull())
    expect(bridge.getState().approvalStatus).toBeNull()
  })

  it("the poll interval and the status mapping are the ones the banner used", () => {
    expect(APPROVAL_POLL_INTERVAL_MS).toBe(2_000)
    expect(approvalStatusFor("pending")).toBe("pending")
    expect(approvalStatusFor("denied")).toBeNull()
    expect(approvalStatusFor("something a later server grew")).toBe("unknown")
  })
})

/** One `tool_use` line, in the shape the sidecar actually emits. */
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "message",
    event: "tool_use",
    payload: { message: { content: [{ type: "tool_use", id, name, input }] } },
  }
}

/** One `tool_result` line for that id. */
function toolResult(id: string, isError = false) {
  return {
    type: "message",
    event: "tool_result",
    payload: {
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
    },
  }
}

// P6d-FX1 (SK-4, SK-9). The rows are also built from the REAL protocol line
// here: the bridge used to match `{ type: "tool_use" }`, a line the sidecar
// never emits, so every activity row was dead in the product.
describe("the local session's tool activity", () => {
  afterEach(() => {
    resetDesktopBridge()
    clearProducedFiles()
  })

  it("a tool call reaches the page state as a running row with its arguments summarised", () => {
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "ls" }))
    const rows = bridge.getState().toolActivity
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "toolu_1",
      toolName: "Bash",
      summary: "command: ls",
      status: "running",
    })
  })

  it("a failed tool result is an error row, never a completed one", () => {
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "false" }))
    emitTurnEvent(toolResult("toolu_1", true))
    expect(bridge.getState().toolActivity[0].status).toBe("error")
  })

  it("a tool result that worked completes the row it names", () => {
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Read", { file_path: "/a" }))
    emitTurnEvent(toolResult("toolu_1"))
    expect(bridge.getState().toolActivity[0].status).toBe("done")
  })

  // P6d-FX8: `noteProducedFile` was called from nothing but a test, so
  // `producedFiles` stayed empty for the whole life of every real session and
  // the attach control, which renders nothing for an empty list, could not
  // mount in the shipped app.
  it("a Write inside the session folder is offered as a produced file", async () => {
    const bridge = freshBridge()
    setDesktopSessionState({ folderPath: "/Users/someone/work" })
    emitTurnEvent(toolUse("toolu_1", "Write", { file_path: "/Users/someone/work/summary.md" }))
    await vi.waitFor(() =>
      expect(bridge.getState().producedFiles).toEqual([
        { path: "/Users/someone/work/summary.md", name: "summary.md" },
      ]),
    )
  })

  it("a file only READ, and a write outside the folder, are offered as neither", async () => {
    const bridge = freshBridge()
    setDesktopSessionState({ folderPath: "/Users/someone/work" })
    emitTurnEvent(toolUse("toolu_1", "Read", { file_path: "/Users/someone/work/notes.md" }))
    emitTurnEvent(toolUse("toolu_2", "Write", { file_path: "/etc/hosts" }))
    emitTurnEvent(toolUse("toolu_3", "Edit", { file_path: "/Users/someone/work/app.ts" }))
    await vi.waitFor(() =>
      expect(bridge.getState().producedFiles).toEqual([
        { path: "/Users/someone/work/app.ts", name: "app.ts" },
      ]),
    )
  })

  // A FINISHED TURN IS NOT A RUNNING ONE. The page mounts its live turn block
  // on the rows this state carries, and the rows outlive the turn on purpose
  // (they are the only place a local turn's tool calls are drawn). With
  // nothing else to read, the block stayed in its streaming state and every
  // finished local turn left a permanent "Generating..." under the agent's
  // own reply.
  it("the turn is active while it runs and over when the sidecar says it is", () => {
    const bridge = freshBridge()
    expect(bridge.getState().turnActive).toBe(false)
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "ls" }))
    expect(bridge.getState().turnActive).toBe(true)
    emitTurnEvent(toolResult("toolu_1"))
    expect(bridge.getState().turnActive).toBe(true)
    emitTurnEvent({ type: "turn_done" })
    expect(bridge.getState().turnActive).toBe(false)
    expect(bridge.getState().toolActivity).toHaveLength(1)
    emitTurnEvent(toolUse("toolu_2", "Read", { file_path: "/b" }))
    expect(bridge.getState().turnActive).toBe(true)
  })

  it("the second turn of a session shows its own rows, not the first turn's", () => {
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "ls" }))
    emitTurnEvent(toolResult("toolu_1"))
    emitTurnEvent({ type: "turn_done" })
    emitTurnEvent(toolUse("toolu_2", "Read", { file_path: "/b" }))
    const rows = bridge.getState().toolActivity
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("toolu_2")
  })
})

// P6d-FX1 (SK-5, SK-8). One slot held one prompt, and placement was guessed
// from the tool's name.
describe("the prompts the local session is blocked on", () => {
  afterEach(() => resetDesktopBridge())

  it("two prompts in flight are both kept, in arrival order", () => {
    const bridge = freshBridge()
    emitPermissionPrompt({ requestId: "req-1", toolName: "Edit", input: { file_path: "/a" } })
    emitPermissionPrompt({ requestId: "req-2", toolName: "Bash", input: { command: "ls" } })
    expect(bridge.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["req-1", "req-2"])
  })

  it("a prompt names the row it belongs in by the arguments, not by the tool name", () => {
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Edit", { file_path: "/a" }))
    emitTurnEvent(toolUse("toolu_2", "Edit", { file_path: "/b" }))
    emitPermissionPrompt({ requestId: "req-1", toolName: "Edit", input: { file_path: "/a" } })
    expect(bridge.getState().pendingPermissions[0].toolUseId).toBe("toolu_1")
  })

  it("a prompt that arrives before its tool row still has a row to live in", () => {
    const bridge = freshBridge()
    emitPermissionPrompt({ requestId: "req-1", toolName: "Bash", input: { command: "ls" } })
    const prompt = bridge.getState().pendingPermissions[0]
    const rows = bridge.getState().toolActivity
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(prompt.toolUseId)
    expect(rows[0].toolName).toBe("Bash")
  })

  it("the real tool_use claims that stand-in row rather than adding a second", () => {
    const bridge = freshBridge()
    emitPermissionPrompt({ requestId: "req-1", toolName: "Bash", input: { command: "ls" } })
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "ls" }))
    const rows = bridge.getState().toolActivity
    expect(rows.map((row) => row.id)).toEqual(["toolu_1"])
    expect(bridge.getState().pendingPermissions[0].toolUseId).toBe("toolu_1")
  })

  // D11: a shell command's allow is the shell's own dialog to give. A no
  // there comes back as a deny, and the stand-in row goes like any deny's.
  it("an allow the shell's dialog turned into a deny drops the stand-in row", async () => {
    const client = await import("./session/sidecar-client")
    vi.mocked(client.respondToPermissionPrompt).mockResolvedValueOnce("deny")
    const bridge = freshBridge()
    emitPermissionPrompt({ requestId: "req-1", toolName: "Bash", input: { command: "ls" } })
    await bridge.respondToPermission("req-1", "allow")
    expect(bridge.getState().pendingPermissions).toEqual([])
    expect(bridge.getState().toolActivity).toEqual([])
  })

  it("control: an allow the shell wrote keeps the row for the real tool_use", async () => {
    const bridge = freshBridge()
    emitPermissionPrompt({ requestId: "req-1", toolName: "Bash", input: { command: "ls" } })
    await bridge.respondToPermission("req-1", "allow")
    expect(bridge.getState().pendingPermissions).toEqual([])
    expect(bridge.getState().toolActivity).toHaveLength(1)
  })

  it("answering one prompt leaves the other outstanding", async () => {
    const bridge = freshBridge()
    emitPermissionPrompt({ requestId: "req-1", toolName: "Edit", input: { file_path: "/a" } })
    emitPermissionPrompt({ requestId: "req-2", toolName: "Bash", input: { command: "ls" } })
    await bridge.respondToPermission("req-1", "allow")
    expect(bridge.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["req-2"])
  })
})

// P6d-FX2 (SK-1). `startSession` took the folder from the CALLER, and the
// folder a session starts in is the root `readLocalFile` is bounded by: a page
// script could start a session at "/" with no picker and no dialog, then read
// anything on the machine through the shell and post it anywhere the CSP
// allows. The page names a folder the SHELL chose, by a handle the shell
// issued, or it names nothing.
describe("the folder a session starts in", () => {
  afterEach(() => resetDesktopBridge())

  /** A bridge with everything a start needs except a folder. */
  async function startableBridge(): Promise<DesktopBridge> {
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    return bridge
  }

  it("a start naming a PATH is refused, and nothing is spawned", async () => {
    const bridge = await startableBridge()
    const asked = { agentId: "a1", threadId: "t1", folderPath: "/" } as unknown as Parameters<
      DesktopBridge["startSession"]
    >[0]
    await expect(bridge.startSession(asked)).resolves.toBe(false)
    expect(startLocalSessionMock).not.toHaveBeenCalled()
    expect(bridge.getState().sessionStatus).not.toBe("running")
  })

  it("a start naming a handle this shell never issued is refused", async () => {
    const bridge = await startableBridge()
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: "folder-99" }),
    ).resolves.toBe(false)
    expect(startLocalSessionMock).not.toHaveBeenCalled()
  })

  it("the folder the picker chose starts a session, by its handle", async () => {
    const bridge = await startableBridge()
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/tessera-monorepo")
    const handle = await bridge.pickFolder()
    expect(handle).toBeTruthy()
    // What crossed is a handle, not the path the shell holds.
    expect(handle).not.toBe("/Users/someone/code/tessera-monorepo")
    expect(bridge.getState().folderPath).toBe("/Users/someone/code/tessera-monorepo")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle as string }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ folder: "/Users/someone/code/tessera-monorepo" }),
    )
  })

  it("the recent folders the page reads are the SHELL's, each with a handle", async () => {
    const bridge = await startableBridge()
    recentFoldersMock.mockResolvedValue(["/Users/someone/code/one"])
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    await bridge.pickFolder()
    const rows = bridge.getState().recentFolders
    expect(rows).toHaveLength(0)
    // With an agent on the state the shell's own list is what is offered.
    setDesktopSessionState({ agentId: "a1" })
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    await bridge.pickFolder()
    expect(recentFoldersMock).toHaveBeenCalledWith("a1")
    const offered = bridge.getState().recentFolders
    expect(offered).toEqual([
      { id: expect.any(String), path: "/Users/someone/code/one", name: "one" },
    ])
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: offered[0].id }),
    ).resolves.toBe(true)
  })

  // P6d-FX3 (W3). The shell keeps an agent's folders in an owner-only file
  // that outlives the window, and nothing read it back: `recentFolders` was
  // written by a pick and by a start and by nothing else, so a freshly
  // launched app offered an empty list however many folders the agent had run
  // in, and the native picker was the only way back to a session.
  it("the page can ask for an agent's folders without picking one first", async () => {
    const bridge = await startableBridge()
    recentFoldersMock.mockResolvedValue(["/Users/someone/code/one"])
    expect(bridge.getState().recentFolders).toEqual([])

    await bridge.loadRecentFolders("a1")

    expect(recentFoldersMock).toHaveBeenCalledWith("a1")
    const offered = bridge.getState().recentFolders
    expect(offered).toEqual([
      { id: expect.any(String), path: "/Users/someone/code/one", name: "one" },
    ])
    // And the handle it issued is one `startSession` accepts, which is what
    // makes the offered row a route to a session rather than a label.
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: offered[0].id }),
    ).resolves.toBe(true)
  })

  // The other half of W3: with nothing running the SHELL knows no agent, so a
  // pick made from an idle menu was filed under null and joined no list.
  it("a pick names the agent the control belongs to when none is running", async () => {
    const bridge = await startableBridge()
    expect(bridge.getState().agentId).toBeNull()
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")

    await bridge.pickFolder("a1")

    expect(pickFolderMock).toHaveBeenCalledWith("a1")
  })

  // THE FOLDER WAS FORGOTTEN ON RELAUNCH (2026-09-23): a pick lived only in
  // the window, so the next launch asked for it again. It is remembered per
  // conversation, and given back only while it is one of the agent's own
  // recent folders (the shell's list, which is what a start accepts anyway).
  it("a conversation's folder survives a relaunch, and only while it is still a recent one", async () => {
    localStorage.clear()
    let bridge = await startableBridge()
    pickFolderMock.mockResolvedValueOnce("/Users/someone/Rapports Liaison")
    await bridge.pickFolder("a1", "t1")

    // A relaunch: a fresh bridge with nothing on its state.
    resetDesktopBridge()
    bridge = await startableBridge()
    expect(bridge.getState().folderPath).toBeNull()
    recentFoldersMock.mockResolvedValue(["/Users/someone/Rapports Liaison"])
    const handle = await bridge.restoreThreadFolder?.("t1", "a1")
    expect(handle).toEqual(expect.any(String))
    expect(bridge.getState().folderPath).toBe("/Users/someone/Rapports Liaison")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle as string }),
    ).resolves.toBe(true)

    // Another conversation has nothing remembered.
    await expect(bridge.restoreThreadFolder?.("t2", "a1")).resolves.toBeNull()
  })

  it("a remembered folder that is no longer one of the agent's is not given back", async () => {
    localStorage.clear()
    localStorage.setItem("liaison:desktop:thread-folder:t1", "/etc")
    const bridge = await startableBridge()
    recentFoldersMock.mockResolvedValue(["/Users/someone/code/one"])
    await expect(bridge.restoreThreadFolder?.("t1", "a1")).resolves.toBeNull()
    expect(bridge.getState().folderPath).toBeNull()
  })
})

// P6d-FX2 (SK-3, SK-5). An `error` line from the sidecar is not the end of a
// turn, and a switch to Bypass answers what is parked rather than hiding it.
describe("what an error line and a mode change do to a live turn", () => {
  afterEach(() => resetDesktopBridge())

  it("an error line leaves the outstanding prompts and the rows exactly where they are", () => {
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "ls" }))
    emitPermissionPrompt({ requestId: "req-1", toolName: "Bash", input: { command: "ls" } })
    expect(bridge.getState().pendingPermissions).toHaveLength(1)
    // The line FX1's own mode path used to emit mid turn.
    emitTurnEvent({ type: "error", message: "the mode could not be changed" })
    expect(bridge.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["req-1"])
    expect(bridge.getState().toolActivity.map((row) => row.id)).toEqual(["toolu_1"])
    // And the turn really does end when the turn ends.
    emitTurnEvent({ type: "turn_done" })
    expect(bridge.getState().pendingPermissions).toEqual([])
  })

  it("switching to bypass allows the parked prompts and the row says who decided", async () => {
    modeMock.mockResolvedValueOnce(undefined)
    const client = await import("./session/sidecar-client")
    const answered = vi.spyOn(client, "respondToPermissionPrompt")
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "Bash", { command: "rm -rf build" }))
    emitPermissionPrompt({
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "rm -rf build" },
    })
    setDesktopSessionState({ sessionStatus: "running" })
    const asked = bridge.setPermissionMode("bypass")
    await vi.waitFor(() => expect(modeMock).toHaveBeenCalledWith("bypass"))
    emitTurnEvent({ type: "permission_mode", mode: "bypass" })
    await expect(asked).resolves.toBe(true)
    expect(answered).toHaveBeenCalledWith("req-1", "allow")
    expect(bridge.getState().pendingPermissions).toEqual([])
    const row = bridge.getState().toolActivity.find((entry) => entry.id === "toolu_1")
    expect(row?.allowedByBypass).toBe(true)
    answered.mockRestore()
  })
})

// A PARKED PROMPT IS NEVER LOST (the owner's stuck turn, 2026-09-23): the SDK
// waited on a can_use_tool answer while no card was left to give it.
describe("a prompt the session is parked on", () => {
  afterEach(() => resetDesktopBridge())

  it("survives the next tool event even when it arrived while the turn read as settled", () => {
    const bridge = freshBridge()
    const read = { name: "monthly-report" }
    // A row left running (its result never came) before the turn ended.
    emitTurnEvent(toolUse("toolu_1", "mcp__liaison__kernel__skill_read", read))
    emitTurnEvent({ type: "turn_done" })
    // The next turn's prompt for the same call lands on that row...
    emitPermissionPrompt({
      requestId: "req-1",
      toolName: "mcp__liaison__kernel__skill_read",
      input: read,
    })
    // ...and the next tool event must not retire it: the SDK is still parked.
    emitTurnEvent(toolUse("toolu_2", "mcp__liaison__kernel__skill_read", read))
    expect(bridge.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["req-1"])
  })

  it("a fresh window's session state is in Auto", () => {
    expect(freshBridge().getState().permissionMode).toBe("auto")
  })

  it("switching to auto allows a parked Liaison call and leaves a shell prompt on its card", async () => {
    modeMock.mockResolvedValueOnce(undefined)
    const client = await import("./session/sidecar-client")
    const answered = vi.spyOn(client, "respondToPermissionPrompt")
    const bridge = freshBridge()
    emitTurnEvent(toolUse("toolu_1", "mcp__liaison__kernel__skill_search", { query: "x" }))
    emitPermissionPrompt({
      requestId: "req-1",
      toolName: "mcp__liaison__kernel__skill_search",
      input: { query: "x" },
    })
    emitTurnEvent(toolUse("toolu_2", "Bash", { command: "rm -rf /tmp/x" }))
    emitPermissionPrompt({
      requestId: "req-2",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/x" },
    })
    setDesktopSessionState({ sessionStatus: "running" })
    const asked = bridge.setPermissionMode("auto")
    await vi.waitFor(() => expect(modeMock).toHaveBeenCalledWith("auto"))
    emitTurnEvent({ type: "permission_mode", mode: "auto" })
    await expect(asked).resolves.toBe(true)
    expect(bridge.getState().permissionMode).toBe("auto")
    expect(answered).toHaveBeenCalledWith("req-1", "allow")
    expect(answered).not.toHaveBeenCalledWith("req-2", "allow")
    expect(bridge.getState().pendingPermissions.map((p) => p.requestId)).toEqual(["req-2"])
    answered.mockRestore()
  })
})

// THE LOCAL MODEL IS THE USER'S CHOICE, and only a local model reaches the
// sidecar. The shell used to start every session on one hard coded model and
// the page had no way to name another, so the picker's local entry could not
// change what answered.
describe("the model a local session runs on", () => {
  beforeEach(() => localStorage.removeItem(LOCAL_MODELS_MIRROR_KEY))
  afterEach(() => {
    localStorage.removeItem(LOCAL_MODELS_MIRROR_KEY)
    resetDesktopBridge()
  })

  async function bridgeWithFolder(): Promise<{ bridge: DesktopBridge; handle: string }> {
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const handle = (await bridge.pickFolder("a1")) as string
    startLocalSessionMock.mockClear()
    return { bridge, handle }
  }

  // The ids the families resolved to on SDK 0.3.296, not the 4.5 era's.
  const FALLBACK_IDS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]

  it("advertises the fallback models until a session says what its SDK offers", () => {
    expect(freshBridge().localModels).toEqual(FALLBACK_IDS)
  })

  // 2026-10-01: THE LIST IS THE INSTALLED SDK'S. It was written into the app,
  // so a model the Agent SDK offered (Fable, Sonnet 5.5) could not be picked
  // until somebody edited the list and shipped a release.
  const DISCOVERED = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ]

  it("offers what the session's SDK said, labelled, and starts on a model the app never listed", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    emitTurnEvent({ type: "local_models", models: DISCOVERED })
    expect(bridge.localModels).toEqual(DISCOVERED.map((model) => model.id))
    expect(bridge.getState().localModels).toEqual(DISCOVERED)
    await expect(
      bridge.startSession({
        agentId: "a1",
        threadId: "t1",
        folderId: handle,
        model: "claude-fable-5-1[1m]",
      }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-fable-5-1[1m]" }),
    )
  })

  it("defaults to the preferred model's dated id, and refuses one the SDK stopped offering", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    emitTurnEvent({ type: "local_models", models: DISCOVERED })
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    )
    startLocalSessionMock.mockClear()
    await expect(
      bridge.startSession({
        agentId: "a1",
        threadId: "t1",
        folderId: handle,
        model: "claude-opus-4-6",
      }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("UnknownModel")
    expect(startLocalSessionMock).not.toHaveBeenCalled()
  })

  // 2026-10-01: a page older than discovery sends its own default,
  // `claude-haiku-4-5`, and the SDK offers Haiku only under its dated id: every
  // start from that page was refused. It is accepted as named, because that
  // page restarts a session whose model differs from the one it asked for.
  it("starts a page older than discovery on the fallback id it names", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    emitTurnEvent({ type: "local_models", models: DISCOVERED })
    await expect(
      bridge.startSession({
        agentId: "a1",
        threadId: "t1",
        folderId: handle,
        model: "claude-haiku-4-5",
      }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    )
    expect(bridge.getState().model).toBe("claude-haiku-4-5")
  })

  // 2026-10-14: A NODE THAT NEVER RAN A LOCAL CHAT published the fallback.
  // The list came only from a local session's `local_models` line, so a
  // computer used as a node and nothing else offered every client the three
  // ids written into the app, not what its bundled SDK advertises.
  describe("without any session", () => {
    beforeEach(() => localModelsMock.mockClear())
    afterEach(() => localModelsMock.mockReset().mockResolvedValue(null))

    it("offers the bundled SDK's own list as soon as the window is up", async () => {
      localModelsMock.mockResolvedValue(DISCOVERED)
      const bridge = freshBridge()
      await vi.waitFor(() =>
        expect(bridge.localModels).toEqual(DISCOVERED.map((model) => model.id)),
      )
      expect(localModelsMock).toHaveBeenCalledTimes(1)
      expect(bridge.getState().localModels).toEqual(DISCOVERED)
      expect(freshBridge().localModels).toEqual(DISCOVERED.map((model) => model.id))
    })

    it("asks again when the node starts after a discovery that failed", async () => {
      localModelsMock.mockResolvedValue(null)
      const bridge = freshBridge()
      await discoverLocalModels()
      expect(bridge.localModels).toEqual(FALLBACK_IDS)
      localModelsMock.mockResolvedValue(DISCOVERED)
      bridge.startNodeJobs?.({ onReview: () => {} })
      await vi.waitFor(() =>
        expect(bridge.localModels).toEqual(DISCOVERED.map((model) => model.id)),
      )
      expect(localModelsMock).toHaveBeenCalledTimes(2)
    })
  })

  it("remembers the SDK's list for the next window", () => {
    freshBridge()
    emitTurnEvent({ type: "local_models", models: DISCOVERED })
    expect(freshBridge().localModels).toEqual(DISCOVERED.map((model) => model.id))
  })

  it("keeps offering the fallback when a session says nothing usable", () => {
    const bridge = freshBridge()
    for (const models of [undefined, [], [{ label: "no id" }], "claude-opus-5-5"]) {
      emitTurnEvent({ type: "local_models", models })
    }
    expect(bridge.localModels).toEqual(FALLBACK_IDS)
  })

  it("starts the session on the model the page named, and says so on the state", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    await expect(
      bridge.startSession({
        agentId: "a1",
        threadId: "t1",
        folderId: handle,
        model: "claude-opus-5-5",
      }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-5-5" }),
    )
    expect(bridge.getState().model).toBe("claude-opus-5-5")
  })

  it("a page that names no model gets the fallback's Haiku before the SDK has said", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-5-5" }),
    )
  })

  // 2026-09-23: a session that started new because the org changed the agent
  // says so in the conversation, once, over its first turn.
  it("a session new because the agent changed says so until its first turn ends", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    startLocalSessionMock.mockResolvedValueOnce({ freshReason: "definition_changed" })
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    expect(bridge.getState().freshSession).toEqual({
      threadId: "t1",
      agentId: "a1",
      reason: "definition_changed",
    })
    emitTurnEvent({ type: "turn_done" })
    expect(bridge.getState().freshSession).toBe(null)
  })

  it("a resumed session, or one fresh for any other reason, says nothing", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    for (const freshReason of [null, "cold_resume", "definition_unknown"]) {
      startLocalSessionMock.mockResolvedValueOnce({ freshReason })
      await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
      expect(bridge.getState().freshSession ?? null).toBe(null)
    }
  })

  it("a Liaison model is refused and nothing is spawned", async () => {
    const { bridge, handle } = await bridgeWithFolder()
    for (const model of ["gemini-pro-latest", "gpt-5.4", "claude-opus-4-6"]) {
      await expect(
        bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle, model }),
      ).resolves.toBe(false)
      expect(bridge.getState().startError).toBe("UnknownModel")
    }
    expect(startLocalSessionMock).not.toHaveBeenCalled()
  })
})

// P6d-FX5 (W8). "A session start that fails says nothing at all": `start`
// answered false on a dozen different paths, put the status back to idle and
// told the page nothing, so thirty seconds of pressing Start produced a window
// identical to the one before it. And the refusal the driven walk actually hit
// was the shell's own doing: it stopped the previous session AFTER starting the
// new one, and both claim the same conversation.
describe("a start that refuses says which refusal it was", () => {
  afterEach(() => resetDesktopBridge())

  async function startableBridge(): Promise<DesktopBridge> {
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    return bridge
  }

  /** A bridge with a folder the shell chose, which is what a start needs. */
  async function bridgeWithFolder(
    path: string,
  ): Promise<{ bridge: DesktopBridge; handle: string }> {
    const bridge = await startableBridge()
    pickFolderMock.mockResolvedValueOnce(path)
    const handle = (await bridge.pickFolder("a1")) as string
    return { bridge, handle }
  }

  beforeEach(() => {
    startOrder.length = 0
    startLocalSessionMock.mockClear()
    endLocalSessionMock.mockClear()
    // The file's own beforeEach replaces the implementation with a bare
    // resolve, and what a start does in which order is the whole point here.
    startLocalSessionMock.mockImplementation(async () => {
      startOrder.push("start")
      return {} as unknown
    })
  })

  it("the previous session is stopped BEFORE the next one claims the conversation", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    // The first start had nothing to stop. The second stops the live session
    // first: with the old order this read start, start, end, and the server
    // refused the second claim with a 409 because the first was still renewing.
    expect(startOrder).toEqual(["start", "end", "start"])
  })

  // P6d-FX7 (SK-2): the stop-first order P6d-FX5 introduced was unconditional,
  // so a start the server then REFUSED had already torn down the session that
  // was working, in a conversation the user never asked to leave.
  it("a refused start for another conversation leaves the live one running and claimed", async () => {
    const released: string[] = []
    const reclaimed: string[] = []
    startLocalSessionMock.mockImplementationOnce(async () => {
      startOrder.push("start")
      return {
        threadId: "t1",
        releaseClaim: async () => {
          released.push("t1")
        },
        reclaim: async () => {
          reclaimed.push("t1")
          return true
        },
        finish: async () => undefined,
      } as unknown
    })
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    startLocalSessionMock.mockRejectedValueOnce(new LocalSessionStartError("AuditRefused"))
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t2", folderId: handle }),
    ).resolves.toBe(false)
    // The first conversation's claim was let go of before the second was
    // asked for (the server must not answer two of them), and it was taken
    // back the moment the second was refused.
    expect(released).toEqual(["t1"])
    expect(reclaimed).toEqual(["t1"])
    // The session itself was never ended, and the window still says which
    // conversation it is answering. The refusal is said out loud anyway.
    expect(endLocalSessionMock).not.toHaveBeenCalled()
    expect(bridge.getState().sessionStatus).toBe("running")
    expect(bridge.getState().threadId).toBe("t1")
    expect(bridge.getState().startError).toBe("AuditRefused")
  })

  // P6d-FX7 (SK-5): the holder is the user AND the window, so one window
  // presents one key for its whole life. A key per claim made this window's
  // own release race its own next registration.
  it("every start presents the same holder key, so a restart cannot conflict with itself", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
    const keys = startLocalSessionMock.mock.calls.map(
      ([options]) => (options as { holderKey?: string }).holderKey,
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
  })

  // P6d-FX7 (SK-4): `starting` was raised before an unguarded stop, so a stop
  // that rejected left the flag true for the life of the window and every
  // later press answered AlreadyStarting about a start that never finished.
  it("a stop that fails does not wedge the Start button on AlreadyStarting", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    endLocalSessionMock.mockImplementationOnce(() => {
      throw new Error("the release never came back")
    })
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).not.toBe("AlreadyStarting")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    expect(bridge.getState().startError).toBeNull()
  })

  it("a start naming a path says PathNotAllowed", async () => {
    const bridge = await startableBridge()
    const asked = { agentId: "a1", threadId: "t1", folderPath: "/" } as unknown as Parameters<
      DesktopBridge["startSession"]
    >[0]
    await expect(bridge.startSession(asked)).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("PathNotAllowed")
    expect(bridge.getState().sessionStatus).toBe("idle")
  })

  it("a handle this shell never issued says UnknownFolder", async () => {
    const bridge = await startableBridge()
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: "folder-99" }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("UnknownFolder")
  })

  it("no folder chosen at all says NoFolderChosen", async () => {
    const bridge = await startableBridge()
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1" })).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("NoFolderChosen")
  })

  it("no conversation to answer in says NoConversation", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "", folderId: handle }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("NoConversation")
  })

  it("a window with no session token says NotSignedIn", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    // The wrapped app signed out, so there is nothing to audit or claim with.
    noteSessionToken(null)
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("NotSignedIn")
    expect(startLocalSessionMock).not.toHaveBeenCalled()
  })

  it("the step that refused on the server is the reason the page is given", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    startLocalSessionMock.mockRejectedValueOnce(new LocalSessionStartError("ConversationClaimed"))
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("ConversationClaimed")
    expect(bridge.getState().sessionStatus).toBe("idle")
  })

  // 2026-09-23: the refusal says WHOSE computer holds the conversation, and a
  // Take over the person pressed reaches the claim.
  it("a claimed conversation's refusal carries who holds it to the page", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    const holder = { sameUser: true, holderName: null, canTakeOver: true }
    startLocalSessionMock.mockRejectedValueOnce(
      new LocalSessionStartError("ConversationClaimed", new LocalClaimError(409, false, holder)),
    )
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
    expect(bridge.getState().startClaimHolder).toEqual(holder)
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle, takeOver: true })
    expect(startLocalSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({ takeOver: true })
    expect(bridge.getState().startClaimHolder).toBeNull()
  })

  it("the window's holder key names this install, so a relaunch can supersede its old lease", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
    const options = startLocalSessionMock.mock.calls[0]?.[0] as { holderKey?: string } | undefined
    const key = options?.holderKey
    expect(key).toMatch(/^d\.[0-9a-f]{32}\.[0-9a-f-]{36}$/)
  })

  it("the shell's own start_session variant is the reason the page is given", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    startLocalSessionMock.mockRejectedValueOnce(new StartSessionError("NotApproved"))
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("NotApproved")
  })

  it("anything else that threw is StartFailed, which is still a sentence", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    startLocalSessionMock.mockRejectedValueOnce(new Error("something the page cannot act on"))
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(false)
    expect(bridge.getState().startError).toBe("StartFailed")
  })

  // P6d-FX5 (W5), found by driving it: the shell dropped the code only on the
  // sidecar's `ready` line, which arrives after the first turn is SENT, so the
  // approval step stayed on screen over a session that was already running and
  // covered the composer the turn has to be typed into.
  it("a start that worked takes the device code with it", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    shell.setDeviceApproval("https://liaison.example/auth/device?code=D6KN465D")
    expect(bridge.getState().deviceApproval).not.toBeNull()
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    expect(bridge.getState().deviceApproval).toBeNull()
  })

  it("a start that worked leaves no refusal behind", async () => {
    const { bridge, handle } = await bridgeWithFolder("/Users/someone/code/one")
    startLocalSessionMock.mockRejectedValueOnce(new Error("boom"))
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle })
    expect(bridge.getState().startError).toBe("StartFailed")
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    expect(bridge.getState().startError).toBeNull()
  })

  // P6d-FX3 (W2) seeded one real folder into the shell's own recent list, and
  // that row is the route back to a session for a window that has picked
  // nothing. It has to start one, by the handle the shell issued for it.
  it("the seeded folder the shell remembers starts a session in that folder", async () => {
    const seeded = "/private/tmp/walk-folder2"
    const bridge = await startableBridge()
    recentFoldersMock.mockResolvedValue([seeded])
    await bridge.loadRecentFolders("a1")
    const offered = bridge.getState().recentFolders
    expect(offered).toEqual([{ id: expect.any(String), path: seeded, name: "walk-folder2" }])
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: offered[0].id }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(expect.objectContaining({ folder: seeded }))
    expect(bridge.getState().startError).toBeNull()
  })
})

// P6d-FX5 (W5): the shell's `clearDeviceApproval` existed and NOTHING called
// it, so a code that had been approved stayed on the state for the life of the
// window and was shown again on the next sign-out.
describe("giving up on the device code", () => {
  afterEach(() => resetDesktopBridge())

  it("takes the code off the state and puts the control back to idle", () => {
    const bridge = freshBridge()
    shell.setDeviceApproval("https://liaison.example/auth/device?code=QKVZMC5G")
    setDesktopSessionState({ sessionStatus: "starting" })
    expect(bridge.getState().deviceApproval).toBe(
      "https://liaison.example/auth/device?code=QKVZMC5G",
    )

    bridge.clearDeviceApproval()

    expect(bridge.getState().deviceApproval).toBeNull()
    expect(bridge.getState().sessionStatus).toBe("idle")
  })
})

// P4c-E1: THE COLD DECISION IS THE SERVER'S, AND IT HAS TO REACH THE SDK.
//
// The rule (more than the warm window since this agent's last turn) is measured
// over rows only the server can see, and it already decides what context the
// server assembles. A shell that resumes its old SDK conversation on such a turn
// hands the model the raw transcript the server just stopped feeding: two
// contexts for one rule. So the shell asks, and passes the answer on.
describe("the cold decision reaches the local session", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch)
    resetDesktopBridge()
  })

  /** The cold assembly the server hands back, in the route's own shape. */
  const COLD_BODY = {
    coldResume: true,
    checkpoint: { summary: "The Lyon shipment was split into two cartons." },
    tail: [
      {
        id: "m1",
        authorType: "user",
        authorName: "Alice Chen",
        createdAt: "2026-09-15T09:00:00.000Z",
        content: "Did the second carton ever leave?",
        toolNames: [],
      },
    ],
    recall: null,
    resumeLine: "Resumed after 3 hours. Earlier messages are summarized above;",
  }

  /** Starts one session against a server that answers `coldResume` as given. */
  async function startAgainstServerSaying(
    coldResume: boolean,
    warm: Record<string, unknown> = { coldResume: false },
  ): Promise<void> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("/turn-context")
          ? {
              ok: true,
              json: async () => ({ data: coldResume ? COLD_BODY : warm }),
            }
          : { ok: true, json: async () => ({ data: null }) },
      ),
    )
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const handle = (await bridge.pickFolder("a1")) as string
    startLocalSessionMock.mockClear()
    startLocalSessionMock.mockResolvedValue({})
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
  }

  it("a cold claim starts a new SDK session, a warm one resumes", async () => {
    await startAgainstServerSaying(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ coldResume: true }),
    )
    // P4c-T26b: and it is handed the context that session runs with, from the
    // SAME read. Two reads would be two decisions about one turn, the second of
    // them running after the first one's checkpoint advance.
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        coldContext: expect.objectContaining({
          checkpoint: { summary: "The Lyon shipment was split into two cartons." },
        }),
      }),
    )

    await startAgainstServerSaying(false)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ coldResume: false }),
    )
  })

  // 2026-09-23: the start asks who wrote the conversation's last agent turn,
  // in the same read, and hands the answer to the resume decision.
  it("asks who answered last and hands it to the session start", async () => {
    await startAgainstServerSaying(false, {
      coldResume: false,
      lastAgentTurn: { runLocation: "cloud", sdkSessionId: null },
    })
    const fetched = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(fetched.some(([url]) => String(url).includes("turn-context?continuity=1"))).toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ lastAgentTurn: { runLocation: "cloud", sdkSessionId: null } }),
    )
  })

  it("an older server's bare answer leaves the resume decision as it was", async () => {
    await startAgainstServerSaying(false)
    const options = startLocalSessionMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(options).not.toHaveProperty("lastAgentTurn")
  })

  // A server that is older, unreachable or refusing leaves the session doing
  // what this shell has always done. Dropping a session's context is not the
  // safe direction to fail in.
  it("a server that cannot answer leaves the session resuming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no route to host")
      }),
    )
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const handle = (await bridge.pickFolder("a1")) as string
    startLocalSessionMock.mockClear()
    startLocalSessionMock.mockResolvedValue({})
    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)
    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ coldResume: false }),
    )
  })

  // P4c-T26b. The failure that matters is not the unreachable server, it is the
  // one that answers. A start that took the refusal as "cold" would begin a
  // FRESH SDK session with no checkpoint and no tail: the agent starts from
  // nothing, in the middle of a conversation it is supposed to be picking up.
  // Losing context is worse than carrying a stale one, so this resumes.
  it("a cold fetch failure resumes the existing session instead of starting empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).endsWith("/turn-context")
          ? { ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) }
          : { ok: true, json: async () => ({ data: null }) },
      ),
    )
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const handle = (await bridge.pickFolder("a1")) as string
    startLocalSessionMock.mockClear()
    startLocalSessionMock.mockResolvedValue({})

    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)

    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ coldResume: false, coldContext: null }),
    )
  })

  // The T26 server: it knows the turn is cold and has nothing to hand over.
  // Same answer, for the same reason.
  it("a cold answer with no context resumes rather than starting empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).endsWith("/turn-context")
          ? { ok: true, json: async () => ({ data: { coldResume: true } }) }
          : { ok: true, json: async () => ({ data: null }) },
      ),
    )
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const handle = (await bridge.pickFolder("a1")) as string
    startLocalSessionMock.mockClear()
    startLocalSessionMock.mockResolvedValue({})

    await expect(
      bridge.startSession({ agentId: "a1", threadId: "t1", folderId: handle }),
    ).resolves.toBe(true)

    expect(startLocalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ coldResume: false, coldContext: null }),
    )
  })
})

// A SIDECAR THAT DIES IS NEVER SILENT (2026-09-23). A stale sidecar refused
// `--permission-mode auto` and exited; the window sent the turn anyway, waited
// for a reply that was never coming, showed nothing, and the claim heartbeat
// kept the server away from the conversation.
describe("a sidecar that dies under a local turn", () => {
  afterEach(() => resetDesktopBridge())

  const exitReport = {
    type: "sidecar_exited",
    code: 2,
    signal: null,
    booted: true,
    reason: "unknown permission mode: auto",
    stderrTail: ["unknown permission mode: auto"],
  }

  /** A running session for t1 whose handle records its own end. */
  async function runningSession(): Promise<{ bridge: DesktopBridge; finished: () => number }> {
    let finishes = 0
    startLocalSessionMock.mockImplementationOnce(
      async () =>
        ({
          ...fakeHandle(),
          finish: async () => {
            finishes += 1
          },
        }) as unknown,
    )
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const folderId = (await bridge.pickFolder("a1")) as string
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1", folderId })).resolves.toBe(
      true,
    )
    return { bridge, finished: () => finishes }
  }

  beforeEach(() => {
    startTurnMock.mockReset()
    startTurnMock.mockResolvedValue(undefined)
    serverMessage.current = {
      id: "m1",
      threadId: "t1",
      authorKind: "user",
      text: "@[Liaison](agent:a1) fix the build",
    }
  })

  it("ends the turn, names the failure on the conversation and releases the claim", async () => {
    const { bridge, finished } = await runningSession()
    const turn = bridge.sendTurn("m1")
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledWith("fix the build"))
    emitTurnEvent(exitReport)
    // The turn settles instead of waiting for ever on a line nobody sends.
    await turn
    const state = bridge.getState()
    expect(state.turnFailure).toEqual({
      threadId: "t1",
      agentId: "a1",
      messageId: "m1",
      reason: "unknown permission mode: auto",
      kind: "stopped",
    })
    expect(state.turnActive).toBe(false)
    expect(state.sessionStatus).toBe("stopped")
    // Finishing the handle is what releases the claim and closes the trail.
    expect(finished()).toBe(1)
  })

  it("a prompt the sidecar never received is a failed turn, not a silent one", async () => {
    const { bridge } = await runningSession()
    startTurnMock.mockRejectedValueOnce("the sidecar is not running")
    await bridge.sendTurn("m1")
    expect(bridge.getState().turnFailure).toEqual({
      threadId: "t1",
      agentId: "a1",
      messageId: "m1",
      reason: "the sidecar is not running",
      kind: "stopped",
    })
    expect(bridge.getState().turnActive).toBe(false)
  })

  // 2026-09-23, production: the answer of a finished turn was refused by the
  // server and nothing on screen said so. It is said, as an answer that exists
  // and is kept, and once one does land the window's own rows go: the message
  // now carries them, and drawn twice one turn reads as two.
  it("an answer the server refuses is drawn as undelivered, with the reason", async () => {
    replyRetry.delaysMs = [0]
    const { bridge } = await runningSession()
    const real = globalThis.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/reply")
          ? new Response(JSON.stringify({ error: { message: "another machine" } }), {
              status: 403,
              headers: { "content-type": "application/json" },
            })
          : real(input, init),
      ),
    )
    try {
      const turn = bridge.sendTurn("m1")
      await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalled())
      emitTurnEvent({
        type: "message",
        event: "result",
        payload: { type: "result", subtype: "success", result: "GREEN" },
      })
      emitTurnEvent({ type: "turn_done" })
      await turn
      expect(bridge.getState().turnFailure).toMatchObject({
        threadId: "t1",
        messageId: "m1",
        kind: "undelivered",
      })
      expect(bridge.getState().turnFailure?.reason).toContain("403")
    } finally {
      vi.stubGlobal("fetch", real)
      localStorage.clear()
    }
  })

  it("an answer that lands takes the window's own rows down", async () => {
    const { bridge } = await runningSession()
    const turn = bridge.sendTurn("m1")
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalled())
    emitTurnEvent({
      type: "message",
      event: "tool_use",
      payload: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
      },
    })
    emitTurnEvent({
      type: "message",
      event: "tool_result",
      payload: {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      },
    })
    expect(bridge.getState().toolActivity).toHaveLength(1)
    emitTurnEvent({
      type: "message",
      event: "result",
      payload: { type: "result", subtype: "success", result: "Done." },
    })
    emitTurnEvent({ type: "turn_done" })
    await turn
    expect(bridge.getState().toolActivity).toHaveLength(0)
  })

  it("a session that starts again takes the failure down", async () => {
    const { bridge } = await runningSession()
    emitTurnEvent(exitReport)
    expect(bridge.getState().turnFailure?.messageId).toBeNull()
    startLocalSessionMock.mockResolvedValueOnce(fakeHandle())
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1" })).resolves.toBe(true)
    expect(bridge.getState().turnFailure).toBeNull()
  })

  it("a start the sidecar died on says what the sidecar said", async () => {
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const folderId = (await bridge.pickFolder("a1")) as string
    startLocalSessionMock.mockRejectedValueOnce(
      new StartSessionError("SidecarExited: unknown permission mode: auto"),
    )
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1", folderId })).resolves.toBe(
      false,
    )
    expect(bridge.getState().startError).toBe("SidecarExited")
    expect(bridge.getState().startErrorDetail).toBe("unknown permission mode: auto")
  })
})

// CLAUDE ON THIS COMPUTER IS NOT SIGNED IN (2026-09-24). A person who only ever
// used the Claude desktop app has no Claude Code login, and every local turn
// failed with "Failed to authenticate": the CLI's words were posted as the
// agent's reply and nothing in the app could fix it.
describe("a local turn with no Claude sign-in", () => {
  afterEach(() => {
    claudeStatusMock.mockReset()
    claudeStatusMock.mockResolvedValue(null)
    claudeLoginMock.mockReset()
    claudeCodeMock.mockReset()
    resetDesktopBridge()
  })

  async function signedInWindow(): Promise<{ bridge: DesktopBridge; folderId: string }> {
    const bridge = freshBridge()
    noteServerAddress("https://liaison.example")
    noteSessionToken("token")
    pickFolderMock.mockResolvedValueOnce("/Users/someone/code/one")
    const folderId = (await bridge.pickFolder("a1")) as string
    return { bridge, folderId }
  }

  it("a start is refused before anything runs, and the conversation is told to sign in", async () => {
    claudeStatusMock.mockResolvedValue({ loggedIn: false, email: null })
    const { bridge, folderId } = await signedInWindow()
    startLocalSessionMock.mockClear()
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1", folderId })).resolves.toBe(
      false,
    )
    expect(startLocalSessionMock).not.toHaveBeenCalled()
    const state = bridge.getState()
    expect(state.startError).toBe("ClaudeSignInRequired")
    expect(state.claudeSignInNeeded).toEqual({ threadId: "t1", agentId: "a1", messageId: null })
    expect(state.claudeAccount).toEqual({ loggedIn: false, email: null })
  })

  it("a signed in account is asked once and then trusted", async () => {
    claudeStatusMock.mockResolvedValue({ loggedIn: true, email: "someone@example.com" })
    const { bridge, folderId } = await signedInWindow()
    startLocalSessionMock.mockResolvedValue(fakeHandle())
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1", folderId })).resolves.toBe(
      true,
    )
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1" })).resolves.toBe(true)
    expect(claudeStatusMock).toHaveBeenCalledTimes(1)
    // The shell may answer from what it read at launch: no second CLI run.
    expect(claudeStatusMock).toHaveBeenCalledWith({ fresh: false })
    expect(bridge.getState().claudeAccount).toEqual({
      loggedIn: true,
      email: "someone@example.com",
    })
  })

  it("a turn that cannot authenticate fails, ends the session and asks for a sign-in", async () => {
    let finishes = 0
    startLocalSessionMock.mockImplementationOnce(
      async () =>
        ({
          ...fakeHandle(),
          finish: async () => {
            finishes += 1
          },
        }) as unknown,
    )
    const { bridge, folderId } = await signedInWindow()
    await bridge.startSession({ agentId: "a1", threadId: "t1", folderId })
    serverMessage.current = { id: "m1", threadId: "t1", authorKind: "user", text: "fix the build" }
    startTurnMock.mockReset()
    startTurnMock.mockResolvedValue(undefined)
    const turn = bridge.sendTurn("m1")
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledWith("fix the build"))
    const words = "Failed to authenticate: OAuth session expired and could not be refreshed"
    emitTurnEvent({
      type: "message",
      event: "text",
      payload: {
        type: "assistant",
        error: "authentication_failed",
        message: { content: [{ type: "text", text: words }] },
      },
    })
    emitTurnEvent({
      type: "message",
      event: "result",
      payload: { type: "result", is_error: true, result: words },
    })
    emitTurnEvent({ type: "turn_done" })
    await turn
    const state = bridge.getState()
    expect(state.turnFailure).toEqual({
      threadId: "t1",
      agentId: "a1",
      messageId: "m1",
      reason: words,
      kind: "stopped",
    })
    expect(state.claudeSignInNeeded).toEqual({ threadId: "t1", agentId: "a1", messageId: "m1" })
    // The session's CLI read its credentials when it started: the Retry starts
    // a new one, which reads the new sign-in.
    await vi.waitFor(() => expect(bridge.getState().sessionStatus).toBe("stopped"))
    expect(finishes).toBe(0)
    expect(endLocalSessionMock).toHaveBeenCalled()

    // REVIEW OF 52fecfa8d, finding 3: the next start is refused UP FRONT, even
    // though the shell (and a CLI holding a dead token) still says signed in,
    // and the shell is told to drop its cached sign-in.
    expect(claudeFailureMock).toHaveBeenCalledTimes(1)
    claudeStatusMock.mockResolvedValue({ loggedIn: true, email: "someone@example.com" })
    startLocalSessionMock.mockClear()
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1" })).resolves.toBe(false)
    expect(startLocalSessionMock).not.toHaveBeenCalled()
    expect(bridge.getState().startError).toBe("ClaudeSignInRequired")

    // A sign-in that succeeds lets the next start through.
    applyClaudeAuthUpdate({
      phase: "signedIn",
      account: { loggedIn: true, email: "someone@example.com" },
    })
    startLocalSessionMock.mockResolvedValueOnce(fakeHandle())
    await expect(bridge.startSession({ agentId: "a1", threadId: "t1" })).resolves.toBe(true)
  })

  it("the sign-in's phases reach the state, and success clears the notice and the dialog", async () => {
    const bridge = freshBridge()
    setDesktopSessionState({
      claudeSignInNeeded: { threadId: "t1", agentId: "a1", messageId: "m1" },
    })
    await expect(bridge.startClaudeSignIn?.()).resolves.toBe(true)
    expect(claudeLoginMock).toHaveBeenCalledTimes(1)
    expect(bridge.getState().claudeSignIn).toEqual({ phase: "starting" })
    applyClaudeAuthUpdate({ phase: "waiting" })
    expect(bridge.getState().claudeSignIn).toEqual({ phase: "waiting" })
    await expect(bridge.submitClaudeSignInCode?.("  ")).resolves.toBe(false)
    await expect(bridge.submitClaudeSignInCode?.("abcd#efgh")).resolves.toBe(true)
    expect(claudeCodeMock).toHaveBeenCalledWith("abcd#efgh")
    expect(bridge.getState().claudeSignIn).toEqual({ phase: "checking" })
    applyClaudeAuthUpdate({
      phase: "signedIn",
      account: { loggedIn: true, email: "someone@example.com" },
    })
    const state = bridge.getState()
    expect(state.claudeSignIn).toBeNull()
    expect(state.claudeSignInNeeded).toBeNull()
    expect(state.claudeAccount).toEqual({ loggedIn: true, email: "someone@example.com" })
  })

  it("a cancel closes the dialog quietly, a failure says why", () => {
    freshBridge()
    applyClaudeAuthUpdate({ phase: "waiting" })
    applyClaudeAuthUpdate({ phase: "failed", reason: "cancelled" })
    expect(freshBridge().getState().claudeSignIn ?? null).toBeNull()
    const bridge = freshBridge()
    applyClaudeAuthUpdate({ phase: "failed", reason: "timeout" })
    expect(bridge.getState().claudeSignIn).toEqual({
      phase: "failed",
      reason: "timeout",
      detail: null,
    })
  })

  it("a shell that refuses the sign-in says so in the dialog", async () => {
    claudeLoginMock.mockRejectedValueOnce(new Error("ClaudeSignInNotRunning"))
    const bridge = freshBridge()
    await expect(bridge.startClaudeSignIn?.()).resolves.toBe(false)
    expect(bridge.getState().claudeSignIn).toEqual({
      phase: "failed",
      reason: "ClaudeSignInNotRunning",
      detail: null,
    })
  })
})

// REVIEW OF 74b97cd63, finding 3: the page could sign the computer out of
// Claude (and the person's own Claude Code with it) with no confirmation. The
// page may only ASK: `signOutOfClaude` opens the shell's own native question
// (Settings is the only place it is offered, on every desktop OS), and
// the sign out runs in the shell on a yes, never from a page call.
describe("signing out of Claude", () => {
  afterEach(() => resetDesktopBridge())

  it("is only ever the shell's own question, never a sign out the page runs", async () => {
    const bridge = freshBridge()
    await bridge.signOutOfClaude?.()
    // The only thing the page reaches is the question.
    expect(claudeSignOutAskMock).toHaveBeenCalledTimes(1)
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const client = await import("./session/sidecar-client")
    expect(Object.keys(client)).not.toContain("claudeAuthLogout")
    const source = readFileSync(
      resolve(import.meta.dirname, "session", "sidecar-client.ts"),
      "utf8",
    )
    expect(source).not.toContain("claude_auth_logout")
    const asked = source.slice(source.indexOf("export async function confirmClaudeSignOut"))
    expect(asked.slice(0, asked.indexOf("\n}\n"))).toContain('invoke("confirm_claude_sign_out")')
  })
})

// P1-T40 (C1, L21, D42): the node tells the server its folders (with paths,
// on the capabilities route only), its models and its level pins.
describe("the node's capabilities", () => {
  const NODE = { nodeId: "node-1", credential: "lnn_cred", enabled: true }
  function publisherWith(overrides: Partial<Parameters<typeof createCapabilityPublisher>[0]> = {}) {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    )
    let models = [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }]
    const publisher = createCapabilityPublisher({
      serverAddress: () => "https://liaison.example/",
      accessToken: () => "session-token",
      node: async () => NODE,
      models: () => models,
      sharedFolders: async () => [
        { name: "code", path: "/Users/o/code", kind: "root", gitDefaultBranch: null },
        { name: "app", path: "/Users/o/code/app", kind: "repo", gitDefaultBranch: "main" },
      ],
      levelPins: async () => [
        { agentId: "11111111-2222-3333-4444-555555555555", level: "standard" },
      ],
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      ...overrides,
    })
    return {
      publisher,
      fetchMock,
      setModels: (next: typeof models) => {
        models = next
      },
    }
  }

  it("starting the runner publishes the folders, models and level pins once, and again when the model list changes or after a job start", async () => {
    const { publisher, fetchMock, setModels } = publisherWith()
    publisher.changed("k1")
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://liaison.example/api/nodes/node-1/capabilities")
    expect(init.method).toBe("PUT")
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer session-token")
    expect(headers["X-Node-Credential"]).toBe("lnn_cred")
    expect(JSON.parse(init.body as string)).toEqual({
      sharedFolders: [
        { name: "code", path: "/Users/o/code", kind: "root" },
        { name: "app", path: "/Users/o/code/app", kind: "repo", gitDefaultBranch: "main" },
      ],
      models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
      levelPins: [{ agentId: "11111111-2222-3333-4444-555555555555", level: "standard" }],
      importProtocol: 5,
    })
    // Nothing changed: nothing is sent.
    publisher.changed("k1")
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The model list changed.
    setModels([{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }])
    publisher.changed("k2")
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string).models,
    ).toEqual([{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }])
    // After a job start (a consumed confirmation may have moved a pin).
    await publisher.publishNow()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("a publish failure is retried on the next change, never blocks the runner", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    const { publisher } = publisherWith({
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
    })
    await expect(publisher.publishNow()).resolves.toBeUndefined()
    publisher.changed("k1")
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }) as never)
    publisher.changed("k1")
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }) as never)
    publisher.changed("k1")
    await flushAsync()
    publisher.changed("k1")
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("S25: a local model's efforts survive parseLocalModels and the capabilities body", async () => {
    const { publisher, fetchMock, setModels } = publisherWith()
    setModels([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high", "max"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ] as never)
    await publisher.publishNow()
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.models).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high", "max"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ])
  })

  it("W1-D6: the same model ids gaining reasoning levels change the key, so the publisher sends again", async () => {
    const { publisher, fetchMock, setModels } = publisherWith()
    const folders = [{ path: "/Users/o/code" }]
    const stale = [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }]
    const discovered = [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high"] },
    ] as never as typeof stale
    setModels(stale)
    publisher.changed(capabilityKeyOf(stale, folders))
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    setModels(discovered)
    publisher.changed(capabilityKeyOf(discovered, folders))
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string).models,
    ).toEqual([{ id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high"] }])
    // A relabel is published content too; an identical list is not a change.
    expect(capabilityKeyOf([{ ...stale[0], label: "Opus" }], folders)).not.toBe(
      capabilityKeyOf(stale, folders),
    )
    expect(capabilityKeyOf(discovered, folders)).toBe(capabilityKeyOf(discovered, folders))
  })

  it("publishes nothing off an enabled node", async () => {
    const { publisher, fetchMock } = publisherWith({
      node: async () => ({ ...NODE, enabled: false }),
    })
    await publisher.publishNow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// P2-T15 (L21): the owner chooses the shared roots in the desktop app; a
// change publishes the node's capabilities again.
// S52 (owner D13): "Open in VS Code" names the folder; the shell resolves it.
describe("S52: openFolderInEditor", () => {
  it("S52: the page names the folder and the shell opens it; an unknown folder name opens nothing", async () => {
    const invokeMock = vi.fn(
      async (_command: string, args?: Record<string, unknown>) => args?.name === "liaison-monorepo",
    )
    const editor = createFolderEditor({ invoke: invokeMock })
    expect(await editor.openFolderInEditor?.("liaison-monorepo")).toBe(true)
    expect(invokeMock).toHaveBeenLastCalledWith("open_folder_in_editor", {
      name: "liaison-monorepo",
    })
    expect(await editor.openFolderInEditor?.("not-shared")).toBe(false)
  })

  it("S52: a subfolder session passes its path relative to the shared folder; the shell resolves and confines it", async () => {
    const invokeMock = vi.fn(async () => true)
    const editor = createFolderEditor({ invoke: invokeMock })
    expect(await editor.openFolderInEditor?.("liaison-monorepo", "apps/web")).toBe(true)
    expect(invokeMock).toHaveBeenLastCalledWith("open_folder_in_editor", {
      name: "liaison-monorepo",
      relativePath: "apps/web",
    })
  })

  it("S52: an empty name asks nothing; a refusal reads as nothing opened", async () => {
    const invokeMock = vi.fn(async () => {
      throw "no application config directory"
    })
    const editor = createFolderEditor({ invoke: invokeMock })
    expect(await editor.openFolderInEditor?.("")).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(await editor.openFolderInEditor?.("app")).toBe(false)
  })
})

// D33 (batch-4 F3): "Stop it" names the CLI session id and the pid; the shell checks both.
describe("D33: stopOrphanClaude", () => {
  it("D33: the page's click invokes the shell with the CLI session id and the pid; a refusal stops nothing", async () => {
    const invokeMock = vi.fn(
      async (_command: string, args?: Record<string, unknown>) => args?.pid === 5093,
    )
    const stopper = createOrphanStopper({ invoke: invokeMock })
    const id = "41173e76-dc0a-4f5f-8c7a-fde5d5329047"
    expect(await stopper.stopOrphanClaude?.(id, 5093)).toBe(true)
    expect(invokeMock).toHaveBeenLastCalledWith("stop_orphan_claude", { sessionId: id, pid: 5093 })
    expect(await stopper.stopOrphanClaude?.(id, 6000)).toBe(false)
  })

  it("D33: no session id, pid 1 or below, or a shell error asks or stops nothing", async () => {
    const invokeMock = vi.fn(async () => {
      throw "no Claude config directory"
    })
    const stopper = createOrphanStopper({ invoke: invokeMock })
    expect(await stopper.stopOrphanClaude?.("", 5093)).toBe(false)
    expect(await stopper.stopOrphanClaude?.("41173e76-dc0a", 1)).toBe(false)
    expect(await stopper.stopOrphanClaude?.("41173e76-dc0a", 1.5)).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(await stopper.stopOrphanClaude?.("41173e76-dc0a", 5093)).toBe(false)
  })
})

describe("the node's shared roots", () => {
  it("setSharedRoots republishes capabilities", async () => {
    const invokeMock = vi.fn(async (command: string, _args?: Record<string, unknown>) =>
      command === "set_node_shared_roots"
        ? { roots: ["/Users/o/code"], isDefault: false }
        : { roots: ["/Users/o/recent"], isDefault: true },
    )
    const republish = vi.fn(async () => {})
    const roots = createSharedRoots({ invoke: invokeMock, republish })
    expect(await roots.sharedRoots?.()).toEqual({
      roots: ["/Users/o/recent"],
      isDefault: true,
      missing: [],
      refused: [],
      dropped: [],
      repos: [],
    })
    expect(republish).not.toHaveBeenCalled()
    expect(await roots.setSharedRoots?.(["/Users/o/code"])).toEqual({
      roots: ["/Users/o/code"],
      isDefault: false,
      missing: [],
      refused: [],
      dropped: [],
      repos: [],
    })
    expect(invokeMock).toHaveBeenLastCalledWith("set_node_shared_roots", {
      roots: ["/Users/o/code"],
    })
    expect(republish).toHaveBeenCalledTimes(1)
    // Back to the default sends null.
    await roots.setSharedRoots?.(null)
    expect(invokeMock).toHaveBeenLastCalledWith("set_node_shared_roots", { roots: null })
    expect(republish).toHaveBeenCalledTimes(2)
  })

  it("reads the roots missing on disk, and only roots", async () => {
    const invokeMock = vi.fn(async () => ({
      roots: ["/Users/o/gone", "/Users/o/code"],
      isDefault: true,
      missing: ["/Users/o/gone", "/elsewhere", 3],
    }))
    const roots = createSharedRoots({ invoke: invokeMock, republish: vi.fn(async () => {}) })
    expect((await roots.sharedRoots?.())?.missing).toEqual(["/Users/o/gone"])
  })

  it("reads which roots are repositories, and only listed roots", async () => {
    const invokeMock = vi.fn(async () => ({
      roots: ["/Users/o/app", "/Users/o/notes"],
      isDefault: false,
      repos: [
        { path: "/Users/o/app", defaultBranch: "main" },
        { path: "/elsewhere", defaultBranch: "dev" },
      ],
    }))
    const roots = createSharedRoots({ invoke: invokeMock, republish: vi.fn(async () => {}) })
    expect((await roots.sharedRoots?.())?.repos).toEqual([
      { path: "/Users/o/app", defaultBranch: "main" },
    ])
  })

  it("a refused root publishes nothing", async () => {
    const invokeMock = vi.fn(async () => {
      throw "SharedRootRefused"
    })
    const republish = vi.fn(async () => {})
    const roots = createSharedRoots({ invoke: invokeMock, republish })
    await expect(roots.setSharedRoots?.(["/"])).rejects.toBe("SharedRootRefused")
    expect(republish).not.toHaveBeenCalled()
  })
})

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("node session wake and reconnect (P3-T14)", () => {
  it("the bridge forwards wake and reconnect to the runner", async () => {
    const bridge = freshBridge()
    bridge.nodeJobOffered?.("job-1", "agent-1")
    bridge.startNodeJobs?.({ onReview: () => {} })
    expect(runnerMock.startup).toHaveBeenCalled()
    bridge.nodeSessionCommand?.("9f8e7d6c-5b4a-4321-8fed-cba987654321")
    expect(runnerMock.wake).toHaveBeenCalledWith("9f8e7d6c-5b4a-4321-8fed-cba987654321")
    bridge.nodeReconnected?.()
    expect(runnerMock.reconnected).toHaveBeenCalledTimes(1)
    bridge.nodeJobOffered?.("job-2", "agent-1")
    expect(runnerMock.offer).toHaveBeenCalledWith("job-2", "agent-1")
    // P3-T22: the owner's "Show full output" reaches the runner.
    bridge.nodeFullOutputRequested?.("9f8e7d6c-5b4a-4321-8fed-cba987654321", "toolu_01A")
    expect(runnerMock.fullOutput).toHaveBeenCalledWith(
      "9f8e7d6c-5b4a-4321-8fed-cba987654321",
      "toolu_01A",
    )
  })
})

// P1-walk D12: the node's calls renew the window's token through the page's
// own single flight refresh, never a refresh of their own.
describe("refreshWindowToken (D12)", () => {
  it("runs the page's forced refresh and answers whether a new token is in place", async () => {
    noteSessionToken("old-token")
    const ensureFreshToken = vi.fn(async () => {
      noteSessionToken("new-token")
    })
    expect(await refreshWindowToken({ ensureFreshToken })).toBe(true)
    expect(ensureFreshToken).toHaveBeenCalledWith({ force: true })
  })

  it("is false with no page refresh, a failed one, or the same token", async () => {
    noteSessionToken("old-token")
    expect(await refreshWindowToken(undefined)).toBe(false)
    expect(
      await refreshWindowToken({
        ensureFreshToken: async () => {
          throw new Error("refresh rejected")
        },
      }),
    ).toBe(false)
    expect(await refreshWindowToken({ ensureFreshToken: async () => {} })).toBe(false)
  })
})
