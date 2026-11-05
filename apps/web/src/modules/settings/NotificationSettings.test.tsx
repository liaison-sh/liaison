// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Notifications (S8, S9): the grid, the digest cadence, work hours,
// the per-app rules and "This device", against the settings API contract of
// plans/P2 (GET/PATCH /api/notifications/settings), fetch mocked.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import NotificationSettings from "~/modules/settings/NotificationSettings"
import { KERNEL_RULE_KINDS } from "~/modules/settings/notification-settings/kind-labels"
import { ApiProvider } from "~/modules/shell/ApiContext"

const device = vi.hoisted(() => ({
  permission: "granted" as "granted" | "denied" | "default" | "unsupported",
  afterRequest: "granted" as "granted" | "denied" | "default" | "unsupported",
  requests: 0,
  desktopApp: false,
}))

vi.mock("~/modules/desktop/desktop-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/desktop/desktop-store")>()),
  isDesktop: () => device.desktopApp,
}))

vi.mock("~/modules/notifications/native-bridge", () => ({
  desktopNotificationPermission: async () => device.permission,
  requestDesktopNotificationPermission: async () => {
    device.requests++
    device.permission = device.afterRequest
    return device.permission
  },
}))

type Grid = Record<string, Record<string, boolean>>

interface Settings {
  channels: string[]
  groups: Array<{ id: string; label: string; labelKey: string }>
  grid: Grid
  defaults: Grid
  workHours: { start: string; end: string; days: number[]; timezone: string; explicit: boolean }
  digestCadence: "immediate" | "hourly" | "daily" | "off"
  approvalReminder?: "daily" | "every_3_days" | "weekly" | "off"
  mutedGroups?: string[]
}

const CHANNELS = ["in_app", "desktop", "push", "email"]

function row(desktop: boolean, push: boolean, email: boolean): Record<string, boolean> {
  return { in_app: true, desktop, push, email }
}

function defaultGrid(): Grid {
  return {
    direct: row(true, true, true),
    replies: row(true, true, true),
    approvals: row(true, true, true),
    work: row(false, false, true),
    mail: row(true, true, false),
    agent: row(true, true, true),
    system: row(false, false, true),
  }
}

function sampleSettings(): Settings {
  return {
    channels: CHANNELS,
    groups: [
      {
        id: "direct",
        label: "Direct messages and mentions",
        labelKey: "notifications.groups.direct",
      },
      { id: "replies", label: "Replies in your threads", labelKey: "notifications.groups.replies" },
      {
        id: "approvals",
        label: "Approvals and access requests",
        labelKey: "notifications.groups.approvals",
      },
      { id: "work", label: "Tickets, tasks and knowledge", labelKey: "notifications.groups.work" },
      { id: "mail", label: "New email", labelKey: "notifications.groups.mail" },
      { id: "agent", label: "Agent and routine alerts", labelKey: "notifications.groups.agent" },
      { id: "system", label: "System alerts", labelKey: "notifications.groups.system" },
    ],
    grid: defaultGrid(),
    defaults: defaultGrid(),
    workHours: {
      start: "09:00",
      end: "17:00",
      days: [1, 2, 3, 4, 5],
      timezone: "Europe/Paris",
      explicit: false,
    },
    digestCadence: "daily",
  }
}

interface Call {
  url: string
  method: string
  body?: any
}

