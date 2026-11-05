// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A minimal in-memory IndexedDB for tests (jsdom has none): open with an
// upgrade, one transaction per call, and get / put / delete on an object
// store. Enough for the browser device credential (device-credential.ts) and
// the service worker that reads it (public/liaison-sw.js), so a test proves
// the two agree on the database, store and key. Never used by the app.

type Handler = ((event: { target: unknown }) => void) | null

interface FakeRequest<T> {
  result: T | undefined
  error: unknown
  onsuccess: Handler
  onerror: Handler
  onupgradeneeded?: Handler
}

function request<T>(run: () => T): FakeRequest<T> {
  const req: FakeRequest<T> = { result: undefined, error: null, onsuccess: null, onerror: null }
  setTimeout(() => {
    try {
      req.result = run()
      req.onsuccess?.({ target: req })
    } catch (err) {
      req.error = err
      req.onerror?.({ target: req })
    }
  }, 0)
  return req
}

export interface FakeIndexedDb {
  open: (name: string, version?: number) => FakeRequest<unknown>
  /** The raw data: database -> store -> key -> value. */
  data: Map<string, Map<string, Map<string, unknown>>>
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const data = new Map<string, Map<string, Map<string, unknown>>>()
  const versions = new Map<string, number>()

  function makeDb(name: string) {
    const stores = data.get(name)!
    return {
      objectStoreNames: { contains: (store: string) => stores.has(store) },
      createObjectStore: (store: string) => {
        stores.set(store, new Map())
        return {}
      },
      close: () => {},
      transaction: (_store: string, _mode?: string) => {
        const tx: { oncomplete: Handler; onerror: Handler; objectStore: (s: string) => unknown } = {
          oncomplete: null,
          onerror: null,
          objectStore: (s: string) => {
            const rows = stores.get(s)
            if (!rows) throw new Error(`NotFoundError: no object store ${s}`)
            const done = <T>(run: () => T) => {
              const req = request(run)
              // The transaction completes right after its one request settles.
              setTimeout(() => tx.oncomplete?.({ target: tx }), 0)
              return req
            }
            return {
              get: (key: string) => done(() => rows.get(key)),
              put: (value: unknown, key: string) =>
                done(() => {
                  rows.set(key, structuredClone(value))
                  return key
                }),
              delete: (key: string) =>
                done(() => {
                  rows.delete(key)
                  return undefined
                }),
            }
          },
        }
        return tx
      },
    }
  }

  return {
    data,
    open(name: string, version = 1) {
      const req: FakeRequest<unknown> = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      }
      setTimeout(() => {
        if (!data.has(name)) data.set(name, new Map())
        const db = makeDb(name)
        req.result = db
        if ((versions.get(name) ?? 0) < version) {
          versions.set(name, version)
          req.onupgradeneeded?.({ target: req })
        }
        req.onsuccess?.({ target: req })
      }, 0)
      return req
    },
  }
}
