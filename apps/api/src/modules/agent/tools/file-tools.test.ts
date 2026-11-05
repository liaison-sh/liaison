// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as fileService from "~/modules/files/service"
import * as mergeService from "~/modules/pdf/merge"
import { handleFilesList, handleFilesMergePdfs, handleFilesRead } from "./file-tools"

const ORG = "00000000-0000-0000-0000-000000000001"
const USER = "00000000-0000-0000-0000-000000000002"

// listFiles runs two RLS queries — the rows SELECT then the COUNT — so the
// first execute returns rows, the second returns the total.
function makeCtx(files: Record<string, unknown>[]) {
  let call = 0
  const db = {
    execute: mock(async () => {
      call++
      if (call === 1) return files
      return [{ total: String(files.length) }]
    }),
  }
  return { orgId: ORG, userId: USER, db } as never
}

describe("handleFilesList", () => {
  it("returns file metadata for an entity the agent can see", async () => {
    const ctx = makeCtx([
      {
        id: "f1",
        app: "tickets",
        entityType: "message",
        entityId: "m1",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        storageKey: "orgs/o/tickets/message/m1/x/photo.jpg",
        thumbnailKey: null,
        uploadedBy: USER,
        disposition: "attachment",
        contentId: null,
        originalContentId: null,
        ordinal: 0,
        createdAt: new Date(),
      },
    ])
    const res = await handleFilesList(
      { app: "tickets", entityType: "message", entityId: "m1" },
      ctx,
    )
    expect(res.files).toHaveLength(1)
    expect(res.files[0]).toMatchObject({ id: "f1", filename: "photo.jpg", sizeBytes: 1024 })
  })

  it("returns an empty list (not an error) for an entity with no files", async () => {
    const ctx = makeCtx([])
    const res = await handleFilesList({ app: "kernel", entityType: "thread", entityId: "t9" }, ctx)
    expect(res.files).toEqual([])
  })
})

describe("handleFilesRead", () => {
  afterEach(() => {
    mock.restore()
  })

  const ctx = { orgId: ORG, userId: USER, db: {} } as never

  it("returns a capability URL + metadata (URL only, never the file's bytes)", async () => {
    const spy = spyOn(fileService, "getRelayDownloadUrl").mockResolvedValue({
      id: "f-log",
      filename: "labLogCurrent.log",
      mimeType: "text/plain; charset=utf-8",
      sizeBytes: 95,
      downloadUrl: "https://staging.fabrikam.example/api/file-relay-dl/tok.abc.def",
      expiresInSec: 300,
    })
    const res = await handleFilesRead({ fileId: "f-log" }, ctx)
    expect(res).toEqual({
      fileId: "f-log",
      filename: "labLogCurrent.log",
      mimeType: "text/plain; charset=utf-8",
      sizeBytes: 95,
      downloadUrl: "https://staging.fabrikam.example/api/file-relay-dl/tok.abc.def",
      expiresInSec: 300,
    })
    // URL routes through the app relay, never the object store directly, and
    // carries no inline bytes.
    expect(res.downloadUrl).toContain("/api/file-relay-dl/")
    expect(JSON.stringify(res)).not.toContain("TESSERA LAB LOG")
    expect(spy).toHaveBeenCalledWith("f-log", expect.objectContaining({ ttlSeconds: undefined }))
  })

  it("forwards a requested TTL to the relay-url builder", async () => {
    const spy = spyOn(fileService, "getRelayDownloadUrl").mockResolvedValue({
      id: "f-log",
      filename: "x",
      mimeType: "text/plain",
      sizeBytes: 1,
      downloadUrl: "https://h/api/file-relay-dl/t",
      expiresInSec: 900,
    })
    const res = await handleFilesRead({ fileId: "f-log", expiresInSec: 900 }, ctx)
    expect(res.expiresInSec).toBe(900)
    expect(spy).toHaveBeenCalledWith("f-log", expect.objectContaining({ ttlSeconds: 900 }))
  })

  it("rejects a file the caller cannot see (builder throws)", async () => {
    spyOn(fileService, "getRelayDownloadUrl").mockRejectedValue(new Error("File not visible"))
    await expect(handleFilesRead({ fileId: "nope" }, ctx)).rejects.toThrow()
  })
})

describe("handleFilesMergePdfs", () => {
  afterEach(() => {
    mock.restore()
  })

  const ctx = { orgId: ORG, userId: USER, db: {} } as never

  it("maps the merge result to the tool shape and forwards RLS ctx", async () => {
    const spy = spyOn(mergeService, "mergePdfs").mockResolvedValue({
      file_id: "merged-1",
      byte_size: 4096,
      page_count: 4,
      title: "packet.pdf",
    })
    const res = await handleFilesMergePdfs({ file_ids: ["a", "a", "b"], title: "packet" }, ctx)
    expect(res).toEqual({ fileId: "merged-1", byteSize: 4096, pageCount: 4, title: "packet.pdf" })
    expect(spy).toHaveBeenCalledWith(
      { fileIds: ["a", "a", "b"], title: "packet" },
      expect.objectContaining({ orgId: ORG, userId: USER }),
    )
  })

  it("propagates a typed merge error to the agent", async () => {
    spyOn(mergeService, "mergePdfs").mockRejectedValue(
      new mergeService.MergePdfsError("not_a_pdf", "File x is not a PDF"),
    )
    await expect(handleFilesMergePdfs({ file_ids: ["x", "y"] }, ctx)).rejects.toThrow(/not a PDF/)
  })
})
