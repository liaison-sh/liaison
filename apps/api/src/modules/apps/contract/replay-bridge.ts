// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Egress fixtures for the app contract harness: record a run's bridge calls
// once against a real bridge (a developer with the provider's sandbox
// account), replay them in CI. No provider is ever called from a contract run.
//
// A fixture lists the entry's input and every bridge call with its answer.
// Replay matches a call by method plus its arguments (canonical JSON); calls
// with the same key are answered in recorded order, the last answer repeating.
// A call with no recorded answer is refused (the app sees a rejected bridge
// call) and counted, so the harness reports the entry as `no-fixture`
// instead of judging a run that never saw its real inputs.
//
// A few bridge methods need no fixture: the logger (a no-op), the caller's
// identity getters (fixed ids) and the approval envelope (none: a first entry).

import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { INFLIGHT } from "./quickjs-isolate"

export interface RecordedCall {
  method: string
  args: unknown[]
  /** The bridge call's answer. */
  reply?: unknown
  /** The bridge call's rejection, when it failed. */
  error?: { message: string; status?: number; code?: string }
}

export interface EgressFixture {
  /** `<kind>:<name>`, the entry the fixture drives. */
  entry: string
  params?: unknown
  extraArgs?: unknown[]
  calls: RecordedCall[]
  /** Where and when it was recorded (free text: never a secret or a customer name). */
  recordedFrom?: string
}

export const CONTRACT_ORG_ID = "00000000-0000-4000-8000-00000000c0de"
export const CONTRACT_USER_ID = "00000000-0000-4000-8000-00000000c0df"

/** Methods answered without a fixture. */
function freeAnswer(method: string): { answer: unknown } | null {
  if (method.startsWith("log_")) return { answer: undefined }
  if (method === "getOrgId") return { answer: CONTRACT_ORG_ID }
  if (method === "getUserId") return { answer: CONTRACT_USER_ID }
  if (method === "getCallerApp" || method === "getIngestionCallerApp") return { answer: null }
  if (method === "_approvalContext_get") return { answer: undefined }
  return null
}

/** Canonical JSON: object keys sorted, so a recorded call matches its replay. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  )
}

const keyOf = (method: string, args: unknown[]) => `${method} ${canonicalJson(args)}`

export class NoFixtureError extends Error {
  constructor(readonly method: string) {
    super(`No recorded answer for bridge call ${method}`)
    this.name = "NoFixtureError"
  }
}

export interface ReplayStats {
  /** Bridge calls the run made (free ones included). */
  calls: number
  /** Calls with no recorded answer, by method. */
  missing: string[]
}

export interface ReplayBridge {
  bridge: AppBridge
  stats: ReplayStats
}

/**
 * A bridge with the given method surface (`[name, "sync" | "async"]`, the
 * executor dispatches on that kind) answering from `fixture`.
 */
export function createReplayBridge(
  surface: ReadonlyArray<readonly [string, "sync" | "async"]>,
  fixture: EgressFixture | null,
): ReplayBridge {
  const queues = new Map<string, RecordedCall[]>()
  for (const call of fixture?.calls ?? []) {
    const k = keyOf(call.method, call.args)
    const q = queues.get(k) ?? []
    q.push(call)
    queues.set(k, q)
  }
  const stats: ReplayStats = { calls: 0, missing: [] }
  let inflight = 0
  const answer = (method: string, args: unknown[]): RecordedCall | { free: unknown } => {
    stats.calls++
    const free = freeAnswer(method)
    if (free) return { free: free.answer }
    const q = queues.get(keyOf(method, args))
    if (!q || q.length === 0) {
      stats.missing.push(method)
      throw new NoFixtureError(method)
    }
    return q.length > 1 ? (q.shift() as RecordedCall) : (q[0] as RecordedCall)
  }
  const settle = (a: RecordedCall | { free: unknown }): unknown => {
    if ("free" in a) return a.free
    if (a.error) {
      throw Object.assign(new Error(a.error.message), {
        ...(a.error.status !== undefined ? { status: a.error.status } : {}),
        ...(a.error.code !== undefined ? { code: a.error.code } : {}),
      })
    }
    return a.reply
  }
  const bridge: AppBridge = {}
  for (const [name, kind] of surface) {
    bridge[name] =
      kind === "async"
        ? async (...args: unknown[]) => {
            inflight++
            try {
              await Promise.resolve()
              return settle(answer(name, args))
            } finally {
              inflight--
            }
          }
        : (...args: unknown[]) => settle(answer(name, args))
  }
  Object.defineProperty(bridge, INFLIGHT, { value: () => inflight, enumerable: false })
  return { bridge, stats }
}

/**
 * Wrap a real bridge so every call and its answer is recorded: the recording
 * half. `finish()` hands back the fixture to store under
 * `fixtures/<app>/<entry>.json` (after reading it for secrets).
 */
export function createRecordingBridge(
  real: AppBridge,
  entry: { entry: string; params?: unknown; extraArgs?: unknown[]; recordedFrom?: string },
): { bridge: AppBridge; finish: () => EgressFixture } {
  const calls: RecordedCall[] = []
  const bridge: AppBridge = {}
  for (const [name, fn] of Object.entries(real)) {
    if (typeof fn !== "function") continue
    const isAsync =
      (fn as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction"
    bridge[name] = isAsync
      ? async (...args: unknown[]) => {
          try {
            const reply = await fn(...args)
            if (!freeAnswer(name)) calls.push({ method: name, args, reply })
            return reply
          } catch (err) {
            const e = err as { message?: string; status?: number; code?: string }
            calls.push({
              method: name,
              args,
              error: {
                message: String(e?.message ?? err),
                ...(typeof e?.status === "number" ? { status: e.status } : {}),
                ...(typeof e?.code === "string" ? { code: e.code } : {}),
              },
            })
            throw err
          }
        }
      : (...args: unknown[]) => {
          const reply = fn(...args)
          if (!freeAnswer(name)) calls.push({ method: name, args, reply })
          return reply
        }
  }
  return {
    bridge,
    finish: () => ({ ...entry, calls: JSON.parse(JSON.stringify(calls)) as RecordedCall[] }),
  }
}
