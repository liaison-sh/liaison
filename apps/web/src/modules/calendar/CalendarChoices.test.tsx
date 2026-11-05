// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Calendar settings page's Calendars block: a failed import shows its error and a Retry
// (production 2026-10-05), and a calendar checkbox rolls back with the server's reason when
// set_selected is refused. Connecting and disconnecting accounts is the connections block.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

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

import { CalendarChoices } from "~/modules/calendar/CalendarChoices"

const SERVICE_DISABLED =
  "The Google Calendar API is not enabled in the Google Cloud project used for this connection."

describe("CalendarChoices", () => {
  afterEach(() => cleanup())

  it("shows a failed account's error with a Retry button", async () => {
    mocks.api.post.mockImplementation(async (url: string) =>
      url.endsWith("/list_accounts")
        ? [
            {
              id: "acc-1",
              identifier: "me@example.com",
              displayName: null,
              ownerType: "user",
              status: "error",
              lastSyncError: SERVICE_DISABLED,
              createdAt: "2026-10-05T00:00:00Z",
            },
          ]
        : {},
    )
    render(() => <CalendarChoices />)
    await waitFor(() =>
      expect(screen.getByTestId("calendar-connection-error")).toHaveTextContent(SERVICE_DISABLED),
    )
    fireEvent.click(screen.getByTestId("calendar-connection-retry"))
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith("/apps/calendar/tools/retry_import", {
        params: { accountId: "acc-1" },
      }),
    )
  })

  // A revoked Google grant (the import answered 401): the page says so, next to
  // the account the connections block above offers to Reconnect.
  it("says an account must be reconnected when its access was revoked", async () => {
    mocks.api.post.mockImplementation(async (url: string) =>
      url.endsWith("/list_accounts")
        ? [
            {
              id: "acc-2",
              identifier: "revoked@example.com",
              displayName: null,
              ownerType: "org",
              status: "reauth-required",
              lastSyncError: null,
              createdAt: "2026-10-05T00:00:00Z",
            },
          ]
        : {},
    )
    render(() => <CalendarChoices />)
    const banner = await screen.findByTestId("calendar-reauth-banner")
    expect(banner).toHaveTextContent("revoked@example.com")
    expect(banner).toHaveTextContent("Reconnect required")
  })

  it("rolls a calendar checkbox back and shows the error when set_selected fails", async () => {
    mocks.store.calendars = [
      { id: "cal-1", name: "Work", color: null, accessRole: "owner", selected: true },
    ]
    mocks.api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("/list_accounts")) return []
      if (url.endsWith("/set_selected")) {
        throw new Error("calendar: could not update calendar cal-1 (no write access)")
      }
      return {}
    })
    render(() => <CalendarChoices />)
    const box = (await screen.findByTestId("calendar-select-cal-1")) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    await waitFor(() =>
      expect(screen.getByTestId("calendar-select-error")).toHaveTextContent(
        "could not update calendar cal-1",
      ),
    )
    expect(box.checked).toBe(true)
  })

  it("hides Retry on an org account from a member and shows it to a calendar admin", async () => {
    const orgFailed = {
      id: "acc-org",
      identifier: "org@example.com",
      displayName: null,
      ownerType: "org",
      status: "error",
      lastSyncError: SERVICE_DISABLED,
      createdAt: "2026-10-05T00:00:00Z",
    }
    mocks.api.post.mockImplementation(async (url: string) =>
      url.endsWith("/list_accounts") ? [orgFailed] : {},
    )
    mocks.admin = false
    render(() => <CalendarChoices />)
    await screen.findByTestId("calendar-connection-error")
    expect(screen.queryByTestId("calendar-connection-retry")).toBeNull()
    cleanup()

    mocks.admin = true
    render(() => <CalendarChoices />)
    expect(await screen.findByTestId("calendar-connection-retry")).toBeInTheDocument()
    mocks.admin = false
  })

  it("shows a refused retry's error inline", async () => {
    mocks.api.post.mockImplementation(async (url: string) => {
      if (url.endsWith("/list_accounts")) {
        return [
          {
            id: "acc-1",
            identifier: "me@example.com",
            displayName: null,
            ownerType: "user",
            status: "error",
            lastSyncError: SERVICE_DISABLED,
            createdAt: "2026-10-05T00:00:00Z",
          },
        ]
      }
      if (url.endsWith("/retry_import")) throw new Error("calendar account acc-1 not found")
      return {}
    })
    render(() => <CalendarChoices />)
    fireEvent.click(await screen.findByTestId("calendar-connection-retry"))
    await waitFor(() =>
      expect(screen.getByTestId("calendar-connection-retry-error")).toHaveTextContent(
        "calendar account acc-1 not found",
      ),
    )
  })
})
