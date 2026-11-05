// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLAIM_HEARTBEAT_MS,
  CLAIM_TTL_SECONDS,
  claimThreadForLocalTurns,
  installClaimId,
  type LocalClaimError,
  mintHolderKey,
} from "./local-claim"

const HOLDER = "holder-key-for-this-window"

const base = {
  serverAddress: "https://box.example/",
  accessToken: "tok",
  agentId: "a1",
  threadId: "t1",
  holderKey: HOLDER,
}

describe("claimThreadForLocalTurns", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("registers the claim on the agent's own claims route, naming the thread", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await claimThreadForLocalTurns({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://box.example/api/agents/a1/local-claims")
    expect(init.method).toBe("POST")
    // The window NAMES ITSELF: the claim belongs to the user and to this
    // window, and a takeover is never implicit.
    expect(JSON.parse(init.body)).toEqual({ threadId: "t1", holderKey: HOLDER, register: true })
    expect(init.headers.Authorization).toBe("Bearer tok")
  })

  // 2026-09-23: the registration, and only it, says it is one: the server lets
  // a registration from this install supersede its previous life, and a
  // heartbeat from a superseded instance must never take the lease back.
  it("marks the first call as a registration and no heartbeat as one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      noteLease: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies[0]).toEqual({ threadId: "t1", holderKey: HOLDER, register: true })
    expect(bodies[1]).toEqual({ threadId: "t1", holderKey: HOLDER })
  })

  // THE QUIT (2026-09-23): no page script runs when the app is quit, so the
  // shell keeps the lease's release URL and the token of the moment, and is
  // told to forget it when the window released it itself.
  it("tells the shell the lease it holds, with each fresh token, and forgets it on release", async () => {
    let token = "tok-a"
    const noted: Array<{ releaseUrl: string; token: string } | null> = []
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const claim = await claimThreadForLocalTurns({
      ...base,
      accessToken: () => token,
      heartbeatMs: 1_000,
      noteLease: (lease) => noted.push(lease),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const releaseUrl = `https://box.example/api/agents/a1/local-claims/t1?holderKey=${HOLDER}`
    expect(noted).toEqual([{ releaseUrl, token: "tok-a" }])
    token = "tok-b"
    await vi.advanceTimersByTimeAsync(1_000)
    expect(noted.at(-1)).toEqual({ releaseUrl, token: "tok-b" })
    await claim.release()
    expect(noted.at(-1)).toBeNull()
  })

  it("names this install in the key, as a digest and never the salt", async () => {
    const salt = "ab".repeat(32)
    const install = await installClaimId(salt)
    expect(install).toMatch(/^[0-9a-f]{32}$/)
    expect(salt).not.toContain(install as string)
    expect(await installClaimId(salt)).toBe(install)
    expect(mintHolderKey(install)).toMatch(new RegExp(`^d\\.${install}\\.[0-9a-f-]{36}$`))
    expect(await installClaimId("")).toBeNull()
    expect(mintHolderKey(null)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("refuses the session when the claim is refused, rather than running beside the server", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    await expect(
      claimThreadForLocalTurns({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/could not be claimed/)
  })

  it("heartbeats the claim so a session outliving the TTL keeps it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === "POST")).toBe(true)
  })

  // An access token lives fifteen minutes and a session does not: with the
  // token captured at claim time, every heartbeat from the sixteenth minute
  // was a 401 and the window declared a live session lost.
  it("presents the token current at each heartbeat and release, not the one at claim time", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    let token = "tok-at-claim"
    const claim = await claimThreadForLocalTurns({
      ...base,
      accessToken: () => token,
      heartbeatMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-at-claim")
    token = "tok-refreshed"
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer tok-refreshed")
    token = "tok-at-release"
    await claim.release()
    expect(fetchImpl.mock.calls[2][1].method).toBe("DELETE")
    expect(fetchImpl.mock.calls[2][1].headers.Authorization).toBe("Bearer tok-at-release")
  })

  it("gives a 401 heartbeat the TTL to turn its token over before calling the claim lost", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 401 }))
    const onLost = vi.fn()
    await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      onLost,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(onLost).not.toHaveBeenCalled()
    // A run of them past the TTL is a token that is not coming back.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it("releases the claim, once, and stops heartbeating it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const claim = await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await claim.release()
    await claim.release()
    const deletes = fetchImpl.mock.calls.filter(([, init]) => init.method === "DELETE")
    expect(deletes).toHaveLength(1)
    expect(deletes[0][0]).toBe(
      `https://box.example/api/agents/a1/local-claims/t1?holderKey=${HOLDER}`,
    )
    expect(deletes[0][1].keepalive).toBe(true)
    const before = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchImpl).toHaveBeenCalledTimes(before)
  })

  it("says so out loud when it takes a live claim over", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await claimThreadForLocalTurns({
      ...base,
      takeOver: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      threadId: "t1",
      holderKey: HOLDER,
      takeOver: true,
      register: true,
    })
  })

  it("heartbeats WITHOUT the takeover flag, so one renewal is not a standing claim", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await claimThreadForLocalTurns({
      ...base,
      takeOver: true,
      heartbeatMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).takeOver).toBeUndefined()
  })

  // A machine that has stopped holding the conversation has stopped being the
  // thing that answers it, and the window has to say so.
  it("says the conversation is lost after a run of failed heartbeats, once", async () => {
    const onLost = vi.fn()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValue(new Error("offline"))
    await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      onLost,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onLost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it("says it at once when another machine has taken the conversation over", async () => {
    const onLost = vi.fn()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 409 }))
    await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      onLost,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  // P6d-FX7 (SK-4): a release is awaited by `stop()`, which a start awaits in
  // turn, and every call here was a bare fetch with no signal. A server that
  // accepts the connection and never answers is not a rejection the catch
  // below can see: it is a promise that never settles, and it wedged the Start
  // button for the life of the window with the control looking untouched.
  it("bounds every call it makes, so a server that never answers is not forever", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const claim = await claimThreadForLocalTurns({
      ...base,
      heartbeatMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await claim.release()
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3)
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  // P6d-FX7 (SK-5): the 409 a window gets from its own lease, which the server
  // is the only half able to tell apart from another machine's.
  it("carries whether the lease that refused it is this window's own", async () => {
    const refusal = (details: Record<string, unknown>) =>
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "claim_held", details } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      )
    const mine = await claimThreadForLocalTurns({
      ...base,
      fetchImpl: refusal({ heldByYou: true }) as unknown as typeof fetch,
    }).catch((error: unknown) => error)
    expect((mine as LocalClaimError).heldByThisWindow).toBe(true)
    const theirs = await claimThreadForLocalTurns({
      ...base,
      fetchImpl: refusal({ heldByYou: false }) as unknown as typeof fetch,
    }).catch((error: unknown) => error)
    expect((theirs as LocalClaimError).heldByThisWindow).toBe(false)
    // A refusal with no body at all says nothing about whose lease it is, and
    // the safe direction is the one that does not tell a user there is no
    // problem to act on.
    const silent = await claimThreadForLocalTurns({
      ...base,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 409 })) as unknown as typeof fetch,
    }).catch((error: unknown) => error)
    expect((silent as LocalClaimError).heldByThisWindow).toBe(false)
  })

  it("renews well inside the TTL, so two lost heartbeats do not lapse the claim", () => {
    expect(CLAIM_HEARTBEAT_MS * 3).toBeLessThanOrEqual(CLAIM_TTL_SECONDS * 1000)
  })
})
