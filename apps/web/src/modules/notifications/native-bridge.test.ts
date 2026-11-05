// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DESKTOP_BRIDGE_KEY, DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import {
  desktopNotificationPermission,
  NativeBridgeTestAccess,
  raiseDesktopNotification,
  requestDesktopNotificationPermission,
  withdrawThreadNotifications,
} from "./native-bridge"

class FakeNotification {
  static permission: NotificationPermission = "default"
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static created: FakeNotification[] = []
  onclick: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  constructor(
    public title: string,
    public options: { body?: string; tag?: string; renotify?: boolean },
  ) {
    FakeNotification.created.push(this)
  }
}

const note = { title: "Ada", body: "Hello", tag: "thread:t1" }

function installShell(members: Record<string, unknown>): void {
  Object.defineProperty(globalThis, DESKTOP_BRIDGE_KEY, {
    value: { version: DESKTOP_BRIDGE_VERSION, platform: "macos", ...members },
    configurable: true,
    writable: true,
  })
}

function removeShell(): void {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
}

beforeEach(() => {
  FakeNotification.permission = "default"
  FakeNotification.created = []
  FakeNotification.requestPermission.mockClear()
  NativeBridgeTestAccess.reset()
  vi.stubGlobal("Notification", FakeNotification)
})

afterEach(() => {
  removeShell()
  vi.unstubAllGlobals()
})

describe("in a browser (no desktop shell)", () => {
  it("raises a browser notification with the tag when permission is granted", async () => {
    FakeNotification.permission = "granted"
    expect(await raiseDesktopNotification(note)).toBe(true)
    expect(FakeNotification.created).toHaveLength(1)
    const [raised] = FakeNotification.created
    expect(raised?.title).toBe("Ada")
    // `renotify`: replacing the conversation's previous notification still alerts.
    expect(raised?.options).toEqual({ body: "Hello", tag: "thread:t1", renotify: true })
  })

  it("brings the window forward on a click", async () => {
    FakeNotification.permission = "granted"
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {})
    await raiseDesktopNotification(note)
    FakeNotification.created[0]?.onclick?.()
    expect(focus).toHaveBeenCalled()
  })

  it("raises nothing without permission", async () => {
    FakeNotification.permission = "denied"
    expect(await raiseDesktopNotification(note)).toBe(false)
    FakeNotification.permission = "default"
    expect(await raiseDesktopNotification(note)).toBe(false)
    expect(FakeNotification.created).toHaveLength(0)
  })

  it("answers false when the constructor throws", async () => {
    FakeNotification.permission = "granted"
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function Throwing() {
          throw new TypeError("Illegal constructor")
        },
        { permission: "granted" },
      ),
    )
    expect(await raiseDesktopNotification(note)).toBe(false)
  })

  it("reports and requests the browser permission", async () => {
    FakeNotification.permission = "denied"
    expect(await desktopNotificationPermission()).toBe("denied")
    FakeNotification.requestPermission.mockImplementationOnce(async () => "granted")
    expect(await requestDesktopNotificationPermission()).toBe("granted")
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("says unsupported where there is no Notification API", async () => {
    vi.stubGlobal("Notification", undefined)
    delete (window as unknown as Record<string, unknown>).Notification
    expect(await desktopNotificationPermission()).toBe("unsupported")
    expect(await requestDesktopNotificationPermission()).toBe("unsupported")
    expect(await raiseDesktopNotification(note)).toBe(false)
  })
})

