// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every state the demo signup can end in is a state a visitor can reach, so
// every one of them is here: the workspace that is still filling in, the one
// that finished, the one that only half finished, the refusals (429, 503, 409,
// 404) and the workspace whose time is up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"

const post = vi.fn()
const get = vi.fn()
const setTokens = vi.fn()

vi.mock("~/lib/api-client", () => ({
  anonApiClient: {
    post: (...args: unknown[]) => post(...args),
    get: (...args: unknown[]) => get(...args),
  },
}))
vi.mock("~/modules/auth/auth-store", () => ({
  setTokens: (...args: unknown[]) => setTokens(...args),
}))

const {
  _hydrateDemoWorkspace,
  _resetDemoStore,
  createDemoWorkspace,
  ensureDemoDoorSettings,
  demoByokSaved,
  demoWorkspace,
  forgetDemoWorkspace,
  isDemoWorkspaceExpired,
  markDemoByokSaved,
  readDemoStatus,
  stopPolling,
  syncDemoWorkspace,
  watchDemoWorkspace,
} = await import("~/modules/demo/demo-store")

const CREATED = {
  orgId: "11111111-1111-4111-8111-111111111111",
  orgSlug: "demo-acme-abc123",
  userId: "22222222-2222-4222-8222-222222222222",
  state: "provisioning" as const,
  statusUrl: "/api/demo/orgs/11111111-1111-4111-8111-111111111111/status",
  expiresAt: "2030-01-01T00:00:00.000Z",
  accessToken: "access.token.value",
  refreshToken: "refresh.token.value",
}

/** The server's own bound on a signup key (apps/api/src/modules/demo/routes.ts). */
const KEY_SHAPE = /^[A-Za-z0-9_-]{32,128}$/

function sent(call: number): { signupKey: string; turnstileToken: string } {
  const body = post.mock.calls[call]?.[1] as
    | { signupKey: string; turnstileToken: string }
    | undefined
  return body ?? { signupKey: "", turnstileToken: "" }
}

/** A token source that hands out a different token each time, as Turnstile does. */
function freshTokens(): () => Promise<string> {
  let n = 0
  return async () => {
    n += 1
    return `token-${n}`
  }
}

const START = { name: "Acme", email: "v@example.com", needs: ["support" as const] }

beforeEach(() => {
  vi.useFakeTimers()
  post.mockReset()
  get.mockReset()
  setTokens.mockReset()
  _resetDemoStore()
})

afterEach(() => {
  stopPolling()
  _resetDemoStore()
  vi.useRealTimers()
})

describe("creating a visitor workspace", () => {
  it("signs the visitor in on the response, before the world is seeded", async () => {
    post.mockResolvedValue(CREATED)
    const ws = await createDemoWorkspace({
      name: "  Acme  ",
      email: " Visitor@Example.com ",
      needs: ["support"],
      turnstileToken: async () => "t",
    })

    expect(post).toHaveBeenCalledWith(
      "/demo/orgs",
      {
        name: "Acme",
        email: "Visitor@Example.com",
        needs: ["support"],
        turnstileToken: "t",
        signupKey: expect.stringMatching(KEY_SHAPE),
      },
      expect.objectContaining({ suppressGlobalError: true }),
    )
    // THE POINT: the session exists while the state is still `provisioning`.
    expect(ws.state).toBe("provisioning")
    expect(setTokens).toHaveBeenCalledWith("access.token.value", "refresh.token.value")
    expect(demoWorkspace()?.orgId).toBe(CREATED.orgId)
  })

  it("says Turnstile failed, and posts nothing, when the browser got no token", async () => {
    post.mockResolvedValue(CREATED)
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: { demo: { turnstileSiteKey: "site-key" } } }),
    )
    await ensureDemoDoorSettings()
    vi.unstubAllGlobals()
    await expect(
      createDemoWorkspace({
        name: "A",
        email: "v@example.com",
        needs: ["support"],
        turnstileToken: async () => "",
      }),
    ).rejects.toMatchObject({ kind: "turnstile" })
    expect(post).not.toHaveBeenCalled()
  })

  it("survives a reload, so the banner and the expiry are not lost", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    expect(JSON.parse(localStorage.getItem("liaison:demo-workspace") ?? "{}").orgId).toBe(
      CREATED.orgId,
    )
  })

  it("reports the signup budget as a wait, not as a status code", async () => {
    post.mockRejectedValue(new ApiError("Too many", 429, undefined, 900))
    await expect(
      createDemoWorkspace({
        name: "A",
        email: "v@example.com",
        needs: ["support"],
        turnstileToken: async () => "t",
      }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfter: 900,
    })
    expect(setTokens).not.toHaveBeenCalled()
    expect(demoWorkspace()).toBeNull()
  })

  it("reports a concurrent duplicate as work already in progress", async () => {
    post.mockRejectedValue(new ApiError("In progress", 503, undefined, 2))
    await expect(
      createDemoWorkspace({
        name: "A",
        email: "v@example.com",
        needs: ["support"],
        turnstileToken: async () => "t",
      }),
    ).rejects.toMatchObject({
      kind: "in_progress",
      retryAfter: 2,
    })
  })

  it("reports a claim that outlived its org as gone", async () => {
    post.mockRejectedValue(new ApiError("Expired", 409))
    await expect(
      createDemoWorkspace({
        name: "A",
        email: "v@example.com",
        needs: ["support"],
        turnstileToken: async () => "t",
      }),
    ).rejects.toMatchObject({
      kind: "gone",
    })
  })

  it("reports a server that is not a demo as unavailable", async () => {
    post.mockRejectedValue(new ApiError("Not found", 404))
    await expect(
      createDemoWorkspace({
        name: "A",
        email: "v@example.com",
        needs: ["support"],
        turnstileToken: async () => "t",
      }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    })
  })

  it("reports anything else as a plain failure rather than leaking it", async () => {
    post.mockRejectedValue(new TypeError("network"))
    await expect(
      createDemoWorkspace({
        name: "A",
        email: "v@example.com",
        needs: ["support"],
        turnstileToken: async () => "t",
      }),
    ).rejects.toMatchObject({
      kind: "failed",
    })
  })
})

