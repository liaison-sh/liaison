// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The knowledge document at phone width (M2-3 T19): a full-width reading
// column with 16px gutters, and the attachments panel moved into a Sources
// bottom sheet instead of a second block of rows under the text.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"
import KnowledgeDocumentView from "./KnowledgeDocumentView"
import { resetKnowledgeStore } from "./knowledge-store"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => scope === "knowledge:attachments:download",
}))

function makeApi() {
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/backlinks")) return { backlinks: [] }
      if (path.endsWith("/sharing")) return { orgAccess: "none", shares: [] }
      if (path === "/knowledge/members") return []
      if (path === "/knowledge/roles") return []
      return {
        id: "doc1",
        title: "Hello",
        body: "# H1",
        revision: 1,
        reviewStatus: "verified",
        documentScope: "personal",
        ownerUserId: "alice",
        status: "active",
      }
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ revision: 2 })),
    put: vi.fn(async () => ({})),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  }
}

function renderView(api: ReturnType<typeof makeApi>) {
  return render(() => (
    <ApiContext.Provider value={api as never}>
      <KnowledgeDocumentView entityId="doc1" />
    </ApiContext.Provider>
  ))
}

afterEach(() => {
  cleanup()
  resetKnowledgeStore()
  setShellTier("desktop")
})

describe("KnowledgeDocumentView at phone width", () => {
  it("reads full width with phone gutters instead of the 2xl column", async () => {
    setShellTier("phone")
    renderView(makeApi())
    const body = await screen.findByTestId("knowledge-doc-body")
    expect(body.className).toContain("px-4")
    expect(body.className).not.toContain("max-w-2xl")
    expect(body.className).not.toContain("px-8")
  })

  it("keeps the desktop reading column untouched", async () => {
    setShellTier("desktop")
    renderView(makeApi())
    const body = await screen.findByTestId("knowledge-doc-body")
    expect(body.className).toContain("max-w-2xl")
    expect(body.className).toContain("px-8")
  })

  it("moves the sources into a bottom sheet the reader opens", async () => {
    setShellTier("phone")
    renderView(makeApi())
    await screen.findByTestId("knowledge-doc-body")
    // Not under the text: the list only exists once the sheet is open.
    expect(screen.queryByTestId("knowledge-attachment-list")).toBeNull()
    fireEvent.click(screen.getByTestId("knowledge-doc-sources-open"))
    expect(await screen.findByTestId("knowledge-attachment-list")).toBeInTheDocument()
    const sheet = document.querySelector("[data-overlay-sheet][data-variant='bottom']")
    expect(sheet).not.toBeNull()
  })

  it("keeps the inline attachments section at desktop width", async () => {
    setShellTier("desktop")
    renderView(makeApi())
    await screen.findByTestId("knowledge-doc-body")
    expect(screen.getByTestId("knowledge-attachment-list")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-doc-sources-open")).toBeNull()
  })
})
