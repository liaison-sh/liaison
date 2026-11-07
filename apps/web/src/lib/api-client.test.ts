// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, createApiClient } from "~/lib/api-client"
import { AuthRefreshError } from "~/lib/auth-refresh"
import { oldestPendingAt, restartSignalAt, ServerPauseTestAccess } from "~/lib/server-pause"

describe("createApiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let client: ReturnType<typeof createApiClient>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    client = createApiClient({
      getAccessToken: () => "test-token",
      onUnauthorized: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Under a native shell the page has no API at its own origin (S15): the
  // shell injects the address the user entered, and the client must send the
  // request, and the bearer token, THERE.
  it("sends requests to the injected server address when the shell set one", async () => {
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = "https://acme.example.com"
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      await client.get("/users/me")
      expect(fetchMock.mock.calls[0][0]).toBe("https://acme.example.com/api/users/me")
    } finally {
      ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = undefined
    }
  })

  it("unwraps success envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: "1", name: "Alex" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const result = await client.get("/users/me")
    expect(result).toEqual({ id: "1", name: "Alex" })
  })

  it("unwraps a null data envelope to null, not the envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const result = await client.post("/apps/invoicing/tools/documents_get", { id: "x" })
    expect(result).toBeNull()
  })

  it("returns raw JSON when response has no data envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const result = await client.get("/health")
    expect(result).toEqual({ ok: true })
  })

  it("supports 204 no-content responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(client.delete("/notifications/1")).resolves.toBeUndefined()
  })

  it("returns undefined for empty JSON success bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(client.get("/empty-json")).resolves.toBeUndefined()
  })

  it("returns undefined for zero-length success bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "Content-Length": "0" },
      }),
    )
    await expect(client.get("/empty")).resolves.toBeUndefined()
  })

  it("returns text for non-JSON text responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("plain text ok", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    )
    await expect(client.get("/status.txt")).resolves.toBe("plain text ok")
  })

  it("returns a blob for binary success responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    )

    const result = await client.get<Blob>("/export")

    // Vitest jsdom may return a Blob from a different realm, so instanceof can fail.
    // Check structurally instead.
    expect(typeof result.arrayBuffer).toBe("function")
    expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual([1, 2, 3])
  })

  it("attaches Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await client.get("/users/me")
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    )
  })

  it("JSON-serializes an object body and sets application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await client.post("/users/me", { name: "Ada" })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ name: "Ada" }))
  })

  it("sends a raw Blob body without JSON-stringifying or forcing application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { avatarUrl: "/api/avatars/abc" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    const result = await client.post<{ avatarUrl: string }>("/users/me/avatar", blob)

    expect(result).toEqual({ avatarUrl: "/api/avatars/abc" })
    const [, init] = fetchMock.mock.calls[0]
    // The blob passes through untouched — fetch derives Content-Type from it.
    expect(init.body).toBe(blob)
    expect(init.headers["Content-Type"]).toBeUndefined()
    // Auth is still attached.
    expect(init.headers.Authorization).toBe("Bearer test-token")
  })

  it("sends FormData without forcing a Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array([9])], { type: "image/png" }), "a.png")
    await client.post("/users/me/avatar", form)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBe(form)
    expect(init.headers["Content-Type"]).toBeUndefined()
  })

  it.each([
    ["absolute https URL", "https://attacker.example/steal"],
    ["absolute http URL", "http://attacker.example/steal"],
    ["protocol-relative URL", "//attacker.example/steal"],
    ["non-http scheme", "javascript:alert(1)"],
    ["data URI", "data:text/html,evil"],
    ["backslash-bypass", "/\\attacker.example/steal"],
    ["leading-space bypass", " //attacker.example/steal"],
    ["relative (no leading slash)", "users/me"],
  ])(
    "REJECTS a non-kernel-relative path (%s) before reading the token / attaching Authorization",
    async (_label, badPath) => {
      const getAccessToken = vi.fn(() => "secret-token")
      const c = createApiClient({ getAccessToken, onUnauthorized: vi.fn() })
      await expect(c.get(badPath)).rejects.toThrow(/non-kernel-relative/i)
      // fetch must never be reached (so no header carrying the token is built)…
      expect(fetchMock).not.toHaveBeenCalled()
      // …and the token must never even be read.
      expect(getAccessToken).not.toHaveBeenCalled()
    },
  )

  it("still dispatches a legit kernel-relative path with Authorization", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await client.get("/users/me")
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    )
  })

  it("threads AbortSignal through to fetch", async () => {
    const ac = new AbortController()
    let abortedInFlight: boolean | undefined
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      // A read carries its own deadline, so fetch gets a signal joining the
      // caller's and the timeout: the caller's abort still reaches it.
      ac.abort()
      abortedInFlight = init.signal?.aborted
      return Promise.resolve(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    })
    // The caller's abort ends the read as a real fetch would, body included.
    await expect(client.get("/with-signal", { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(abortedInFlight).toBe(true)
  })

  it("threads a mutation's AbortSignal through to fetch untouched", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const ac = new AbortController()
    await client.post("/with-signal", {}, { signal: ac.signal })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/with-signal",
      expect.objectContaining({ signal: ac.signal }),
    )
  })

  it("propagates AbortError without wrapping in ApiError", async () => {
    expect.assertions(2)
    const onError = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "t",
      onUnauthorized: vi.fn(),
      onError,
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    )
    try {
      const ac = new AbortController()
      ac.abort()
      await c.get("/cancelled", { signal: ac.signal })
    } catch (e) {
      expect((e as DOMException).name).toBe("AbortError")
      expect(onError).not.toHaveBeenCalled()
    }
  })

  it("throws ApiError on error response", async () => {
    expect.assertions(4)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Not found", code: "NOT_FOUND" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    )
    try {
      await client.get("/missing")
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).message).toBe("Not found")
      expect((e as ApiError).code).toBe("NOT_FOUND")
      expect((e as ApiError).status).toBe(404)
    }
  })

  // A validation refusal names each problem at its path (`error.issues`), and
  // the screen that sent the document shows them there: the client must carry
  // them on the error instead of dropping everything but the message.
  it("carries a validation error's issues on the ApiError details", async () => {
    expect.assertions(3)
    const issues = [{ path: "operations[0].name", message: "must match ^[a-z]" }]
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "invalid_adapter", issues } }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    )
    try {
      await client.put("/api-connector/adapters/crm", { id: "x" })
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe("invalid_adapter")
      expect((e as ApiError).details?.issues).toEqual(issues)
    }
  })

  it("retries on 401 after token refresh (H3)", async () => {
    const onUnauthorized = vi.fn()
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const c = createApiClient({
      getAccessToken: () => "refreshed-token",
      onUnauthorized,
      ensureFreshToken,
    })
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    const result = await c.get("/protected")
    expect(ensureFreshToken).toHaveBeenCalled()
    expect(result).toEqual({ ok: true })
  })

  // A 401 on a token that is not near expiry means the server rejected its
  // CLAIMS (an admin changed this user's roles, a personal MCP connection granted
  // its owner a scope): only a forced refresh mints a token the retry can pass.
  // An unforced refresh is a no-op on such a token, so the retry 401'd again and
  // the user was signed out mid-action.
  it.each([
    ["get", (c: ReturnType<typeof createApiClient>) => c.get("/protected")],
    ["post", (c: ReturnType<typeof createApiClient>) => c.post("/protected", { a: 1 })],
    ["getEnvelope", (c: ReturnType<typeof createApiClient>) => c.getEnvelope("/protected")],
    ["rawPost", (c: ReturnType<typeof createApiClient>) => c.rawPost("/protected", { a: 1 })],
  ])("a 401 forces the token refresh before the retry (%s)", async (_name, call) => {
    const onUnauthorized = vi.fn()
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized, ensureFreshToken })
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    await call(c)
    expect(ensureFreshToken).toHaveBeenCalledWith({ force: true, rejected: "t" })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("calls onUnauthorized when refresh also fails", async () => {
    const onUnauthorized = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "expired-token",
      onUnauthorized,
      ensureFreshToken: vi.fn().mockRejectedValue(new Error("refresh failed")),
    })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(c.get("/protected")).rejects.toThrow(ApiError)
    expect(onUnauthorized).toHaveBeenCalled()
  })

  it("keeps the session when refresh fails transiently", async () => {
    const onUnauthorized = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "expired-token",
      onUnauthorized,
      ensureFreshToken: vi
        .fn()
        .mockRejectedValue(new AuthRefreshError("transient", "network down")),
    })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await expect(c.get("/protected")).rejects.toMatchObject({ status: 0 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  // A refresh succeeded, then the resend of the request that 401'd never came
  // back: its caller aborted it while the refresh ran, or a flaky network
  // dropped it. That is not a refused session, and it used to sign the user out
  // a moment after the refresh succeeded.
  describe.each([
    ["get", (c: ReturnType<typeof createApiClient>) => c.get("/protected")],
    ["getEnvelope", (c: ReturnType<typeof createApiClient>) => c.getEnvelope("/protected")],
    ["rawGet", (c: ReturnType<typeof createApiClient>) => c.rawGet("/protected")],
  ])("a resend that fails after a successful refresh (%s)", (_name, call) => {
    const unauthorized = () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })

    it("keeps the session when the resend is aborted", async () => {
      const onUnauthorized = vi.fn()
      const c = createApiClient({
        getAccessToken: () => "token",
        onUnauthorized,
        ensureFreshToken: vi.fn().mockResolvedValue(undefined),
      })
      fetchMock
        .mockResolvedValueOnce(unauthorized())
        .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
      await expect(call(c)).rejects.toMatchObject({ name: "AbortError" })
      expect(onUnauthorized).not.toHaveBeenCalled()
    })

    it("keeps the session when the resend hits a network error", async () => {
      vi.useFakeTimers()
      const onUnauthorized = vi.fn()
      const c = createApiClient({
        getAccessToken: () => "token",
        onUnauthorized,
        ensureFreshToken: vi.fn().mockResolvedValue(undefined),
      })
      // The network stays down: a read's retries (S26) fail the same way.
      fetchMock
        .mockResolvedValueOnce(unauthorized())
        .mockRejectedValue(new TypeError("Failed to fetch"))
      const settled = call(c).catch((e) => e)
      await vi.advanceTimersByTimeAsync(3_000)
      vi.useRealTimers()
      expect(await settled).toMatchObject({ status: 0, message: "Network error" })
      expect(onUnauthorized).not.toHaveBeenCalled()
    })

    // Only the refresh's verdict ends the session: it has just said the session
    // is good, so a 401 on the resend fails this call and signs nobody out.
    it("fails the call but keeps the session when the new token is refused too", async () => {
      const onUnauthorized = vi.fn()
      const c = createApiClient({
        getAccessToken: () => "token",
        onUnauthorized,
        ensureFreshToken: vi.fn().mockResolvedValue(undefined),
      })
      fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized())
      await expect(call(c)).rejects.toMatchObject({ status: 401 })
      expect(onUnauthorized).not.toHaveBeenCalled()
    })
  })

  it("parses Retry-After on 429", async () => {
    expect.assertions(1)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Too many attempts" } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "15",
        },
      }),
    )
    try {
      await client.post("/auth/login", { email: "a", password: "b" })
    } catch (e) {
      expect((e as ApiError).retryAfter).toBe(15)
    }
  })

  it("calls onUnauthorized on 401 without ensureFreshToken", async () => {
    const onUnauthorized = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "token",
      onUnauthorized,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(c.get("/protected")).rejects.toThrow(ApiError)
    expect(onUnauthorized).toHaveBeenCalled()
  })

  it("sends JSON body with POST", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await client.post("/auth/login", { email: "a@b.com", password: "pass" })
    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.method).toBe("POST")
    expect(JSON.parse(opts.body)).toEqual({ email: "a@b.com", password: "pass" })
  })

  // Binary reads (inline image previews, downloads) go through rawGet, and a
  // preview that the UI already degrades from must not pop the global error
  // toast. rawResponse/getEnvelope honour `suppressGlobalError` exactly as the
  // JSON `request` path does.
  it("skips the global error toast on rawGet when the caller suppresses it", async () => {
    const onError = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "token",
      onUnauthorized: vi.fn(),
      onError,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Object not available" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(
      c.rawGet("/files/abc/inline?variant=thumb", { suppressGlobalError: true }),
    ).rejects.toThrow(ApiError)
    expect(onError).not.toHaveBeenCalled()
  })

  it("still raises the global error toast on rawGet when nothing suppresses it", async () => {
    const onError = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "token",
      onUnauthorized: vi.fn(),
      onError,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Object not available" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(c.rawGet("/files/abc/inline")).rejects.toThrow(ApiError)
    expect(onError).toHaveBeenCalledWith(502, "Something went wrong. Try again.")
  })

  it("a 500 carrying a server reference names it on the error and in the global toast", async () => {
    const onError = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "token",
      onUnauthorized: vi.fn(),
      onError,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Internal server error", code: "INTERNAL_ERROR", ref: "3f2a9c1b" },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    )
    const err = await c.post("/scope-requests/x/decide", {}).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).ref).toBe("3f2a9c1b")
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[1]).toContain("3f2a9c1b")
  })

  it("skips the global error toast on getEnvelope when the caller suppresses it", async () => {
    const onError = vi.fn()
    const c = createApiClient({
      getAccessToken: () => "token",
      onUnauthorized: vi.fn(),
      onError,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(c.getEnvelope("/things", { suppressGlobalError: true })).rejects.toThrow(ApiError)
    expect(onError).not.toHaveBeenCalled()
  })

  it("throws ApiError with network message on fetch failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(client.post("/anything")).rejects.toThrow(ApiError)
  })
  describe("reads across a network blip (S26)", () => {
    const ok = () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    /** A request the network swallowed: it settles only when its signal aborts. */
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("a GET that never answers rejects with a timeout after 20 s", async () => {
      vi.useFakeTimers()
      fetchMock.mockImplementation(hang)
      const onError = vi.fn()
      const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
      const settled = vi.fn()
      const p = c.get("/slow").then(settled, (e) => {
        settled()
        return e
      })
      await vi.advanceTimersByTimeAsync(19_900)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      const err = await p
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 0, code: "timeout" })
      expect(onError).toHaveBeenCalledTimes(1)
    })

    it("a GET whose body stalls after the headers still times out", async () => {
      vi.useFakeTimers()
      // The headers came back, then the network went: the body never ends.
      fetchMock.mockImplementation(
        async () =>
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      )
      const settled = vi.fn()
      const p = client.get("/stalled").then(settled, (e) => {
        settled()
        return e
      })
      const q = client.getEnvelope("/stalled").catch((e) => e)
      await vi.advanceTimersByTimeAsync(20_100)
      expect(settled).toHaveBeenCalledTimes(1)
      expect(await p).toMatchObject({ status: 0, code: "timeout" })
      expect(await q).toMatchObject({ status: 0, code: "timeout" })
    })

    it("a GET whose body arrives is parsed as before, an empty 204 included", async () => {
      fetchMock
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
      await expect(client.get("/fine")).resolves.toEqual({ ok: true })
      await expect(client.get("/empty")).resolves.toBeUndefined()
    })

    it("getEnvelope times out the same way", async () => {
      vi.useFakeTimers()
      fetchMock.mockImplementation(hang)
      const p = client.getEnvelope("/slow").catch((e) => e)
      await vi.advanceTimersByTimeAsync(20_100)
      expect(await p).toMatchObject({ status: 0, code: "timeout" })
    })

    it("a GET retries a network error and resolves", async () => {
      vi.useFakeTimers()
      const onError = vi.fn()
      const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
      fetchMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(ok())
      const p = c.get("/flaky")
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(p).resolves.toEqual({ ok: true })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      // A blip the retry absorbed is no one's business.
      expect(onError).not.toHaveBeenCalled()
    })

    it("a GET that keeps failing gives up after two retries with one toast", async () => {
      vi.useFakeTimers()
      const onError = vi.fn()
      const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
      const p = c.get("/down").catch((e) => e)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await p).toMatchObject({ status: 0, message: "Network error" })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(onError).toHaveBeenCalledTimes(1)
    })

    it("a POST is never retried by the client", async () => {
      vi.useFakeTimers()
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(ok())
      const p = client.post("/threads/t/messages", { content: "hi" }).catch((e) => e)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await p).toMatchObject({ status: 0 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("no connection toast while reconnecting", async () => {
      vi.useFakeTimers()
      const onError = vi.fn()
      let reconnecting = true
      const c = createApiClient({
        getAccessToken: () => "t",
        onUnauthorized: vi.fn(),
        onError,
        isReconnecting: () => reconnecting,
      })
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
      const p = c.get("/down").catch((e) => e)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await p).toMatchObject({ status: 0 })
      expect(onError).not.toHaveBeenCalled()
      reconnecting = false
      const q = c.get("/down").catch((e) => e)
      await vi.advanceTimersByTimeAsync(3_000)
      await q
      expect(onError).toHaveBeenCalledTimes(1)
    })

    it("a caller abort is not retried", async () => {
      vi.useFakeTimers()
      const ac = new AbortController()
      fetchMock.mockImplementation(hang)
      const p = client.get("/slow", { signal: ac.signal }).then(
        () => null,
        (e: Error) => e,
      )
      await vi.advanceTimersByTimeAsync(1_000)
      ac.abort()
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await p)?.name).toBe("AbortError")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("a 401 then a refresh still goes through the read's retry", async () => {
      vi.useFakeTimers()
      const onUnauthorized = vi.fn()
      const c = createApiClient({
        getAccessToken: () => "t",
        onUnauthorized,
        ensureFreshToken: vi.fn().mockResolvedValue(undefined),
      })
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(ok())
      const p = c.get("/protected")
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(p).resolves.toEqual({ ok: true })
      expect(onUnauthorized).not.toHaveBeenCalled()
    })
  })
})

