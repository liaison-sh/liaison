// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BacklinksPanel } from "./BacklinksPanel"

const openTabMock = vi.hoisted(() => vi.fn())

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: openTabMock,
}))

function jsonResponse(body: any, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )
}

describe("BacklinksPanel", () => {
  beforeEach(() => {
    openTabMock.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("renders nothing when count=0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ data: [] })),
    )
    const { container } = render(() => (
      <BacklinksPanel app="tickets" entityType="ticket" entityId="t1" />
    ))
    await waitFor(() =>
      expect(container.querySelector("[data-testid='backlinks-panel']")).toBeNull(),
    )
  })

  it("renders 'Referenced in N threads' header and clickable rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          data: [
            {
              threadId: "th1",
              handle: "thr-1",
              title: "Discussion",
              updatedAt: "2026-05-11T00:00:00Z",
            },
          ],
        }),
      ),
    )
    render(() => <BacklinksPanel app="tickets" entityType="ticket" entityId="t1" />)
    expect(await screen.findByText(/Referenced in 1 thread/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("backlink-row-th1"))
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread", entityId: "th1" }),
    )
  })

  it("hidden on error (calm UI)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network"))),
    )
    const { container } = render(() => (
      <BacklinksPanel app="tickets" entityType="ticket" entityId="t1" />
    ))
    await waitFor(() =>
      expect(container.querySelector("[data-testid='backlinks-panel']")).toBeNull(),
    )
  })

  it("Show more appends next page", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1
        if (call === 1) {
          return jsonResponse({
            data: [
              {
                threadId: "th1",
                handle: "thr-1",
                title: "First",
                updatedAt: "2026-05-11T00:00:00Z",
              },
            ],
          })
        }
        return jsonResponse({
          data: [
            {
              threadId: "th2",
              handle: "thr-2",
              title: "Second",
              updatedAt: "2026-05-11T00:00:00Z",
            },
          ],
        })
      }),
    )
    render(() => <BacklinksPanel app="tickets" entityType="ticket" entityId="t1" pageSize={1} />)
    await screen.findByText("thr-1")
    fireEvent.click(screen.getByTestId("backlinks-show-more"))
    await waitFor(() => expect(screen.getByText("thr-2")).toBeInTheDocument())
  })

  it("resets rows + pagination when the entity changes in place", async () => {
    // Simulates a singleton detail surface swapping entityId on a live instance:
    // t1 has a paginated backlink loaded via "Show more"; switching to t2 must
    // NOT inherit t1's rows or its extra page (the stale-panel leak).
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("entityId=t1")) {
          const handle = u.includes("offset=0") ? "thr-1" : "thr-2"
          return jsonResponse({
            data: [
              {
                threadId: handle,
                handle,
                title: `${handle}-title`,
                updatedAt: "2026-05-11T00:00:00Z",
              },
            ],
          })
        }
        return jsonResponse({
          data: [
            {
              threadId: "thr-3",
              handle: "thr-3",
              title: "thr-3-title",
              updatedAt: "2026-05-11T00:00:00Z",
            },
          ],
        })
      }),
    )
    const [entityId, setEntityId] = createSignal("t1")
    render(() => (
      <BacklinksPanel app="tickets" entityType="ticket" entityId={entityId()} pageSize={1} />
    ))
    await screen.findByText("thr-1")
    fireEvent.click(screen.getByTestId("backlinks-show-more"))
    await screen.findByText("thr-2")

    setEntityId("t2")
    await screen.findByText("thr-3")
    // t1's first page AND its "Show more" page must be gone — not carried over.
    expect(screen.queryByText("thr-1")).toBeNull()
    expect(screen.queryByText("thr-2")).toBeNull()
    // Header reflects only t2's single row, proving pagination state reset too.
    expect(screen.getByText(/Referenced in 1 thread/)).toBeInTheDocument()
  })
})
