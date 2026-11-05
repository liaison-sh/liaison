// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The import uploader resumes after a dropped connection: a failed part makes
// it read the upload's status, re-sign the parts the store is missing and send
// only those, never a part the store already holds.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { ImportUploadInterruptedError, uploadImportFile } from "./upload-client"

const ID = "00000000-0000-4000-8000-000000000001"
const PART = 4

/** A fake upload server: the parts the store holds, and every call made to it. */
function server(partCount: number) {
  const held = new Set<number>()
  const calls: string[] = []
  const puts: number[] = []
  let signSeq = 0
  const url = (n: number) => `https://store.test/part/${n}?sig=${++signSeq}`
  const missing = () =>
    Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !held.has(n))
  const api = {
    get: vi.fn(async (path: string) => {
      calls.push(`GET ${path}`)
      return {
        id: ID,
        mode: "multipart",
        status: "uploading",
        size: partCount * PART,
        partSize: PART,
        partCount,
        fileId: null,
        received: [...held].sort().map((n) => ({ partNumber: n, size: PART })),
        missing: missing(),
      }
    }),
    post: vi.fn(async (path: string, body?: unknown) => {
      if (path === "/imports/uploads") {
        calls.push("POST create")
        return {
          id: ID,
          mode: "multipart",
          partSize: PART,
          partCount,
          parts: Array.from({ length: partCount }, (_, i) => ({
            partNumber: i + 1,
            url: url(i + 1),
          })),
        }
      }
      if (path.endsWith("/sign")) {
        const { partNumbers } = body as { partNumbers: number[] }
        calls.push(`POST sign ${partNumbers.join(",")}`)
        return { parts: partNumbers.map((n) => ({ partNumber: n, url: url(n) })) }
      }
      if (path.endsWith("/complete")) {
        calls.push("POST complete")
        if (missing().length > 0) throw new ApiError("Parts still missing", 409, "PARTS_MISSING")
        return { fileId: "file-1" }
      }
      throw new Error(`unexpected POST ${path}`)
    }),
  }
  /** PUT handler: `fail(n, attempt)` decides whether the attempt-th PUT of part n drops. */
  function fetchWith(fail: (part: number, attempt: number) => boolean) {
    const attempts = new Map<number, number>()
    return vi.fn(async (input: string) => {
      const n = Number(/\/part\/(\d+)/.exec(input)?.[1])
      const attempt = (attempts.get(n) ?? 0) + 1
      attempts.set(n, attempt)
      puts.push(n)
      if (fail(n, attempt)) throw new TypeError("Failed to fetch")
      held.add(n)
      return new Response(null, { status: 200 })
    })
  }
  return { api: api as unknown as ApiClient, calls, puts, held, fetchWith }
}

const file = (parts: number) => new File([new Uint8Array(parts * PART).fill(65)], "tickets.csv")
const noSleep = { sleep: async () => undefined }

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("uploadImportFile resume", () => {
  it("re-reads the status after a dropped part and re-sends only that part", async () => {
    const s = server(2)
    vi.stubGlobal(
      "fetch",
      s.fetchWith((n, attempt) => n === 2 && attempt === 1),
    )
    const progress: number[] = []
    const fileId = await uploadImportFile(s.api, file(2), {
      onProgress: (f) => progress.push(f),
      retry: noSleep,
    })
    expect(fileId).toBe("file-1")
    // Part 1 is sent once; part 2 twice (the drop, then the resend).
    expect(s.puts).toEqual([1, 2, 2])
    expect(s.calls).toEqual([
      "POST create",
      `GET /imports/uploads/${ID}`,
      "POST sign 2",
      "POST complete",
    ])
    expect(progress.at(-1)).toBe(1)
  })

  it("on PARTS_MISSING at complete, re-sends only the parts the store lacks", async () => {
    const s = server(3)
    vi.stubGlobal(
      "fetch",
      s.fetchWith(() => false),
    )
    // The store loses part 2 after it was sent (an upload the store dropped).
    const realPost = s.api.post
    let lost = false
    s.api.post = (async (path: string, body?: unknown, init?: unknown) => {
      if (path.endsWith("/complete") && !lost) {
        lost = true
        s.held.delete(2)
      }
      return (realPost as (p: string, b?: unknown, i?: unknown) => Promise<unknown>)(
        path,
        body,
        init,
      )
    }) as ApiClient["post"]
    const fileId = await uploadImportFile(s.api, file(3), { retry: noSleep })
    expect(fileId).toBe("file-1")
    expect(s.puts).toEqual([1, 2, 3, 2])
    expect(s.calls).toEqual([
      "POST create",
      "POST complete",
      `GET /imports/uploads/${ID}`,
      "POST sign 2",
      "POST complete",
    ])
  })

  it("gives up after the retry budget with a resumable error, never re-sending held parts", async () => {
    const s = server(2)
    vi.stubGlobal(
      "fetch",
      s.fetchWith((n) => n === 2),
    )
    const sleeps: number[] = []
    const err = await uploadImportFile(s.api, file(2), {
      retry: { attempts: 3, sleep: async (ms) => void sleeps.push(ms) },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportUploadInterruptedError)
    expect((err as ImportUploadInterruptedError).uploadId).toBe(ID)
    // One first try plus three retries of part 2, with a growing backoff.
    expect(s.puts).toEqual([1, 2, 2, 2, 2])
    expect(sleeps).toHaveLength(3)
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!)
    expect(s.calls).not.toContain("POST complete")

    // Resuming the same upload sends only what is still missing.
    vi.stubGlobal(
      "fetch",
      s.fetchWith(() => false),
    )
    const before = s.puts.length
    const fileId = await uploadImportFile(s.api, file(2), { resumeId: ID, retry: noSleep })
    expect(fileId).toBe("file-1")
    expect(s.puts.slice(before)).toEqual([2])
    expect(s.calls.filter((c) => c === "POST create")).toHaveLength(1)
  })

  it("a refusal that is not transient fails at once, without retrying", async () => {
    const s = server(2)
    vi.stubGlobal(
      "fetch",
      s.fetchWith(() => false),
    )
    s.api.post = vi.fn(async () => {
      throw new ApiError("Too large", 413, "IMPORT_FILE_TOO_LARGE")
    }) as unknown as ApiClient["post"]
    const err = await uploadImportFile(s.api, file(2), { retry: noSleep }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe("IMPORT_FILE_TOO_LARGE")
    expect(s.puts).toEqual([])
  })
})
