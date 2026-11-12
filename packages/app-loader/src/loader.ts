// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app loader: runs one app export in a dynamic worker per signed `/run`
// from a cell. Pure request handling; every platform object is injected, so
// one source serves every host:
//
//   loader     `LOADER.get(id, getCode)`: a Worker Loader binding on Workers,
//              workerd's own loader in the self-hosted sandbox, an in-process
//              stand-in in tests
//   bundles    the content-addressed module cache (an object bucket, a
//              directory, a map)
//   cells      the cell table `{cellId: {key, bridgeOrigin}}`
//   makeBridge the per-run bridge capability handed to the isolate
//   makeTail   optional per-worker tail (usage metering)
//
// Flow of one `POST /run`: the cell's v2 signature (sign.ts) -> body checks
// (protocol.ts) -> bridgeUrl origin == the cell's registered origin (403) ->
// the module by key from `bundles`, else fetched from the cell (signed
// loader->cell, capped, re-hashed, then stored) -> sha256 re-check -> one
// dynamic worker per id, env empty, no outbound network, capped limits -> a
// fresh execNonce and bridge per run -> `run(req, bridge)` raced against the
// deadline -> the module's verdict passed through with the loader's timings,
// or a failure with its kind. Anything the loader itself throws is
// `loader_internal`, never a kindless 500.

import { type BridgeProps, runStats } from "./bridge"
import {
  bundleKey,
  COMPATIBILITY_DATE,
  cellBundlePath,
  deadlineDuration,
  dynamicWorkerId,
  type ErrorKind,
  fail,
  MAX_FETCHED_BUNDLE_BYTES,
  type RunBody,
  runLimits,
  START_PROBE_METHOD,
  START_PROBE_MS,
  validateRunBody,
  type WorkerRunRequest,
} from "./protocol"
import {
  CELL_ID_HEADER,
  CELL_SIGNATURE_HEADER,
  CELL_SIGNATURE_VERSION_HEADER,
  CELL_TS_HEADER,
  sha256Hex,
  signCellRequestV2,
  verifyCellRequestV2,
} from "./sign"

export interface WorkerCode {
  compatibilityDate: string
  mainModule: string
  modules: Record<string, string>
  env: Record<string, unknown>
  globalOutbound: null
  limits: { cpuMs: number; subRequests: number }
  tails?: unknown[]
}
export interface EntrypointLike {
  run(req: unknown, bridge: unknown): Promise<unknown>
}
export interface LoadedWorker {
  getEntrypoint(name?: string): EntrypointLike
}
export interface LoaderLike {
  get(id: string, getCode: () => WorkerCode | Promise<WorkerCode>): LoadedWorker
}

/** The content-addressed module cache. Only bytes that hash to their key are ever put. */
export interface BundleStore {
  get(key: string): Promise<ArrayBuffer | Uint8Array | null>
  put(key: string, bytes: ArrayBuffer | Uint8Array): Promise<void>
}

export type CellEntry = { key: string; bridgeOrigin: string }
export type CellTable = Record<string, CellEntry>

/** What is constant per dynamic worker id (a tail's props are frozen at its first build). */
export interface WorkerIdentity {
  cellId: string
  orgId: string
  app: string
  version: string
}

export interface LoaderPlatform {
  loader: LoaderLike
  bundles: BundleStore
  /** The cell table, or null when it is not configured or malformed (every request: 500). */
  cells(): CellTable | null
  now(): number
  makeBridge(props: BridgeProps): unknown
  makeTail?(identity: WorkerIdentity): unknown
  randomBytes?(n: number): Uint8Array
  /** The module fetch from a cell (global fetch by default). */
  fetch?(url: string, init: RequestInit): Promise<Response>
  /**
   * Verified module text per dynamic worker id (content-addressed, so never
   * stale). A host that builds a loader per request (its platform objects are
   * per request) passes one map that outlives them; default: one per loader.
   */
  verified?: Map<string, string>
}

export interface AppLoader {
  /** `/health` and `POST /run`; any other path is 404. */
  handle(req: Request): Promise<Response>
  /** Drop every verified module text (tests; a host that evicts a module). */
  clearVerified(): void
}

/** At most this many verified module texts are kept per loader instance. */
const VERIFIED_MAX = 16

/** Module evaluation / entrypoint failures (the bundle itself is broken), not handler errors. */
const LOAD_RE =
  /^SyntaxError|script startup|failed to (load|start)|no such module|does not provide an export|entrypoint .*(not found|does not exist)|\.run is not a function/i
