// SPDX-License-Identifier: FSL-1.1-ALv2
// The declarative app page (S13, A7, A9, §R1 P2-6, F-P2-1): one round trip per
// field type through `PATCH /apps/:app/settings/{org|user}` ({ path, value }),
// section visibility per scope, the approval and error states, refetch on
// becoming active, custom blocks.
import { Route, Router, useNavigate } from "@solidjs/router"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiError, createFakeApi, type FakeApi } from "./__fixtures__/fake-api"
import { FIXTURE_APP, fixtureManifest } from "./__fixtures__/settings-fixture"

const state = vi.hoisted(() => ({ api: null as unknown, scopes: [] as string[] }))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  const has = (s: string) => state.scopes.includes("*") || state.scopes.includes(s)
  return {
    ...actual,
    hasScope: has,
    canAccessScope: (s?: string | null) => !s || has(s),
  }
})

import { appSettingsLabelKey } from "~/framework/define-app"
import { type OrgApp, orgAppsStore } from "../app-management/org-apps-store"
import { AppSettingsPage } from "./AppSettingsPage"
import { registerAppSettingsPage, resetAppSettingsPages } from "./app-settings-pages"

let api: FakeApi
const ORG = `/apps/${FIXTURE_APP}/settings/org`
const USER = `/apps/${FIXTURE_APP}/settings/user`

function defaultHandlers(): void {
  api.on("get", ORG, () => ({ values: {} }))
  api.on("get", USER, () => ({ values: { "signature.text": "Hi" } }))
  api.on("patch", ORG, (b) => b)
  api.on("patch", USER, (b) => b)
  api.on("get", `/apps/${FIXTURE_APP}/connections`, () => [])
  api.tool(`${FIXTURE_APP}:options.list`, () => [
    { value: "x", label: "Ex" },
    { value: "y", label: "Why" },
  ])
  api.tool(`${FIXTURE_APP}:keys.list`, () => [])
  api.tool(`${FIXTURE_APP}:categories.list`, () => ({ version: "v1", nodes: [] }))
}

function renderPage(props: { active?: () => boolean } = {}) {
  window.history.pushState({}, "", `/settings/apps/${FIXTURE_APP}`)
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => <AppSettingsPage appId={FIXTURE_APP} active={props.active} />}
      />
    </Router>
  ))
}

function patchesTo(path: string) {
  return api.patch.mock.calls.filter((c) => c[0] === path).map((c) => c[1])
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  resetAppSettingsPages()
  registerAppSettingsPage({
    appId: FIXTURE_APP,
    manifest: fixtureManifest,
    exports: { FixturePanel: () => <div data-testid="fixture-panel">panel</div> },
  })
  defaultHandlers()
})

afterEach(() => {
  resetAppSettingsPages()
})

async function field(key: string): Promise<HTMLElement> {
  return await screen.findByTestId(`settings-input-${key}`)
}

describe("AppSettingsPage header", () => {
  it("shows icon, name, version and publisher", async () => {
    renderPage()
    const head = await screen.findByTestId("app-settings-header")
    expect(within(head).getByTestId("app-settings-name").textContent).toBe("Fixture")
    expect(within(head).getByTestId("app-settings-version").textContent).toBe("v1.2.3")
    expect(within(head).getByTestId("app-settings-publisher").textContent).toContain("Liaison")
  })

  it("titles an app without a display name by its catalog name, never its id", async () => {
    resetAppSettingsPages()
    registerAppSettingsPage({
      appId: FIXTURE_APP,
      manifest: { ...fixtureManifest, name: "mcp-manager", displayName: undefined },
      label: "mcp-manager",
      labelKey: appSettingsLabelKey("mcp-manager"),
    })
    renderPage()
    const head = await screen.findByTestId("app-settings-header")
    expect(within(head).getByTestId("app-settings-name").textContent).toBe("Connected services")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Connected services")
    expect(screen.getByTestId(`app-settings-page-${FIXTURE_APP}`).textContent).not.toContain(
      "mcp-manager",
    )
  })

  it("says so when the app declares no settings", async () => {
    resetAppSettingsPages()
    registerAppSettingsPage({ appId: FIXTURE_APP, manifest: { name: FIXTURE_APP } })
    renderPage()
    expect(await screen.findByTestId("app-settings-empty")).toBeTruthy()
  })
})

