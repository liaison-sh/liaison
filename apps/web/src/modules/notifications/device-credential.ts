// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser device's receipt credential (A7, F1), kept in IndexedDB because
// the service worker (public/liaison-sw.js) must read it with no page open,
// and a worker has no localStorage. ONE record per browser profile, under a
// fixed database, store and key that the worker script repeats verbatim:
// change them here and there together (liaison-sw.test.ts proves they agree).
//
// The credential can write receipts for this device and nothing else; it is
// never a session token. Every call answers null / no-op rather than throwing:
// a browser without IndexedDB (some private modes) just posts no receipts.

export const CREDENTIAL_DB = "liaison-notifications"
export const CREDENTIAL_STORE = "device"
export const CREDENTIAL_KEY = "browser"

export interface BrowserDeviceRecord {
  /** The per-browser id the WS hello sends (createWebSocket notificationDeviceId). */
  deviceId: string
  /** Receipt-only credential (`lnr_...`). */
  credential: string
  /** Whose session registered it: another user on this browser registers again. */
  userId: string
  /** The server the credential is valid on. */
  serverOrigin: string
  /** Absolute URL of POST /api/notifications/receipts on that server. */
  receiptsUrl: string
  /** The Web Push endpoint registered with it, or null for in-tab receipts only. */
  endpoint: string | null
}

function idb(): IDBFactory | null {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  return factory ?? null
}

function openDb(): Promise<IDBDatabase | null> {
  const factory = idb()
  if (!factory) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = factory.open(CREDENTIAL_DB, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CREDENTIAL_STORE)) db.createObjectStore(CREDENTIAL_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = op(db.transaction(CREDENTIAL_STORE, mode).objectStore(CREDENTIAL_STORE))
          req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export async function readBrowserDevice(): Promise<BrowserDeviceRecord | null> {
  const rec = await run<BrowserDeviceRecord>("readonly", (s) => s.get(CREDENTIAL_KEY))
  return rec && typeof rec.credential === "string" ? rec : null
}

export async function writeBrowserDevice(rec: BrowserDeviceRecord): Promise<void> {
  await run("readwrite", (s) => s.put(rec, CREDENTIAL_KEY))
}

export async function clearBrowserDevice(): Promise<void> {
  await run("readwrite", (s) => s.delete(CREDENTIAL_KEY))
}
