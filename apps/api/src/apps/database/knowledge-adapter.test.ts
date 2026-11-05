// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit test for the database-backed Knowledge source adapter. Mirrors the
// google-drive/adapter.test.ts style: pure mock deps (a `runRead` stub + a
// `hasRead` capability predicate), no DB, no transport. Proves the adapter
// maps curated-read rows to KnowledgeFolderItem / RemoteContentResult exactly
// as the reconciler expects, and honors the non-throwing IO contract.

import { describe, expect, it, mock } from "bun:test"
import { createDatabaseKnowledgeAdapter } from "./knowledge-adapter"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:sources:read"],
  dimensionGrants: {},
}

const LIST = "knowledge_sync_list"
const GET = "knowledge_sync_get"

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, id }), "utf-8").toString("base64")
}
function decodeCursor(cursor: string): { updated_at: string; id: string } {
  return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"))
}

describe("Database Knowledge source adapter", () => {
  it("searchRemote is a skipped no-op", async () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => ({ rows: [] }),
      hasRead: () => true,
    })
    const result = await adapter.searchRemote({ query: "x", limit: 10 }, actor)
    expect(result.hits).toEqual([])
    expect(result.status.source).toBe("database")
    expect(result.status.state).toBe("skipped")
    expect(result.status.retryable).toBe(false)
  })

  it("listFolder maps rows to text/markdown file items with parentExternalId set", async () => {
    const runRead = mock(async (_name: string, _params: Record<string, unknown>) => ({
      rows: [
        {
          id: 42,
          title: "Refund Policy",
          updated_at: "2026-05-01T00:00:00.000Z",
          url: "https://hub/kb/42",
        },
        { id: "art-7", title: "Shipping", updated_at: "2026-05-02T00:00:00.000Z" },
      ],
    }))
    const adapter = createDatabaseKnowledgeAdapter({ runRead, hasRead: () => true })
    const result = await adapter.listFolder!({ folderRef: "kb" }, actor)

    expect(runRead).toHaveBeenCalledTimes(1)
    expect(runRead.mock.calls[0][0]).toBe(LIST)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toEqual({
      kind: "file",
      externalId: "42",
      name: "Refund Policy",
      parentExternalId: "kb",
      mimeType: "text/markdown",
      modifiedAt: "2026-05-01T00:00:00.000Z",
      url: "https://hub/kb/42",
    })
    // url omitted when the row has none
    expect(result.items[1].url).toBeUndefined()
    expect(result.items[1].externalId).toBe("art-7")
    expect(result.items[1].parentExternalId).toBe("kb")
    expect(result.items[1].mimeType).toBe("text/markdown")
  })

  it("passes decoded cursor as after_updated_at/after_id and sets nextCursor on a full page", async () => {
    // Return exactly `limit` rows so a full page → nextCursor is emitted.
    const rows = Array.from({ length: 200 }, (_v, i) => ({
      id: `id-${i}`,
      title: `Doc ${i}`,
      updated_at: `2026-05-01T00:00:00.${String(i).padStart(3, "0")}Z`,
    }))
    const runRead = mock(async (_name: string, _params: Record<string, unknown>) => ({ rows }))
    const adapter = createDatabaseKnowledgeAdapter({ runRead, hasRead: () => true })

    const cursorIn = encodeCursor("2026-04-01T00:00:00.000Z", "prev-9")
    const result = await adapter.listFolder!({ folderRef: "kb", cursor: cursorIn }, actor)

    const params = runRead.mock.calls[0][1] as Record<string, unknown>
    expect(params.after_updated_at).toBe("2026-04-01T00:00:00.000Z")
    expect(params.after_id).toBe("prev-9")
    expect(params.limit).toBe(200)

    expect(result.nextCursor).toBeDefined()
    const decoded = decodeCursor(result.nextCursor!)
    expect(decoded.id).toBe("id-199")
    expect(decoded.updated_at).toBe("2026-05-01T00:00:00.199Z")
  })

  it("omits nextCursor on a short page, and passes null cursor params when no cursor", async () => {
    const runRead = mock(async (_name: string, _params: Record<string, unknown>) => ({
      rows: [{ id: "a", title: "A", updated_at: "2026-05-01T00:00:00.000Z" }],
    }))
    const adapter = createDatabaseKnowledgeAdapter({ runRead, hasRead: () => true })
    const result = await adapter.listFolder!({ folderRef: "kb" }, actor)
    expect(result.nextCursor).toBeUndefined()
    const params = runRead.mock.calls[0][1] as Record<string, unknown>
    expect(params.after_updated_at).toBeNull()
    expect(params.after_id).toBeNull()
  })

  it("hasRead=false for list → empty items, NO throw, no read call, no recursion", async () => {
    const runRead = mock(async () => ({ rows: [] }))
    const adapter = createDatabaseKnowledgeAdapter({
      runRead,
      hasRead: (name: string) => name !== LIST,
    })
    const result = await adapter.listFolder!({ folderRef: "kb" }, actor)
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeUndefined()
    expect(runRead).toHaveBeenCalledTimes(0)
  })

  it("transport failure in listFolder → empty items, NO throw", async () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => {
        throw new Error("connection refused")
      },
      hasRead: () => true,
    })
    const result = await adapter.listFolder!({ folderRef: "kb" }, actor)
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeUndefined()
  })

  it("bad folderRef throws (defense-in-depth charset guard)", async () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => ({ rows: [] }),
      hasRead: () => true,
    })
    await expect(adapter.listFolder!({ folderRef: "kb; DROP" }, actor)).rejects.toThrow()
    await expect(adapter.listFolder!({ folderRef: "" }, actor)).rejects.toThrow()
  })

  it("fetchRemoteContent maps a row to an available body", async () => {
    const runRead = mock(async (_name: string, params: Record<string, unknown>) => {
      expect(params.id).toBe("42")
      return {
        rows: [
          {
            id: "42",
            title: "Refund Policy",
            body: "# Refunds\nText",
            updated_at: "2026-05-01T00:00:00.000Z",
            url: "https://hub/kb/42",
          },
        ],
      }
    })
    const adapter = createDatabaseKnowledgeAdapter({ runRead, hasRead: () => true })
    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "42" }, actor, "sync")
    expect(runRead.mock.calls[0][0]).toBe(GET)
    expect(content).toEqual({
      status: "available",
      text: "# Refunds\nText",
      title: "Refund Policy",
      url: "https://hub/kb/42",
      modifiedAt: "2026-05-01T00:00:00.000Z",
    })
  })

  it("fetchRemoteContent → unsupported when the get read is absent", async () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => ({ rows: [] }),
      hasRead: (name: string) => name !== GET,
    })
    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "42" }, actor)
    expect(content.status).toBe("unsupported")
    expect(content.text).toBeUndefined()
  })

  it("fetchRemoteContent → unavailable when no row is returned", async () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => ({ rows: [] }),
      hasRead: () => true,
    })
    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "nope" }, actor)
    expect(content.status).toBe("unavailable")
  })

  it("fetchRemoteContent → unavailable on transport failure (never throws)", async () => {
    const adapter = createDatabaseKnowledgeAdapter({
      runRead: async () => {
        throw new Error("timeout")
      },
      hasRead: () => true,
    })
    const content = await adapter.fetchRemoteContent!({ sourceEntityId: "42" }, actor)
    expect(content.status).toBe("unavailable")
  })
})
