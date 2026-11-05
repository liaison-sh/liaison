// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The brake that keeps one 429 from becoming hundreds. On 2026-09-22 a single
// per IP refusal on production grew into 245 GET /threads and 227 GET
// /threads/:id/messages inside three minutes, every one of them answered 429,
// because nothing on the client stopped the next read from going out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type ApiError, createApiClient } from "~/lib/api-client"

function rateLimited(retryAfter?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (retryAfter) headers["Retry-After"] = retryAfter
  return new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
    status: 429,
    headers,
  })
}

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("api client rate limit cool-down", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let onError: ReturnType<typeof vi.fn<(status: number, message: string) => void>>
  let client: ReturnType<typeof createApiClient>
  let now: number

  beforeEach(() => {
    now = 1_700_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    onError = vi.fn<(status: number, message: string) => void>()
    client = createApiClient({
      getAccessToken: () => "test-token",
      onUnauthorized: vi.fn(),
      onError,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("makes no further read request inside the Retry-After window", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("30"))
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({
      status: 429,
      retryAfter: 30,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 29_000
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })
    await expect(client.getEnvelope("/threads/t1/messages?limit=50")).rejects.toMatchObject({
      status: 429,
    })
    await expect(client.rawGet("/files/a.png")).rejects.toMatchObject({ status: 429 })
    // Not one further byte left the browser, and the single 429 raised exactly
    // one toast: the refusals are local.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("lets reads through again once the window has passed", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("5"))
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })

    now += 5_001
    fetchMock.mockResolvedValueOnce(ok({ threads: [] }))
    await expect(client.get("/threads?limit=50")).resolves.toEqual({ threads: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("holds reads for a default window when the server sent no Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited())
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })

    now += 4_000
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 2_000
    fetchMock.mockResolvedValueOnce(ok({ threads: [] }))
    await client.get("/threads?limit=50")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("caps an absurd Retry-After so the app is not frozen for an hour", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("3600"))
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })

    now += 60_001
    fetchMock.mockResolvedValueOnce(ok({ threads: [] }))
    await client.get("/threads?limit=50")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("reads the envelope's Retry-After too (the messages page is an envelope read)", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("12"))
    const error = await client
      .getEnvelope("/threads/t1/messages?limit=50")
      .then(() => null)
      .catch((e: ApiError) => e)
    expect(error?.retryAfter).toBe(12)
  })

  it("lets a person's own Try again through, since the cool-down is the reason it would do nothing", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("30"))
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })

    fetchMock.mockResolvedValueOnce(ok({ threads: [] }))
    await client.get("/threads?limit=50", { userInitiated: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // And the automatic reads are still held.
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("leaves a user's own write alone: the human is the brake on a click", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("30"))
    await expect(client.get("/threads?limit=50")).rejects.toMatchObject({ status: 429 })

    fetchMock.mockResolvedValueOnce(ok({ id: "m1" }))
    await expect(client.post("/threads/t1/messages", { content: "hi" })).resolves.toEqual({
      id: "m1",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
