// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A control plane stand-in with the real lease rules (heartbeat renews a lease,
// freeze and commit are compare-and-sets), for the timing spike. Mirrors the
// fake in agents.test.ts.
import {
  MOVE_LEASE_SECONDS,
  type MoveAgentPhase,
  type MoveState,
} from "@liaison/control-plane-contract"
import type { MoveControl, MoveDecision } from "~/modules/org/transfer/control"

export class SpikeControl {
  state: MoveState = "planned"
  leaseUntil = 0
  offset = 0
  reachable = true
  /** The next commit is recorded but its reply is lost. */
  loseCommitReply = false
  calls: string[] = []
  now = () => Date.now() + this.offset
  private lapse() {
    if ((this.state === "draining" || this.state === "frozen") && this.now() > this.leaseUntil) {
      this.state = "aborted"
    }
  }
  private reply(): MoveDecision {
    return {
      ok: true,
      state: this.state,
      leaseUntil: this.leaseUntil ? new Date(this.leaseUntil).toISOString() : null,
    }
  }
  private down(): MoveDecision | null {
    return this.reachable ? null : { ok: false, code: "unreachable", error: "down" }
  }
  for(): MoveControl {
    return {
      heartbeat: async (phase: MoveAgentPhase) => {
        this.calls.push(`heartbeat:${phase}`)
        const d = this.down()
        if (d) return d
        this.lapse()
        if (["committed", "finalized", "aborted", "failed"].includes(this.state))
          return this.reply()
        this.leaseUntil = this.now() + MOVE_LEASE_SECONDS * 1000
        const order = ["planned", "precopy", "draining"]
        if (order.indexOf(phase) > order.indexOf(this.state)) this.state = phase
        return this.reply()
      },
      status: async () => {
        this.calls.push("status")
        const d = this.down()
        if (d) return d
        this.lapse()
        return this.reply()
      },
      freeze: async () => {
        this.calls.push("freeze")
        const d = this.down()
        if (d) return d
        this.lapse()
        if (this.now() > this.leaseUntil) return { ok: false, code: "lease_expired" }
        this.state = "frozen"
        return this.reply()
      },
      commit: async () => {
        this.calls.push("commit")
        const d = this.down()
        if (d) return d
        this.lapse()
        if (this.state === "aborted") return { ok: false, code: "aborted", state: "aborted" }
        if (this.state === "committed") return this.reply()
        if (this.state !== "frozen") return { ok: false, code: "bad_state" }
        this.state = "committed"
        this.leaseUntil = 0
        if (this.loseCommitReply) {
          this.loseCommitReply = false
          return { ok: false, code: "unreachable", error: "reply lost" }
        }
        return this.reply()
      },
      abort: async () => {
        this.calls.push("abort")
        const d = this.down()
        if (d) return d
        if (this.state === "committed")
          return { ok: false, code: "already_committed", state: "committed" }
        this.state = "aborted"
        return { ok: true, state: "aborted", leaseUntil: null }
      },
    }
  }
}
