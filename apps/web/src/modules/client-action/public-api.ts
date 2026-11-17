// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The token page's only way to the server: POSTs to this origin's public client
// action routes, the token in the JSON body (never a path, a query or a header),
// no cookie. No member session either, except a staff signer's, which the member
// app's own sign tab passes for verify and decide. A network failure reads as the
// `down` frame.

import { apiBase } from "~/lib/env"

export type PublicRoute = "open" | "seen" | "document" | "code" | "verify" | "decide" | "request"

export interface PublicAnswer {
  status: number
  /** The JSON body, or null for an empty or non-JSON answer. */
  body: Record<string, unknown> | null
}

/** Status 0: the server could not be reached at all. */
export const UNREACHABLE: PublicAnswer = { status: 0, body: null }

function url(route: PublicRoute): string {
  return `${apiBase()}/public/client-actions/${route}`
}

function init(body: Record<string, unknown>, bearer?: string | null): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A staff signer's own session, which their verify and decide require.
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  }
}

export async function postPublic(
  route: PublicRoute,
  body: Record<string, unknown>,
  bearer?: string | null,
): Promise<PublicAnswer> {
  let res: Response
  try {
    res = await fetch(url(route), init(body, bearer))
  } catch {
    return UNREACHABLE
  }
  let parsed: Record<string, unknown> | null = null
  try {
    const text = await res.text()
    const v = text ? (JSON.parse(text) as unknown) : null
    parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

/** A file answer (a page picture, the PDF): the bytes, or the JSON refusal. */
export async function postPublicFile(
  body: Record<string, unknown>,
): Promise<{ status: number; blob: Blob | null; body: Record<string, unknown> | null }> {
  let res: Response
  try {
    res = await fetch(url("document"), init(body))
  } catch {
    return { status: 0, blob: null, body: null }
  }
  if (res.ok && !(res.headers.get("content-type") ?? "").includes("application/json")) {
    return { status: res.status, blob: await res.blob(), body: null }
  }
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = (await res.json()) as Record<string, unknown>
  } catch {
    parsed = null
  }
  return { status: res.status, blob: null, body: parsed }
}
