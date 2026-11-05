// SPDX-License-Identifier: FSL-1.1-ALv2
// P1-T6 (S4, A6, A7, F1): the desktop app as a notification device. Its id is
// the install id the shell publishes (never a localStorage key, which a web
// sign out clears); it reports the system's real permission; it registers with
// POST /api/notifications/desktop-devices and keeps the answered receipt
// credential in the shell, per server; its receipts carry that credential,
// never the session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import {
  DesktopDeviceTestAccess,
  desktopDeviceId,
  ensureDesktopDevice,
  installDesktopPermissionReporting,
  postDesktopReceipt,
  refreshReportedPermission,
  reportedPermission,
  wirePermission,
} from "./desktop-device"

const SERVER = "https://acme.example.com"
const DEVICE = "d.0123456789abcdef0123456789abcdef"

interface ShellNotifications {
  permission: "granted" | "denied" | "default"
  stored: Array<[string, string]>
  listeners: Array<(p: "granted" | "denied" | "default") => void>
}

let shell: ShellNotifications
let fetchCalls: Array<{ url: string; init: RequestInit }>
let fetchStatus: number[]

function installDesktop(): void {
  installFakeBridge()
  const bridge = getDesktopBridge() as unknown as Record<string, unknown>
  Object.assign(bridge, {
    notificationDeviceId: () => DEVICE,
    notificationPermission: async () => shell.permission,
    onNotificationPermissionChange: (listener: ShellNotifications["listeners"][number]) => {
      shell.listeners.push(listener)
      return () => {
        shell.listeners = shell.listeners.filter((l) => l !== listener)
      }
    },
    storeNotificationCredential: async (server: string, credential: string) => {
      shell.stored.push([server, credential])
    },
    loadNotificationCredential: async (server: string) => {
      const last = [...shell.stored].reverse().find(([s]) => s === server)
      return last ? last[1] : null
    },
  })
}

function api(credentials: string[]) {
  let i = 0
  const post = vi.fn(async (_path: string, _body?: unknown) => ({
    deviceId: DEVICE,
    receiptCredential: credentials[Math.min(i++, credentials.length - 1)],
  }))
  return { post: post as unknown as Pick<ApiClient, "post">["post"] & typeof post }
}

beforeEach(() => {
  shell = { permission: "granted", stored: [], listeners: [] }
  fetchCalls = []
  fetchStatus = []
  ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = SERVER
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      return new Response(null, { status: fetchStatus.shift() ?? 201 })
    }),
  )
  DesktopDeviceTestAccess.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  uninstallFakeBridge()
  delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
})

describe("the desktop device id", () => {
  it("is the install id the shell published, and nothing in a browser", () => {
    expect(desktopDeviceId()).toBeNull()
    installDesktop()
    expect(desktopDeviceId()).toBe(DEVICE)
    expect(localStorage.getItem("liaison:deviceId")).toBeNull()
  })
})

describe("the reported permission (A6)", () => {
  it("speaks the server's three words", () => {
    expect(wirePermission("granted")).toBe("granted")
    expect(wirePermission("denied")).toBe("denied")
    expect(wirePermission("default")).toBe("not_determined")
    expect(wirePermission("unsupported")).toBe("not_determined")
  })

  it("is the system's answer, read through the shell", async () => {
    installDesktop()
    expect(reportedPermission()).toBeUndefined()
    shell.permission = "denied"
    expect(await refreshReportedPermission()).toBe("denied")
    expect(reportedPermission()).toBe("denied")
  })

  it("is never reported outside the desktop app", async () => {
    expect(await refreshReportedPermission()).toBeUndefined()
    expect(reportedPermission()).toBeUndefined()
  })

  it("a change in the system reaches the caller and re-registers the device", async () => {
    installDesktop()
    const client = api(["lnr_1", "lnr_2"])
    await ensureDesktopDevice(client, "u1")
    const seen: string[] = []
    const stop = installDesktopPermissionReporting((p) => seen.push(p))
    shell.listeners[0]?.("denied")
    await vi.waitFor(() => expect(client.post).toHaveBeenCalledTimes(2))
    expect(seen).toEqual(["denied"])
    expect(reportedPermission()).toBe("denied")
    expect(client.post.mock.calls[1]?.[1]).toMatchObject({
      deviceId: DEVICE,
      notificationPermission: "denied",
    })
    stop()
    expect(shell.listeners).toHaveLength(0)
  })
})

describe("registration (F1, A7)", () => {
  it("registers the install with its real permission and keeps the credential in the shell", async () => {
    installDesktop()
    shell.permission = "default"
    const client = api(["lnr_abc"])
    expect(await ensureDesktopDevice(client, "u1")).toBe(true)
    expect(client.post).toHaveBeenCalledWith("/notifications/desktop-devices", {
      deviceId: DEVICE,
      notificationPermission: "not_determined",
      os: "macos",
    })
    expect(shell.stored).toEqual([[SERVER, "lnr_abc"]])
    expect(localStorage.length).toBe(0)
  })

  it("does nothing in a browser", async () => {
    const client = api(["lnr_abc"])
    expect(await ensureDesktopDevice(client, "u1")).toBe(false)
    expect(client.post).not.toHaveBeenCalled()
  })
})

describe("receipts (S1, A7)", () => {
  it("carry the device credential, never the session, and name the desktop surface", async () => {
    installDesktop()
    await ensureDesktopDevice(api(["lnr_abc"]), "u1")
    const id = "11111111-1111-4111-8111-111111111111"
    expect(await postDesktopReceipt({ notificationId: id, outcome: "shown" })).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    const [call] = fetchCalls
    expect(call!.url).toBe(`${SERVER}/api/notifications/receipts`)
    expect((call!.init.headers as Record<string, string>).Authorization).toBe("Bearer lnr_abc")
    expect(JSON.parse(call!.init.body as string)).toMatchObject({
      notificationId: id,
      deviceId: DEVICE,
      surface: "desktop",
      outcome: "shown",
    })
  })

  it("a receipt that beat its delivery row (404) is posted once more a moment later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      installDesktop()
      await ensureDesktopDevice(api(["lnr_abc"]), "u1")
      fetchStatus = [404, 201]
      const pending = postDesktopReceipt({
        notificationId: "11111111-1111-4111-8111-111111111111",
        outcome: "shown",
      })
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toBe(true)
      expect(fetchCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a suppression names its reason", async () => {
    installDesktop()
    await ensureDesktopDevice(api(["lnr_abc"]), "u1")
    await postDesktopReceipt({
      notificationId: "11111111-1111-4111-8111-111111111111",
      outcome: "suppressed",
      reason: "os_permission_denied",
    })
    expect(JSON.parse(fetchCalls[0]!.init.body as string)).toMatchObject({
      outcome: "suppressed",
      reason: "os_permission_denied",
    })
  })

  it("a rotated credential (401) re-registers once and retries", async () => {
    installDesktop()
    const client = api(["lnr_old", "lnr_new"])
    await ensureDesktopDevice(client, "u1")
    fetchStatus = [401, 201]
    expect(
      await postDesktopReceipt({
        notificationId: "11111111-1111-4111-8111-111111111111",
        outcome: "shown",
      }),
    ).toBe(true)
    expect(client.post).toHaveBeenCalledTimes(2)
    expect(fetchCalls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(
      ["Bearer lnr_old", "Bearer lnr_new"],
    )
  })

  it("posts nothing without a credential", async () => {
    installDesktop()
    expect(
      await postDesktopReceipt({
        notificationId: "11111111-1111-4111-8111-111111111111",
        outcome: "shown",
      }),
    ).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })
})
