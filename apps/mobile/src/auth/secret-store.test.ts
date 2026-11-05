// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createServerList, refreshTokenKey } from "../servers/server-list"
import { REFRESH_TOKEN_KEY } from "./refresh-bridge"
import {
  createSecretRoutedStore,
  INSTALL_FLAG_KEY,
  isSecretKey,
  type ListableStringStore,
  SECRET_KEY_PREFIX,
  type SecureStoragePluginLike,
  secureStorageStringStore,
} from "./secret-store"

const A = "https://acme.example.com"
const TOKEN_A = refreshTokenKey(A)

function memory(initial: Record<string, string> = {}): ListableStringStore & {
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
    keys: async () => [...map.keys()],
  }
}

describe("which keys are secret", () => {
  it("the refresh tokens, legacy and per server, and nothing else", () => {
    expect(isSecretKey(REFRESH_TOKEN_KEY)).toBe(true)
    expect(isSecretKey(TOKEN_A)).toBe(true)
    expect(isSecretKey("liaison.serverAddress")).toBe(false)
    expect(isSecretKey("liaison.servers")).toBe(false)
    expect(isSecretKey(`liaison.pageStorage@${A}`)).toBe(false)
    expect(isSecretKey("liaison.refreshTokenX")).toBe(false)
  })
})

describe("the routed store", () => {
  it("files secret keys in the secret store and the rest in Preferences", async () => {
    const plain = memory()
    const secret = memory()
    const store = createSecretRoutedStore({ plain, secret })
    await store.set(TOKEN_A, "rt-1")
    await store.set("liaison.serverAddress", A)
    expect(secret.map.get(TOKEN_A)).toBe("rt-1")
    expect(plain.map.has(TOKEN_A)).toBe(false)
    expect(plain.map.get("liaison.serverAddress")).toBe(A)
    expect(await store.get(TOKEN_A)).toBe("rt-1")
    await store.remove(TOKEN_A)
    expect(secret.map.has(TOKEN_A)).toBe(false)
  })

  it("with no secret store (the web build) everything stays in Preferences", async () => {
    const plain = memory()
    const store = createSecretRoutedStore({ plain, secret: null })
    await store.set(TOKEN_A, "rt-1")
    expect(plain.map.get(TOKEN_A)).toBe("rt-1")
    expect(await store.get(TOKEN_A)).toBe("rt-1")
  })
})

describe("first launch after the update", () => {
  it("moves the Preferences token to the secret store and deletes the old copy", async () => {
    const plain = memory({ [TOKEN_A]: "rt-old", "liaison.serverAddress": A })
    const secret = memory()
    const store = createSecretRoutedStore({ plain, secret })
    expect(await store.get(TOKEN_A)).toBe("rt-old")
    expect(secret.map.get(TOKEN_A)).toBe("rt-old")
    expect(plain.map.has(TOKEN_A)).toBe(false)
    expect(plain.map.get("liaison.serverAddress")).toBe(A)
  })

  it("keeps a token already in the secret store and still deletes the stale copy", async () => {
    // The app died between the write and the delete, or a newer token was
    // saved since: the secret store's is the one that counts.
    const plain = memory({ [INSTALL_FLAG_KEY]: "1", [TOKEN_A]: "rt-stale" })
    const secret = memory({ [TOKEN_A]: "rt-new" })
    const store = createSecretRoutedStore({ plain, secret })
    expect(await store.get(TOKEN_A)).toBe("rt-new")
    expect(plain.map.has(TOKEN_A)).toBe(false)
  })

  it("the single-server legacy token reaches its server through the list's own migration", async () => {
    const plain = memory({ [REFRESH_TOKEN_KEY]: "rt-legacy", "liaison.serverAddress": A })
    const secret = memory()
    const store = createSecretRoutedStore({ plain, secret })
    const list = createServerList({ store, fetchImpl: async () => new Response(null) })
    await list.migrate()
    expect(secret.map.get(TOKEN_A)).toBe("rt-legacy")
    expect(secret.map.has(REFRESH_TOKEN_KEY)).toBe(false)
    expect([...plain.map.keys()].some(isSecretKey)).toBe(false)
  })

  it("runs once, and a failed move leaves the old copy for the next launch", async () => {
    const plain = memory({ [TOKEN_A]: "rt-old" })
    let failing = true
    let writes = 0
    const secret: ListableStringStore = {
      keys: async () => [],
      get: async () => null,
      set: async () => {
        writes++
        if (failing) throw new Error("keychain unavailable")
      },
      remove: async () => undefined,
    }
    const store = createSecretRoutedStore({ plain, secret })
    await expect(store.get(TOKEN_A)).rejects.toThrow("keychain unavailable")
    expect(plain.map.get(TOKEN_A)).toBe("rt-old")
    failing = false
    await store.get(TOKEN_A)
    expect(plain.map.has(TOKEN_A)).toBe(false)
    const after = writes
    await store.get(TOKEN_A)
    await store.migrateSecrets()
    expect(writes).toBe(after)
  })
})

