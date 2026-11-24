// SPDX-License-Identifier: FSL-1.1-ALv2
// A page's files through the files API: refusals said in the writer's language, every
// read under the reader's rights through the app's own routes, nothing fetched for a
// value that is not a file id.
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { FileQuotaExceededError, FileStorageUnavailableError } from "~/modules/files/file-service"
import { pageImageUrl, resetPageFiles, resolvePageFile, uploadRefusal } from "./page-files"

const t = (key: string, p?: Record<string, string | number | boolean>) =>
  `${key}${p ? ` ${JSON.stringify(p)}` : ""}`
const ID = "11111111-1111-4111-8111-111111111111"

afterEach(() => resetPageFiles())

describe("uploadRefusal", () => {
  it("names the size limit of one file", () => {
    const err = new FileQuotaExceededError("Exceeds 25 MB limit", "FILE_TOO_LARGE")
    expect(uploadRefusal(t, err, "big.mov")).toBe(
      'knowledge.files.tooLargeLimit {"name":"big.mov","limit":"25"}',
    )
  })
  it("says the storage is full", () => {
    const err = new FileQuotaExceededError("quota", "STORAGE_QUOTA_EXCEEDED")
    expect(uploadRefusal(t, err, "a.png")).toBe('knowledge.files.storageFull {"name":"a.png"}')
  })
  it("says storage is down, a refusal of the page, or a failure", () => {
    expect(uploadRefusal(t, new FileStorageUnavailableError(), "a")).toContain("storageDown")
    expect(uploadRefusal(t, new ApiError("no", 403), "a")).toContain("notAllowed")
    expect(uploadRefusal(t, new Error("x"), "a")).toContain("knowledge.files.failed")
  })
})

describe("reads", () => {
  it("asks the metadata route once per file, under the reader's rights", async () => {
    const api = {
      get: vi.fn(async () => ({ id: ID, filename: "a.png", mimeType: "image/png", sizeBytes: 3 })),
      rawGet: vi.fn(),
    }
    expect(await resolvePageFile(api as never, ID)).toMatchObject({ filename: "a.png" })
    await resolvePageFile(api as never, ID.toUpperCase())
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith(`/files/${ID}/metadata`, { suppressGlobalError: true })
  })

  it("a file the reader cannot read is null; nothing is asked for a non-id", async () => {
    const api = { get: vi.fn(async () => Promise.reject(new ApiError("nf", 404))), rawGet: vi.fn() }
    expect(await resolvePageFile(api as never, ID)).toBeNull()
    expect(await resolvePageFile(api as never, "https://evil.example/x.png")).toBeNull()
    expect(await pageImageUrl(api as never, "../../x")).toBeNull()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.rawGet).not.toHaveBeenCalled()
  })

  it("reads a picture through the inline route; an SVG answer is never a picture", async () => {
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/made")
    URL.revokeObjectURL = vi.fn()
    const answer = (body: string, type: string) =>
      new Response(body, { status: 200, headers: { "content-type": type } })
    const api = {
      get: vi.fn(),
      rawGet: vi
        .fn()
        .mockResolvedValueOnce(answer("x", "image/png"))
        .mockResolvedValueOnce(answer("<svg/>", "image/svg+xml")),
    }
    const url = await pageImageUrl(api as never, ID)
    expect(url).toMatch(/^blob:/)
    expect(api.rawGet).toHaveBeenCalledWith(`/files/${ID}/inline`, { suppressGlobalError: true })
    expect(await pageImageUrl(api as never, "22222222-2222-4222-8222-222222222222")).toBeNull()
  })
})
