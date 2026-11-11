// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HttpGate — DbTransport over the liaison-db-gate sidecar's HTTP surface.
// probe() diffs GET /catalog against the local adapter's read names
// (missingReads). runRead/runQuery POST with bearer auth, response-size cap,
// and timeouts. Errors are mapped to the SAME typed DbTransportError shapes
// PostgresDirect produces, so the agent sees identical failure shapes
// regardless of which transport is active. https:// required for non-local
// gate URLs (same resolved-IP classifier as PostgresDirect/Task 3).
//
// The gate URL is org data (a credential an app admin types), so every request
// goes through the outbound guard: the host is resolved once and pinned, a
// redirect is never followed, link-local and metadata addresses are refused,
// and the operator's host policy applies as in direct mode (allow-list, the
// instance's own services). A gate on a private or loopback address needs the
// operator's opt-in: its host on LIAISON_DATABASE_ALLOWED_HOSTS, or
// LIAISON_DB_ALLOW_PLAINTEXT_LOCAL=true.

import {
  classifyDsnHost,
  type DnsResolver,
  type ReadCatalog,
  type ReadDefinition,
  TlsRequiredError,
} from "@liaison/db-core"
import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { ownOption } from "~/lib/safe-path"
import type {
  DbTransport,
  ExecOptions,
  ProbeReport,
  RunQueryResult,
  RunReadResult,
  SchemaInfo,
} from "../transport"
import { DbTransportError } from "../transport"
import {
  hostMatchesAllowList,
  isForbiddenResolvedIp,
  namesInstanceService,
  normaliseIp,
} from "./postgres-direct"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024 // 10MB response-size cap

export interface HttpGateOptions {
  gateUrl: string
  gateToken: string
  timeoutMs?: number
  resolveDns?: DnsResolver
  /** Operator opt-in for a gate on a private or loopback address. Off by default. */
  allowPrivate?: boolean
  /** Operator allow-list of gate hosts (`host`, `*.suffix`, IP literal); a listed
   *  host may be private. Empty: any public host passes this step. */
  allowedHosts?: readonly string[]
  /** `host:port` of the instance's own services, never a gate. */
  blockedEndpoints?: readonly string[]
}

const defaultDnsResolver: DnsResolver = async (host: string): Promise<string[]> => {
  const dns = await import("node:dns/promises")
  try {
    const results = await dns.lookup(host, { all: true })
    return results.map((r) => r.address)
  } catch {
    return []
  }
}

export class HttpGate implements DbTransport {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly resolveDns: DnsResolver
  private readonly allowPrivate: boolean
  private readonly allowedHosts: readonly string[]
  private readonly blockedEndpoints: readonly string[]
  /** Set once the host policy passed: whether the request may pin a private address. */
  private privateAllowed: boolean | null = null

  constructor(opts: HttpGateOptions) {
    this.baseUrl = opts.gateUrl.replace(/\/+$/, "")
    this.token = opts.gateToken
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.resolveDns = opts.resolveDns ?? defaultDnsResolver
    this.allowPrivate = ownOption(opts, "allowPrivate") ?? false
    this.allowedHosts = opts.allowedHosts ?? []
    this.blockedEndpoints = (opts.blockedEndpoints ?? []).map((e) => e.toLowerCase())
  }