interface Fake {
  calls: Call[]
  settings: Settings
  settingsStatus: number
  settingsPending: boolean
  axes: Array<{ app: string; kinds: string[]; filterableAxes: string[] }>
  rules: Array<{
    id: string
    source: string
    kinds: string[]
    filters: Record<string, string[]>
    enabled: boolean
  }>
  conversations: {
    muted: Array<{ threadId: string; title: string | null; type: string }>
    allPosts: Array<{ threadId: string; title: string | null; type: string }>
  }
  onCall: {
    source: "list" | "admins"
    onCall: Array<{ id: string; name: string }>
    canEdit: boolean
    members: Array<{ id: string; name: string }>
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** The server half of the contract, as far as these tests lean on it. */
function applyPatch(settings: Settings, body: any): Settings {
  const next: Settings = structuredClone(settings)
  if (body.grid) {
    for (const [group, cells] of Object.entries(body.grid as Grid)) {
      for (const [channel, value] of Object.entries(cells)) next.grid[group]![channel] = value
      if (cells.email === true && next.digestCadence === "off") next.digestCadence = "daily"
    }
  }
  if (body.digestCadence) next.digestCadence = body.digestCadence
  if (body.approvalReminder) next.approvalReminder = body.approvalReminder
  if (body.workHours) next.workHours = { ...next.workHours, ...body.workHours, explicit: true }
  if (body.timezone) next.workHours.timezone = body.timezone
  if (body.mutedGroups) {
    const muted = new Set(next.mutedGroups ?? [])
    for (const [g, on] of Object.entries(body.mutedGroups as Record<string, boolean>)) {
      if (on) muted.add(g)
      else muted.delete(g)
    }
    next.mutedGroups = [...muted]
  }
  if (next.digestCadence === "off")
    for (const g of Object.keys(next.grid)) next.grid[g]!.email = false
  return next
}

function installFetch(fake: Fake): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      fake.calls.push({ url, method, body })
      if (url.endsWith("/notifications/settings")) {
        if (method === "GET") {
          if (fake.settingsPending) return new Promise<Response>(() => {})
          if (fake.settingsStatus !== 200) {
            return json({ error: { message: "boom" } }, fake.settingsStatus)
          }
          return json({ data: fake.settings })
        }
        if (method === "PATCH") {
          fake.settings = applyPatch(fake.settings, body)
          return json({ data: fake.settings })
        }
      }
      if (url.endsWith("/notifications/conversations")) return json({ data: fake.conversations })
      const state = url.match(/\/threads\/([^/?]+)\/state$/)
      if (state && method === "PATCH") return json({ data: { state: body } })
      if (url.endsWith("/notifications/on-call")) {
        if (method === "PUT") {
          const ids = body.userIds as string[]
          fake.onCall = {
            ...fake.onCall,
            source: ids.length > 0 ? "list" : "admins",
            onCall: fake.onCall.members.filter((m) => ids.includes(m.id)),
          }
        }
        return json({ data: fake.onCall })
      }
      if (url.endsWith("/apps/manifests/attention-axes")) return json({ data: fake.axes })
      if (url.endsWith("/attention/subscriptions") && method === "GET") {
        return json({ data: fake.rules })
      }
      if (url.endsWith("/attention/subscriptions") && method === "POST") {
        const id = `rule-${fake.rules.length + 1}`
        fake.rules.push({ id, ...body })
        return json({ data: { id } }, 201)
      }
      const put = url.match(/\/attention\/subscriptions\/([^/?]+)$/)
      if (put && method === "PUT") {
        const idx = fake.rules.findIndex((r) => r.id === put[1])
        if (idx >= 0) fake.rules[idx] = { id: put[1]!, ...body }
        return json({ data: { id: put[1] } })
      }
      return json({ data: null }, 404)
    }),
  )
}

function renderPage() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <NotificationSettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

function cell(group: string, channel: string): HTMLInputElement {
  return screen.getByTestId(`notif-cell-${group}-${channel}`) as HTMLInputElement
}

function patches(fake: Fake): Call[] {
  return fake.calls.filter((c) => c.method === "PATCH")
}

let fake: Fake

beforeEach(() => {
  device.permission = "granted"
  device.afterRequest = "granted"
  device.requests = 0
  device.desktopApp = false
  fake = {
    calls: [],
    settings: sampleSettings(),
    settingsStatus: 200,
    settingsPending: false,
    axes: [
      {
        app: "shopify",
        kinds: [
          "shopify:order.created",
          "shopify:orders.unfulfilled",
          "shopify:refund.created",
          "shopify:return.requested",
        ],
        filterableAxes: ["market", "order_value_band"],
      },
      { app: "acme", kinds: ["acme:widget.stalled"], filterableAxes: [] },
    ],
    rules: [],
    conversations: {
      muted: [{ threadId: "t-muted", title: "Release room", type: "thread" }],
      allPosts: [{ threadId: "t-loud", title: "Support", type: "thread" }],
    },
    onCall: {
      source: "admins",
      onCall: [{ id: "u-admin", name: "Ada" }],
      canEdit: true,
      members: [
        { id: "u-admin", name: "Ada" },
        { id: "u-bob", name: "Bob" },
      ],
    },
  }
  installFetch(fake)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
})

