// SPDX-License-Identifier: FSL-1.1-ALv2
// Connections block (§R1 P2-11, S5/A1, S7 labels): one row per account with
// who owns it, Disconnect behind a confirm, Share with organization for a
// personal OAuth account, the credential form inline, `?open=` opening it.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appsStore } from "~/modules/settings/apps-store"
import { apiError, createFakeApi, type FakeApi } from "./__fixtures__/fake-api"

const state = vi.hoisted(() => ({ api: null as unknown, scopes: ["*"] as string[] }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  const has = (s: string) => state.scopes.includes("*") || state.scopes.includes(s)
  return { ...actual, hasScope: has, canAccessScope: (s?: string | null) => !s || has(s) }
})

import { ConnectionsBlock } from "./ConnectionsBlock"

let api: FakeApi

const google = {
  name: "google",
  type: "oauth2" as const,
  purpose: "Google Calendar",
  accounts: { active: 2, error: 0 },
}
const token = {
  name: "token",
  type: "credentials" as const,
  credentialFields: [{ name: "token", label: "Access token", type: "password", required: true }],
  accounts: { active: 0, error: 0 },
}

function account(over: Record<string, unknown>) {
  return {
    id: "acc",
    identifier: "id",
    displayName: null,
    label: null,
    ownerType: "user",
    isMine: true,
    status: "active",
    statusMessage: null,
    tokenExpiresAt: null,
    hasRefreshToken: true,
    connectedByName: "Lena",
    ...over,
  }
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  appsStore.reset()
  api.on("get", "/apps/fixture/connections", () => [google, token])
  api.on("get", "/connections/fixture/google/accounts", () => [
    account({ id: "acc1", identifier: "lena@example.com", label: "lena@example.com" }),
    account({
      id: "acc2",
      identifier: "123456789",
      displayName: "Support rota",
      label: "Support rota",
      ownerType: "org",
      isMine: false,
    }),
  ])
  api.on("get", "/connections/fixture/token/accounts", () => [])
  api.on("delete", "/connections/acc1", () => ({ success: true }))
  api.on("post", "/connections/fixture/google/authorize", () => ({ redirectUrl: null }))
})

function renderBlock(
  props: {
    names?: string[]
    open?: string
    status?: { tool: string; params?: Record<string, string | number | boolean> }
    personalSection?: boolean
  } = {},
) {
  return render(() => (
    <ConnectionsBlock
      app="fixture"
      block={{
        block: "connections",
        ...(props.names ? { names: props.names } : {}),
        ...(props.status ? { status: props.status } : {}),
      }}
      blockId="accounts-0"
      openConnection={props.open}
      personalSection={props.personalSection}
    />
  ))
}

describe("ConnectionsBlock in a section open to everyone", () => {
  it("shows a non-admin their own accounts, no org connection and no status line", async () => {
    state.scopes = []
    renderBlock({ names: ["google"], personalSection: true, status: { tool: "search" } })
    await screen.findByTestId("connections-account-acc1")
    expect(screen.queryByTestId("connections-account-acc2")).toBeNull()
    expect(screen.queryByTestId("connections-status")).toBeNull()
    expect(screen.queryByTestId("connections-share-acc1")).toBeNull()
  })

  it("keeps the org connection for whoever administers it", async () => {
    renderBlock({ names: ["google"], personalSection: true })
    await screen.findByTestId("connections-account-acc1")
    expect(screen.getByTestId("connections-account-acc2")).toBeInTheDocument()
  })

  it("a non-admin holding only the org's account sees the empty state, not the org's", async () => {
    state.scopes = []
    api.on("get", "/connections/fixture/google/accounts", () => [
      account({ id: "acc2", ownerType: "org", isMine: false, label: "Support rota" }),
    ])
    renderBlock({ names: ["google"], personalSection: true })
    expect(await screen.findByText("No account connected yet.")).toBeInTheDocument()
    expect(screen.queryByText("Support rota")).toBeNull()
  })

  it("an org section keeps showing a holder of its scope the org account", async () => {
    state.scopes = []
    renderBlock({ names: ["google"] })
    expect(await screen.findByTestId("connections-account-acc2")).toBeInTheDocument()
  })
})