describe("AppSettingsPage from a newer server", () => {
  // A block or field type added after this build: a placeholder that says to
  // update, never a guessed control or nothing at all.
  it("draws an unknown block or field type as an update placeholder, and the rest as usual", async () => {
    resetAppSettingsPages()
    registerAppSettingsPage({
      appId: FIXTURE_APP,
      manifest: {
        ...fixtureManifest,
        settings: {
          sections: [
            {
              id: "future",
              title: "Future",
              scope: "org",
              blocks: [
                { block: "field", key: "f.text", type: "text", label: "Text" },
                { block: "field", key: "f.color", type: "color", label: "Brand colour" },
                { block: "gallery", key: "g" },
              ],
            },
          ],
        } as never,
      },
    })
    renderPage()
    const section = await screen.findByTestId("settings-section-future")
    const placeholders = within(section).getAllByTestId("settings-unsupported")
    expect(placeholders).toHaveLength(2)
    expect(placeholders[0].textContent).toContain("Brand colour")
    for (const p of placeholders) expect(p.textContent).toContain("Update Liaison to change it")
    expect(within(section).getByTestId("settings-input-f.text")).toBeTruthy()
    expect(within(section).queryByTestId("settings-input-f.color")).toBeNull()
  })
})

describe("AppSettingsPage: the scope badge of a section holding connections", () => {
  const register = () => {
    // As in production: the connections come from the API, the manifest feed has none.
    api.on("get", `/apps/${FIXTURE_APP}/connections`, () => [
      { name: "drive", type: "oauth2" },
      { name: "api", type: "credentials", multiInstance: true },
    ])
    api.on("get", `/connections/${FIXTURE_APP}/drive/accounts`, () => [])
    api.on("get", `/connections/${FIXTURE_APP}/api/accounts`, () => [])
    resetAppSettingsPages()
    registerAppSettingsPage({
      appId: FIXTURE_APP,
      manifest: {
        ...fixtureManifest,
        settings: {
          sections: [
            {
              id: "drive",
              title: "Connection",
              scope: "org",
              blocks: [{ block: "connections", names: ["drive"] }],
            },
            {
              id: "all",
              title: "All connections",
              scope: "org",
              blocks: [{ block: "connections" }],
            },
            {
              id: "named",
              title: "Named instances",
              scope: "org",
              blocks: [{ block: "connections", names: ["api"] }],
            },
            {
              id: "plain",
              title: "Org fields",
              scope: "org",
              blocks: [{ block: "field", key: "f.text", type: "text", label: "Text" }],
            },
            {
              id: "mine",
              title: "My calendars",
              scope: "user",
              blocks: [{ block: "connections", names: ["drive"] }],
            },
          ],
        } as never,
      },
    })
  }

  it("carries no Organization badge where a person can connect their own account", async () => {
    register()
    renderPage()
    // Once the named-instance section knows its connections, this one's are known too.
    await screen.findByTestId("settings-section-scope-named")
    expect(screen.queryByTestId("settings-section-scope-drive")).toBeNull()
    expect(screen.queryByTestId("settings-section-scope-all")).toBeNull()
  })

  it("keeps it where only the organization can hold what the section shows", async () => {
    register()
    renderPage()
    expect((await screen.findByTestId("settings-section-scope-named")).textContent).toBe(
      "Organization",
    )
    expect(screen.getByTestId("settings-section-scope-plain").textContent).toBe("Organization")
  })

  it("in a section open to everyone: 'Just you' for a member", async () => {
    register()
    state.scopes = []
    renderPage()
    expect((await screen.findByTestId("settings-section-scope-mine")).textContent).toBe("Just you")
  })

  it("in a section open to everyone: no badge for an admin, who can pick Organization", async () => {
    register()
    renderPage()
    await screen.findByTestId("settings-section-scope-named")
    expect(screen.queryByTestId("settings-section-scope-mine")).toBeNull()
  })
})

