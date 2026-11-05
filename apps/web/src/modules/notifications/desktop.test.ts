// SPDX-License-Identifier: FSL-1.1-ALv2
// S5: the server picks the window and sends a `notify` frame; this module only
// checks the OS permission and raises through the bridge. S6: the window tells
// the server what it is (desktop app, browser, phone) and when it was last used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import {
  clientKind,
  DesktopNotificationsTestAccess,
  dismissBanner,
  enable,
  handleNotifyFrame,
  installActivityTracking,
  isBannerDismissed,
  isEnabled,
  isSupported,
  lastActiveAt,
  permissionState,
} from "./desktop"

// T4: in-tab receipts go through the browser device module (credential in
// IndexedDB); here only what the tab reports is checked.
const receipts = vi.hoisted(() => ({ posted: [] as Array<Record<string, unknown>> }))
vi.mock("./browser-push", () => ({
  postBrowserReceipt: async (input: Record<string, unknown>) => {
    receipts.posted.push(input)
    return true
  },
}))
// T6: the desktop app's receipts go through its own device (credential kept by
// the shell); here only what the app reports is checked.
const desktopReceipts = vi.hoisted(() => ({ posted: [] as Array<Record<string, unknown>> }))
vi.mock("./desktop-device", () => ({
  postDesktopReceipt: async (input: Record<string, unknown>) => {
    desktopReceipts.posted.push(input)
    return true
  },
}))

// LIF-18: a click opens the item through the one resolver.
const routes = vi.hoisted(() => ({
  opened: [] as unknown[],
  offered: [] as Array<{ route: string; title: string }>,
}))
vi.mock("./open-route", () => ({
  openNotificationRoute: async (route: unknown) => {
    routes.opened.push(route)
    return true
  },
  offerShellNotificationRoute: (route: string, title: string) => {
    routes.offered.push({ route, title })
  },
}))

class FakeNotification {
  static permission: NotificationPermission = "default"
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  constructor(
    public title: string,
    public options: { body?: string; tag?: string },
  ) {
    FakeNotification.instances.push(this)
  }
}

const frame = {
  type: "notify" as const,
  notifyId: "attention:e1",
  group: "approvals",
  title: "Approval needed",
  body: "Refund 42",
  route: "/approvals/1",
  urgent: false,
}

