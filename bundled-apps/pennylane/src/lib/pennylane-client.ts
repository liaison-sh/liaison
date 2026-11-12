// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane external-v2 client. Host-free: constructor-injected with a `fetch`
// shaped like `ctx.fetch` (`(url,{method,headers,body,timeoutMs}) → {status,headers,body}`).
// NEVER imports node:* — the bundle runs in QuickJS.
//
// Writes: JSON `post`/`put` and `postMultipart` (the host assembles the multipart body from
// text fields and kernel file ids; the bytes never enter the sandbox).
//
// Rate limit (25 requests / 5 s per token): every answer carries `ratelimit-remaining` and
// `ratelimit-reset` (absolute epoch seconds). The sandbox has no timers, so the client cannot
// wait: when the budget is spent it refuses BEFORE sending with a retryable
// `PennylaneRateLimitError` naming when to come back, and a 429 becomes the same error with the
// `retry-after` delay. Callers that run on a schedule (the transmission job) stop for this tick
// and resume on the next; nothing is replayed blindly.
import type { Filter, Page } from "../types"

const BASE = "https://app.pennylane.com/api/external/v2"
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50
const ERROR_BODY_MAX = 2048

export type PennylaneMultipartPart =
  | { name: string; value: string }
  | {
      name: string
      fileId: string
      filename?: string
      contentType?: string
      expectSha256?: string
      /** The host refuses unless the uploaded PDF embeds a file `name` whose content is exactly `text`. */
      expectEmbeddedFile?: { name: string; text: string }
      /** File parents the host refuses to send from (`file_parent_refused`, nothing sent). */
      refuseParents?: Array<{ app: string; entityType: string }>
    }

export type PennylaneFetch = (
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: string | { multipart: PennylaneMultipartPart[] }
    timeoutMs?: number
  },
) => Promise<{
  status: number
  headers: Record<string, string>
  body: string
  upload?: {
    size: number
    parts: Array<{ name: string; size: number; sha256: string; fileId?: string }>
  }
}>

const ERROR_MESSAGE_DETAIL_MAX = 300

/**
 * Pennylane's own explanation from an error body, for the error message (and so the logs).
 * The v2 API answers `{error, status}` or `{message, field?, code?, payload?}`; anything else
 * (HTML, plain text) is used as-is. Whitespace is collapsed and the result truncated.
 */
export function pennylaneErrorDetail(body: string): string {
  let detail = body
  try {
    const j = JSON.parse(body) as Record<string, unknown>
    if (j && typeof j === "object") {
      const text =
        typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : null
      if (text !== null) {
        const extra = [
          typeof j.field === "string" ? `field ${j.field}` : null,
          typeof j.code === "string" ? `code ${j.code}` : null,
        ].filter(Boolean)
        detail = extra.length ? `${text} (${extra.join(", ")})` : text
      }
    }
  } catch {
    // Not JSON: keep the raw text.
  }
  detail = detail.replace(/\s+/g, " ").trim()
  return detail.length > ERROR_MESSAGE_DETAIL_MAX
    ? `${detail.slice(0, ERROR_MESSAGE_DETAIL_MAX)}…`
    : detail
}

export class PennylaneApiError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body = "") {
    const detail = pennylaneErrorDetail(body)
    super(detail ? `Pennylane ${status}: ${detail}` : `Pennylane ${status}`)
    this.name = "PennylaneApiError"
    this.status = status
    this.body = body.length > ERROR_BODY_MAX ? `${body.slice(0, ERROR_BODY_MAX)}…` : body
  }
}

/** The per-token budget is spent: come back at `retryAtMs` (epoch ms). Retryable, never a fault. */
export class PennylaneRateLimitError extends PennylaneApiError {
  readonly retryAtMs: number
  constructor(retryAtMs: number, body = "") {
    super(429, body)
    this.name = "PennylaneRateLimitError"
    this.message = `Pennylane rate limit reached; retry after ${new Date(retryAtMs).toISOString()}`
    this.retryAtMs = retryAtMs
  }
}

export interface PennylaneClientOptions {
  fetch: PennylaneFetch
  apiToken: string
  baseUrl?: string
  /** Sent as `X-Company-Id` (required with a firm token, ignored otherwise). */
  companyId?: string | null
  /** Clock (tests). */
  now?: () => number
}

export interface PennylaneResponse {
  status: number
  body: string
  headers: Record<string, string>
  upload?: {
    size: number
    parts: Array<{ name: string; size: number; sha256: string; fileId?: string }>
  }
}

export class PennylaneClient {
  private readonly fetchImpl: PennylaneFetch
  private readonly apiToken: string
  private readonly base: string
  private readonly companyId: string | null
  private readonly now: () => number
  private remaining: number | null = null
  private resetAtMs = 0

  constructor(opts: PennylaneClientOptions) {
    this.fetchImpl = opts.fetch
    this.apiToken = opts.apiToken
    this.base = opts.baseUrl ?? BASE
    this.companyId = opts.companyId ?? null
    this.now = opts.now ?? (() => Date.now())
  }

