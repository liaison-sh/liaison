// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 4.3. `encryption_state` moves only along the spec section 4.3 table.
//
// What this state is NOT: it is not the enforcement key for Invariant P. The
// trigger arms on the existence of an active mailbox identity precisely so a
// transition to `blocked` or `paused` cannot disarm the database guarantee.
// `encryption_state` drives sync suspension, the enrollment banner and the UI,
// and nothing else.

import { describe, expect, it } from "bun:test"
import {
  ENCRYPTION_STATE_TRANSITIONS,
  ENCRYPTION_STATES,
  type EncryptionState,
  type EncryptionStateTrigger,
  nextEncryptionState,
} from "~/modules/mailbox-keys/encryption-state"

/** The fourteen legal ordered pairs, spelled out independently of the source table. */
const LEGAL: Array<[EncryptionState, EncryptionState, EncryptionStateTrigger]> = [
  ["none", "pending_enrollment", "deploy"],
  ["pending_enrollment", "ready", "enrolled"],
  ["pending_enrollment", "paused", "grace_elapsed"],
  ["ready", "blocked", "seal_failed"],
  ["blocked", "ready", "rotated"],
  ["paused", "ready", "enrolled"],
  // The mailbox reset: back to waiting for enrollment, never to `none`.
  ["ready", "pending_enrollment", "reset"],
  ["blocked", "pending_enrollment", "reset"],
  ["paused", "pending_enrollment", "reset"],
  // Server-managed mode: into it from any not-yet-sealing state, and between it
  // and private (zero-access) in both directions, each by a re-seal.
  ["none", "managed", "managed_default"],
  ["pending_enrollment", "managed", "managed_default"],
  ["paused", "managed", "managed_default"],
  ["managed", "ready", "made_private"],
  ["ready", "managed", "made_managed"],
]

describe("encryption state machine", () => {
  it("declares exactly the six states and fourteen legal transitions", () => {
    // Non-vacuity: the table under test is non-empty and is the size the spec
    // names, so the exhaustive sweep below cannot pass against an empty table.
    expect(ENCRYPTION_STATES.length).toBe(6)
    expect(ENCRYPTION_STATE_TRANSITIONS.length).toBe(14)
  })

  it("accepts every legal pair and returns the target state", () => {
    for (const [from, to, trigger] of LEGAL) {
      expect(nextEncryptionState(from, trigger), `${from} -> ${to}`).toBe(to)
    }
  })

  it("rejects every ordered pair of the 36 that is not legal", () => {
    const legalPairs = new Set(LEGAL.map(([from, to]) => `${from}>${to}`))
    let rejected = 0
    let accepted = 0
    for (const from of ENCRYPTION_STATES) {
      for (const to of ENCRYPTION_STATES) {
        const pair = `${from}>${to}`
        // Reach the pair through every trigger: a transition is legal only when
        // some trigger produces it, so the sweep asks each one.
        const reachable = ENCRYPTION_STATE_TRANSITIONS.some((t) => {
          try {
            return nextEncryptionState(from, t.trigger) === to
          } catch {
            return false
          }
        })
        if (legalPairs.has(pair)) {
          expect(reachable, `${pair} must be reachable`).toBe(true)
          accepted++
        } else {
          expect(reachable, `${pair} must not be reachable`).toBe(false)
          rejected++
        }
      }
    }
    expect(accepted).toBe(14)
    expect(rejected).toBe(22)
  })

  it("throws on a trigger that is not legal from the current state", () => {
    expect(() => nextEncryptionState("ready", "deploy")).toThrow(/encryption_state/)
    expect(() => nextEncryptionState("none", "enrolled")).toThrow(/encryption_state/)
    expect(() => nextEncryptionState("blocked", "seal_failed")).toThrow(/encryption_state/)
    // A managed mailbox never falls back to waiting for a mailbox password.
    expect(() => nextEncryptionState("managed", "reset")).toThrow(/encryption_state/)
    expect(() => nextEncryptionState("managed", "enrolled")).toThrow(/encryption_state/)
  })

  it("is not the enforcement key: blocked and paused are terminal for writes, not for arming", () => {
    // A documentation assertion with teeth. If someone ever adds a
    // `blocked -> none` or `ready -> none` transition, the trigger's arming
    // predicate would become flippable by one row update, so the table must
    // never contain a path back to `none`.
    for (const t of ENCRYPTION_STATE_TRANSITIONS) {
      expect(t.to).not.toBe("none")
    }
  })
})
