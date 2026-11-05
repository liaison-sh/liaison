// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F1. At 390px Home rendered the top bar, the tab bar and nothing between
// them: the desktop landing is the sidebar's conversation list, which the
// phone tier has no column for, and conversations moved to their own seat.
// The phone Home is the attention feed itself.
import type { AttentionItem } from "@liaison/shared"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const apiPost = vi.fn(async () => ({}))
const apiPatch = vi.fn(async () => ({}))
const apiPut = vi.fn(async () => ({}))
const apiStub = {
  get: apiGet,
  getEnvelope: apiGetEnvelope,
  post: apiPost,
  patch: apiPatch,
  put: apiPut,
}
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiStub,
  useOptionalApi: () => apiStub,
}))

import { resetRegistry } from "~/framework/app-registry"
import { attentionStore } from "~/modules/shell/attention-store"
import Home from "~/modules/shell/Home"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetThreadStore } from "~/modules/threads/thread-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

const approvalItem = (id: string): AttentionItem => ({
  id,
  app: "invoicing",
  entity: "document",
  entityId: id,
  kind: "approval_pending",
  summary: "Mark invoice paid",
  urgency: 40,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "decide_approval", approvalId: id },
})

describe("Home at phone tier", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetThreadStore()
    resetHomeCardLayout()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    apiGet.mockReset().mockResolvedValue([])
    apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  })
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("renders the greeting as the screen title and the attention cards inline", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [approvalItem("doc-1")], errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-phone")).toBeTruthy()
    const greeting = screen.getByTestId("home-greeting")
    expect(greeting.textContent).toContain("Tester")
    // Compact, not a hero: the 32px title was a third of a 390px fold.
    expect(greeting.className).toContain("text-[22px]")
    expect(greeting.className).toContain("font-display")
    // The cards, with the approval row and its inline action.
    expect(screen.getByTestId("home-feed")).toBeTruthy()
    expect(screen.getByTestId("home-card-approvals")).toBeTruthy()
  })

  it("shows the empty state when nothing needs the user", () => {
    setShellTier("phone")
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-phone")).toBeTruthy()
    expect(screen.getByTestId("home-empty-state")).toBeTruthy()
  })

  it("lands desktop Home on the same attention feed, with no phone variant", () => {
    setShellTier("desktop")
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-phone")).toBeNull()
    expect(screen.queryByTestId("home-threads-landing")).toBeNull()
    // Same attention surface, desktop chrome: greeting, status line, then the
    // feed (empty here, so the calm empty state stands in for the cards).
    expect(screen.getByTestId("home")).toBeTruthy()
    expect(screen.getByTestId("home-greeting")).toBeTruthy()
    expect(screen.getByTestId("home-empty-state")).toBeTruthy()
  })
})
