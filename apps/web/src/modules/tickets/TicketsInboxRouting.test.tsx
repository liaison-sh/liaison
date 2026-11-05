// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  loadInboxes: vi.fn(),
  inboxes: [
    {
      id: "i1",
      connectedAccountId: "ca",
      name: "Support",
      emailAddress: "support@x",
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      isDefaultForCreate: true,
      archivedAt: null,
    },
    {
      id: "i2",
      connectedAccountId: "ca2",
      name: "Sales",
      emailAddress: "sales@x",
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      isDefaultForCreate: false,
      archivedAt: null,
    },
    {
      id: "i3",
      kind: "api",
      connectedAccountId: null,
      name: "Bug reports",
      emailAddress: null,
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      reply_via_inbox_id: "i1",
      reply_from_email: null,
      isDefaultForCreate: false,
      archivedAt: null as string | null,
    },
  ],
  loaded: true,
  toast: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: state.toast }))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ orgId: "org-1" }),
}))
vi.mock("~/modules/tickets/ticket-inbox-store", async (orig) => ({
  handleInboxEvent: vi.fn(),
  loadInboxes: state.loadInboxes,
  // The real save: runs the tool and lets a refusal throw.
  saveInboxSettings: ((await orig()) as any).saveInboxSettings,
  ticketInboxStore: {
    get inboxes() {
      return state.inboxes
    },
    get loaded() {
      return state.loaded
    },
  },
}))

import { ApiError } from "~/lib/api-error"
import { TicketsInboxRouting } from "./TicketsInboxRouting"