  /** The host policy, checked once before the first request. Refusals name the
   *  rule, never what the host resolved to. Returns whether a private address
   *  may be pinned. */
  private async assertHostPolicy(): Promise<boolean> {
    if (this.privateAllowed !== null) return this.privateAllowed
    let url: URL
    try {
      url = new URL(this.baseUrl)
    } catch {
      throw new DbTransportError("The db-gate URL is not a valid URL", "config")
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DbTransportError("The db-gate URL must use http or https", "config")
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    const listed = this.allowedHosts.length > 0 && hostMatchesAllowList(host, this.allowedHosts)
    if (this.allowedHosts.length > 0 && !listed) {
      throw new DbTransportError(
        "This db-gate host is not on the allow-list set by the operator (LIAISON_DATABASE_ALLOWED_HOSTS)",
        "config",
      )
    }
    const classification = await classifyDsnHost(host, async (h) =>
      (await this.resolveDns(h)).map(normaliseIp),
    )
    if (classification.resolvedIps.length === 0) {
      throw new DbTransportError(`Could not reach db-gate at ${this.safeHost()}`, "unreachable")
    }
    if (classification.resolvedIps.some(isForbiddenResolvedIp)) {
      throw new DbTransportError(
        "This db-gate host is not allowed: link-local and metadata addresses cannot be reached",
        "config",
      )
    }
    const privateAllowed = this.allowPrivate || listed
    if (classification.kind !== "public" && !privateAllowed) {
      throw new DbTransportError(
        "A db-gate on a private or loopback address needs the operator's opt-in: list its host in LIAISON_DATABASE_ALLOWED_HOSTS",
        "config",
      )
    }
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    if (
      await namesInstanceService(
        port,
        classification.resolvedIps,
        this.blockedEndpoints,
        this.resolveDns,
      )
    ) {
      throw new DbTransportError(
        "This address belongs to a service of this Liaison instance and cannot be used as a db-gate",
        "config",
      )
    }
    if (url.protocol !== "https:" && classification.tlsRequired) {
      throw new TlsRequiredError(url.hostname)
    }
    this.privateAllowed = privateAllowed
    return privateAllowed
  }

  private async request(
    path: string,
    init: RequestInit = {},
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const allowPrivate = await this.assertHostPolicy()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetchWithPinnedHost(
        `${this.baseUrl}${path}`,
        {
          ...init,
          // The caller's abort (the tool call ran out of time) drops the request:
          // the gate owns cancelling its own statement once the client is gone.
          signal: callerSignal
            ? AbortSignal.any([controller.signal, callerSignal])
            : controller.signal,
          headers: {
            ...(init.headers ?? {}),
            authorization: `Bearer ${this.token}`,
          },
        },
        // Resolved once and pinned; a redirect is an error, never a second address.
        { requireHttps: false, allowPrivate, maxRedirects: 0 },
      )
      return res
    } catch (err) {
      if (err instanceof TlsRequiredError) throw err
      if (err instanceof UnsafeOutboundUrlError) {
        throw new DbTransportError(
          err.message.startsWith("Too many redirects")
            ? "db-gate answered with a redirect; redirects are not followed"
            : `db-gate request refused: ${err.message}`,
          "config",
        )
      }
      if (callerSignal?.aborted) {
        throw new DbTransportError(
          "The db-gate request was abandoned: the tool call ran out of time",
          "timeout",
        )
      }
      throw new DbTransportError(`Could not reach db-gate at ${this.safeHost()}`, "unreachable")
    } finally {
      clearTimeout(timeout)
    }
  }

  private safeHost(): string {
    try {
      return new URL(this.baseUrl).host
    } catch {
      return "<gate>"
    }
  }

