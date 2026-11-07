// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How many draft builds may run. Each build is a Bun subprocess of about
// 100-200 MB, and an agent in a loop could start dozens, so:
//   - per org: one build at a time, and at most 30 builds in any rolling hour;
//   - per process: at most 2 builds at once, all orgs together.
// A build over a limit is refused at once (typed `build_busy`, HTTP 429), never
// queued: the caller (agent tool or route) reports it and the agent retries later.
//
// The counters live in this process's memory. A cell that runs several API
// processes therefore allows 2 builds per process, and an org's hourly budget and
// one-at-a-time rule are counted per process too (a determined caller spread over
// N processes gets up to N x 30 per hour). That is a bound on cost, not a security
// boundary: every build is sandboxed and capped on its own (./build-draft.ts).
// Move the counters to Redis if per-cell exactness is ever needed.

export const BUILDS_PER_ORG_PER_HOUR = 30
export const BUILDS_PER_PROCESS = 2
const HOUR_MS = 60 * 60 * 1000

export type BuildBusyReason = "org_build_running" | "org_hourly_limit" | "server_busy"

export class BuildBusyError extends Error {
  readonly code = "build_busy"
  readonly status = 429
  constructor(
    readonly reason: BuildBusyReason,
    /** Seconds until a retry can succeed, when known. */
    readonly retryAfterSeconds?: number,
  ) {
    super(
      reason === "org_build_running"
        ? "Another build of this organization is running: wait for it to finish."
        : reason === "org_hourly_limit"
          ? `This organization reached ${BUILDS_PER_ORG_PER_HOUR} builds in the last hour: try again in ${retryAfterSeconds ?? 60} s.`
          : "The server is running its maximum number of builds: try again in a few seconds.",
    )
    this.name = "BuildBusyError"
  }
}

export interface BuildGovernor {
  /** Take a build slot for `orgId`, or throw BuildBusyError. Call the result once when done. */
  acquire(orgId: string): () => void
  /** Run `fn` holding a slot. */
  run<T>(orgId: string, fn: () => Promise<T>): Promise<T>
}

export function createBuildGovernor(opts?: {
  perOrgPerHour?: number
  perProcess?: number
  now?: () => number
}): BuildGovernor {
  const perHour = opts?.perOrgPerHour ?? BUILDS_PER_ORG_PER_HOUR
  const perProcess = opts?.perProcess ?? BUILDS_PER_PROCESS
  const now = opts?.now ?? Date.now
  const running = new Set<string>()
  const starts = new Map<string, number[]>()
  let inFlight = 0

  const acquire = (orgId: string): (() => void) => {
    const t = now()
    const recent = (starts.get(orgId) ?? []).filter((s) => t - s < HOUR_MS)
    starts.set(orgId, recent)
    if (running.has(orgId)) throw new BuildBusyError("org_build_running")
    if (recent.length >= perHour) {
      throw new BuildBusyError("org_hourly_limit", Math.ceil((recent[0] + HOUR_MS - t) / 1000))
    }
    if (inFlight >= perProcess) throw new BuildBusyError("server_busy", 5)
    running.add(orgId)
    recent.push(t)
    inFlight++
    let released = false
    return () => {
      if (released) return
      released = true
      running.delete(orgId)
      inFlight--
    }
  }

  return {
    acquire,
    async run(orgId, fn) {
      const release = acquire(orgId)
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}

/** The process-wide governor every draft build and check goes through. */
export const buildGovernor: BuildGovernor = createBuildGovernor()
