// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No sandboxed run holds a host transaction.
//
// A sandboxed event handler or webhook delivery used to run on ONE database
// transaction from start to end: it held a pooled connection, and every row it
// touched stayed locked, for its whole wall clock, provider calls included.
// It now runs on a session bridge instead: each bridge call opens its own short
// transaction (rpc-bridge.ts createSessionRpcBridge), as polls and reconciles
// already do. What a run wrote before it failed stays written, so a handler
// that is retried (an event's one retry, the webhook inbox's replay) must be
// idempotent, as a provider's own redelivery already required.
//
// The handlers that still rely on the whole run committing together (several
// writes that must land as one, a claim a killed run must not leave behind)
// keep the held transaction: they are listed in
// contract/run-wide-tx.allowlist.json, each with its reason. The list only
// shrinks (run-wide-tx.guard.test.ts pins it under a frozen baseline): an app
// whose handler is made safe removes its row.
//
// Core apps are not concerned: their handlers keep the held transaction until
// they become server code.
import allowlist from "./contract/run-wide-tx.allowlist.json"

export interface RunWideTxAllowance {
  app: string
  /** `event:<export>` or `webhook:<export>`, as the run timing record names the entry. */
  entry: string
  /** What the handler relies on the whole-run transaction for, for whoever makes it safe. */
  reason: string
}

const keyOf = (app: string, entry: string) => `${app}\u0000${entry}`
const ALLOWED = new Set((allowlist as RunWideTxAllowance[]).map((r) => keyOf(r.app, r.entry)))
const testAllowed = new Set<string>()

/** True when `app`'s handler `entry` (`event:<export>` / `webhook:<export>`) is a listed exception. */
export function runWideTxAllowed(app: string, entry: string): boolean {
  const key = keyOf(app, entry)
  return ALLOWED.has(key) || testAllowed.has(key)
}

/**
 * Whether a handler run holds one transaction for its whole run: a core app's
 * always, a sandboxed app's only when it is a listed exception.
 */
export function handlerRunHoldsTx(opts: { core: boolean; app: string; entry: string }): boolean {
  return opts.core || runWideTxAllowed(opts.app, opts.entry)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const RunWideTxTestAccess = {
  /** Treat `app`'s `entry` as listed until `clear()`. */
  allow(app: string, entry: string): void {
    testAllowed.add(keyOf(app, entry))
  },
  clear(): void {
    testAllowed.clear()
  },
}
