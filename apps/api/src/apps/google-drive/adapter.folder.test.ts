// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import { createGoogleDriveAdapter } from "~/apps/google-drive/adapter"
import type { KnowledgeActor } from "~/apps/knowledge/service"

const fakeActor = (): KnowledgeActor =>
  ({ orgId: "o1", userId: "u1", scopes: ["knowledge:sources:read"] }) as unknown as KnowledgeActor

describe("Drive adapter — listFolder (T-3)", () => {
  it("returns folder + file items with mime + parentExternalId from Drive list", async () => {
    const fetchDrive = mock(async () => ({
      files: [
        {
          id: "f1",
          name: "section-a",
          mimeType: "application/vnd.google-apps.folder",
        },
        {
          id: "x1",
          name: "intro.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-05-24T00:00:00Z",
        },
        {
          id: "x2",
          name: "diagram.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-05-22T00:00:00Z",
        },
      ],
      nextPageToken: undefined,
    }))
    const a = createGoogleDriveAdapter({
      getToken: async () => "t",
      fetchDrive,
    })
    const res = await a.listFolder!({ folderRef: "root1234" }, fakeActor())
    expect(res.items).toEqual([
      {
        kind: "folder",
        externalId: "f1",
        name: "section-a",
        parentExternalId: "root1234",
      },
      {
        kind: "file",
        externalId: "x1",
        name: "intro.md",
        parentExternalId: "root1234",
        mimeType: "text/markdown",
        modifiedAt: "2026-05-24T00:00:00Z",
      },
      {
        kind: "file",
        externalId: "x2",
        name: "diagram.pdf",
        parentExternalId: "root1234",
        mimeType: "application/pdf",
        modifiedAt: "2026-05-22T00:00:00Z",
      },
    ])
    expect(fetchDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "'root1234' in parents and trashed = false",
      }),
    )
  })

  it("propagates Drive nextPageToken as cursor", async () => {
    const fetchDrive = mock(async () => ({ files: [], nextPageToken: "abc" }))
    const a = createGoogleDriveAdapter({ getToken: async () => "t", fetchDrive })
    const res = await a.listFolder!({ folderRef: "RRRRRRRR" }, fakeActor())
    expect(res.nextCursor).toBe("abc")
  })

  it("forwards the cursor as pageToken on the next call", async () => {
    const fetchDrive = mock(async () => ({ files: [], nextPageToken: undefined }))
    const a = createGoogleDriveAdapter({ getToken: async () => "t", fetchDrive })
    await a.listFolder!({ folderRef: "RRRRRRRR", cursor: "cur-1" }, fakeActor())
    expect(fetchDrive).toHaveBeenCalledWith(expect.objectContaining({ pageToken: "cur-1" }))
  })

  it("C3: rejects folderRef containing characters that could break the Drive q: filter", async () => {
    const fetchDrive = mock(async () => ({ files: [] }))
    const a = createGoogleDriveAdapter({ getToken: async () => "t", fetchDrive })
    // Each of these would, without the adapter-level guard, escape the
    // single-quoted literal in the Drive `q:` filter or otherwise be a
    // pattern Drive file ids never produce.
    const injectionAttempts = [
      "abc' in parents or '' in parents and trashed = false or 'YYY",
      "abc def", // whitespace
      "abc/def", // slash
      "abc\nlinebreak", // newline
      "短", // unicode
      "abc'", // bare quote
      "ab", // too short (< 8)
      "a".repeat(200), // too long (> 128)
    ]
    for (const folderRef of injectionAttempts) {
      await expect(a.listFolder!({ folderRef }, fakeActor())).rejects.toThrow(
        /Invalid Drive folderRef/,
      )
    }
    // Defense in depth: the bad refs MUST NOT have triggered an outbound
    // fetch call.
    expect(fetchDrive).not.toHaveBeenCalled()
  })

  it("does NOT declare pickFolder in v1 (manual folder-ID entry fallback)", () => {
    const a = createGoogleDriveAdapter({
      getToken: async () => "t",
      fetchDrive: mock(async () => ({ files: [] })),
    })
    expect(a.pickFolder).toBeUndefined()
  })
})

describe("Drive adapter — picked-items root", () => {
  const picked = [
    { id: "keep-aaaaaaaa", name: "old name", mimeType: "text/plain" },
    { id: "gone-bbbbbbbb", name: "Deleted", mimeType: "text/plain" },
    { id: "trash-cccccccc", name: "Trashed", mimeType: "text/plain" },
    { id: "unshared-dddd", name: "Unshared", mimeType: "text/plain" },
  ]
  const httpError = (status: number, reason?: string) =>
    Object.assign(new Error(`Drive HTTP ${status}`), { status, reason })

  it("lists what Drive still shows: deleted, trashed and unshared picks drop out, Drive's names win", async () => {
    const a = createGoogleDriveAdapter({
      getToken: async () => "t",
      fetchDrive: async () => ({ files: [] }),
      getPickedItems: async () => picked,
      getMetadata: async ({ id }) => {
        if (id === "gone-bbbbbbbb") throw httpError(404)
        if (id === "unshared-dddd") throw httpError(403, "insufficientFilePermissions")
        return {
          id,
          name: id === "keep-aaaaaaaa" ? "Plan.docx" : "x",
          mimeType: "application/msword",
          trashed: id === "trash-cccccccc",
        }
      },
    })
    const res = await a.listFolder!({ folderRef: "liaison-picked-items" }, fakeActor())
    expect(res.items).toEqual([
      {
        kind: "file",
        externalId: "keep-aaaaaaaa",
        name: "Plan.docx",
        parentExternalId: "liaison-picked-items",
        mimeType: "application/msword",
      },
    ])
  })

  it("a rate limit or a revoked token fails the listing instead of emptying the source", async () => {
    const a = createGoogleDriveAdapter({
      getToken: async () => "t",
      fetchDrive: async () => ({ files: [] }),
      getPickedItems: async () => picked.slice(0, 1),
      getMetadata: async () => {
        throw httpError(403, "userRateLimitExceeded")
      },
    })
    await expect(a.listFolder!({ folderRef: "liaison-picked-items" }, fakeActor())).rejects.toThrow(
      /403/,
    )
  })
})