describe("TicketsInboxRouting", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.loadInboxes.mockReset()
  })

  it("lists inboxes with default radio selection", () => {
    render(() => <TicketsInboxRouting />)
    expect(screen.getByTestId("tickets-inboxes-list")).toBeTruthy()
    expect(screen.getByTestId("tickets-inboxes-row-i1")).toBeTruthy()
  })

  it("configure form invokes tickets:inboxes.update", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    fireEvent.input(screen.getByTestId("tickets-inboxes-team-i2"), { target: { value: "Support" } })
    fireEvent.change(screen.getByTestId("tickets-inboxes-default-i2"), {
      target: { checked: true },
    })
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:inboxes.update",
      params: { id: "i2", defaultTeam: "Support", isDefaultForCreate: true },
    })
  })

  it("a refused save (403) shows a localized error and keeps the form open", async () => {
    state.api.post = vi.fn().mockRejectedValue(new ApiError("missing scope", 403, "forbidden"))
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-inboxes-save-error-i2").textContent).toBe(
        "You are not allowed to change this inbox's settings. Ask an admin for access.",
      ),
    )
    // Still editing: the save button is there to try again.
    expect(screen.getByTestId("tickets-inboxes-save-i2")).toBeTruthy()
  })

  it("a failed save says it was not saved and why", async () => {
    state.api.post = vi.fn().mockRejectedValue(new ApiError("Inbox name already taken", 409))
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-inboxes-save-error-i2").textContent).toBe(
        "The inbox settings were not saved: Inbox name already taken",
      ),
    )
  })

  it("a save parked for a second approver says so instead of closing as saved", async () => {
    state.api.post = vi.fn().mockResolvedValue({ blocked: { approvalRequestId: "ar-1" } })
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-inboxes-save-pending-i2").textContent).toContain(
        "second approver",
      ),
    )
  })

  it("a successful save closes the form", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() => expect(screen.queryByTestId("tickets-inboxes-save-i2")).toBeNull())
    expect(screen.queryByTestId("tickets-inboxes-save-error-i2")).toBeNull()
  })

  it("configure form toggles per-inbox SLA exemption (slaExempt)", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    const toggle = screen.getByTestId("tickets-inboxes-sla-exempt-i2") as HTMLInputElement
    expect(toggle.checked).toBe(false) // default: inbox tickets carry an SLA
    fireEvent.click(toggle)
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:inboxes.update",
      params: { id: "i2", slaExempt: true },
    })
  })

  it("close-silent is off by default and sends only the switch while off", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    const toggle = screen.getByTestId("tickets-inboxes-close-silent-enabled-i2") as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.queryByTestId("tickets-inboxes-close-silent-nudge-days-i2")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    const params = state.api.post.mock.calls[0][1].params
    expect(params.closeSilentEnabled).toBe(false)
    expect(params).not.toHaveProperty("closeSilentNudgeDays")
  })

  it("switching close-silent on shows 7 and 5 days and the default nudge, and saves them", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i2"))
    fireEvent.click(screen.getByTestId("tickets-inboxes-close-silent-enabled-i2"))
    const nudge = screen.getByTestId(
      "tickets-inboxes-close-silent-nudge-days-i2",
    ) as HTMLInputElement
    const close = screen.getByTestId(
      "tickets-inboxes-close-silent-close-days-i2",
    ) as HTMLInputElement
    const text = screen.getByTestId("tickets-inboxes-close-silent-text-i2") as HTMLTextAreaElement
    expect(nudge.value).toBe("7")
    expect(close.value).toBe("5")
    expect(text.placeholder).toContain("5")
    fireEvent.input(close, { target: { value: "200" } })
    fireEvent.input(text, { target: { value: "Still there?" } })
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i2"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1].params).toMatchObject({
      id: "i2",
      closeSilentEnabled: true,
      closeSilentNudgeDays: 7,
      closeSilentCloseDays: 90,
      closeSilentNudgeText: "Still there?",
    })
  })

  it("disconnect asks first, then calls tickets:inboxes.disconnect", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-disconnect-i1"))
    const dialog = await screen.findByTestId("tickets-inboxes-disconnect-dialog")
    expect(dialog).toHaveTextContent("tickets and their messages stay")
    expect(state.api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("tickets-inboxes-disconnect-dialog-confirm"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:inboxes.disconnect",
      params: { id: "i1" },
    })
  })

  it("a disconnected (archived) inbox leaves the list: no Configure, no API key", () => {
    const archived = {
      id: "i9",
      kind: "api",
      connectedAccountId: null,
      name: "Old API inbox",
      emailAddress: null,
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      reply_via_inbox_id: "i1",
      reply_from_email: null,
      isDefaultForCreate: false,
      archivedAt: "2026-10-25T09:35:12.000Z",
    }
    state.inboxes.push(archived)
    try {
      render(() => <TicketsInboxRouting />)
      expect(screen.getByTestId("tickets-inboxes-configure-i3")).toBeTruthy()
      expect(screen.queryByTestId("tickets-inboxes-configure-i9")).toBeNull()
      expect(screen.getByTestId("tickets-inboxes-list")).not.toHaveTextContent("Old API inbox")
    } finally {
      state.inboxes.pop()
    }
  })

  it("connecting a mailbox is the page's connections block: no Gmail or IMAP form here", () => {
    render(() => <TicketsInboxRouting />)
    expect(screen.queryByTestId("tickets-inboxes-connect-gmail")).toBeNull()
    expect(screen.queryByTestId("tickets-inboxes-connect-imap")).toBeNull()
    expect(screen.queryByTestId("tickets-inboxes-imap-form")).toBeNull()
    expect(screen.getByTestId("tickets-inboxes-connect-api")).toBeTruthy()
  })

  it("Reconnect on an IMAP inbox points to the connections block instead of a form", async () => {
    const original = state.inboxes
    state.inboxes = [
      {
        ...original[0],
        connection_health: { status: "needs_reconnect", connection: "imap", reason: "error" },
      },
      ...original.slice(1),
    ] as any
    try {
      render(() => <TicketsInboxRouting />)
      fireEvent.click(screen.getByTestId("tickets-inboxes-reconnect-i1"))
      await waitFor(() =>
        expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "info" })),
      )
      expect(state.api.post).not.toHaveBeenCalled()
    } finally {
      state.inboxes = original
    }
  })

  it("renders a kind badge per inbox (Mailbox vs API)", () => {
    render(() => <TicketsInboxRouting />)
    expect(screen.getByTestId("tickets-inboxes-kind-i1").textContent).toBe("Mailbox")
    expect(screen.getByTestId("tickets-inboxes-kind-i3").textContent).toBe("API")
  })

  it("create API inbox form submits kind:api via tickets:inboxes.create", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-connect-api"))
    fireEvent.input(screen.getByTestId("tickets-api-inbox-name"), {
      target: { value: "Website contact" },
    })
    fireEvent.change(screen.getByTestId("tickets-api-inbox-reply-via"), {
      target: { value: "i1" },
    })
    fireEvent.input(screen.getByTestId("tickets-api-inbox-reply-from"), {
      target: { value: "hello@x.test" },
    })
    fireEvent.click(screen.getByTestId("tickets-api-inbox-create"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:inboxes.create",
      params: {
        kind: "api",
        name: "Website contact",
        replyViaInboxId: "i1",
        replyFromEmail: "hello@x.test",
      },
    })
  })

  it("API inbox row shows a copyable ingest URL and a generate-key action", async () => {
    render(() => <TicketsInboxRouting />)
    const urlEl = screen.getByTestId("tickets-inboxes-ingest-url-i3")
    expect(urlEl.textContent).toContain("/webhooks/org-1/inboxes/i3/tickets/create")

    state.api.post = vi
      .fn()
      .mockResolvedValue({ id: "k1", label: "Bug reports ingest", key: "RAW_KEY" })
    fireEvent.click(screen.getByTestId("tickets-inboxes-generate-key-i3"))
    await waitFor(() => expect(screen.getByTestId("tickets-inboxes-key-reveal")).toBeTruthy())
    expect(screen.getByTestId("tickets-inboxes-key-reveal").textContent).toContain("RAW_KEY")
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:apiKeys.create",
      params: { inboxId: "i3" },
    })
  })

  it("mailbox inbox rows do not render the API ingest panel", () => {
    render(() => <TicketsInboxRouting />)
    expect(screen.queryByTestId("tickets-inboxes-api-panel-i1")).toBeNull()
  })

  it("configure form submits the per-inbox email identity fields (reply-to, signature, ack)", async () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i1"))
    fireEvent.input(screen.getByTestId("tickets-inboxes-reply-to-i1"), {
      target: { value: "support@fabrikam.example" },
    })
    fireEvent.input(screen.getByTestId("tickets-inboxes-signature-html-i1"), {
      target: { value: "<p>The Team</p>" },
    })
    fireEvent.input(screen.getByTestId("tickets-inboxes-signature-text-i1"), {
      target: { value: "The Team" },
    })
    fireEvent.change(screen.getByTestId("tickets-inboxes-ack-enabled-i1"), {
      target: { checked: false },
    })
    fireEvent.input(screen.getByTestId("tickets-inboxes-sla-promise-i1"), {
      target: { value: "within 1 business day" },
    })
    fireEvent.input(screen.getByTestId("tickets-inboxes-ack-body-i1"), {
      target: { value: "Custom ack body" },
    })
    fireEvent.click(screen.getByTestId("tickets-inboxes-save-i1"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:inboxes.update",
      params: {
        id: "i1",
        replyToEmail: "support@fabrikam.example",
        signatureHtml: "<p>The Team</p>",
        signatureText: "The Team",
        ackEnabled: false,
        ackBodyText: "Custom ack body",
        slaPromisePhrase: "within 1 business day",
      },
    })
  })

  it("ack-enabled checkbox defaults to checked (ack on by default)", () => {
    render(() => <TicketsInboxRouting />)
    fireEvent.click(screen.getByTestId("tickets-inboxes-configure-i1"))
    const checkbox = screen.getByTestId("tickets-inboxes-ack-enabled-i1") as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it("healthy inboxes show no connection-health badge or reconnect button", () => {
    render(() => <TicketsInboxRouting />)
    expect(screen.queryByTestId("tickets-inboxes-health-badge-i1")).toBeNull()
    expect(screen.queryByTestId("tickets-inboxes-reconnect-i1")).toBeNull()
  })

  it("an unhealthy inbox shows the badge and Reconnect starts the gmail authorize flow", async () => {
    const original = state.inboxes
    state.inboxes = [
      {
        ...original[0],
        connection_health: { status: "needs_reconnect", connection: "gmail", reason: "error" },
      },
      ...original.slice(1),
    ] as any
    const assignSpy = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    })
    state.api.post = vi.fn().mockResolvedValue({ redirectUrl: "https://accounts.google.test/auth" })
    try {
      render(() => <TicketsInboxRouting />)
      expect(screen.getByTestId("tickets-inboxes-health-badge-i1").textContent).toBe(
        "Needs reconnection",
      )
      expect(screen.getByTestId("tickets-inboxes-health-hint-i1")).toBeTruthy()
      fireEvent.click(screen.getByTestId("tickets-inboxes-reconnect-i1"))
      await waitFor(() =>
        expect(state.api.post).toHaveBeenCalledWith("/connections/tickets/gmail/authorize"),
      )
      await waitFor(() =>
        expect(assignSpy).toHaveBeenCalledWith("https://accounts.google.test/auth"),
      )
    } finally {
      state.inboxes = original
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    }
  })

  it("missing_scopes health renders the re-authorization badge and scope hint", () => {
    const original = state.inboxes
    state.inboxes = [
      {
        ...original[0],
        connection_health: {
          status: "needs_reconnect",
          connection: "gmail",
          reason: "missing_scopes",
          missingScopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
      },
      ...original.slice(1),
    ] as any
    try {
      render(() => <TicketsInboxRouting />)
      expect(screen.getByTestId("tickets-inboxes-health-badge-i1").textContent).toBe(
        "Re-authorization required",
      )
      expect(screen.getByTestId("tickets-inboxes-health-hint-i1").textContent).toContain(
        "gmail.modify",
      )
      expect(screen.getByTestId("tickets-inboxes-reconnect-i1").textContent).toBe("Re-authorize")
    } finally {
      state.inboxes = original
    }
  })
})
