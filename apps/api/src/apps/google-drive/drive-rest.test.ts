// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * drive-rest.ts unit tests — Drive REST v3 IO. fetch() is stubbed; the test
 * asserts URL construction, auth header propagation, error mapping, and the
 * IT-5 size cap.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { DriveHttpError, EXPORT_SIZE_CAP_BYTES, makeDriveFetchers } from "./drive-rest"
import { PERSONAL_DRIVE_SCOPE } from "./drive-scope"

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
})

// Drive IO is routed through the SSRF-safe outbound helper, so we inject the
// stub via its test seam (not globalThis.fetch — the helper uses undici).
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  OutboundFetchTestAccess.setFetch((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as never)
  return calls
}

describe("drive-rest", () => {
  it("fetchDrive issues GET with Authorization Bearer + supportsAllDrives params", async () => {
    const calls = stubFetch(
      async () =>
        new Response(JSON.stringify({ files: [], incompleteSearch: false }), { status: 200 }),
    )
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk-123",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await fetchers.fetchDrive({
      q: "name contains 'plan'",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
      pageSize: 25,
    })
    expect(calls).toHaveLength(1)
    const url = calls[0]!.url
    expect(url).toContain("https://www.googleapis.com/drive/v3/files?")
    expect(url).toContain("supportsAllDrives=true")
    expect(url).toContain("includeItemsFromAllDrives=true")
    expect(url).toContain("corpora=allDrives")
    expect(url).toContain("fields=") // default LIST_FIELDS gets injected
    const headers = calls[0]!.init?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBe("Bearer tk-123")
  })

  it("401 maps to DriveHttpError(401, OAUTH_REVOKED)", async () => {
    stubFetch(async () => new Response("", { status: 401 }))
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await expect(fetchers.fetchDrive({ q: "x" })).rejects.toMatchObject({
      status: 401,
      code: "OAUTH_REVOKED",
    })
  })

  it("429 maps to DriveHttpError(429, RATE_LIMITED)", async () => {
    stubFetch(async () => new Response("", { status: 429 }))
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await expect(fetchers.fetchDrive({ q: "x" })).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    })
  })

  it("captures Google's error reason + message from the response body into DriveHttpError", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              errors: [{ reason: "storageQuotaExceeded", message: "Quota exceeded." }],
              message: "outer message",
            },
          }),
          { status: 403 },
        ),
    )
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await expect(fetchers.fetchDrive({ q: "x" })).rejects.toMatchObject({
      status: 403,
      reason: "storageQuotaExceeded",
      message: "Drive HTTP 403: Quota exceeded.",
    })
  })

  it("still throws a status-only DriveHttpError on an unparseable error body", async () => {
    stubFetch(async () => new Response("<html>nope</html>", { status: 500 }))
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await expect(fetchers.fetchDrive({ q: "x" })).rejects.toMatchObject({
      status: 500,
      message: "Drive HTTP 500",
    })
  })

  it("getMetadata fetches /files/:id with fields", async () => {
    const calls = stubFetch(
      async () =>
        new Response(JSON.stringify({ id: "f1", name: "F", mimeType: "application/pdf" }), {
          status: 200,
        }),
    )
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    const meta = await fetchers.getMetadata({ id: "f1" })
    expect(meta.id).toBe("f1")
    expect(calls[0]!.url).toContain("/files/f1?")
    expect(calls[0]!.url).toContain("fields=")
  })

  it("download passes resourceKey via X-Goog-Drive-Resource-Keys (G11)", async () => {
    const calls = stubFetch(async () => new Response("body content", { status: 200 }))
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await fetchers.download({ id: "f1", resourceKey: "rkey-abc" })
    const headers = calls[0]!.init?.headers as Record<string, string> | undefined
    expect(headers?.["X-Goog-Drive-Resource-Keys"]).toBe("f1/rkey-abc")
    expect(calls[0]!.url).toContain("alt=media")
  })

  it("exportGoogleDoc enforces 10 MB stream cap (IT-5)", async () => {
    const oversizeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(2 * 1024 * 1024) // 2 MB
        for (let i = 0; i < 6; i++) controller.enqueue(chunk) // 12 MB > 10 MB cap
        controller.close()
      },
    })
    stubFetch(async () => new Response(oversizeStream, { status: 200 }))
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await expect(
      fetchers.exportGoogleDoc({ id: "f1", mimeType: "text/plain" }),
    ).rejects.toBeInstanceOf(DriveHttpError)
    expect(EXPORT_SIZE_CAP_BYTES).toBe(10 * 1024 * 1024)
  })

  it("download below cap returns the text body", async () => {
    stubFetch(async () => new Response("hello drive", { status: 200 }))
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    const r = await fetchers.download({ id: "f1" })
    expect(r.text).toBe("hello drive")
  })

  it("downloadBytes returns raw bytes and content type", async () => {
    stubFetch(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    )
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    const out = await fetchers.downloadBytes({ id: "drive-file-1" })
    expect(out.bytes).toBeInstanceOf(Buffer)
    expect(out.bytes.length).toBe(4)
    expect(out.mimeType).toBe("application/pdf")
  })

  it("downloadBytes rejects a file exceeding the size cap", async () => {
    stubFetch(
      async () =>
        new Response(new Uint8Array(60 * 1024 * 1024), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    )
    const fetchers = makeDriveFetchers(async () => ({
      token: "tk",
      readScope: PERSONAL_DRIVE_SCOPE,
    }))
    await expect(fetchers.downloadBytes({ id: "x" })).rejects.toThrow(/cap/i)
  })
})