describe("the grid", () => {
  it("renders every group and channel from the settings the server returns", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    const grid = screen.getByTestId("notif-grid")
    expect(within(grid).getByText("Direct messages and mentions")).toBeInTheDocument()
    expect(within(grid).getByText("System alerts")).toBeInTheDocument()
    for (const group of Object.keys(defaultGrid())) {
      for (const channel of CHANNELS) {
        expect(cell(group, channel).checked).toBe(defaultGrid()[group]![channel])
      }
    }
  })

  it("toggling one cell sends that cell and nothing else", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    fireEvent.click(cell("replies", "push"))
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    expect(patches(fake)[0]!.body).toEqual({ grid: { replies: { push: false } } })
    await waitFor(() => expect(cell("replies", "push").checked).toBe(false))
    expect(cell("direct", "push").checked).toBe(true)
  })

  it("shows the in-app column checked and not switchable, with the reason", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    for (const group of Object.keys(defaultGrid())) {
      expect(cell(group, "in_app").checked).toBe(true)
      expect(cell(group, "in_app").disabled).toBe(true)
    }
    expect(screen.getByTestId("notif-in-app-why").textContent?.length).toBeGreaterThan(10)
    fireEvent.click(cell("direct", "in_app"))
    await Promise.resolve()
    expect(patches(fake)).toHaveLength(0)
  })

  it("puts the cell back and says so when the save fails", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { message: "nope" } }, 500)),
    )
    fireEvent.click(cell("work", "push"))
    await waitFor(() => expect(cell("work", "push").checked).toBe(false))
  })
})

describe("computer sessions", () => {
  const SESSION_GROUPS = [
    { id: "session_needs_you", label: "Computer session needs you" },
    { id: "session_done", label: "Computer session done" },
    { id: "session_failed", label: "Computer session failed" },
  ]

  function withSessionGroups(sections: boolean): void {
    const s = fake.settings as Settings & { sections?: unknown }
    // The API lists the session groups before "system".
    const system = s.groups.pop()!
    for (const g of SESSION_GROUPS) {
      s.groups.push({ ...g, labelKey: `notifications.groups.${g.id}` })
      s.grid[g.id] = row(true, true, false)
      s.defaults[g.id] = row(true, true, false)
    }
    s.groups.push(system)
    if (sections) {
      s.sections = [
        {
          id: "sessions",
          label: "Computer sessions",
          labelKey: "notifications.sections.sessions",
          groups: SESSION_GROUPS.map((g) => g.id),
        },
      ]
    }
  }

  function sessionRowsUnderHeading(): string[] {
    const heading = screen.getByTestId("notif-section-sessions")
    expect(heading.textContent).toBe("Computer sessions")
    const body = heading.closest("tbody")!
    return [...body.querySelectorAll("tr[data-testid^='notif-row-']")].map(
      (tr) => tr.querySelector("th")!.textContent ?? "",
    )
  }

  it("S11: the grid shows a Computer sessions heading with Needs you, Done, Failed; toggling Done phone sends {session_done:{push:false}}", async () => {
    withSessionGroups(true)
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    expect(sessionRowsUnderHeading()).toEqual(["Needs you", "Done", "Failed"])
    // The rows outside the section keep their order, "system" included.
    const firstBody = screen.getByTestId("notif-row-direct").closest("tbody")!
    expect(firstBody.querySelector("[data-testid='notif-row-system']")).not.toBeNull()
    expect(firstBody.querySelector("[data-testid='notif-row-session_done']")).toBeNull()
    expect(cell("session_done", "push").checked).toBe(true)
    expect(cell("session_done", "email").checked).toBe(false)
    expect(cell("session_done", "push").getAttribute("aria-label")).toContain(
      "Computer session done",
    )
    fireEvent.click(cell("session_done", "push"))
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    expect(patches(fake)[0]!.body).toEqual({ grid: { session_done: { push: false } } })
    await waitFor(() => expect(cell("session_done", "push").checked).toBe(false))
  })

  it("S11: the heading still groups the three rows when the API sends no sections", async () => {
    withSessionGroups(false)
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    expect(sessionRowsUnderHeading()).toEqual(["Needs you", "Done", "Failed"])
  })

  it("S11: the in-app cell is checked and disabled", async () => {
    withSessionGroups(true)
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    for (const g of SESSION_GROUPS) {
      expect(cell(g.id, "in_app").checked).toBe(true)
      expect(cell(g.id, "in_app").disabled).toBe(true)
    }
    fireEvent.click(cell("session_failed", "in_app"))
    await Promise.resolve()
    expect(patches(fake)).toHaveLength(0)
  })
})