describe("desktop notifications", () => {
  beforeEach(() => {
    localStorage.clear()
    receipts.posted = []
    desktopReceipts.posted = []
    routes.opened = []
    routes.offered = []
    FakeNotification.permission = "default"
    FakeNotification.instances = []
    FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission)
    vi.stubGlobal("Notification", FakeNotification)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  })

  it("isSupported reflects Notification API presence", () => {
    expect(isSupported()).toBe(true)
    vi.unstubAllGlobals()
    // biome-ignore lint/performance/noDelete: simulate an unsupported browser
    delete (globalThis as any).Notification
    expect(isSupported()).toBe(false)
    expect(permissionState()).toBe("unsupported")
  })

  it("enabled is the permission alone: no per-browser switch is read or written", async () => {
    expect(isEnabled()).toBe(false)
    FakeNotification.permission = "granted"
    expect(isEnabled()).toBe(true)
    FakeNotification.permission = "default"
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = "granted"
      return "granted" as NotificationPermission
    })
    expect(await enable()).toBe(true)
    expect(localStorage.getItem("liaison:desktop-notifications-enabled")).toBeNull()
  })

  it("enable() answers false when the permission is denied", async () => {
    FakeNotification.permission = "denied"
    expect(await enable()).toBe(false)
  })

  it("banner dismissal persists via localStorage", () => {
    expect(isBannerDismissed()).toBe(false)
    dismissBanner()
    expect(isBannerDismissed()).toBe(true)
  })

  describe("notify frame", () => {
    it("raises the server's notification when the permission is granted, tagged by notifyId", async () => {
      FakeNotification.permission = "granted"
      expect(await handleNotifyFrame(frame)).toBe(true)
      expect(FakeNotification.instances).toHaveLength(1)
      expect(FakeNotification.instances[0]?.title).toBe("Approval needed")
      expect(FakeNotification.instances[0]?.options).toMatchObject({
        body: "Refund 42",
        tag: "attention:e1",
      })
    })

    it("tags the notification by the frame's conversation when it names one, so the newer replaces the older", async () => {
      FakeNotification.permission = "granted"
      expect(await handleNotifyFrame({ ...frame, tag: "thread/t-42" })).toBe(true)
      expect(FakeNotification.instances.at(-1)?.options).toMatchObject({ tag: "thread/t-42" })
    })

    it("a click on the browser notification focuses the window and opens its route (LIF-18)", async () => {
      FakeNotification.permission = "granted"
      const focus = vi.spyOn(window, "focus").mockImplementation(() => {})
      const route = "attention/kernel/approval_request/a1"
      expect(await handleNotifyFrame({ ...frame, route })).toBe(true)
      FakeNotification.instances[0]?.onclick?.()
      expect(focus).toHaveBeenCalled()
      expect(routes.opened).toEqual([route])
    })

    it("does nothing without the permission", async () => {
      FakeNotification.permission = "denied"
      expect(await handleNotifyFrame(frame)).toBe(false)
      expect(FakeNotification.instances).toHaveLength(0)
    })

    it("never re-decides: a visible, focused window still raises what the server sent", async () => {
      FakeNotification.permission = "granted"
      vi.spyOn(document, "hasFocus").mockReturnValue(true)
      expect(await handleNotifyFrame({ ...frame, group: "replies" })).toBe(true)
      expect(FakeNotification.instances).toHaveLength(1)
    })

    it("raises nothing for a message in the conversation on screen", async () => {
      // The one thing only the page knows: the user is reading that
      // conversation, so a notice announcing its new message is redundant.
      FakeNotification.permission = "granted"
      const message = { ...frame, notifyId: "message:m1", group: "direct", route: "thread/t-open" }
      expect(await handleNotifyFrame(message, () => "t-open")).toBe(false)
      expect(
        await handleNotifyFrame(
          { ...message, route: "thread/t-open?replyRoot=r1" },
          () => "t-open",
        ),
      ).toBe(false)
      expect(FakeNotification.instances).toHaveLength(0)
    })

    it("still raises a message from any other conversation while one is on screen", async () => {
      FakeNotification.permission = "granted"
      const message = { ...frame, notifyId: "message:m2", group: "direct", route: "thread/t-other" }
      expect(await handleNotifyFrame(message, () => "t-open")).toBe(true)
      expect(await handleNotifyFrame({ ...frame, notifyId: "message:m3" }, () => null)).toBe(true)
      expect(FakeNotification.instances).toHaveLength(2)
    })

    describe("in-tab receipts (T4, A5)", () => {
      const id = "33333333-3333-4333-8333-333333333333"

      it("a raised notification posts a shown browser_tab receipt", async () => {
        FakeNotification.permission = "granted"
        expect(await handleNotifyFrame({ ...frame, notificationId: id })).toBe(true)
        expect(receipts.posted).toEqual([
          { notificationId: id, surface: "browser_tab", outcome: "shown" },
        ])
      })

      it("the conversation on screen posts suppressed/on_screen", async () => {
        FakeNotification.permission = "granted"
        const message = { ...frame, notificationId: id, route: "thread/t-open" }
        expect(await handleNotifyFrame(message, () => "t-open")).toBe(false)
        expect(receipts.posted).toEqual([
          {
            notificationId: id,
            surface: "browser_tab",
            outcome: "suppressed",
            reason: "on_screen",
          },
        ])
      })

      it("no permission posts suppressed/os_permission_denied", async () => {
        FakeNotification.permission = "denied"
        expect(await handleNotifyFrame({ ...frame, notificationId: id })).toBe(false)
        expect(receipts.posted).toEqual([
          {
            notificationId: id,
            surface: "browser_tab",
            outcome: "suppressed",
            reason: "os_permission_denied",
          },
        ])
      })

      it("a frame without a notificationId posts nothing", async () => {
        FakeNotification.permission = "granted"
        expect(await handleNotifyFrame(frame)).toBe(true)
        expect(receipts.posted).toEqual([])
      })

      it("the desktop app's frames are not in-tab receipts", async () => {
        installFakeBridge()
        try {
          FakeNotification.permission = "granted"
          await handleNotifyFrame({ ...frame, notificationId: id })
          expect(receipts.posted).toEqual([])
        } finally {
          uninstallFakeBridge()
        }
      })

      describe("the desktop app reports what the OS call did (S1, T6)", () => {
        function desktopWith(permission: "granted" | "denied" | "default", raised = true) {
          installFakeBridge()
          Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
            notificationPermission: async () => permission,
            raiseNotification: async () => raised,
          })
        }

        it("shown, after the OS call returns", async () => {
          desktopWith("granted")
          try {
            expect(await handleNotifyFrame({ ...frame, notificationId: id })).toBe(true)
            expect(desktopReceipts.posted).toEqual([{ notificationId: id, outcome: "shown" }])
            expect(receipts.posted).toEqual([])
          } finally {
            uninstallFakeBridge()
          }
        })

        it("a shell that reports its clicks gets the route and no Open toast (LIF-18)", async () => {
          const raised: unknown[] = []
          installFakeBridge()
          Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
            notificationPermission: async () => "granted",
            notificationClickSupport: async () => true,
            raiseNotification: async (n: unknown) => {
              raised.push(n)
              return true
            },
          })
          try {
            const route = "attention/kernel/approval_request/a1"
            expect(await handleNotifyFrame({ ...frame, route })).toBe(true)
            expect(raised).toEqual([
              { title: "Approval needed", body: "Refund 42", tag: "attention:e1", route },
            ])
            expect(routes.offered).toEqual([])
          } finally {
            uninstallFakeBridge()
          }
        })

        it("a shell that says it hears no click keeps the Open toast (LIF-18)", async () => {
          installFakeBridge()
          Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
            notificationPermission: async () => "granted",
            notificationClickSupport: async () => false,
            raiseNotification: async () => true,
          })
          try {
            const route = "thread/t-1"
            expect(await handleNotifyFrame({ ...frame, route })).toBe(true)
            expect(routes.offered).toEqual([{ route, title: "Approval needed" }])
          } finally {
            uninstallFakeBridge()
          }
        })

        it("hands the shell the frame's route, and offers it in the page (LIF-18)", async () => {
          const raised: unknown[] = []
          installFakeBridge()
          Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
            notificationPermission: async () => "granted",
            raiseNotification: async (n: unknown) => {
              raised.push(n)
              return true
            },
          })
          try {
            const route = "thread/t-1?replyRoot=r-1"
            expect(await handleNotifyFrame({ ...frame, route })).toBe(true)
            expect(raised).toEqual([
              { title: "Approval needed", body: "Refund 42", tag: "attention:e1", route },
            ])
            expect(routes.offered).toEqual([{ route, title: "Approval needed" }])
          } finally {
            uninstallFakeBridge()
          }
        })

        it("a direct message or a mention asks the shell for the sound; the rest are silent", async () => {
          const raised: Array<Record<string, unknown>> = []
          installFakeBridge()
          Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
            notificationPermission: async () => "granted",
            notificationClickSupport: async () => true,
            raiseNotification: async (n: Record<string, unknown>) => {
              raised.push(n)
              return true
            },
          })
          try {
            await handleNotifyFrame({ ...frame, notifyId: "message:m1", group: "direct" })
            await handleNotifyFrame({ ...frame, notifyId: "message:m2", group: "replies" })
            await handleNotifyFrame({ ...frame, notifyId: "attention:e2" })
            expect(raised.map((n) => [n.tag, n.sound])).toEqual([
              ["message:m1", true],
              ["message:m2", undefined],
              ["attention:e2", undefined],
            ])
          } finally {
            uninstallFakeBridge()
          }
        })

        it("suppressed/on_screen for the conversation on screen", async () => {
          desktopWith("granted")
          try {
            const onThread = { ...frame, notificationId: id, route: "/threads/t-9" }
            expect(await handleNotifyFrame(onThread, () => "t-9")).toBe(false)
            expect(desktopReceipts.posted).toEqual([
              { notificationId: id, outcome: "suppressed", reason: "on_screen" },
            ])
          } finally {
            uninstallFakeBridge()
          }
        })

        it("suppressed/os_permission_denied when the system refuses", async () => {
          desktopWith("denied")
          try {
            expect(await handleNotifyFrame({ ...frame, notificationId: id })).toBe(false)
            expect(desktopReceipts.posted).toEqual([
              { notificationId: id, outcome: "suppressed", reason: "os_permission_denied" },
            ])
          } finally {
            uninstallFakeBridge()
          }
        })
      })
    })

    it("ignores a malformed frame", async () => {
      FakeNotification.permission = "granted"
      expect(await handleNotifyFrame({ type: "notify" } as never)).toBe(false)
      expect(FakeNotification.instances).toHaveLength(0)
    })
  })

  describe("client kind and activity (S6)", () => {
    it("a plain browser is a browser", () => {
      expect(clientKind()).toBe("browser")
    })

    it("the desktop shell is the desktop app", () => {
      installFakeBridge()
      try {
        expect(clientKind()).toBe("desktop_app")
      } finally {
        uninstallFakeBridge()
      }
    })

    it("the Capacitor shell is the mobile app", () => {
      ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {}
      expect(clientKind()).toBe("mobile_app")
    })

    it("user input moves the activity clock and reports a return at most every 10 s", () => {
      DesktopNotificationsTestAccess.setLastActiveAt(0)
      const onActive = vi.fn()
      const uninstall = installActivityTracking(onActive)
      try {
        window.dispatchEvent(new Event("pointerdown"))
        expect(lastActiveAt()).toBeGreaterThan(0)
        window.dispatchEvent(new Event("keydown"))
        expect(onActive).toHaveBeenCalledTimes(1)
      } finally {
        uninstall()
      }
      window.dispatchEvent(new Event("pointerdown"))
      expect(onActive).toHaveBeenCalledTimes(1)
    })
  })
})
