// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Time for a seed: every instant is an OFFSET from one base instant (the
// SeedContext's `now`), never an absolute date. The offsets are the fixed
// thing, so a world seeded next month still reads as freshly active.

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

/** A clock derived from one base instant. */
export interface SeedClock {
  base: Date
  hoursBefore: (h: number) => Date
  daysBefore: (d: number) => Date
  hoursAfter: (h: number) => Date
  daysAfter: (d: number) => Date
  /** A UTC time of day, `dayOffset` days from the Monday of the base week. */
  dayAt: (dayOffset: number, hour: number, minute?: number) => Date
}

export function seedClock(base: Date): SeedClock {
  const at = (ms: number) => new Date(ms)
  return {
    base,
    hoursBefore: (h) => at(base.getTime() - h * HOUR_MS),
    daysBefore: (d) => at(base.getTime() - d * DAY_MS),
    hoursAfter: (h) => at(base.getTime() + h * HOUR_MS),
    daysAfter: (d) => at(base.getTime() + d * DAY_MS),
    dayAt: (dayOffset, hour, minute = 0) => {
      // Anchor to the Monday of the base week so a "working week" always reads
      // as one, whatever weekday the seed happens to run on.
      const anchor = new Date(base.getTime())
      const dow = anchor.getUTCDay() // 0 Sun .. 6 Sat
      const mondayShift = dow === 0 ? -6 : 1 - dow
      anchor.setUTCDate(anchor.getUTCDate() + mondayShift + dayOffset)
      anchor.setUTCHours(hour, minute, 0, 0)
      return anchor
    },
  }
}