describe("ConnectionsBlock", () => {
  it("lists each account with its label and owner", async () => {
    renderBlock()
    const mine = await screen.findByTestId("connections-account-acc1")
    expect(mine.textContent).toContain("lena@example.com")
    expect(mine.textContent).toContain("Personal (only you)")
    const org = screen.getByTestId("connections-account-acc2")
    expect(org.textContent).toContain("Support rota")
    expect(org.textContent).toContain("Organization")
    expect(org.textContent).toContain("Access renews automatically")
  })

  it("disconnects one account after the confirm", async () => {
    renderBlock({ names: ["google"] })
    fireEvent.click(await screen.findByTestId("connections-disconnect-acc1"))
    const dialog = await screen.findByTestId("connections-disconnect-dialog")
    fireEvent.click(within(dialog).getByTestId("connections-disconnect-dialog-confirm"))
    await waitFor(() =>
      expect(api.delete.mock.calls.some((c) => c[0] === "/connections/acc1")).toBe(true),
    )
  })

  it("offers to share a personal OAuth account with the organization (org mode)", async () => {
    renderBlock({ names: ["google"] })
    fireEvent.click(await screen.findByTestId("connections-share-acc1"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/fixture/google/authorize")?.[1],
      ).toMatchObject({ mode: "org" }),
    )
    expect(screen.queryByTestId("connections-share-acc2")).toBeNull()
  })

  it("does not offer Share to someone who cannot administer the app's accounts", async () => {
    state.scopes = []
    renderBlock({ names: ["google"] })
    await screen.findByTestId("connections-account-acc1")
    expect(screen.queryByTestId("connections-share-acc1")).toBeNull()
  })

  // The connection's own admin scope (manifest connections.<name>.adminScope, served
  // resolved by the listing) decides Share and an org account's Disconnect, as on the server.
  it("offers Share and the org account's Disconnect to the connection's own admin scope", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...google, adminScope: "fixture:admin:connection" },
      token,
    ])
    state.scopes = ["fixture:admin:connection"]
    renderBlock({ names: ["google"] })
    expect(await screen.findByTestId("connections-share-acc1")).toBeTruthy()
    expect(screen.getByTestId("connections-disconnect-acc2")).toBeTruthy()
  })

  it("does not offer them for the default scope when the connection names its own", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...google, adminScope: "fixture:admin:connection" },
      token,
    ])
    state.scopes = ["fixture:accounts:admin"]
    renderBlock({ names: ["google"] })
    await screen.findByTestId("connections-account-acc1")
    expect(screen.queryByTestId("connections-share-acc1")).toBeNull()
    expect(screen.queryByTestId("connections-disconnect-acc2")).toBeNull()
  })

  it("embeds the credential form inline for a credentials connection", async () => {
    renderBlock({ names: ["token"] })
    fireEvent.click(await screen.findByTestId("connections-connect-token"))
    const form = await screen.findByTestId("fixture-inline-connect")
    expect(await within(form).findByTestId("connect-field-token")).toBeTruthy()
  })

  it("reconnects a per-store OAuth account through the form when its store is not derivable", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...google, name: "shop", purpose: "Store", templateVars: ["shop"] },
    ])
    api.on("get", "/connections/fixture/shop/accounts", () => [
      account({
        id: "acc9",
        identifier: "example.myshopify.com",
        ownerType: "org",
        status: "error",
      }),
    ])
    renderBlock({ names: ["shop"] })
    fireEvent.click(await screen.findByTestId("connections-reconnect-acc9"))
    expect(await screen.findByTestId("fixture-inline-connect")).toBeTruthy()
    expect(api.post.mock.calls.some((c) => String(c[0]).endsWith("/authorize"))).toBe(false)
  })

  it("opens the form on the account's store when the store alone cannot start the grant", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      {
        ...google,
        name: "shop",
        purpose: "Store",
        templateVars: ["shop", "region"],
        identifierVar: "shop",
      },
    ])
    api.on("get", "/connections/fixture/shop/accounts", () => [
      account({ id: "acc9", identifier: "example.myshopify.com", ownerType: "org" }),
    ])
    renderBlock({ names: ["shop"] })
    fireEvent.click(await screen.findByTestId("connections-reconnect-acc9"))
    const form = await screen.findByTestId("fixture-inline-connect")
    const input = (await within(form).findByTestId("oauth-var-shop")) as HTMLInputElement
    expect(input.value).toBe("example.myshopify.com")
    expect(api.post.mock.calls.some((c) => String(c[0]).endsWith("/authorize"))).toBe(false)
  })

  // New scopes on an app need a fresh grant: every account its viewer may manage
  // offers Reconnect, healthy or not.
  it("offers Reconnect on a healthy OAuth account, which re-runs the grant for that account", async () => {
    renderBlock({ names: ["google"] })
    fireEvent.click(await screen.findByTestId("connections-reconnect-acc1"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/fixture/google/authorize")?.[1],
      ).toMatchObject({ mode: "personal", accountHint: "lena@example.com" }),
    )
    expect(screen.getByTestId("connections-reconnect-acc2").textContent).toContain("Reconnect")
  })

  it("reconnects an org account in org mode", async () => {
    renderBlock({ names: ["google"] })
    fireEvent.click(await screen.findByTestId("connections-reconnect-acc2"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/fixture/google/authorize")?.[1],
      ).toMatchObject({ mode: "org", accountHint: "123456789" }),
    )
  })

  it("does not offer Reconnect on an org account to someone who cannot administer it", async () => {
    state.scopes = []
    renderBlock({ names: ["google"] })
    await screen.findByTestId("connections-account-acc2")
    expect(screen.getByTestId("connections-reconnect-acc1")).toBeTruthy()
    expect(screen.queryByTestId("connections-reconnect-acc2")).toBeNull()
  })

  it("reconnects a store account straight to the provider for that account's store", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      {
        ...google,
        name: "shop",
        purpose: "Store",
        templateVars: ["shop"],
        identifierVar: "shop",
      },
    ])
    api.on("get", "/connections/fixture/shop/accounts", () => [
      account({ id: "acc9", identifier: "example.myshopify.com", ownerType: "org" }),
    ])
    api.on("post", "/connections/fixture/shop/authorize", () => ({ redirectUrl: null }))
    renderBlock({ names: ["shop"] })
    fireEvent.click(await screen.findByTestId("connections-reconnect-acc9"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/fixture/shop/authorize")?.[1],
      ).toMatchObject({ mode: "org", shop: "example.myshopify.com" }),
    )
    expect(screen.queryByTestId("fixture-inline-connect")).toBeNull()
  })

  it("opens the form of the connection `?open=` names", async () => {
    renderBlock({ open: "token" })
    expect(await screen.findByTestId("fixture-inline-connect")).toBeTruthy()
  })

  it("names an account without a readable name by its connection, never by its number or UUID", async () => {
    const uuid = "fc420f33-800d-4c3e-9a51-0d6f1b2c3e4a"
    api.on("get", "/connections/fixture/google/accounts", () => [
      account({
        id: "acc3",
        identifier: "987654321",
        label: null,
        ownerType: "org",
        isMine: false,
      }),
      account({ id: "acc4", identifier: uuid, label: null }),
    ])
    renderBlock({ names: ["google"] })
    const row = await screen.findByTestId("connections-account-acc3")
    expect(screen.getByTestId("connections-account-label-acc3").textContent).toBe("Google Calendar")
    expect(row.textContent).not.toContain("987654321")
    const other = await screen.findByTestId("connections-account-acc4")
    expect(screen.getByTestId("connections-account-label-acc4").textContent).toBe("Google Calendar")
    expect(other.textContent).not.toContain(uuid)
  })

  it("falls back to the account counts when the accounts cannot be read", async () => {
    api.on("get", "/connections/fixture/google/accounts", () => {
      throw apiError(500, "internal")
    })
    renderBlock({ names: ["google"] })
    const conn = await screen.findByTestId("connections-conn-google")
    await waitFor(() => expect(conn.textContent).toContain("2 connected"))
  })
})

