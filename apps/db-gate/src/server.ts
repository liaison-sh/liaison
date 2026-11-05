// SPDX-License-Identifier: FSL-1.1-ALv2
//
// db-gate HTTP server. Routes:
//   GET  /healthz         — the ONLY unauthenticated route, bare liveness
//   GET  /catalog          — bearer-gated, read names/descriptions/params/columns (never SQL text)
//   POST /read/{name}      — bearer-gated, {params} -> curated read
//   POST /query             — bearer-gated, {sql} -> raw query, 404-shaped "disabled" unless DB_GATE_ALLOW_QUERY
//
// Every request logged (JSON line to stdout): name/params-hash/rows/duration/
// caller-ip — never SQL results or DSN. Per-token sliding-window rate limit.

import { createHash, timingSafeEqual } from "node:crypto"
import { assertReadOnlySelect, type ReadCatalog, SqlGuardError } from "@liaison/db-core"
import type { DbGateConfig } from "./config"
import type { GateDb } from "./gate-db"

export interface RateLimitOptions {
  windowMs: number
  maxRequests: number
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 10_000, maxRequests: 30 }

class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly opts: RateLimitOptions) {}

  /** Returns true if the request is allowed (and records it); false if rate-limited. */
  check(key: string, now = Date.now()): boolean {
    const windowStart = now - this.opts.windowMs
    const existing = (this.hits.get(key) ?? []).filter((t) => t > windowStart)
    if (existing.length >= this.opts.maxRequests) {
      this.hits.set(key, existing)
      return false
    }
    existing.push(now)
    this.hits.set(key, existing)
    return true
  }
}

function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Still do a constant-time-ish compare against a same-length dummy to
    // avoid a length-based timing signal on the common wrong-length case.
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function paramsHash(params: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 16)
}

function logLine(entry: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: structured request log, by design (stdout, never SQL/DSN)
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }))
}

export interface DbGateServerDeps {
  config: DbGateConfig
  catalog: ReadCatalog
  db: GateDb
  rateLimit?: RateLimitOptions
}

export function createDbGateHandler(deps: DbGateServerDeps): (req: Request) => Promise<Response> {
  const limiter = new SlidingWindowRateLimiter(deps.rateLimit ?? DEFAULT_RATE_LIMIT)

  function checkAuth(req: Request): boolean {
    const header = req.headers.get("authorization") ?? ""
    const match = /^Bearer (.+)$/.exec(header)
    if (!match) return false
    return timingSafeTokenEqual(match[1], deps.config.token)
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (url.pathname === "/healthz") {
      // Bare liveness only — no version/catalog/config info leaked, and the
      // ONLY unauthenticated route.
      return new Response("ok", { status: 200 })
    }

    if (!checkAuth(req)) {
      return jsonResponse({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)
    }

    const callerIp = req.headers.get("x-forwarded-for") ?? "unknown"
    const rateLimitKey = req.headers.get("authorization") ?? callerIp
    if (!limiter.check(rateLimitKey)) {
      return jsonResponse({ error: { message: "Rate limit exceeded", code: "rate_limited" } }, 429)
    }

    if (url.pathname === "/catalog" && req.method === "GET") {
      const reads = Object.fromEntries(
        Object.entries(deps.catalog.reads).map(([name, read]) => [
          name,
          {
            description: read.description,
            domain: read.domain,
            params: read.params,
            columns: read.columns,
          },
        ]),
      )
      return jsonResponse({ adapter: deps.catalog.adapter, reads })
    }

    if (url.pathname.startsWith("/read/") && req.method === "POST") {
      const name = decodeURIComponent(url.pathname.slice("/read/".length))
      const read = deps.catalog.reads[name]
      if (!read) {
        return jsonResponse(
          {
            error: {
              message: `Unknown read "${name}"`,
              code: "unknown_read",
              validNames: Object.keys(deps.catalog.reads),
            },
          },
          404,
        )
      }
      let body: { params?: Record<string, unknown> }
      try {
        body = (await req.json()) as { params?: Record<string, unknown> }
      } catch {
        return jsonResponse({ error: { message: "Malformed JSON body", code: "bad_request" } }, 400)
      }
      const params = body.params ?? {}
      const start = Date.now()
      try {
        const result = await deps.db.runRead(read, params)
        logLine({
          route: "read",
          name,
          paramsHash: paramsHash(params),
          rows: result.rows.length,
          durationMs: result.durationMs,
          callerIp,
        })
        return jsonResponse({ rows: result.rows, truncated: result.truncated })
      } catch (err) {
        logLine({
          route: "read",
          name,
          paramsHash: paramsHash(params),
          durationMs: Date.now() - start,
          callerIp,
          error: true,
        })
        return jsonResponse(
          { error: { message: "Read execution failed", code: "execution_error" } },
          500,
        )
      }
    }

    if (url.pathname === "/query" && req.method === "POST") {
      if (!deps.config.allowQuery) {
        return jsonResponse({ error: { message: "Raw query is disabled", code: "disabled" } }, 404)
      }
      let body: { sql?: string }
      try {
        body = (await req.json()) as { sql?: string }
      } catch {
        return jsonResponse({ error: { message: "Malformed JSON body", code: "bad_request" } }, 400)
      }
      const sqlText = body.sql ?? ""
      const start = Date.now()
      try {
        assertReadOnlySelect(sqlText)
      } catch (err) {
        logLine({ route: "query", callerIp, blocked: true, reason: (err as SqlGuardError).code })
        return jsonResponse(
          {
            error: {
              message: err instanceof SqlGuardError ? err.message : "Query rejected",
              code: err instanceof SqlGuardError ? err.code : "rejected",
            },
          },
          400,
        )
      }
      try {
        const result = await deps.db.runQuery(sqlText)
        logLine({
          route: "query",
          paramsHash: paramsHash(sqlText),
          rows: result.rows.length,
          durationMs: result.durationMs,
          callerIp,
        })
        return jsonResponse({ rows: result.rows, truncated: result.truncated })
      } catch (err) {
        logLine({
          route: "query",
          durationMs: Date.now() - start,
          callerIp,
          error: true,
        })
        return jsonResponse(
          { error: { message: "Query execution failed", code: "execution_error" } },
          500,
        )
      }
    }

    return jsonResponse({ error: { message: "Not found", code: "not_found" } }, 404)
  }
}
