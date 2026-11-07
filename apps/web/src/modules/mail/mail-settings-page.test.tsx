// SPDX-License-Identifier: FSL-1.1-ALv2
// The Mail settings page rendered from the REAL mail manifest `settings`: your
// email accounts for everyone, the mailbox types toggle for mail admins, and
// the Google client for org admins only (P2-12: mail:accounts:admin alone does
// not see it).
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { notifyEntityChange } from "~/framework/entity-changes"
import mailManifest from "../../../../api/src/apps/mail/app.manifest.json"
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

import { settingsChangeEvents } from "~/modules/mail/exports"
import { AppSettingsPage } from "../settings/app-page/AppSettingsPage"
import {
  registerAppSettingsPage,
  resetAppSettingsPages,
} from "../settings/app-page/app-settings-pages"

let api: FakeApi

function renderPage(url = "/settings/apps/mail") {
  window.history.pushState({}, "", url)
  return render(() => (
    <Router>
      <Route path="*" component={() => <AppSettingsPage appId="mail" />} />
    </Router>
  ))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  resetAppSettingsPages()
  registerAppSettingsPage({
    appId: "mail",
    manifest: mailManifest as unknown as AppSettingsManifest,
    exports: {
      MailAccounts: () => <div data-testid="stub-mail-accounts" />,
      GoogleClientCard: () => <div data-testid="stub-google-client" />,
      // The real Mail export: the frames that change this page's values.
      settingsChangeEvents,
    },
  })
  api.on("get", "/apps/mail/settings/org", () => ({ values: { gmail: false } }))
  api.on("get", "/apps/mail/settings/user", () => ({ values: {} }))
  api.on("patch", "/apps/mail/settings/org", (b) => b)
})

afterEach(() => resetAppSettingsPages())

const sectionIds = () =>
  [...document.querySelectorAll("[data-testid^='settings-section-']")]
    .map((el) => el.getAttribute("data-testid") ?? "")
    .filter((id) => !id.startsWith("settings-section-scope-"))
    .map((id) => id.replace("settings-section-", ""))

describe("Mail settings page", () => {
  it("an org admin sees accounts, mailbox types and the Google client", async () => {
    state.scopes = ["*"]
    renderPage()
    await screen.findByTestId("stub-google-client")
    expect(sectionIds()).toEqual(["accounts", "providers", "google-client"])
    expect(screen.getByTestId("stub-mail-accounts")).toBeTruthy()
  })

  it("a mail admin alone: mailbox types, no Google client section", async () => {
    state.scopes = ["mail:accounts:read", "mail:accounts:admin"]
    renderPage()
    await screen.findByTestId("settings-section-providers")
    expect(sectionIds()).toEqual(["accounts", "providers"])
    expect(screen.queryByTestId("stub-google-client")).toBeNull()
  })

  it("a member sees only their own accounts", async () => {
    state.scopes = ["mail:accounts:read"]
    renderPage()
    await screen.findByTestId("stub-mail-accounts")
    expect(sectionIds()).toEqual(["accounts"])
  })

  it("the Gmail toggle saves alone as the tool field `gmail`", async () => {
    state.scopes = ["mail:accounts:read", "mail:accounts:admin"]
    renderPage()
    fireEvent.click(await screen.findByTestId("settings-input-gmail"))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/apps/mail/settings/org",
        { path: "gmail", value: true },
        expect.anything(),
      ),
    )
  })
  it("arriving on ?section=providers scrolls to the Gmail switch and focuses it", async () => {
    state.scopes = ["mail:accounts:read", "mail:accounts:admin"]
    const scrolled = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrolled
    try {
      renderPage("/settings/apps/mail?section=providers")
      const toggle = await screen.findByTestId("settings-input-gmail")
      await waitFor(() => expect(document.activeElement).toBe(toggle))
      const section = screen.getByTestId("settings-section-providers")
      expect(section.id).toBe("settings-section-mail-providers")
      expect(scrolled.mock.contexts[0]).toBe(section)
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it("the Gmail switch turned on from a chat shows on the open page without a reload", async () => {
    state.scopes = ["mail:accounts:read", "mail:accounts:admin"]
    let gmail = false
    api.on("get", "/apps/mail/settings/org", () => ({ values: { gmail } }))
    renderPage()
    const toggle = await screen.findByTestId("settings-input-gmail")
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"))

    // The agent's approved config_apps sets the switch; the server announces it.
    gmail = true
    notifyEntityChange({
      key: "mail:provider",
      app: "mail",
      entity: "provider",
      action: "update",
      data: { id: "gmail", enabled: true },
    })
    await waitFor(() =>
      expect(screen.getByTestId("settings-input-gmail").getAttribute("aria-checked")).toBe("true"),
    )
  })

  it("a switch this page flipped yields to the value set elsewhere afterwards", async () => {
    state.scopes = ["mail:accounts:read", "mail:accounts:admin"]
    let gmail = false
    api.on("get", "/apps/mail/settings/org", () => ({ values: { gmail } }))
    api.on("patch", "/apps/mail/settings/org", (b) => {
      gmail = (b as { value: boolean }).value
      return b
    })
    renderPage()
    fireEvent.click(await screen.findByTestId("settings-input-gmail"))
    // Saved: the page shows what it saved over what it loaded.
    await waitFor(() => expect(gmail).toBe(true))
    await waitFor(() =>
      expect(screen.getByTestId("settings-field-status-gmail").textContent).not.toBe(""),
    )
    await waitFor(() =>
      expect(screen.getByTestId("settings-input-gmail").getAttribute("aria-checked")).toBe("true"),
    )
    // Turned off again from a chat.
    gmail = false
    notifyEntityChange({
      key: "mail:provider",
      app: "mail",
      entity: "provider",
      action: "update",
      data: { id: "gmail", enabled: false },
    })
    await waitFor(() =>
      expect(screen.getByTestId("settings-input-gmail").getAttribute("aria-checked")).toBe("false"),
    )
  })
})
