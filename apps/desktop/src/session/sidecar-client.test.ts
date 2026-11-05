// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

const invoke = vi.fn(
  async (_command: string, _args?: Record<string, unknown>) => undefined as unknown,
)
let emitLine: ((line: string) => void) | null = null
let emitReconnect: ((reason: string) => void) | null = null
let emitExit: ((payload: unknown) => void) | null = null
let emitUpdate: ((payload: unknown) => void) | null = null
const listen = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
  if (event === "sidecar-line") emitLine = (line) => handler({ payload: line })
  if (event === "sidecar-exited") emitExit = (payload) => handler({ payload })
  if (event === "liaison-update-progress") emitUpdate = (payload) => handler({ payload })
  if (event === "liaison-reconnect-required")
    emitReconnect = (reason) => handler({ payload: reason })
  return () => undefined
})

vi.mock("../tauri", () => ({ invoke, listen }))

/** A fresh module per test: the client keeps session state at module scope. */
async function freshClient() {
  vi.resetModules()
  invoke.mockClear()
  listen.mockClear()
  emitLine = null
  emitReconnect = null
  emitExit = null
  emitUpdate = null
  return await import("./sidecar-client")
}

/** Let the client's own `await ensureStream()` settle before emitting into it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("sidecar-client", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("startSession invokes the documented command name with the session shape", async () => {
    const client = await freshClient()
    await client.startSession({
      agentId: "a1",
      cwd: "/work",
      permissionMode: "manual",
      model: "claude-haiku-4-5",
      agentDefinition: "you are @support",
      agentKind: "role",
      accessToken: "user.session.jwt",
    })
    expect(invoke).toHaveBeenCalledWith("start_session", {
      agentId: "a1",
      cwd: "/work",
      permissionMode: "manual",
      model: "claude-haiku-4-5",
      resumeSessionId: null,
      agentDefinition: "you are @support",
      agentKind: "role",
      accessToken: "user.session.jwt",
    })
  })

  it("readLocalFile asks the shell for the file and answers with its bytes", async () => {
    const client = await freshClient()
    invoke.mockImplementationOnce(async () => ({ base64: "dGhlIHBsYW4=", mime: "text/markdown" }))
    const blob = await client.readLocalFile("/work/notes/plan.md")
    expect(invoke).toHaveBeenCalledWith("read_local_file", { path: "/work/notes/plan.md" })
    expect(blob.type).toBe("text/markdown")
    expect(await blob.text()).toBe("the plan")
  })

  it("readLocalFile lets the shell's refusal through rather than answering empty", async () => {
    const client = await freshClient()
    invoke.mockImplementationOnce(async () => {
      throw new Error("OutsideSessionFolder")
    })
    const failure = await client.readLocalFile("/etc/hosts").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(client.LocalFileError)
    expect((failure as { variant: string }).variant).toBe("OutsideSessionFolder")
  })

  it("gives every session its own readiness and health", async () => {
    const client = await freshClient()
    const start = {
      agentId: "a1",
      cwd: "/work",
      permissionMode: "manual" as const,
      model: "claude-haiku-4-5",
      agentDefinition: "you are @support",
      agentKind: "role" as const,
      accessToken: "user.session.jwt",
    }
    await client.startSession(start)
    await settle()
    emitLine?.('{"type":"ready","sidecarReadyMs":100,"systemPromptChecksum":"aa"}')
    expect((await client.getSidecarReadiness()).sidecarReadyMs).toBe(100)
    expect(client.health()).toBe("ready")
    emitLine?.('{"type":"done"}')
    expect(client.health()).toBe("disconnected")

    // The second session is a second cold start: reporting the first one's
    // readiness (and its checksum) would describe a process that is gone.
    await client.startSession(start)
    expect(client.health()).toBe("unknown")
    await settle()
    emitLine?.('{"type":"ready","sidecarReadyMs":900,"systemPromptChecksum":"bb"}')
    const second = await client.getSidecarReadiness()
    expect(second.sidecarReadyMs).toBe(900)
    expect(second.systemPromptChecksum).toBe("bb")
  })

  // P6d-FX7 (SK-7): the dialog's Cancel set a signal to null and nothing more,
  // so the pending device code stayed approvable for its whole window and a
  // user who cancelled could still complete the flow by following the link
  // they had already copied.
  it("giving up on the device code withdraws the grant on the server too", async () => {
    const client = await freshClient()
    client.clearDeviceApproval()
    expect(client.deviceApproval()).toBeNull()
    await settle()
    expect(invoke).toHaveBeenCalledWith("cancel_device_approval")
  })

  it("a shell with no such command still takes the dialog down", async () => {
    const client = await freshClient()
    invoke.mockImplementationOnce(async () => {
      throw new Error("Command cancel_device_approval not found")
    })
    client.clearDeviceApproval()
    expect(client.deviceApproval()).toBeNull()
    await expect(client.withdrawDeviceApproval()).resolves.toBe(false)
  })

  it("the shell's update progress is followed from the moment the events are armed", async () => {
    const client = await freshClient()
    await client.armShellEvents()
    expect(client.updateProgress()).toBeNull()
    emitUpdate?.({ version: "0.2.0", phase: "downloading", percent: null })
    expect(client.updateProgress()).toEqual({
      version: "0.2.0",
      phase: "downloading",
      percent: null,
    })
    emitUpdate?.({ version: "0.2.0", phase: "downloading", percent: 57 })
    expect(client.updateProgress()).toEqual({ version: "0.2.0", phase: "downloading", percent: 57 })
    emitUpdate?.({ version: "0.2.0", phase: "installing", percent: null })
    expect(client.updateProgress()?.phase).toBe("installing")
    // A failed install, or Smart App Control refusing it: the shell clears it.
    emitUpdate?.(null)
    expect(client.updateProgress()).toBeNull()
  })

  it("a malformed update payload draws nothing rather than a card with no version", () => {
    return freshClient().then((client) => {
      expect(client.updateProgressFrom({ phase: "downloading", percent: 3 })).toBeNull()
      expect(client.updateProgressFrom({ version: "0.2.0", phase: "done", percent: 3 })).toBeNull()
      expect(
        client.updateProgressFrom({ version: "0.2.0", phase: "downloading", percent: "3" }),
      ).toBeNull()
      expect(client.updateProgressFrom("0.2.0")).toBeNull()
      expect(
        client.updateProgressFrom({ version: "0.2.0", phase: "downloading", percent: 140 }),
      ).toEqual({
        version: "0.2.0",
        phase: "downloading",
        percent: 100,
      })
    })
  })

  it("startTurn invokes the documented command name", async () => {
    const client = await freshClient()
    await client.startTurn("hello")
    expect(invoke).toHaveBeenCalledWith("send_turn", { prompt: "hello" })
  })

  it("interrupt invokes the typed command, never a raw control line", async () => {
    const client = await freshClient()
    await client.interrupt()
    expect(invoke).toHaveBeenCalledWith("interrupt_turn")
    expect(invoke.mock.calls.map((call) => call[0])).not.toContain("send_control")
  })

  /**
   * The shell exposes no command that writes a line this module composed: a
   * free channel to the sidecar's stdin is a free channel to the agent for any
   * script in the page.
   */
  it("never invokes a generic control command for any of its control lines", async () => {
    const client = await freshClient()
    await client.interrupt()
    await client.respondToPermissionPrompt("perm-1", "allow")
    const pending = client.callMcpTool("liaison_approval_status", {})
    await settle()
    const id = JSON.parse(
      JSON.stringify(
        invoke.mock.calls.find((call) => call[0] === "call_mcp_tool")?.[1]?.requestId ?? null,
      ),
    )
    emitLine?.(JSON.stringify({ type: "mcp_result", requestId: id, result: null }))
    await pending
    expect(invoke.mock.calls.map((call) => call[0]).sort()).toEqual([
      "call_mcp_tool",
      "interrupt_turn",
      "respond_permission",
    ])
  })

  it("onTurnEvent subscribes to the documented event name", async () => {
    const client = await freshClient()
    client.onTurnEvent(() => undefined)
    await settle()
    expect(listen.mock.calls.map((call) => call[0])).toContain("sidecar-line")
  })

  it("onTurnEvent parses one protocol line and dispatches it by type", async () => {
    const client = await freshClient()
    const seen: unknown[] = []
    client.onTurnEvent((event) => seen.push(event))
    await settle()
    emitLine?.('{"type":"turn_done"}')
    emitLine?.("not json at all")
    expect(seen).toEqual([{ type: "turn_done" }])
  })

  it("onPermissionPrompt only sees permission_request lines", async () => {
    const client = await freshClient()
    const seen: unknown[] = []
    client.onPermissionPrompt((prompt) => seen.push(prompt))
    await settle()
    emitLine?.('{"type":"turn_done"}')
    emitLine?.(
      '{"type":"permission_request","requestId":"perm-1","toolName":"Bash","input":{"a":1}}',
    )
    expect(seen).toEqual([
      { type: "permission_request", requestId: "perm-1", toolName: "Bash", input: { a: 1 } },
    ])
  })

  it("respondToPermissionPrompt invokes the checked command with the id and the behavior", async () => {
    const client = await freshClient()
    await client.respondToPermissionPrompt("perm-1", "allow")
    expect(invoke).toHaveBeenCalledWith("respond_permission", {
      requestId: "perm-1",
      behavior: "allow",
      message: null,
    })
    await client.respondToPermissionPrompt("perm-2", "deny", "not this time")
    expect(invoke).toHaveBeenCalledWith("respond_permission", {
      requestId: "perm-2",
      behavior: "deny",
      message: "not this time",
    })
  })

  /** D11: the shell answers the decision it wrote, which for a shell command
   *  is the one its own dialog gave. */
  it("respondToPermissionPrompt answers what the shell wrote, not what was asked", async () => {
    const client = await freshClient()
    invoke.mockImplementationOnce(async () => "deny")
    await expect(client.respondToPermissionPrompt("perm-1", "allow")).resolves.toBe("deny")
    invoke.mockImplementationOnce(async () => "allow")
    await expect(client.respondToPermissionPrompt("perm-2", "allow")).resolves.toBe("allow")
  })

  /**
   * The shell answers a replayed or forged id with `UnknownPermissionRequest`,
   * and the refusal has to reach the caller rather than being swallowed into a
   * prompt that looks answered.
   */
  it("lets the shell refuse a permission answer it did not ask for", async () => {
    const client = await freshClient()
    invoke.mockImplementationOnce(async () => {
      throw "UnknownPermissionRequest"
    })
    const failure = await client
      .respondToPermissionPrompt("perm-forged", "allow")
      .catch((error: unknown) => error)
    expect(String(failure)).toContain("UnknownPermissionRequest")
  })

  it("getSidecarReadiness resolves on the ready line", async () => {
    const client = await freshClient()
    const readiness = client.getSidecarReadiness()
    await settle()
    emitLine?.('{"type":"ready","sidecarReadyMs":1234,"systemPromptChecksum":"abc"}')
    await expect(readiness).resolves.toEqual({ sidecarReadyMs: 1234, systemPromptChecksum: "abc" })
  })

  it("health flips to disconnected on a reconnect required event", async () => {
    const client = await freshClient()
    client.onTurnEvent(() => undefined)
    await settle()
    expect(client.health()).not.toBe("disconnected")
    emitReconnect?.("TokenRefreshFailed")
    expect(client.health()).toBe("disconnected")
  })

  it("remembers WHY the shell asked for a reconnect", async () => {
    const client = await freshClient()
    void client.getSidecarReadiness()
    await settle()
    expect(client.reconnectReason()).toBeNull()
    emitReconnect?.("TokenRefreshFailed")
    expect(client.reconnectReason()).toBe("TokenRefreshFailed")
  })

  it("clears the reconnect reason when a session starts again", async () => {
    const client = await freshClient()
    void client.getSidecarReadiness()
    await settle()
    emitReconnect?.("SidecarSpawnFailed")
    expect(client.reconnectReason()).toBe("SidecarSpawnFailed")
    await client.startSession({
      agentId: "a1",
      cwd: "/work",
      permissionMode: "manual",
      model: "claude-haiku-4-5",
      agentDefinition: "you are @support",
      agentKind: "role",
      accessToken: "user.session.jwt",
    })
    expect(client.reconnectReason()).toBeNull()
    expect(client.health()).not.toBe("disconnected")
  })

  it("health flips to disconnected on an error line", async () => {
    const client = await freshClient()
    client.onTurnEvent(() => undefined)
    await settle()
    emitLine?.('{"type":"error","message":"boom"}')
    expect(client.health()).toBe("disconnected")
  })

  it("callMcpTool relays the tool name and args over the documented IPC command", async () => {
    const client = await freshClient()
    const pending = client.callMcpTool("liaison_approval_status", { turnId: "t1" })
    await settle()
    const call = invoke.mock.calls.find((entry) => entry[0] === "call_mcp_tool")
    expect(call).toBeDefined()
    const sent = call?.[1] as { tool: string; args: unknown; requestId: string }
    expect(sent.tool).toBe("liaison_approval_status")
    expect(sent.args).toEqual({ turnId: "t1" })
    expect(typeof sent.requestId).toBe("string")
    // Settle it, so the call's own 30 second deadline does not outlive the test.
    emitLine?.(JSON.stringify({ type: "mcp_result", requestId: sent.requestId, result: null }))
    await expect(pending).resolves.toBeNull()
  })

  it("callMcpTool resolves only the call whose requestId matches", async () => {
    const client = await freshClient()
    const first = client.callMcpTool("tool_a", {})
    await settle()
    const second = client.callMcpTool("tool_b", {})
    await settle()
    const ids = invoke.mock.calls
      .filter((entry) => entry[0] === "call_mcp_tool")
      .map((entry) => (entry as unknown as [string, { requestId: string }])[1].requestId)
    expect(ids[0]).not.toBe(ids[1])
    emitLine?.(JSON.stringify({ type: "mcp_result", requestId: ids[1], result: { ok: "second" } }))
    await expect(second).resolves.toEqual({ ok: "second" })
    emitLine?.(JSON.stringify({ type: "mcp_result", requestId: ids[0], result: { ok: "first" } }))
    await expect(first).resolves.toEqual({ ok: "first" })
  })

  it("callMcpTool rejects when the relay answers with an error", async () => {
    const client = await freshClient()
    const pending = client.callMcpTool("tool_a", {})
    await settle()
    const relayed = invoke.mock.calls.find((entry) => entry[0] === "call_mcp_tool")
    expect(relayed).toBeDefined()
    const id = ((relayed ?? [])[1] as { requestId: string }).requestId
    emitLine?.(JSON.stringify({ type: "mcp_result", requestId: id, error: { message: "nope" } }))
    await expect(pending).rejects.toThrow("nope")
  })

  it("callMcpTool rejects after the 30 second timeout when no result arrives", async () => {
    const client = await freshClient()
    vi.useFakeTimers()
    const failure = client.callMcpTool("tool_a", {}).then(
      () => null,
      (error: Error) => error,
    )
    await vi.advanceTimersByTimeAsync(client.MCP_CALL_TIMEOUT_MS + 1)
    expect((await failure)?.message).toContain("tool_a")
  })
})

