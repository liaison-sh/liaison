// SPDX-License-Identifier: FSL-1.1-ALv2
import { setSystemTime } from "bun:test"

/**
 * One day and a bit: far enough that any wall-clock value (a second, a minute,
 * a date) differs, which is what a "byte identical across time" check needs.
 */
export const CLOCK_JUMP_MS = 86_400_000 + 1_100

/**
 * Run `fn` with the wall clock (`Date`, `Date.now`) moved `offsetMs` into the
 * future, then put it back. Stands in for sleeping across a second boundary:
 * the code under test sees a later time instantly. The mocked clock is frozen
 * for the duration, so `fn` must not wait on `Date.now()` advancing.
 */
export async function atClockOffset<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  setSystemTime(new Date(Date.now() + offsetMs))
  try {
    return await fn()
  } finally {
    setSystemTime()
  }
}
