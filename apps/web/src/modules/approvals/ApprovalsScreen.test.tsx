// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T12. The approvals queue screen: its title line, and the collapse a
// decided card leaves behind so the next one rises into the gap.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let currentScope: string[] = ["mail:approve"]
const apiMocks = { get: vi.fn().mockResolvedValue(undefined), post: vi.fn() }

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => currentScope.includes(s),
  userFromToken: () => ({ userId: "u-approver", name: "Test User", scopes: currentScope }),
  onAuthCleared: () => () => {},
}))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))
vi.mock("~/modules/approvals/approvals-service", () => ({
  listDecidableByMe: vi.fn(async () => []),
  getApproval: vi.fn(),
  decideApproval: vi.fn(),
  listBundle: vi.fn(async () => []),
  updatePayload: vi.fn(),
}))

import type { AttentionItem } from "@liaison/shared"
import { attentionStore } from "~/modules/shell/attention-store"
import { _resetBranding, ensureBrandingLoaded } from "~/modules/shell/branding-store"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { ApprovalsScreen, COLLAPSE_MS, soonestDeadlineMinutes } from "./ApprovalsScreen"
import { handleWsCreate, handleWsUpdate, resetApprovalsStore } from "./approvals-store"

const NOW = Date.parse("2026-04-30T12:00:00.000Z")

const row = (over: Partial<any> = {}): any => ({
  id: "ar-1",
  handle: "request-0001",
  status: "pending",
  createdAt: "2026-04-30T11:00:00.000Z",
  expiresAt: new Date(Date.now() + 40 * 60_000).toISOString(),
  toolName: "mail:reply",
  summary: { kind: "mail.reply", title: "Re: Test", lines: ["body line"] },
  editableFields: [],
  currentPayload: { textBody: "original" },
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-requester" },
  requester: { kind: "user", id: "u-requester", name: "Bob" },
  notifyUserIds: ["u-approver"],
  lastEdit: null,
  lastFailure: null,
  ...over,
})

describe("soonestDeadlineMinutes", () => {
  it("reports the nearest deadline, ignoring rows that carry none", () => {
    expect(
      soonestDeadlineMinutes(
        [
          { expiresAt: new Date(NOW + 45 * 60_000).toISOString() },
          {},
          { expiresAt: new Date(NOW + 12 * 60_000).toISOString() },
        ],
        NOW,
      ),
    ).toBe(12)
    expect(soonestDeadlineMinutes([], NOW)).toBeNull()
    expect(soonestDeadlineMinutes([{}], NOW)).toBeNull()
  })
})