// A connector's card says whether its connection works, from a real read the
// manifest names (`status`), and fixes it in place (P1 S5): the probe's
// answer, not the stored account rows, is what a dead token shows up in.
describe("ConnectionsBlock connection names", () => {
  it("names a connection by its declared purpose", async () => {
    renderBlock({ names: ["google"] })
    const card = await screen.findByTestId("connections-conn-google")
    expect(card.textContent).toContain("Google Calendar")
  })

  it("names a connection without a declared label in words, never by its raw id", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...token, name: "api_token", accounts: { active: 0, error: 0 } },
    ])
    api.on("get", "/connections/fixture/api_token/accounts", () => [])
    renderBlock()
    const card = await screen.findByTestId("connections-conn-api_token")
    await waitFor(() => expect(card.textContent).toContain("API token"))
    expect(card.textContent).not.toContain("api_token")
  })

  it("spells a protocol connection as its initials: IMAP, never Imap", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...token, name: "imap", accounts: { active: 0, error: 0 } },
    ])
    api.on("get", "/connections/fixture/imap/accounts", () => [])
    renderBlock()
    const card = await screen.findByTestId("connections-conn-imap")
    await waitFor(() => expect(card.textContent).toContain("IMAP"))
    expect(card.textContent).not.toContain("Imap")
  })

  it("names the app's own connection by the app's name", async () => {
    api.on("get", "/apps/gitlab/connections", () => [
      { ...token, name: "gitlab", accounts: { active: 0, error: 0 } },
    ])
    api.on("get", "/connections/gitlab/gitlab/accounts", () => [])
    render(() => (
      <ConnectionsBlock app="gitlab" block={{ block: "connections" }} blockId="accounts-0" />
    ))
    const card = await screen.findByTestId("connections-conn-gitlab")
    await waitFor(() => expect(card.textContent).toContain("GitLab"))
    expect(card.textContent).not.toMatch(/\bgitlab\b/)
  })

  it("says Not connected once, with one Connect, when nothing is connected", async () => {
    api.tool("fixture:probe_read", () => ({ error: { code: "not_connected", message: "none" } }))
    renderBlock({ names: ["token"], status: { tool: "probe_read" } })
    const block = await screen.findByTestId("settings-block-accounts-0")
    const card = await screen.findByTestId("connections-conn-token")
    await waitFor(() => expect(api.toolCalls().length).toBe(1))
    await waitFor(() => expect(card.textContent).toContain("No account connected yet."))
    expect(block.textContent).not.toContain("Nothing is connected yet.")
    expect(block.textContent).not.toContain("Not connected")
  })
})

