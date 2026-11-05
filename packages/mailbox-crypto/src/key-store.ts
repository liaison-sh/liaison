// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`. It holds unlocked session
// key handles; nothing on the server may reach it.
//
// Only NON-EXTRACTABLE `CryptoKey` handles are persisted, never raw bytes
// (spec section 3.3 step 4). `CryptoKey` structured-clone in IndexedDB has a
// cross-browser bug history, so every write is read back and compared before
// success is reported: a persistence failure degrades to "re-prompt each
// session", never to an error and never to a silent partial state.
//
// The wipe path deletes the store records, not only the in-memory handles.

/** The minimum an injected store has to do. A real IndexedDB fills it in. */
export interface KeyStoreBackend {
  /**
   * A non-extractable `CryptoKey`, or a small plain record that describes the
   * handles beside it (the session lease). Never raw key bytes.
   */
  put(id: string, value: CryptoKey | object): Promise<void>
  get(id: string): Promise<unknown>
  delete(id: string): Promise<void>
  clear(): Promise<void>
  /**
   * Every record id in the store. Optional: a store without it can only be
   * wiped whole, and the caller falls back to that.
   */
  keys?(): Promise<string[]>
}

export type KeyPersistence = { persisted: true } | { persisted: false; reason: string }

export type UnlockPrompting = "restored-from-store" | "re-prompt-each-session"

export interface RestoreResult {
  key: CryptoKey | null
  prompting: UnlockPrompting
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey
}

function sameHandle(a: CryptoKey, b: CryptoKey): boolean {
  return (
    a.type === b.type &&
    a.extractable === b.extractable &&
    a.algorithm.name === b.algorithm.name &&
    [...a.usages].sort().join(",") === [...b.usages].sort().join(",")
  )
}

/**
 * Write, then read back and compare. Reports rather than throws: the caller's
 * answer to "not persisted" is to re-prompt, not to show an error.
 */
export async function persistKey(
  store: KeyStoreBackend,
  id: string,
  key: CryptoKey,
): Promise<KeyPersistence> {
  if (key.extractable) {
    return { persisted: false, reason: "refusing to persist an extractable key handle" }
  }
  try {
    await store.put(id, key)
  } catch (error) {
    return { persisted: false, reason: `store rejected the write: ${describe(error)}` }
  }
  let readBack: unknown
  try {
    readBack = await store.get(id)
  } catch (error) {
    await forget(store, id)
    return { persisted: false, reason: `store rejected the read back: ${describe(error)}` }
  }
  if (!isCryptoKey(readBack)) {
    await forget(store, id)
    return {
      persisted: false,
      reason: "the store did not return a CryptoKey, structured clone is unavailable here",
    }
  }
  if (!sameHandle(readBack, key)) {
    await forget(store, id)
    return { persisted: false, reason: "the store returned a different key handle" }
  }
  return { persisted: true }
}

/** `null` when the handle is not there or the store cannot return one. */
export async function loadPersistedKey(
  store: KeyStoreBackend,
  id: string,
): Promise<CryptoKey | null> {
  try {
    const value = await store.get(id)
    return isCryptoKey(value) ? value : null
  } catch {
    return null
  }
}

/** The caller path: either the handle came back, or this session re-prompts. */
export async function restoreOrPrompt(store: KeyStoreBackend, id: string): Promise<RestoreResult> {
  const key = await loadPersistedKey(store, id)
  return key
    ? { key, prompting: "restored-from-store" }
    : { key: null, prompting: "re-prompt-each-session" }
}

/**
 * Logout and idle timeout. Deletes the records; a store that throws must not
 * leave a logout half done, so failures are swallowed after a best effort.
 */
export async function wipePersistedKeys(
  store: KeyStoreBackend,
  ids?: readonly string[],
): Promise<void> {
  if (ids) {
    for (const id of ids) await forget(store, id)
    return
  }
  try {
    await store.clear()
  } catch {
    // Nothing more this layer can do. The in-memory handles are dropped by the
    // caller regardless, and the next unlock re-prompts.
  }
}

async function forget(store: KeyStoreBackend, id: string): Promise<void> {
  try {
    await store.delete(id)
  } catch {
    // Same reasoning as wipePersistedKeys.
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * A store for contexts with no IndexedDB at all (a worker in a browser that
 * blocks site data, a server-side render, a test). Every operation is a no-op,
 * so the caller re-prompts each session rather than failing.
 */
export function keyStoreUnavailable(reason: string): KeyStoreBackend {
  return {
    async put() {
      throw new Error(reason)
    },
    async get() {
      return undefined
    },
    async delete() {},
    async clear() {},
    async keys() {
      return []
    },
  }
}

// The minimum of the IndexedDB surface this file uses. Declared structurally
// rather than pulled from lib.dom, because this package compiles with
// lib: ["ESNext"] so it stays loadable in a worker, in the browser and in Bun.
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
  clear(): IdbRequestLike<unknown>
  getAllKeys(): IdbRequestLike<unknown[]>
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

/**
 * The browser store. Not reachable under `bun test`, where `indexedDB` does not
 * exist: callers get `keyStoreUnavailable` and re-prompt.
 */
export function createIndexedDbKeyStore(
  dbName = "liaison-mailbox-keys",
  storeName = "handles",
): KeyStoreBackend {
  const idb = (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB
  if (!idb) return keyStoreUnavailable("IndexedDB is not available in this context")

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
    async put(id, key) {
      await run("readwrite", (store) => store.put(key, id))
    },
    async get(id) {
      return run("readonly", (store) => store.get(id))
    },
    async delete(id) {
      await run("readwrite", (store) => store.delete(id))
    },
    async clear() {
      await run("readwrite", (store) => store.clear())
    },
    async keys() {
      const all = await run("readonly", (store) => store.getAllKeys())
      return all.filter((key): key is string => typeof key === "string")
    },
  }
}
