// SPDX-License-Identifier: FSL-1.1-ALv2
// The Tickets settings page (S14) rendered from the REAL tickets manifest
// `settings`: one page with Your reply signature, Inboxes, Categories,
// Response times & email, Ticket ID prefixes and API keys. A member sees only
// their signature; each field saves alone through the kernel settings route;
// the categories tree reads `categories.tree` and saves with ONE
// `categories.reorder` on the loaded version; an API key is shown once.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ticketsManifest from "../../../../api/src/apps/tickets/app.manifest.json"
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
const ORG = "/apps/tickets/settings/org"
const USER = "/apps/tickets/settings/user"

function renderPage() {
  window.history.pushState({}, "", "/settings/apps/tickets")
  return render(() => (
    <Router>
      <Route path="*" component={() => <AppSettingsPage appId="tickets" />} />
    </Router>
  ))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  resetAppSettingsPages()
  registerAppSettingsPage({
    appId: "tickets",
    manifest: ticketsManifest as unknown as AppSettingsManifest,
    exports: {
      TicketsInboxRouting: () => <div data-testid="stub-inbox-routing" />,
      TicketsIdSegments: () => <div data-testid="stub-id-segments" />,
    },
  })
  api.on("get", ORG, () => ({ values: { "sla.targets.urgent": 3600, enabled: false } }))
  api.on("get", USER, () => ({ values: { "signature.text": null } }))
  api.on("patch", ORG, (b) => b)
  api.on("patch", USER, (b) => b)
  api.on("get", "/connections/tickets/gmail/accounts", () => [])
  api.on("get", "/connections/tickets/imap/accounts", () => [])
  api.tool("tickets:categories.tree", () => ({
    version: "v7",
    rows: [
      { id: "a", parent_id: null, name: "Billing", sort_order: 0, archived_at: null },
      { id: "b", parent_id: null, name: "Shipping", sort_order: 1, archived_at: null },
    ],
  }))
  api.tool("tickets:categories.reorder", () => ({ version: "v8", ids: {} }))
  api.tool("tickets:apiKeys.list", () => [])
  api.tool("tickets:apiKeys.create", () => ({ id: "k1", label: "Site", key: "tk_secret_once" }))
})

afterEach(() => resetAppSettingsPages())

