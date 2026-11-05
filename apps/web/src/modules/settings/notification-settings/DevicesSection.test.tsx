// SPDX-License-Identifier: FSL-1.1-ALv2
// P1-T7w (S3, S6): Settings -> Notifications -> devices and "Send me a test".
// The device list (GET /api/notifications/devices) on every surface with its
// registration state, last delivery and last confirmation; the browser control
// that asks the permission and subscribes; and the test button
// (POST /api/notifications/test) that polls the receipts for 30 s and shows
// each device as shown, suppressed (reason) or no receipt. Fetch is mocked.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DevicesSection } from "~/modules/settings/notification-settings/DevicesSection"
import { ApiProvider } from "~/modules/shell/ApiContext"

const browser = vi.hoisted(() => ({
  real: true,
  enableResult: "enabled" as string,
  enableCalls: [] as string[],
}))

vi.mock("~/modules/notifications/browser-push", () => ({
  isRealBrowser: () => browser.real,
  enableBrowserPush: async (_api: unknown, userId: string) => {
    browser.enableCalls.push(userId)
    return browser.enableResult
  },
}))

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me", orgId: "o1" }),
}))

interface Device {
  deviceId: string
  surface: "ios" | "android" | "desktop" | "browser"
  detail: Record<string, unknown>
  lastSeenAt: string
  lastDelivery: {
    notificationId: string
    channel: string
    surface: string | null
    result: string
    reason: string | null
    attemptedAt: string
  } | null
  lastReceipt: { notificationId: string; outcome: string; reason: string | null; at: string } | null
}

interface TestLine {
  deviceId: string | null
  surface: string
  notificationId: string
  result: string
  reason: string | null
}

interface Receipt {
  notificationId: string
  deviceId: string
  surface: string | null
  outcome: string
  reason: string | null
  at: string
}

interface Fake {
  devices: Device[]
  devicesStatus: number
  lines: TestLine[]
  testStatus: number
  /** Receipts the server holds, revealed after `afterPolls` receipt-status reads. */
  receipts: Array<Receipt & { afterPolls: number }>
  polls: number
  calls: Array<{ url: string; method: string }>
}

let fake: Fake

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const NOW = new Date("2026-10-07T12:00:00Z")
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString()

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      fake.calls.push({ url, method })
      if (url.endsWith("/notifications/devices")) {
        if (fake.devicesStatus !== 200)
          return json({ error: { message: "boom" } }, fake.devicesStatus)
        return json({ data: fake.devices })
      }
      if (url.endsWith("/notifications/test") && method === "POST") {
        if (fake.testStatus !== 200) return json({ error: { message: "boom" } }, fake.testStatus)
        return json({ data: { runId: "run-1", devices: fake.lines } })
      }
      if (url.includes("/notifications/receipt-status")) {
        fake.polls++
        const ids = new URL(url, "http://x").searchParams.get("ids")?.split(",") ?? []
        return json({
          data: fake.receipts
            .filter((r) => ids.includes(r.notificationId) && fake.polls > r.afterPolls)
            .map(({ afterPolls: _a, ...r }) => r),
        })
      }
      return json({ data: null }, 404)
    }),
  )
}

function renderSection() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <DevicesSection />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

