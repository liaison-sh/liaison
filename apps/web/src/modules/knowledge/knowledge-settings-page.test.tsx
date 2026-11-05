// SPDX-License-Identifier: FSL-1.1-ALv2
// The Knowledge settings page rendered from the REAL knowledge manifest
// `settings`: the synced sources list on synced_sources.list, Sync now as a
// row action on synced_sources.run_now, Remove on synced_sources.archive after
// an in-place confirm, and the add-source block under it.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import knowledgeManifest from "../../../../api/src/apps/knowledge/app.manifest.json"
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
  state.scopes = ["knowledge:documents:read"]
  resetAppSettingsPages()
  registerAppSettingsPage({
    appId: "knowledge",
    manifest: knowledgeManifest as unknown as AppSettingsManifest,
    exports: { SyncedSourceAdd: () => <div data-testid="stub-synced-source-add" /> },
  })
  api.on("get", "/apps/knowledge/settings/user", () => ({ values: {} }))
  api.on("get", "/apps/knowledge/settings/org", () => ({ values: {} }))
  api.tool("knowledge:synced_sources.list", () => ({
    rows: [
      {
        id: "s1",
        displayName: "Team manual",
        appName: "google-drive",
        scope: "organization",
        lastSyncAt: null,
        lastSyncStatus: "ok",
      },
    ],
  }))
  api.tool("knowledge:synced_sources.run_now", () => ({ id: "s1", enqueued: true }))
  api.tool("knowledge:synced_sources.archive", () => ({ id: "s1", archived: true }))
})

afterEach(() => resetAppSettingsPages())

function renderPage() {
  window.history.pushState({}, "", "/settings/apps/knowledge")
  return render(() => (
    <Router>
      <Route path="*" component={() => <AppSettingsPage appId="knowledge" />} />
    </Router>
  ))
}

describe("Knowledge settings page", () => {
  it("lists the synced sources, runs Sync now on a row, and shows the add-source block", async () => {
    renderPage()
    const section = await screen.findByTestId("settings-section-synced-sources")
    const row = await within(section).findByTestId("settings-list-row-s1")
    expect(row.textContent).toContain("Team manual")
    expect(within(section).getByTestId("stub-synced-source-add")).toBeTruthy()
    fireEvent.click(within(row).getByTestId("settings-list-action-0-s1"))
    await waitFor(() =>
      expect(api.toolCalls()).toContainEqual({
        toolName: "knowledge:synced_sources.run_now",
        params: { id: "s1" },
      }),
    )
  })
})
