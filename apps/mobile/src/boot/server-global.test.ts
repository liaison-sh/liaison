// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  createMemoryRefreshStore,
  installRefreshBridge,
  REFRESH_HEADER,
  REFRESH_PATH,
} from "../auth/refresh-bridge"
import {
  confirmedServerOrigin,
  publishedServerAddress,
  serverOriginSettled,
  startBoot,
} from "../main"
import {
  mirrorServerAddress,
  publishMirroredServerAddress,
  publishServerAddress,
  SERVER_ADDRESS_GLOBAL,
  SERVER_ADDRESS_MIRROR_KEY,
} from "./server-global"

describe("the server address handed to the wrapped app", () => {
  it("publishes the origin of the address the user entered", () => {
    const target: Record<string, unknown> = {}
    expect(publishServerAddress(target, "https://acme.example.com/")).toBe(true)
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://acme.example.com")
  })

  it("keeps the origin alone, never a path a link could smuggle in", () => {
    const target: Record<string, unknown> = {}
    publishServerAddress(target, "https://acme.example.com/evil?x=1#y")
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://acme.example.com")
  })

  it("publishes nothing for an address that is not http or https", () => {
    for (const bad of ["", "acme.example.com", "javascript:alert(1)", "file:///etc/passwd"]) {
      const target: Record<string, unknown> = {}
      expect(publishServerAddress(target, bad)).toBe(false)
      expect(SERVER_ADDRESS_GLOBAL in target).toBe(false)
    }
  })
})

describe("the boot sequence", () => {
  it("publishes the settled address before anything talks to the server", async () => {
    const target = globalThis as Record<string, unknown>
    delete target[SERVER_ADDRESS_GLOBAL]
    let publishedWhenPushStarted: unknown
    await startBoot({
      queue: {
        onAppUrlOpen: () => {},
        registerNavigator: () => {},
        markAppReady: () => {},
        pending: () => [],
      },
      addUrlListener: () => {},
      whenAppReady: () => {},
      firstLaunch: {
        start: async () => "https://acme.example.com/",
        boundAddress: async () => null,
        offerAddress: () => {},
      },
      startPush: async () => {
        publishedWhenPushStarted = target[SERVER_ADDRESS_GLOBAL]
      },
    })
    expect(publishedWhenPushStarted).toBe("https://acme.example.com")
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://acme.example.com")
    delete target[SERVER_ADDRESS_GLOBAL]
  })
})

// The address reaches the wrapped app through an ASYNCHRONOUS store, and the
// app's module entry runs as soon as the boot script yields: without a
// synchronous mirror the first requests were built before the global existed.
describe("the synchronous mirror", () => {
  function memoryStorage(seed?: string) {
    const map = new Map<string, string>()
    if (seed !== undefined) map.set(SERVER_ADDRESS_MIRROR_KEY, seed)
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value)
      },
      read: () => map.get(SERVER_ADDRESS_MIRROR_KEY) ?? null,
    }
  }

  it("publishes before any microtask when a mirror exists", async () => {
    const storage = memoryStorage("https://acme.example.com")
    const target: Record<string, unknown> = {}
    let publishedSynchronously: unknown
    // Whatever runs in this tick sees it: the assertion is taken BEFORE the
    // first await resolves, which is where the app's own entry runs.
    const observe = Promise.resolve().then(() => {
      publishedSynchronously = target[SERVER_ADDRESS_GLOBAL]
    })
    expect(publishMirroredServerAddress(target, storage)).toBe(true)
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://acme.example.com")
    await observe
    expect(publishedSynchronously).toBe("https://acme.example.com")
  })

  it("publishes nothing when there is no mirror, or storage refuses", () => {
    const target: Record<string, unknown> = {}
    expect(publishMirroredServerAddress(target, memoryStorage())).toBe(false)
    expect(publishMirroredServerAddress(target, null)).toBe(false)
    expect(SERVER_ADDRESS_GLOBAL in target).toBe(false)
  })

  it("refuses a mirror that is not an http address", () => {
    const target: Record<string, unknown> = {}
    expect(publishMirroredServerAddress(target, memoryStorage("javascript:alert(1)"))).toBe(false)
    expect(SERVER_ADDRESS_GLOBAL in target).toBe(false)
  })

  it("round trips what the settle writes", () => {
    const storage = memoryStorage()
    mirrorServerAddress("https://acme.example.com", storage)
    const target: Record<string, unknown> = {}
    expect(publishMirroredServerAddress(target, storage)).toBe(true)
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://acme.example.com")
  })
})