// A LOST RESPONSE (seen live on the demo box): the signup made a workspace whose
// response never arrived, the visitor clicked again and got a second one, and
// the first sat there with nobody able to enter it. One start carries one
// random key, and every retry of that start resends it with a fresh Turnstile
// token, so the server hands back the workspace the lost response held.
describe("a signup whose response does not arrive", () => {
  it("retries a request that hangs past its timeout with the same key, and lands in the workspace", async () => {
    // The first attempt never answers until this client gives up on it.
    post.mockImplementationOnce(
      (_path: string, _body: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          )
        }),
    )
    post.mockResolvedValueOnce(CREATED)
    const pending = createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    await vi.advanceTimersByTimeAsync(60_000)
    const ws = await pending
    expect(post).toHaveBeenCalledTimes(2)
    expect(sent(0).signupKey).toMatch(KEY_SHAPE)
    expect(sent(1).signupKey).toBe(sent(0).signupKey)
    // Turnstile tokens are single-use: every attempt asks for its own.
    expect(sent(1).turnstileToken).not.toBe(sent(0).turnstileToken)
    expect(ws.orgId).toBe(CREATED.orgId)
    expect(demoWorkspace()?.orgId).toBe(CREATED.orgId)
    expect(setTokens).toHaveBeenCalledWith("access.token.value", "refresh.token.value")
  })

  it("retries a 504 and a dropped connection with the same key", async () => {
    post.mockRejectedValueOnce(new ApiError("Gateway timeout", 504))
    post.mockRejectedValueOnce(new ApiError("Network error", 0))
    post.mockResolvedValueOnce(CREATED)
    const pending = createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await pending).orgId).toBe(CREATED.orgId)
    expect(new Set([0, 1, 2].map((i) => sent(i).signupKey)).size).toBe(1)
  })

  it("waits while the server says that start is still being made", async () => {
    post.mockResolvedValueOnce({ state: "creating" })
    post.mockResolvedValueOnce({ state: "creating" })
    post.mockResolvedValueOnce(CREATED)
    const pending = createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await pending).orgId).toBe(CREATED.orgId)
    expect(post).toHaveBeenCalledTimes(3)
    expect(new Set([0, 1, 2].map((i) => sent(i).signupKey)).size).toBe(1)
    // Only the real answer signs the visitor in.
    expect(setTokens).toHaveBeenCalledTimes(1)
  })

  it("says a busy server's 'being prepared' to the screen and waits the server's own retry time", async () => {
    post.mockResolvedValueOnce({ state: "creating", retryAfter: 5 })
    post.mockResolvedValueOnce(CREATED)
    const onPreparing = vi.fn()
    const pending = createDemoWorkspace({ ...START, turnstileToken: freshTokens(), onPreparing })
    await vi.advanceTimersByTimeAsync(0)
    expect(onPreparing).toHaveBeenCalledTimes(1)
    // Not before the five seconds the server asked for.
    await vi.advanceTimersByTimeAsync(4_500)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await pending).orgId).toBe(CREATED.orgId)
    expect(post).toHaveBeenCalledTimes(2)
    expect(sent(0).signupKey).toBe(sent(1).signupKey)
  })

  it("keeps the key across a failed click, and starts a new one after a success", async () => {
    post.mockRejectedValueOnce(new ApiError("Busy", 503, undefined, 2))
    await expect(
      createDemoWorkspace({ ...START, turnstileToken: freshTokens() }),
    ).rejects.toMatchObject({ kind: "in_progress" })
    post.mockResolvedValueOnce(CREATED)
    await createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    expect(sent(1).signupKey).toBe(sent(0).signupKey)
    post.mockResolvedValueOnce(CREATED)
    await createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    expect(sent(2).signupKey).not.toBe(sent(0).signupKey)
  })

  it("starts with a new key after the server says the old one's workspace is gone", async () => {
    post.mockRejectedValueOnce(new ApiError("Gone", 409))
    await expect(
      createDemoWorkspace({ ...START, turnstileToken: freshTokens() }),
    ).rejects.toMatchObject({ kind: "gone" })
    post.mockResolvedValueOnce(CREATED)
    await createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    expect(sent(1).signupKey).not.toBe(sent(0).signupKey)
  })

  it("gives up after its own deadline instead of retrying forever", async () => {
    post.mockRejectedValue(new ApiError("Gateway timeout", 504))
    const pending = createDemoWorkspace({ ...START, turnstileToken: freshTokens() })
    const outcome = expect(pending).rejects.toMatchObject({ kind: "failed" })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await outcome
    expect(post.mock.calls.length).toBeLessThan(20)
    expect(setTokens).not.toHaveBeenCalled()
  })
})

