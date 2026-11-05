// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type ApprovalAuthorityFacts,
  type AuthorityViewer,
  canDecidePure,
  canEditPure,
  canSeeInFeed,
  canSeeInList,
  decidingScope,
  decidingScopeForToolDef,
  factsFromSummary,
  holdsDecidingScope,
  isNotified,
  isOwnerRouted,
  isPeerSelfApprovable,
} from "./authority"

const facts = (over: Partial<ApprovalAuthorityFacts> = {}): ApprovalAuthorityFacts => ({
  toolName: "tickets:reply",
  approveScope: null,
  resourceOwnerId: null,
  requestedById: "requester-1",
  notifyUserIds: ["requester-1", "approver-1"],
  ...over,
})

/** Test viewer with exact-match scopes plus the `*` super-grant — enough to
 *  exercise the predicates, which treat hasScope as an opaque callback. */
const viewer = (userId: string, scopes: string[]): AuthorityViewer => ({
  userId,
  hasScope: (s) => scopes.includes("*") || scopes.includes(s),
})

describe("decidingScope (Q1)", () => {
  it("reads the row's persisted approve_scope, never recomputing from the tool name", () => {
    expect(
      decidingScope(
        facts({ toolName: "kernel:update_skill", approveScope: "kernel:skills:approve" }),
      ),
    ).toBe("kernel:skills:approve")
  })

  it("falls back to <app>:approve only when the row carries no override", () => {
    expect(decidingScope(facts({ toolName: "knowledge:update" }))).toBe("knowledge:approve")
  })

  it("never asks for admin-grade kernel:approve on a domain (custom-scope) approval", () => {
    // The C-Level persona: every <app>:approve + kernel:skills:approve, nothing
    // admin. A skills row must be decided by exactly kernel:skills:approve.
    const skillRow = facts({
      toolName: "kernel:update_skill",
      approveScope: "kernel:skills:approve",
    })
    expect(decidingScope(skillRow)).not.toBe("kernel:approve")
    const cLevel = viewer("clevel-1", ["tickets:approve", "mail:approve", "kernel:skills:approve"])
    expect(holdsDecidingScope(skillRow, cLevel)).toBe(true)
    const genericAdmin = viewer("admin-1", ["kernel:approve"])
    expect(holdsDecidingScope(skillRow, genericAdmin)).toBe(false)
  })

  it("registry twin matches the row-level derivation", () => {
    expect(decidingScopeForToolDef({}, "knowledge")).toBe("knowledge:approve")
    expect(decidingScopeForToolDef({ approveScope: "kernel:skills:approve" }, "kernel")).toBe(
      "kernel:skills:approve",
    )
  })

  it("a kernel tool is decided by its own scope, never by the admin-grade kernel:approve by default", () => {
    // Holding the scope to make the change is the right to decide it ("write = updates").
    expect(decidingScopeForToolDef({ requiredScopes: ["kernel:contacts:write"] }, "kernel")).toBe(
      "kernel:contacts:write",
    )
    // A tool that names a stricter deciding scope keeps it.
    expect(
      decidingScopeForToolDef(
        { requiredScopes: ["kernel:roles:admin"], approveScope: "kernel:approve" },
        "kernel",
      ),
    ).toBe("kernel:approve")
    // Ambiguous (several scopes, none named): the strict fallback stays.
    expect(
      decidingScopeForToolDef({ requiredScopes: ["kernel:a:read", "kernel:b:write"] }, "kernel"),
    ).toBe("kernel:approve")
    // Apps keep their own `<app>:approve`.
    expect(decidingScopeForToolDef({ requiredScopes: ["mail:messages:write"] }, "mail")).toBe(
      "mail:approve",
    )
  })

  it("throws loudly when a caller's SELECT omitted a canonical column", () => {
    const broken = { toolName: "tickets:reply" } as unknown as ApprovalAuthorityFacts
    expect(() => decidingScope(broken)).toThrow(/canonical column/)
  })
})

describe("canSeeInFeed (Q2, narrow by design)", () => {
  it("notified holder of the row's custom scope sees it", () => {
    const f = facts({
      toolName: "kernel:update_skill",
      approveScope: "kernel:skills:approve",
      notifyUserIds: ["requester-1", "skills-approver"],
    })
    expect(canSeeInFeed(f, viewer("skills-approver", ["kernel:skills:approve"]))).toBe(true)
  })

  it("notified kernel:approve holder does NOT see a skills-scoped row (the 2026-08-06 regression)", () => {
    const f = facts({
      toolName: "kernel:update_skill",
      approveScope: "kernel:skills:approve",
      notifyUserIds: ["requester-1", "generic-admin"],
    })
    expect(canSeeInFeed(f, viewer("generic-admin", ["kernel:approve"]))).toBe(false)
  })

  it("a decider who was never notified stays out of the feed (A2 anti-noise, deliberate)", () => {
    const f = facts({ notifyUserIds: ["someone-else"] })
    expect(canSeeInFeed(f, viewer("approver-1", ["tickets:approve"]))).toBe(false)
  })

  it("a notified user without the deciding scope sees nothing (A3)", () => {
    const f = facts({ toolName: "mail:send", notifyUserIds: ["user-a"] })
    expect(canSeeInFeed(f, viewer("user-a", ["tickets:approve"]))).toBe(false)
  })

  it("owner-routed rows are private absolutely, even from a `*` admin", () => {
    const f = facts({ resourceOwnerId: "owner-1", notifyUserIds: ["owner-1", "admin-1"] })
    expect(canSeeInFeed(f, viewer("admin-1", ["*"]))).toBe(false)
    expect(canSeeInFeed(f, viewer("owner-1", []))).toBe(true)
  })
})

