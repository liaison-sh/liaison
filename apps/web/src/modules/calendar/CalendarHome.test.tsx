// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The calendar home with no calendar to show (production 2026-10-05): a connected account whose
// import failed showed "Connect a Google account" as if nothing were connected. The home now
// shows the account's state (importing, failed with its error, nothing selected) and offers
// "Connect" only to a user with no visible account (Settings: CalendarChoices.test.tsx).
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async (_url: string, _body?: unknown): Promise<unknown> => ({})),
    delete: vi.fn(async (_url: string): Promise<unknown> => ({})),
  },
  admin: false,
  grants: [] as string[],
  store: {
    events: [] as any[],
    calendars: [] as any[],
    accounts: [] as any[],
    accountsLoaded: true,
    accountsError: null as string | null,
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))
vi.mock("~/modules/auth/auth-store", () => ({
  // Same matching as the real web hasScope: '*', exact, or a prefix grant ('calendar').
  hasScope: (scope: string) =>
    mocks.grants.some((g) => g === "*" || g === scope || scope.startsWith(`${g}:`)) ||
    (mocks.admin && scope.startsWith("calendar")),
}))
vi.mock("~/modules/calendar/calendar-store", () => ({
  calendarStore: mocks.store,
  createRequestedAt: () => 0,
  focusedDate: () => new Date(2026, 9, 5),
  setFocusedDate: vi.fn(),
  isCalendarVisible: () => true,
  loadAccountsList: vi.fn(),
  loadCalendarsList: vi.fn(),
  loadEventsForWindow: vi.fn(),
  loadPreferredView: () => "month",
  persistPreferredView: vi.fn(),
}))
vi.mock("~/modules/calendar/EventDialog", () => ({ EventDialog: () => null }))

import { CalendarShell, calendarHomeState } from "~/modules/calendar/CalendarShell"
import { canManageOrgCalendars } from "~/modules/calendar/calendar-api"

const SERVICE_DISABLED =
  "The Google Calendar API is not enabled in the Google Cloud project used for this connection."

function account(over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    connectionName: "google-calendar",
    ownerType: "user",
    identifier: "me@example.com",
    status: "active",
    lastSyncError: null,
    createdAt: "2026-10-05T00:00:00Z",
    ...over,
  } as any
}

describe("calendarHomeState", () => {
  it("offers Connect only when no account is visible, and waits for the accounts first", () => {
    expect(calendarHomeState([], false).kind).toBe("loading")
    expect(calendarHomeState([], true).kind).toBe("connect")
    expect(calendarHomeState([account({ status: "error" })], true).kind).toBe("error")
    expect(calendarHomeState([account({ status: "reauth-required" })], true).kind).toBe("error")
    expect(calendarHomeState([account({ status: "pre-sync" })], true).kind).toBe("syncing")
    expect(calendarHomeState([account({ status: "syncing" })], true).kind).toBe("syncing")
    expect(calendarHomeState([account({ status: "active" })], true).kind).toBe("empty")
    expect(calendarHomeState([], true, "boom")).toEqual({ kind: "loadError", message: "boom" })
    expect(calendarHomeState([account({ status: "active" })], true, "boom").kind).toBe("empty")
  })
})

describe("CalendarShell home with no calendars", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.calendars = []
    mocks.store.accounts = []
    mocks.store.accountsLoaded = true
    mocks.store.accountsError = null
    mocks.admin = false
  })
  afterEach(() => cleanup())

  it("does not offer Connect when the accounts could not be read, and says why", () => {
    mocks.store.accountsError = "calendar_listAccounts failed (500)"
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.queryByTestId("calendar-empty-connect")).toBeNull()
    expect(screen.getByTestId("calendar-accounts-load-error")).toHaveTextContent(
      "calendar_listAccounts failed (500)",
    )
  })

  it("shows Connect when the user has no account", () => {
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-empty-connect")).toBeInTheDocument()
  })

  it("shows the import error and a Retry, not Connect, for a failed account", async () => {
    mocks.store.accounts = [account({ status: "error", lastSyncError: SERVICE_DISABLED })]
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.queryByTestId("calendar-empty-connect")).toBeNull()
    expect(screen.getByTestId("calendar-import-error")).toHaveTextContent("me@example.com")
    expect(screen.getByTestId("calendar-import-error-message")).toHaveTextContent(SERVICE_DISABLED)
    expect(screen.getByTestId("calendar-open-settings")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("calendar-import-retry"))
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith("/apps/calendar/tools/retry_import", {
        params: { accountId: "acc-1" },
      }),
    )
    await waitFor(() => expect(screen.getByTestId("calendar-retry-queued")).toBeInTheDocument())
  })

  it("shows that the import is running for a syncing account", () => {
    mocks.store.accounts = [account({ status: "pre-sync" })]
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.queryByTestId("calendar-empty-connect")).toBeNull()
    expect(screen.getByTestId("calendar-syncing")).toBeInTheDocument()
  })

  it("points to settings when an active account has no calendar selected", () => {
    mocks.store.accounts = [account({ status: "active" })]
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.queryByTestId("calendar-empty-connect")).toBeNull()
    expect(screen.getByTestId("calendar-none-selected")).toBeInTheDocument()
  })

  it("treats an account whose only calendar is unticked as having none selected", () => {
    // list_calendars returns unticked calendars too (Settings needs them to tick them again).
    mocks.store.accounts = [account({ status: "active" })]
    mocks.store.calendars = [
      { id: "cal-off", name: "Holidays", color: null, accessRole: "reader", selected: false },
    ]
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-none-selected")).toBeInTheDocument()
  })
})

describe("CalendarShell retry permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.calendars = []
    mocks.store.accountsLoaded = true
    mocks.admin = false
  })
  afterEach(() => cleanup())

  it("offers Retry on a failed org account only to a calendar admin", () => {
    mocks.store.accounts = [account({ ownerType: "org", status: "error", lastSyncError: "x" })]
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-import-error")).toBeInTheDocument()
    expect(screen.queryByTestId("calendar-import-retry")).toBeNull()
    cleanup()

    mocks.admin = true
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-import-retry")).toBeInTheDocument()
  })

  it("shows a refused retry's error inline instead of claiming it restarted", async () => {
    mocks.store.accounts = [account({ status: "error", lastSyncError: "x" })]
    mocks.api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("/retry_import")) throw new Error("calendar account acc-1 not found")
      return {}
    })
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    fireEvent.click(screen.getByTestId("calendar-import-retry"))
    await waitFor(() =>
      expect(screen.getByTestId("calendar-import-retry-error")).toHaveTextContent(
        "calendar account acc-1 not found",
      ),
    )
    expect(screen.queryByTestId("calendar-retry-queued")).toBeNull()
  })

  it("lets every grant the server's org-connect check accepts manage org calendars", () => {
    for (const grant of ["*", "calendar:*", "calendar", "calendar:accounts:admin"]) {
      mocks.grants = [grant]
      expect(canManageOrgCalendars(), grant).toBe(true)
    }
    mocks.grants = ["calendar:events:write"]
    expect(canManageOrgCalendars()).toBe(false)
    mocks.grants = []
  })
})
