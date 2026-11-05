// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ),
)

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake`
}

describe("SettingsLayout — prop-driven", () => {
  beforeEach(() => {
    clearAuth()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })

  afterEach(() => cleanup())

  it("renders with entityId prop and shows default sub-page", async () => {
    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <SettingsLayout entityId="settings" />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    // Should render without crashing — container is present
    expect(document.querySelector("[class*='settings'], [class*='flex']")).toBeTruthy()
  })

  it("redirects hidden admin routes to the first accessible settings page", async () => {
    window.history.pushState({}, "", "/settings/admin/users")
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Alex",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <SettingsLayout entityId="settings" />
            </ApiProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings")
    })
    expect(
      screen.queryByText("You do not have access to this settings section."),
    ).not.toBeInTheDocument()
  })

  it("does not show the no-access fallback for a regular user on /settings", async () => {
    window.history.pushState({}, "", "/settings")
    // Regular user with no admin scopes — still should see Profile (user group, no adminScope required)
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Alex",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <SettingsLayout entityId="settings" />
            </ApiProvider>
          )}
        />
      </Router>
    ))

    // The layout should render the active page component, not the no-access fallback
    await waitFor(() => {
      expect(
        screen.queryByText("You do not have access to this settings section."),
      ).not.toBeInTheDocument()
    })
    // Verify the content area container is rendered
    expect(document.querySelector('[data-testid="settings-content"]')).toBeTruthy()
    // Should remain on the /settings path (not redirected away)
    expect(window.location.pathname).toBe("/settings")
  })

  it("keeps an app settings deep link until the app registers its section", async () => {
    // A reload on /settings/<app>: manifest apps register their sections after
    // first paint, so the path is unknown when SettingsLayout mounts.
    window.history.pushState({}, "", "/settings/ads")
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Alex",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "refresh",
    )

    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    const { registerApp } = await import("~/framework/define-app")
    const { setManifestAppsSettled } = await import("~/framework/app-registry")
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <SettingsLayout entityId="settings" />
            </ApiProvider>
          )}
        />
      </Router>
    ))

    // Let the mount effects run: the unknown path must not bounce to Profile.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(window.location.pathname).toBe("/settings/ads")
    expect(
      screen.queryByText("You do not have access to this settings section."),
    ).not.toBeInTheDocument()

    // The manifest sync lands: the app's section registers, then the sync settles.
    registerApp({
      name: "ads",
      settings: [
        {
          id: "ads-connection",
          label: "Ads",
          href: "/settings/ads",
          component: () => <div data-testid="ads-settings-probe" />,
          group: "app" as const,
          order: 0,
        },
      ],
    })
    setManifestAppsSettled(true)

    expect(await screen.findByTestId("ads-settings-probe")).toBeInTheDocument()
    expect(window.location.pathname).toBe("/settings/ads")
  })

  it("keeps an Off app's page on reload for an apps admin until the workspace's app list loaded", async () => {
    // The manifests feed omits an app turned Off: its page comes from the
    // admin's app list, which loads after the feed settled.
    window.history.pushState({}, "", "/settings/apps/tickets")
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Alex",
        roles: [],
        scopes: ["kernel:apps:admin"],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "refresh",
    )
    const { setManifestAppsSettled } = await import("~/framework/app-registry")
    const { orgAppsStore } = await import("~/modules/settings/app-management/org-apps-store")
    orgAppsStore.reset()
    setManifestAppsSettled(true)
    // GET /org/apps is still on its way.
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}))

    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    try {
      render(() => (
        <Router>
          <Route
            path="/*"
            component={() => (
              <ApiProvider>
                <SettingsLayout entityId="settings" />
              </ApiProvider>
            )}
          />
        </Router>
      ))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(window.location.pathname).toBe("/settings/apps/tickets")

      // The list lands with Tickets Off: its row registers and the page stays.
      orgAppsStore.set([
        {
          name: "tickets",
          displayName: "Tickets",
          version: "1.0.0",
          kind: "app",
          status: "disabled",
          accessMode: "everyone",
          principals: { roleIds: [], userIds: [] },
          hasOwnScopes: true,
          dependents: [],
          installSource: "in-tree",
          listing: null,
          settings: null,
        },
      ])
      // The page is a lazy chunk: allow its first import.
      expect(
        await screen.findByTestId("app-settings-page-tickets", {}, { timeout: 5_000 }),
      ).toBeInTheDocument()
      expect(window.location.pathname).toBe("/settings/apps/tickets")
    } finally {
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      )
      orgAppsStore.reset()
    }
  })

  it("falls back to Profile for an unknown settings path once manifest apps settled", async () => {
    window.history.pushState({}, "", "/settings/not-an-app")
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Alex",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "refresh",
    )
    const { setManifestAppsSettled } = await import("~/framework/app-registry")
    setManifestAppsSettled(true)

    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <SettingsLayout entityId="settings" />
            </ApiProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings")
    })
  })

  it("renders admin sections when user has admin scopes", async () => {
    window.history.pushState({}, "", "/settings/admin/users")
    // Admin user with kernel:users:admin scope
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Admin",
      roles: ["admin"],
      scopes: ["kernel:users:admin"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <SettingsLayout entityId="settings" />
            </ApiProvider>
          )}
        />
      </Router>
    ))

    // Should stay on the admin page, not redirect away
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/admin/users")
    })
    // Should not show the no-access fallback
    expect(
      screen.queryByText("You do not have access to this settings section."),
    ).not.toBeInTheDocument()
  })
})

describe("kernel workspace sections (settings overhaul S12)", () => {
  it("lists Organization, Documents, Users, Roles & access, App store and System, in that order", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    const { getSettingsSections } = await import("~/framework/app-registry")
    const labels = getSettingsSections()
      .filter((section) => section.group === "admin" && !section.hidden)
      .sort((a, b) => a.order - b.order)
      .map((section) => section.label)

    expect(labels).toEqual([
      "Organization",
      "Documents",
      "Users",
      "Roles & access",
      "App store",
      "System",
    ])
  })

  it("keeps the removed Email Routing and Service Levels paths as aliases of the Tickets page, not pages", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    const { getSettingsSections } = await import("~/framework/app-registry")
    const { resolveSettingsAlias } = await import("~/modules/settings/settings-aliases")
    for (const href of ["/settings/admin/email", "/settings/admin/sla"]) {
      expect(getSettingsSections().find((s) => s.href === href)).toBeUndefined()
      expect(resolveSettingsAlias(href)).toBe("/settings/apps/tickets")
    }
  })
})

describe("app settings in the sidebar", () => {
  it("registers an app's section under its app", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { getSettingsSections } = await import("~/framework/app-registry")

    registerApp({
      name: "mail",
      activityBar: {
        icon: () => null,
        label: "Mail",
        order: 10,
      },
      settings: [
        {
          label: "Email Accounts",
          component: () => null,
          href: "/settings/mail/accounts",
          group: "app" as const,
          order: 0,
        },
      ],
    })

    const sections = getSettingsSections()
    const mailSection = sections.find((s) => s.id === "mail:email-accounts")
    expect(mailSection).toBeDefined()
    expect(mailSection!.appId).toBe("mail")
    expect(mailSection!.group).toBe("app")
  })

  it("renders a dimmed admin badge for admin-only app settings", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { SettingsSidebar } = await import("~/modules/settings/SettingsSidebar")

    registerApp({
      name: "mail",
      activityBar: {
        icon: () => null,
        label: "Mail",
        order: 10,
      },
      settings: [
        {
          label: "Mail Setup",
          badge: "Admin",
          component: () => null,
          href: "/settings/mail/providers",
          group: "app" as const,
          order: 1,
          adminScope: "mail:accounts:admin",
        },
      ],
    })

    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Admin",
      roles: ["admin"],
      scopes: ["mail:accounts:admin"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    render(() => (
      <Router>
        <Route path="/*" component={() => <SettingsSidebar />} />
      </Router>
    ))

    // One row per app, named after the app, carrying its page's badge.
    const row = await screen.findByTestId("settings-link-app:mail")
    expect(row.textContent).toContain("Mail")
    expect(screen.getByText("Admin")).toBeInTheDocument()
  })

  // Surface 80: the badge was whatever English literal the manifest carried,
  // so it stayed English beside a French section name. It now names a catalog
  // key, the same contract the section label itself uses.
  it("renders the admin badge from the catalog, in the reader's language", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { SettingsSidebar } = await import("~/modules/settings/SettingsSidebar")
    const { I18nProvider } = await import("~/modules/i18n/i18n-context")

    registerApp({
      name: "mail",
      activityBar: { icon: () => null, label: "Mail", order: 10 },
      settings: [
        {
          label: "Mail Setup",
          badge: "Admin",
          // A key whose French differs from the English literal, so the
          // assertion below fails if the badge is still read straight off the
          // manifest.
          badgeKey: "kernel.nav.section.users",
          component: () => null,
          href: "/settings/mail/providers",
          group: "app" as const,
          order: 1,
          adminScope: "mail:accounts:admin",
        },
      ],
    })

    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Admin",
        roles: ["admin"],
        scopes: ["mail:accounts:admin"],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "refresh",
    )

    render(() => (
      <I18nProvider initialLocale="fr">
        <Router>
          <Route path="/*" component={() => <SettingsSidebar />} />
        </Router>
      </I18nProvider>
    ))

    expect(await screen.findByText("Utilisateurs")).toBeInTheDocument()
    expect(screen.queryByText("Admin")).not.toBeInTheDocument()
  })
})
