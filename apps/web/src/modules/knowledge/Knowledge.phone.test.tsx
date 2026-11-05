// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge at phone width (M2-3 T19): a large title, the collections tree as
// grouped rows (it has no sidebar column to live in here), document rows that
// say when they were last touched, and a reading column with 16px gutters
// whose sources move into a bottom sheet.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(async () => ({})) },
  store: {
    homeData: { recent: [] as any[], needsReview: [] as any[] },
    collectionsTree: [] as any[],
  },
  openTab: vi.fn(),
  loadCollectionsTree: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: mocks.openTab,
  evictTabByEntity: vi.fn(),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({ discussWithPersonalAgent: vi.fn() }))
vi.mock("~/modules/knowledge/knowledge-store", () => ({
  knowledgeStore: mocks.store,
  loadCollectionsTree: mocks.loadCollectionsTree,
}))

import KnowledgeHome, { formatUpdated } from "~/modules/knowledge/KnowledgeHome"
import { setShellTier } from "~/tests/helpers/shell-tier"

describe("Knowledge home at phone width", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.homeData = {
      recent: [{ id: "d1", title: "Return policy", updatedAt: "2026-09-01T10:00:00.000Z" }],
      needsReview: [],
    }
    mocks.store.collectionsTree = [
      {
        id: "col1",
        name: "Support",
        parentId: null,
        ownerUserId: null,
        children: [],
        documents: [{ id: "d2", title: "Refund script" }],
      },
    ]
  })

  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("owns a large title at phone and keeps the small desktop heading", () => {
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    expect(screen.getByTestId("knowledge-title")).toHaveTextContent("Knowledge")
    cleanup()

    setShellTier("desktop")
    render(() => <KnowledgeHome />)
    expect(screen.queryByTestId("knowledge-title")).toBeNull()
  })

  it("wraps the header instead of folding the CTA against the title at phone", () => {
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    expect(screen.getByTestId("knowledge-home-header").className).toContain("flex-wrap")
    const cta = screen.getByTestId("knowledge-home-create-from-cta")
    expect(cta.className).toContain("whitespace-nowrap")
    expect(cta.className).toContain("shrink-0")
  })

  it("lists the collections as rows at phone, and not at desktop", () => {
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    expect(screen.getByTestId("knowledge-collection-col1")).toHaveTextContent("Support")
    cleanup()

    setShellTier("desktop")
    render(() => <KnowledgeHome />)
    expect(screen.queryByTestId("knowledge-home-collections")).toBeNull()
  })

  it("opens a collection in place and opens the document it holds", () => {
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    expect(screen.queryByTestId("knowledge-collection-doc-d2")).toBeNull()
    fireEvent.click(screen.getByTestId("knowledge-collection-col1"))
    fireEvent.click(screen.getByTestId("knowledge-collection-doc-d2"))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "knowledge:document", entityId: "d2" }),
    )
  })

  it("fetches the collections tree itself at phone, since no sidebar did", () => {
    mocks.store.collectionsTree = []
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    expect(mocks.loadCollectionsTree).toHaveBeenCalled()
  })

  it("says when a document row was last touched", () => {
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    const row = screen.getByTestId("knowledge-recent-d1")
    expect(row).toHaveTextContent("Return policy")
    expect(row.textContent).toContain(formatUpdated("2026-09-01T10:00:00.000Z"))
  })

  it("drops the desktop gutters for the phone ones", () => {
    setShellTier("phone")
    render(() => <KnowledgeHome />)
    const home = screen.getByTestId("knowledge-home")
    expect(home.className).toContain("px-4")
    expect(home.className).not.toContain("max-w-2xl")
    cleanup()

    setShellTier("desktop")
    render(() => <KnowledgeHome />)
    expect(screen.getByTestId("knowledge-home").className).toContain("max-w-2xl")
  })
})

describe("formatUpdated", () => {
  it("is empty rather than 'Invalid Date' for an unusable value", () => {
    expect(formatUpdated(undefined)).toBe("")
    expect(formatUpdated("not-a-date")).toBe("")
  })
})
