// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BlockResult, DashboardBlockSpec } from "../dashboards-client"
import { BlockCard } from "./BlockCard"

afterEach(cleanup)

const block: DashboardBlockSpec = {
  id: "b1",
  type: "metric",
  title: "Revenue",
  width: 1,
  source: { kind: "store", app: "agent", collection: "sales", query: {} },
}

const metric = (value: number): BlockResult => ({ ok: true, data: { kind: "metric", value } })

function deferred() {
  let resolve!: (r: BlockResult) => void
  const promise = new Promise<BlockResult>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const card = () => screen.getByTestId("dashboard-block-b1")

describe("BlockCard", () => {
  it("shows a skeleton while loading, then the data", async () => {
    const d = deferred()
    render(() => <BlockCard block={block} load={() => d.promise} locale="en" />)
    expect(card().dataset.state).toBe("loading")
    expect(screen.getByTestId("dashboard-block-skeleton")).toBeTruthy()
    expect(screen.getByTestId("dashboard-block-title").textContent).toBe("Revenue")
    d.resolve(metric(5))
    await waitFor(() => expect(card().dataset.state).toBe("ready"))
    expect(screen.getByTestId("block-metric-value").textContent).toBe("5")
  })

  it.each([
    ["no_access", "You don't have access to the data behind this block."],
    ["not_allowed", "This block's source can no longer be shown on a dashboard."],
    ["source_error", "This block's data could not be read. Try again later."],
    ["rate_limited", "Just refreshed. Try again in a few seconds."],
    ["not_found", "This block is no longer on the dashboard."],
    ["network", "Can't reach the server right now. Try again in a moment."],
  ] as const)("shows the calm %s state", async (error, copy) => {
    render(() => <BlockCard block={block} load={async () => ({ ok: false, error })} />)
    await waitFor(() => expect(card().dataset.state).toBe("error"))
    const msg = screen.getByTestId("dashboard-block-error")
    expect(msg.dataset.error).toBe(error)
    expect(msg.textContent).toBe(copy)
    // Calm: no alarm colour on a refusal.
    expect(msg.className).not.toMatch(/danger|error|red/)
  })

  it("refreshes itself past the cache", async () => {
    const load = vi.fn(async (_refresh: boolean) => metric(1))
    render(() => <BlockCard block={block} load={load} />)
    await waitFor(() => expect(card().dataset.state).toBe("ready"))
    fireEvent.click(screen.getByTestId("dashboard-block-refresh-b1"))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load.mock.calls.map((c) => c[0])).toEqual([false, true])
  })

  it("keeps its figures when a refresh is refused as too soon", async () => {
    let n = 0
    const load = async (): Promise<BlockResult> =>
      n++ === 0 ? metric(9) : { ok: false, error: "rate_limited" }
    render(() => <BlockCard block={block} load={load} />)
    await waitFor(() => expect(card().dataset.state).toBe("ready"))
    fireEvent.click(screen.getByTestId("dashboard-block-refresh-b1"))
    await waitFor(() => expect(screen.getByTestId("dashboard-block-note")).toBeTruthy())
    expect(card().dataset.state).toBe("ready")
    expect(screen.getByTestId("block-metric-value").textContent).toBe("9")
  })

  it("re-reads past the cache on each Refresh all", async () => {
    const load = vi.fn(async (_refresh: boolean) => metric(1))
    const [tick, setTick] = createSignal(0)
    render(() => <BlockCard block={block} load={load} refreshTick={tick()} />)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    setTick(1)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load.mock.calls[1]?.[0]).toBe(true)
  })

  it("says when the server left rows out", async () => {
    render(() => (
      <BlockCard
        block={{ ...block, type: "table" }}
        load={async () => ({
          ok: true,
          data: {
            kind: "table",
            columns: [{ field: "a", label: "A" }],
            rows: [{ a: 1 }],
            truncated: true,
          },
        })}
      />
    ))
    await waitFor(() => expect(screen.getByTestId("dashboard-block-truncated")).toBeTruthy())
  })
})
