// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.9, T-CRYPTO-7. `CryptoKey` structured-clone in IndexedDB has a
// cross-browser bug history, so a persistence failure must degrade to
// re-prompting each session, never to an error and never to a silent partial
// state (spec section 3.3). The helper therefore writes, then reads back and
// compares, before reporting success.
//
// Runs under `bun test` with an injected store, not a real browser.

import { describe, expect, it } from "bun:test"
import {
  type KeyStoreBackend,
  keyStoreUnavailable,
  loadPersistedKey,
  persistKey,
  restoreOrPrompt,
  wipePersistedKeys,
} from "./key-store"

async function aKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, [
    "deriveBits",
  ])
}

/** A backend that behaves. */
function workingStore(): KeyStoreBackend & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  return {
    records,
    async put(id, value) {
      records.set(id, value)
    },
    async get(id) {
      return records.get(id)
    },
    async delete(id) {
      records.delete(id)
    },
    async clear() {
      records.clear()
    },
  }
}

describe("T-CRYPTO-7 persisted key handles", () => {
  it("persists and restores a key when the store works, the non vacuity half", async () => {
    const store = workingStore()
    const key = await aKey()
    const result = await persistKey(store, "account-key", key)
    expect(result.persisted).toBe(true)
    expect(store.records.size).toBe(1)
    const restored = await restoreOrPrompt(store, "account-key")
    expect(restored.prompting).toBe("restored-from-store")
    expect(restored.key?.algorithm.name).toBe("HKDF")
    expect(restored.key?.extractable).toBe(false)
  })

  it("reports not persisted when the store accepts the put and returns nothing", async () => {
    const store: KeyStoreBackend = {
      ...workingStore(),
      async get() {
        return undefined
      },
    }
    const result = await persistKey(store, "account-key", await aKey())
    expect(result.persisted).toBe(false)
    expect(result.persisted === false && result.reason.length > 0).toBe(true)
  })

  it("makes the caller re-prompt each session when the read back fails", async () => {
    const store: KeyStoreBackend = {
      ...workingStore(),
      async get() {
        return undefined
      },
    }
    await persistKey(store, "account-key", await aKey())
    const restored = await restoreOrPrompt(store, "account-key")
    expect(restored.prompting).toBe("re-prompt-each-session")
    expect(restored.key).toBeNull()
  })

  it("reports not persisted when the read back is not the same key", async () => {
    const other = await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    )
    const store: KeyStoreBackend = {
      ...workingStore(),
      async get() {
        return other
      },
    }
    const result = await persistKey(store, "account-key", await aKey())
    expect(result.persisted).toBe(false)
  })

  it("reports not persisted when the read back is a structured clone stub", async () => {
    const store: KeyStoreBackend = {
      ...workingStore(),
      async get() {
        return { type: "secret", algorithm: { name: "HKDF" }, extractable: false, usages: [] }
      },
    }
    const result = await persistKey(store, "account-key", await aKey())
    expect(result.persisted).toBe(false)
  })

  it("reports not persisted, and does not throw, when the put itself throws", async () => {
    const store: KeyStoreBackend = {
      ...workingStore(),
      async put() {
        throw new Error("DataCloneError")
      },
    }
    const result = await persistKey(store, "account-key", await aKey())
    expect(result.persisted).toBe(false)
    expect(result.persisted === false && result.reason).toContain("DataCloneError")
  })

  it("leaves no partial record behind after a failed persist", async () => {
    const store = workingStore()
    const failing: KeyStoreBackend = {
      ...store,
      async get() {
        return undefined
      },
    }
    await persistKey(failing, "account-key", await aKey())
    expect(store.records.size).toBe(0)
  })

  it("returns null rather than throwing when a load finds nothing", async () => {
    expect(await loadPersistedKey(workingStore(), "missing")).toBeNull()
  })

  it("wipes the store records, not only the in memory handles", async () => {
    const store = workingStore()
    await persistKey(store, "account-key", await aKey())
    await persistKey(store, "identity-1", await aKey())
    expect(store.records.size).toBe(2)
    await wipePersistedKeys(store, ["account-key"])
    expect(store.records.size).toBe(1)
    await wipePersistedKeys(store)
    expect(store.records.size).toBe(0)
    expect(await loadPersistedKey(store, "identity-1")).toBeNull()
  })

  it("wipes even when the store throws, so a logout is never left half done", async () => {
    const store: KeyStoreBackend = {
      ...workingStore(),
      async clear() {
        throw new Error("InvalidStateError")
      },
    }
    await expect(wipePersistedKeys(store)).resolves.toBeUndefined()
  })

  it("degrades to re-prompting where IndexedDB does not exist at all", async () => {
    const store = keyStoreUnavailable("no IndexedDB in this context")
    expect((await persistKey(store, "account-key", await aKey())).persisted).toBe(false)
    expect((await restoreOrPrompt(store, "account-key")).prompting).toBe("re-prompt-each-session")
  })
})