describe("watching the workspace fill in", () => {
  async function created(): Promise<void> {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
  }

  it("strips the /api prefix the server puts on statusUrl", async () => {
    get.mockResolvedValue({ state: "ready" })
    await readDemoStatus("/api/demo/orgs/abc/status")
    expect(get).toHaveBeenCalledWith("/demo/orgs/abc/status", { suppressGlobalError: true })
  })

  it("stops the moment the seed reports ready", async () => {
    await created()
    get.mockResolvedValue({ state: "ready", expiresAt: CREATED.expiresAt })
    watchDemoWorkspace()

    await vi.advanceTimersByTimeAsync(1_100)
    expect(demoWorkspace()?.state).toBe("ready")
    const calls = get.mock.calls.length
    // No further polling once it has settled.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(get.mock.calls.length).toBe(calls)
  })

  it("reports a failed seed honestly and stops there, rather than waiting for ready", async () => {
    await created()
    get.mockResolvedValue({ state: "failed" })
    watchDemoWorkspace()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(demoWorkspace()?.state).toBe("failed")
    const calls = get.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(get.mock.calls.length).toBe(calls)
  })

  it("keeps polling, with backoff, while the seed is still running", async () => {
    await created()
    get.mockResolvedValue({ state: "provisioning" })
    watchDemoWorkspace()

    await vi.advanceTimersByTimeAsync(1_100)
    expect(get).toHaveBeenCalledTimes(1)
    // Backed off to two seconds, so one second more is not enough for a second
    // read: this is what keeps a slow seed from being a poll storm.
    await vi.advanceTimersByTimeAsync(1_100)
    expect(get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(get).toHaveBeenCalledTimes(2)
    expect(demoWorkspace()?.state).toBe("provisioning")
  })

  it("does not run two pollers when it is started twice", async () => {
    await created()
    get.mockResolvedValue({ state: "provisioning" })
    watchDemoWorkspace()
    watchDemoWorkspace()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(get).toHaveBeenCalledTimes(1)
  })

  // DEFECT D4. Three numbers disagreed about how long a seed may take: the
  // seeder was given 900s, the server called a record stale after 5 minutes, and
  // this file gave up after 10 and gave up ITSELF. A visitor whose seed
  // legitimately took six minutes, the exact case the 900s raise exists for, was
  // told a few apps were emptier than they should be and was never told the
  // world had finished.
  //
  // THE MUTATION THAT PROVES THESE BITE: ignore `pollUntil` in `watchDemoWorkspace`
  // (drop the `deadline` assignment, leaving `now() - startedAt > MAX_POLL_MS`).
  // The first test then gives up at 20 minutes on a seed the server is still
  // happy with; drop MAX_POLL_MS to the old ten minutes with it and it fails at
  // ten, which is the shipped bug exactly.
  it("keeps polling as long as the SERVER's own deadline says to", async () => {
    await created()
    const stopAt = new Date(Date.now() + 14 * 60_000).toISOString()
    get.mockResolvedValue({ state: "provisioning", pollUntil: stopAt })
    watchDemoWorkspace()
    // Well past the ten minutes this file used to stop at, and past the five the
    // server used to call stale.
    await vi.advanceTimersByTimeAsync(12 * 60_000)
    expect(demoWorkspace()?.state).toBe("provisioning")
    const calls = get.mock.calls.length
    expect(calls).toBeGreaterThan(1)
    // And it does stop, at the deadline the server named rather than at one of
    // ours: two more minutes takes it past `pollUntil`.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(demoWorkspace()?.state).toBe("failed")
    const settled = get.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(get.mock.calls.length).toBe(settled)
  })

  it("still gives up on a server that never names a deadline at all", async () => {
    await created()
    get.mockResolvedValue({ state: "provisioning" })
    watchDemoWorkspace()
    await vi.advanceTimersByTimeAsync(19 * 60_000)
    expect(demoWorkspace()?.state).toBe("provisioning")
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(demoWorkspace()?.state).toBe("failed")
  })

  it("never starts on a workspace that has already settled", async () => {
    post.mockResolvedValue({ ...CREATED, state: "ready" })
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    watchDemoWorkspace()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(get).not.toHaveBeenCalled()
  })
})

describe("a workspace whose time is up", () => {
  const at = Date.parse("2030-01-01T00:00:00.000Z")

  it("is not expired a moment before its expiry", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    expect(isDemoWorkspaceExpired(at - 1)).toBe(false)
  })

  it("is expired at its expiry, decided by the server's own timestamp", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    expect(isDemoWorkspaceExpired(at)).toBe(true)
  })

  // The reserved App Review org's marker carries a null expiry on purpose, so
  // a reaper could never take it. That session must not be told it is over.
  it("never expires when the server named no expiry", async () => {
    post.mockResolvedValue({ ...CREATED, expiresAt: null })
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    expect(isDemoWorkspaceExpired(Date.parse("2999-01-01T00:00:00.000Z"))).toBe(false)
  })

  it("is not expired when there is no workspace at all", () => {
    expect(isDemoWorkspaceExpired(Date.now())).toBe(false)
  })

  it("is forgotten on request, so a fresh one can be asked for", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    forgetDemoWorkspace()
    expect(demoWorkspace()).toBeNull()
    expect(localStorage.getItem("liaison:demo-workspace")).toBeNull()
  })
})

