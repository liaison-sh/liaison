// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { HeadResult } from "~/infra/storage/object-storage"
import { FileServiceError } from "~/modules/files/service"
import { type GetObjectBytesDeps, getObjectBytes } from "./get-object-bytes"

// `getObjectBytes` reads through `~/infra/storage/object-storage`, but it now
// accepts an injectable `deps` seam, so each test passes fakes directly rather
// than `mock.module(...)`. `mock.module` registers a PROCESS-WIDE override that
// bun:test never restores; with all *.test.ts sharing one process it leaked an
// empty-buffer `getObjectBuffer` into later suites (it broke
// `modules/pdf/render.test.ts`). Local fakes cannot leak.
function makeDeps(over: {
  head?: () => Promise<HeadResult>
  buffer?: (key: string, opts?: { maxBytes?: number }) => Promise<Buffer>
}): GetObjectBytesDeps {
  return {
    headObject: over.head
      ? async (_key: string) => over.head!()
      : async () => ({ contentLength: 0, contentType: "application/octet-stream" }),
    getObjectBuffer: over.buffer
      ? ((async (key: string, _d?: unknown, opts?: { maxBytes?: number }) =>
          over.buffer!(key, opts)) as unknown as GetObjectBytesDeps["getObjectBuffer"])
      : ((async () => Buffer.alloc(0)) as unknown as GetObjectBytesDeps["getObjectBuffer"]),
  }
}

describe("getObjectBytes", () => {
  it("rejects with FILE_TOO_LARGE when an honest Content-Length exceeds maxBytes (early reject)", async () => {
    // Honest header says 5 MiB; cap is 1 MiB. The early head-based check must
    // reject before any body is streamed.
    let streamed = false
    const deps = makeDeps({
      head: async () => ({ contentLength: 5 * 1024 * 1024, contentType: "application/pdf" }),
      buffer: async () => {
        streamed = true
        return Buffer.alloc(0)
      },
    })
    const err = await getObjectBytes("k/honest-oversized", { maxBytes: 1024 * 1024 }, deps).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(FileServiceError)
    expect((err as FileServiceError).code).toBe("FILE_TOO_LARGE")
    // The early reject must short-circuit before the streaming read.
    expect(streamed).toBe(false)
  })

  it("rejects with FILE_TOO_LARGE when a dishonest Content-Length=0 hides an oversized body (streaming cap)", async () => {
    // Header lies / is unknown (contentLength=0) so the early check is bypassed;
    // the streaming ceiling on actual received bytes must still catch it. We
    // simulate getObjectBuffer's own overflow throw to pin the catch-block
    // error-code mapping the SUT depends on.
    const cap = 1024 * 1024
    const deps = makeDeps({
      head: async () => ({ contentLength: 0, contentType: "application/octet-stream" }),
      buffer: async (_key, opts) => {
        // Mirror the real getObjectBuffer behaviour: when the streamed total
        // crosses maxBytes it throws with this exact message substring.
        throw new Error(`Object exceeds maxBytes=${opts?.maxBytes} during streaming`)
      },
    })
    const err = await getObjectBytes("k/dishonest", { maxBytes: cap }, deps).catch((e) => e)
    expect(err).toBeInstanceOf(FileServiceError)
    expect((err as FileServiceError).code).toBe("FILE_TOO_LARGE")
  })

  it("returns the streamed bytes and head content-type when under the cap", async () => {
    const payload = Buffer.from("hello world", "utf-8")
    const deps = makeDeps({
      head: async () => ({ contentLength: 0, contentType: "text/plain" }),
      buffer: async () => payload,
    })
    const result = await getObjectBytes("k/ok", { maxBytes: 1024 }, deps)
    expect(result.bytes.equals(payload)).toBe(true)
    expect(result.contentType).toBe("text/plain")
    // contentLength is derived from the actually-received bytes, never the header.
    expect(result.contentLength).toBe(payload.byteLength)
  })

  it("maps a headObject failure to FILE_VERIFY_FAILED without leaking the key", async () => {
    const deps = makeDeps({
      head: async () => {
        throw new Error("S3 head failed for secret-internal-key")
      },
    })
    const err = await getObjectBytes("k/secret-internal-key", { maxBytes: 1024 }, deps).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(FileServiceError)
    expect((err as FileServiceError).code).toBe("FILE_VERIFY_FAILED")
    expect((err as FileServiceError).message).not.toContain("secret-internal-key")
  })
})