describe("the digest cadence", () => {
  it("shows every email cell off when the cadence is off, whatever the grid says", async () => {
    fake.settings.digestCadence = "off"
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    for (const group of Object.keys(defaultGrid())) expect(cell(group, "email").checked).toBe(false)
    expect(screen.getByTestId("notif-cadence-off-note")).toBeInTheDocument()
  })

  it("choosing off sends the cadence and turns the email column off", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    expect(cell("direct", "email").checked).toBe(true)
    fireEvent.click(screen.getByTestId("attention-cadence-off"))
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    expect(patches(fake)[0]!.body).toEqual({ digestCadence: "off" })
    await waitFor(() => expect(cell("direct", "email").checked).toBe(false))
  })

  it("turning one email cell on while off takes the cadence the server returns", async () => {
    fake.settings = applyPatch(fake.settings, { digestCadence: "off" })
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    fireEvent.click(cell("direct", "email"))
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    expect(patches(fake)[0]!.body).toEqual({ grid: { direct: { email: true } } })
    await waitFor(() =>
      expect(
        (screen.getByTestId("attention-cadence-daily").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(true),
    )
  })
})

describe("approval reminders", () => {
  const option = (value: string) =>
    screen
      .getByTestId(`approval-reminder-frequency-${value}`)
      .querySelector("input") as HTMLInputElement

  it("sits right under the grid, labelled, with Daily chosen when the person never chose", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("approval-reminder")).toBeInTheDocument())
    const section = screen.getByTestId("approval-reminder")
    expect(section.textContent).toContain("Remind me of my requests waiting for approval")
    expect(section.textContent).toContain(
      "Your agent reminds you of requests you made that are still waiting for a decision.",
    )
    // Placed after the grid, before the email digest.
    const grid = screen.getByTestId("notif-grid")
    const digest = screen.getByTestId("attention-cadence")
    expect(grid.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(section.compareDocumentPosition(digest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      within(screen.getByTestId("approval-reminder-frequency"))
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["daily", "every_3_days", "weekly", "off"])
    expect(option("daily").checked).toBe(true)
    expect(screen.getByTestId("approval-reminder-hint").textContent).toContain("Once a day")
  })

  it("choosing Weekly saves only that, and Off says no reminders are sent", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("approval-reminder")).toBeInTheDocument())
    fireEvent.click(option("weekly"))
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    expect(patches(fake)[0]!.body).toEqual({ approvalReminder: "weekly" })
    await waitFor(() => expect(option("weekly").checked).toBe(true))
    fireEvent.click(option("off"))
    await waitFor(() => expect(patches(fake)).toHaveLength(2))
    expect(patches(fake)[1]!.body).toEqual({ approvalReminder: "off" })
    await waitFor(() =>
      expect(screen.getByTestId("approval-reminder-hint").textContent).toContain("No reminders"),
    )
  })

  it("shows the stored choice", async () => {
    fake.settings.approvalReminder = "every_3_days"
    renderPage()
    await waitFor(() => expect(screen.getByTestId("approval-reminder")).toBeInTheDocument())
    expect(option("every_3_days").checked).toBe(true)
  })
})