describe("a first launch that had no address to start with", () => {
  const target = globalThis as Record<string, unknown>

  it("reloads once so the app starts against the server it just learned", async () => {
    delete target[SERVER_ADDRESS_GLOBAL]
    let reloads = 0
    let pushStarted = false
    await startBoot({
      queue: {
        onAppUrlOpen: () => {},
        registerNavigator: () => {},
        markAppReady: () => {},
        pending: () => [],
      },
      addUrlListener: () => {},
      whenAppReady: () => {},
      firstLaunch: {
        start: async () => "https://acme.example.com",
        boundAddress: async () => null,
        offerAddress: () => {},
      },
      reload: () => {
        reloads += 1
      },
      startPush: async () => {
        pushStarted = true
      },
    })
    expect(reloads).toBe(1)
    // Nothing talks to the server on the run that is about to be thrown away.
    expect(pushStarted).toBe(false)
    delete target[SERVER_ADDRESS_GLOBAL]
  })

  it("does not reload when the mirror already published the address", async () => {
    delete target[SERVER_ADDRESS_GLOBAL]
    publishServerAddress(target, "https://acme.example.com")
    let reloads = 0
    let pushStarted = false
    await startBoot({
      queue: {
        onAppUrlOpen: () => {},
        registerNavigator: () => {},
        markAppReady: () => {},
        pending: () => [],
      },
      addUrlListener: () => {},
      whenAppReady: () => {},
      firstLaunch: {
        start: async () => "https://acme.example.com",
        boundAddress: async () => null,
        offerAddress: () => {},
      },
      reload: () => {
        reloads += 1
      },
      startPush: async () => {
        pushStarted = true
      },
    })
    expect(reloads).toBe(0)
    expect(pushStarted).toBe(true)
    delete target[SERVER_ADDRESS_GLOBAL]
  })
})

// THE MIRROR IS A HINT, AND PREFERENCES ARE THE RECORD.
//
// Anything that can run script in the wrapped page can write localStorage, so
// a mirror pointing at an attacker's host would otherwise decide where the
// app's requests (and the shell's refresh token) go for as long as the
// asynchronous Preferences read takes to answer. These pin the three things
// that make that survivable: the confirmed address wins, the poisoned mirror
// is dropped and rewritten, the page starts again, and the refresh header is
// never presented to an origin Preferences did not confirm.
describe("a mirror that disagrees with Preferences", () => {
  const target = globalThis as Record<string, unknown>

  function memoryStorage(seed?: string) {
    const map = new Map<string, string>()
    if (seed !== undefined) map.set(SERVER_ADDRESS_MIRROR_KEY, seed)
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value)
      },
      removeItem: (key: string) => {
        map.delete(key)
      },
      read: () => map.get(SERVER_ADDRESS_MIRROR_KEY) ?? null,
    }
  }

  function bootDeps(storage: ReturnType<typeof memoryStorage>, onReload: () => void) {
    return {
      queue: {
        onAppUrlOpen: () => {},
        registerNavigator: () => {},
        markAppReady: () => {},
        pending: () => [],
      },
      addUrlListener: () => {},
      whenAppReady: () => {},
      mirrorStorage: storage,
      reload: onReload,
    }
  }

  it("republishes the Preferences address, drops the mirror and reloads", async () => {
    const storage = memoryStorage("https://evil.example.com")
    delete target[SERVER_ADDRESS_GLOBAL]
    expect(publishMirroredServerAddress(target, storage)).toBe(true)
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://evil.example.com")

    let reloads = 0
    let pushStarted = false
    await startBoot({
      ...bootDeps(storage, () => {
        reloads += 1
      }),
      firstLaunch: {
        start: async () => "https://acme.example.com",
        boundAddress: async () => null,
        offerAddress: () => {},
      },
      startPush: async () => {
        pushStarted = true
      },
    })

    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://acme.example.com")
    expect(storage.read()).toBe("https://acme.example.com")
    expect(reloads).toBe(1)
    // Nothing talks to the server on the run that is about to be thrown away.
    expect(pushStarted).toBe(false)
    delete target[SERVER_ADDRESS_GLOBAL]
  })

  it("leaves an agreeing mirror alone and does not reload", async () => {
    const storage = memoryStorage("https://acme.example.com")
    delete target[SERVER_ADDRESS_GLOBAL]
    publishMirroredServerAddress(target, storage)

    let reloads = 0
    await startBoot({
      ...bootDeps(storage, () => {
        reloads += 1
      }),
      firstLaunch: {
        start: async () => "https://acme.example.com/",
        boundAddress: async () => null,
        offerAddress: () => {},
      },
    })

    expect(reloads).toBe(0)
    expect(storage.read()).toBe("https://acme.example.com/")
    delete target[SERVER_ADDRESS_GLOBAL]
  })

  it("hands the refresh header to the confirmed origin and never to the hint", async () => {
    const storage = memoryStorage("https://evil.example.com")
    delete target[SERVER_ADDRESS_GLOBAL]
    publishMirroredServerAddress(target, storage)

    const store = createMemoryRefreshStore()
    await store.save("rt-one")
    const sent: Array<{ url: string; header: string | null }> = []
    const bridged = installRefreshBridge({
      fetchImpl: async (input: string, init?: RequestInit) => {
        sent.push({ url: input, header: new Headers(init?.headers).get(REFRESH_HEADER) })
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      serverOrigin: confirmedServerOrigin,
      store,
    })

    // Before Preferences answer, the hint is what the page is USING, and what
    // the bridge is bound to is not it: no header, and no token captured from
    // its answers either.
    expect(confirmedServerOrigin()).not.toBe("https://evil.example.com")
    await bridged(`https://evil.example.com${REFRESH_PATH}`, { method: "POST" })
    expect(sent[0].header).toBeNull()

    // WHAT THE OLD BINDING DID, on the same poisoned hint: a bridge bound to
    // the published global hands the stored refresh token straight to it.
    // This is the defect the line above is the fix for, kept here so the two
    // behaviours are visible side by side.
    const leaked: Array<string | null> = []
    const naive = installRefreshBridge({
      fetchImpl: async (_input: string, init?: RequestInit) => {
        leaked.push(new Headers(init?.headers).get(REFRESH_HEADER))
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      serverOrigin: publishedServerAddress,
      store,
    })
    await naive(`https://evil.example.com${REFRESH_PATH}`, { method: "POST" })
    expect(leaked[0]).toBe("rt-one")

    await startBoot({
      ...bootDeps(storage, () => {}),
      firstLaunch: {
        start: async () => "https://acme.example.com",
        boundAddress: async () => null,
        offerAddress: () => {},
      },
    })

    await bridged(`https://evil.example.com${REFRESH_PATH}`, { method: "POST" })
    expect(sent[1].header).toBeNull()
    await bridged(`https://acme.example.com${REFRESH_PATH}`, { method: "POST" })
    expect(sent[2].header).toBe("rt-one")
    delete target[SERVER_ADDRESS_GLOBAL]
  })
})

