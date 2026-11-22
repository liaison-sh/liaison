// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn(async () => {}),
  openAttentionLink: vi.fn(async () => {}),
  markAttentionRead: vi.fn(),
}))

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import { attentionStore } from "~/modules/shell/attention-store"

const card = (
  id: string,
  group?: { key: string; count: number },
  runGroup?: Record<string, unknown>,
): AttentionItem => ({
  id: `kernel:approval_pending:${id}`,
  app: "kernel",
  entity: "approval_request",
  entityId: id,
  kind: "approval_pending",
  summary: `Issue invoice ${id}`,
  urgency: 60,
  occurredAt: "2026-12-31T09:00:00.000Z",
  action: { type: "decide_approval", approvalId: id },
  metadata: {
    toolName: "invoicing:invoice_issue",
    placement: "mine",
    ...(group ? { runGroup: runGroup ?? { ...group, label: "Monthly billing" } } : {}),
  },
})

const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never

function show(item: AttentionItem) {
  return render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <ul>
          <AttentionRow item={item} />
        </ul>
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

afterEach(() => attentionStore._setForTest({ items: [], errors: [] }))

describe("one row for the cards of one run", () => {
  it("names who asked and how many, and opens to every card", () => {
    const group = { key: "run-1:mine", count: 3 }
    const items = [card("a", group), card("b", group), card("c", group)]
    attentionStore._setForTest({ items, errors: [] })
    const { getByTestId, queryByTestId } = show(items[0] as AttentionItem)
    expect(getByTestId("approval-run-group-title").textContent).toBe(
      "3 approvals from Monthly billing",
    )
    expect(getByTestId("approval-run-group-row").dataset.count).toBe("3")
    expect(queryByTestId("approval-run-group-list")).toBeNull()
    fireEvent.click(getByTestId("approval-run-group-toggle"))
    const list = getByTestId("approval-run-group-list")
    for (const id of ["a", "b", "c"]) {
      expect(
        list.querySelector(`[data-testid="attention-row-kernel-approval_request-${id}"]`),
      ).not.toBeNull()
    }
  })

  it("once one card is left, the row is that card", () => {
    const group = { key: "run-2:mine", count: 2 }
    const left = card("d", group)
    attentionStore._setForTest({ items: [left], errors: [] })
    const { queryByTestId, getByTestId } = show(left)
    expect(queryByTestId("approval-run-group-row")).toBeNull()
    expect(getByTestId("attention-row-kernel-approval_request-d")).toBeDefined()
  })
})

describe("one row for one day's cards of the same action, with no run", () => {
  it("names the action and how many, and opens to every card", () => {
    const group = { key: "batch:x|invoicing:invoice_issue|2026-11-30:mine", count: 2 }
    const batch = { ...group, basis: "batch", toolName: "invoicing:invoice_issue" }
    const items = [card("e", group, batch), card("f", group, batch)]
    attentionStore._setForTest({ items, errors: [] })
    const { getByTestId } = show(items[0] as AttentionItem)
    expect(getByTestId("approval-run-group-title").textContent).toBe(
      "2 approvals: Invoicing: issue invoice",
    )
    fireEvent.click(getByTestId("approval-run-group-toggle"))
    const list = getByTestId("approval-run-group-list")
    for (const id of ["e", "f"]) {
      expect(
        list.querySelector(`[data-testid="attention-row-kernel-approval_request-${id}"]`),
      ).not.toBeNull()
    }
  })
})