describe("work hours", () => {
  it("saves hours, days and timezone without touching the grid", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    fireEvent.input(screen.getByTestId("attention-work-hours-start"), {
      target: { value: "08:00" },
    })
    fireEvent.click(screen.getByTestId("attention-workday-7"))
    fireEvent.click(screen.getByTestId("attention-save"))
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    const body = patches(fake)[0]!.body
    expect(body.grid).toBeUndefined()
    expect(body.digestCadence).toBeUndefined()
    // Sunday is 0 on the wire, 7 on the screen.
    expect(body.workHours).toEqual({ start: "08:00", end: "17:00", days: [0, 1, 2, 3, 4, 5] })
    expect(body.timezone).toBe("Europe/Paris")
    await waitFor(() => expect(screen.queryByTestId("attention-save")).toBeNull())
    expect(cell("replies", "push").checked).toBe(true)
    expect(cell("direct", "push").checked).toBe(true)
  })

  it("says when the hours are still the defaults and do not hold anything back", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-work-hours-default")).toBeInTheDocument())
  })

  it("refuses to save with no work day", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    for (const iso of [1, 2, 3, 4, 5])
      fireEvent.click(screen.getByTestId(`attention-workday-${iso}`))
    expect(screen.getByTestId("attention-workdays-error")).toBeInTheDocument()
    expect((screen.getByTestId("attention-save") as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("per-app rules", () => {
  it("never prints a raw kind id", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("attention-rules-row-acme")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
    const text = document.body.textContent ?? ""
    for (const raw of [
      "shopify:order.created",
      "order.created",
      "acme:widget.stalled",
      "widget.stalled",
      "thread_reply",
      "in_app",
      "sla_risk",
    ]) {
      expect(text, raw).not.toContain(raw)
    }
    // Filterable axes are field names ("market", "order_value_band"), not controls.
    expect(
      within(screen.getByTestId("attention-rules-row-shopify")).queryByText("market"),
    ).toBeNull()
    const shopify = screen.getByTestId("attention-rules-row-shopify")
    expect(within(shopify).getByText("New orders")).toBeInTheDocument()
    expect(
      within(screen.getByTestId("attention-rules-row-acme")).getByText("Widget stalled"),
    ).toBeInTheDocument()
  })

  it("has a Liaison row where replies can be dropped and mentions and system alerts always come through", async () => {
    renderPage()
    const kernel = await screen.findByTestId("attention-rules-row-kernel")
    for (const locked of ["mention", "system_alert"]) {
      const box = within(kernel).getByTestId(
        `attention-rules-kind-kernel-${locked}`,
      ) as HTMLInputElement
      expect(box.checked, locked).toBe(true)
      expect(box.disabled, locked).toBe(true)
    }
    expect(within(kernel).getAllByText("Always delivered, whatever the rules.")).toHaveLength(2)
    const reply = within(kernel).getByTestId(
      "attention-rules-kind-kernel-thread_reply",
    ) as HTMLInputElement
    expect(reply.checked).toBe(true)
    fireEvent.click(reply)
    await waitFor(() => expect(fake.rules).toHaveLength(1))
    expect(fake.rules[0]).toMatchObject({ source: "kernel", enabled: true, filters: {} })
    expect([...fake.rules[0]!.kinds].sort()).toEqual(
      KERNEL_RULE_KINDS.filter((k) => k !== "thread_reply").sort(),
    )
    await waitFor(() => expect(reply.checked).toBe(false))
  })

  it("unticking one kind of an app keeps the others", async () => {
    renderPage()
    const shopify = await screen.findByTestId("attention-rules-row-shopify")
    const boxes = within(shopify).getAllByRole("checkbox") as HTMLInputElement[]
    expect(boxes).toHaveLength(4)
    expect(boxes.every((b) => b.checked)).toBe(true)
    fireEvent.click(boxes[0]!)
    await waitFor(() => expect(fake.rules).toHaveLength(1))
    expect(fake.rules[0]).toMatchObject({ source: "shopify", enabled: true })
    expect(fake.rules[0]!.kinds).toEqual([
      "shopify:orders.unfulfilled",
      "shopify:refund.created",
      "shopify:return.requested",
    ])
  })

  it("ticking every kind back stores no narrowing", async () => {
    fake.rules = [
      {
        id: "r1",
        source: "shopify",
        kinds: ["shopify:orders.unfulfilled", "shopify:refund.created", "shopify:return.requested"],
        filters: {},
        enabled: true,
      },
    ]
    renderPage()
    const shopify = await screen.findByTestId("attention-rules-row-shopify")
    await waitFor(() =>
      expect((within(shopify).getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(false),
    )
    fireEvent.click(within(shopify).getAllByRole("checkbox")[0]!)
    await waitFor(() => expect(fake.calls.some((c) => c.method === "PUT")).toBe(true))
    expect(fake.rules[0]).toMatchObject({ id: "r1", kinds: [], enabled: true })
  })

  it("switching an app off stores a disabled rule", async () => {
    renderPage()
    const toggle = await screen.findByTestId("attention-rules-toggle-shopify")
    fireEvent.click(toggle)
    await waitFor(() => expect(fake.rules).toHaveLength(1))
    expect(fake.rules[0]).toMatchObject({ source: "shopify", enabled: false })
  })

  it("keeps the Liaison row when no app declares notifications", async () => {
    fake.axes = []
    renderPage()
    await screen.findByTestId("attention-rules-row-kernel")
    expect(screen.getByTestId("attention-rules-empty")).toBeInTheDocument()
  })
})

describe("this device", () => {
  it("in a browser that allows notifications, says so with no button", async () => {
    renderPage()
    const row = await screen.findByTestId("notif-device")
    await waitFor(() =>
      expect(within(row).getByTestId("notif-device-state").dataset.state).toBe("granted"),
    )
    expect(within(row).queryByTestId("notif-device-request")).toBeNull()
  })

  it("asks when the browser has not been asked yet", async () => {
    device.permission = "default"
    renderPage()
    const button = await screen.findByTestId("notif-device-request")
    fireEvent.click(button)
    await waitFor(() => expect(device.requests).toBe(1))
    await waitFor(() =>
      expect(screen.getByTestId("notif-device-state").dataset.state).toBe("granted"),
    )
  })

  it("explains how to unblock when the browser refused", async () => {
    device.permission = "denied"
    renderPage()
    await screen.findByTestId("notif-device-blocked")
    expect(screen.queryByTestId("notif-device-request")).toBeNull()
  })

  it("says when there are no notifications here at all", async () => {
    device.permission = "unsupported"
    renderPage()
    const row = await screen.findByTestId("notif-device")
    await waitFor(() =>
      expect(within(row).getByTestId("notif-device-state").dataset.state).toBe("unsupported"),
    )
  })

  // P1-T6: the shell now reads the system's own setting, so "on" is the
  // system's answer, and the hint says the app keeps notifying from the tray.
  it("in the desktop app, says notifications are on, also with the window closed", async () => {
    device.desktopApp = true
    renderPage()
    const row = await screen.findByTestId("notif-device")
    await waitFor(() => expect(row.dataset.device).toBe("desktop_app"))
    const hint = await screen.findByTestId("notif-device-desktop-hint")
    expect(hint.textContent).toMatch(/window is closed/)
    expect(screen.queryByTestId("notif-device-request")).toBeNull()
  })

  it("in the desktop app, launch at login is a switch, on by default, that turns off (P1-T6)", async () => {
    device.desktopApp = true
    const setLaunchAtLogin = vi.fn(async (enabled: boolean) => enabled)
    installFakeBridge()
    Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
      launchAtLogin: async () => true,
      setLaunchAtLogin,
    })
    try {
      renderPage()
      const toggle = await screen.findByTestId("notif-launch-at-login-switch")
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"))
      fireEvent.click(toggle)
      await waitFor(() => expect(setLaunchAtLogin).toHaveBeenCalledWith(false))
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"))
    } finally {
      uninstallFakeBridge()
    }
  })

  it("in a browser, there is no launch at login switch", async () => {
    renderPage()
    await screen.findByTestId("notif-device")
    expect(screen.queryByTestId("notif-launch-at-login")).toBeNull()
  })

  it("on the phone, reads and asks for the push permission through the shell", async () => {
    let state: "prompt" | "granted" | "denied" = "prompt"
    const request = vi.fn(async () => {
      state = "granted"
      return state
    })
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      pushPermission: { check: async () => state, request },
    }
    renderPage()
    const row = await screen.findByTestId("notif-device")
    await waitFor(() => expect(row.dataset.device).toBe("phone"))
    fireEvent.click(await screen.findByTestId("notif-device-request"))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId("notif-device-state").dataset.state).toBe("granted"),
    )
    expect(device.requests).toBe(0)
  })

  it("on the phone, a refused permission shows the way to the system settings", async () => {
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      pushPermission: { check: async () => "denied", request: async () => "denied" },
    }
    renderPage()
    const blocked = await screen.findByTestId("notif-device-blocked")
    expect(blocked.textContent).toMatch(/Settings/)
  })
})

