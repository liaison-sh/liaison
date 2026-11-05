// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test only: the kernel's effect ledger (`ctx.effects`) in memory, for the
// suites that prove an outside call happens once (S11).
import type { EffectClaim, EffectsBridge } from "@liaison/app-sdk/effects"

/** The kernel's effect ledger (`ctx.effects`), in memory, with its states. `die()` is the claimer's death. */
export class LedgerDouble implements EffectsBridge {
  rows = new Map<string, { state: "pending" | "done" | "unknown"; result: unknown }>()
  crashBeforeComplete = false
  async claim(key: string): Promise<EffectClaim> {
    const row = this.rows.get(key)
    if (!row) {
      this.rows.set(key, { state: "pending", result: null })
      return { state: "claimed" }
    }
    if (row.state === "done") return { state: "done", result: row.result }
    if (row.state === "unknown") return { state: "unknown" }
    return { state: "in_flight" }
  }
  async complete(key: string, resultJson: string) {
    if (this.crashBeforeComplete) throw new Error("the process died before storing the result")
    if (this.rows.get(key)?.state !== "pending") return { ok: false }
    this.rows.set(key, { state: "done", result: JSON.parse(resultJson) })
    return { ok: true }
  }
  async release(key: string) {
    if (this.rows.get(key)?.state === "pending") this.rows.delete(key)
    return { ok: true }
  }
  async settleUnknown(key: string, decisionJson: string) {
    const d = JSON.parse(decisionJson) as { outcome: "done" | "retry"; result?: unknown }
    if (this.rows.get(key)?.state !== "unknown") return { ok: false }
    this.rows.set(key, d.outcome === "done" ? { state: "done", result: d.result ?? null } : { state: "pending", result: null })
    return { ok: true }
  }
  async markUnknown(key: string) {
    if (this.rows.get(key)?.state !== "pending") return { ok: false }
    this.rows.set(key, { state: "unknown", result: null })
    return { ok: true }
  }
  /** The claiming process is gone: its pending claims are unknown now. */
  die() {
    for (const [k, r] of this.rows) if (r.state === "pending") this.rows.set(k, { state: "unknown", result: null })
  }
}
