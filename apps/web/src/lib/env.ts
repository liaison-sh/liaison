// SPDX-License-Identifier: FSL-1.1-ALv2
function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "") || "/"
}

const builtApiBase = trimTrailingSlash((import.meta.env.VITE_API_BASE as string) ?? "/api")
const wsBase = trimTrailingSlash((import.meta.env.VITE_WS_BASE as string) ?? "/ws")

export const env = {
  DEV: import.meta.env.DEV as boolean,
  API_BASE: builtApiBase,
  WS_BASE: wsBase,
} as const

/**
 * ONE BUILD FOR EVERY DEPLOYMENT (S15).
 *
 * In a browser this app is served BY its own API's origin, so "/api" is the
 * right base and nothing below does anything. Wrapped in a native shell it is
 * not: the page comes from `capacitor://localhost` or `tauri://localhost`, and
 * a relative "/api" there resolves inside the app bundle, which holds no API
 * at all. The shell is the only part that knows the address the user entered
 * at first launch, so it sets it on this global BEFORE these scripts run (the
 * mobile boot bundle is injected first; the desktop overlay is a Tauri
 * initialization script) and every request reads it here.
 *
 * IT IS VALIDATED, NOT TRUSTED. A global is writable by any script in the
 * page, and this one decides where the bearer token is sent, so anything that
 * is not an absolute http(s) URL is ignored, and only the ORIGIN of one is
 * kept: a path, a query or a fragment on it would be smuggled onto every
 * request. Ignored means "fall back to the relative base", which is what a
 * browser wants anyway.
 */
const SERVER_ADDRESS_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

export function serverAddressOverride(): string | null {
  const raw = (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  return parsed.origin
}

/** The API base every request is built on: absolute under a shell, relative otherwise. */
export function apiBase(): string {
  const origin = serverAddressOverride()
  return origin === null ? env.API_BASE : `${origin}${env.API_BASE}`
}

/**
 * The API base as an ABSOLUTE url, for the two callers that cannot use a
 * relative one: the WS ticket exchange and the socket itself.
 */
export function absoluteApiBase(): string {
  const origin = serverAddressOverride()
  if (origin !== null) return `${origin}${env.API_BASE}`
  const target = import.meta.env.VITE_API_TARGET as string | undefined
  if (target) return trimTrailingSlash(target)
  return `${window.location.protocol}//${window.location.host}${env.API_BASE}`
}

/**
 * Where the websocket connects. Derived from the API base rather than from
 * `window.location`, which under a native shell names the bundle's own
 * scheme (`capacitor:`) and would pick `ws:` for an `https:` deployment.
 */
export function webSocketOrigin(): string {
  const url = new URL(absoluteApiBase())
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`
}

/**
 * A URL the SERVER handed back for the page to load directly, an <img> src
 * above all: an uploaded avatar is stored as "/api/avatars/<key>". In a
 * browser that path is right as it is. Under a native shell it would resolve
 * inside the app bundle, so every uploaded picture broke while the initials
 * fallback kept working. Only a server-relative path is anchored on the
 * injected origin; an absolute, protocol-relative, data: or blob: URL already
 * names where it lives and is returned untouched.
 */
export function serverResourceUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (!url.startsWith("/") || url.startsWith("//")) return url
  const origin = serverAddressOverride()
  return origin === null ? url : `${origin}${url}`
}

export function apiUrl(path: string): string {
  return `${apiBase()}${normalizePath(path)}`
}

export function authApiPath(path: string): string {
  return `/auth${normalizePath(path)}`
}

export function authApiUrl(path: string): string {
  return apiUrl(authApiPath(path))
}
