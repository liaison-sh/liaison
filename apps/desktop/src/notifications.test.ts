// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's half of native notifications: the shell's own commands behind
// the bridge (src-tauri/src/desktop_notifications.rs), and what each one's
// answer becomes in the contract's words.
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
  listen: vi.fn(
    async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {},
  ),
}))
vi.mock("./tauri", () => ({ invoke, listen }))

import {
  BADGE_COMMAND,
  CLICK_EVENT,
  CLICK_SERVER_COMMAND,
  CLICK_SUPPORT_COMMAND,
  DEVICE_ID_GLOBAL,
  launchAtLogin,
  loadNotificationCredential,
  NOTIFY_COMMAND,
  notificationClickSupport,
  notificationDeviceId,
  notificationPermission,
  OS_PERMISSION_COMMAND,
  onNotificationClick,
  onNotificationPermissionChange,
  onNotificationServerClick,
  PERMISSION_EVENT,
  REQUEST_PERMISSION_COMMAND,
  raiseNotification,
  requestNotificationPermission,
  SWITCH_EVENT,
  setLaunchAtLogin,
  setUnreadBadge,
  storeNotificationCredential,
  TAKE_CLICK_COMMAND,
} from "./notifications"

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async () => undefined)
  listen.mockReset()
  listen.mockImplementation(async () => () => {})
})

describe("the shell's command names", () => {
  it("are the shell's own (the window is granted none of the plugin's commands)", () => {
    expect(NOTIFY_COMMAND).toBe("raise_notification")
    expect(CLICK_SUPPORT_COMMAND).toBe("notification_click_support")
    expect(TAKE_CLICK_COMMAND).toBe("take_notification_click")
    expect(CLICK_EVENT).toBe("liaison://notification-click")
  })
})

describe("setUnreadBadge", () => {
  it("hands the shell the count, zero included (which clears the badge)", async () => {
    expect(BADGE_COMMAND).toBe("set_unread_badge")
    await setUnreadBadge(4)
    await setUnreadBadge(0)
    expect(invoke.mock.calls).toEqual([
      [BADGE_COMMAND, { count: 4 }],
      [BADGE_COMMAND, { count: 0 }],
    ])
  })

  it("sends a whole, non negative count and never throws on a refused command", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("not allowed")
    })
    await expect(setUnreadBadge(2.7)).resolves.toBeUndefined()
    await setUnreadBadge(-3)
    await setUnreadBadge(Number.NaN)
    expect(invoke.mock.calls.map((call) => call[1])).toEqual([
      { count: 2 },
      { count: 0 },
      { count: 0 },
    ])
  })
})

describe("raiseNotification", () => {
  it("asks the shell for the sound only when the notification wants one", async () => {
    invoke.mockImplementation(async () => true)
    await raiseNotification({ title: "Ada", body: "Hi", tag: "m-1", sound: true })
    expect(invoke).toHaveBeenCalledWith(NOTIFY_COMMAND, {
      title: "Ada",
      body: "Hi",
      tag: "m-1",
      route: null,
      sound: true,
    })
  })

  it("hands the shell the title, the body, the tag and the route (LIF-18)", async () => {
    invoke.mockImplementation(async () => true)
    const route = "thread/t-1?replyRoot=r-1"
    expect(await raiseNotification({ title: "Ada", body: "Hello", tag: "t-1", route })).toBe(true)
    expect(invoke).toHaveBeenCalledWith(NOTIFY_COMMAND, {
      title: "Ada",
      body: "Hello",
      tag: "t-1",
      route,
      sound: false,
    })
  })

  it("sends a null route when the notification has none, and reads the shell's false", async () => {
    invoke.mockImplementation(async () => false)
    expect(await raiseNotification({ title: "Ada", body: "Hello", tag: "t-1" })).toBe(false)
    expect(invoke).toHaveBeenCalledWith(NOTIFY_COMMAND, {
      title: "Ada",
      body: "Hello",
      tag: "t-1",
      route: null,
      sound: false,
    })
  })

  it("answers false, and throws nothing, when the shell refuses", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("notification.notify not allowed")
    })
    expect(await raiseNotification({ title: "Ada", body: "Hello", tag: "t-1" })).toBe(false)
  })

  it("answers false when there is no Tauri under the page at all", async () => {
    invoke.mockImplementation(() => {
      throw new TypeError("window.__TAURI_INTERNALS__ is undefined")
    })
    expect(await raiseNotification({ title: "Ada", body: "Hello", tag: "t-1" })).toBe(false)
  })
})