describe("ConnectionsBlock status line", () => {
  const status = { tool: "probe_read", params: { limit: 1 } }
  /** The token connection with an account on record, so the line has something to say. */
  const tokenOnRecord = () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...token, accounts: { active: 1, error: 0 } },
    ])
    api.on("get", "/connections/fixture/token/accounts", () => [
      account({ id: "tok1", identifier: "token", label: "token", ownerType: "org" }),
    ])
  }
  const buttonsNamed = (root: HTMLElement, name: string) =>
    within(root)
      .queryAllByRole("button")
      .filter((b) => b.textContent?.trim() === name)

  it("reads the status tool with its params and says Connected", async () => {
    api.tool("fixture:probe_read", () => ({ items: [] }))
    renderBlock({ names: ["token"], status })
    const line = await screen.findByTestId("connections-status")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("connected"))
    expect(line.textContent).toContain("Connected")
    expect(api.toolCalls()).toEqual([{ toolName: "fixture:probe_read", params: { limit: 1 } }])
  })

  // A connected card is unchanged: the health line (with Check again, no fix)
  // above the account row and its own actions.
  it("connected: the line keeps Check again, the card its account and Replace", async () => {
    tokenOnRecord()
    api.tool("fixture:probe_read", () => ({ items: [] }))
    renderBlock({ names: ["token"], status })
    const line = await screen.findByTestId("connections-status")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("connected"))
    expect(within(line).getByTestId("connections-status-refresh")).toBeTruthy()
    expect(within(line).queryByTestId("connections-status-fix")).toBeNull()
    expect(await screen.findByTestId("connections-account-tok1")).toBeTruthy()
    expect(screen.getByTestId("connections-reconnect-tok1").textContent).toContain("Replace")
    expect(screen.getByTestId("connections-disconnect-tok1")).toBeTruthy()
  })

  // Nothing connected: ONE empty state (the card's) with ONE Connect, no
  // status box offering a second Connect and a Check again with nothing to check.
  it("not connected: one empty state, exactly one Connect, which opens the form", async () => {
    api.tool("fixture:probe_read", () => ({ error: { code: "not_connected", message: "none" } }))
    renderBlock({ names: ["token"], status })
    const block = await screen.findByTestId("settings-block-accounts-0")
    await screen.findByTestId("connections-connect-token")
    await waitFor(() => expect(api.toolCalls().length).toBe(1))
    await waitFor(() => expect(screen.queryByTestId("connections-status")).toBeNull())
    expect(buttonsNamed(block, "Connect")).toHaveLength(1)
    expect(buttonsNamed(block, "Check again")).toHaveLength(0)
    fireEvent.click(screen.getByTestId("connections-connect-token"))
    expect(await screen.findByTestId("fixture-inline-connect")).toBeTruthy()
  })

  // run-tool answers "nothing connected" with a 200 carrying the error
  // envelope (lib/tool-answer.ts): read as success, it printed "Connected".
  it("reads a 200 not_connected envelope as Not connected", async () => {
    tokenOnRecord()
    api.tool("fixture:probe_read", () => ({
      error: { code: "fixture_not_connected", message: "No connection" },
    }))
    renderBlock({ names: ["token"], status })
    const line = await screen.findByTestId("connections-status")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("not_connected"))
    expect(line.textContent).toContain("Not connected")
  })

  it("reads a thrown not_connected as Not connected, with no second Connect", async () => {
    tokenOnRecord()
    api.tool("fixture:probe_read", () => {
      throw apiError(400, "not_connected", "No connection")
    })
    renderBlock({ names: ["token"], status })
    const line = await screen.findByTestId("connections-status")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("not_connected"))
    expect(within(line).queryByTestId("connections-status-fix")).toBeNull()
    expect(within(line).queryByTestId("connections-status-refresh")).toBeNull()
  })

  it("shows the probe's own message when the status cannot be read", async () => {
    api.tool("fixture:probe_read", () => {
      throw apiError(502, "tool_error", "GitLab rejected the token (401 Unauthorized)")
    })
    renderBlock({ names: ["token"], status })
    const line = await screen.findByTestId("connections-status")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("unavailable"))
    expect(screen.getByTestId("connections-status-message").textContent).toContain(
      "GitLab rejected the token (401 Unauthorized)",
    )
    expect(line.textContent).toContain("may have expired or been revoked")
  })

  it("lists the warnings a status answer carries", async () => {
    api.tool("fixture:probe_read", () => ({ ok: true, warnings: ["role can INSERT into orders"] }))
    renderBlock({ names: ["token"], status })
    const warnings = await screen.findByTestId("connections-status-warnings")
    expect(warnings.textContent).toContain("role can INSERT into orders")
  })

  it("a dead credential is replaced in place: the form opens in the card, a save re-checks", async () => {
    let probes = 0
    api.tool("fixture:probe_read", () => {
      probes += 1
      throw apiError(502, "tool_error", "401 Unauthorized")
    })
    api.on("post", "/connections/fixture/token/credentials", () => ({ success: true }))
    renderBlock({ names: ["token"], status })
    fireEvent.click(await screen.findByTestId("connections-status-fix"))
    const form = await screen.findByTestId("fixture-inline-connect")
    fireEvent.input(await within(form).findByTestId("connect-field-token"), {
      target: { value: "new-token" },
    })
    expect(probes).toBe(1)
    fireEvent.click(within(form).getByTestId("connect-submit"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/fixture/token/credentials")?.[1],
      ).toMatchObject({ credentials: { token: "new-token" } }),
    )
    await waitFor(() => expect(probes).toBe(2))
    expect(window.location.pathname).not.toContain("/settings/admin/apps")
  })

  it("a revoked OAuth grant offers Reconnect, which starts the authorize flow", async () => {
    api.tool("fixture:probe_read", () => {
      throw apiError(401, "OAUTH_REVOKED", "Access was revoked")
    })
    renderBlock({ names: ["google"], status })
    const line = await screen.findByTestId("connections-status")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("revoked"))
    fireEvent.click(screen.getByTestId("connections-status-fix"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.some((c) => c[0] === "/connections/fixture/google/authorize"),
      ).toBe(true),
    )
  })

  it("Check again shows it is busy while the read runs", async () => {
    let release: (v: unknown) => void = () => {}
    let first = true
    api.tool("fixture:probe_read", () => {
      if (first) {
        first = false
        return { items: [] }
      }
      return new Promise((resolve) => {
        release = resolve
      })
    })
    renderBlock({ names: ["token"], status })
    const again = await screen.findByTestId("connections-status-refresh")
    await waitFor(() => expect(again.getAttribute("aria-busy")).toBeNull())
    fireEvent.click(again)
    await waitFor(() => expect(again.getAttribute("aria-busy")).toBe("true"))
    release({ items: [] })
    await waitFor(() => expect(again.getAttribute("aria-busy")).toBeNull())
  })

  it("no status tool, no status line", async () => {
    renderBlock({ names: ["token"] })
    await screen.findByTestId("connections-conn-token")
    expect(screen.queryByTestId("connections-status")).toBeNull()
  })
})

