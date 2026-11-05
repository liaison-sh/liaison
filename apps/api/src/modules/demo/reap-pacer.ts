// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pacing for the demo reaper: background deletes yield to live traffic.
//
// A purge is real database work (deleting a seeded workspace's rows, its
// triggers, its Redis keys). On an idle box the reaper may run several at once
// and drain a backlog fast. On a busy box the same work competes with visitors
// for Postgres CPU, connections and the box's cores, and a visitor's page gets
// slower. The pacer keeps the reaper's share bounded:
//
//   - It looks at three cheap pressure signals before every purge: waiters on
//     this process's privileged pool, the round trip of a trivial query (a
//     busy database answers it late), and the host's load per core.
//   - Under pressure it runs one purge at a time and rests after each one, so
//     the reaper is busy only a fraction (`duty`) of the wall clock. The
//     fraction halves on every pressured sample, down to `minDuty`.
//   - Without pressure the fraction climbs back by `dutyStep` per purge; at a
//     full duty and no pressure the reaper runs `maxConcurrency` purges at once,
//     as before.
//
// The rest after a purge that took `t` ms is `t * (1 / duty - 1)`, capped, so a
// purge that got slow (because the box is busy) earns a longer rest.
//
// Yielding has a FLOOR: the backlog is drained within the pass, whatever the
// pressure. Without one, a box under sustained load (the very load that makes
// workspaces expire fast) collected a tenth of its backlog per pass and the
// expired workspaces filled the workspace cap, so every new start was refused.
// The caller tells the pacer, before each purge, how many purges are left and
// how much of the pass is left for them (`schedule`): the time per purge that
// still drains everything. A rest never eats into that allotment, and when the
// purges take longer than it, more of them run at once (up to
// `maxConcurrency`). And when the workspace caps are nearly full (`urgent`)
// the reaper runs at full speed: a full cap refuses every visitor, which is
// worse than a slower page for the ones already in. Pure state machine: the
// signals are sampled by the caller.

export interface ReapPressure {
  /** The privileged pool in this process has waiters, or is at least half busy. */
  poolBusy: boolean
  /** Round trip of a trivial query, in ms; null when it could not be measured. */
  dbProbeMs: number | null
  /** One-minute load average divided by the number of cores; null when unknown. */
  hostLoadPerCore: number | null
}

export interface ReapPacerOptions {
  maxConcurrency: number
  /** Lowest busy fraction under sustained pressure. */
  minDuty?: number
  /** Busy fraction regained per unpressured purge. */
  dutyStep?: number
  /** Longest rest after one purge, in ms. */
  maxRestMs?: number
  /** A probe this slow (ms) is pressure whatever the floor. */
  probeAbsoluteMs?: number
  /** A probe this many times the fastest seen in the pass is pressure. */
  probeFactor?: number
  /** Host load per core at or above this is pressure. */
  hostLoadPerCore?: number
}

export const REAP_PACER_DEFAULTS = {
  minDuty: 0.1,
  dutyStep: 0.1,
  maxRestMs: 30_000,
  probeAbsoluteMs: 25,
  probeFactor: 5,
  hostLoadPerCore: 0.7,
} as const

export class ReapPacer {
  private duty = 1
  private probeFloorMs: number | null = null
  /** Time per purge that still drains the backlog in the pass; null: no schedule. */
  private allotMs: number | null = null
  /** The last purge's wall clock. */
  private lastPurgeMs: number | null = null
  private urgent = false
  private readonly o: Required<ReapPacerOptions>

  constructor(opts: ReapPacerOptions) {
    this.o = { ...REAP_PACER_DEFAULTS, ...opts }
  }

  /** The busy fraction the reaper is held to right now (0..1]. */
  currentDuty(): number {
    return this.duty
  }

  /** Is this sample pressure? Also learns the probe floor. */
  isPressured(p: ReapPressure): boolean {
    let probeSlow = false
    if (p.dbProbeMs !== null && Number.isFinite(p.dbProbeMs)) {
      if (this.probeFloorMs === null || p.dbProbeMs < this.probeFloorMs) {
        this.probeFloorMs = p.dbProbeMs
      }
      const floor = Math.max(this.probeFloorMs, 1)
      probeSlow = p.dbProbeMs >= this.o.probeAbsoluteMs || p.dbProbeMs >= floor * this.o.probeFactor
    }
    const hostBusy = p.hostLoadPerCore !== null && p.hostLoadPerCore >= this.o.hostLoadPerCore
    return p.poolBusy || probeSlow || hostBusy
  }

  /** Feed one pressure sample (before a purge starts); adjusts the duty. */
  observe(p: ReapPressure): boolean {
    const pressured = this.isPressured(p)
    if (pressured) this.duty = Math.max(this.o.minDuty, this.duty / 2)
    else this.duty = Math.min(1, this.duty + this.o.dutyStep)
    return pressured
  }

  /**
   * The throughput floor: `remaining` purges must fit in `msLeft`. Called
   * before each purge; a rest never takes the reaper below this rate.
   */
  schedule(remaining: number, msLeft: number): void {
    this.allotMs = remaining > 0 ? Math.max(0, msLeft) / remaining : null
  }

  /** The workspace caps are nearly full: no yielding at all. */
  setUrgent(urgent: boolean): void {
    this.urgent = urgent
  }

  isUrgent(): boolean {
    return this.urgent
  }

  /** Purges allowed in flight at the current duty. */
  concurrency(): number {
    if (this.urgent || this.duty >= 1) return this.o.maxConcurrency
    // Behind schedule: as many at once as it takes to keep the floor.
    if (this.allotMs !== null && this.lastPurgeMs !== null && this.lastPurgeMs > this.allotMs) {
      if (this.allotMs <= 0) return this.o.maxConcurrency
      return Math.min(this.o.maxConcurrency, Math.ceil(this.lastPurgeMs / this.allotMs))
    }
    return 1
  }

  /** How long to rest after a purge that took `purgeMs`. */
  restAfter(purgeMs: number): number {
    this.lastPurgeMs = Math.max(0, purgeMs)
    if (this.urgent || this.duty >= 1) return 0
    let rest = Math.min(this.o.maxRestMs, this.lastPurgeMs * (1 / this.duty - 1))
    if (this.allotMs !== null) rest = Math.min(rest, Math.max(0, this.allotMs - this.lastPurgeMs))
    return Math.round(rest)
  }
}