// P1-T6 (A6): the plugin's own permission commands answer "granted" on a
// desktop whatever the system says, so the shell asks the system itself
// (src-tauri/src/desktop_notifications.rs) and the bridge reads THAT.
describe("notificationPermission", () => {
  it("asks the shell's own command, never the plugin's", async () => {
    invoke.mockImplementation(async () => "denied")
    await notificationPermission()
    expect(invoke).toHaveBeenCalledWith(OS_PERMISSION_COMMAND)
    expect(invoke).not.toHaveBeenCalledWith("plugin:notification|is_permission_granted")
    expect(OS_PERMISSION_COMMAND).toBe("notification_os_permission")
  })

  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    ["not_determined", "default"],
    ["something-else", "default"],
  ] as const)("reads %s from the system as %s", async (answer, expected) => {
    invoke.mockImplementation(async () => answer)
    expect(await notificationPermission()).toBe(expected)
  })

  it("reads a failed command as not yet decided, never as granted", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("boom")
    })
    expect(await notificationPermission()).toBe("default")
  })
})

describe("requestNotificationPermission", () => {
  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    ["not_determined", "default"],
  ] as const)("asks the system and reads %s as %s", async (answer, expected) => {
    invoke.mockImplementation(async () => answer)
    expect(await requestNotificationPermission()).toBe(expected)
    expect(invoke).toHaveBeenCalledWith(REQUEST_PERMISSION_COMMAND)
    expect(REQUEST_PERMISSION_COMMAND).toBe("request_notification_os_permission")
  })

  it("reads a failed command as not yet decided", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("boom")
    })
    expect(await requestNotificationPermission()).toBe("default")
  })
})

describe("onNotificationPermissionChange", () => {
  it("follows the shell's event and hands over the browser word", async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null
    const unlisten = vi.fn()
    listen.mockImplementation(async (_event: string, h: (event: { payload: unknown }) => void) => {
      handler = h
      return unlisten
    })
    const seen: string[] = []
    const stop = onNotificationPermissionChange((p) => seen.push(p))
    await vi.waitFor(() => expect(handler).not.toBeNull())
    expect(listen).toHaveBeenCalledWith(PERMISSION_EVENT, expect.any(Function))
    expect(PERMISSION_EVENT).toBe("liaison://notification-permission")
    handler!({ payload: "denied" })
    handler!({ payload: "not_determined" })
    handler!({ payload: "granted" })
    expect(seen).toEqual(["denied", "default", "granted"])
    stop()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
  })
})

describe("the install's notification device", () => {
  it("is the id the shell published before the page loaded", () => {
    const g = globalThis as Record<string, unknown>
    g[DEVICE_ID_GLOBAL] = "d.0123456789abcdef0123456789abcdef"
    try {
      expect(notificationDeviceId()).toBe("d.0123456789abcdef0123456789abcdef")
    } finally {
      delete g[DEVICE_ID_GLOBAL]
    }
    expect(notificationDeviceId()).toBeNull()
  })

  it("keeps its receipt credential in the shell, per server, never in the page", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "load_notification_credential" ? "lnr_x" : undefined,
    )
    await storeNotificationCredential("https://a.example.com", "lnr_x")
    expect(invoke).toHaveBeenCalledWith("store_notification_credential", {
      server: "https://a.example.com",
      credential: "lnr_x",
    })
    expect(await loadNotificationCredential("https://a.example.com")).toBe("lnr_x")
    expect(invoke).toHaveBeenCalledWith("load_notification_credential", {
      server: "https://a.example.com",
    })
    invoke.mockImplementation(async () => {
      throw new Error("NotCurrentServer")
    })
    expect(await loadNotificationCredential("https://b.example.com")).toBeNull()
  })
})

