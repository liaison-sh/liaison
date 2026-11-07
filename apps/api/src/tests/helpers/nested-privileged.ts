// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Make a nested privileged acquisition throw for the tests of the calling file.
 *
 * A privileged-pool acquisition made while the same caller already holds a
 * privileged slot deadlocks a full pool in production, where it is only counted
 * (db/privileged.ts). Under NESTED_PRIVILEGED_STRICT=1 it throws instead, so a
 * code path that takes a second slot under the first fails its tests. Not every
 * suite is clean yet, so a file opts in by calling this at its top level; the
 * previous value comes back after the file.
 */
import { afterAll, beforeAll } from "bun:test"

export function strictNestedPrivileged(): void {
  let before: string | undefined
  beforeAll(() => {
    before = process.env.NESTED_PRIVILEGED_STRICT
    process.env.NESTED_PRIVILEGED_STRICT = "1"
  })
  afterAll(() => {
    if (before === undefined) delete process.env.NESTED_PRIVILEGED_STRICT
    else process.env.NESTED_PRIVILEGED_STRICT = before
  })
}