  private async readJson<T>(res: Response): Promise<T> {
    const text = await res.text()
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new DbTransportError("db-gate response exceeded the size cap", "protocol")
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new DbTransportError("db-gate returned malformed JSON", "protocol")
    }
  }

  async probe(): Promise<ProbeReport> {
    const warnings: string[] = []
    try {
      const healthRes = await this.request("/healthz")
      if (!healthRes.ok) {
        warnings.push(`db-gate /healthz returned ${healthRes.status}`)
        return { ok: false, mode: "gate", warnings }
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
      return { ok: false, mode: "gate", warnings }
    }
    return { ok: warnings.length === 0, mode: "gate", warnings }
  }

  /** Diffs the local adapter's read names against the gate's advertised
   *  catalog, returning any names the gate is missing. */
  async diffCatalog(localCatalog: ReadCatalog): Promise<string[]> {
    const res = await this.request("/catalog", { method: "GET" })
    if (res.status === 401) {
      throw new DbTransportError("db-gate rejected the bearer token", "auth")
    }
    if (!res.ok) {
      throw new DbTransportError(`db-gate /catalog returned ${res.status}`, "protocol")
    }
    const body = await this.readJson<{ reads: Record<string, unknown> }>(res)
    const gateReadNames = new Set(Object.keys(body.reads ?? {}))
    return Object.keys(localCatalog.reads).filter((name) => !gateReadNames.has(name))
  }

  async runRead(
    _read: ReadDefinition,
    readName: string,
    params: Record<string, unknown>,
    opts?: ExecOptions,
  ): Promise<RunReadResult> {
    const start = Date.now()
    const res = await this.request(
      `/read/${encodeURIComponent(readName)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
      },
      opts?.signal,
    )
    if (res.status === 401) throw new DbTransportError("db-gate rejected the bearer token", "auth")
    if (res.status === 404) {
      throw new DbTransportError(`Unknown read "${readName}" on db-gate`, "config")
    }
    if (!res.ok) throw new DbTransportError(`db-gate read failed (${res.status})`, "execution")
    const body = await this.readJson<{ rows: Record<string, unknown>[]; truncated: boolean }>(res)
    return { rows: body.rows, truncated: body.truncated, durationMs: Date.now() - start }
  }

  async runQuery(sql: string, opts?: ExecOptions, params: unknown[] = []): Promise<RunQueryResult> {
    if (params.length > 0) {
      throw new DbTransportError("A db-gate query takes no bound parameters", "config")
    }
    const start = Date.now()
    const res = await this.request(
      "/query",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql }),
      },
      opts?.signal,
    )
    if (res.status === 401) throw new DbTransportError("db-gate rejected the bearer token", "auth")
    if (res.status === 404) {
      throw new DbTransportError("Raw query is disabled on this db-gate", "config")
    }
    if (res.status === 400) {
      const body = await this.readJson<{ error: { message: string } }>(res)
      throw new DbTransportError(body.error.message, "execution")
    }
    if (!res.ok) throw new DbTransportError(`db-gate query failed (${res.status})`, "execution")
    const body = await this.readJson<{ rows: Record<string, unknown>[]; truncated: boolean }>(res)
    return { rows: body.rows, truncated: body.truncated, durationMs: Date.now() - start }
  }

  async describe(catalog: ReadCatalog, table?: string): Promise<SchemaInfo> {
    // The gate never exposes raw information_schema introspection — describe
    // is derived from the LOCAL catalog's declared per-table columns only
    // (same restriction as the bridge's db_describe filtering, Task 6 M1),
    // keyed by the real `schema.table` names each read declares in `tables`
    // — never a synthetic pseudo-table, so db_describe is correctly shaped
    // in gate mode and the bridge's SECRET_COLUMNS filter (keyed by real
    // table name) actually applies.
    const tables = new Map<string, Set<string>>()
    for (const read of Object.values(catalog.reads)) {
      for (const tableRef of read.tables) {
        if (!tables.has(tableRef)) tables.set(tableRef, new Set())
        const cols = tables.get(tableRef)
        // A read's `columns` allow-list may span multiple joined tables; we
        // can't know from the catalog alone which declared column belongs to
        // which of a multi-table read's tables (same limitation the grants
        // renderer documents), so a multi-table read's columns are attributed
        // to every table it touches — over-inclusive, never under, and still
        // strictly derived from declared (non-secret-guarded) catalog data.
        for (const col of read.columns) cols?.add(col)
      }
    }
    const targetTables = table ? (tables.has(table) ? [table] : []) : [...tables.keys()]
    return {
      tables: targetTables.map((t) => ({
        table: t,
        columns: [...(tables.get(t) ?? [])].map((column) => ({ column, dataType: "unknown" })),
      })),
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }
}
