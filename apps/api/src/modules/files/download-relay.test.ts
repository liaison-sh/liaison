// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as objectStorage from "~/infra/storage/object-storage"
import { fileDownloadRelay } from "~/modules/files/routes"
import * as fileService from "~/modules/files/service"
import {
  FileServiceError,
  getRelayDownloadUrl,
  signFileDownloadToken,
} from "~/modules/files/service"
import * as orgDeleting from "~/modules/org/purge/deleting"

const ORG = "00000000-0000-0000-0000-000000000001"

const ROW = {
  id: "f-log",
  orgId: ORG,
  filename: "labLogCurrent.log",
  mimeType: "text/plain; charset=utf-8",
  sizeBytes: 95,
  storageKey: "orgs/o/tickets/staged/f-log/labLogCurrent.log",
}

function rlsTxReturning(rows: unknown[]) {
  return { execute: mock(async () => rows) } as never
}

describe("getRelayDownloadUrl", () => {
  it("mints a capability URL on the app host pinning the file, with default 5-min TTL", async () => {
    let signed: unknown
    const res = await getRelayDownloadUrl("f-log", {
      rlsTx: rlsTxReturning([ROW]),
      baseUrl: "https://staging.fabrikam.example",
      signToken: async (payload, _secret, ttl) => {
        signed = { payload, ttl }
        return "TOK"
      },
    })
    expect(res).toEqual({
      id: "f-log",
      filename: "labLogCurrent.log",
      mimeType: "text/plain; charset=utf-8",
      sizeBytes: 95,
      downloadUrl: "https://staging.fabrikam.example/api/file-relay-dl/TOK",
      expiresInSec: 300,
    })
    // Token is scoped to exactly this file + storage key + org.
    expect(signed).toEqual({
      payload: {
        orgId: ORG,
        fileId: "f-log",
        storageKey: ROW.storageKey,
        filename: "labLogCurrent.log",
        mimeType: "text/plain; charset=utf-8",
      },
      ttl: 300,
    })
  })

  it("clamps a too-long requested TTL to the 900s ceiling", async () => {
    let ttlSeen = 0
    const res = await getRelayDownloadUrl("f-log", {
      rlsTx: rlsTxReturning([ROW]),
      baseUrl: "https://h",
      ttlSeconds: 100000,
      signToken: async (_p, _s, ttl) => {
        ttlSeen = ttl ?? 0
        return "T"
      },
    })
    expect(res.expiresInSec).toBe(900)
    expect(ttlSeen).toBe(900)
  })

  it("throws PARENT_NOT_FOUND for a file the caller cannot see (RLS returns no row)", async () => {
    await expect(
      getRelayDownloadUrl("nope", { rlsTx: rlsTxReturning([]), baseUrl: "https://h" }),
    ).rejects.toBeInstanceOf(FileServiceError)
  })
})

describe("fileDownloadRelay route", () => {
  beforeEach(() => {
    spyOn(orgDeleting, "assertOrgNotDeleting").mockResolvedValue(undefined)
  })
  afterEach(() => {
    mock.restore()
  })

  it("refuses a valid token once its org's deletion has started (410), before storage", async () => {
    spyOn(orgDeleting, "assertOrgNotDeleting").mockRejectedValue(new orgDeleting.OrgDeletedError())
    const recheck = spyOn(fileService, "isRelayedFileServable").mockResolvedValue(true)
    const stream = spyOn(objectStorage, "getObjectStream")
    const token = await signFileDownloadToken({
      orgId: ORG,
      fileId: "f-log",
      storageKey: ROW.storageKey,
      filename: "labLogCurrent.log",
      mimeType: "text/plain; charset=utf-8",
    })
    const res = await fileDownloadRelay.request(`/${token}`)
    expect(res.status).toBe(410)
    expect(orgDeleting.assertOrgNotDeleting).toHaveBeenCalledWith(ORG)
    expect(recheck).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it("streams the pinned object for a valid token, forced to attachment disposition", async () => {
    spyOn(fileService, "isRelayedFileServable").mockResolvedValue(true)
    const bytes = new TextEncoder().encode("TESSERA LAB LOG\nline2")
    spyOn(objectStorage, "getObjectStream").mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
      contentType: "text/plain",
      contentLength: bytes.byteLength,
    })
    const token = await signFileDownloadToken({
      orgId: ORG,
      fileId: "f-log",
      storageKey: ROW.storageKey,
      filename: "labLogCurrent.log",
      mimeType: "text/plain; charset=utf-8",
    })
    const res = await fileDownloadRelay.request(`/${token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toContain("attachment")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await res.text()).toBe("TESSERA LAB LOG\nline2")
  })

  it("refuses a valid token whose file was deleted since (e.g. its message was deleted)", async () => {
    const recheck = spyOn(fileService, "isRelayedFileServable").mockResolvedValue(false)
    const stream = spyOn(objectStorage, "getObjectStream")
    const token = await signFileDownloadToken({
      orgId: ORG,
      fileId: "f-log",
      storageKey: ROW.storageKey,
      filename: "labLogCurrent.log",
      mimeType: "text/plain; charset=utf-8",
    })
    for (const method of ["GET", "HEAD"]) {
      const res = await fileDownloadRelay.request(`/${token}`, { method })
      expect(res.status).toBe(404)
    }
    expect(recheck).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, fileId: "f-log", storageKey: ROW.storageKey }),
    )
    expect(stream).not.toHaveBeenCalled()
  })

  it("rejects a forged / malformed token with 401 and never touches storage", async () => {
    const spy = spyOn(objectStorage, "getObjectStream")
    const res = await fileDownloadRelay.request("/not-a-real-token")
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
})