const LIMIT_RE =
  /exceeded (its )?(cpu|memory)|cpu time limit|too many subrequests|subrequest limit|exceeded.*limit/i

/** The cell table from its JSON form, or null when malformed (a key shorter than 16 chars included). */
export function parseCellTable(raw: string | undefined): CellTable | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== "object" || Array.isArray(v)) return null
    for (const e of Object.values(v) as CellEntry[]) {
      if (
        !e ||
        typeof e.key !== "string" ||
        e.key.length < 16 ||
        typeof e.bridgeOrigin !== "string"
      ) {
        return null
      }
    }
    return v
  } catch {
    return null
  }
}

export type Authenticated = { cellId: string; cell: CellEntry; signature: string }

/**
 * A cell->loader v2 signature over METHOD + `signedPath` (a GET signs its
 * query too) + body: the cell, or the failure answer (401 auth, 500 when the
 * table is missing).
 */
export async function authenticateCellRequest(
  req: Request,
  signedPath: string,
  raw: Uint8Array,
  cells: CellTable | null,
  now: number,
): Promise<Authenticated | Response> {
  if (!cells) return fail(500, "loader_internal", "loader misconfigured")
  const cellId = req.headers.get(CELL_ID_HEADER)
  const cell = cellId && Object.hasOwn(cells, cellId) ? cells[cellId] : undefined
  if (!cellId || !cell) return fail(401, "auth", "unknown cell")
  const signature = req.headers.get(CELL_SIGNATURE_HEADER)
  const v = await verifyCellRequestV2({
    cellKey: cell.key,
    direction: "cell->loader",
    method: req.method,
    path: signedPath,
    ts: req.headers.get(CELL_TS_HEADER),
    signature,
    version: req.headers.get(CELL_SIGNATURE_VERSION_HEADER),
    body: raw,
    now,
  })
  if (!v.ok) return fail(401, "auth", `signature rejected: ${v.reason}`)
  return { cellId, cell, signature: signature as string }
}

/** Anything the loader itself throws is `loader_internal`, never a kindless 500. */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    return fail(500, "loader_internal", `loader error: ${errorMessage(e)}`)
  }
}

