// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-D T4 (S19): "Use this computer as my node". The checklist state
// machine (Claude sign-in, notifications, launch at login, keep awake), what
// each item reads from the shell and what its fix asks, and the enable /
// turn-off flows against the node routes (mocked: N-S T1 builds them).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { DesktopBridge, DesktopNodeRecord } from "~/lib/desktop-shell-contract"
import { NodeSessionTestAccess, nodeCredentialForHello, onNodeSessionChange } from "./node-session"
import {
  CHECKLIST,
  checklistComplete,
  fixChecklistItem,
  initialNodeSetup,
  type NodeSetupState,
  nodeSetupReducer,
  readChecklistItem,
  registerNode,
  turnOffNode,
} from "./node-setup"

function run(state: NodeSetupState, ...events: Parameters<typeof nodeSetupReducer>[1][]) {
  return events.reduce(nodeSetupReducer, state)
}

describe("the checklist state machine", () => {
  it("starts loading, then shows the switch as the shell left it", () => {
    expect(initialNodeSetup().phase).toBe("loading")
    expect(run(initialNodeSetup(), { type: "loaded", enabled: false }).phase).toBe("off")
    expect(run(initialNodeSetup(), { type: "loaded", enabled: true }).phase).toBe("on")
  })

  it("checks every item when turned on, and registers once all four pass", () => {
    let s = run(initialNodeSetup(), { type: "loaded", enabled: false }, { type: "turnOn" })
    expect(s.phase).toBe("checking")
    expect(CHECKLIST.every((item) => s.items[item] === "checking")).toBe(true)
    s = run(
      s,
      { type: "checked", item: "claude", state: "done" },
      { type: "checked", item: "notifications", state: "done" },
      { type: "checked", item: "launchAtLogin", state: "done" },
    )
    expect(s.phase).toBe("checking")
    s = run(s, { type: "checked", item: "keepAwake", state: "done" })
    expect(s.phase).toBe("registering")
    expect(run(s, { type: "registered" }).phase).toBe("on")
  })

  it("stops on the checklist while an item is to do, and goes on once it is fixed", () => {
    let s = run(
      initialNodeSetup(),
      { type: "loaded", enabled: false },
      { type: "turnOn" },
      { type: "checked", item: "claude", state: "todo" },
      { type: "checked", item: "notifications", state: "done" },
      { type: "checked", item: "launchAtLogin", state: "todo" },
      { type: "checked", item: "keepAwake", state: "done" },
    )
    expect(s.phase).toBe("setup")
    s = run(s, { type: "checked", item: "claude", state: "done" })
    expect(s.phase).toBe("setup")
    s = run(s, { type: "checked", item: "launchAtLogin", state: "done" })
    expect(s.phase).toBe("registering")
  })

  it("lets an OS without keep awake through, and nothing else", () => {
    const items = {
      claude: "done",
      notifications: "done",
      launchAtLogin: "done",
      keepAwake: "unsupported",
    } as const
    expect(checklistComplete(items)).toBe(true)
    expect(checklistComplete({ ...items, notifications: "unsupported" })).toBe(false)
    expect(checklistComplete({ ...items, claude: "todo" })).toBe(false)
  })

  it("names a failed registration and turns the switch back off; turning off always works", () => {
    const failed = run(
      initialNodeSetup(),
      { type: "loaded", enabled: false },
      { type: "turnOn" },
      { type: "failed", error: "boom" },
    )
    expect(failed).toMatchObject({ phase: "error", error: "boom" })
    expect(run(failed, { type: "turnOn" })).toMatchObject({ phase: "checking", error: null })
    expect(
      run(initialNodeSetup(), { type: "loaded", enabled: true }, { type: "turnOff" }).phase,
    ).toBe("off")
  })

  it("keeps an item's live status while on, without re-registering", () => {
    const s = run(
      initialNodeSetup(),
      { type: "loaded", enabled: true },
      { type: "checked", item: "keepAwake", state: "todo" },
    )
    expect(s.phase).toBe("on")
    expect(s.items.keepAwake).toBe("todo")
  })

  it("ignores a stray registered or turnOn in the wrong phase", () => {
    const off = run(initialNodeSetup(), { type: "loaded", enabled: false })
    expect(run(off, { type: "registered" }).phase).toBe("off")
    const on = run(initialNodeSetup(), { type: "loaded", enabled: true })
    expect(run(on, { type: "turnOn" }).phase).toBe("on")
  })
})

function shell(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    platform: "macos",
    checkClaudeAccount: vi.fn(async () => ({ loggedIn: true, email: "a@b.c" })),
    startClaudeSignIn: vi.fn(async () => true),
    notificationPermission: vi.fn(async () => "granted" as const),
    requestNotificationPermission: vi.fn(async () => "granted" as const),
    launchAtLogin: vi.fn(async () => true),
    setLaunchAtLogin: vi.fn(async (on: boolean) => on),
    keepAwake: vi.fn(async () => ({
      enabled: true,
      supported: true,
      nodeOn: false,
      power: "ac" as const,
      held: false,
    })),
    setKeepAwake: vi.fn(async (enabled: boolean) => ({
      enabled,
      supported: true,
      nodeOn: false,
      power: "ac" as const,
      held: false,
    })),
    storeNodeCredential: vi.fn(async () => undefined),
    loadNodeCredential: vi.fn(async () => null),
    ...overrides,
  } as unknown as DesktopBridge
}

