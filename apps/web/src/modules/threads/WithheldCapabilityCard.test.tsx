// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { handleVisibilityInvalidate } from "~/modules/threads/message-store"
import { WithheldCapabilityCard } from "~/modules/threads/WithheldCapabilityCard"

const TITLE = "Some capabilities are unavailable here"
const BODY =
  "Not everyone in this room has access to what I would need, so I left some capabilities out."
const SUFFIX = "This one cannot be shared here."

const api = {
  get: vi.fn(async () => ({ data: [] })),
  post: vi.fn(async () => ({ data: {} })),
}

function renderCard(props: Record<string, unknown> = {}) {
  return render(() => (
    <WithheldCapabilityCard
      api={api as never}
      threadId="t-1"
      messageId="m-1"
      agentId="a-1"
      items={[{ label: "finance data" }]}
      {...props}
    />
  ))
}

describe("WithheldCapabilityCard (P4b-T31)", () => {
  beforeEach(() => {
    api.get.mockClear()
    api.post.mockReset()
    api.post.mockImplementation(async () => ({ data: {} }))
  })
  afterEach(() => cleanup())

  it("renders the exact title, body and Continue in a DM action for a disclosable withheld scope", () => {
    renderCard()
    expect(screen.getByTestId("withheld-card-title").textContent).toBe(TITLE)
    expect(screen.getByTestId("withheld-card-body").textContent).toBe(BODY)
    expect(screen.getByText("Continue in a DM")).toBeInTheDocument()
    expect(screen.getByText("Share anyway")).toBeInTheDocument()
  })

  it("hides Share anyway and shows the non-disclosable suffix when the withheld scope is marked non-disclosable", () => {
    renderCard({ items: [{ label: "finance data", nonDisclosable: true }] })
    expect(screen.queryByText("Share anyway")).not.toBeInTheDocument()
    expect(screen.getByTestId("withheld-card-body").textContent).toBe(`${BODY} ${SUFFIX}`)
    expect(screen.getByText("Continue in a DM")).toBeInTheDocument()
  })

  it("a scope-taint item never offers Share anyway", () => {
    renderCard({ items: [{ label: "finance data", scopeTainted: true }] })
    expect(screen.queryByText("Share anyway")).not.toBeInTheDocument()
    expect(screen.getByTestId("withheld-card-body").textContent).toBe(`${BODY} ${SUFFIX}`)
  })

  it("shows only the category labels, never a scope, tool, member or value", () => {
    renderCard({ items: [{ label: "finance data", scopeTainted: true }] })
    const card = screen.getByTestId("withheld-card")
    expect(card.textContent).toContain("finance data")
    expect(card.textContent).not.toContain("pennylane")
  })

  it("NAMES the withheld capability instead of leaving it unsaid", () => {
    // The chip rendered the label bare, and the label was always the generic
    // one, so the whole card said "a capability" and named nothing.
    renderCard({ items: [{ label: "finance data" }, { label: "support tickets" }] })
    const chips = screen.getAllByTestId("withheld-card-item")
    expect(chips.map((c) => c.textContent)).toEqual([
      "Withheld: finance data",
      "Withheld: support tickets",
    ])
  })

  it("never offers to ask for a scope, because no scope name reaches the card", () => {
    renderCard({ items: [{ label: "finance data", scopeTainted: true }] })
    expect(screen.queryByTestId("withheld-card-request-scope")).not.toBeInTheDocument()
    expect(screen.queryByText("Request access")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("withheld-card-continue-in-dm"))
    expect(api.post).not.toHaveBeenCalledWith("/scope-requests", expect.anything())
  })

  it("Share anyway re-runs the turn through the disclosure route", () => {
    renderCard()
    fireEvent.click(screen.getByText("Share anyway"))
    expect(api.post).toHaveBeenCalledWith(
      "/threads/t-1/messages/m-1/share-anyway",
      expect.anything(),
    )
  })

  it("Share anyway names the messages the rerun disclosed", async () => {
    api.post.mockImplementation(async () => ({ data: { messageIds: ["m-9", "m-10"] } }))
    renderCard()
    fireEvent.click(screen.getByTestId("withheld-card-share-anyway"))
    await waitFor(() => expect(screen.getByTestId("withheld-card-disclosed")).toBeInTheDocument())
    expect(screen.getByTestId("withheld-card-disclosed").getAttribute("data-message-ids")).toBe(
      "m-9 m-10",
    )
  })

  it("a 409 taint refusal is reported in the not shareable words", async () => {
    api.post.mockImplementation(async () => {
      throw new ApiError("E_SCOPE_TAINT_BLOCKED", 409, undefined, undefined, undefined)
    })
    renderCard()
    fireEvent.click(screen.getByTestId("withheld-card-share-anyway"))
    await waitFor(() => expect(screen.getByTestId("withheld-card-failure")).toBeInTheDocument())
    expect(screen.getByTestId("withheld-card-failure").textContent).toBe(SUFFIX)
  })

  it("Continue in a DM opens or reuses the requester's chat with that agent", async () => {
    const opened: string[] = []
    api.post.mockImplementation(async () => ({
      data: { id: "dm-1", handle: "@support", created: true },
    }))
    renderCard({ onContinueInDm: (id: string) => opened.push(id) })
    fireEvent.click(screen.getByTestId("withheld-card-continue-in-dm"))
    await waitFor(() => expect(opened).toEqual(["dm-1"]))
    expect(api.post).toHaveBeenCalledWith("/threads/dm", { agentId: "a-1" })
  })

  it("a reused DM opens exactly like a created one", async () => {
    const opened: string[] = []
    api.post.mockImplementation(async () => ({
      data: { id: "dm-existing", handle: "@support", created: false },
    }))
    renderCard({ onContinueInDm: (id: string) => opened.push(id) })
    fireEvent.click(screen.getByTestId("withheld-card-continue-in-dm"))
    await waitFor(() => expect(opened).toEqual(["dm-existing"]))
  })

  it("Continue in a DM is disabled when the card names no agent", () => {
    renderCard({ agentId: null })
    const button = screen.getByTestId("withheld-card-continue-in-dm") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(api.post).not.toHaveBeenCalled()
  })

  it("a 404 from the DM route says the agent is gone, not that something went wrong", async () => {
    api.post.mockImplementation(async () => {
      throw new ApiError("Not found", 404, "not_found")
    })
    renderCard()
    fireEvent.click(screen.getByTestId("withheld-card-continue-in-dm"))
    await waitFor(() => expect(screen.getByTestId("withheld-card-failure")).toBeInTheDocument())
    expect(screen.getByTestId("withheld-card-failure").textContent).toBe(
      "That agent is no longer available.",
    )
  })

  it("renders nothing when the turn withheld nothing", () => {
    renderCard({ items: [] })
    expect(screen.queryByTestId("withheld-card")).not.toBeInTheDocument()
  })
})

describe("visibility:invalidate refetches the named threads (P4b-T31)", () => {
  afterEach(() => cleanup())

  it("refetches every thread the frame names, and no other", async () => {
    const refetched: string[] = []
    await handleVisibilityInvalidate({ threadIds: ["t-1", "t-2"] }, async (id) => {
      refetched.push(id)
    })
    expect(refetched).toEqual(["t-1", "t-2"])
  })

  it("ignores a frame that names no thread", async () => {
    const refetched: string[] = []
    await handleVisibilityInvalidate({ threadIds: [] }, async (id) => {
      refetched.push(id)
    })
    expect(refetched).toEqual([])
  })
})
