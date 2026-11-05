// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHOSE SESSION EVENTS CACHE IT IS (S58, batch-5 F3). The disk cache of
// session events (session-disk-cache.ts) is one IndexedDB database per server
// and per user: `liaison-sessions-<server hash>-<user id>`. In a browser the
// origin is already the server's; in the desktop app every server shares the
// page's one origin (`tauri://localhost`), so without the server in the name
// one server's transcripts stayed readable by the page while it was signed in
// to another. A server switch simply never opens the other server's database;
// a sign-out deletes the user's; removing a server in the desktop app deletes
// every database of that server (`deleteSessionCachesOf`).
//
// No app imports here: the desktop overlay imports this module as well.

/** Every session events cache database starts with this. */
export const SESSION_CACHE_DB_PREFIX = "liaison-sessions-"

/** The origin of a server address (a path or a trailing slash never makes another server). */
function originOf(server: string): string {
  try {
    return new URL(server).origin
  } catch {
    return server.trim().replace(/\/+$/, "")
  }
}

/** A short stable hash of a server's origin (FNV-1a, 32 bits, hex). Not a secret: a name. */
export function serverKey(server: string): string {
  const text = originOf(server)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** The database that holds one user's cached session events on one server. */
export function sessionCacheDbName(server: string, userId: string): string {
  return `${SESSION_CACHE_DB_PREFIX}${serverKey(server)}-${userId}`
}

type Factory = Pick<IDBFactory, "deleteDatabase"> & {
  databases?: () => Promise<{ name?: string }[]>
}

function factoryOf(): Factory | null {
  try {
    const f = (globalThis as { indexedDB?: Factory }).indexedDB
    return f && typeof f.deleteDatabase === "function" ? f : null
  } catch {
    return null
  }
}

/** Delete one database; settles whatever happens (a blocked delete completes once the holder closes). */
export function deleteSessionCacheDb(name: string, factory = factoryOf()): Promise<void> {
  if (!factory) return Promise.resolve()
  return new Promise((resolve) => {
    try {
      const req = factory.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * A server removed (the desktop app): every user's session events cache of
 * that server is deleted. The names deleted (none without IndexedDB or
 * `indexedDB.databases()`).
 */
export async function deleteSessionCachesOf(
  server: string,
  factory = factoryOf(),
): Promise<string[]> {
  if (!factory || typeof factory.databases !== "function") return []
  const prefix = `${SESSION_CACHE_DB_PREFIX}${serverKey(server)}-`
  let names: string[] = []
  try {
    names = (await factory.databases())
      .map((d) => d.name ?? "")
      .filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
  await Promise.all(names.map((name) => deleteSessionCacheDb(name, factory)))
  return names
}
