// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings column's APP rows (Mail, Tickets, Knowledge, Calendar,
// and the connectors Database, GitLab, Google Drive, which have no row) and the sections behind them. They are declared in each module's `app.manifest.json`, which shipped
// English literals, so a French reader found a whole English block under the
// translated kernel groups. The modules are registered here from the real
// manifests, so a manifest that loses its `labelKey` fails this test.
//
// A BUNDLED app (Shopify, Invoicing, Shipping, Ads, Monitoring) ships no
// catalog key: the package format carries no localized name, so its own label
// survives rather than a bare key. That fallback is asserted too.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getSettingsSections, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest } from "~/framework/define-app"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { SettingsSidebar } from "~/modules/settings/SettingsSidebar"
import pennylaneManifest from "../../../../../bundled-apps/pennylane/app.manifest.json"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import projectsEn from "../../../../../packages/shared/src/i18n/locales/en/projects.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"
import projectsFr from "../../../../../packages/shared/src/i18n/locales/fr/projects.json"
import calendarManifest from "../../../../api/src/apps/calendar/app.manifest.json"
import databaseManifest from "../../../../../bundled-apps/database/app.manifest.json"
import gitlabManifest from "../../../../api/src/apps/gitlab/app.manifest.json"
import driveManifest from "../../../../api/src/apps/google-drive/app.manifest.json"
import knowledgeManifest from "../../../../api/src/apps/knowledge/app.manifest.json"
import mailManifest from "../../../../api/src/apps/mail/app.manifest.json"
import projectsManifest from "../../../../api/src/apps/projects/app.manifest.json"
import ticketsManifest from "../../../../api/src/apps/tickets/app.manifest.json"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const MODULE_MANIFESTS = [
  mailManifest,
  ticketsManifest,
  knowledgeManifest,
  calendarManifest,
  databaseManifest,
  gitlabManifest,
  driveManifest,
] as unknown as Parameters<typeof registerAppFromManifest>[0][]

/** Every component a manifest names, stubbed: this renders the nav, not the pages. */
const stubExports = new Proxy({}, { get: () => () => null, has: () => true }) as Record<
  string,
  unknown
>

/** A bundled app: a label of its own, no catalog key (the package format has none). */
const bundledAppManifest = {
  name: "invoicing",
  version: "0.17.9",
  views: {
    activityBar: { icon: "InvoicingAppIcon", label: "Invoicing", order: 65 },
  },
  settings: {
    sections: [
      {
        id: "issuers",
        title: "Issuer profiles",
        scope: "org",
        adminScope: "kernel:admin",
        blocks: [{ block: "custom", component: "InvoicingIssuerProfiles" }],
      },
    ],
  },
} as unknown as Parameters<typeof registerAppFromManifest>[0]

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
      scopes: [
        "kernel:admin",
        "gitlab:accounts:admin",
        "google-drive:accounts:admin",
        "mail:accounts:admin",
        "tickets:inboxes:admin",
        "tickets:categories:admin",
        "tickets:settings:admin",
      ],
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