describe("createApiClient: the server pause signals (lib/server-pause.ts)", () => {
  afterEach(() => {
    ServerPauseTestAccess.reset()
    vi.unstubAllGlobals()
  })

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })

  it("a 503 RESTARTING marks the server restarting and raises no fault toast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(503, { error: { message: "The server is restarting.", code: "RESTARTING" } }),
      ),
    )
    const onError = vi.fn()
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
    await expect(c.post("/agent/chat", {})).rejects.toMatchObject({ status: 503 })
    expect(restartSignalAt()).not.toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it("a 503 org_moving waits out the move: the same request goes again and succeeds, no toast", async () => {
    const moving = () =>
      new Response(JSON.stringify({ error: { message: "moving", code: "org_moving" } }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(moving())
      .mockResolvedValueOnce(json(201, { data: { id: "m1" } }))
    vi.stubGlobal("fetch", fetchMock)
    const onError = vi.fn()
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
    await expect(c.post("/threads/t/messages", { content: "hi" })).resolves.toMatchObject({
      id: "m1",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body)
    expect(onError).not.toHaveBeenCalled()
  })

  it("the default wait outlasts a whole refusal: a 30 s drain, a 20 s gap", async () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      const fetchMock = vi.fn(async () =>
        Date.now() - start < 50_000
          ? new Response(JSON.stringify({ error: { message: "moving", code: "org_moving" } }), {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "2" },
            })
          : json(201, { data: { id: "m1" } }),
      )
      vi.stubGlobal("fetch", fetchMock)
      const onError = vi.fn()
      const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
      const sent = c.post("/threads/t/messages", { content: "hi" })
      await vi.advanceTimersByTimeAsync(55_000)
      await expect(sent).resolves.toMatchObject({ id: "m1" })
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaving during the wait is the caller's own cancel, not a fault", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "moving", code: "org_moving" } }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "5" },
          }),
      ),
    )
    const onError = vi.fn()
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
    const controller = new AbortController()
    const sent = c.post("/x", {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(sent).rejects.toMatchObject({ name: "AbortError" })
    expect(onError).not.toHaveBeenCalled()
  })

  it("a move that outlasts the wait is the caller's answer", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "moving", code: "org_moving" } }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "1" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const c = createApiClient({
      getAccessToken: () => "t",
      onUnauthorized: vi.fn(),
      onError: vi.fn(),
      orgMoveWaitMs: 1500,
    })
    await expect(c.post("/x", {})).rejects.toMatchObject({ status: 503, code: "org_moving" })
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("any other 503 is a fault, not an update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(503, { error: { message: "Down" } })),
    )
    const onError = vi.fn()
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn(), onError })
    await expect(c.post("/x", {})).rejects.toMatchObject({ status: 503 })
    expect(restartSignalAt()).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("an answer after the restart says the server is back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(503, { error: { message: "r", code: "RESTARTING" } }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn() })
    await expect(c.post("/x", {})).rejects.toMatchObject({ status: 503 })
    expect(restartSignalAt()).not.toBeNull()
    await c.post("/x", {})
    expect(restartSignalAt()).toBeNull()
  })

  it("a request in flight is tracked until it settles", async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    )
    const c = createApiClient({ getAccessToken: () => "t", onUnauthorized: vi.fn() })
    const p = c.post("/x", {})
    expect(oldestPendingAt()).not.toBeNull()
    answer(json(200, { data: {} }))
    await p
    expect(oldestPendingAt()).toBeNull()
  })
})
