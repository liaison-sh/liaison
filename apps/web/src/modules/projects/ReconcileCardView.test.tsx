// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ReconcileCardView } from "~/modules/projects/ReconcileCardView"

const calls = vi.hoisted(() => ({ list: [] as Array<[string, unknown]>, answer: null as unknown }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    rawPost: vi.fn(async (path: string, body: unknown) => {
      calls.list.push([path, body])
      return new Response(JSON.stringify(calls.answer), { status: calls.answer ? 200 : 404 })
    }),
  }),
}))
vi.mock("~/modules/agent/ToolCard", () => ({
  ToolCard: (props: { toolCall: { toolName: string; card?: { title?: string } } }) => (
    <div data-testid="card-stub">
      {props.toolCall.toolName} {props.toolCall.card?.title}
    </div>
  ),
}))

beforeEach(() => {
  calls.list = []
  calls.answer = null
})

describe("a planned vs done card on its own page", () => {
  it("reads the card through reconcile_get and draws it with its actions", async () => {
    calls.answer = { data: {}, meta: { card: { title: "Portal, October 2026" } } }
    render(() => <ReconcileCardView entityId="rec-1" />)
    await waitFor(() => expect(screen.getByTestId("card-stub")).toBeTruthy())
    expect(screen.getByTestId("card-stub").textContent).toContain("projects__reconcile_get")
    expect(screen.getByTestId("card-stub").textContent).toContain("Portal, October 2026")
    expect(calls.list).toEqual([
      [
        "/apps/projects/tools/reconcile_get",
        { params: { reconciliationId: "rec-1" }, withCard: true },
      ],
    ])
  })

  it("says the card cannot be opened when it is gone or not the person's to see", async () => {
    render(() => <ReconcileCardView entityId="rec-2" />)
    await waitFor(() => expect(screen.getByTestId("reconcile-card-page-none")).toBeTruthy())
  })
})
