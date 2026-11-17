// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's only way to the server: this origin's `/api/portal/*`
// routes. The access token lives in this module's memory and nowhere else (no
// storage, no cookie a script can read); the refresh token is the server's
// HttpOnly cookie, sent only to the auth routes. A 401 on a data route tries one
// refresh, then reports the session as gone. A network failure reads as status 0.

import { apiBase } from "~/lib/env"

export interface PortalAnswer<T = unknown> {
  status: number
  /** `data` of a success body. */
  data: T | null
  /** The whole JSON body (a refusal's `error`, a decision's state), or null. */
  body: Record<string, unknown> | null
}

let accessToken: string | null = null
let onSessionGone: ((why: "signed_out" | "ended") => void) | null = null

export function setPortalAccessToken(token: string | null): void {
  accessToken = token
}

export function hasPortalSession(): boolean {
  return accessToken !== null
}

/** Called once by the portal root: what to do when the session can no longer be renewed. */
export function onPortalSessionGone(fn: ((why: "signed_out" | "ended") => void) | null): void {
  onSessionGone = fn
}

function url(path: string): string {
  return `${apiBase()}/portal${path}`
}

async function parse(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text()
    const v = text ? (JSON.parse(text) as unknown) : null
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function answer<T>(status: number, body: Record<string, unknown> | null): PortalAnswer<T> {
  const data = body && "data" in body ? (body.data as T) : null
  return { status, data, body }
}

/** A public or cookie route of `/api/portal/auth`: no access token, the cookie same-origin only. */
export async function portalAuthPost<T = unknown>(
  route: "request" | "verify" | "totp" | "refresh" | "logout",
  body: Record<string, unknown> = {},
): Promise<PortalAnswer<T>> {
  let res: Response
  try {
    res = await fetch(url(`/auth/${route}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
  } catch {
    return { status: 0, data: null, body: null }
  }
  return answer<T>(res.status, await parse(res))
}

export interface Branding {
  name: string | null
  logoUrl: string | null
  notice: string | null
}

export async function portalBranding(slug: string): Promise<Branding | null> {
  try {
    const res = await fetch(url(`/auth/branding/${encodeURIComponent(slug)}`), {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
    const body = await parse(res)
    return res.ok && body && body.data ? (body.data as Branding) : null
  } catch {
    return null
  }
}

/** Renews the access token from the refresh cookie. True when signed in again. */
export async function refreshPortalSession(): Promise<boolean> {
  const out = await portalAuthPost<{ accessToken?: string }>("refresh")
  if (out.status === 409) {
    // Another tab renewed first: its cookie is the live one now; try once more.
    const again = await portalAuthPost<{ accessToken?: string }>("refresh")
    if (again.status === 200 && again.data?.accessToken) {
      accessToken = again.data.accessToken
      return true
    }
    return false
  }
  if (out.status === 200 && out.data?.accessToken) {
    accessToken = out.data.accessToken
    return true
  }
  return false
}

/** A 401 that is about the decision (a code is needed), not about the session. */
function isDecisionRefusal(body: Record<string, unknown> | null): boolean {
  const err = body?.error as { code?: unknown } | undefined
  return err?.code === "code_required"
}

function endedRefusal(body: Record<string, unknown> | null): boolean {
  const err = body?.error as { code?: unknown } | undefined
  return err?.code === "PORTAL_ACCESS_ENDED"
}

async function send(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown> | FormData,
): Promise<Response | null> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  if (body && !(body instanceof FormData)) headers["content-type"] = "application/json"
  try {
    return await fetch(url(path), {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
  } catch {
    return null
  }
}

/** A data route, with the access token; one refresh on a session 401. */
export async function portalCall<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown> | FormData,
): Promise<PortalAnswer<T>> {
  let res = await send(method, path, body)
  if (!res) return { status: 0, data: null, body: null }
  if (res.status === 401) {
    const first = await parse(res)
    if (isDecisionRefusal(first)) return answer<T>(401, first)
    if (endedRefusal(first)) {
      accessToken = null
      onSessionGone?.("ended")
      return answer<T>(401, first)
    }
    if (!(await refreshPortalSession())) {
      accessToken = null
      onSessionGone?.("signed_out")
      return answer<T>(401, first)
    }
    res = await send(method, path, body)
    if (!res) return { status: 0, data: null, body: null }
    if (res.status === 401) {
      const again = await parse(res)
      if (isDecisionRefusal(again)) return answer<T>(401, again)
      accessToken = null
      onSessionGone?.(endedRefusal(again) ? "ended" : "signed_out")
      return answer<T>(401, again)
    }
  }
  return answer<T>(res.status, await parse(res))
}

export const portalGet = <T = unknown>(path: string) => portalCall<T>("GET", path)
export const portalPost = <T = unknown>(path: string, body: Record<string, unknown> | FormData) =>
  portalCall<T>("POST", path, body)

/**
 * A file route (an invoice PDF, a shared file): fetched with the token, handed to
 * the browser as a download. No signed URL is ever asked for or shown.
 */
export async function portalDownload(path: string, filename: string): Promise<boolean> {
  let res = await send("GET", path)
  if (res?.status === 401 && (await refreshPortalSession())) res = await send("GET", path)
  if (!res || !res.ok) return false
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.rel = "noopener"
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
  return true
}

/** A page picture as an object URL for an <img>, or null. */
export async function portalBlob(path: string): Promise<string | null> {
  let res = await send("GET", path)
  if (res?.status === 401 && (await refreshPortalSession())) res = await send("GET", path)
  if (!res || !res.ok) return null
  return URL.createObjectURL(await res.blob())
}

export async function signOutOfPortal(): Promise<void> {
  accessToken = null
  await portalAuthPost("logout")
}
