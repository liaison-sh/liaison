// SPDX-License-Identifier: FSL-1.1-ALv2
// Whether THIS process should receive traffic, answered by /readyz
// (modules/healthz/readyz.ts). Distinct from /healthz, which is liveness plus
// dependency status: a process is "starting" until its role's boot is done
// (index.ts calls markBootComplete), then "ready", and "draining" once a
// shutdown has begun, so a load balancer stops sending it requests first.
import { INSTANCE_ID } from "~/infra/instance-id"
import { isLeader } from "~/infra/leadership"
import { currentRole, type LiaisonRole } from "~/lib/process-role"
import { edgeGracePassed, isShuttingDown } from "~/lib/shutdown"

export type ReadinessStatus = "starting" | "ready" | "draining"

export interface Readiness {
  status: ReadinessStatus
  role: LiaisonRole
  instanceId: string
  /** Whether this process runs the cell's singletons right now. */
  leader: boolean
}

let bootComplete = false
let draining = false

/** The role's boot is done: the process may receive traffic. */
export function markBootComplete(): void {
  bootComplete = true
}

/** A shutdown has begun (or ended): /readyz answers 503 while true. */
export function setDraining(value: boolean): void {
  draining = value
}

export function readiness(): Readiness {
  const status: ReadinessStatus = draining ? "draining" : bootComplete ? "ready" : "starting"
  return { status, role: currentRole(), instanceId: INSTANCE_ID, leader: isLeader() }
}

/**
 * Whether this process refuses new work (a new turn, a re-attach) with a retry
 * hint. Not at the first draining instant: until the edge grace has passed
 * the edge may still route here (its probe has not yet seen /readyz 503), and
 * a refusal then is a client-visible 5xx for nothing. Work taken in that
 * window is tracked like any other (a turn drains, or hands off and resumes
 * on another process). Past the grace the listener is stopped and only a
 * kept-alive connection can still bring a request: that one is refused.
 * Draining with no shutdown sequence (no grace to wait for) refuses at once.
 */
export function refusesNewWork(): boolean {
  if (!draining) return false
  return !isShuttingDown() || edgeGracePassed()
}

export const ReadinessTestAccess = {
  reset(): void {
    bootComplete = false
    draining = false
  },
}
