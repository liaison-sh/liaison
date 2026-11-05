// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import EntityPreview from "./EntityPreview"
import { entityPreviewRegistry, registerEntityPreview } from "./registry"

const mocks = vi.hoisted(() => ({
  api: { getEnvelope: vi.fn() },
  openEntity: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
}))

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: mocks.openEntity,
}))

async function flushPreviewLoad() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("EntityPreview", () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    entityPreviewRegistry.clear()
    mocks.api.getEnvelope.mockReset().mockResolvedValue({ data: [] })
    mocks.openEntity.mockReset()
    const { resetEntityPreviewStore } = await import("./entity-preview-store")
    resetEntityPreviewStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens after 500ms hover and closes on mouseleave", async () => {
    registerEntityPreview({
      app: "kernel",
      entityType: "contact",
      fetch: vi.fn().mockResolvedValue({ id: "c1", name: "Alice" }),
      render: (data: any) => <div>{data.name}</div>,
    })
    render(() => (
      <EntityPreview app="kernel" entityType="contact" entityId="c1">
        <span>Alice trigger</span>
      </EntityPreview>
    ))

    fireEvent.pointerOver(screen.getByText("Alice trigger"))
    await vi.advanceTimersByTimeAsync(500)
    await flushPreviewLoad()

    await vi.waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument())
    fireEvent.pointerOut(screen.getByText("Alice trigger"))
    await vi.waitFor(() => expect(screen.queryByText("Alice")).toBeNull())
  })

  it("pins on click and dismisses on Escape", async () => {
    registerEntityPreview({
      app: "kernel",
      entityType: "contact",
      fetch: vi.fn().mockResolvedValue({ id: "c1", name: "Alice" }),
      render: (data: any) => <div>{data.name}</div>,
    })
    render(() => (
      <EntityPreview app="kernel" entityType="contact" entityId="c1">
        <span>Alice trigger</span>
      </EntityPreview>
    ))

    fireEvent.click(screen.getByText("Alice trigger"))
    await flushPreviewLoad()
    await vi.waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument())
    fireEvent.keyDown(screen.getByText("Alice trigger"), { key: "Escape" })

    await vi.waitFor(() => expect(screen.queryByText("Alice")).toBeNull())
  })

  it("trigger='hover' lets click bubble to children without pinning", () => {
    const onClick = vi.fn()

    render(() => (
      <button type="button" onClick={onClick}>
        <EntityPreview app="kernel" entityType="contact" entityId="c1" trigger="hover">
          <span>Alice trigger</span>
        </EntityPreview>
      </button>
    ))
    fireEvent.click(screen.getByText("Alice trigger"))

    expect(onClick).toHaveBeenCalled()
    expect(screen.queryByText(/contact: c1/)).toBeNull()
  })

  it("renders generic fallback and timeline when no renderer is registered", async () => {
    mocks.api.getEnvelope.mockResolvedValue({
      data: [{ actorName: "Alice", action: "updated", createdAt: "2026-10-23T07:08:45.790Z" }],
    })
    render(() => (
      <EntityPreview app="kernel" entityType="contact" entityId="c1">
        <span>Contact trigger</span>
      </EntityPreview>
    ))

    fireEvent.click(screen.getByText("Contact trigger"))
    await flushPreviewLoad()

    await vi.waitFor(() => expect(screen.getByText("contact: c1")).toBeInTheDocument())
    expect(screen.getByText(/Alice updated/)).toBeInTheDocument()
  })

  it("renders registered renderer output and timeline section", async () => {
    mocks.api.getEnvelope.mockResolvedValue({
      data: [{ actorName: "Bob", action: "created", createdAt: "2026-10-23T07:08:45.790Z" }],
    })
    registerEntityPreview({
      app: "kernel",
      entityType: "contact",
      fetch: vi.fn().mockResolvedValue({ id: "c1", name: "Alice" }),
      render: (data: any) => <strong>{data.name}</strong>,
    })
    render(() => (
      <EntityPreview app="kernel" entityType="contact" entityId="c1">
        <span>Contact trigger</span>
      </EntityPreview>
    ))

    fireEvent.click(screen.getByText("Contact trigger"))
    await flushPreviewLoad()

    await vi.waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument())
    expect(screen.getByText(/Bob created/)).toBeInTheDocument()
  })

  it("a timeline entry with no actor reads as the action alone, with a readable date (never 'Unknown', never a raw ISO stamp)", async () => {
    mocks.api.getEnvelope.mockResolvedValue({
      data: [{ actorName: null, action: "created", createdAt: "2026-10-23T07:08:45.790Z" }],
    })
    registerEntityPreview({
      app: "tickets",
      entityType: "ticket",
      fetch: vi.fn().mockResolvedValue({ id: "t1", subject: "Calibration" }),
      render: (data: any) => <strong>{data.subject}</strong>,
    })
    render(() => (
      <EntityPreview app="tickets" entityType="ticket" entityId="t1">
        <span>Ticket trigger</span>
      </EntityPreview>
    ))

    fireEvent.click(screen.getByText("Ticket trigger"))
    await flushPreviewLoad()

    await vi.waitFor(() => expect(screen.getByText("Calibration")).toBeInTheDocument())
    const row = screen.getByTestId("entity-preview-timeline-entry")
    expect(row.textContent).not.toContain("Unknown")
    expect(row.textContent).not.toContain("2026-10-23T07:08:45.790Z")
    expect(row.textContent).toMatch(/^Created · .*2026/)
  })

  it("re-fetches an open preview after cache invalidation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ id: "c1", name: "Alice v1" })
      .mockResolvedValueOnce({ id: "c1", name: "Alice v2" })
    registerEntityPreview({
      app: "kernel",
      entityType: "contact",
      fetch,
      render: (data: any) => <strong>{data.name}</strong>,
    })
    const { invalidatePreview } = await import("./entity-preview-store")
    render(() => (
      <EntityPreview app="kernel" entityType="contact" entityId="c1">
        <span>Contact trigger</span>
      </EntityPreview>
    ))

    fireEvent.click(screen.getByText("Contact trigger"))
    await flushPreviewLoad()
    await vi.waitFor(() => expect(screen.getByText("Alice v1")).toBeInTheDocument())

    invalidatePreview("kernel", "contact", "c1")
    fireEvent.click(screen.getByText("Contact trigger"))
    await flushPreviewLoad()

    await vi.waitFor(() => expect(screen.getByText("Alice v2")).toBeInTheDocument())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("exposes an Open button that opens the entity and dismisses the popover", async () => {
    registerEntityPreview({
      app: "tickets",
      entityType: "ticket",
      fetch: vi.fn().mockResolvedValue({ id: "t1", subject: "Broken pad" }),
      render: (data: any) => <div>{data.subject}</div>,
    })
    render(() => (
      <EntityPreview app="tickets" entityType="ticket" entityId="t1">
        <span>Ticket trigger</span>
      </EntityPreview>
    ))

    fireEvent.click(screen.getByText("Ticket trigger"))
    await flushPreviewLoad()
    await vi.waitFor(() => expect(screen.getByText("Broken pad")).toBeInTheDocument())

    const openBtn = screen.getByTestId("entity-preview-open")
    expect(openBtn).toBeInTheDocument()
    fireEvent.click(openBtn)

    // Opening routes through openEntity with the entity's own app/type/id, and
    // the popover dismisses.
    expect(mocks.openEntity).toHaveBeenCalledWith(mocks.api, "tickets", "ticket", "t1")
    await vi.waitFor(() => expect(screen.queryByText("Broken pad")).toBeNull())
  })

  it("offers the Open button on hover preview too (not just when pinned)", async () => {
    registerEntityPreview({
      app: "tickets",
      entityType: "ticket",
      fetch: vi.fn().mockResolvedValue({ id: "t1", subject: "Broken pad" }),
      render: (data: any) => <div>{data.subject}</div>,
    })
    render(() => (
      <EntityPreview app="tickets" entityType="ticket" entityId="t1">
        <span>Hover trigger</span>
      </EntityPreview>
    ))

    fireEvent.pointerOver(screen.getByText("Hover trigger"))
    await vi.advanceTimersByTimeAsync(500)
    await flushPreviewLoad()
    await vi.waitFor(() => expect(screen.getByText("Broken pad")).toBeInTheDocument())

    expect(screen.getByTestId("entity-preview-open")).toBeInTheDocument()
  })
})