// The stored record is what this browser last heard, not the server's truth.
describe("catching up with the server after a reload", () => {
  async function created(state: "provisioning" | "ready" | "failed"): Promise<void> {
    post.mockResolvedValue({ ...CREATED, state })
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
  }

  it("settles a stale provisioning record from one status read, with no poller left", async () => {
    await created("provisioning")
    get.mockResolvedValue({ state: "ready", expiresAt: CREATED.expiresAt })
    await syncDemoWorkspace()
    expect(demoWorkspace()?.state).toBe("ready")
    expect(get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("restarts the poller when the seed really is still running", async () => {
    await created("provisioning")
    get.mockResolvedValueOnce({ state: "provisioning" })
    get.mockResolvedValue({ state: "ready" })
    await syncDemoWorkspace()
    expect(demoWorkspace()?.state).toBe("provisioning")
    await vi.advanceTimersByTimeAsync(1_100)
    expect(demoWorkspace()?.state).toBe("ready")
  })

  it("restarts the poller when the status read fails", async () => {
    await created("provisioning")
    get.mockRejectedValueOnce(new Error("offline"))
    get.mockResolvedValue({ state: "ready" })
    await syncDemoWorkspace()
    expect(demoWorkspace()?.state).toBe("provisioning")
    await vi.advanceTimersByTimeAsync(1_100)
    expect(demoWorkspace()?.state).toBe("ready")
  })

  it("re-checks a failed record, which can still have finished", async () => {
    await created("failed")
    get.mockResolvedValue({ state: "ready" })
    await syncDemoWorkspace()
    expect(demoWorkspace()?.state).toBe("ready")
  })

  it("does not ask about a ready record or a missing one", async () => {
    await syncDemoWorkspace()
    await created("ready")
    await syncDemoWorkspace()
    expect(get).not.toHaveBeenCalled()
  })
})

describe("the saved-key flag belongs to one workspace", () => {
  it("are cleared when a different workspace replaces this one", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    markDemoByokSaved()
    post.mockResolvedValue({ ...CREATED, orgId: "33333333-3333-4333-8333-333333333333" })
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    expect(demoByokSaved()).toBe(false)
    expect(localStorage.getItem("liaison:demo-byok-saved")).toBeNull()
  })

  it("survive the same workspace being written again", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    markDemoByokSaved()
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    expect(demoByokSaved()).toBe(true)
  })

  it("are cleared when the workspace is forgotten", async () => {
    post.mockResolvedValue(CREATED)
    await createDemoWorkspace({
      name: "Acme",
      email: "v@example.com",
      needs: ["support"],
      turnstileToken: async () => "t",
    })
    markDemoByokSaved()
    forgetDemoWorkspace()
    expect(demoByokSaved()).toBe(false)
  })
})
