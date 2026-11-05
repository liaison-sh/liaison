// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import {
  attachRefreshBridge,
  createAccessTokenStore,
  createMemoryRefreshStore,
  installRefreshBridge,
  LOGOUT_PATH,
  REFRESH_HEADER,
  REFRESH_PATH,
} from "./refresh-bridge"

const SERVER = "https://liaison.example.com"

interface Call {
  url: string
  headers: Record<string, string>
}

function recorder(bodies: Record<string, unknown> = {}, statuses: Record<string, number> = {}) {
  const calls: Call[] = []
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    calls.push({ url: input, headers })
    const path = new URL(input).pathname
    const body = bodies[path] ?? { data: {} }
    return new Response(JSON.stringify(body), {
      status: statuses[path] ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { calls, fetchImpl }
}

/**
 * A server double that keeps the API's real rotation rule for a token presented
 * in the header (apps/api modules/auth/auth.ts refreshSession, routes.ts):
 * a spent token under 30 s after its successor was issued is a race, answered
 * 401 "Invalid session" for a header-borne token; after that, a spent token
 * whose successor was used (or past the 3 minute window) revokes the family;
 * an unused successor inside the window is replaced (the lost response).
 * Nothing it did not mint, and nothing of a revoked family, is accepted.
 */
function rotatingServer(initial: string) {
  const RACE_MS = 30_000
  const LOST_RESPONSE_MS = 3 * 60_000
  let clock = 1_000_000
  let n = 0
  interface Row {
    successor: string | null
    successorIssuedAt: number
    rotatedAt: number
    used: boolean
  }
  const rows = new Map<string, Row>([
    [initial, { successor: null, successorIssuedAt: 0, rotatedAt: 0, used: false }],
  ])
  const state = {
    revoked: false,
    presented: [] as Array<string | null>,
    logouts: [] as Array<string | null>,
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const mint = (): { refreshToken: string; accessToken: string } => {
    n += 1
    const refreshToken = `rt-${n + 1}`
    rows.set(refreshToken, { successor: null, successorIssuedAt: 0, rotatedAt: 0, used: false })
    return { refreshToken, accessToken: `access-${n + 1}` }
  }
  const refresh = (token: string | null): Response => {
    state.presented.push(token)
    const row = token === null ? undefined : rows.get(token)
    if (state.revoked || !row) return json(401, { error: { message: "Invalid session" } })
    if (row.successor === null) {
      const next = mint()
      row.successor = next.refreshToken
      row.successorIssuedAt = clock
      row.rotatedAt = clock
      return json(200, { data: next })
    }
    if (clock - row.successorIssuedAt < RACE_MS)
      return json(401, { error: { message: "Invalid session" } })
    const successor = rows.get(row.successor)
    if (
      !successor ||
      successor.used ||
      successor.successor !== null ||
      clock - row.rotatedAt > LOST_RESPONSE_MS
    ) {
      state.revoked = true
      return json(401, { error: { message: "Invalid session" } })
    }
    rows.delete(row.successor)
    const next = mint()
    row.successor = next.refreshToken
    row.successorIssuedAt = clock
    return json(200, { data: next })
  }
  return {
    state,
    advance: (ms: number) => {
      clock += ms
    },
    respond: (input: string, init?: RequestInit): Response => {
      const path = new URL(input).pathname
      const presented = new Headers(init?.headers).get(REFRESH_HEADER)
      if (path === REFRESH_PATH) return refresh(presented)
      if (path === LOGOUT_PATH) {
        state.logouts.push(presented)
        if (presented !== null) rows.delete(presented)
        return json(200, { data: { ok: true } })
      }
      return json(404, {})
    },
  }
}

/** A store whose next `failures` saves throw, as a locked keychain does. */
function flakyStore(initial: string | null, failures: number) {
  let stored = initial
  let left = failures
  return {
    load: async () => stored,
    save: async (token: string) => {
      if (left > 0) {
        left -= 1
        throw new Error("keychain unavailable")
      }
      stored = token
    },
    clear: async () => {
      stored = null
    },
  }
}

describe("the shell's refresh token bridge", () => {
  let store: ReturnType<typeof createMemoryRefreshStore>

  beforeEach(() => {
    store = createMemoryRefreshStore()
  })

  it("captures a refresh token handed back by a login", async () => {
    const { fetchImpl } = recorder({
      "/api/auth/login": { data: { accessToken: "a", refreshToken: "rt-from-login" } },
    })
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}/api/auth/login`, { method: "POST" })
    expect(await store.load()).toBe("rt-from-login")
  })

  // A visitor's demo workspace is signed in by POST /api/demo/orgs, which
  // answers a shell with the refresh token in the body like a login does
  // (apps/api modules/demo/routes.ts). Read only on /api/auth/, it was never
  // kept, and the visitor's session ended at the app's first restart.
  it("captures the refresh token a demo workspace signs the visitor in with", async () => {
    const { fetchImpl } = recorder({
      "/api/demo/orgs": { data: { orgId: "o", accessToken: "a", refreshToken: "rt-demo" } },
      "/api/demo/orgs/o/status": { data: { refreshToken: "not-a-sign-in" } },
    })
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}/api/demo/orgs`, { method: "POST" })
    expect(await store.load()).toBe("rt-demo")
    await wrapped(`${SERVER}/api/demo/orgs/o/status`)
    expect(await store.load()).toBe("rt-demo")
  })

  it("sends the stored token on the refresh call and keeps the rotated one", async () => {
    await store.save("rt-one")
    const { calls, fetchImpl } = recorder({
      [REFRESH_PATH]: { data: { accessToken: "a", refreshToken: "rt-two" } },
    })
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(calls[0].headers[REFRESH_HEADER.toLowerCase()]).toBe("rt-one")
    expect(await store.load()).toBe("rt-two")
  })

  // SAVED BEFORE IT IS USED (A4). A rotation whose successor the store did not
  // keep must not reach the app: it would run on a pair it cannot renew. The
  // old pair stays, and the app reads a transient failure, not a sign-out.
  it("keeps the old pair when the rotated refresh token cannot be saved", async () => {
    let stored: string | null = "rt-one"
    const failing = {
      load: async () => stored,
      save: async (_token: string) => {
        throw new Error("keychain unavailable")
      },
      clear: async () => {
        stored = null
      },
    }
    const accessTokens = createAccessTokenStore()
    accessTokens.set("old-access")
    const { fetchImpl } = recorder({
      [REFRESH_PATH]: { data: { accessToken: "new-access", refreshToken: "rt-two" } },
    })
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store: failing,
      accessTokens,
    })
    const response = await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { data?: unknown; error?: { code?: string } }
    expect(body.data).toBeUndefined()
    expect(body.error?.code).toBe("refresh_token_not_saved")
    expect(accessTokens.get()).toBe("old-access")
    expect(stored).toBe("rt-one")
  })

  it("publishes the new access token only after its refresh token is saved", async () => {
    const order: string[] = []
    let stored: string | null = "rt-one"
    const slow = {
      load: async () => stored,
      save: async (token: string) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        stored = token
        order.push("saved")
      },
      clear: async () => {
        stored = null
      },
    }
    const accessTokens = createAccessTokenStore()
    accessTokens.subscribe((token) => {
      if (token) order.push(`published:${token}`)
    })
    const { fetchImpl } = recorder({
      [REFRESH_PATH]: { data: { accessToken: "new-access", refreshToken: "rt-two" } },
    })
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store: slow,
      accessTokens,
    })
    await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(order).toEqual(["saved", "published:new-access"])
  })

  // ONE TOKEN CALL AT A TIME: two refreshes started together never present the
  // same stored token (the second would be a replay of a spent one).
  it("queues concurrent refreshes so each presents the token the one before it saved", async () => {
    await store.save("rt-one")
    let n = 0
    const presented: string[] = []
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      presented.push(new Headers(init?.headers).get(REFRESH_HEADER) ?? "")
      n += 1
      const next = `rt-${n + 1}`
      await new Promise((resolve) => setTimeout(resolve, 5))
      return new Response(JSON.stringify({ data: { accessToken: `a${n}`, refreshToken: next } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await Promise.all([
      wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" }),
      wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" }),
    ])
    expect(presented).toEqual(["rt-one", "rt-2"])
    expect(await store.load()).toBe("rt-3")
  })

  // A FAILED SAVE DOES NOT SIGN THE USER OUT. The rotation happened, the
  // keychain refused its successor, and the store still holds the spent token.
  // Presented again within 30 s, that token is a race the server answers 401
  // for a header-borne token, and the app signs out. The bridge keeps the
  // successor in memory instead, presents it next, and saves it then.
  it("presents the unsaved successor on the next refresh and keeps the user signed in", async () => {
    const server = rotatingServer("rt-1")
    const flaky = flakyStore("rt-1", 1)
    const accessTokens = createAccessTokenStore()
    const wrapped = installRefreshBridge({
      fetchImpl: async (input, init) => server.respond(input, init),
      serverOrigin: () => SERVER,
      store: flaky,
      accessTokens,
    })
    const first = await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(first.status).toBe(503)
    server.advance(5_000)
    const second = await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(second.status).toBe(200)
    // Never the spent token while the successor is held.
    expect(server.state.presented).toEqual(["rt-1", "rt-2"])
    expect(server.state.revoked).toBe(false)
    expect(await flaky.load()).toBe("rt-3")
    expect(accessTokens.get()).toBe("access-3")
  })

  it("persists the held successor at the next token call, and signs out with it", async () => {
    const server = rotatingServer("rt-1")
    const flaky = flakyStore("rt-1", 1)
    const wrapped = installRefreshBridge({
      fetchImpl: async (input, init) => server.respond(input, init),
      serverOrigin: () => SERVER,
      store: flaky,
    })
    await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(server.state.logouts).toEqual(["rt-2"])
    expect(await flaky.load()).toBeNull()
  })

  // A page that gives up on a refresh (its timeout) must not lose the rotation:
  // the server has spent the old token by then. The call underneath runs to
  // its end and its successor is kept; only the page's promise is abandoned.
  it("keeps the rotation a refresh the page abandoned still completed", async () => {
    const server = rotatingServer("rt-1")
    await store.save("rt-1")
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let stalled = true
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (stalled) {
        stalled = false
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          void gate.then(resolve)
        })
      }
      return server.respond(input, init)
    }
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    const controller = new AbortController()
    const abandoned = wrapped(`${SERVER}${REFRESH_PATH}`, {
      method: "POST",
      signal: controller.signal,
    })
    controller.abort()
    await expect(abandoned).rejects.toBeDefined()
    release()
    server.advance(5_000)
    const next = await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(next.status).toBe(200)
    expect(server.state.presented).toEqual(["rt-1", "rt-2"])
  })

  // A SIGN-OUT IS NEVER HELD HOSTAGE by a refresh that does not come back.
  it("signs out within its bound while a refresh is stalled, and keeps no late successor", async () => {
    await store.save("rt-one")
    const accessTokens = createAccessTokenStore()
    accessTokens.set("a")
    let finishRefresh: (r: Response) => void = () => {}
    const sent: string[] = []
    const fetchImpl = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname
      sent.push(path)
      if (path === REFRESH_PATH) {
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve
        })
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store,
      accessTokens,
      logoutQueueWaitMs: 50,
    })
    const refresh = wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    const started = Date.now()
    const outcome = await Promise.race([
      wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" }).then(() => "signed out"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000)),
    ])
    expect(outcome).toBe("signed out")
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(sent).toContain(LOGOUT_PATH)
    expect(await store.load()).toBeNull()
    expect(accessTokens.get()).toBeNull()
    finishRefresh(
      new Response(JSON.stringify({ data: { accessToken: "late", refreshToken: "rt-late" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const late = await refresh
    expect(late.ok).toBe(false)
    expect(await store.load()).toBeNull()
    expect(accessTokens.get()).toBeNull()
  })

  it("clears the token on logout", async () => {
    await store.save("rt-one")
    const { fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(await store.load()).toBeNull()
  })

  // SIGNING OUT HAS TO REACH THE SERVER. The app posts an empty body and holds
  // no cookie this call could carry, so without the header the route had
  // nothing to revoke: the session row stayed valid for thirty days while the
  // device showed a signed-out app.
  it("presents the stored token on the logout call", async () => {
    await store.save("rt-one")
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST", body: "{}" })
    expect(calls[0].headers[REFRESH_HEADER.toLowerCase()]).toBe("rt-one")
  })

  // THE DEVICE NAMES ITSELF ON THE WAY OUT (A7, Track S deviation 3): the
  // server revokes the receipt credential of the deviceId in the body, so a
  // signed-out NSE can write nothing. The app's own body is kept.
  it("names this device in the logout body, keeping what the app sent", async () => {
    await store.save("rt-one")
    const bodies: unknown[] = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      void input
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      return new Response("{}", { status: 200 })
    }
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store,
      deviceId: async () => "device-row-1",
    })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, {
      method: "POST",
      body: JSON.stringify({ everywhere: true }),
    })
    expect(bodies).toEqual([
      { deviceId: "device-row-1" },
      { everywhere: true, deviceId: "device-row-1" },
    ])
  })

  it("sends the logout untouched when this device has no id yet", async () => {
    await store.save("rt-one")
    const bodies: unknown[] = []
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      bodies.push(init?.body ?? null)
      return new Response("{}", { status: 200 })
    }
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store,
      deviceId: async () => null,
    })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(bodies).toEqual([null])
  })

  // A SIGN-OUT STICKS WHATEVER THE SERVER ANSWERED. Under a shell a cold start
  // refreshes with whatever token the store holds, so a token kept after a
  // failed logout signed the user back in at the next launch.
  it("forgets the token and the bearer when the logout call fails on the server", async () => {
    await store.save("rt-one")
    const { fetchImpl } = recorder({}, { [LOGOUT_PATH]: 500 })
    const accessTokens = createAccessTokenStore()
    accessTokens.set("bearer")
    let ended = 0
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store,
      accessTokens,
      onSessionEnd: () => {
        ended++
      },
    })
    const response = await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(response.status).toBe(500)
    expect(await store.load()).toBeNull()
    expect(accessTokens.get()).toBeNull()
    expect(ended).toBe(1)
  })

  // The server refuses an ended session's access tokens at once, so the
  // shell's unregister (which carries the bearer) goes before the logout.
  it("unregisters the device before it sends the logout", async () => {
    await store.save("rt-one")
    const order: string[] = []
    const fetchImpl = async () => {
      order.push("logout")
      return new Response("{}", { status: 200 })
    }
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => SERVER,
      store,
      onSessionEnd: () => {
        order.push("unregister")
      },
    })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(order).toEqual(["unregister", "logout"])
    expect(await store.load()).toBeNull()
  })

  it("forgets the token when the logout call never reaches the server", async () => {
    await store.save("rt-one")
    const failing = async () => {
      throw new TypeError("network down")
    }
    const wrapped = installRefreshBridge({ fetchImpl: failing, serverOrigin: () => SERVER, store })
    await expect(wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })).rejects.toThrow()
    expect(await store.load()).toBeNull()
  })

  // A token the server has already refused is worth nothing, so a 401 clears
  // it: the alternative is an app that can never sign out.
  it("clears the token when the server refuses it", async () => {
    await store.save("rt-one")
    const { fetchImpl } = recorder({}, { [LOGOUT_PATH]: 401 })
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(await store.load()).toBeNull()
  })

  it("sends the token to the bound server and to nothing else", async () => {
    await store.save("rt-one")
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`https://evil.example.com${REFRESH_PATH}`, { method: "POST" })
    expect(calls[0].headers[REFRESH_HEADER.toLowerCase()]).toBeUndefined()
    // A lookalike host that merely starts with the bound origin is not it.
    await wrapped(`${SERVER}.evil.example.com${REFRESH_PATH}`, { method: "POST" })
    expect(calls[1].headers[REFRESH_HEADER.toLowerCase()]).toBeUndefined()
  })

  it("carries no token before one is stored, and never an empty header", async () => {
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(calls[0].headers[REFRESH_HEADER.toLowerCase()]).toBeUndefined()
  })

  it("leaves the response readable by the app that asked for it", async () => {
    const { fetchImpl } = recorder({
      "/api/auth/login": { data: { accessToken: "a", refreshToken: "rt" } },
    })
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    const response = await wrapped(`${SERVER}/api/auth/login`, { method: "POST" })
    const body = (await response.json()) as { data: { accessToken: string } }
    expect(body.data.accessToken).toBe("a")
  })

  it("does nothing to a call that is not an auth call", async () => {
    await store.save("rt-one")
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => SERVER, store })
    await wrapped(`${SERVER}/api/threads`, { method: "GET" })
    expect(calls[0].headers[REFRESH_HEADER.toLowerCase()]).toBeUndefined()
    expect(await store.load()).toBe("rt-one")
  })

  it("holds the refresh until native storage has answered, then sends the token", async () => {
    // The app refreshes its session in its first tick and Preferences answer
    // later. Sent early the call carries no token, the server answers 401,
    // and the user lands on the login screen with a live session in storage.
    await store.save("rt-one")
    const { calls, fetchImpl } = recorder({
      [REFRESH_PATH]: { data: { accessToken: "a", refreshToken: "rt-two" } },
    })
    let origin: string | null = null
    let settle: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => origin,
      store,
      serverOriginSettled: () => settled,
    })
    const inFlight = wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    await Promise.resolve()
    expect(calls).toHaveLength(0)

    origin = SERVER
    settle()
    await inFlight
    expect(calls).toHaveLength(1)
    expect(calls[0].headers[REFRESH_HEADER.toLowerCase()]).toBe("rt-one")
    expect(await store.load()).toBe("rt-two")
  })

  it("gives up waiting rather than holding the call for ever, and sends no bare refresh", async () => {
    // The wait is bounded: an app whose token call never returns is worse
    // than one that gives up. What changed is what happens AFTER the bound.
    // An install with no bound server has nothing to refresh against, and the
    // call the app built points at `capacitor://localhost`, where there is no
    // API: the 401 that came back was read as an ended session.
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => null,
      store,
      serverOriginSettled: () => new Promise<void>(() => {}),
      settleTimeoutMs: 5,
    })
    const started = Date.now()
    const response = await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls).toHaveLength(0)
    expect(response.ok).toBe(false)
  })

  it("waits for nothing on a call that carries no token", async () => {
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({
      fetchImpl,
      serverOrigin: () => null,
      store,
      serverOriginSettled: () => new Promise<void>(() => {}),
      settleTimeoutMs: 50_000,
    })
    await wrapped(`${SERVER}/api/threads`, { method: "GET" })
    expect(calls).toHaveLength(1)
  })

  it("presents the token to no server this install is not bound to", async () => {
    // The refresh token goes to the bound origin or nowhere. With no binding
    // at all the call is answered here rather than sent somewhere bare.
    await store.save("rt-one")
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => null, store })
    await wrapped(`${SERVER}${REFRESH_PATH}`, { method: "POST" })
    expect(calls).toHaveLength(0)
    expect(await store.load()).toBe("rt-one")
  })

  it("still lets a sign-out through when this install is bound to nothing", async () => {
    // Nothing to revoke server side, and the app has to be able to finish
    // signing out locally. Only the refresh is answered here.
    const { calls, fetchImpl } = recorder()
    const wrapped = installRefreshBridge({ fetchImpl, serverOrigin: () => null, store })
    await wrapped(`${SERVER}${LOGOUT_PATH}`, { method: "POST" })
    expect(calls).toHaveLength(1)
  })
})

describe("attaching the bridge to a page", () => {
  it("wraps fetch once, whatever the boot bundle is evaluated", async () => {
    const store = createMemoryRefreshStore()
    const { calls, fetchImpl } = recorder({
      "/api/auth/login": { data: { refreshToken: "rt" } },
    })
    const target = { fetch: fetchImpl as unknown as typeof fetch } as {
      fetch: typeof fetch
    } & Record<string, unknown>
    attachRefreshBridge(target, { serverOrigin: () => SERVER, store })
    const first = target.fetch
    attachRefreshBridge(target, { serverOrigin: () => SERVER, store })
    expect(target.fetch).toBe(first)

    await target.fetch(`${SERVER}/api/auth/login`, { method: "POST" })
    expect(calls).toHaveLength(1)
    expect(await store.load()).toBe("rt")
  })
})