describe("in the desktop app", () => {
  it("raises through the shell, never the browser API", async () => {
    FakeNotification.permission = "granted"
    const raiseNotification = vi.fn(async () => true)
    installShell({ raiseNotification })
    expect(await raiseDesktopNotification(note)).toBe(true)
    expect(raiseNotification).toHaveBeenCalledWith(note)
    expect(FakeNotification.created).toHaveLength(0)
  })

  it("passes on the shell's refusal", async () => {
    installShell({ raiseNotification: vi.fn(async () => false) })
    expect(await raiseDesktopNotification(note)).toBe(false)
  })

  it("answers false when the shell call rejects", async () => {
    installShell({
      raiseNotification: vi.fn(async () => {
        throw new Error("plugin missing")
      }),
    })
    expect(await raiseDesktopNotification(note)).toBe(false)
  })

  it("reads and requests the permission from the shell", async () => {
    FakeNotification.permission = "denied"
    const requestNotificationPermission = vi.fn(async () => "granted" as const)
    installShell({
      notificationPermission: vi.fn(async () => "default" as const),
      requestNotificationPermission,
    })
    expect(await desktopNotificationPermission()).toBe("default")
    expect(await requestDesktopNotificationPermission()).toBe("granted")
    expect(requestNotificationPermission).toHaveBeenCalledTimes(1)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })

  it("falls back to the browser API in a shell too old to notify", async () => {
    FakeNotification.permission = "granted"
    installShell({})
    expect(await raiseDesktopNotification(note)).toBe(true)
    expect(FakeNotification.created).toHaveLength(1)
    expect(await desktopNotificationPermission()).toBe("granted")
  })
})

// Rule 5, read once, read everywhere: a conversation read on any device takes
// its notifications off this computer, the browser's and the service worker's.
describe("withdrawing a read conversation's notifications", () => {
  it("closes this page's notifications of the thread, and only those", async () => {
    FakeNotification.permission = "granted"
    await raiseDesktopNotification({ title: "A", body: "", tag: "thread/t1", route: "thread/t1" })
    await raiseDesktopNotification({ title: "B", body: "", tag: "thread/t2", route: "thread/t2" })
    expect(await withdrawThreadNotifications("t1")).toBe(1)
    const [a, b] = FakeNotification.created
    expect(a?.closed).toBe(true)
    expect(b?.closed).toBe(false)
    // Closed once: a second read finds nothing left.
    expect(await withdrawThreadNotifications("t1")).toBe(0)
  })

  it("a channel read leaves its replies' notifications; the reply thread's read closes them", async () => {
    FakeNotification.permission = "granted"
    // A reply is tagged with its channel (one notification per conversation)
    // but its route names its root: only that root's read withdraws it.
    await raiseDesktopNotification({
      title: "R",
      body: "",
      tag: "n:reply",
      route: "thread/t1?replyRoot=r1",
    })
    expect(await withdrawThreadNotifications("t1")).toBe(0)
    expect(FakeNotification.created[0]?.closed).toBe(false)
    expect(await withdrawThreadNotifications("t1", "r2")).toBe(0)
    expect(await withdrawThreadNotifications("t1", "r1")).toBe(1)
    expect(FakeNotification.created[0]?.closed).toBe(true)
  })

  it("never guesses from a tag alone, nor closes an entity thread's notification on a channel id", async () => {
    FakeNotification.permission = "granted"
    await raiseDesktopNotification({ title: "T", body: "", tag: "thread/t1" })
    await raiseDesktopNotification({
      title: "Task",
      body: "",
      tag: "attention/projects/task/k1",
      route: "attention/projects/task/k1?message=m1",
    })
    expect(await withdrawThreadNotifications("t1")).toBe(0)
    expect(await withdrawThreadNotifications("k1")).toBe(0)
    expect(FakeNotification.created.map((n) => n.closed)).toEqual([false, false])
  })

  it("closes the service worker's Web Push notifications of the thread, never its replies'", async () => {
    const shown = [
      { tag: "thread/t1", data: { route: "thread/t1" }, close: vi.fn() },
      { tag: "thread/t1", data: { route: "thread/t1?replyRoot=r1" }, close: vi.fn() },
      { tag: "approval/a1", data: { route: "approval/a1" }, close: vi.fn() },
    ]
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: async () => ({ getNotifications: async () => shown }) },
    })
    expect(await withdrawThreadNotifications("t1")).toBe(1)
    expect(shown[0]?.close).toHaveBeenCalledTimes(1)
    expect(shown[1]?.close).not.toHaveBeenCalled()
    expect(shown[2]?.close).not.toHaveBeenCalled()
    expect(await withdrawThreadNotifications("t1", "r1")).toBe(1)
    expect(shown[1]?.close).toHaveBeenCalledTimes(1)
  })
})