describe("the shell's refusals, as the window renders them", () => {
  // The suite above leaves fake timers installed for the MCP deadline test.
  beforeEach(() => {
    vi.useRealTimers()
  })

  const START = {
    agentId: "a1",
    cwd: "/work",
    permissionMode: "manual" as const,
    model: "claude-haiku-4-5",
    agentDefinition: "you are @support",
    agentKind: "role" as const,
    accessToken: "user.session.jwt",
  }

  /**
   * Every variant the shell answers with reaches the window as a TYPED error
   * carrying copy somebody can act on. An unmapped variant would surface a
   * Rust identifier in a banner, which is the failure this maps away.
   */
  it("maps every start refusal onto its own copy", async () => {
    const client = await freshClient()
    const copy = await import("./desktop-copy")
    const expected: Array<[string, string]> = [
      ["UnknownPermissionMode", copy.START_ERROR_UNKNOWN_PERMISSION_MODE],
      ["CwdNotADirectory", copy.START_ERROR_CWD_NOT_A_DIRECTORY],
      ["BypassDeclined", copy.START_ERROR_BYPASS_DECLINED],
      ["ModeDeclined", copy.START_ERROR_MODE_DECLINED],
      ["TokenRefreshFailed", copy.BANNER_RECONNECT_REQUIRED],
      ["ConfigUnwritable", copy.BANNER_RECONNECT_REQUIRED],
      ["SidecarSpawnFailed", copy.BANNER_RECONNECT_REQUIRED],
      ["NotApproved", copy.BANNER_RECONNECT_REQUIRED],
    ]
    for (const [variant, message] of expected) {
      invoke.mockImplementationOnce(async () => {
        throw variant
      })
      const failure = await client.startSession(START).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(client.StartSessionError)
      expect((failure as InstanceType<typeof client.StartSessionError>).variant).toBe(variant)
      expect((failure as Error).message).toBe(message)
    }
  })

  it("maps every read refusal onto its own copy", async () => {
    const client = await freshClient()
    const copy = await import("./desktop-copy")
    const expected: Array<[string, string]> = [
      ["NoSession", copy.FILE_ERROR_NO_SESSION],
      ["OutsideSessionFolder", copy.FILE_ERROR_OUTSIDE_SESSION_FOLDER],
      ["TooLarge", copy.FILE_ERROR_TOO_LARGE],
    ]
    for (const [variant, message] of expected) {
      invoke.mockImplementationOnce(async () => {
        throw new Error(variant)
      })
      const failure = await client.readLocalFile("/etc/hosts").catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(client.LocalFileError)
      expect((failure as InstanceType<typeof client.LocalFileError>).variant).toBe(variant)
      expect((failure as Error).message).toBe(message)
    }
  })

  it("keeps a refusal it does not recognise readable rather than blank", async () => {
    const client = await freshClient()
    const copy = await import("./desktop-copy")
    invoke.mockImplementationOnce(async () => {
      throw "SomethingNewFromTheShell"
    })
    const failure = (await client
      .startSession(START)
      .catch((error: unknown) => error)) as InstanceType<typeof client.StartSessionError>
    expect(failure.variant).toBe("SomethingNewFromTheShell")
    expect(failure.message).toBe(copy.START_ERROR_UNKNOWN)
  })

  it("does not clear the reconnect banner when the start was refused", async () => {
    const client = await freshClient()
    void client.getSidecarReadiness()
    await settle()
    emitReconnect?.("TokenRefreshFailed")
    invoke.mockImplementationOnce(async () => {
      throw "CwdNotADirectory"
    })
    await client.startSession(START).catch(() => undefined)
    expect(client.reconnectReason()).toBe("TokenRefreshFailed")
  })
})

