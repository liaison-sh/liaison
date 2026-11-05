// SPDX-License-Identifier: FSL-1.1-ALv2
//
// At 390px the phone top bar carries the screen's name, and it took it straight
// off the stored tab label: the Home tab is opened with the English literal
// "Home", so the one word above a fully French screen stayed English. A tab
// type with a FIXED name is now renamed from the catalog here, the same way the
// desktop tab strip renames it; an entity tab (a thread, a document) keeps the
// name the entity itself carries, in any language.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"

function renderPanel(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <PanelProvider>
                <MainPanel tier="phone" />
              </PanelProvider>
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

describe("the phone top bar names the screen in the reader's language", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => cleanup())

  it("titles the Home tab in French", async () => {
    openTab({ type: "home", entityId: "home", label: "Home", preview: false })
    renderPanel("fr")

    await waitFor(() => expect(screen.getByTestId("phone-top-bar-title")).toBeTruthy())
    expect(screen.getByTestId("phone-top-bar-title").textContent).toBe("Accueil")
  })

  it("titles the Home tab in English when the reader is English", async () => {
    openTab({ type: "home", entityId: "home", label: "Home", preview: false })
    renderPanel("en")

    await waitFor(() => expect(screen.getByTestId("phone-top-bar-title")).toBeTruthy())
    expect(screen.getByTestId("phone-top-bar-title").textContent).toBe("Home")
  })

  it("keeps an installed app's own name, which the catalog does not know", async () => {
    registerTabType("crm:home", {
      component: () => <div data-testid="crm-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/crm",
      defaultLabel: "Pipeline",
    })
    openTab({ type: "crm:home", entityId: "crm", label: "Pipeline", preview: false })
    renderPanel("fr")

    await waitFor(() => expect(screen.getByTestId("phone-top-bar-title")).toBeTruthy())
    expect(screen.getByTestId("phone-top-bar-title").textContent).toBe("Pipeline")
  })

  it("keeps an entity tab's own name rather than a screen name", async () => {
    openTab({ type: "home", entityId: "home", label: "Devis 4711", preview: false })
    renderPanel("fr")

    await waitFor(() => expect(screen.getByTestId("phone-top-bar-title")).toBeTruthy())
    expect(screen.getByTestId("phone-top-bar-title").textContent).toBe("Devis 4711")
  })
})
