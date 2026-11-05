// SPDX-License-Identifier: FSL-1.1-ALv2
// The Calendar settings page rendered from the REAL calendar manifest
// `settings`: one "Calendar accounts" section any member sees, holding the
// google-calendar connections block and the CalendarChoices block.
import { Route, Router } from "@solidjs/router"
import { render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import calendarManifest from "../../../../api/src/apps/calendar/app.manifest.json"
import { createFakeApi, type FakeApi } from "../settings/app-page/__fixtures__/fake-api"
import type { AppSettingsManifest } from "../settings/app-page/types"

const state = vi.hoisted(() => ({ api: null as unknown, scopes: [] as string[] }))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  const has = (s: string) => state.scopes.includes("*") || state.scopes.includes(s)
  return { ...actual, hasScope: has, canAccessScope: (s?: string | null) => !s || has(s) }
})

import { AppSettingsPage } from "../settings/app-page/AppSettingsPage"
import {
  registerAppSettingsPage,
  resetAppSettingsPages,
} from "../settings/app-page/app-settings-pages"

let api: FakeApi

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["calendar:events:read", "calendar:accounts:read"]
  resetAppSettingsPages()
  registerAppSettingsPage({
    appId: "calendar",
    manifest: calendarManifest as unknown as AppSettingsManifest,
    exports: { CalendarChoices: () => <div data-testid="stub-calendar-choices" /> },
  })
  api.on("get", "/apps/calendar/settings/user", () => ({ values: {} }))
  api.on("get", "/apps/calendar/settings/org", () => ({ values: {} }))
  api.on("get", "/apps/calendar/connections", () => [
    { name: "google-calendar", type: "oauth2", accounts: { active: 0, error: 0 } },
  ])
  api.on("get", "/connections/calendar/google-calendar/accounts", () => [])
})

afterEach(() => resetAppSettingsPages())

describe("Calendar settings page", () => {
  it("a member sees the accounts section: the connections block, then CalendarChoices", async () => {
    window.history.pushState({}, "", "/settings/apps/calendar")
    render(() => (
      <Router>
        <Route path="*" component={() => <AppSettingsPage appId="calendar" />} />
      </Router>
    ))
    const section = await screen.findByTestId("settings-section-accounts")
    expect(within(section).getByTestId("settings-block-accounts-0")).toBeTruthy()
    expect(await within(section).findByTestId("stub-calendar-choices")).toBeTruthy()
    await waitFor(() =>
      expect(api.get.mock.calls.map((c) => c[0])).toContain("/apps/calendar/connections"),
    )
  })
})