describe("openOAuthUrl", () => {
  it("asks the shell to open the URL in the system browser", async () => {
    const client = await freshClient()
    const url = "https://liaison.example/api/auth/oauth/google/authorize?client=desktop"
    expect(await client.openOAuthUrl(url)).toBe(true)
    expect(invoke).toHaveBeenCalledWith("open_oauth_url", { url })
  })

  it("answers false when the shell refuses", async () => {
    const client = await freshClient()
    invoke.mockRejectedValueOnce("not this server's desktop sign-in route")
    expect(await client.openOAuthUrl("file:///etc/passwd")).toBe(false)
  })
})

describe("openLocalPath", () => {
  it("asks the shell to open the path as the message wrote it", async () => {
    const client = await freshClient()
    invoke.mockResolvedValueOnce("opened")
    const path = "C:\\Users\\someone\\Hub X\\report.pdf"
    expect(await client.openLocalPath(path)).toBe("opened")
    expect(invoke).toHaveBeenCalledWith("open_local_path", { path })
  })

  it("says when the shell revealed a program rather than running it", async () => {
    const client = await freshClient()
    invoke.mockResolvedValueOnce("revealed")
    expect(await client.openLocalPath("/Users/someone/setup.sh")).toBe("revealed")
  })

  it("tells a path that is not on this computer apart from a refusal", async () => {
    const client = await freshClient()
    invoke.mockRejectedValueOnce("NotFound")
    expect(await client.openLocalPath("/Users/someone/missing.pdf")).toBe("not_found")
    invoke.mockRejectedValueOnce("PathRefused")
    expect(await client.openLocalPath("relative.pdf")).toBe("failed")
  })

  it("says the shell refused a network path without touching it", async () => {
    const client = await freshClient()
    invoke.mockRejectedValueOnce("NetworkPath")
    expect(await client.openLocalPath("//fileserver/team/report.pdf")).toBe("network")
  })
})

