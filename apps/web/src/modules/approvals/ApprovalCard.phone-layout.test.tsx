// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two things the phone card got wrong about its own box.
//
// The Reject / Edit / Approve row was drawn under the bottom tab bar, so the
// one control the card exists for was the one part of it a thumb could not
// reach. It now clears the bar the way every other phone surface does, off the
// shell's own bottom-bar variable plus the safe area, never a magic number.
//
// And the collapsed Message clamped to a pixel height, which lands wherever it
// lands: the last line was sliced through the middle and read as a smear. The
// clamp counts LINES now, so the box always ends on a whole one.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let currentScope: string[] = ["mail:approve"]
const currentUserId = "u-approver"
const apiMocks = { get: vi.fn().mockResolvedValue(undefined), post: vi.fn() }

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => currentScope.includes(s),
  userFromToken: () => ({ userId: currentUserId, name: "Test User", scopes: currentScope }),
}))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))
vi.mock("~/lib/native-bridge", () => ({ nativeHaptic: vi.fn() }))

import { setShellTier } from "~/tests/helpers/shell-tier"
import ApprovalCard from "./ApprovalCard"
import { handleWsCreate, resetApprovalsStore } from "./approvals-store"

const row = (over: Partial<any> = {}): any => ({
  id: "ar-1",
  handle: "request-0001",
  status: "pending",
  createdAt: "2026-04-30T11:00:00.000Z",
  expiresAt: new Date(Date.now() + 40 * 60_000).toISOString(),
  toolName: "mail:reply",
  summary: { kind: "mail.reply", title: "Re: Test", lines: ["body line"] },
  editableFields: [{ field: "textBody", label: "Body", widget: "richtext" }],
  currentPayload: { textBody: "original" },
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-requester" },
  requester: { kind: "user", id: "u-requester", name: "Bob" },
  notifyUserIds: ["u-approver", "u-requester"],
  lastEdit: null,
  lastFailure: null,
  ...over,
})

describe("ApprovalCard at phone tier: the card's own box", () => {
  beforeEach(() => {
    resetApprovalsStore()
    currentScope = ["mail:approve"]
    apiMocks.get.mockReset().mockResolvedValue(undefined)
    apiMocks.post.mockReset()
    setShellTier("phone")
  })
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("keeps the decide row clear of the bottom tab bar and the safe area", async () => {
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)

    const actions = await screen.findByTestId("approval-card-actions")
    const padding = (actions as HTMLElement).style.paddingBottom
    expect(padding).toContain("env(safe-area-inset-bottom")
    expect(padding).toContain("--shell-bottom-bar")
  })

  it("clamps the collapsed Message to whole lines, not to a pixel height", async () => {
    handleWsCreate(
      row({
        currentPayload: { textBody: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)

    const body = await screen.findByTestId("approval-card-message-body")
    expect(body.getAttribute("data-expanded")).toBe("false")
    const cls = body.className
    expect(cls).toMatch(/\bline-clamp-\d+\b/)
    expect(cls).not.toMatch(/max-h-\[/)
  })
})