// A multi-instance connection's accounts are each named by an identifier the
// app defines (an adapter slug): the generic form cannot add or replace one,
// so the block lists them and leaves adding to the app's own block.
describe("ConnectionsBlock multi-instance", () => {
  it("lists the accounts with Disconnect, and no generic Connect or Replace", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...token, name: "api", multiInstance: true, accounts: { active: 1, error: 0 } },
    ])
    api.on("get", "/connections/fixture/api/accounts", () => [
      account({ id: "crm", identifier: "crm", label: "crm", ownerType: "org", isMine: false }),
    ])
    renderBlock({ names: ["api"] })
    await screen.findByTestId("connections-account-crm")
    expect(screen.getByTestId("connections-disconnect-crm")).toBeTruthy()
    expect(screen.queryByTestId("connections-reconnect-crm")).toBeNull()
    expect(screen.queryByTestId("connections-connect-api")).toBeNull()
  })

  it("offers Reconnect on each account of a multi-instance OAuth connection", async () => {
    api.on("get", "/apps/fixture/connections", () => [
      { ...google, name: "sites", multiInstance: true, accounts: { active: 2, error: 0 } },
    ])
    api.on("get", "/connections/fixture/sites/accounts", () => [
      account({ id: "s1", identifier: "one@example.com", ownerType: "org", isMine: false }),
      account({ id: "s2", identifier: "two@example.com", ownerType: "org", isMine: false }),
    ])
    api.on("post", "/connections/fixture/sites/authorize", () => ({ redirectUrl: null }))
    renderBlock({ names: ["sites"] })
    fireEvent.click(await screen.findByTestId("connections-reconnect-s2"))
    expect(screen.getByTestId("connections-reconnect-s1")).toBeTruthy()
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/fixture/sites/authorize")?.[1],
      ).toMatchObject({ mode: "org", accountHint: "two@example.com" }),
    )
    expect(screen.queryByTestId("connections-connect-sites")).toBeNull()
  })
})