const iphone: Device = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  surface: "ios",
  detail: { environment: "production" },
  lastSeenAt: ago(3600),
  lastDelivery: {
    notificationId: "n-ios",
    channel: "push",
    surface: "ios",
    result: "accepted",
    reason: null,
    attemptedAt: ago(600),
  },
  lastReceipt: { notificationId: "n-ios", outcome: "shown", reason: null, at: ago(590) },
}
const desktop: Device = {
  deviceId: "desk-1",
  surface: "desktop",
  detail: { os: "macOS", appVersion: "0.1.18", reportedPermission: "denied" },
  lastSeenAt: ago(60),
  lastDelivery: null,
  lastReceipt: null,
}
const thisBrowser: Device = {
  deviceId: "web-this",
  surface: "browser",
  detail: { webPush: false, userAgent: "Mozilla/5.0 Chrome" },
  lastSeenAt: ago(10),
  lastDelivery: {
    notificationId: "n-web",
    channel: "desktop",
    surface: "browser_tab",
    result: "no_connection",
    reason: null,
    attemptedAt: ago(120),
  },
  lastReceipt: null,
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  localStorage.clear()
  localStorage.setItem("liaison:deviceId", "web-this")
  browser.real = true
  browser.enableResult = "enabled"
  browser.enableCalls = []
  fake = {
    devices: [iphone, desktop, thisBrowser],
    devicesStatus: 200,
    lines: [],
    testStatus: 200,
    receipts: [],
    polls: 0,
    calls: [],
  }
  installFetch()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("device list", () => {
  it("shows every surface with its registration state, last delivery and last confirmation", async () => {
    renderSection()
    const ios = await screen.findByTestId(`notif-device-row-${iphone.deviceId}`)
    expect(ios.dataset.surface).toBe("ios")
    expect(ios.textContent).toContain("iPhone")
    expect(ios.textContent).toContain("Registered")
    expect(ios.textContent).toContain("delivered")
    expect(ios.textContent).toContain("shown")

    const desk = screen.getByTestId("notif-device-row-desk-1")
    expect(desk.textContent).toContain("Desktop app")
    expect(desk.textContent).toContain("Blocked by the system")
    expect(desk.textContent).toContain("Nothing sent to it yet")

    const web = screen.getByTestId("notif-device-row-web-this")
    expect(web.textContent).toContain("This browser")
    expect(web.textContent).toContain("Notifies you while Liaison is open in it")
    expect(web.textContent).toContain("not connected")
    expect(web.textContent).toContain("No confirmation yet")
  })

  it("says so when there is no device", async () => {
    fake.devices = []
    renderSection()
    expect(await screen.findByTestId("notif-devices-empty")).toBeTruthy()
  })

  it("says so when the list cannot be loaded", async () => {
    fake.devicesStatus = 500
    renderSection()
    expect(await screen.findByTestId("notif-devices-error")).toBeTruthy()
  })
})

describe("browser notifications control", () => {
  it("offers to turn them on in a browser without Web Push, and turns them on from the click", async () => {
    renderSection()
    const button = await screen.findByTestId("notif-browser-enable")
    fireEvent.click(button)
    await waitFor(() => expect(browser.enableCalls).toEqual(["u-me"]))
    expect((await screen.findByTestId("notif-browser-result")).dataset.result).toBe("enabled")
    // The list is read again to show the new registration.
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.url.endsWith("/notifications/devices"))).toHaveLength(2),
    )
  })

  it("explains a refusal", async () => {
    browser.enableResult = "denied"
    renderSection()
    fireEvent.click(await screen.findByTestId("notif-browser-enable"))
    expect((await screen.findByTestId("notif-browser-result")).dataset.result).toBe("denied")
  })

  it("is not offered in the desktop or phone app", async () => {
    browser.real = false
    renderSection()
    await screen.findByTestId(`notif-device-row-${iphone.deviceId}`)
    expect(screen.queryByTestId("notif-browser-enable")).toBeNull()
  })

  it("is not offered once this browser already has Web Push", async () => {
    fake.devices = [{ ...thisBrowser, detail: { webPush: true } }]
    vi.stubGlobal(
      "Notification",
      Object.defineProperty(function N() {}, "permission", { get: () => "granted" }),
    )
    renderSection()
    await screen.findByTestId("notif-device-row-web-this")
    expect(screen.queryByTestId("notif-browser-enable")).toBeNull()
  })
})

