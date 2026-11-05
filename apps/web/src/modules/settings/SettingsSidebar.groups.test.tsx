// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings column (settings overhaul S12, A7, D26): You, AI, Workspace,
// Apps, Connectors, top to bottom. Apps holds ONE row per app, no sub-headings;
// the Connectors heading is itself the link to the Connectors page. Rendered
// from the real kernel registrations, the real manifests and fixture apps that
// declare a `settings` page, for the three viewers the spec names: an admin, a
// support lead holding only tickets scopes, and a member.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerSettingsSection, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest } from "~/framework/define-app"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import { SettingsSidebar } from "~/modules/settings/SettingsSidebar"
import adsManifest from "../../../../../bundled-apps/ads/app.manifest.json"
import mailManifest from "../../../../api/src/apps/mail/app.manifest.json"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

type Manifest = Parameters<typeof registerAppFromManifest>[0]

const stubExports = new Proxy({}, { get: () => () => null, has: () => true }) as Record<
  string,
  unknown
>

interface FixtureSection {
  id: string
  scope: "user" | "org"
  adminScope?: string
}

function app(
  name: string,
  sections: FixtureSection[],
  opts: {
    rail?: { label: string; order: number }
    kind?: "app" | "connector"
    displayName?: string
  } = {},
): Manifest {
  return {
    name,
    kind: opts.kind ?? "app",
    displayName: opts.displayName,
    settings: {
      sections: sections.map((s) => ({ ...s, title: s.id, blocks: [] })),
    },
    views: opts.rail
      ? { activityBar: { icon: "Icon", label: opts.rail.label, order: opts.rail.order } }
      : {},
  } as unknown as Manifest
}

/** Tickets as it will declare itself: your signature, then the support setup. */
const tickets = app(
  "tickets",
  [
    { id: "signature", scope: "user" },
    { id: "inboxes", scope: "org", adminScope: "tickets:inboxes:admin" },
    { id: "categories", scope: "org", adminScope: "tickets:categories:admin" },
    { id: "response-times", scope: "org", adminScope: "tickets:settings:admin" },
  ],
  { rail: { label: "Tickets", order: 11 } },
)
/** Org settings only, under the default admin scope. */
const invoicing = app("invoicing", [{ id: "issuers", scope: "org" }], {
  rail: { label: "Invoicing", order: 65 },
})
/** No rail entry: listed after the rail apps, by name. */
const notes = app("notes", [{ id: "org", scope: "org" }], { displayName: "Notes" })
const atlas = app("atlas", [{ id: "mine", scope: "user" }], { displayName: "Atlas" })
/** A connector: never an Apps row. */
const gitlab = app("gitlab", [{ id: "conn", scope: "org", adminScope: "gitlab:accounts:admin" }], {
  kind: "connector",
})

const SUPPORT_LEAD = [
  "tickets:tickets:read",
  "tickets:inboxes:admin",
  "tickets:categories:admin",
  "tickets:settings:admin",
]

function jwt(scopes: string[]): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Alex",
      roles: [],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function renderSidebar(locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route path="/*" component={() => <SettingsSidebar />} />
      </Router>
    </I18nProvider>
  ))
}

/** The row keys one group lists, top to bottom. */
function rowsIn(groupId: string): string[] {
  const group = screen.queryByTestId(`settings-group-${groupId}`)
  if (!group) return []
  return [...within(group).queryAllByRole("link")]
    .map((a) => (a.getAttribute("data-testid") ?? "").replace(/^settings-link-/, ""))
    .filter((id) => id !== "kernel:connectors")
}

function headingIds(): string[] {
  return [...document.querySelectorAll("[data-testid^='settings-group-heading-']")].map((h) =>
    (h.getAttribute("data-testid") ?? "").replace(/^settings-group-heading-/, ""),
  )
}

/** Every row of the column, group by group. */
function column(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const id of headingIds()) out[id] = rowsIn(id)
  return out
}

beforeEach(() => {
  clearAuth()
  resetRegistry()
  resetBootstrap()
  bootstrapKernelApps()
  for (const m of [tickets, invoicing, notes, atlas, gitlab])
    registerAppFromManifest(m, stubExports)
  // Mail declares its settings page; Ads may still declare its former page: one row each.
  registerAppFromManifest(mailManifest as unknown as Manifest, stubExports)
  registerAppFromManifest(adsManifest as unknown as Manifest, stubExports)
  BillingStateTestAccess.setMode("managed")
  window.history.pushState({}, "", "/settings")
})

afterEach(() => {
  cleanup()
  clearAuth()
  BillingStateTestAccess.reset()
})

