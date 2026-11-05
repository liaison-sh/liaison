// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Health gate for `buildToolSet` — answers `isUnreachable(connectionId)` from
// an in-memory map. `setHealthStatus` is pumped by HealthTracker on each
// transition; `setDisabled` is pumped by the manager-app routes when toggling
// the connection-level disabled flag.
//
// Single module-level instance — the previous swappable `HealthGate` interface
// + `setHealthGate` setter were built for a planned alternate impl that never
// arrived; collapsing them removes a premature seam.

import type { HealthStatus } from "./health"

const UNREACHABLE_STATUSES: ReadonlySet<HealthStatus> = new Set<HealthStatus>([
  "down",
  "failed",
  "needs_reauth",
])

let disabled = new Map<string, boolean>()
let status = new Map<string, HealthStatus>()

export function isUnreachable(connectionId: string): boolean {
  if (disabled.get(connectionId)) return true
  const s = status.get(connectionId)
  if (!s) return false
  return UNREACHABLE_STATUSES.has(s)
}

export function setDisabled(connectionId: string, value: boolean): void {
  disabled.set(connectionId, value)
}

export function setHealthStatus(connectionId: string, value: HealthStatus): void {
  status.set(connectionId, value)
}

/** Back-compat accessor for the small number of callers that still reach for
 *  the gate as an object. New code can import the functions directly. */
export function getHealthGate() {
  return { isUnreachable, setDisabled, setHealthStatus }
}

/** Test-only: clear all gate state. */
export function _resetHealthGate(): void {
  disabled = new Map()
  status = new Map()
}
