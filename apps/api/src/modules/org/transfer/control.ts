// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the source transfer agent asks the control plane during a move (D34).
//
//   heartbeat  every 2 s, renews the lease (`move.heartbeat`, the instance's own
//              signed cell-billing channel; contract moves.ts);
//   status     what the control plane decided (`move.status`, same channel);
//   freeze     the control plane's freeze (router pin `frozen`, tenant moving);
//   commit     the decision: a compare-and-set (frozen AND lease valid);
//   abort      before the commit only.
// freeze/commit/abort are operator actions of the control plane's `cell-ops`
// webhook: the operator hands its key to the agent on the agent's stdin when it
// starts the move (memory only, never a file or an argument), and the agent
// signs them itself, so the commit runs from the cell, not from the operator's
// machine (R1.4).
//
// Every reply is a `MoveDecision`. `unreachable` means the call's outcome is
// unknown (network error, timeout, a 5xx): for a commit that is NOT a refusal,
// the agent asks `status` before it does anything else.
import { createHmac, randomUUID } from "node:crypto"
import type { MoveAgentPhase, MoveState } from "@liaison/control-plane-contract"

export type MoveDecision =
  | { ok: true; state: MoveState; leaseUntil: string | null }
  | { ok: false; code: string; state?: MoveState }
  | { ok: false; code: "unreachable"; error: string }

export interface MoveControl {
  heartbeat(phase: MoveAgentPhase): Promise<MoveDecision>
  status(): Promise<MoveDecision>
  freeze(): Promise<MoveDecision>
  commit(freezeMs: number): Promise<MoveDecision>
  abort(reason: string): Promise<MoveDecision>
}

/** The operator's credential for `cell-ops`, as handed to the agent (stdin). */
export interface OperatorCredential {
  /** The control plane's webhook base (the one `cell:*` posts `/cell-ops` to). */
  control: string
  operatorKey: string
}

const CELL_OPS_TIMEOUT_MS = 5_000

/** The signed `cell-ops` body (headers as the control plane verifies them). */
export function signCellOps(
  operatorKey: string,
  body: Record<string, unknown>,
  nowSec: number,
): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify(body)
  const ts = String(nowSec)
  const signature = createHmac("sha256", operatorKey).update(`${ts}.${raw}`).digest("base64")
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "x-operator-ts": ts,
      "x-operator-signature": signature,
    },
  }
}

function toDecision(body: Record<string, unknown>): MoveDecision {
  if (body.ok === true && typeof body.state === "string") {
    return {
      ok: true,
      state: body.state as MoveState,
      leaseUntil: typeof body.leaseUntil === "string" ? body.leaseUntil : null,
    }
  }
  if (body.ok === false && typeof body.code === "string") {
    return {
      ok: false,
      code: body.code,
      ...(typeof body.state === "string" ? { state: body.state as MoveState } : {}),
    }
  }
  return { ok: false, code: "unreachable", error: "an unexpected reply" }
}

export interface ControlDeps {
  fetch?: typeof fetch
  now?: () => number
}

/** The production client: cell-billing for the lease, cell-ops for the decisions. */
export function controlPlaneMoveControl(
  args: { orgId: string; transferId: string; operator: OperatorCredential | null },
  deps: ControlDeps = {},
): MoveControl {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const billing = async (type: "move.heartbeat" | "move.status", phase?: MoveAgentPhase) => {
    try {
      const { callControlBilling } = await import("~/modules/billing-managed/control-client")
      const data = {
        requestId: randomUUID(),
        orgId: args.orgId,
        transferId: args.transferId,
        ...(type === "move.heartbeat" ? { phase: phase ?? "planned" } : {}),
      }
      const reply = await callControlBilling(type, data as never)
      return toDecision(reply as unknown as Record<string, unknown>)
    } catch (err) {
      return { ok: false as const, code: "unreachable" as const, error: String(err) }
    }
  }
  const cellOps = async (op: string, extra: Record<string, unknown>): Promise<MoveDecision> => {
    if (!args.operator) {
      return { ok: false, code: "unreachable", error: "no operator credential was handed over" }
    }
    const body = { op, messageId: randomUUID(), transferId: args.transferId, ...extra }
    const signed = signCellOps(args.operator.operatorKey, body, Math.floor(now() / 1000))
    try {
      const res = await doFetch(`${args.operator.control.replace(/\/$/, "")}/cell-ops`, {
        method: "POST",
        headers: signed.headers,
        body: signed.raw,
        signal: AbortSignal.timeout(CELL_OPS_TIMEOUT_MS),
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, code: "unreachable", error: `HTTP ${res.status}` }
      const parsed = JSON.parse(text) as Record<string, unknown>
      return toDecision((parsed.data ?? parsed) as Record<string, unknown>)
    } catch (err) {
      return { ok: false, code: "unreachable", error: String(err) }
    }
  }
  return {
    heartbeat: (phase) => billing("move.heartbeat", phase),
    status: () => billing("move.status"),
    freeze: () => cellOps("move_freeze", {}),
    commit: (freezeMs) => cellOps("move_commit", { freezeMs: Math.max(0, Math.round(freezeMs)) }),
    abort: (reason) => cellOps("move_abort", { reason }),
  }
}

/** Committed (or later) per the control plane. */
export function isCommitted(d: MoveDecision): boolean {
  return (
    (d.ok && (d.state === "committed" || d.state === "finalized")) ||
    (!d.ok && d.code === "already_committed")
  )
}

/** Aborted per the control plane (the org belongs to the source). */
export function isAborted(d: MoveDecision): boolean {
  if (d.ok) return d.state === "aborted" || d.state === "failed"
  return (
    d.code === "aborted" || d.code === "lease_expired" || ("state" in d && d.state === "aborted")
  )
}