describe("settings column, row by row, per viewer (A7)", () => {
  it("an admin sees every group and every row", () => {
    setTokens(jwt(["*"]), "refresh")
    renderSidebar()
    expect(column()).toEqual({
      you: [
        "kernel:profile",
        "kernel:security",
        "kernel:notifications",
        "kernel:computers",
        "kernel:connected-tools",
      ],
      ai: ["kernel:ai-models", "kernel:agent-behavior", "kernel:usage", "kernel:plan"],
      workspace: [
        "kernel:org",
        "kernel:documents",
        "kernel:users",
        "kernel:roles",
        "kernel:store",
        "kernel:system",
      ],
      apps: ["app:mail", "app:tickets", "app:invoicing", "app:ads", "app:atlas", "app:notes"],
      connectors: [],
    })
  })

  it("a support lead holding only tickets scopes keeps the Tickets row, and no admin group", () => {
    setTokens(jwt(SUPPORT_LEAD), "refresh")
    renderSidebar()
    expect(column()).toEqual({
      you: [
        "kernel:profile",
        "kernel:security",
        "kernel:notifications",
        "kernel:computers",
        "kernel:connected-tools",
      ],
      // Ads still declares its former page with no admin scope, so everyone
      // sees it until it moves to a settings page with org sections.
      apps: ["app:mail", "app:tickets", "app:atlas"],
    })
  })

  it("a member sees You and the apps that have a section for them", () => {
    setTokens(jwt([]), "refresh")
    renderSidebar()
    expect(column()).toEqual({
      you: [
        "kernel:profile",
        "kernel:security",
        "kernel:notifications",
        "kernel:computers",
        "kernel:connected-tools",
      ],
      // Ads still declares its former page with no admin scope, so everyone
      // sees it until it moves to a settings page with org sections.
      apps: ["app:mail", "app:tickets", "app:atlas"],
    })
  })

  it("a member who administers a connector gets the Connectors heading", () => {
    setTokens(jwt(["gitlab:accounts:admin"]), "refresh")
    renderSidebar()
    expect(headingIds()).toContain("connectors")
  })
})

describe("the Apps group", () => {
  beforeEach(() => setTokens(jwt(["*"]), "refresh"))

  it("an app with a settings page links to its one page, named after the app", () => {
    renderSidebar()
    const row = screen.getByTestId("settings-link-app:tickets")
    expect(row.getAttribute("href")).toBe("/settings/apps/tickets")
    expect(row.textContent).toBe("Tickets")
    expect(screen.getByTestId("settings-link-app:notes").textContent).toBe("Notes")
  })

  it("a migrated in-tree app (Mail) gets one row onto its settings page", () => {
    renderSidebar()
    const row = screen.getByTestId("settings-link-app:mail")
    expect(row.getAttribute("href")).toBe("/settings/apps/mail")
    expect(row.textContent).toBe("Mail")
    expect(screen.queryByTestId("settings-link-mail:providers")).toBeNull()
  })

  it("has no per-app sub-headings", () => {
    renderSidebar()
    expect(document.querySelectorAll("[data-testid^='settings-app-group-']")).toHaveLength(0)
  })

  it("a connector is never an Apps row", () => {
    renderSidebar()
    expect(screen.queryByTestId("settings-link-app:gitlab")).toBeNull()
  })

  it("reads the app names in French", () => {
    renderSidebar("fr")
    expect(screen.getByTestId("settings-link-app:mail").textContent).toBe("Mail")
    expect(screen.getByTestId("settings-link-app:ads").textContent).toBe("Publicité")
    expect(screen.getByTestId("settings-link-app:invoicing").textContent).toBe("Facturation")
  })
})

describe("the Connectors heading is the link (D26)", () => {
  it("links to the Connectors page, with no same-name row beneath it", () => {
    setTokens(jwt(["*"]), "refresh")
    renderSidebar()
    const link = screen.getByTestId("settings-link-kernel:connectors")
    expect(link.getAttribute("href")).toBe("/settings/connectors")
    expect(within(screen.getByTestId("settings-group-connectors")).getAllByRole("link")).toEqual([
      link,
    ])
    expect(screen.getByTestId("settings-group-heading-connectors").contains(link)).toBe(true)
  })

  it("is shown to an org admin even with no connector installed (MCP servers live there)", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    setTokens(jwt(["kernel:org:admin"]), "refresh")
    renderSidebar()
    expect(headingIds()).toContain("connectors")
  })
})

describe("group headings", () => {
  it("read in order, in French for a French reader", () => {
    setTokens(jwt(["*"]), "refresh")
    renderSidebar("fr")
    const headings = [...document.querySelectorAll("[data-testid^='settings-group-heading-']")].map(
      (h) => h.textContent,
    )
    expect(headings).toEqual(["Vous", "IA", "Espace de travail", "Applications", "Connecteurs"])
  })

  it("no row repeats its group heading", () => {
    setTokens(jwt(["*"]), "refresh")
    renderSidebar()
    for (const id of headingIds()) {
      const heading = screen.getByTestId(`settings-group-heading-${id}`).textContent
      for (const link of within(screen.getByTestId(`settings-group-${id}`)).queryAllByRole(
        "link",
      )) {
        if (link.getAttribute("data-testid") === "settings-link-kernel:connectors") continue
        expect(link.textContent).not.toBe(heading)
      }
    }
  })

  it("an AI section registered with the lowest order lists first", () => {
    setTokens(jwt(["*"]), "refresh")
    registerSettingsSection({
      id: "kernel:ai-first",
      label: "First",
      href: "/settings/ai-first",
      component: () => null,
      group: "ai",
      order: 1,
      appId: "kernel",
    })
    renderSidebar()
    expect(rowsIn("ai")[0]).toBe("kernel:ai-first")
  })
})
