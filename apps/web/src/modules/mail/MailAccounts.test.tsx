// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { notifyEntityChange } from "~/framework/entity-changes"
import * as authStore from "~/modules/auth/auth-store"
import { imapConnectProblem, MailAccounts } from "~/modules/mail/MailAccounts"
import { resetMailAccountStore } from "~/modules/mail/mail-account-store"
import * as encryptionStore from "~/modules/mail/mail-encryption-store"
import { resetMailProviderStore } from "~/modules/mail/mail-provider-store"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"
import { ApiProvider } from "~/modules/shell/ApiContext"

let providersResponse: unknown[] = []
let connectionRequests: unknown[] = []
let accountsResponse: unknown[] = []
let authorizeRequests: unknown[] = []
let keyringResponse: unknown = { identityId: null, keyId: null, identities: [], wraps: [] }
let armRequests: string[] = []
let syncRequests: string[] = []
let deleteRequests: string[] = []
let settingsRequests: string[] = []
let settingsResponse: Record<string, string> = {}
let syncRefusal: { status: number; message: string } | null = null
let encryptionSettingsResponse: unknown = null

// The mailbox's locked/unlocked state, driven by the test: a real Solid signal
// built inside the factory so the component reacts to it.
const unlock = vi.hoisted(() => ({ set: (_value: boolean) => {} }))
vi.mock("~/modules/mailbox/mailbox-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/mailbox/mailbox-store")>()
  const { createSignal } = await import("solid-js")
  const [unlocked, setUnlocked] = createSignal(false)
  unlock.set = setUnlocked
  return { ...actual, isMailboxUnlocked: () => unlocked() }
})