  /** The credential for a host-side file download from the API host (first hop only). */
  downloadAuthorization(): string {
    return `Bearer ${this.apiToken}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: "application/json",
      ...(this.companyId ? { "X-Company-Id": this.companyId } : {}),
      ...extra,
    }
  }

  private noteBudget(headers: Record<string, string>): void {
    const h = (k: string) => headers[k] ?? headers[k.toLowerCase()]
    const rem = Number(h("ratelimit-remaining"))
    if (Number.isFinite(rem)) this.remaining = rem
    const reset = Number(h("ratelimit-reset"))
    if (Number.isFinite(reset) && reset > 0) {
      // Pennylane sends an absolute epoch-seconds value; tolerate a delta just in case.
      this.resetAtMs = reset > 1_000_000_000 ? reset * 1000 : this.now() + reset * 1000
    }
  }

  /** An error body is logged: never let it carry our own credential back out. */
  private redact(body: string): string {
    return this.apiToken ? body.split(this.apiToken).join("[redacted]") : body
  }

  /** One request. Refuses up front when the budget is spent; a 429 becomes a typed retryable
   *  error; any other status ≥ 400 throws PennylaneApiError (body truncated to 2 KB). */
  async request(
    method: string,
    path: string,
    body?: string | { multipart: PennylaneMultipartPart[] },
    opts: { contentType?: string; timeoutMs?: number } = {},
  ): Promise<PennylaneResponse> {
    if (this.remaining !== null && this.remaining <= 0 && this.now() < this.resetAtMs) {
      throw new PennylaneRateLimitError(this.resetAtMs)
    }
    const url = path.startsWith("http") ? path : `${this.base}${path}`
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(opts.contentType ? { "Content-Type": opts.contentType } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    })
    this.noteBudget(res.headers ?? {})
    if (res.status === 429) {
      const ra = Number((res.headers ?? {})["retry-after"])
      const at =
        Number.isFinite(ra) && ra > 0
          ? this.now() + ra * 1000
          : Math.max(this.resetAtMs, this.now() + 1000)
      this.remaining = 0
      this.resetAtMs = at
      throw new PennylaneRateLimitError(at, this.redact(res.body ?? ""))
    }
    if (res.status >= 400) throw new PennylaneApiError(res.status, this.redact(res.body ?? ""))
    return {
      status: res.status,
      body: res.body,
      headers: res.headers ?? {},
      ...(res.upload ? { upload: res.upload } : {}),
    }
  }

  /** One cursor page. `params` carries endpoint-specific query params (e.g. trial_balance's
   *  required `period_start`/`period_end`). */
  async list<T>(
    path: string,
    q: {
      cursor?: string
      limit?: number
      filter?: Filter[]
      sort?: string
      params?: Record<string, string>
    } = {},
  ): Promise<Page<T>> {
    const params: string[] = []
    for (const [k, v] of Object.entries(q.params ?? {}))
      params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    if (q.cursor) params.push(`cursor=${encodeURIComponent(q.cursor)}`)
    params.push(`limit=${Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT)}`)
    if (q.filter?.length) params.push(`filter=${encodeURIComponent(JSON.stringify(q.filter))}`)
    if (q.sort) params.push(`sort=${encodeURIComponent(q.sort)}`)
    const { body } = await this.request("GET", `${path}?${params.join("&")}`)
    const j = JSON.parse(body) as { items?: T[]; next_cursor?: string | null; has_more?: boolean }
    return {
      items: j.items ?? [],
      next_cursor: j.next_cursor ?? null,
      has_more: Boolean(j.has_more),
    }
  }

  async get<T>(path: string): Promise<T> {
    const { body } = await this.request("GET", path)
    return JSON.parse(body) as T
  }

  async post<T>(path: string, json: unknown): Promise<{ status: number; data: T }> {
    const res = await this.request("POST", path, JSON.stringify(json), {
      contentType: "application/json",
    })
    return { status: res.status, data: (res.body ? JSON.parse(res.body) : null) as T }
  }

  async put<T>(path: string, json: unknown): Promise<{ status: number; data: T }> {
    const res = await this.request("PUT", path, JSON.stringify(json), {
      contentType: "application/json",
    })
    return { status: res.status, data: (res.body ? JSON.parse(res.body) : null) as T }
  }

  /** POST with no body (e.g. `send_to_pa`): the status is the answer (204, 409, 422 …). */
  async postEmpty(path: string): Promise<PennylaneResponse> {
    return this.request("POST", path)
  }

  async postMultipart<T>(
    path: string,
    parts: PennylaneMultipartPart[],
    timeoutMs = 90_000,
  ): Promise<{ status: number; data: T; upload: PennylaneResponse["upload"] }> {
    const res = await this.request("POST", path, { multipart: parts }, { timeoutMs })
    return {
      status: res.status,
      data: (res.body ? JSON.parse(res.body) : null) as T,
      upload: res.upload,
    }
  }
}
