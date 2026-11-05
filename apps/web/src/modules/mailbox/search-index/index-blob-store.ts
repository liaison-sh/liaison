// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where sealed index shards live on this device.
//
// Everything that reaches this module is CIPHERTEXT, base64, sealed under D7 in
// the crypto worker. That is a rule about the caller, not a hope: nothing here
// can encrypt, so a caller that put plaintext in would be visible as a missing
// seal call at its own call site.
//
// The IndexedDB surface is declared structurally, matching
// `@liaison/mailbox-crypto`'s key store, so the module stays loadable in a
// worker and under `vitest` where `indexedDB` does not exist. A context with no
// IndexedDB gets a store that persists nothing and reports so: the index is a
// cache, and a cache that cannot be written means "rebuild each session", never
// an error page.

export interface IndexBlobStore {
  /** Names whether writes actually survive, for the banner and the ledger. */
  readonly durable: boolean
  put(key: string, blob: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  clear(): Promise<void>
}

export function createMemoryIndexBlobStore(): IndexBlobStore {
  const map = new Map<string, string>()
  return {
    durable: false,
    async put(key, blob) {
      map.set(key, blob)
    },
    async get(key) {
      return map.get(key) ?? null
    },
    async delete(key) {
      map.delete(key)
    },
    async keys() {
      return [...map.keys()]
    },
    async clear() {
      map.clear()
    },
  }
}

/** A store for a browser that blocks site data. Every write is dropped. */
export function indexBlobStoreUnavailable(): IndexBlobStore {
  return {
    durable: false,
    async put() {},
    async get() {
      return null
    },
    async delete() {},
    async keys() {
      return []
    },
    async clear() {},
  }
}

interface IdbRequestLike<T> {
  result: T
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded?: (() => void) | null
}
interface IdbObjectStoreLike {
  put(value: unknown, key: string): IdbRequestLike<unknown>
  get(key: string): IdbRequestLike<unknown>
  delete(key: string): IdbRequestLike<unknown>
  getAllKeys(): IdbRequestLike<unknown[]>
  clear(): IdbRequestLike<unknown>
}
interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): IdbObjectStoreLike
  transaction(
    name: string,
    mode: "readonly" | "readwrite",
  ): { objectStore(name: string): IdbObjectStoreLike; oncomplete: (() => void) | null }
  close(): void
}
interface IdbFactoryLike {
  open(name: string, version: number): IdbRequestLike<IdbDatabaseLike>
}

export function createIndexedDbBlobStore(
  dbName = "liaison-mailbox-search-index",
  storeName = "shards",
): IndexBlobStore {
  const idb = (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB
  if (!idb) return indexBlobStoreUnavailable()

  const open = (): Promise<IdbDatabaseLike> =>
    new Promise((resolve, reject) => {
      const request = idb.open(dbName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

  const run = <T>(
    mode: "readonly" | "readwrite",
    body: (store: IdbObjectStoreLike) => IdbRequestLike<T>,
  ) =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeName, mode)
          const request = body(tx.objectStore(storeName))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
          tx.oncomplete = () => db.close()
        }),
    )

  return {
    durable: true,
    async put(key, blob) {
      await run("readwrite", (store) => store.put(blob, key))
    },
    async get(key) {
      const value = await run("readonly", (store) => store.get(key))
      return typeof value === "string" ? value : null
    },
    async delete(key) {
      await run("readwrite", (store) => store.delete(key))
    },
    async keys() {
      const keys = await run("readonly", (store) => store.getAllKeys())
      return keys.map((key) => String(key))
    },
    async clear() {
      await run("readwrite", (store) => store.clear())
    },
  }
}