describe("AppSettingsPage field round trips (one PATCH { path, value } per field)", () => {
  const cases: Array<{
    type: string
    key: string
    act: () => Promise<void>
    value: unknown
    endpoint?: string
  }> = [
    {
      type: "text",
      key: "f.text",
      act: async () => {
        const el = await field("f.text")
        fireEvent.input(el, { target: { value: "hello" } })
        fireEvent.blur(el)
      },
      value: "hello",
    },
    {
      type: "textarea",
      key: "f.textarea",
      act: async () => {
        const el = await field("f.textarea")
        fireEvent.input(el, { target: { value: "two\nlines" } })
        fireEvent.blur(el)
      },
      value: "two\nlines",
    },
    {
      type: "number",
      key: "f.number",
      act: async () => {
        const el = await field("f.number")
        fireEvent.input(el, { target: { value: "42" } })
        fireEvent.blur(el)
      },
      value: 42,
    },
    {
      type: "toggle",
      key: "f.toggle",
      act: async () => {
        fireEvent.click(await field("f.toggle"))
      },
      value: true,
    },
    {
      type: "select",
      key: "f.select",
      act: async () => {
        const el = await field("f.select")
        fireEvent.change(el, { target: { value: "b" } })
      },
      value: "b",
    },
    {
      type: "multiselect (optionsTool)",
      key: "f.multi",
      act: async () => {
        fireEvent.click(await screen.findByTestId("settings-input-f.multi-opt-y"))
      },
      value: ["y"],
    },
    {
      type: "url",
      key: "f.url",
      act: async () => {
        const el = await field("f.url")
        fireEvent.input(el, { target: { value: "https://status.example.com" } })
        fireEvent.blur(el)
      },
      value: "https://status.example.com",
    },
    {
      type: "email",
      key: "f.email",
      act: async () => {
        const el = await field("f.email")
        fireEvent.input(el, { target: { value: "ops@example.com" } })
        fireEvent.blur(el)
      },
      value: "ops@example.com",
    },
    {
      type: "date",
      key: "f.date",
      act: async () => {
        fireEvent.change(await field("f.date"), { target: { value: "2026-12-24" } })
      },
      value: "2026-12-24",
    },
    {
      type: "dates",
      key: "f.dates",
      act: async () => {
        fireEvent.input(await screen.findByTestId("settings-input-f.dates-new-date"), {
          target: { value: "2026-12-25" },
        })
        fireEvent.input(screen.getByTestId("settings-input-f.dates-new-label"), {
          target: { value: "Christmas" },
        })
        fireEvent.click(screen.getByTestId("settings-input-f.dates-add"))
      },
      value: [{ date: "2026-12-25", label: "Christmas" }],
    },
    {
      type: "duration (minutes → seconds)",
      key: "f.duration",
      act: async () => {
        const el = await field("f.duration")
        fireEvent.input(el, { target: { value: "30" } })
        fireEvent.blur(el)
      },
      value: 1800,
    },
    {
      type: "schedule",
      key: "f.schedule",
      act: async () => {
        fireEvent.click(await screen.findByTestId("settings-input-f.schedule-mon-enabled"))
      },
      value: {
        mon: [["09:00", "18:00"]],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      },
    },
    {
      type: "toggle (tool source)",
      key: "approve",
      act: async () => {
        fireEvent.click(await field("approve"))
      },
      value: true,
    },
    {
      type: "textarea (user scope)",
      key: "signature.text",
      endpoint: USER,
      act: async () => {
        const el = await field("signature.text")
        fireEvent.input(el, { target: { value: "Best, Lena" } })
        fireEvent.blur(el)
      },
      value: "Best, Lena",
    },
  ]

  it.each(cases)("$type saves { path: $key }", async ({ key, act, value, endpoint }) => {
    renderPage()
    await act()
    await waitFor(() => expect(patchesTo(endpoint ?? ORG)).toContainEqual({ path: key, value }))
    expect(patchesTo(endpoint ?? ORG)).toHaveLength(1)
    await waitFor(() =>
      expect(screen.getByTestId(`settings-field-status-${key}`).textContent).toContain("Saved"),
    )
  })

  it("does not save a text field whose value did not change", async () => {
    renderPage()
    const el = await field("signature.text")
    fireEvent.blur(el)
    await new Promise((r) => setTimeout(r, 20))
    expect(patchesTo(USER)).toHaveLength(0)
  })
})

