// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { installRefreshBridge, REFRESH_HEADER, REFRESH_TOKEN_KEY } from "../auth/refresh-bridge"
import {
  SERVER_ADDRESS_GLOBAL,
  SERVER_ADDRESS_MIRROR_KEY,
  serverAddressOrigin,
} from "../boot/server-global"
import { SERVER_ADDRESS_KEY } from "../onboarding/server-address"
import {
  createNativeServers,
  createServerList,
  type KeyValueStore,
  NOT_A_LIAISON_SERVER,
  type PageStorage,
  pageStorageKey,
  reconcilePageStorage,
  refreshTokenKey,
  SERVER_LIST_KEY,
  SERVER_UNREACHABLE,
  STORAGE_OWNER_KEY,
  UNKNOWN_SERVER,
} from "./server-list"

const A = "https://acme.example.com"
const B = "https://globex.example.com"

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  map: Map<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
    remove: async (key) => {
      map.delete(key)
    },
  }
}

function memoryPage(initial: Record<string, string> = {}): PageStorage & {
  map: Map<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get length() {
      return map.size
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

function branding(orgName: string): Response {
  return new Response(
    JSON.stringify({ data: { orgName, logoUrl: null, flags: {}, byokModelIds: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** A fetch that answers branding for the servers named, and records the rest. */
function fakeNetwork(names: Record<string, string>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: new Headers(init?.headers) })
    const origin = new URL(input).origin
    if (input.endsWith("/api/settings/branding")) {
      if (origin in names) return branding(names[origin])
      if (origin === "https://not-liaison.example") return new Response("<html>", { status: 200 })
      throw new TypeError("network down")
    }
    return new Response("{}", { status: 200 })
  }
  return { calls, fetchImpl }
}

describe("the phone's saved servers", () => {
  it("migrates the one address and the one token a build before the list kept", async () => {
    const store = memoryStore({ [SERVER_ADDRESS_KEY]: A, [REFRESH_TOKEN_KEY]: "rt-a" })
    const list = createServerList({ store, fetchImpl: fakeNetwork({}).fetchImpl })
    await list.migrate()
    expect(await list.snapshot()).toEqual({
      current: A,
      servers: [{ address: A, label: null }],
    })
    expect(store.map.get(refreshTokenKey(A))).toBe("rt-a")
    expect(store.map.has(REFRESH_TOKEN_KEY)).toBe(false)
    // The migrated session is the one the bridge reads, for that server.
    expect(await list.refreshStoreFor(() => A).load()).toBe("rt-a")
    // Twice is once.
    await list.migrate()
    expect(store.map.get(refreshTokenKey(A))).toBe("rt-a")
  })

  it("files the first launch's address as the first saved server", async () => {
    const store = memoryStore()
    const list = createServerList({ store, fetchImpl: fakeNetwork({}).fetchImpl })
    expect(await list.snapshot()).toEqual({ current: null, servers: [] })
    await store.set(SERVER_ADDRESS_KEY, A)
    expect((await list.snapshot()).servers).toEqual([{ address: A, label: null }])
    expect(store.map.get(SERVER_LIST_KEY)).toContain(A)
  })

  // THE ISOLATION RULE. The bridge reads the token under the origin it is
  // bound to, so a token for one server is never presented to another.
  it("never hands one server's refresh token to another", async () => {
    const store = memoryStore({ [refreshTokenKey(A)]: "rt-a" })
    const list = createServerList({ store, fetchImpl: fakeNetwork({}).fetchImpl })
    let bound: string | null = A
    const tokens = list.refreshStoreFor(() => bound)
    expect(await tokens.load()).toBe("rt-a")
    bound = B
    expect(await tokens.load()).toBeNull()
    await tokens.save("rt-b")
    expect(store.map.get(refreshTokenKey(A))).toBe("rt-a")
    expect(store.map.get(refreshTokenKey(B))).toBe("rt-b")
    await tokens.clear()
    expect(store.map.get(refreshTokenKey(A))).toBe("rt-a")
    bound = null
    expect(await tokens.load()).toBeNull()
  })

  it("adds a server only once it answers as a Liaison, and says why when it does not", async () => {
    const store = memoryStore({ [SERVER_ADDRESS_KEY]: A })
    const network = fakeNetwork({ [B]: "Globex" })
    const list = createServerList({ store, fetchImpl: network.fetchImpl })
    expect(await list.add(`${B}/`)).toBe(B)
    expect((await list.snapshot()).servers).toEqual([
      { address: A, label: null },
      { address: B, label: "Globex" },
    ])
    await expect(list.add("https://not-liaison.example")).rejects.toThrow(NOT_A_LIAISON_SERVER)
    await expect(list.add("https://gone.example")).rejects.toThrow(SERVER_UNREACHABLE)
    expect((await list.snapshot()).servers).toHaveLength(2)
  })
})

describe("moving the phone between servers", () => {
  function phone() {
    const store = memoryStore({
      [SERVER_ADDRESS_KEY]: A,
      [refreshTokenKey(A)]: "rt-a",
      [SERVER_LIST_KEY]: JSON.stringify([
        { address: A, label: "Acme" },
        { address: B, label: "Globex" },
      ]),
    })
    const network = fakeNetwork({ [A]: "Acme", [B]: "Globex" })
    const list = createServerList({ store, fetchImpl: network.fetchImpl })
    const page = memoryPage({
      [SERVER_ADDRESS_MIRROR_KEY]: A,
      [STORAGE_OWNER_KEY]: A,
      "liaison:tabs": '["a-ticket"]',
    })
    const session = memoryPage({ oauth_state: "for-a" })
    const order: string[] = []
    const target: Record<string, unknown> = { [SERVER_ADDRESS_GLOBAL]: A }
    const servers = createNativeServers({
      list,
      pageStorage: page,
      sessionStorage: session,
      endSession: async () => {
        order.push("push revoked")
      },
      signOut: async () => {
        order.push("signed out")
      },
      reload: () => order.push("reload"),
      serversChanged: async () => {
        order.push(`push re-registered with ${(await list.snapshot()).servers.length} servers`)
      },
      target,
    })
    return { store, network, list, page, session, order, target, servers }
  }

  it("keeps the push registration of the server it leaves, parks its page storage and starts again on the other", async () => {
    const { store, page, session, order, target, servers } = phone()
    await servers.switchTo(B)
    // A's notifications keep reaching the phone: a switch is not a sign out.
    expect(order).toEqual(["reload"])
    expect(store.map.get(SERVER_ADDRESS_KEY)).toBe(B)
    expect(page.map.get("liaison:tabs")).toBeUndefined()
    expect(page.map.get(SERVER_ADDRESS_MIRROR_KEY)).toBe(B)
    expect(page.map.get(STORAGE_OWNER_KEY)).toBe(B)
    expect(session.map.size).toBe(0)
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe(B)
    // B's session is B's alone: A's token is still filed under A.
    expect(store.map.get(refreshTokenKey(A))).toBe("rt-a")
    expect(store.map.get(refreshTokenKey(B))).toBeUndefined()

    page.setItem("liaison:tabs", '["b-thread"]')
    await servers.switchTo(A)
    expect(page.map.get("liaison:tabs")).toBe('["a-ticket"]')
    expect(JSON.parse(store.map.get(pageStorageKey(B)) ?? "{}")).toEqual({
      "liaison:tabs": '["b-thread"]',
    })
  })

  it("does nothing for the server it is already on, or one it does not know", async () => {
    const { order, servers } = phone()
    await servers.switchTo(A)
    await expect(servers.switchTo("https://stranger.example")).rejects.toThrow(UNKNOWN_SERVER)
    expect(order).toEqual([])
  })

  it("adds a server and goes straight to it", async () => {
    const { store, order, servers } = phone()
    await store.set(SERVER_LIST_KEY, JSON.stringify([{ address: A, label: "Acme" }]))
    await servers.add(B)
    expect(store.map.get(SERVER_ADDRESS_KEY)).toBe(B)
    // The server being left is told the phone now knows two, while its bearer
    // still works, so its pushes start naming their organisation.
    expect(order).toEqual(["push re-registered with 2 servers", "reload"])
  })

  it("removing a server the phone is not on re-registers the current one with the new count", async () => {
    const { order, servers } = phone()
    await servers.remove(B)
    expect(order).toEqual(["push re-registered with 1 servers"])
  })

  it("a switch there and back leaves both servers' push registrations in place", async () => {
    const { order, servers } = phone()
    await servers.switchTo(B)
    await servers.switchTo(A)
    expect(order.filter((step) => step === "push revoked")).toEqual([])
  })

  it("a tapped notification from the other server moves the phone there, at the item", async () => {
    const { store, order } = phone()
    const reloads: Array<string | undefined> = []
    const opened = await createNativeServers({
      list: createServerList({ store, fetchImpl: fakeNetwork({}).fetchImpl }),
      pageStorage: null,
      endSession: async () => {
        order.push("push revoked")
      },
      signOut: async () => undefined,
      reload: (path) => reloads.push(path),
      target: {},
    }).openOn(`${B}/`, "liaison://thread/abc123")
    expect(opened).toBe(true)
    expect(store.map.get(SERVER_ADDRESS_KEY)).toBe(B)
    expect(reloads).toEqual(["/threads/abc123"])
    expect(order).toEqual([])
  })

  it("a tapped notification moves nothing for an unsaved server, the current one or a bad link", async () => {
    const { store, order, servers } = phone()
    expect(await servers.openOn("https://stranger.example", "liaison://thread/abc123")).toBe(false)
    expect(await servers.openOn(A, "liaison://thread/abc123")).toBe(false)
    expect(await servers.openOn(B, "liaison://settings/../x")).toBe(false)
    expect(store.map.get(SERVER_ADDRESS_KEY)).toBe(A)
    expect(order).toEqual([])
  })

  it("removing a server the phone is not on names this phone's device, so its push row goes", async () => {
    const store = memoryStore({
      [SERVER_ADDRESS_KEY]: A,
      [refreshTokenKey(B)]: "rt-b",
      [SERVER_LIST_KEY]: JSON.stringify([
        { address: A, label: "Acme" },
        { address: B, label: "Globex" },
      ]),
    })
    const bodies: Array<{ url: string; body: unknown }> = []
    const forgotten: string[] = []
    const list = createServerList({
      store,
      fetchImpl: async (input, init) => {
        bodies.push({ url: input, body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response("{}", { status: 200 })
      },
      deviceIdFor: async (origin) => (origin === B ? "push-row-b" : null),
      forgetDevice: async (origin) => {
        forgotten.push(origin)
      },
    })
    await list.remove(B)
    const logout = bodies.find((call) => call.url === `${B}/api/auth/logout`)
    expect(logout?.body).toEqual({ deviceId: "push-row-b" })
    expect(forgotten).toEqual([B])
  })

  it("removes the current server: revokes its session, forgets it, moves to the next", async () => {
    const { store, network, page, order, servers } = phone()
    await servers.remove(A)
    const logout = network.calls.find((call) => call.url === `${A}/api/auth/logout`)
    expect(logout?.headers.get(REFRESH_HEADER)).toBe("rt-a")
    expect(store.map.has(refreshTokenKey(A))).toBe(false)
    expect(store.map.get(SERVER_ADDRESS_KEY)).toBe(B)
    expect((await servers.list()).servers.map((server) => server.address)).toEqual([B])
    expect(page.map.get("liaison:tabs")).toBeUndefined()
    expect(order).toEqual(["push revoked", "reload"])
  })

  it("removing the last server leaves the phone on first launch", async () => {
    const { store, servers } = phone()
    await servers.remove(B)
    await servers.remove(A)
    expect(store.map.has(SERVER_ADDRESS_KEY)).toBe(false)
    expect((await servers.list()).servers).toEqual([])
  })

  it("signs out of the current server and starts the page again", async () => {
    const { order, servers } = phone()
    await servers.signOut()
    expect(order).toEqual(["signed out", "reload"])
  })

  // The next person to sign in on this server is not the one who left: their
  // open tabs (a Mail tab mounted behind Home for a member without mail, walk
  // 2026-10-19 #18), drafts and preferences go with the session. Which server
  // the storage belongs to stays.
  it("forgets the signed-out account's page storage, keeping whose server it is", async () => {
    const { page, servers } = phone()
    await servers.signOut()
    expect(page.map.get("liaison:tabs")).toBeUndefined()
    expect(page.map.get(SERVER_ADDRESS_MIRROR_KEY)).toBe(A)
    expect(page.map.get(STORAGE_OWNER_KEY)).toBe(A)
  })
})

describe("the page's storage at start", () => {
  it("adopts the bound server when the storage predates the marker", async () => {
    const list = createServerList({ store: memoryStore(), fetchImpl: fakeNetwork({}).fetchImpl })
    const page = memoryPage({ "liaison:tabs": "[1]" })
    let reloaded = false
    expect(await reconcilePageStorage(A, list, page, () => (reloaded = true))).toBe(false)
    expect(page.map.get(STORAGE_OWNER_KEY)).toBe(A)
    expect(page.map.get("liaison:tabs")).toBe("[1]")
    expect(reloaded).toBe(false)
  })

  it("puts another server's storage back where it belongs", async () => {
    const store = memoryStore({ [pageStorageKey(B)]: JSON.stringify({ "liaison:tabs": "[b]" }) })
    const list = createServerList({ store, fetchImpl: fakeNetwork({}).fetchImpl })
    const page = memoryPage({ [STORAGE_OWNER_KEY]: A, "liaison:tabs": "[a]" })
    let reloaded = false
    expect(await reconcilePageStorage(B, list, page, () => (reloaded = true))).toBe(true)
    expect(page.map.get("liaison:tabs")).toBe("[b]")
    expect(JSON.parse(store.map.get(pageStorageKey(A)) ?? "{}")).toEqual({ "liaison:tabs": "[a]" })
    expect(reloaded).toBe(true)
  })
})

// THE ROUND TRIP, as the simulator walked it (2026-09-28): signed in on A,
// over to B from the You screen, B's sign-in card, "Use A instead". A's token
// and A's storage both came back, and the phone still landed on A's sign-in:
// the restart RELOADED THE ROUTE it was on, B's /login, and the login screen
// under a shell leaves a signed-in page where it is. A server change starts the
// page again at the app's root, where a restored session goes to the app.
describe("a saved server keeps its session across a switch and back", () => {
  it("restores A's session at the app's root, with A's own token", async () => {
    const store = memoryStore({
      [SERVER_ADDRESS_KEY]: A,
      [refreshTokenKey(A)]: "rt-a1",
      [SERVER_LIST_KEY]: JSON.stringify([
        { address: A, label: "Acme" },
        { address: B, label: "Globex" },
      ]),
    })
    // A rotates single-use refresh tokens; B has no session for this phone.
    let live = "rt-a1"
    let issued = 1
    const presented: Array<{ origin: string; token: string | null }> = []
    const serverFetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input)
      if (url.pathname === "/api/auth/refresh") {
        const token = new Headers(init?.headers).get(REFRESH_HEADER)
        presented.push({ origin: url.origin, token })
        if (url.origin === A && token === live) {
          live = `rt-a${++issued}`
          return new Response(
            JSON.stringify({ data: { accessToken: "at-a", refreshToken: live } }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        return new Response("{}", { status: 401 })
      }
      return new Response("{}", { status: 200 })
    }
    const list = createServerList({ store, fetchImpl: serverFetch })

    // The webview: its storage, the route it is on, and what a restart does.
    const page = memoryPage({
      [SERVER_ADDRESS_MIRROR_KEY]: A,
      [STORAGE_OWNER_KEY]: A,
      "liaison:session": "1",
      "liaison:tabs": '["a-ticket"]',
    })
    let path = "/threads/t-1"
    let restarts = 0
    const servers = createNativeServers({
      list,
      pageStorage: page,
      sessionStorage: memoryPage(),
      endSession: async () => undefined,
      signOut: async () => undefined,
      reload: (to?: string) => {
        restarts++
        if (to !== undefined) path = to
      },
      target: {},
    })

    /** One page load: the bridge bound to the stored server, the app's boot refresh. */
    async function boot(): Promise<boolean> {
      const bound = serverAddressOrigin((await store.get(SERVER_ADDRESS_KEY)) ?? "")
      const bridged = installRefreshBridge({
        fetchImpl: serverFetch,
        serverOrigin: () => bound,
        store: list.refreshStoreFor(() => bound),
      })
      const response = await bridged(`${bound}/api/auth/refresh`, { method: "POST" })
      // apps/web: a rejected refresh clears the flag and shows the sign-in.
      if (!response.ok) {
        page.removeItem("liaison:session")
        path = "/login"
      }
      return response.ok
    }

    expect(await boot()).toBe(true)
    await servers.switchTo(B)
    expect(await boot()).toBe(false)
    expect(path).toBe("/login")

    await servers.switchTo(A)
    expect(restarts).toBe(2)
    // A's storage is back, flag and all, before the page starts again.
    expect(page.map.get("liaison:session")).toBe("1")
    expect(page.map.get("liaison:tabs")).toBe('["a-ticket"]')
    // And the page does not start again on B's sign-in route.
    expect(path).toBe("/")
    expect(await boot()).toBe(true)
    // A was only ever shown A's token, the rotated one; B never saw one.
    expect(presented).toEqual([
      { origin: A, token: "rt-a1" },
      { origin: B, token: null },
      { origin: A, token: "rt-a2" },
    ])
    expect(store.map.get(refreshTokenKey(A))).toBe("rt-a3")
    expect(store.map.has(refreshTokenKey(B))).toBe(false)
  })
})
