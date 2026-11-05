// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel regroup (settings overhaul S16, A22, §R1 P2-13/P2-14): the pages
// that merged into one, each section where the prototype puts it.
//   AI > Agent behavior   = Outside content + Media analysis
//   Workspace > Organization = details + Export your data
//   You > Security        = personal + admin "Sign-in methods" (email link
//                           state, SSO providers, the Google client, the admin
//                           second-factor requirement); Integrations is gone
//   You > Connected tools = AI tools over MCP + your own MCP servers
//   Workspace > Roles & access = roles + access requests + data access
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { Component } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getSettingsSections, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import AgentBehaviorSettings from "~/modules/settings/AgentBehaviorSettings"
import OrganizationSettings from "~/modules/settings/OrganizationSettings"
import RolesAccessSettings from "~/modules/settings/RolesAccessSettings"
import SecuritySettings from "~/modules/settings/SecuritySettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

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

let orgSettings: Record<string, unknown> = {}
let orgPatchStatus = 200
let orgPatches: unknown[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  orgSettings = {}
  orgPatchStatus = 200
  orgPatches = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      if (url.endsWith("/org") && method === "GET") {
        return json({
          data: { id: "o1", name: "Resonant", timezone: "UTC", settings: orgSettings },
        })
      }
      if (url.endsWith("/org") && method === "PATCH") {
        const body = JSON.parse(String(init?.body))
        orgPatches.push(body)
        if (orgPatchStatus !== 200)
          return json({ error: { message: "own factor first" } }, orgPatchStatus)
        orgSettings = { ...orgSettings, ...body.settings }
        return json({ data: { settings: orgSettings } })
      }
      if (url.includes("/org/settings/media-analysis")) {
        return json({ data: { images: true, pdfs: true, audio: false, video: false } })
      }
      if (url.includes("/admin/oauth-providers")) {
        return json({
          data: [
            {
              id: "p1",
              name: "Okta",
              issuerUrl: "https://okta.example",
              scopes: null,
              autoProvision: false,
              configured: true,
              connectedAccountCount: 3,
            },
          ],
        })
      }
      if (url.includes("/settings/integrations/google")) {
        return json({
          data: {
            provider: "google",
            configured: true,
            configurationSource: "deployment",
            clientIdHint: "123…",
          },
        })
      }
      if (url.includes("/export/apps")) return json({ data: { apps: ["tickets"] } })
      if (url.endsWith("/org/usage")) {
        const unlimited = { used: 0, limit: null }
        return json({
          data: {
            seats: unlimited,
            mailboxes: unlimited,
            storageGb: unlimited,
            jobsThisHour: unlimited,
          },
        })
      }
      return json({ data: [] })
    }),
  )
})

afterEach(() => {
  cleanup()
  clearAuth()
  vi.unstubAllGlobals()
})

function renderPage(Page: Component) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <Page />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("AI > Agent behavior", () => {
  it("holds Outside content and Media analysis as two sections of one page", async () => {
    setTokens(jwt(["kernel:org:admin"]), "refresh")
    renderPage(AgentBehaviorSettings)
    expect(await screen.findByTestId("agent-behavior-section-outside")).toBeInTheDocument()
    expect(screen.getByTestId("agent-behavior-section-media")).toBeInTheDocument()
    expect(await screen.findByTestId("agent-safety-untrusted-switch")).toBeInTheDocument()
    expect(await screen.findByTestId("media-analysis-grid")).toBeInTheDocument()
    // One page title; the merged pages no longer bring their own.
    expect(document.querySelectorAll("h1")).toHaveLength(1)
  })

  it("is registered at /settings/ai/agent-behavior; the two former pages are not", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    const hrefs = getSettingsSections().map((s) => s.href)
    expect(hrefs).toContain("/settings/ai/agent-behavior")
    expect(hrefs).not.toContain("/settings/admin/agent-safety")
    expect(hrefs).not.toContain("/settings/admin/media-analysis")
  })
})