// The relaunch this closes: Preferences hold a good address and a good refresh
// token, the network is gone, and the shell's own validation of that address is
// a fetch with nothing behind it. Everything the wrapped app does in its first
// seconds was waiting on that fetch.
describe("the bound origin settles from storage, never from the network", () => {
  const STORED = "https://relaunch.example.com"

  it("settles the stored address before it waits for that server to answer", async () => {
    const target = globalThis as Record<string, unknown>
    delete target[SERVER_ADDRESS_GLOBAL]
    const order: string[] = []
    const store = createMemoryRefreshStore()
    await store.save("rt-one")
    const sent: Array<{ url: string; header: string | null }> = []
    const bridged = installRefreshBridge({
      fetchImpl: async (input: string, init?: RequestInit) => {
        sent.push({ url: input, header: new Headers(init?.headers).get(REFRESH_HEADER) })
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      serverOrigin: confirmedServerOrigin,
      store,
      serverOriginSettled,
      settleTimeoutMs: 5000,
    })

    void startBoot({
      queue: {
        onAppUrlOpen: () => {},
        registerNavigator: () => {},
        markAppReady: () => {},
        pending: () => [],
      },
      addUrlListener: () => {},
      whenAppReady: () => {},
      firstLaunch: {
        boundAddress: async () => {
          order.push("stored address")
          return STORED
        },
        // Offline: the branding validation never answers at all.
        start: () => {
          order.push("branding")
          return new Promise<string>(() => {})
        },
        offerAddress: () => {},
      },
    })
    // One native storage read, and nothing else, stands between boot and the
    // settle. The branding fetch has started and will never finish.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["stored address", "branding"])
    expect(confirmedServerOrigin()).toBe(STORED)

    const started = Date.now()
    await bridged(`${STORED}/api/auth/refresh`, { method: "POST" })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(sent).toHaveLength(1)
    expect(sent[0].header).toBe("rt-one")
    delete target[SERVER_ADDRESS_GLOBAL]
  })
})
