// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings NAVIGATION under a French provider: the sidebar heading, the
// group headings and every registered section row. They used to be
// English literals in the registry, so a French reader saw an English
// navigation column next to translated pages; these renders are what a literal
// cannot pass.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getSettingsSections, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { SettingsSidebar } from "~/modules/settings/SettingsSidebar"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

/** Read a flat `kernel.a.b` key out of one locale's kernel dictionary. */
function readKey(dict: unknown, key: string): unknown {
  return key
    .replace(/^kernel\./, "")
    .split(".")
    .reduce<any>((acc, part) => (acc == null ? acc : acc[part]), dict)
}

function makeAdminJwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Alex",
      roles: [],
      scopes: ["kernel:admin"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function renderSidebar(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route path="/*" component={() => <SettingsSidebar />} />
      </Router>
    </I18nProvider>
  ))
}

describe("settings navigation speaks the reader's language", () => {
  beforeEach(() => {
    clearAuth()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    setTokens(makeAdminJwt(), "refresh")
    window.history.pushState({}, "", "/settings")
  })
  afterEach(() => {
    cleanup()
    clearAuth()
  })

  it("every kernel section carries a catalog key that resolves in en and fr", () => {
    const kernelSections = getSettingsSections().filter(
      (s) => s.id.startsWith("kernel:") || !s.appId,
    )
    expect(kernelSections.length).toBeGreaterThan(10)
    const unkeyed = kernelSections.filter((s) => !s.labelKey).map((s) => s.id)
    expect(unkeyed).toEqual([])
    const unresolved = kernelSections.filter(
      (s) =>
        typeof readKey(en, s.labelKey as string) !== "string" ||
        typeof readKey(fr, s.labelKey as string) !== "string",
    )
    expect(unresolved.map((s) => s.labelKey)).toEqual([])
  })

  it("the sidebar heading and the group headings are French", () => {
    renderSidebar("fr")

    expect(screen.getByText("Paramètres")).toBeInTheDocument()
    expect(screen.getByTestId("settings-group-heading-you").textContent).toBe("Vous")
    expect(screen.queryByText("Settings")).toBeNull()
    expect(screen.queryByText("You")).toBeNull()
  })

  it("the section rows are French, with no English label left in the column", () => {
    renderSidebar("fr")

    expect(screen.getByTestId("settings-link-kernel:profile").textContent).toBe("Profil")
    expect(screen.getByTestId("settings-link-kernel:security").textContent).toBe("Sécurité")
    expect(screen.getByTestId("settings-link-kernel:notifications").textContent).toBe(
      "Notifications",
    )

    // Every label the column actually renders is the French one: no English
    // registry literal survives anywhere in the nav.
    const rendered = [...document.querySelectorAll("[data-testid^='settings-link-']")].map(
      (el) => el.textContent,
    )
    for (const section of getSettingsSections()) {
      if (!section.labelKey || section.hidden) continue
      const french = readKey(fr, section.labelKey)
      if (french === section.label) continue // the same word in both locales
      expect(rendered).not.toContain(section.label)
    }
  })

  it("English is unchanged, so the column still reads Settings in en", () => {
    renderSidebar("en")

    expect(screen.getByText("Settings")).toBeInTheDocument()
    expect(screen.getByTestId("settings-link-kernel:profile").textContent).toBe("Profile")
    expect(screen.getByTestId("settings-link-kernel:notifications").textContent).toBe(
      "Notifications",
    )
  })
})
