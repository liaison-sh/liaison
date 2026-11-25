// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Page links on a Knowledge page (S13, S14): the reader shows the title of a page it
// may open and "Page you cannot open" for any other, with no title in the DOM; a
// rename shows at once; "Linked from" lists the pages and conversations that point
// here, and each row opens it, in a sheet on a phone.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setAttentionApi } from "~/modules/shell/attention-store"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { liveSavers } from "./autosave"
import { handleKnowledgeDocumentWsEvent } from "./exports"
import KnowledgeDocumentView from "./KnowledgeDocumentView"
import { resetKnowledgeStore } from "./knowledge-store"
import { resetPageFiles } from "./page-files"
import { resetPageTitles } from "./page-links"

const opened = vi.hoisted(() => [] as Array<{ type: string; entityId: string; label?: string }>)
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: (tab: { type: string; entityId: string; label?: string }) => opened.push(tab),
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: () => false,
  userFromToken: () => ({ userId: "lucas", orgId: "o1", name: "Lucas Pereira" }),
}))

const OPEN = "11111111-1111-4111-8111-111111111111"
const SECRET = "33333333-3333-4333-8333-333333333333"
const SOURCE = "44444444-4444-4444-8444-444444444444"

function makeApi(canEdit: boolean) {
  const titles: Record<string, string> = { [OPEN]: "Return procedure" }
  const page = {
    id: "doc1",
    title: "Policies",
    body: `See [](knowledge:document:${OPEN}) and [](knowledge:document:${SECRET}).`,
    revision: 1,
    documentScope: "organization",
    status: "active",
    canEdit,
    updatedAt: new Date().toISOString(),
  }
  const api = {
    titles,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/backlinks")) {
        return {
          backlinks: [
            {
              kind: "page",
              app: "knowledge",
              entityType: "document",
              entityId: SOURCE,
              title: "Onboarding",
            },
            {
              kind: "thread",
              app: "kernel",
              entityType: "thread",
              entityId: "t1",
              title: "Returns question",
              url: "/threads/t1",
            },
          ],
        }
      }
      if (path.startsWith("/knowledge/documents/pick")) {
        return Object.entries(titles).map(([id, title]) => ({ id, title }))
      }
      if (path.endsWith("/sharing")) return { orgAccess: "none", shares: [] }
      if (path === "/knowledge/members" || path === "/knowledge/roles") return []
      if (path.startsWith("/files")) return []
      if (path.endsWith("/versions")) return []
      if (path.startsWith(`/knowledge/documents/${OPEN}`)) return { id: OPEN, title: titles[OPEN] }
      return { ...page }
    }),
    post: vi.fn(async (path: string, body: { ids?: string[] }) => {
      if (path === "/knowledge/documents/resolve") {
        return (body.ids ?? [])
          .filter((id) => id in titles)
          .map((id) => ({ id, title: titles[id] }))
      }
      return {}
    }),
    patch: vi.fn(async () => ({ ...page })),
    put: vi.fn(async () => ({})),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  }
  return api
}

function renderView(api: ReturnType<typeof makeApi>, locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as never}>
        <KnowledgeDocumentView entityId="doc1" />
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

afterEach(async () => {
  for (const s of liveSavers()) await s.destroy({ discard: true })
  resetKnowledgeStore()
  resetPageFiles()
  resetPageTitles()
  setAttentionApi(null)
  setShellTier("desktop")
  opened.length = 0
})

const chips = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-page-link]")]

describe("page links: a reader", () => {
  it("sees the title of a page it may open, the neutral label for the other, no title in the DOM", async () => {
    const api = makeApi(false)
    renderView(api)
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    await waitFor(() => expect(chips(rendered)[0]?.textContent).toBe("Return procedure"))
    const [open, secret] = chips(rendered)
    expect(secret?.textContent).toBe("Page you cannot open")
    expect(secret?.dataset.state).toBe("unavailable")
    expect(rendered.querySelector("[title]")).toBeNull()
    fireEvent.click(open!)
    expect(opened).toContainEqual({
      type: "knowledge:document",
      entityId: OPEN,
      label: "Return procedure",
    })
    fireEvent.click(secret!)
    expect(opened).toHaveLength(1)
  })

  it("a rename of the linked page shows at once", async () => {
    const api = makeApi(false)
    setAttentionApi(api as never)
    renderView(api)
    const rendered = await screen.findByTestId("knowledge-doc-body-rendered")
    await waitFor(() => expect(chips(rendered)[0]?.textContent).toBe("Return procedure"))
    api.titles[OPEN] = "Returns, step by step"
    await handleKnowledgeDocumentWsEvent("update", { entityId: OPEN })
    await waitFor(() => expect(chips(rendered)[0]?.textContent).toBe("Returns, step by step"))
  })
})

describe("page links: a writer", () => {
  it("the editor's chips resolve the same way", async () => {
    const api = makeApi(true)
    renderView(api)
    const field = await screen.findByTestId("knowledge-doc-body-editor", {}, { timeout: 4000 })
    await waitFor(() => expect(chips(field)[0]?.textContent).toBe("Return procedure"))
    expect(chips(field)[1]?.textContent).toBe("Page you cannot open")
  })
})

describe("Linked from", () => {
  it("lists the pages and conversations that point here; each row opens it", async () => {
    const api = makeApi(false)
    renderView(api)
    const button = await screen.findByTestId("knowledge-backlinks-button")
    expect(button.textContent).toContain("2 references")
    fireEvent.click(button)
    const panel = await screen.findByTestId("knowledge-backlinks-panel")
    expect(panel.textContent).toContain("Linked from")
    expect(panel.textContent).toContain("Onboarding")
    expect(panel.textContent).toContain("Conversations")
    fireEvent.click(screen.getByTestId("knowledge-backlink-page"))
    expect(opened.at(-1)).toEqual({
      type: "knowledge:document",
      entityId: SOURCE,
      label: "Onboarding",
    })
    fireEvent.click(await screen.findByTestId("knowledge-backlinks-button"))
    fireEvent.click(await screen.findByTestId("knowledge-backlink-thread"))
    expect(opened.at(-1)).toEqual({
      type: "kernel:thread",
      entityId: "t1",
      label: "Returns question",
    })
    // Asked again each time the list opens.
    const asked = api.get.mock.calls.filter(([p]) => String(p).endsWith("/backlinks")).length
    expect(asked).toBeGreaterThanOrEqual(3)
  })

  it("a conversation with no title is named in the reader's language", async () => {
    for (const [locale, name] of [
      ["en", "Untitled conversation"],
      ["fr", "Conversation sans titre"],
    ] as const) {
      const api = makeApi(false)
      const read = api.get.getMockImplementation()!
      api.get.mockImplementation(async (path: string) => {
        if (!path.endsWith("/backlinks")) return read(path)
        return {
          backlinks: [
            { kind: "thread", app: "kernel", entityType: "thread", entityId: "t2", title: "" },
          ],
        }
      })
      renderView(api, locale)
      fireEvent.click(await screen.findByTestId("knowledge-backlinks-button"))
      const row = await screen.findByTestId("knowledge-backlink-thread")
      expect(row.textContent).toBe(name)
      cleanup()
    }
  })

  it("opens as a sheet on a phone", async () => {
    setShellTier("phone")
    renderView(makeApi(false))
    const button = await screen.findByTestId("knowledge-backlinks-button")
    fireEvent.click(button)
    const page = await screen.findByTestId("knowledge-backlink-page")
    expect(page.className).toContain("min-h-11")
  })
})
