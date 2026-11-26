// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The HTTPS client: one signed-in profile, its access token, a refresh when the
// token is near its end or the server answers 401, the new refresh cookie
// stored at once (the server rotates it on every refresh).

import { type Credentials, readCredentials, writeCredentials } from "./store"

export const CLI_VERSION = "0.1.0"
const USER_AGENT = `liaison-cli/${CLI_VERSION}`

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
  }
}

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** A host as typed: `acme.example.com` -> `https://acme.example.com`, no trailing slash. */
export function normalizeHost(raw: string): string {
  let host = raw.trim()
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`
  const url = new URL(host)
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new CliError(`Refusing plain http for ${url.hostname}: use https://`)
  }
  return `${url.protocol}//${url.host}`
}

/** The claims of an access token, read without verifying (the server verifies). */
export function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The refresh cookie among a response's Set-Cookie headers (a non-empty `*liaison_rt`). */
export function refreshCookieFrom(res: Response): { name: string; value: string } | undefined {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
  for (const line of all) {
    const pair = line.split(";")[0] ?? ""
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name.endsWith("liaison_rt") && value) return { name, value }
  }
  return undefined
}

async function readError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "")
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; code?: string; details?: unknown }
    }
    if (body.error?.message) {
      return new ApiError(res.status, body.error.message, body.error.code, body.error.details)
    }
  } catch {}
  return new ApiError(
    res.status,
    `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
  )
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>
  /** Return the raw status with the data (202 vs 200). */
  withStatus?: boolean
}

export class Client {
  private creds: Credentials

  constructor(
    readonly profile: string,
    readonly host: string,
    creds?: Credentials,
  ) {
    const found = creds ?? readCredentials(profile)
    if (!found) {
      throw new CliError(
        `Not signed in to ${host} (profile ${profile}). Run: liaison login --host ${host}`,
      )
    }
    this.creds = found
  }

  get scopes(): string[] {
    const s = tokenClaims(this.creds.accessToken).scopes
    return Array.isArray(s) ? (s as string[]) : []
  }

  get claims(): Record<string, unknown> {
    return tokenClaims(this.creds.accessToken)
  }

  /** Refresh when the token ends in less than a minute. */
  private async fresh(): Promise<string> {
    const exp = Number(tokenClaims(this.creds.accessToken).exp ?? 0)
    if (exp && exp * 1000 - Date.now() < 60_000) await this.refresh()
    return this.creds.accessToken
  }

  async refresh(): Promise<void> {
    const cookie = this.creds.refreshCookie
    if (!cookie) {
      throw new CliError(
        `The sign-in to ${this.host} expired. Run: liaison login --host ${this.host}`,
      )
    }
    const res = await fetch(`${this.host}/api/auth/refresh`, {
      method: "POST",
      headers: {
        cookie: `${cookie.name}=${cookie.value}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: "{}",
    })
    if (!res.ok) {
      throw new CliError(
        `The sign-in to ${this.host} ended (${res.status}). Run: liaison login --host ${this.host}`,
      )
    }
    const body = (await res.json()) as { data?: { accessToken?: string } }
    if (!body.data?.accessToken) throw new CliError("The refresh answer carried no token")
    this.creds = {
      ...this.creds,
      accessToken: body.data.accessToken,
      refreshCookie: refreshCookieFrom(res) ?? cookie,
    }
    writeCredentials(this.profile, this.creds)
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const out = await this.requestWithStatus<T>(method, path, body, opts)
    return out.data
  }

  async requestWithStatus<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<{ status: number; data: T }> {
    const url = new URL(`${this.host}${path}`)
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v))
    const send = async () =>
      fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${await this.fresh()}`,
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    let res = await send()
    if (res.status === 401 && this.creds.refreshCookie) {
      await this.refresh()
      res = await send()
    }
    if (!res.ok) throw await readError(res)
    const json = (await res.json().catch(() => ({}))) as { data?: T }
    return { status: res.status, data: json.data as T }
  }

  /** A tool run through `POST /api/apps/tools/<app>:<tool>` (a gated tool parks a card). */
  async tool<T = unknown>(name: string, params: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", `/api/apps/tools/${encodeURIComponent(name)}`, { params })
  }
}

/** Unauthenticated JSON call (the device flow). */
export async function publicRequest<T>(
  host: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ res: Response; data: T }> {
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      "user-agent": USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok && res.status !== 429) throw await readError(res)
  const json = (await res.json().catch(() => ({}))) as { data?: T }
  return { res, data: json.data as T }
}