export function createAppLoader(platform: LoaderPlatform): AppLoader {
  const verifiedText = platform.verified ?? new Map<string, string>()

  async function handleRun(req: Request, url: URL): Promise<Response> {
    const t0 = platform.now()
    const raw = new Uint8Array(await req.arrayBuffer())
    const a = await authenticateCellRequest(
      req,
      url.pathname,
      raw,
      platform.cells(),
      platform.now(),
    )
    if (a instanceof Response) return a
    const { cellId, cell } = a

    let body: RunBody
    try {
      body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return fail(400, "loader_internal", "body is not JSON", { code: "bad_request" })
    }
    const invalid = validateRunBody(body)
    if (invalid) return fail(400, "loader_internal", invalid, { code: "bad_request" })
    let origin: string
    try {
      origin = new URL(body.bridgeUrl).origin
    } catch {
      return fail(400, "loader_internal", "invalid bridgeUrl", { code: "bad_request" })
    }
    if (origin !== cell.bridgeOrigin) {
      return fail(403, "auth", "bridgeUrl origin not allowed for this cell")
    }

    const id = dynamicWorkerId(cellId, body)
    let text = verifiedText.get(id)
    if (text === undefined) {
      const key = bundleKey(body)
      const stored = await platform.bundles.get(key)
      let bytes: ArrayBuffer | Uint8Array
      if (stored) {
        bytes = stored
        if ((await sha256Hex(bytes)) !== body.sha256) {
          return fail(409, "load", "bundle hash mismatch", { code: "hash_mismatch" })
        }
      } else {
        const fetched = await fetchFromCell(cellId, cell, body.sha256)
        if (fetched instanceof Response) return fetched
        bytes = fetched
        // Verified before it is stored: the store only ever holds bytes that hash to their key.
        if ((await sha256Hex(bytes)) !== body.sha256) {
          return fail(409, "load", "bundle hash mismatch", { code: "hash_mismatch" })
        }
        await platform.bundles.put(key, bytes)
      }
      text = new TextDecoder().decode(bytes)
      if (verifiedText.size >= VERIFIED_MAX) {
        verifiedText.delete(verifiedText.keys().next().value as string)
      }
      verifiedText.set(id, text)
    }
    const code = text
    const limits = runLimits(body)
    let cold = false
    const identity: WorkerIdentity = {
      cellId,
      orgId: body.orgId,
      app: body.app,
      version: body.version,
    }
    // Everything before the entrypoint's run starts (LOADER.get, its factory,
    // getEntrypoint, the module's evaluation) is the module's to fail: kind
    // `load`, never `handler`.
    let worker: LoadedWorker
    try {
      worker = platform.loader.get(id, () => {
        cold = true
        const wc: WorkerCode = {
          compatibilityDate: COMPATIBILITY_DATE,
          mainModule: "worker.js",
          modules: { "worker.js": code },
          env: {},
          globalOutbound: null,
          limits,
        }
        if (platform.makeTail) wc.tails = [platform.makeTail(identity)]
        return wc
      })
    } catch (e) {
      return Response.json({
        ok: false,
        error: { message: errorMessage(e), kind: "load" },
        timings: { loadMs: platform.now() - t0, cold },
      })
    }
    const loadMs = platform.now() - t0

    const random = platform.randomBytes
      ? platform.randomBytes(16)
      : crypto.getRandomValues(new Uint8Array(16))
    const execNonce = base64url(random)
    runStats.set(execNonce, { calls: 0, ms: 0 })
    const bridge = platform.makeBridge({
      bridgeUrl: body.bridgeUrl,
      runToken: body.runToken,
      runId: body.runId,
      execNonce,
      bridgeMethods: body.bridgeMethods,
    })
    // The worker never sees the token or the bridge URL.
    const workerReq: WorkerRunRequest = {
      runId: body.runId,
      orgId: body.orgId,
      app: body.app,
      version: body.version,
      exportName: body.exportName,
      params: body.params,
      extraArgs: body.extraArgs ?? [],
      approval: body.approval ?? null,
      bridgeMethods: body.bridgeMethods,
    }

    const t1 = platform.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const TIMEOUT = Symbol("timeout")
    const timings = () => {
      const s = runStats.get(execNonce) ?? { calls: 0, ms: 0 }
      return { loadMs, runMs: platform.now() - t1, bridgeCalls: s.calls, bridgeMsTotal: s.ms, cold }
    }
    try {
      let entry: EntrypointLike
      try {
        entry = worker.getEntrypoint()
      } catch (e) {
        return Response.json({
          ok: false,
          error: { message: errorMessage(e), kind: "load" },
          timings: timings(),
        })
      }
      const outcome = await Promise.race([
        entry.run(workerReq, bridge),
        new Promise<typeof TIMEOUT>((r) => {
          timer = setTimeout(() => r(TIMEOUT), deadlineDuration(body.deadlineMs, platform.now()))
        }),
      ])
      if (outcome === TIMEOUT) {
        return Response.json({
          ok: false,
          error: { message: "App execution timed out", kind: "timeout" },
          timings: timings(),
        })
      }
      // The product's worker module answers {ok, result|error, timings}: its
      // verdict passes through with the loader's timings. Anything else is a bare result.
      if (isRunVerdict(outcome)) return verdictAnswer(outcome, timings())
      return Response.json({
        ok: true,
        result: outcome === undefined ? null : outcome,
        timings: timings(),
      })
    } catch (e) {
      const err = e as { status?: unknown; code?: unknown }
      const message = errorMessage(e)
      let kind: ErrorKind = LIMIT_RE.test(message)
        ? "limit"
        : LOAD_RE.test(message)
          ? "load"
          : "handler"
      // The product's module never rejects run (it answers a verdict), so a
      // rejection is the module's start (its evaluation threw) or a bare
      // module's own handler. A probe call tells them apart: a module that
      // failed to start fails every call with the same error.
      if (kind === "handler" && (await failsToStart(worker, message))) kind = "load"
      const error: Record<string, unknown> = { message, kind }
      if (typeof err?.status === "number") error.status = err.status
      if (typeof err?.code === "string") error.code = err.code
      return Response.json({ ok: false, error, timings: timings() })
    } finally {
      if (timer) clearTimeout(timer)
      runStats.delete(execNonce)
    }
  }

  /** GET <bridgeOrigin>/api/app-bridge/bundles/<sha>, signed v2 loader->cell. */
  async function fetchFromCell(
    cellId: string,
    cell: CellEntry,
    sha256: string,
  ): Promise<ArrayBuffer | Response> {
    const path = cellBundlePath(sha256)
    const headers = await signCellRequestV2({
      cellId,
      cellKey: cell.key,
      direction: "loader->cell",
      method: "GET",
      path,
      body: "",
      ts: platform.now(),
    })
    const doFetch = platform.fetch ?? ((u: string, i: RequestInit) => fetch(u, i))
    let res: Response
    try {
      res = await doFetch(`${cell.bridgeOrigin}${path}`, {
        method: "GET",
        headers,
        redirect: "manual",
      })
    } catch (e) {
      return fail(502, "bundle_fetch_failed", `bundle fetch from cell failed: ${errorMessage(e)}`, {
        code: "bundle_fetch_failed",
      })
    }
    if (res.status === 404)
      return fail(404, "bundle_missing", "bundle not found", { code: "bundle_missing" })
    if (res.status !== 200) {
      return fail(
        502,
        "bundle_fetch_failed",
        `bundle fetch from cell answered HTTP ${res.status}`,
        {
          code: "bundle_fetch_failed",
        },
      )
    }
    const len = Number(res.headers.get("content-length") ?? "0")
    const tooLarge = () =>
      fail(502, "bundle_fetch_failed", "bundle from cell too large", {
        code: "bundle_fetch_failed",
      })
    if (len > MAX_FETCHED_BUNDLE_BYTES) return tooLarge()
    const bytes = await res.arrayBuffer()
    if (bytes.byteLength > MAX_FETCHED_BUNDLE_BYTES) return tooLarge()
    return bytes
  }

  return {
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ ok: true })
      if (url.pathname !== "/run") return new Response("not found", { status: 404 })
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 })
      return guarded(() => handleRun(req, url))
    },
    clearVerified() {
      verifiedText.clear()
    },
  }
}