describe("reading and fixing an item", () => {
  it("reads each item from the shell", async () => {
    const s = shell()
    for (const item of CHECKLIST) expect(await readChecklistItem(item, s)).toBe("done")
    const t = shell({
      checkClaudeAccount: async () => ({ loggedIn: false, email: null }),
      notificationPermission: async () => "default",
      launchAtLogin: async () => false,
      keepAwake: async () => ({
        enabled: false,
        supported: true,
        nodeOn: false,
        power: "ac",
        held: false,
      }),
    })
    for (const item of CHECKLIST) expect(await readChecklistItem(item, t)).toBe("todo")
    const linux = shell({
      keepAwake: async () => ({
        enabled: false,
        supported: false,
        nodeOn: false,
        power: "unknown",
        held: false,
      }),
    })
    expect(await readChecklistItem("keepAwake", linux)).toBe("unsupported")
  })

  it("treats a shell that cannot answer as to do, never as done", async () => {
    const s = shell({
      checkClaudeAccount: undefined,
      notificationPermission: async () => {
        throw new Error("x")
      },
      launchAtLogin: undefined,
      keepAwake: undefined,
    })
    expect(await readChecklistItem("claude", s)).toBe("todo")
    expect(await readChecklistItem("notifications", s)).toBe("todo")
    expect(await readChecklistItem("launchAtLogin", s)).toBe("todo")
    expect(await readChecklistItem("keepAwake", s)).toBe("unsupported")
  })

  it("fixes each item the one way the shell offers", async () => {
    const s = shell({ requestNotificationPermission: vi.fn(async () => "denied" as const) })
    expect(await fixChecklistItem("claude", s)).toBe("checking")
    expect(s.startClaudeSignIn).toHaveBeenCalled()
    expect(await fixChecklistItem("notifications", s)).toBe("todo")
    expect(await fixChecklistItem("launchAtLogin", s)).toBe("done")
    expect(s.setLaunchAtLogin).toHaveBeenCalledWith(true)
    expect(await fixChecklistItem("keepAwake", s)).toBe("done")
    expect(s.setKeepAwake).toHaveBeenCalledWith(true)
  })
})

function api() {
  return {
    post: vi.fn(async (_path: string, _body?: unknown) => ({
      node: {
        id: "n-new",
        name: "Mac",
        enabled: true,
        online: false,
        lastSeenAt: null,
        os: "macos",
        appVersion: null,
        deviceId: "d.1",
        queue: { queued: 0, running: 0 },
      },
      credential: "lnn_new",
    })),
    patch: vi.fn(async (_path: string, _body?: unknown) => ({})),
  }
}

describe("registering and turning off", () => {
  beforeEach(() => NodeSessionTestAccess.reset())

  it("binds a new node to this install's device id and hands the credential to the shell", async () => {
    const s = shell()
    const a = api()
    const changes: number[] = []
    const stop = onNodeSessionChange(() => changes.push(1))
    const record = await registerNode({
      api: a as never,
      shell: s,
      server: "https://a.example.com",
      deviceId: "d.1",
    })
    stop()
    expect(a.post).toHaveBeenCalledWith("/nodes", { deviceId: "d.1", os: "macos" })
    expect(record).toEqual({ nodeId: "n-new", credential: "lnn_new", enabled: true })
    expect(s.storeNodeCredential).toHaveBeenCalledWith("https://a.example.com", record)
    expect(nodeCredentialForHello()).toBe("lnn_new")
    expect(changes).toHaveLength(1)
  })

  it("turns a node it already holds back on with a PATCH, and falls back to enabling when the server forgot it", async () => {
    const held: DesktopNodeRecord = { nodeId: "n-old", credential: "lnn_old", enabled: false }
    const s = shell({ loadNodeCredential: async () => held })
    const a = api()
    const record = await registerNode({
      api: a as never,
      shell: s,
      server: "https://a.example.com",
      deviceId: "d.1",
    })
    expect(a.patch).toHaveBeenCalledWith("/nodes/n-old", { enabled: true })
    expect(a.post).not.toHaveBeenCalled()
    expect(record).toEqual({ ...held, enabled: true })

    const gone = api()
    gone.patch.mockImplementation(async () => {
      throw new ApiError("not found", 404)
    })
    const again = await registerNode({
      api: gone as never,
      shell: s,
      server: "https://a.example.com",
      deviceId: "d.1",
    })
    expect(gone.post).toHaveBeenCalled()
    expect(again.nodeId).toBe("n-new")
  })

  it("stores nothing when the server refuses", async () => {
    const s = shell()
    const a = api()
    a.post.mockImplementation(async () => {
      throw new ApiError("nope", 403)
    })
    await expect(
      registerNode({ api: a as never, shell: s, server: "https://a.example.com", deviceId: "d.1" }),
    ).rejects.toThrow()
    expect(s.storeNodeCredential).not.toHaveBeenCalled()
    expect(nodeCredentialForHello()).toBeNull()
  })

  it("turning off keeps the credential, presents nothing, and cancels nothing on the server", async () => {
    const held: DesktopNodeRecord = { nodeId: "n-old", credential: "lnn_old", enabled: true }
    const s = shell({ loadNodeCredential: async () => held })
    const a = api()
    await turnOffNode({ api: a as never, shell: s, server: "https://a.example.com" })
    expect(a.patch).toHaveBeenCalledWith("/nodes/n-old", { enabled: false })
    expect(s.storeNodeCredential).toHaveBeenCalledWith("https://a.example.com", {
      ...held,
      enabled: false,
    })
    expect(nodeCredentialForHello()).toBeNull()
  })
})