describe("AppSettingsPage visibility (A7, S13)", () => {
  const order = () =>
    Array.from(document.querySelectorAll("section[data-testid^='settings-section-']")).map((el) =>
      el.getAttribute("data-testid")?.replace("settings-section-", ""),
    )

  it("shows a member only the user sections", async () => {
    state.scopes = []
    renderPage()
    await screen.findByTestId("settings-section-prefs")
    expect(order()).toEqual(["prefs"])
    expect(screen.getByTestId("settings-section-scope-prefs").textContent).toBe("Just you")
    expect(api.get.mock.calls.some((c) => c[0] === ORG)).toBe(false)
  })

  it("shows a lead the sections of its own scope, user sections first", async () => {
    state.scopes = ["fixture:lead:admin"]
    renderPage()
    await screen.findByTestId("settings-section-lead")
    expect(order()).toEqual(["prefs", "lead"])
    expect(screen.getByTestId("settings-section-scope-lead").textContent).toBe("Organization")
  })

  it("shows an admin every section, user sections first, then schema order", async () => {
    renderPage()
    await screen.findByTestId("settings-section-general")
    expect(order()).toEqual([
      "prefs",
      "lead",
      "general",
      "keys",
      "categories",
      "accounts",
      "panel",
      "address",
    ])
  })
})