describe("the settings column names every module section in the reader's language", () => {
  beforeEach(() => {
    clearAuth()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    for (const manifest of MODULE_MANIFESTS) registerAppFromManifest(manifest, stubExports)
    registerAppFromManifest(bundledAppManifest, stubExports)
    setTokens(makeAdminJwt(), "refresh")
    window.history.pushState({}, "", "/settings")
  })
  afterEach(() => {
    cleanup()
    clearAuth()
  })

  it("every module section carries a catalog key that resolves in en and fr", () => {
    const moduleIds = ["mail", "tickets", "knowledge", "calendar"]
    const sections = getSettingsSections().filter((s) => moduleIds.includes(s.appId ?? ""))
    // One row per app with a settings page (connectors are cards, not rows).
    for (const appId of ["mail", "tickets", "knowledge", "calendar"]) {
      expect(sections.some((s) => s.appId === appId)).toBe(true)
    }
    expect(sections.filter((s) => !s.labelKey).map((s) => s.id)).toEqual([])
    const unresolved = sections.filter(
      (s) =>
        typeof readKey(en, s.labelKey as string) !== "string" ||
        typeof readKey(fr, s.labelKey as string) !== "string",
    )
    expect(unresolved.map((s) => s.labelKey)).toEqual([])
  })

  // the projects app's sections (CI release status, Labels) carry
  // `projects.*` keys; each must resolve in both locales or a French reader
  // gets a bare key as the section title.
  it("every projects section title and description resolves in en and fr", () => {
    const sections = (
      projectsManifest as unknown as {
        settings: { sections: { id: string; titleKey?: string; descriptionKey?: string }[] }
      }
    ).settings.sections
    expect(sections.map((s) => s.id)).toEqual(expect.arrayContaining(["ci", "labels"]))
    const readProjectsKey = (dict: unknown, key: string): unknown =>
      key
        .replace(/^projects\./, "")
        .split(".")
        .reduce<any>((acc, part) => (acc == null ? acc : acc[part]), dict)
    const unresolved: string[] = []
    for (const section of sections) {
      for (const key of [section.titleKey, section.descriptionKey]) {
        expect(key).toBeTypeOf("string")
        for (const dict of [projectsEn, projectsFr]) {
          if (typeof readProjectsKey(dict, key as string) !== "string")
            unresolved.push(key as string)
        }
      }
    }
    expect(unresolved).toEqual([])
  })

  // One row per app (settings overhaul S12): the row is the app's name, in
  // the reader's language.
  it("every app row is named in French, with no English label left", () => {
    renderSidebar("fr")

    const row = (appId: string) => screen.getByTestId(`settings-link-app:${appId}`).textContent
    expect(row("mail")).toBe("Mail")
    expect(row("knowledge")).toBe("Connaissances")
    expect(row("calendar")).toBe("Agenda")

    const rendered = [...document.querySelectorAll("[data-testid^='settings-link-app:']")].map(
      (el) => el.textContent,
    )
    // "Mail" is the mail app's name in French too, so only the others are checked.
    for (const english of ["Knowledge", "Calendar"]) {
      expect(rendered).not.toContain(english)
    }
    // No machine name survives as a row either.
    expect(screen.queryByText("google-drive")).toBeNull()
    // A connector is a card on Settings > Connectors, never an app row.
    for (const connector of ["gitlab", "database", "google-drive"]) {
      expect(screen.queryByTestId(`settings-link-app:${connector}`)).toBeNull()
    }
  })

  // An app that ships SETTINGS but no activity bar entry has no rail label to
  // borrow, so `appGroupLabel` falls through to `kernel.nav.app.<appId>`. A
  // missing key there printed the machine name and logged a missing-translation
  // warning on every page. Pennylane is the live example; the list is derived
  // from the real manifests so a future settings-only app fails here.
  it("every settings-only app is named from the catalog in en and fr", () => {
    const settingsOnly = [
      ...MODULE_MANIFESTS,
      pennylaneManifest as unknown as Parameters<typeof registerAppFromManifest>[0],
    ]
      .map(
        (m) =>
          m as unknown as { name: string; settings?: unknown; views?: Record<string, unknown> },
      )
      .filter((m) => m.settings && !m.views?.activityBar)
      .map((m) => m.name)

    expect(settingsOnly).toContain("pennylane")
    for (const appId of settingsOnly) {
      expect(readKey(en, `kernel.nav.app.${appId}`)).toBeTypeOf("string")
      expect(readKey(fr, `kernel.nav.app.${appId}`)).toBeTypeOf("string")
    }
    expect(readKey(en, "kernel.nav.app.pennylane")).toBe("Pennylane")
    expect(readKey(fr, "kernel.nav.app.pennylane")).toBe("Pennylane")
  })

  // Second French walk (2026-09-23): the INVOICING heading and its Invoicing
  // row stayed English. A bundled app whose section carries the app's own name
  // is now named from kernel.nav.<app> when the catalog has one.
  it("a bundled app's row reads in French", () => {
    renderSidebar("fr")

    expect(screen.getByTestId("settings-link-app:invoicing").textContent).toBe("Facturation")
  })

  it("English is unchanged", () => {
    renderSidebar("en")

    expect(screen.getByTestId("settings-link-app:mail").textContent).toBe("Mail")
    expect(screen.getByTestId("settings-link-app:knowledge").textContent).toBe("Knowledge")
  })
})
