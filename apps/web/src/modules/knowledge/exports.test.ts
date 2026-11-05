// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setAttentionApi } from "~/modules/shell/attention-store"
import { handleKnowledgeDocumentWsEvent } from "./exports"
import { knowledgeStore, resetKnowledgeStore } from "./knowledge-store"

describe("handleKnowledgeDocumentWsEvent", () => {
  beforeEach(() => {
    resetKnowledgeStore()
  })

  afterEach(() => {
    setAttentionApi(null)
    resetKnowledgeStore()
  })

  it('action "create" refreshes the Knowledge home feed', async () => {
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/knowledge/home"
          ? {
              personal: [],
              recent: [{ id: "d1", title: "New doc" }],
              needsReview: [],
              sourceHealth: [],
            }
          : [],
      ),
    }
    setAttentionApi(api as never)

    await handleKnowledgeDocumentWsEvent("create", { id: "d1" })

    expect(api.get).toHaveBeenCalledWith("/knowledge/home")
    expect(knowledgeStore.homeData?.recent).toEqual([{ id: "d1", title: "New doc" }])
  })

  it('action "update" refreshes the single cached doc AND the home feed', async () => {
    const freshDoc = { id: "d2", title: "Updated title", body: "body", externalRev: "rev-2" }
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "/knowledge/home") {
          return {
            personal: [],
            recent: [{ id: "d2", title: "Updated title" }],
            needsReview: [],
            sourceHealth: [],
          }
        }
        if (path === "/knowledge/documents/d2") return freshDoc
        return []
      }),
    }
    setAttentionApi(api as never)

    await handleKnowledgeDocumentWsEvent("update", { id: "d2", externalRev: "rev-2" })

    expect(api.get).toHaveBeenCalledWith("/knowledge/home")
    expect(knowledgeStore.documentsById.d2).toEqual(freshDoc)
    expect(knowledgeStore.homeData?.recent).toEqual([{ id: "d2", title: "Updated title" }])
  })

  it("unknown actions do nothing (no API call, no store mutation)", async () => {
    const api = { get: vi.fn() }
    setAttentionApi(api as never)

    await handleKnowledgeDocumentWsEvent("archive", { id: "d3" })

    expect(api.get).not.toHaveBeenCalled()
    expect(knowledgeStore.homeData).toBe(null)
  })

  it("no-ops gracefully when no attention API is registered", async () => {
    setAttentionApi(null)
    await expect(handleKnowledgeDocumentWsEvent("create", { id: "d4" })).resolves.toBeUndefined()
  })
})