describe("Send me a test", () => {
  const line = (surface: string, deviceId: string, n: string, result = "accepted"): TestLine => ({
    deviceId,
    surface,
    notificationId: n,
    result,
    reason: result === "accepted" ? null : result,
  })

  it("shows each device as shown, suppressed with its reason, or no receipt after 30 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(NOW)
    fake.lines = [
      line("ios", iphone.deviceId, "n1"),
      line("browser_tab", "web-this", "n2"),
      line("browser_push", "web-this", "n3"),
      line("desktop", "desk-1", "n4", "no_connection"),
    ]
    fake.receipts = [
      {
        notificationId: "n1",
        deviceId: iphone.deviceId,
        surface: "ios",
        outcome: "shown",
        reason: null,
        at: NOW.toISOString(),
        afterPolls: 0,
      },
      {
        notificationId: "n2",
        deviceId: "web-this",
        surface: "browser_tab",
        outcome: "suppressed",
        reason: "on_screen",
        at: NOW.toISOString(),
        afterPolls: 1,
      },
    ]
    renderSection()
    await vi.waitFor(() => screen.getByTestId("notif-test-send"))
    fireEvent.click(screen.getByTestId("notif-test-send"))

    await vi.waitFor(() => screen.getByTestId("notif-test-line-n1"))
    // Before any confirmation, the delivered ones wait; the unreachable one is final.
    expect(screen.getByTestId("notif-test-line-n3").dataset.status).toBe("pending")
    expect(screen.getByTestId("notif-test-line-n4").dataset.status).toBe("not_delivered")
    expect(screen.getByTestId("notif-test-line-n4").textContent).toContain("not connected")

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() =>
      expect(screen.getByTestId("notif-test-line-n1").dataset.status).toBe("shown"),
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() =>
      expect(screen.getByTestId("notif-test-line-n2").dataset.status).toBe("suppressed"),
    )
    expect(screen.getByTestId("notif-test-line-n2").textContent).toContain(
      "you were already looking at it",
    )
    expect(screen.getByTestId("notif-test-line-n3").dataset.status).toBe("pending")

    // n3 never confirms: at 30 s it is "no receipt", and polling stops.
    await vi.advanceTimersByTimeAsync(28_000)
    await vi.waitFor(() =>
      expect(screen.getByTestId("notif-test-line-n3").dataset.status).toBe("no_receipt"),
    )
    expect(screen.getByTestId("notif-test-line-n3").textContent).toContain(
      "No confirmation within 30 seconds",
    )
    const polls = fake.polls
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.polls).toBe(polls)
    expect(polls).toBeLessThanOrEqual(16)
  })

  it("stops polling as soon as every delivered device has confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(NOW)
    fake.lines = [line("ios", iphone.deviceId, "n1")]
    fake.receipts = [
      {
        notificationId: "n1",
        deviceId: iphone.deviceId,
        surface: "ios",
        outcome: "shown",
        reason: null,
        at: NOW.toISOString(),
        afterPolls: 0,
      },
    ]
    renderSection()
    await vi.waitFor(() => screen.getByTestId("notif-test-send"))
    fireEvent.click(screen.getByTestId("notif-test-send"))
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() =>
      expect(screen.getByTestId("notif-test-line-n1").dataset.status).toBe("shown"),
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fake.polls).toBe(1)
    expect(screen.getByTestId("notif-test-state").dataset.state).toBe("done")
  })

  it("a received-only iOS confirmation stays 'received' at the deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(NOW)
    fake.lines = [line("ios", iphone.deviceId, "n1")]
    fake.receipts = [
      {
        notificationId: "n1",
        deviceId: iphone.deviceId,
        surface: "ios",
        outcome: "received",
        reason: null,
        at: NOW.toISOString(),
        afterPolls: 0,
      },
    ]
    renderSection()
    await vi.waitFor(() => screen.getByTestId("notif-test-send"))
    fireEvent.click(screen.getByTestId("notif-test-send"))
    await vi.advanceTimersByTimeAsync(32_000)
    await vi.waitFor(() =>
      expect(screen.getByTestId("notif-test-line-n1").dataset.status).toBe("received"),
    )
  })

  it("says when the test could not be sent, and when there is no device", async () => {
    fake.testStatus = 500
    renderSection()
    fireEvent.click(await screen.findByTestId("notif-test-send"))
    expect((await screen.findByTestId("notif-test-state")).dataset.state).toBe("failed")

    cleanup()
    fake.testStatus = 200
    fake.lines = []
    renderSection()
    fireEvent.click(await screen.findByTestId("notif-test-send"))
    expect((await screen.findByTestId("notif-test-state")).dataset.state).toBe("none")
  })
})