describe("openDownloadedFile", () => {
  it("sends the bytes as the raw body and the name percent encoded in a header", async () => {
    const client = await freshClient()
    invoke.mockResolvedValueOnce("opened")
    const bytes = new TextEncoder().encode("%PDF-1.7")
    expect(await client.openDownloadedFile(bytes, "Facture F-12 e.pdf")).toBe(true)
    expect(invoke).toHaveBeenCalledWith("open_downloaded_file", bytes, {
      headers: { "x-liaison-file-name": "Facture%20F-12%20e.pdf" },
    })
  })

  it("answers false when the shell refused the file", async () => {
    const client = await freshClient()
    invoke.mockRejectedValueOnce("DownloadRefused")
    expect(await client.openDownloadedFile(new Uint8Array([1]), "tool.exe")).toBe(false)
  })
})

describe("verifyFirstPartyApp", () => {
  it("asks the shell to verify name@version and answers its URL and signed manifest", async () => {
    const client = await freshClient()
    const answer = {
      url: `liaison-app://localhost/${"a".repeat(64)}.js`,
      sha256: "a".repeat(64),
      manifest: { name: "boxtal", version: "1.2.0" },
    }
    invoke.mockResolvedValueOnce(answer)
    expect(await client.verifyFirstPartyApp("boxtal", "1.2.0")).toEqual(answer)
    expect(invoke).toHaveBeenCalledWith("verify_first_party_app", {
      name: "boxtal",
      version: "1.2.0",
    })
  })

  it("answers null on a refusal or a malformed answer, so the page frames the app", async () => {
    const client = await freshClient()
    invoke.mockRejectedValueOnce("unknown_key")
    expect(await client.verifyFirstPartyApp("boxtal", "1.2.0")).toBeNull()
    invoke.mockResolvedValueOnce({ url: 7 })
    expect(await client.verifyFirstPartyApp("boxtal", "1.2.0")).toBeNull()
  })
})