describe("AppSettingsPage save states", () => {
  it("a gated set reads Waiting for approval, never Saved (§R1 P2-6)", async () => {
    api.on("patch", ORG, (b) => ({
      path: (b as { path: string }).path,
      pending: { approvalRequestId: "ar-1" },
    }))
    renderPage()
    fireEvent.click(await field("approve"))
    await waitFor(() =>
      expect(screen.getByTestId("settings-field-status-approve").textContent).toContain(
        "Waiting for approval",
      ),
    )
    expect(screen.getByTestId("settings-field-status-approve").textContent).not.toContain("Saved")
  })

  it("shows the server's message under the field and retries the same value", async () => {
    let fail = true
    api.on("patch", ORG, (b) => {
      if (fail) throw apiError(422, "invalid_field", "Url: must be an http or https URL")
      return b
    })
    renderPage()
    const el = await field("f.url")
    fireEvent.input(el, { target: { value: "ftp://nope" } })
    fireEvent.blur(el)
    const err = await screen.findByTestId("settings-field-error-f.url")
    expect(err.textContent).toContain("must be an http or https URL")
    expect(screen.getByTestId("settings-field-status-f.url").textContent).toContain("Not saved")
    fail = false
    fireEvent.click(screen.getByTestId("settings-field-retry-f.url"))
    await waitFor(() => expect(patchesTo(ORG)).toHaveLength(2))
    expect(patchesTo(ORG)[1]).toEqual({ path: "f.url", value: "ftp://nope" })
    await waitFor(() => expect(screen.queryByTestId("settings-field-error-f.url")).toBeNull())
  })

  it("a get tool waiting for approval renders the field pending and read-only (F-P2-1)", async () => {
    api.on("get", ORG, () => ({
      values: {},
      errors: { approve: { code: "pending", message: "fixture:approve.get is waiting" } },
    }))
    renderPage()
    const el = await field("approve")
    expect((el as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("settings-field-status-approve").textContent).toContain(
      "Waiting for approval",
    )
  })

  it("shows stored values", async () => {
    api.on("get", ORG, () => ({ values: { "f.text": "stored", "f.duration": 7200 } }))
    renderPage()
    expect(((await field("f.text")) as HTMLInputElement).value).toBe("stored")
    expect(((await field("f.duration")) as HTMLInputElement).value).toBe("2")
    expect((screen.getByTestId("settings-input-f.duration-unit") as HTMLSelectElement).value).toBe(
      "hours",
    )
  })
})

// M1: the fields of one whole-object setter (a gated tool takes the whole address)
// save as one unit: edits wait in a Save bar, and Save sends ONE PATCH { values }.
describe("AppSettingsPage section saved as one unit", () => {
  async function edit(key: string, value: string): Promise<void> {
    const el = await field(key)
    fireEvent.input(el, { target: { value } })
    fireEvent.blur(el)
  }

  it("editing three fields sends nothing until Save, then one PATCH with all three", async () => {
    renderPage()
    await edit("address.street", "1 Main St")
    await edit("address.city", "Lyon")
    await edit("address.zip", "69001")
    expect(patchesTo(ORG)).toHaveLength(0)
    expect(screen.getByTestId("settings-unit-count-address").textContent).toBe("3 unsaved changes")
    fireEvent.click(screen.getByTestId("settings-unit-save-address"))
    await waitFor(() => expect(patchesTo(ORG)).toHaveLength(1))
    expect(patchesTo(ORG)[0]).toEqual({
      values: { "address.street": "1 Main St", "address.city": "Lyon", "address.zip": "69001" },
    })
    await waitFor(() => expect(screen.queryByTestId("settings-unit-bar-address")).toBeNull())
  })

  it("a parked save reads Waiting for approval, and the fields wait with it", async () => {
    api.on("patch", ORG, () => ({
      paths: ["address.city"],
      pending: { approvalRequestId: "ar-9" },
    }))
    renderPage()
    await edit("address.city", "Lyon")
    fireEvent.click(screen.getByTestId("settings-unit-save-address"))
    expect((await screen.findByTestId("settings-unit-pending-address")).textContent).toContain(
      "Waiting for approval",
    )
    expect(((await field("address.city")) as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByTestId("settings-unit-bar-address")).toBeNull()
  })

  it("a refused second save shows the server's message and keeps the edits", async () => {
    api.on("patch", ORG, () => {
      throw apiError(
        409,
        "approval_pending",
        "An earlier change to these settings is still waiting for approval.",
      )
    })
    renderPage()
    await edit("address.city", "Paris")
    fireEvent.click(screen.getByTestId("settings-unit-save-address"))
    expect((await screen.findByTestId("settings-unit-error-address")).textContent).toContain(
      "still waiting for approval",
    )
    expect(((await field("address.city")) as HTMLInputElement).value).toBe("Paris")
    expect(screen.getByTestId("settings-unit-bar-address")).toBeTruthy()
  })

  it("Discard puts the stored values back", async () => {
    api.on("get", ORG, () => ({ values: { "address.city": "Lyon" } }))
    renderPage()
    await edit("address.city", "Paris")
    fireEvent.click(screen.getByTestId("settings-unit-discard-address"))
    expect(((await field("address.city")) as HTMLInputElement).value).toBe("Lyon")
    expect(patchesTo(ORG)).toHaveLength(0)
  })
})

describe("AppSettingsPage refetch and custom blocks", () => {
  it("refetches when the page becomes active again (A9)", async () => {
    const [active, setActive] = createSignal(true)
    renderPage({ active })
    await screen.findByTestId("settings-section-general")
    const gets = () => api.get.mock.calls.filter((c) => c[0] === ORG).length
    expect(gets()).toBe(1)
    setActive(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(gets()).toBe(1)
    setActive(true)
    await waitFor(() => expect(gets()).toBe(2))
  })

  it("renders a custom block from the app's export bag", async () => {
    renderPage()
    expect((await screen.findByTestId("fixture-panel")).textContent).toBe("panel")
  })

  it("shows an admin an error card when the export is missing (P2-20)", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {})
    resetAppSettingsPages()
    registerAppSettingsPage({ appId: FIXTURE_APP, manifest: fixtureManifest, exports: {} })
    renderPage()
    expect(await screen.findByTestId("settings-custom-missing-FixturePanel")).toBeTruthy()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("AppSettingsPage leaving with unsaved edits (A9)", () => {
  it("asks before leaving with a dirty tree, and leaves on Discard", async () => {
    api.tool(`${FIXTURE_APP}:categories.list`, () => ({
      version: "v1",
      nodes: [
        { id: "a", parent_id: null, name: "Hardware", sort_order: 0 },
        { id: "b", parent_id: null, name: "Billing", sort_order: 1 },
      ],
    }))
    window.history.pushState({}, "", `/settings/apps/${FIXTURE_APP}`)
    const Leave = () => {
      const navigate = useNavigate()
      return (
        <button type="button" data-testid="leave" onClick={() => navigate("/elsewhere")}>
          leave
        </button>
      )
    }
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <>
              <Leave />
              <AppSettingsPage appId={FIXTURE_APP} active={() => true} />
            </>
          )}
        />
      </Router>
    ))
    await screen.findByTestId("tree-row-a")
    fireEvent.dragStart(screen.getByTestId("tree-row-b"))
    fireEvent.drop(screen.getByTestId("tree-drop-before-a"))
    expect(await screen.findByTestId("tree-dirty-bar")).toBeTruthy()

    fireEvent.click(screen.getByTestId("leave"))
    expect(await screen.findByTestId("app-settings-discard-dialog")).toBeTruthy()
    expect(window.location.pathname).toBe(`/settings/apps/${FIXTURE_APP}`)

    fireEvent.click(screen.getByTestId("app-settings-discard-confirm"))
    await waitFor(() => expect(window.location.pathname).toBe("/elsewhere"))
  })

  it("asks before leaving with a staged list row; Keep editing stays, Discard leaves unsaved", async () => {
    api.tool(`${FIXTURE_APP}:keys.list`, () => [{ id: "k1", label: "CI", prefix: "lk_ab" }])
    api.tool(`${FIXTURE_APP}:keys.create`, () => ({ id: "k2" }))
    window.history.pushState({}, "", `/settings/apps/${FIXTURE_APP}`)
    const Leave = () => {
      const navigate = useNavigate()
      return (
        <button type="button" data-testid="leave" onClick={() => navigate("/elsewhere")}>
          leave
        </button>
      )
    }
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <>
              <Leave />
              <AppSettingsPage appId={FIXTURE_APP} active={() => true} />
            </>
          )}
        />
      </Router>
    ))
    await screen.findByTestId("settings-list-row-k1")
    fireEvent.click(screen.getByTestId("settings-list-add"))
    fireEvent.input(screen.getByTestId("settings-list-create-label"), {
      target: { value: "Deploy" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    expect(screen.getByTestId("settings-list-dirty-bar")).toBeTruthy()

    fireEvent.click(screen.getByTestId("leave"))
    const dialog = await screen.findByTestId("app-settings-discard-dialog")
    fireEvent.click(within(dialog).getByText("Keep editing"))
    await waitFor(() => expect(screen.queryByTestId("app-settings-discard-dialog")).toBeNull())
    expect(window.location.pathname).toBe(`/settings/apps/${FIXTURE_APP}`)
    expect(screen.getByTestId("settings-list-row-new-1")).toBeTruthy()

    fireEvent.click(screen.getByTestId("leave"))
    fireEvent.click(await screen.findByTestId("app-settings-discard-confirm"))
    await waitFor(() => expect(window.location.pathname).toBe("/elsewhere"))
    expect(api.toolCalls().some((c) => c.toolName === `${FIXTURE_APP}:keys.create`)).toBe(false)
  })
})

