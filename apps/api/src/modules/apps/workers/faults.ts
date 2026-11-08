// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a failed Workers attempt says about whom to blame, which decides what
// happens next (executor.ts, fallback.ts):
//
//   class   kinds                                   then
//   loader  network error (no answer), an answer    retried once (zero bridge calls,
//           without a kind (any HTTP status, e.g.   budget left); counts toward the
//           Cloudflare's own 503 page), `auth`,     process-wide breaker
//           `loader_internal`, a kind this cell
//           does not know
//   app     `load`, `bundle_missing`,               no retry; this org's app@version
//           `bundle_fetch_failed`                   runs on QuickJS for 10 minutes
//   final   `limit`, `handler`, `timeout`; and      the run's own outcome: nothing
//           "deadline" (the cell's own wait ran     changes
//           out), "cancelled" (the caller's
//           abort), "cell" (this cell's fault)
//
// A loader-level fault is the platform's (the loader, its key, the network,
// Cloudflare); an app-level one is one org's module (a broken custom build, a
// bundle the cell cannot serve), and must never take the other orgs off
// Workers.

import type { WorkersFaultClass } from "./run-settled"

export interface WorkersFault {
  class: WorkersFaultClass
  /** The loader's kind, or "network", "http_<status>" (no kind), "deadline", "cancelled", "cell". */
  kind: string
}

const LOADER_KINDS = new Set(["auth", "loader_internal"])
const APP_KINDS = new Set(["load", "bundle_missing", "bundle_fetch_failed"])
const FINAL_KINDS = new Set(["limit", "handler", "timeout"])

/** The fault of a loader answer that was not `{ok:true}`. */
export function classifyLoaderAnswer(httpStatus: number, kind: unknown): WorkersFault {
  if (typeof kind !== "string" || kind === "") {
    return { class: "loader", kind: `http_${httpStatus}` }
  }
  if (FINAL_KINDS.has(kind)) return { class: "final", kind }
  if (APP_KINDS.has(kind)) return { class: "app", kind }
  if (LOADER_KINDS.has(kind)) return { class: "loader", kind }
  // A kind newer than this cell: the loader answered, but not in a way this
  // cell can act on; treat it as the platform's, never the app's.
  return { class: "loader", kind }
}

/** The loader could not be reached (DNS, TLS, connection reset, ...). */
export const NETWORK_FAULT: WorkersFault = { class: "loader", kind: "network" }
/** The cell's own deadline passed while it waited for the loader. */
export const DEADLINE_FAULT: WorkersFault = { class: "final", kind: "deadline" }
/** This cell failed before or while sending the run (registration, signing). */
export const CELL_FAULT: WorkersFault = { class: "final", kind: "cell" }
/** The caller gave up. */
export const CANCELLED_FAULT: WorkersFault = { class: "final", kind: "cancelled" }
