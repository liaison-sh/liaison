// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app loader's wire protocol: what a cell posts to `/run`, the error kinds
// every failed answer carries, and the identities derived from a run (the
// dynamic worker id, the content-addressed bundle key, the cell route a
// module is fetched from). Shared by every loader host and by the cell.

export const COMPATIBILITY_DATE = "2026-10-01"
/** Per-run isolate limits; a cell may ask for less, never more. */
export const DEFAULT_LIMITS = { cpuMs: 30_000, subRequests: 10_000 }
/** Upper bound on a run's wall clock, whatever the cell asks for. */
export const MAX_DEADLINE_MS = 15 * 60_000
/** Cap on a module fetched from a cell (the cell's own build output cap is 4 MiB). */
export const MAX_FETCHED_BUNDLE_BYTES = 8 * 1024 * 1024
/** A method no module implements: calling it only shows whether the module starts. */
export const START_PROBE_METHOD = "__liaisonStartProbe"
/** How long the start probe may take before the failure counts as the handler's. */
export const START_PROBE_MS = 2_000

/**
 * Every `/run` error answer carries one of these. Loader-level (the cell may
 * trip its breaker): auth, loader_internal. App-level (this org:app@version):
 * bundle_missing, bundle_fetch_failed, load. The run's own outcome: limit,
 * handler, timeout. A network failure or a kindless answer never comes from a
 * loader built on this package.
 */
export const ERROR_KINDS = [
  "auth",
  "bundle_missing",
  "bundle_fetch_failed",
  "load",
  "limit",
  "handler",
  "timeout",
  "loader_internal",
] as const
export type ErrorKind = (typeof ERROR_KINDS)[number]

export const LOADER_LEVEL_KINDS: readonly ErrorKind[] = ["auth", "loader_internal"]
export const APP_LEVEL_KINDS: readonly ErrorKind[] = [
  "load",
  "bundle_missing",
  "bundle_fetch_failed",
]
export const FINAL_KINDS: readonly ErrorKind[] = ["limit", "handler", "timeout"]

export interface RunBody {
  runId: string
  orgId: string
  app: string
  version: string
  sha256: string
  exportName: string
  params: unknown
  extraArgs: unknown[]
  approval: unknown
  bridgeMethods: string[]
  bridgeUrl: string
  runToken: string
  deadlineMs: number
  limits?: { cpuMs?: number; subRequests?: number }
  /**
   * The run's lane: `interactive` (a person or an agent waits on it: tool
   * calls, attention computes, summarizers, page reads) or `background` (jobs,
   * events, syncs). A host with a bounded pool keeps part of it for the
   * interactive lane (the sandbox service, @liaison/sandbox-supervisor).
   * Absent: interactive. Part of the signed body like every other field.
   */
  lane?: RunLane
}

export const RUN_LANES = ["interactive", "background"] as const
export type RunLane = (typeof RUN_LANES)[number]

/** What the module's entrypoint receives: never the run token or the bridge URL. */
export interface WorkerRunRequest {
  runId: string
  orgId: string
  app: string
  version: string
  exportName: string
  params: unknown
  extraArgs: unknown[]
  approval: unknown
  bridgeMethods: string[]
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/
/** A run id is `<instanceId>:<uuid>`: SAFE plus the colon. Not part of any id. */
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/
const SHA = /^[0-9a-f]{64}$/
/** The shortest run token a loader accepts (the cell mints 32 random bytes). */
export const MIN_RUN_TOKEN_LENGTH = 16

/** Null when the body is a well-formed run, else the reason. */
export function validateRunBody(b: unknown): string | null {
  if (!b || typeof b !== "object") return "body must be an object"
  const r = b as Record<string, unknown>
  if (typeof r.runId !== "string" || !RUN_ID.test(r.runId)) return "invalid runId"
  for (const k of ["orgId", "app", "version", "exportName"] as const) {
    if (typeof r[k] !== "string" || !SAFE.test(r[k] as string)) return `invalid ${k}`
  }
  if (typeof r.sha256 !== "string" || !SHA.test(r.sha256)) return "invalid sha256"
  if (typeof r.bridgeUrl !== "string") return "invalid bridgeUrl"
  if (typeof r.runToken !== "string" || r.runToken.length < MIN_RUN_TOKEN_LENGTH) {
    return "invalid runToken"
  }
  if (!Array.isArray(r.bridgeMethods) || !r.bridgeMethods.every((m) => typeof m === "string")) {
    return "invalid bridgeMethods"
  }
  if (r.extraArgs !== undefined && !Array.isArray(r.extraArgs)) return "invalid extraArgs"
  if (typeof r.deadlineMs !== "number" || !Number.isFinite(r.deadlineMs) || r.deadlineMs <= 0) {
    return "invalid deadlineMs"
  }
  if (r.lane !== undefined && !(RUN_LANES as readonly unknown[]).includes(r.lane)) {
    return "invalid lane"
  }
  return null
}

/** deadlineMs is a duration; an absolute epoch-ms value (> 1e12) is accepted too. Capped. */
export function deadlineDuration(deadlineMs: number, now: number): number {
  const d = deadlineMs > 1e12 ? deadlineMs - now : deadlineMs
  return Math.max(0, Math.min(d, MAX_DEADLINE_MS))
}

/** One dynamic worker per cell, org, app version and module bytes. */
export function dynamicWorkerId(
  cellId: string,
  b: Pick<RunBody, "orgId" | "app" | "version" | "sha256">,
): string {
  return `${cellId}:${b.orgId}:${b.app}@${b.version}#${b.sha256}`
}

/** The content-addressed key a module is cached under. */
export function bundleKey(b: Pick<RunBody, "app" | "version" | "sha256">): string {
  return `${b.app}/${b.version}/${b.sha256}.js`
}

/** The cell route a module is fetched from when the loader has no copy. */
export function cellBundlePath(sha256: string): string {
  return `/api/app-bridge/bundles/${sha256}`
}

/** The isolate limits of a run: what the cell asked for, capped at the defaults. */
export function runLimits(body: Pick<RunBody, "limits">): { cpuMs: number; subRequests: number } {
  return {
    cpuMs: Math.min(body.limits?.cpuMs ?? DEFAULT_LIMITS.cpuMs, DEFAULT_LIMITS.cpuMs),
    subRequests: Math.min(
      body.limits?.subRequests ?? DEFAULT_LIMITS.subRequests,
      DEFAULT_LIMITS.subRequests,
    ),
  }
}

/** The failure answer: always a kind, optionally an HTTP-ish status and a code. */
export function fail(
  status: number,
  kind: ErrorKind,
  message: string,
  extra: { status?: number; code?: string } = {},
): Response {
  return Response.json({ ok: false, error: { message, kind, ...extra } }, { status })
}