describe("a fresh install (the iOS keychain outlives an uninstall)", () => {
  it("with no install flag, purges the app's secret-store items before any secret is read", async () => {
    const plain = memory()
    const secret = memory({ [TOKEN_A]: "rt-previous-install", [REFRESH_TOKEN_KEY]: "rt-legacy" })
    const store = createSecretRoutedStore({ plain, secret })
    expect(await store.get(TOKEN_A)).toBeNull()
    expect(secret.map.size).toBe(0)
    expect(plain.map.get(INSTALL_FLAG_KEY)).toBe("1")
  })

  it("purges before a plain key is touched, so the first launch is the one that decides", async () => {
    const plain = memory()
    const secret = memory({ [TOKEN_A]: "rt-previous-install" })
    const store = createSecretRoutedStore({ plain, secret })
    await store.set("liaison.serverAddress", A)
    expect(secret.map.size).toBe(0)
  })

  it("an update from a build that kept the token in Preferences purges, then moves it", async () => {
    const plain = memory({ [TOKEN_A]: "rt-prefs" })
    const secret = memory({ [TOKEN_A]: "rt-previous-install" })
    const store = createSecretRoutedStore({ plain, secret })
    expect(await store.get(TOKEN_A)).toBe("rt-prefs")
    expect(plain.map.has(TOKEN_A)).toBe(false)
  })

  it("once the flag is set, later launches keep the secret store", async () => {
    const plain = memory()
    const secret = memory({ [TOKEN_A]: "rt-previous-install" })
    await createSecretRoutedStore({ plain, secret }).set(TOKEN_A, "rt-1")
    const nextLaunch = createSecretRoutedStore({ plain, secret })
    expect(await nextLaunch.get(TOKEN_A)).toBe("rt-1")
  })

  it("a failed purge sets no flag, so the next launch purges again", async () => {
    const plain = memory()
    const items = memory({ [TOKEN_A]: "rt-previous-install" })
    let failing = true
    const secret: ListableStringStore = {
      ...items,
      remove: async (key) => {
        if (failing) throw new Error("keychain unavailable")
        await items.remove(key)
      },
    }
    const store = createSecretRoutedStore({ plain, secret })
    await expect(store.get(TOKEN_A)).rejects.toThrow("keychain unavailable")
    expect(plain.map.has(INSTALL_FLAG_KEY)).toBe(false)
    failing = false
    expect(await store.get(TOKEN_A)).toBeNull()
    expect(plain.map.get(INSTALL_FLAG_KEY)).toBe("1")
  })

  it("the web build has no secret store and no flag to keep", async () => {
    const plain = memory()
    const store = createSecretRoutedStore({ plain, secret: null })
    await store.set(TOKEN_A, "rt-1")
    expect(plain.map.has(INSTALL_FLAG_KEY)).toBe(false)
  })
})

describe("the secure-storage plugin as a string store", () => {
  it("configures prefix, no iCloud sync and this-device-only access before the first call", async () => {
    const calls: string[] = []
    const items = new Map<string, string>()
    const plugin: SecureStoragePluginLike = {
      setKeyPrefix: async (prefix) => {
        calls.push(`prefix:${prefix}`)
      },
      setSynchronize: async (sync) => {
        calls.push(`sync:${sync}`)
      },
      setDefaultKeychainAccess: async (access) => {
        calls.push(`access:${access}`)
      },
      getItem: async (key) => {
        calls.push(`get:${key}`)
        return items.get(key) ?? null
      },
      setItem: async (key, value) => {
        calls.push(`set:${key}`)
        items.set(key, value)
      },
      removeItem: async (key) => {
        calls.push(`remove:${key}`)
        items.delete(key)
      },
      keys: async () => {
        calls.push("keys")
        return [...items.keys()]
      },
    }
    const store = secureStorageStringStore(plugin, 3)
    await store.set(TOKEN_A, "rt")
    expect(await store.get(TOKEN_A)).toBe("rt")
    expect(await store.keys()).toEqual([TOKEN_A])
    await store.remove(TOKEN_A)
    expect(calls).toEqual([
      `prefix:${SECRET_KEY_PREFIX}`,
      "sync:false",
      "access:3",
      `set:${TOKEN_A}`,
      `get:${TOKEN_A}`,
      "keys",
      `remove:${TOKEN_A}`,
    ])
  })
})
