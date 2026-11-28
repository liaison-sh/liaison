// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The web builds this server ships, and their build ids.
//
// The image holds two builds of apps/web: the desktop build (`vite build`,
// apps/api/public, served at `/`) and the native build (`vite build --mode
// native`, apps/api/public-native, served under `/native/`), the one the phone
// apps wrap. A desktop or phone app can run the server's build in place of the
// one compiled into it, once it has checked a signed statement for that build
// id (packages/shared/src/app-signing/shell-statement.ts); GET /api/shell/info
// tells it which ids this server ships.
//
// Side-effect free and cheap: lib/server.ts reads the ids once at startup, the
// route reads them through the same cache.
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** The web build's id, written by apps/web's Vite build next to index.html. */
export const WEB_BUILD_ID_FILE = "build-id.txt"

/** Where the native build is served: `/native/<path>` is `<native dir>/<path>`. */
export const NATIVE_SHELL_PREFIX = "/native"

/** The desktop web build: LIAISON_PUBLIC_DIR, else apps/api/public. */
export function defaultPublicDir(): string {
  return (
    process.env.LIAISON_PUBLIC_DIR || resolve(new URL("../../public", import.meta.url).pathname)
  )
}

/** The native web build: LIAISON_PUBLIC_NATIVE_DIR, else apps/api/public-native. */
export function defaultNativePublicDir(): string {
  return (
    process.env.LIAISON_PUBLIC_NATIVE_DIR ||
    resolve(new URL("../../public-native", import.meta.url).pathname)
  )
}

/**
 * The build id a web build was built with. Null when no build is there (dev,
 * API-only images) or the file is missing or empty.
 */
export function readWebBuildId(publicDir: string): string | null {
  try {
    const p = join(publicDir, WEB_BUILD_ID_FILE)
    if (!existsSync(p)) return null
    const id = readFileSync(p, "utf8").trim()
    return id === "" ? null : id
  } catch {
    return null
  }
}

export interface ShellBuildIds {
  desktop: string | null
  native: string | null
}

// The image is immutable, so a running process reads each id once.
const cache = new Map<string, string | null>()

function cachedId(dir: string): string | null {
  if (!cache.has(dir)) cache.set(dir, readWebBuildId(dir))
  return cache.get(dir) ?? null
}

/** The build ids of the two web builds this server ships (null: not shipped). */
export function shellBuildIds(
  dirs: { publicDir?: string; nativePublicDir?: string } = {},
): ShellBuildIds {
  return {
    desktop: cachedId(dirs.publicDir ?? defaultPublicDir()),
    native: cachedId(dirs.nativePublicDir ?? defaultNativePublicDir()),
  }
}

export const ShellBuildIdsTestAccess = {
  reset(): void {
    cache.clear()
  },
}