describe("loading and errors", () => {
  it("shows a placeholder while the settings load", async () => {
    fake.settingsPending = true
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("notification-settings-loading")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("notif-grid")).toBeNull()
  })

  it("shows the error with a retry that loads again", async () => {
    fake.settingsStatus = 500
    renderPage()
    const retry = await screen.findByTestId("notification-settings-retry")
    fake.settingsStatus = 200
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId("notif-grid")).toBeInTheDocument())
  })
})

describe("rules 7, 9 and 10: one place to tune it", () => {
  it("sets a kind to inbox only (computer and phone off) and to off (muted)", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-kind-modes")).toBeInTheDocument())
    const agent = screen.getByTestId("notif-kind-mode-agent-interrupt").querySelector("input")!
    expect(agent.checked).toBe(true)
    fireEvent.click(screen.getByTestId("notif-kind-mode-agent-inbox").querySelector("input")!)
    await waitFor(() => expect(patches(fake)).toHaveLength(1))
    expect(patches(fake)[0]!.body).toEqual({
      mutedGroups: { agent: false },
      grid: { agent: { desktop: false, push: false } },
    })
    fireEvent.click(screen.getByTestId("notif-kind-mode-agent-off").querySelector("input")!)
    await waitFor(() => expect(patches(fake)).toHaveLength(2))
    expect(patches(fake)[1]!.body).toEqual({ mutedGroups: { agent: true } })
    await waitFor(() =>
      expect(
        (screen.getByTestId("notif-kind-mode-agent-off").querySelector("input") as HTMLInputElement)
          .checked,
      ).toBe(true),
    )
  })

  it("lists muted conversations with Unmute, and channels set to every message", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-muted-t-muted")).toBeInTheDocument())
    expect(screen.getByTestId("notif-muted-t-muted")).toHaveTextContent("Release room")
    expect(screen.getByTestId("notif-allPosts-t-loud")).toHaveTextContent("Support")
    fireEvent.click(screen.getByTestId("notif-muted-action-t-muted"))
    await waitFor(() => expect(screen.getByTestId("notif-muted-empty")).toBeInTheDocument())
    const call = fake.calls.find((c) => c.url.endsWith("/threads/t-muted/state"))
    expect(call).toMatchObject({ method: "PATCH", body: { isMuted: false } })
    fireEvent.click(screen.getByTestId("notif-allPosts-action-t-loud"))
    await waitFor(() =>
      expect(fake.calls.find((c) => c.url.endsWith("/threads/t-loud/state"))?.body).toEqual({
        notifyAllPosts: false,
      }),
    )
  })

  it("an admin picks who is on call; with nobody picked the admins are", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("notif-on-call-default")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("notif-on-call-member-u-bob"))
    fireEvent.click(screen.getByTestId("notif-on-call-save"))
    await waitFor(() =>
      expect(fake.calls.find((c) => c.method === "PUT")?.body).toEqual({ userIds: ["u-bob"] }),
    )
    await waitFor(() =>
      expect(screen.queryByTestId("notif-on-call-default")).not.toBeInTheDocument(),
    )
  })

  it("a member sees who is on call without an editor", async () => {
    fake.onCall = { ...fake.onCall, canEdit: false, members: [] }
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("notif-on-call-person-u-admin")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("notif-on-call-save")).not.toBeInTheDocument()
    expect(screen.queryByTestId("notif-on-call-members")).not.toBeInTheDocument()
  })
})