describe("canSeeInList (Q2, wide by design)", () => {
  it("requester always sees their own request", () => {
    const f = facts({ notifyUserIds: ["requester-1"] })
    expect(canSeeInList(f, viewer("requester-1", []))).toBe(true)
  })

  it("notified custom-scope holder sees a skills row (the list.ts recompute bug)", () => {
    const f = facts({
      toolName: "kernel:update_skill",
      approveScope: "kernel:skills:approve",
      notifyUserIds: ["requester-1", "skills-approver"],
    })
    expect(canSeeInList(f, viewer("skills-approver", ["kernel:skills:approve"]))).toBe(true)
    expect(canSeeInList(f, viewer("generic-admin", ["kernel:approve"]))).toBe(false)
  })

  it("ticket mode widens to ticket readers; owner-routing still wins over it", () => {
    const f = facts()
    expect(canSeeInList(f, viewer("teammate", ["tickets:tickets:read"]), { ticketId: "t-1" })).toBe(
      true,
    )
    const ownerRouted = facts({ resourceOwnerId: "owner-1" })
    expect(
      canSeeInList(ownerRouted, viewer("teammate", ["tickets:tickets:read", "*"]), {
        ticketId: "t-1",
      }),
    ).toBe(false)
    expect(canSeeInList(ownerRouted, viewer("owner-1", []), { ticketId: "t-1" })).toBe(true)
  })

  it("conversation mode widens to mail readers", () => {
    const f = facts({ toolName: "mail:reply" })
    expect(
      canSeeInList(f, viewer("teammate", ["mail:conversations:read"]), { conversationId: "c-1" }),
    ).toBe(true)
    expect(canSeeInList(f, viewer("teammate", []), { conversationId: "c-1" })).toBe(false)
  })
})

describe("canDecidePure / canEditPure", () => {
  it("shared-surface drafts are decidable by any deciding-scope holder", () => {
    const f = facts({ notifyUserIds: ["requester-1"] })
    expect(canDecidePure(f, viewer("teammate", ["tickets:approve"]), { sharedSurface: true })).toBe(
      true,
    )
    expect(
      canDecidePure(f, viewer("teammate", ["tickets:approve"]), { sharedSurface: false }),
    ).toBe(false)
  })

  it("owner decides their own owner-routed row without any approve scope; nobody else can", () => {
    const f = facts({ resourceOwnerId: "owner-1" })
    expect(canDecidePure(f, viewer("owner-1", []), { sharedSurface: false })).toBe(true)
    expect(canDecidePure(f, viewer("admin-1", ["*"]), { sharedSurface: false })).toBe(false)
  })

  it("edit: requester and owner always; others need audience + deciding scope", () => {
    const skillRow = facts({
      toolName: "kernel:update_skill",
      approveScope: "kernel:skills:approve",
      notifyUserIds: ["requester-1", "skills-approver", "generic-admin"],
    })
    expect(canEditPure(skillRow, viewer("requester-1", []), { sharedSurface: false })).toBe(true)
    expect(
      canEditPure(skillRow, viewer("skills-approver", ["kernel:skills:approve"]), {
        sharedSurface: false,
      }),
    ).toBe(true)
    // Notified but holding only the admin-grade scope: may NOT edit a domain row.
    expect(
      canEditPure(skillRow, viewer("generic-admin", ["kernel:approve"]), { sharedSurface: false }),
    ).toBe(false)
  })
})

describe("factsFromSummary (web adapter)", () => {
  it("maps the DTO and tolerates a missing approveScope as legacy-null", () => {
    const f = factsFromSummary({
      toolName: "tickets:reply",
      requestedBy: { id: "u-1" },
      notifyUserIds: ["u-1"],
    })
    expect(f.approveScope).toBeNull()
    expect(isOwnerRouted(f)).toBe(false)
    expect(isNotified(f, "u-1")).toBe(true)
    expect(decidingScope(f)).toBe("tickets:approve")
  })
})

describe("isPeerSelfApprovable — the feed's default peer-noise fold", () => {
  const VIEWER = "viewer-1"
  const PEER = "peer-2"

  it("hides a peer's request when that peer could have approved it themselves", () => {
    // The reported case: two holders of the same <app>:approve bury each other.
    expect(
      isPeerSelfApprovable(
        { requestedById: PEER, originRoutineId: null, requesterCanDecide: true },
        VIEWER,
      ),
    ).toBe(true)
  })

  it("SHOWS a peer's request when that peer cannot decide it — this is the real queue", () => {
    expect(
      isPeerSelfApprovable(
        { requestedById: PEER, originRoutineId: null, requesterCanDecide: false },
        VIEWER,
      ),
    ).toBe(false)
  })

  it("never hides your own request, even when you can self-approve", () => {
    // You are watching it and may withdraw it.
    expect(
      isPeerSelfApprovable(
        { requestedById: VIEWER, originRoutineId: null, requesterCanDecide: true },
        VIEWER,
      ),
    ).toBe(false)
  })

  it("never hides a routine-raised request, even from a self-approving owner", () => {
    // No human is waiting behind a routine: if the viewer does not act, nobody does.
    expect(
      isPeerSelfApprovable(
        { requestedById: PEER, originRoutineId: "routine-9", requesterCanDecide: true },
        VIEWER,
      ),
    ).toBe(false)
  })
})