describe("ApprovalsScreen", () => {
  beforeEach(() => {
    resetApprovalsStore()
    currentScope = ["mail:approve"]
    apiMocks.get.mockReset().mockResolvedValue(undefined)
    apiMocks.post.mockReset()
    vi.useRealTimers()
  })
  afterEach(() => cleanup())

  it("leads with the count and how long the soonest decision has", async () => {
    handleWsCreate(row({ id: "ar-1" }), "u-approver")
    handleWsCreate(
      row({ id: "ar-2", expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() }),
      "u-approver",
    )
    render(() => <ApprovalsScreen />)
    await waitFor(() => expect(screen.getByTestId("approvals-count").textContent).toBe("2"))
    // The SAME humanised formatter the rows use, not raw minutes.
    expect(screen.getByTestId("approvals-summary").textContent).toContain("9m")
    expect(screen.getByTestId("approvals-item-ar-1")).toBeTruthy()
    expect(screen.getByTestId("approvals-item-ar-2")).toBeTruthy()
  })

  it("says so plainly when nothing is waiting", async () => {
    render(() => <ApprovalsScreen />)
    await waitFor(() => expect(screen.getByTestId("approvals-empty")).toBeTruthy())
    expect(screen.getByTestId("approvals-count").textContent).toBe("0")
  })

  // K2: the phone top bar used to render above this screen's own large title
  // (it registered no `hidePhoneTopBar`, unlike `work`/`chats`). Fixed at the
  // registry entry (see bootstrap.ts); here the workspace name that bar used
  // to carry moves under the large title instead, same as ChatsScreen.
  it("K2: carries the workspace name under its own title, like ChatsScreen", async () => {
    _resetBranding()
    await ensureBrandingLoaded((async () => ({
      ok: true,
      json: async () => ({ data: { orgName: "Fabrikam" } }),
    })) as never)
    render(() => <ApprovalsScreen />)
    await waitFor(() =>
      expect(screen.getByTestId("approvals-title-org").textContent).toBe("Fabrikam"),
    )
    _resetBranding()
  })

  // The public branding read answers for the DEPLOYMENT: Host slug, else the
  // oldest org on the box. On a box carrying more than one org that named
  // somebody else's workspace ("Default Organization") beside every other
  // surface's real name. The signed-in org wins here.
  it("names the SIGNED IN org, not the deployment's public name", async () => {
    _resetBranding()
    await ensureBrandingLoaded((async () => ({
      ok: true,
      json: async () => ({ data: { orgName: "Default Organization" } }),
    })) as never)
    apiMocks.get.mockImplementation(async (path: string) =>
      path === "/org" ? { data: { name: "Resonant Audio Labs" } } : undefined,
    )
    render(() => <ApprovalsScreen />)
    await waitFor(() =>
      expect(screen.getByTestId("approvals-title-org").textContent).toBe("Resonant Audio Labs"),
    )
    apiMocks.get.mockResolvedValue(undefined)
    _resetBranding()
  })

  it("collapses a decided card in place, then drops it", async () => {
    handleWsCreate(row({ id: "ar-1" }), "u-approver")
    handleWsCreate(row({ id: "ar-2" }), "u-approver")
    render(() => <ApprovalsScreen />)
    await waitFor(() => expect(screen.getByTestId("approvals-item-ar-1")).toBeTruthy())

    handleWsUpdate(row({ id: "ar-1", status: "approved" }))

    // Still on screen, collapsing: the row below does not jump up under a
    // finger that is still on it.
    await waitFor(() =>
      expect(screen.getByTestId("approvals-item-ar-1").getAttribute("data-collapsing")).toBe(
        "true",
      ),
    )
    expect(screen.getByTestId("approvals-count").textContent).toBe("1")

    await waitFor(() => expect(screen.queryByTestId("approvals-item-ar-1")).toBeNull(), {
      timeout: COLLAPSE_MS + 1000,
    })
    expect(screen.getByTestId("approvals-item-ar-2")).toBeTruthy()
  })

  // A refresh replaces the row objects in the store. Keyed by the object, the
  // list remounted every card on each refresh (the phone queue's deadline chip
  // came back detached between two reads, and an open deny sheet closed).
  it("keeps each card mounted when a refresh replaces its row", async () => {
    handleWsCreate(row({ id: "ar-1" }), "u-approver")
    render(() => <ApprovalsScreen />)
    await waitFor(() => expect(screen.getByTestId("approvals-item-ar-1")).toBeTruthy())
    const before = screen.getByTestId("approvals-item-ar-1")

    handleWsUpdate(
      row({ id: "ar-1", summary: { kind: "mail.reply", title: "Re: Test", lines: ["edited"] } }),
    )

    await waitFor(() =>
      expect(screen.getByTestId("approvals-item-ar-1").textContent).toContain("edited"),
    )
    expect(screen.getByTestId("approvals-item-ar-1")).toBe(before)
  })

  // F6. The header said "Soonest expires in 3913 min" over rows that read
  // "3d": one figure nobody can price against the other.
  it("humanises a multi-day deadline instead of printing thousands of minutes", async () => {
    handleWsCreate(
      row({ id: "ar-far", expiresAt: new Date(Date.now() + 3913 * 60_000).toISOString() }),
      "u-approver",
    )
    render(() => <ApprovalsScreen />)
    await waitFor(() => expect(screen.getByTestId("approvals-count").textContent).toBe("1"))

    const text = screen.getByTestId("approvals-summary").textContent ?? ""
    expect(text).toContain("3d")
    expect(text).not.toContain("3913")
    expect(text).not.toMatch(/\d{3,}/)
  })

  describe("the approvals list's other kinds, on the phone", () => {
    const scopeRequest: AttentionItem = {
      id: "kernel:scope_request:sr-1",
      app: "kernel",
      entity: "scope_request",
      entityId: "sr-1",
      kind: "scope_request",
      summary: "Sales agent requested access: shopify:orders:read",
      urgency: 60,
      occurredAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      action: { type: "open_entity", tabType: "admin:scope-requests", entityId: "sr-1" },
      metadata: { agentName: "Sales agent", requestedScopes: ["shopify:orders:read"] },
    } as AttentionItem
    const wait: AttentionItem = {
      id: "kernel:agent_notification:w-1",
      app: "kernel",
      entity: "agent_notification",
      entityId: "routine-mailbox-wait:run-1",
      kind: "routine_mailbox_wait",
      summary: "waiting",
      urgency: 60,
      occurredAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      action: { type: "open_entity", tabType: "thread", entityId: "t-1" },
      metadata: {
        routineMailboxWait: {
          routineId: "r-1",
          routineName: "qualify-prospects",
          runId: "run-1",
          expiresAt: new Date(Date.now() + 21 * 3600_000).toISOString(),
          trigger: { app: "mail", entity: "message", action: "create" },
        },
      },
    } as AttentionItem

    afterEach(() => {
      attentionStore._setForTest({ items: [], errors: [] })
      vi.unstubAllGlobals()
    })

    it("lists an access request and a routine run waiting for the mailbox, as Home does", async () => {
      setShellTier("phone")
      currentScope = ["mail:approve", "kernel:scope_requests:admin"]
      attentionStore._setForTest({ items: [scopeRequest, wait], errors: [] })
      handleWsCreate(row({ id: "ar-1" }), "u-approver")
      render(() => <ApprovalsScreen />)
      await waitFor(() => expect(screen.getByTestId("approvals-count").textContent).toBe("3"))
      const others = screen.getByTestId("approvals-other-kinds")
      const access = others.querySelector('[data-kind="scope_request"]') as HTMLElement
      expect(access.getAttribute("data-compact")).toBe("true")
      expect(screen.getByTestId("attention-row-kernel-scope_request-sr-1-grant").textContent).toBe(
        "Grant",
      )
      expect(screen.getByTestId("attention-row-kernel-scope_request-sr-1-deny").textContent).toBe(
        "Deny",
      )
      expect(others.querySelector('[data-kind="routine_mailbox_wait"]')).toBeTruthy()
      expect(screen.getByTestId("routine-mailbox-wait-row-title").textContent).toBe(
        "qualify-prospects waits for you",
      )
      expect(screen.getByTestId("routine-mailbox-wait-run")).toBeTruthy()
      expect(screen.getByTestId("approvals-item-ar-1")).toBeTruthy()
    })

    it("shows an access request only to someone who can grant it", async () => {
      setShellTier("phone")
      currentScope = ["mail:approve"]
      attentionStore._setForTest({ items: [scopeRequest, wait], errors: [] })
      render(() => <ApprovalsScreen />)
      await waitFor(() => expect(screen.getByTestId("approvals-count").textContent).toBe("1"))
      expect(screen.queryByTestId("attention-row-kernel-scope_request-sr-1")).toBeNull()
      expect(screen.getByTestId("routine-mailbox-wait-run")).toBeTruthy()
    })
  })
})