describe("Tickets settings page", () => {
  it("an admin sees one page: signature first, then the five organization sections", async () => {
    renderPage()
    await screen.findByTestId("settings-section-signature")
    const ids = [...document.querySelectorAll("[data-testid^='settings-section-']")]
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => !id.startsWith("settings-section-scope-"))
      .map((id) => id.replace("settings-section-", ""))
    expect(ids).toEqual([
      "signature",
      "inboxes",
      "categories",
      "response-times",
      "id-segments",
      "api-keys",
    ])
    expect(await screen.findByTestId("stub-inbox-routing")).toBeTruthy()
    expect(await screen.findByTestId("stub-id-segments")).toBeTruthy()
  })

  it("a member sees only their reply signature", async () => {
    state.scopes = ["tickets:tickets:read"]
    renderPage()
    await screen.findByTestId("settings-section-signature")
    expect(screen.queryByTestId("settings-section-inboxes")).toBeNull()
    expect(screen.queryByTestId("settings-section-categories")).toBeNull()
    expect(screen.queryByTestId("settings-section-api-keys")).toBeNull()
  })

  it("a support lead with categories admin only sees signature and categories", async () => {
    state.scopes = ["tickets:tickets:read", "tickets:categories:admin"]
    renderPage()
    await screen.findByTestId("settings-section-categories")
    expect(screen.queryByTestId("settings-section-response-times")).toBeNull()
    expect(screen.queryByTestId("settings-section-inboxes")).toBeNull()
  })

  it("the signature saves alone: PATCH user { path: signature.text }", async () => {
    renderPage()
    const input = await screen.findByTestId("settings-input-signature.text")
    fireEvent.input(input, { target: { value: "Best,\nAlex" } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        USER,
        { path: "signature.text", value: "Best,\nAlex" },
        expect.anything(),
      ),
    )
  })

  it("approve replies from Home is a toggle saved as the tool field `enabled`", async () => {
    renderPage()
    const toggle = await screen.findByTestId("settings-input-enabled")
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        ORG,
        { path: "enabled", value: true },
        expect.anything(),
      ),
    )
  })

  it("categories: loaded from categories.tree, renamed, saved by ONE reorder on the loaded version", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("tree-name-b"))
    const input = screen.getByTestId("tree-rename-input")
    fireEvent.input(input, { target: { value: "Delivery" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.click(screen.getByTestId("tree-save"))
    await waitFor(() =>
      expect(
        api.toolCalls().filter((c) => c.toolName === "tickets:categories.reorder"),
      ).toHaveLength(1),
    )
    const call = api.toolCalls().find((c) => c.toolName === "tickets:categories.reorder")
    expect(call?.params).toMatchObject({
      baseVersion: "v7",
      nodes: [
        { id: "a", parentId: null, name: "Billing", sortOrder: 0 },
        { id: "b", parentId: null, name: "Delivery", sortOrder: 1 },
      ],
    })
  })

  it("an API key is created from the list and its secret shown once", async () => {
    renderPage()
    const section = await screen.findByTestId("settings-section-api-keys")
    fireEvent.click(await within(section).findByTestId("settings-list-add"))
    fireEvent.input(within(section).getByTestId("settings-list-create-label"), {
      target: { value: "Site" },
    })
    fireEvent.click(within(section).getByTestId("settings-list-create-submit"))
    fireEvent.click(within(section).getByTestId("settings-list-save"))
    const reveal = await within(section).findByTestId("settings-list-reveal")
    expect(reveal.textContent).toContain("tk_secret_once")
    const create = api.toolCalls().find((c) => c.toolName === "tickets:apiKeys.create")
    expect(create?.params).toMatchObject({ label: "Site" })
  })

  it("an API key row: human last-used date, no empty labels, and Revoke (asked first) revokes it", async () => {
    api.tool("tickets:apiKeys.list", () => [
      {
        id: "k1",
        label: "Site",
        key_prefix: "W4UOTITC",
        allowed_origins: [],
        last_used_at: null,
        created_at: "2026-10-25 09:32:41.1+00",
      },
    ])
    api.tool("tickets:apiKeys.revoke", () => ({ id: "k1", revoked: true }))
    renderPage()
    const section = await screen.findByTestId("settings-section-api-keys")
    const row = await within(section).findByTestId("settings-list-row-k1")
    // Never used reads "Never", not a blank or a raw database timestamp.
    expect(within(row).getByTestId("settings-list-cell-k1-last_used_at").textContent).toBe(
      "Last used: Never",
    )
    // An empty column is left out, and no "Revoked" column is declared.
    expect(within(row).queryByTestId("settings-list-cell-k1-allowed_origins")).toBeNull()
    expect(row.textContent).not.toContain("Revoked")
    const action = within(row).getByTestId("settings-list-archive-k1")
    expect(action.textContent).toBe("Revoke")
    fireEvent.click(action)
    const confirm = within(row).getByTestId("settings-list-confirm-k1")
    expect(confirm.textContent).toContain("Revoke “Site”?")
    expect(confirm.textContent).not.toContain("Archive")
    expect(api.toolCalls().some((c) => c.toolName === "tickets:apiKeys.revoke")).toBe(false)
    fireEvent.click(within(row).getByTestId("settings-list-archive-confirm-k1"))
    // Staged until Save (S10): one Save/Discard bar commits the revoke.
    expect(api.toolCalls().some((c) => c.toolName === "tickets:apiKeys.revoke")).toBe(false)
    fireEvent.click(within(section).getByTestId("settings-list-save"))
    await waitFor(() =>
      expect(api.toolCalls().find((c) => c.toolName === "tickets:apiKeys.revoke")?.params).toEqual({
        id: "k1",
      }),
    )
  })
})