function renderMailAccounts() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <MailAccounts />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("MailAccounts", () => {
  beforeEach(() => {
    providersResponse = [
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: false,
        integrationConfigured: true,
        configurationSource: "org",
        supportedOwnerTypes: ["user", "org"],
      },
    ]
    connectionRequests = []
    accountsResponse = []
    authorizeRequests = []
    keyringResponse = { identityId: null, keyId: null, identities: [], wraps: [] }
    armRequests = []
    syncRequests = []
    deleteRequests = []
    settingsRequests = []
    settingsResponse = {}
    syncRefusal = null
    encryptionSettingsResponse = null
    unlock.set(false)

    vi.spyOn(authStore, "canAccessScope").mockImplementation(
      (scope?: string | null) => scope === "mail:accounts:admin",
    )
    // The enrollment wizard binds the user id into the AAD, so the connect flow
    // only opens it for a signed-in user. Without this the wizard never mounts.
    vi.spyOn(authStore, "userFromToken").mockReturnValue({
      userId: "11111111-1111-4111-8111-111111111111",
    } as ReturnType<typeof authStore.userFromToken>)

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)

        if (url.includes("/api/mailbox-keys/arm")) {
          armRequests.push(init?.method ?? "GET")
          return Promise.resolve(
            new Response(JSON.stringify({ data: { moved: ["acc-personal"] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (/\/api\/mail\/accounts\/[^/]+\/sync$/.test(url)) {
          syncRequests.push(url)
          if (syncRefusal) {
            return Promise.resolve(
              new Response(JSON.stringify({ error: { message: syncRefusal.message } }), {
                status: syncRefusal.status,
                headers: { "Content-Type": "application/json" },
              }),
            )
          }
          return Promise.resolve(
            new Response(JSON.stringify({ data: { enqueued: true } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        // Answered in every test: the settings are a module-level signal, and a
        // test that loaded some would otherwise leak them into the next one.
        if (url.endsWith("/api/mailbox/encryption")) {
          if (!encryptionSettingsResponse) {
            return Promise.resolve(new Response(JSON.stringify({ error: {} }), { status: 404 }))
          }
          return Promise.resolve(
            new Response(JSON.stringify({ data: encryptionSettingsResponse }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (url.includes("/api/mail/accounts")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: accountsResponse }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (url.includes("/api/mail/providers")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: providersResponse }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (url.includes("/api/mailbox-keys/me")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: keyringResponse }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (url.includes("/api/connections/mail/gmail/authorize")) {
          authorizeRequests.push(JSON.parse(String(init?.body ?? "{}")))
          return Promise.resolve(
            new Response(JSON.stringify({ data: { redirectUrl: "" } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (/\/api\/connections\/[^/]+$/.test(url) && init?.method === "DELETE") {
          deleteRequests.push(url)
          return Promise.resolve(
            new Response(JSON.stringify({ data: { success: true } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (/\/api\/connections\/[^/]+\/settings$/.test(url)) {
          settingsRequests.push(url)
          return Promise.resolve(
            new Response(JSON.stringify({ data: { settings: settingsResponse } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        if (url.includes("/api/connections/mail/imap/credentials")) {
          connectionRequests.push(JSON.parse(String(init?.body ?? "{}")))
          return Promise.resolve(
            new Response(JSON.stringify({ data: { id: "connection-1" } }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }

        return Promise.reject(new Error(`Unhandled fetch: ${url}`))
      }),
    )
  })

  afterEach(() => {
    resetMailAccountStore()
    resetMailProviderStore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("shows disabled Gmail actions with mail setup guidance when Gmail is disabled for the org", async () => {
    renderMailAccounts()

    await waitFor(() => {
      expect(
        screen.getAllByText(
          "Gmail is turned off for this workspace. Enable it in Mail Setup to connect accounts.",
        ),
      ).toHaveLength(2)
    })

    expect(screen.getByTestId("mail-connect-gmail")).toBeDisabled()
    expect(screen.getByTestId("mail-connect-shared-gmail")).toBeDisabled()
    expect(screen.getAllByRole("link", { name: /open mail setup/i })[0]).toHaveAttribute(
      "href",
      "/settings/apps/mail?section=providers",
    )
  })

  it("Open Mail Setup on the page it lives on scrolls to the Gmail switch and focuses it", async () => {
    // The Mailbox types section of the same settings page, as SectionView renders it.
    const section = document.createElement("section")
    section.id = "settings-section-mail-providers"
    section.tabIndex = -1
    const toggle = document.createElement("button")
    toggle.setAttribute("data-testid", "settings-input-gmail")
    section.appendChild(toggle)
    document.body.appendChild(section)
    const scrolled = vi.fn()
    section.scrollIntoView = scrolled
    try {
      renderMailAccounts()
      fireEvent.click(await screen.findByTestId("mail-open-setup"))
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(toggle)

      toggle.blur()
      fireEvent.click(screen.getByTestId("mail-open-setup-shared"))
      expect(scrolled).toHaveBeenCalledTimes(2)
      expect(document.activeElement).toBe(toggle)
    } finally {
      section.remove()
    }
  })

  it("refreshes when the Gmail switch flips and when a mailbox connects elsewhere, without a reload", async () => {
    renderMailAccounts()
    await waitFor(() => expect(screen.getByTestId("mail-connect-gmail")).toBeDisabled())

    // An admin (or the agent's approved config change) turns Gmail on.
    providersResponse = [{ ...(providersResponse[0] as object), enabled: true }]
    notifyEntityChange({
      key: "mail:provider",
      app: "mail",
      entity: "provider",
      action: "update",
      data: { id: "gmail", enabled: true },
    })
    await waitFor(() => expect(screen.getByTestId("mail-connect-gmail")).not.toBeDisabled())

    // A shared mailbox connects on a card in a conversation.
    accountsResponse = [
      {
        id: "acc-shared",
        connectedAccountId: "conn-shared",
        provider: "gmail",
        emailAddress: "support@acme.com",
        displayName: "Support",
        ownerType: "org",
        ownerId: null,
        syncStatus: "pre-sync",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
      },
    ]
    notifyEntityChange({
      key: "mail:account",
      app: "mail",
      entity: "account",
      action: "create",
      data: { id: "acc-shared" },
    })
    expect(await screen.findByText("support@acme.com")).toBeInTheDocument()
  })

  it("shows an admin CTA to Mail Setup when Gmail is enabled but Google credentials are missing", async () => {
    providersResponse = [
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: true,
        integrationConfigured: false,
        configurationSource: null,
        supportedOwnerTypes: ["user", "org"],
      },
    ]
    vi.spyOn(authStore, "canAccessScope").mockImplementation(
      (scope?: string | null) => scope === "mail:accounts:admin",
    )

    renderMailAccounts()

    expect(
      await screen.findAllByText(
        "Google credentials are not set up yet. Finish step 1 in Mail Setup to connect Gmail.",
      ),
    ).toHaveLength(2)
    expect(screen.getAllByRole("link", { name: /open mail setup/i })[0]).toHaveAttribute(
      "href",
      "/settings/apps/mail?section=providers",
    )
  })

  it("shows why the OAuth callback refused a mailbox (allowed mail domains)", async () => {
    const reason = "This organisation only connects mailboxes on @acme.example."
    window.history.replaceState(
      null,
      "",
      `/settings/mail/accounts?oauth_error=mail_domain_not_allowed&oauth_error_description=${encodeURIComponent(reason)}`,
    )
    try {
      renderMailAccounts()
      const alert = await screen.findByTestId("mail-connect-error")
      expect(alert).toHaveTextContent(reason)
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })

  it("does not show shared connect actions for non-admins", async () => {
    providersResponse = [
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: true,
        integrationConfigured: true,
        configurationSource: "org",
        supportedOwnerTypes: ["user", "org"],
      },
    ]
    vi.spyOn(authStore, "canAccessScope").mockReturnValue(false)

    renderMailAccounts()

    await screen.findByTestId("mail-connect-gmail")
    expect(screen.queryByTestId("mail-connect-shared-gmail")).not.toBeInTheDocument()
    expect(screen.queryByText("Connect shared IMAP/SMTP")).not.toBeInTheDocument()
  })

  it("renders Manage access deep-link for organization-owned accounts", async () => {
    accountsResponse = [
      {
        id: "acc-shared",
        connectedAccountId: "conn-shared",
        provider: "gmail",
        emailAddress: "support@acme.com",
        displayName: "Support",
        ownerType: "org",
        ownerId: null,
        syncStatus: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
      },
    ]

    renderMailAccounts()

    expect(await screen.findByRole("link", { name: "Manage access" })).toHaveAttribute(
      "href",
      "/settings/admin/roles?dimension=mail%3Ainbox&value=acc-shared",
    )
  })

  it("shows a re-authorization badge and hint when the connection needs reauth", async () => {
    accountsResponse = [
      {
        id: "acc-1",
        connectedAccountId: "conn-1",
        provider: "gmail",
        emailAddress: "me@acme.com",
        displayName: null,
        ownerType: "user",
        ownerId: "u1",
        syncStatus: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
        connectionHealth: {
          status: "needs_reconnect",
          reason: "missing_scopes",
          missingScopes: ["https://www.googleapis.com/auth/gmail.send"],
        },
      },
    ]

    renderMailAccounts()

    expect((await screen.findByTestId("mail-account-health-badge")).textContent).toBe(
      "Re-authorization required",
    )
    expect(screen.getByTestId("mail-account-health-hint").textContent).toContain("gmail.send")
    expect(screen.getByTestId("mail-account-reauthorize")).toBeTruthy()
  })

  it("disconnecting a mailbox asks first, saying the imported mail is deleted", async () => {
    accountsResponse = [
      {
        id: "acc-1",
        connectedAccountId: "conn-1",
        provider: "gmail",
        emailAddress: "me@acme.com",
        displayName: null,
        ownerType: "user",
        ownerId: "u1",
        syncStatus: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
        connectionHealth: { status: "ok" },
      },
    ]

    renderMailAccounts()

    fireEvent.click(await screen.findByTestId("mail-account-disconnect"))
    const dialog = await screen.findByTestId("mail-account-disconnect-dialog")
    expect(dialog).toHaveTextContent("me@acme.com")
    expect(dialog).toHaveTextContent("deleted from Liaison")
    expect(deleteRequests).toEqual([])
    fireEvent.click(screen.getByTestId("mail-account-disconnect-dialog-confirm"))
    await waitFor(() => expect(deleteRequests).toEqual(["/api/connections/conn-1"]))
  })

  it("healthy accounts show no re-authorization affordance", async () => {
    accountsResponse = [
      {
        id: "acc-1",
        connectedAccountId: "conn-1",
        provider: "gmail",
        emailAddress: "me@acme.com",
        displayName: null,
        ownerType: "user",
        ownerId: "u1",
        syncStatus: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
        connectionHealth: { status: "ok" },
      },
    ]

    renderMailAccounts()

    await screen.findByTestId("mail-account-row")
    expect(screen.queryByTestId("mail-account-health-badge")).toBeNull()
    expect(screen.queryByTestId("mail-account-reauthorize")).toBeNull()
  })

  it("keeps the address readable: its own line with a title, actions in a wrapping group", async () => {
    accountsResponse = [
      {
        id: "acc-layout",
        connectedAccountId: "conn-layout",
        provider: "gmail",
        emailAddress: "a.rather.long.address@example-company.com",
        displayName: null,
        ownerType: "user",
        ownerId: "u1",
        syncStatus: "idle",
        lastSyncAt: "2026-10-30T20:57:02.000Z",
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
        connectionHealth: { status: "ok" },
      },
    ]

    renderMailAccounts()

    const address = await screen.findByTestId("mail-account-address")
    expect(address.getAttribute("title")).toBe("a.rather.long.address@example-company.com")
    // The identity column never shrinks below its basis: the actions wrap
    // under it instead of crushing the address to a few letters.
    expect(screen.getByTestId("mail-account-identity").className).toContain("flex-[1_1_16rem]")
    expect(screen.getByTestId("mail-account-actions").className).toContain("flex-wrap")
    expect(screen.getByTestId("mail-account-last-synced").className).toContain("whitespace-nowrap")
  })

  it("a mailbox that never synced says so in words beside its status dot", async () => {
    accountsResponse = [
      {
        id: "acc-new",
        connectedAccountId: "conn-new",
        provider: "imap",
        emailAddress: "new@example.com",
        displayName: null,
        ownerType: "user",
        ownerId: "u1",
        syncStatus: "syncing",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
        connectionHealth: { status: "ok" },
        encryptionState: "pending_enrollment",
      },
    ]

    renderMailAccounts()

    expect(await screen.findByTestId("mail-account-never-synced")).toHaveTextContent(
      "Syncs once the mailbox is set up",
    )
  })

  it("a mailbox waiting for its keys offers no sync and claims none, whatever the row carries", async () => {
    // A gestalt walk: a pending-enrollment mailbox read "Last synced Nov 2" with
    // Sync Now beside "Setup needed", and its security panel said it "is stored
    // with zero-access encryption" before any key existed.
    accountsResponse = [
      {
        ...suspendedPersonalAccount("pending_enrollment"),
        lastSyncAt: "2026-11-02T16:20:00.000Z",
      },
    ]
    renderMailAccounts()

    expect(await screen.findByTestId("mail-account-never-synced")).toHaveTextContent(
      "Syncs once the mailbox is set up",
    )
    expect(screen.queryByTestId("mail-account-last-synced")).toBeNull()
    expect(screen.queryByTestId("mail-account-sync")).toBeNull()

    fireEvent.click(screen.getByTestId("mail-account-security"))
    const claim = await screen.findByTestId("mailbox-security.claim")
    expect(claim.textContent).toContain("not set up yet")
    expect(claim.textContent).not.toContain("Your personal mailbox is stored")
  })

  it("a shared IMAP mailbox in error offers Retry now and Edit credentials, and a labelled disconnect", async () => {
    accountsResponse = [
      {
        id: "acc-shared-imap",
        connectedAccountId: "conn-shared-imap",
        provider: "imap",
        emailAddress: "support@acme.com",
        displayName: "Support",
        ownerType: "org",
        ownerId: null,
        syncStatus: "error",
        lastSyncAt: null,
        lastSyncError: "getaddrinfo ENOTFOUND imap.acme.invalid",
        unreadCount: 0,
        allowedImageSenderDomains: [],
      },
    ]

    renderMailAccounts()

    // A sentence in the UI language; the raw cause only in the title.
    const syncError = await screen.findByTestId("mail-shared-account-sync-error")
    expect(syncError).toHaveTextContent("The mail server's address was not found.")
    expect(syncError).not.toHaveTextContent("ENOTFOUND")
    expect(syncError).toHaveAttribute("title", "getaddrinfo ENOTFOUND imap.acme.invalid")
    const disconnect = screen.getByTestId("mail-shared-account-disconnect")
    expect(disconnect).toHaveAttribute("aria-label", "Disconnect")
    expect(disconnect).toHaveAttribute("title", "Disconnect")

    fireEvent.click(screen.getByTestId("mail-shared-account-retry"))
    await waitFor(() => expect(syncRequests).toHaveLength(1))
    expect(syncRequests[0]).toContain("/api/mail/accounts/acc-shared-imap/sync")

    // Edit opens the connect form for this mailbox, as a shared one.
    fireEvent.click(screen.getByTestId("mail-shared-account-edit"))
    expect(await screen.findByTestId("mail-imap-email")).toHaveValue("support@acme.com")
    fireEvent.input(screen.getByPlaceholderText("IMAP Host"), {
      target: { value: "imap.acme.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("SMTP Host"), {
      target: { value: "smtp.acme.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("Username"), {
      target: { value: "support@acme.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("Password"), { target: { value: "secret" } })
    fireEvent.click(screen.getByTestId("mail-imap-submit"))
    await waitFor(() => expect(connectionRequests).toHaveLength(1))
    expect(connectionRequests[0]).toMatchObject({
      mode: "org",
      email: "support@acme.com",
      imapHost: "imap.acme.com",
    })
  })

  it("a mailbox whose sync keeps failing says calmly when it tries again", async () => {
    const retryAt = new Date(Date.now() + 8 * 60_000).toISOString()
    accountsResponse = [
      {
        id: "acc-shared-imap",
        connectedAccountId: "conn-shared-imap",
        provider: "imap",
        emailAddress: "support@acme.com",
        displayName: "Support",
        ownerType: "org",
        ownerId: null,
        syncStatus: "active",
        lastSyncAt: null,
        lastSyncError: "IMAP timeout",
        nextRetryAt: retryAt,
        unreadCount: 0,
        allowedImageSenderDomains: [],
      },
    ]

    renderMailAccounts()

    const line = await screen.findByTestId("mail-shared-account-sync-retry")
    expect(line).toHaveTextContent("Next try at")
    // Today: only the time, in the page's language (en in tests).
    expect(line).toHaveTextContent(
      new Date(retryAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
    )
    // Calm: grey, not the red of the error itself.
    expect(line.className).toContain("text-text-tertiary")
  })

  it("a personal mailbox whose sync keeps failing shows the retry line and a calm error", async () => {
    const retryAt = new Date(Date.now() + 8 * 60_000).toISOString()
    accountsResponse = [
      {
        id: "acc-imap",
        connectedAccountId: "conn-imap",
        provider: "imap",
        emailAddress: "me@example.com",
        displayName: null,
        ownerType: "user",
        ownerId: "u1",
        syncStatus: "error",
        lastSyncAt: null,
        lastSyncError: "IMAP connection refused: connect ECONNREFUSED ::1:11025",
        nextRetryAt: retryAt,
        unreadCount: 0,
        allowedImageSenderDomains: [],
        connectionHealth: { status: "ok" },
      },
    ]

    renderMailAccounts()

    expect(await screen.findByTestId("mail-account-sync-retry")).toHaveTextContent("Next try at")
    const error = screen.getByTestId("mail-account-sync-error")
    expect(error).toHaveTextContent("The mail server could not be reached.")
    expect(error).not.toHaveTextContent("ECONNREFUSED")
    expect(error).toHaveAttribute(
      "title",
      "IMAP connection refused: connect ECONNREFUSED ::1:11025",
    )
    expect(error.className).not.toContain("text-red-500")
    expect(screen.queryByTestId("mail-account-never-synced")).toBeNull()
  })

  const sharedImapInError = {
    id: "acc-shared-imap",
    connectedAccountId: "conn-shared-imap",
    provider: "imap",
    emailAddress: "support@acme.com",
    displayName: "Support",
    ownerType: "org",
    ownerId: null,
    syncStatus: "error",
    lastSyncAt: null,
    lastSyncError: "getaddrinfo ENOTFOUND imap.acme.invalid",
    unreadCount: 0,
    allowedImageSenderDomains: [],
  }

  it("a Retry now the server refuses says why on the mailbox's row", async () => {
    accountsResponse = [sharedImapInError]
    syncRefusal = { status: 403, message: "Admin scope required for org-account sync" }

    renderMailAccounts()

    fireEvent.click(await screen.findByTestId("mail-shared-account-retry"))
    expect(await screen.findByTestId("mail-shared-account-sync-refused")).toHaveTextContent(
      "Admin scope required for org-account sync",
    )
  })

  it("Edit credentials opens with the stored hosts, ports and username, and asks only for the password", async () => {
    accountsResponse = [sharedImapInError]
    settingsResponse = {
      email: "support@acme.com",
      imapHost: "imap.acme.invalid",
      imapPort: "993",
      smtpHost: "smtp.acme.invalid",
      smtpPort: "587",
      username: "support",
    }

    renderMailAccounts()

    fireEvent.click(await screen.findByTestId("mail-shared-account-edit"))
    await waitFor(() =>
      expect(screen.getByTestId("mail-imap-host")).toHaveValue("imap.acme.invalid"),
    )
    expect(settingsRequests[0]).toContain("/api/connections/conn-shared-imap/settings")
    expect(screen.getByTestId("mail-imap-port")).toHaveValue("993")
    expect(screen.getByTestId("mail-smtp-host")).toHaveValue("smtp.acme.invalid")
    expect(screen.getByTestId("mail-smtp-port")).toHaveValue("587")
    expect(screen.getByTestId("mail-smtp-security")).toHaveValue("starttls")
    expect(screen.getByTestId("mail-imap-username")).toHaveValue("support")
    expect(screen.getByTestId("mail-imap-password")).toHaveValue("")

    fireEvent.input(screen.getByTestId("mail-imap-password"), { target: { value: "secret" } })
    fireEvent.click(screen.getByTestId("mail-imap-submit"))
    await waitFor(() => expect(connectionRequests).toHaveLength(1))
    expect(connectionRequests[0]).toMatchObject({
      mode: "org",
      imapHost: "imap.acme.invalid",
      smtpPort: "587",
      username: "support",
      password: "secret",
    })
  })

  it("the SMTP port default follows the security mode: 587 STARTTLS, 465 implicit TLS", async () => {
    renderMailAccounts()

    fireEvent.click(await screen.findByTestId("mail-connect-imap"))
    expect(screen.getByTestId("mail-smtp-port")).toHaveValue("587")
    expect(screen.getByTestId("mail-smtp-security")).toHaveValue("starttls")
    fireEvent.change(screen.getByTestId("mail-smtp-security"), { target: { value: "tls" } })
    expect(screen.getByTestId("mail-smtp-port")).toHaveValue("465")
    fireEvent.change(screen.getByTestId("mail-smtp-security"), { target: { value: "starttls" } })
    expect(screen.getByTestId("mail-smtp-port")).toHaveValue("587")
    // A custom port is the person's own: switching the mode leaves it.
    fireEvent.input(screen.getByTestId("mail-smtp-port"), { target: { value: "2525" } })
    fireEvent.change(screen.getByTestId("mail-smtp-security"), { target: { value: "tls" } })
    expect(screen.getByTestId("mail-smtp-port")).toHaveValue("2525")
  })

  it("a healthy shared mailbox shows no retry or edit action", async () => {
    accountsResponse = [
      {
        id: "acc-shared-ok",
        connectedAccountId: "conn-shared-ok",
        provider: "imap",
        emailAddress: "ok@acme.com",
        displayName: null,
        ownerType: "org",
        ownerId: null,
        syncStatus: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        unreadCount: 0,
        allowedImageSenderDomains: [],
      },
    ]

    renderMailAccounts()

    expect(await screen.findByTestId("mail-shared-account-disconnect")).toBeInTheDocument()
    expect(screen.queryByTestId("mail-shared-account-retry")).toBeNull()
    expect(screen.queryByTestId("mail-shared-account-edit")).toBeNull()
  })

  it("submits personal IMAP connect mode without ownerType", async () => {
    providersResponse = [
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: true,
        integrationConfigured: true,
        configurationSource: "org",
        supportedOwnerTypes: ["user", "org"],
      },
    ]

    renderMailAccounts()

    fireEvent.click(await screen.findByTestId("mail-connect-imap"))
    fireEvent.input(screen.getByPlaceholderText("Email"), { target: { value: "me@example.com" } })
    fireEvent.input(screen.getByPlaceholderText("IMAP Host"), {
      target: { value: "imap.example.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("SMTP Host"), {
      target: { value: "smtp.example.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("Username"), {
      target: { value: "me@example.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("Password"), { target: { value: "secret" } })
    fireEvent.click(screen.getByTestId("mail-imap-submit"))

    await waitFor(() => expect(connectionRequests).toHaveLength(1))
    expect(connectionRequests[0]).toMatchObject({ mode: "personal" })
    expect(connectionRequests[0]).not.toHaveProperty("ownerType")
  })
  it("does not start the OAuth handoff for a personal mailbox before enrollment", async () => {
    // Spec section 5.1, hard ordering rule: no mail sync may start until the
    // mailbox keys exist. Connecting a PERSONAL mailbox runs the enrollment
    // wizard first and does not issue the OAuth authorize call.
    providersResponse = [
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: true,
        integrationConfigured: true,
        configurationSource: "org",
        supportedOwnerTypes: ["user", "org"],
      },
    ]

    renderMailAccounts()

    // The button exists before the provider list lands and is disabled until
    // then, so clicking on first appearance is a no-op. Wait for it to arm.
    const connect = await screen.findByTestId("mail-connect-gmail")
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)

    expect(await screen.findByTestId("mailbox-enrollment")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.passphrase")).toBeTruthy())
    expect(authorizeRequests).toHaveLength(0)
  })

  function suspendedPersonalAccount(encryptionState: string) {
    return {
      id: "acc-personal",
      connectedAccountId: "conn-personal",
      provider: "gmail",
      emailAddress: "me@acme.com",
      displayName: null,
      ownerType: "user",
      ownerId: "11111111-1111-4111-8111-111111111111",
      syncStatus: "active",
      lastSyncAt: null,
      lastSyncError: null,
      unreadCount: 0,
      allowedImageSenderDomains: [],
      encryptionState,
    }
  }

  it("a Gmail write-back failure is shown in the viewer's language, not as a raw code", async () => {
    accountsResponse = [
      {
        id: "acc-shared",
        connectedAccountId: "conn-shared",
        provider: "gmail",
        emailAddress: "support@acme.com",
        displayName: "Support",
        ownerType: "org",
        ownerId: null,
        syncStatus: "active",
        lastSyncAt: null,
        lastSyncError: "gmail_write_back:scope",
        unreadCount: 0,
        allowedImageSenderDomains: [],
      },
    ]

    renderMailAccounts()

    // A shared mailbox shows it too: its admins are the ones who reconnect it.
    const error = await screen.findByTestId("mail-shared-account-sync-error")
    expect(error.textContent).toContain("Not written to Gmail")
    expect(error.textContent).not.toContain("gmail_write_back")
  })

  it("a suspended personal mailbox offers encryption setup and opens the wizard, never the OAuth connect", async () => {
    // The inbox banner sends the user here to "set up encryption". Before this
    // the page had no such action: the only button that reached the wizard was
    // Connect Gmail, which then ran the OAuth connect a second time and
    // restarted the mailbox import from scratch.
    accountsResponse = [suspendedPersonalAccount("pending_enrollment")]

    renderMailAccounts()

    expect(await screen.findByTestId("mail-account-encryption-badge")).toBeTruthy()
    fireEvent.click(screen.getByTestId("mail-account-enroll"))

    expect(await screen.findByTestId("mailbox-enrollment")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.passphrase")).toBeTruthy())
    expect(authorizeRequests).toHaveLength(0)
    expect(armRequests).toHaveLength(0)
  })

  it("an owner who already has keys re-arms the suspended mailbox and syncs it, without OAuth", async () => {
    // The wizard has nothing to offer an owner with keys ("nothing new to do
    // here"), so the action goes straight to the arm route and then fetches
    // what accumulated at the provider.
    keyringResponse = {
      identityId: "id-1",
      keyId: 1,
      identities: [{ id: "id-1", keyId: 1, status: "active" }],
      wraps: [],
    }
    accountsResponse = [suspendedPersonalAccount("paused")]

    renderMailAccounts()

    fireEvent.click(await screen.findByTestId("mail-account-enroll"))

    await waitFor(() => expect(armRequests).toEqual(["POST"]))
    await waitFor(() => expect(syncRequests).toHaveLength(1))
    expect(syncRequests[0]).toContain("/api/mail/accounts/acc-personal/sync")
    expect(authorizeRequests).toHaveLength(0)
    expect(screen.queryByTestId("mailbox-enrollment")).toBeNull()
  })

  it("a blocked personal mailbox offers a reset that opens the reset flow, never the setup", async () => {
    // A blocked mailbox has keys the server could not use: "set up again" had
    // nothing to do and the page offered no way out at all. The reset is the
    // edge the server allows from blocked, and it leads on to a new password.
    accountsResponse = [suspendedPersonalAccount("blocked")]
    const requests: unknown[] = []
    const listener = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener(MAILBOX_UNLOCK_EVENT, listener)
    try {
      renderMailAccounts()
      expect(await screen.findByTestId("mail-account-stopped-badge")).toBeTruthy()
      expect(screen.queryByTestId("mail-account-enroll")).toBeNull()
      const reset = screen.getByTestId("mail-account-reset")
      expect(reset.textContent).toBe("Reset the mailbox")
      fireEvent.click(reset)
      expect(requests).toEqual([{ view: "reset" }])
      expect(armRequests).toHaveLength(0)
      expect(authorizeRequests).toHaveLength(0)
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, listener)
    }
  })

  it("making a locked private mailbox transparent asks for an emailed code, then to unlock in place, then carries on", async () => {
    // The browser re-encrypts, so it needs the mailbox open. A message saying
    // "unlock first" left the owner hunting for where to unlock: the button
    // opens the unlock popup and the move starts once the mailbox is open.
    accountsResponse = [suspendedPersonalAccount("ready")]
    encryptionSettingsResponse = {
      deploymentDefault: "managed",
      allowManaged: true,
      allowPrivate: true,
      preference: null,
      effective: "managed",
      canMakeTransparent: true,
      canSetPolicy: false,
    }
    const convert = vi
      .spyOn(encryptionStore, "makeMailboxTransparent")
      .mockResolvedValue({ done: true, converted: 3, failed: 0, remaining: 0 })
    const sendCode = vi
      .spyOn(encryptionStore, "requestMakeTransparentCode")
      .mockResolvedValue({ sent: true })
    const requests: unknown[] = []
    const listener = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener(MAILBOX_UNLOCK_EVENT, listener)
    try {
      renderMailAccounts()
      fireEvent.click(await screen.findByTestId("mail-account-make-transparent"))
      // Starting the move takes a step-up: nothing starts without the code.
      const confirm = screen.getByTestId("mail-account-mode-switch-confirm") as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      fireEvent.click(screen.getByTestId("mail-account-mode-switch-send-code"))
      await waitFor(() => expect(sendCode).toHaveBeenCalledTimes(1))
      fireEvent.input(await screen.findByTestId("mail-account-mode-switch-code"), {
        target: { value: "123456" },
      })
      expect(confirm.disabled).toBe(false)
      fireEvent.click(confirm)
      expect(requests).toEqual([{ view: "unlock" }])
      expect(convert).not.toHaveBeenCalled()
      expect(screen.getByTestId("mail-account-mode-switch")).toBeTruthy()
      expect(screen.getByTestId("mail-account-mode-switch-message").textContent).toContain(
        "Unlock your mailbox to continue",
      )

      unlock.set(true)
      await waitFor(() => expect(convert).toHaveBeenCalledTimes(1))
      expect(convert.mock.calls[0]?.[1]).toBe("acc-personal")
      expect(convert.mock.calls[0]?.[3]).toEqual({ stepUpCode: "123456" })
      expect(requests).toHaveLength(1)
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, listener)
    }
  })

  it("a ready personal mailbox shows no encryption setup action", async () => {
    accountsResponse = [suspendedPersonalAccount("ready")]
    renderMailAccounts()
    await screen.findByTestId("mail-account-row")
    expect(screen.queryByTestId("mail-account-enroll")).toBeNull()
    expect(screen.queryByTestId("mail-account-encryption-badge")).toBeNull()
  })

  it("says a personal mailbox is private and needs a mailbox password, before and at connect", async () => {
    providersResponse = [
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: true,
        integrationConfigured: true,
        configurationSource: "org",
        supportedOwnerTypes: ["user", "org"],
      },
    ]
    renderMailAccounts()

    // Before the connect: stated on the page itself.
    const notice = await screen.findByTestId("mail-connect-encryption-notice")
    expect(notice.textContent).toMatch(/private/i)
    expect(notice.textContent).toMatch(/only you can read/i)
    expect(notice.textContent).toMatch(/mailbox password/i)
    expect(notice.textContent).toMatch(/not your Liaison login password/i)

    // At the connect: the enrollment interstitial says it again.
    const connect = await screen.findByTestId("mail-connect-gmail")
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    // At the connect: setup is one screen, the password step, which says
    // what the password is for and that it is not the login password.
    const step = await screen.findByTestId("mailbox-enrollment.password-step")
    expect(step.textContent).toMatch(/choose a password for your mail/i)
    expect(step.textContent).toMatch(/not your Liaison login password/i)
  })
})

describe("imapConnectProblem", () => {
  it("maps the known connection failures and leaves the rest alone", () => {
    expect(imapConnectProblem("IMAP connection refused: connect ECONNREFUSED ::1:11025")).toBe(
      "unreachable",
    )
    expect(imapConnectProblem("getaddrinfo ENOTFOUND imap.acme.invalid")).toBe("not_found")
    expect(imapConnectProblem("IMAP timeout")).toBe("timeout")
    expect(imapConnectProblem("IMAP connection refused: self-signed certificate")).toBe("tls")
    expect(imapConnectProblem("something else")).toBeNull()
  })

  it("reads the bridge's own wording at the start only, the system's error codes anywhere", () => {
    expect(imapConnectProblem("IMAP timeout after 30s")).toBe("timeout")
    expect(imapConnectProblem("sync failed: connect ETIMEDOUT 10.0.0.1:993")).toBe("timeout")
    expect(imapConnectProblem("the server Timed Out")).toBe("timeout")
    expect(imapConnectProblem("IMAP connection refused")).toBe("unreachable")
    expect(imapConnectProblem("sync failed: read ECONNRESET")).toBe("unreachable")
    expect(imapConnectProblem("folder named IMAP timeout is empty")).toBeNull()
    expect(imapConnectProblem("folder named IMAP connection refused is empty")).toBeNull()
  })
})