function verdictAnswer(
  outcome: {
    ok: boolean
    result?: unknown
    error?: unknown
    timings?: unknown
    logs?: unknown
    logsDropped?: unknown
  },
  t: Record<string, unknown>,
): Response {
  const inner = (outcome.timings && typeof outcome.timings === "object" ? outcome.timings : {}) as {
    runMs?: unknown
    sleepMs?: unknown
    sleepExact?: unknown
  }
  const merged = {
    ...t,
    workerRunMs: inner.runMs,
    sleepMs: inner.sleepMs,
    sleepExact: inner.sleepExact,
  }
  // The worker's captured console lines (and how many it dropped) pass through untouched.
  const logPart: Record<string, unknown> = {}
  if (Array.isArray(outcome.logs)) logPart.logs = outcome.logs
  if (typeof outcome.logsDropped === "number") logPart.logsDropped = outcome.logsDropped
  if (outcome.ok) {
    return Response.json({
      ok: true,
      result: outcome.result === undefined ? null : outcome.result,
      timings: merged,
      ...logPart,
    })
  }
  // The kind is the loader's to set: an app cannot pass for a loader-level fault.
  const error =
    outcome.error && typeof outcome.error === "object"
      ? outcome.error
      : { message: String(outcome.error) }
  return Response.json({
    ok: false,
    error: { ...error, kind: "handler" },
    timings: merged,
    ...logPart,
  })
}

function errorMessage(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === "string" ? m : String(e)
}

function base64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Whether a probe call on the module fails with `message` (its start failed), within the probe window. */
async function failsToStart(worker: LoadedWorker, message: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entry = worker.getEntrypoint() as unknown as Record<string, () => unknown>
    if (typeof entry[START_PROBE_METHOD] !== "function") return false
    // Called as a method of the stub: `.call(entry)` would be an RPC of its own, passing the stub.
    const settled = await Promise.race([
      Promise.resolve(entry[START_PROBE_METHOD]()).then(
        () => ({ failed: false, message: "" }),
        (e: unknown) => ({ failed: true, message: errorMessage(e) }),
      ),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), START_PROBE_MS)
      }),
    ])
    return settled?.failed === true && settled.message === message
  } catch (e) {
    return errorMessage(e) === message
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isRunVerdict(v: unknown): v is {
  ok: boolean
  result?: unknown
  error?: unknown
  timings?: unknown
  logs?: unknown
  logsDropped?: unknown
} {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { ok?: unknown }).ok === "boolean" &&
    ("result" in (v as object) || "error" in (v as object))
  )
}