describe("AppSettingsPage when the app's manifest arrives after the page drew", () => {
  afterEach(() => orgAppsStore.reset())

  it("keeps an unsaved tree edit made on the admin's copy of the page", async () => {
    // An admin's page can draw first from the workspace's app list, before the manifests feed
    // registers the app. The same sections arriving from the feed must not redraw the blocks.
    resetAppSettingsPages()
    orgAppsStore.set([
      {
        name: FIXTURE_APP,
        displayName: "Fixture",
        version: "1.2.3",
        kind: "app",
        status: "active",
        accessMode: "everyone",
        principals: { roleIds: [], userIds: [] },
        hasOwnScopes: true,
        dependents: [],
        installSource: "in-tree",
        listing: null,
        settings: JSON.parse(JSON.stringify(fixtureManifest.settings)),
      } as OrgApp,
    ])
    api.tool(`${FIXTURE_APP}:categories.list`, () => ({
      version: "v1",
      nodes: [
        { id: "a", parent_id: null, name: "Hardware", sort_order: 0 },
        { id: "b", parent_id: null, name: "Billing", sort_order: 1 },
      ],
    }))
    renderPage({ active: () => true })
    await screen.findByTestId("tree-row-a")
    fireEvent.dragStart(screen.getByTestId("tree-row-b"))
    fireEvent.drop(screen.getByTestId("tree-row-a"))
    await waitFor(() =>
      expect(screen.getByTestId("tree-row-b").getAttribute("data-depth")).toBe("2"),
    )

    registerAppSettingsPage({
      appId: FIXTURE_APP,
      manifest: fixtureManifest,
      exports: { FixturePanel: () => <div data-testid="fixture-panel">panel</div> },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId("tree-row-b").getAttribute("data-depth")).toBe("2")
    expect(screen.getByTestId("tree-dirty-bar")).toBeTruthy()
    expect(api.toolCalls().filter((c) => c.toolName.endsWith("categories.list"))).toHaveLength(1)
  })
})