// A SIDECAR THAT DIES IS NEVER SILENT (2026-09-23).
describe("a sidecar that died", () => {
  it("a start it died on carries what it said beyond the refusal's code", async () => {
    const client = await freshClient()
    invoke.mockImplementationOnce(async () => {
      throw "SidecarExited: unknown permission mode: auto"
    })
    const refused = await client
      .startSession({
        agentId: "a1",
        cwd: "/work",
        permissionMode: "auto",
        model: "claude-haiku-4-5",
        agentDefinition: "d",
        agentKind: "personal",
        accessToken: "user.session.jwt",
      })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(client.StartSessionError)
    const error = refused as InstanceType<typeof client.StartSessionError>
    expect(error.variant).toBe("SidecarExited")
    expect(error.detail).toBe("unknown permission mode: auto")
    expect(error.message).toBe("The assistant on this computer stopped before it started.")
  })

  it("a refusal with no words of its own is read exactly as before", async () => {
    const client = await freshClient()
    expect(client.splitRefusal("CwdNotADirectory")).toEqual({
      variant: "CwdNotADirectory",
      detail: null,
    })
    // A sentence with a colon in it is not a variant.
    expect(client.splitRefusal("the sidecar is not running: it exited")).toEqual({
      variant: "the sidecar is not running: it exited",
      detail: null,
    })
  })

  it("an exit the shell reports reaches every turn listener and the health", async () => {
    const client = await freshClient()
    const seen: Array<Record<string, unknown>> = []
    client.onTurnEvent((event) => seen.push(event))
    await client.armShellEvents()
    await settle()
    emitExit?.({
      code: 2,
      signal: null,
      booted: true,
      reason: "unknown permission mode: auto",
      stderrTail: ["unknown permission mode: auto", "usage: liaison-sidecar"],
    })
    expect(seen).toEqual([
      {
        type: "sidecar_exited",
        code: 2,
        signal: null,
        booted: true,
        reason: "unknown permission mode: auto",
        stderrTail: ["unknown permission mode: auto", "usage: liaison-sidecar"],
      },
    ])
    expect(client.health()).toBe("disconnected")
  })

  it("an exit with nothing to say still says it exited", async () => {
    const client = await freshClient()
    expect(client.exitReportFrom({ code: null, signal: 9 })?.reason).toBe("it exited")
    expect(client.exitReportFrom("not an exit")).toBeNull()
  })
})