describe("launch at login", () => {
  it("reads and sets the shell's switch", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "set_launch_at_login" ? args?.enabled : true,
    )
    expect(await launchAtLogin()).toBe(true)
    expect(invoke).toHaveBeenCalledWith("get_launch_at_login")
    expect(await setLaunchAtLogin(false)).toBe(false)
    expect(invoke).toHaveBeenCalledWith("set_launch_at_login", { enabled: false })
  })
})

// LIF-18: a click on a notification the shell raised opens its item.
describe("notificationClickSupport", () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ] as const)("reads the shell's %s as %s", async (answer, expected) => {
    invoke.mockImplementation(async () => answer)
    expect(await notificationClickSupport()).toBe(expected)
    expect(invoke).toHaveBeenCalledWith(CLICK_SUPPORT_COMMAND)
  })

  it("is false from a shell without the command", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("command notification_click_support not found")
    })
    expect(await notificationClickSupport()).toBe(false)
  })
})

describe("onNotificationServerClick", () => {
  it("switches to the server a clicked notification came from, at start and on each event", async () => {
    const event: { fire: () => void } = { fire: () => undefined }
    listen.mockImplementation(async (name, h) => {
      if (name === SWITCH_EVENT) event.fire = () => h({ payload: { server: "ignored" } })
      return () => {}
    })
    const pending = ["https://globex.example.com", null, "https://initech.example.com"]
    invoke.mockImplementation(async (command) =>
      command === CLICK_SERVER_COMMAND ? (pending.shift() ?? null) : undefined,
    )
    const switched: string[] = []
    const stop = onNotificationServerClick(async (address) => {
      switched.push(address)
    })
    // The click that launched the app, asked once listening started.
    await vi.waitFor(() => expect(switched).toEqual(["https://globex.example.com"]))
    event.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(switched).toEqual(["https://globex.example.com"])
    event.fire()
    await vi.waitFor(() =>
      expect(switched).toEqual(["https://globex.example.com", "https://initech.example.com"]),
    )
    stop()
  })

  it("switches nothing when no click is pending or the shell has no such command", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("unknown command")
    })
    const switched: string[] = []
    const stop = onNotificationServerClick(async (address) => {
      switched.push(address)
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(switched).toEqual([])
    stop()
  })
})

describe("onNotificationClick", () => {
  function captureClickEvent(): { fire: () => void } {
    let handler: ((event: { payload: unknown }) => void) | null = null
    listen.mockImplementation(async (event, h) => {
      if (event === CLICK_EVENT) handler = h
      return () => {}
    })
    return { fire: () => handler?.({ payload: { route: "ignored" } }) }
  }

  it("delivers the click that launched the app once it listens (cold start)", async () => {
    captureClickEvent()
    const pending = ["thread/t-1"]
    invoke.mockImplementation(async (command) =>
      command === TAKE_CLICK_COMMAND ? (pending.shift() ?? null) : undefined,
    )
    const routes: string[] = []
    const stop = onNotificationClick((route) => routes.push(route))
    await vi.waitFor(() => expect(routes).toEqual(["thread/t-1"]))
    stop()
  })

  it("takes the route from the shell on each click event, once each", async () => {
    const click = captureClickEvent()
    const pending: string[] = []
    invoke.mockImplementation(async (command) =>
      command === TAKE_CLICK_COMMAND ? (pending.shift() ?? null) : undefined,
    )
    const routes: string[] = []
    const stop = onNotificationClick((route) => routes.push(route))
    await vi.waitFor(() => expect(listen).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    pending.push("attention/kernel/approval_request/a1")
    click.fire()
    click.fire()
    await vi.waitFor(() => expect(routes).toEqual(["attention/kernel/approval_request/a1"]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(routes).toEqual(["attention/kernel/approval_request/a1"])
    stop()
  })

  it("delivers nothing after the unsubscribe", async () => {
    const click = captureClickEvent()
    invoke.mockImplementation(async (command) =>
      command === TAKE_CLICK_COMMAND ? "thread/t-1" : undefined,
    )
    const routes: string[] = []
    const stop = onNotificationClick((route) => routes.push(route))
    stop()
    click.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(routes).toEqual([])
  })
})