describe("Workspace > Organization", () => {
  it("carries the details and the data export", async () => {
    setTokens(jwt(["*"]), "refresh")
    renderPage(OrganizationSettings)
    expect(await screen.findByTestId("admin-org-save")).toBeInTheDocument()
    expect(await screen.findByTestId("organization-section-export")).toBeInTheDocument()
    expect(await screen.findByTestId("admin-data-export")).toBeInTheDocument()
    expect(document.querySelectorAll("h1")).toHaveLength(1)
  })

  it("keeps the export to holders of its own scope", async () => {
    setTokens(jwt(["kernel:org:admin"]), "refresh")
    renderPage(OrganizationSettings)
    expect(await screen.findByTestId("admin-org-save")).toBeInTheDocument()
    expect(screen.queryByTestId("organization-section-export")).toBeNull()
  })
})

describe("You > Security: Sign-in methods", () => {
  it("is not shown to a member", async () => {
    setTokens(jwt([]), "refresh")
    renderPage(SecuritySettings)
    expect(await screen.findByText("Change password")).toBeInTheDocument()
    expect(screen.queryByTestId("security-sign-in-methods")).toBeNull()
  })

  it("shows an admin the email link, the SSO providers, the Google client and the 2FA rule", async () => {
    setTokens(jwt(["kernel:org:admin"]), "refresh")
    renderPage(SecuritySettings)
    expect(await screen.findByTestId("security-sign-in-methods")).toBeInTheDocument()
    expect(screen.getByTestId("sign-in-methods-email-link")).toBeInTheDocument()
    expect(await screen.findByTestId("sso-provider-p1")).toBeInTheDocument()
    expect(screen.getByTestId("sso-provider-add")).toBeInTheDocument()
    expect(await screen.findByTestId("google-client-card")).toBeInTheDocument()
    expect(await screen.findByTestId("sign-in-security-require-admin-switch")).toBeInTheDocument()
  })

  it("still springs the 2FA rule back when the admin has no second factor (409)", async () => {
    orgPatchStatus = 409
    setTokens(jwt(["kernel:org:admin"]), "refresh")
    renderPage(SecuritySettings)
    const sw = await screen.findByTestId("sign-in-security-require-admin-switch")
    fireEvent.click(sw)
    await waitFor(() => expect(orgPatches).toHaveLength(1))
    await waitFor(() =>
      expect(
        screen.getByTestId("sign-in-security-require-admin-switch").getAttribute("aria-checked"),
      ).toBe("false"),
    )
  })

  it("the Integrations page is gone; its path and the SSO and sign-in pages are Security's", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    const hrefs = getSettingsSections().map((s) => s.href)
    for (const gone of [
      "/settings/admin/integrations",
      "/settings/admin/oauth",
      "/settings/admin/sign-in-security",
      "/settings/admin/mcp-servers",
      "/settings/admin/data-export",
      "/settings/admin/scope-requests",
      "/settings/admin/dimension-grants",
      "/settings/admin/apps",
      "/settings/connections",
    ]) {
      expect(hrefs).not.toContain(gone)
    }
    for (const page of [
      "/settings/connected-tools",
      "/settings/store",
      "/settings/connectors",
      "/settings/admin/roles",
    ]) {
      expect(hrefs).toContain(page)
    }
  })
})

describe("Workspace > Roles & access", () => {
  it("holds roles, access requests and data access as sections", async () => {
    setTokens(jwt(["*"]), "refresh")
    renderPage(RolesAccessSettings)
    expect(await screen.findByTestId("roles-access-section-roles")).toBeInTheDocument()
    expect(screen.getByTestId("roles-access-section-requests")).toBeInTheDocument()
    expect(screen.getByTestId("roles-access-section-data")).toBeInTheDocument()
    expect(document.querySelectorAll("h1")).toHaveLength(1)
  })

  it("keeps access requests to holders of their scope", async () => {
    setTokens(jwt(["kernel:users:admin"]), "refresh")
    renderPage(RolesAccessSettings)
    expect(await screen.findByTestId("roles-access-section-roles")).toBeInTheDocument()
    expect(screen.queryByTestId("roles-access-section-requests")).toBeNull()
  })
})
