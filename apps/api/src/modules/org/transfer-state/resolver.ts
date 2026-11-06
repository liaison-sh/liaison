// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The move resolver: an org draining, frozen or incoming is settled by
// asking the control plane what it decided for the move (`move.status`), never
// by this instance alone, so the org never has two writers:
//  - committed (or finalized): a source copy becomes `moved`, a target copy
//    is served (state cleared). Acted on as soon as it is read: the commit is
//    a compare-and-set in the control plane, so no answer can follow it but
//    `committed`. The control plane is asked from `CONTROL_ASK_AFTER_MS` after
//    the state was entered, every pass, so a source agent that dies right
//    after the commit costs the target one or two passes, not the deadline;
//  - aborted (or failed): a source copy is unfrozen (state cleared) at once,
//    since an aborted move never commits; a target copy is purged (`incoming`,
//    it never served anything) only past `FREEZE_DEADLINE_MS`, so a purge never
//    races an import still running;
//  - still open (precopy, draining, frozen): nothing yet, the control plane
//    aborts the move itself once the driver's lease lapses. The answer names
//    the lease's end, and the loop asks again just past it instead of waiting
//    for its next pass, so a source whose agent died while frozen is unfrozen
//    about one lease after its last heartbeat, not a lease plus a pass;
//  - control plane unreachable: the org stays as it is; past
//    `FREEZE_DEADLINE_MS` a critical alert is logged every 60 s ("org frozen,
//    control plane unreachable").
// One resolver per cell: the leader's (infra/leadership.ts).

import { randomUUID } from "node:crypto"
import type { MoveState } from "@liaison/control-plane-contract"
import { registerSingleton } from "~/infra/leadership"
import { rootLogger } from "~/lib/logger"
import {
  FREEZE_DEADLINE_MS,
  type OrgTransferRecord,
  orgTransferView,
  setOrgTransferState,
} from "./state"

const log = rootLogger.child({ module: "org-transfer-resolver" })

/** How often the leader looks for overdue moves. */
export const RESOLVER_INTERVAL_MS = 5_000
/**
 * How long after an org entered its state the control plane is first asked.
 * The source's own agent settles a healthy move within it; past it, a
 * committed move is served on the next pass (<= this + one interval).
 */
export const CONTROL_ASK_AFTER_MS = 5_000
/** How long past a lease's end the extra ask is made (Control decides on the lapsed lease). */
export const LEASE_LAPSE_MARGIN_MS = 250
/** How often an unresolved org's critical alert repeats. */
export const UNRESOLVED_ALERT_EVERY_MS = 60_000

export type ResolveAction =
  | "marked-moved"
  | "unfrozen"
  | "served"
  | "purged"
  | "waiting"
  | "unreachable"
  | "purge-unavailable"
  | "unknown-state"

export interface ResolveOutcome {
  orgId: string
  transferId: string
  from: OrgTransferRecord["state"]
  decided: MoveState | null
  action: ResolveAction
  /** For an open move the control plane still holds: when its lease ends (epoch ms). */
  leaseUntil?: number
}

/** What `move.status` answers: the state, and when the driver's lease ends (null: none held). */
export interface MoveStatusAnswer {
  state: MoveState
  leaseUntil: string | null
}

export interface ResolverDeps {
  /** The moving orgs now (fresh). */
  moving: () => Promise<OrgTransferRecord[]>
  /** The control plane's state of the move (with its lease when known); throws when it cannot be asked. */
  askControl: (orgId: string, transferId: string) => Promise<MoveState | MoveStatusAnswer>
  setState: typeof setOrgTransferState
  /** Resume the after-commit steps of committed moves that never finished; null when none is wired. */
  resumeAfterCommit: typeof afterCommitResume
  /** Remove an incoming copy whose move was aborted; null when none is wired. */
  purgeIncoming: ((orgId: string, transferId: string) => Promise<void>) | null
  now: () => number
}

let afterCommitResume:
  | ((askControl: (orgId: string, transferId: string) => Promise<MoveState>) => Promise<void>)
  | null = null

/** Wire the resume of after-commit steps a dead source agent left undone (org transfer supplies it). */
export function setAfterCommitResume(
  fn:
    | ((askControl: (orgId: string, transferId: string) => Promise<MoveState>) => Promise<void>)
    | null,
): void {
  afterCommitResume = fn
}

let incomingPurge: ((orgId: string, transferId: string) => Promise<void>) | null = null

/** Wire how an aborted incoming copy is removed (the org transfer import supplies it). */
export function setIncomingOrgPurge(
  fn: ((orgId: string, transferId: string) => Promise<void>) | null,
): void {
  incomingPurge = fn
}

export async function askControlPlane(
  orgId: string,
  transferId: string,
): Promise<MoveStatusAnswer> {
  const { callControlBilling } = await import("~/modules/billing-managed/control-client")
  const reply = await callControlBilling("move.status", {
    requestId: randomUUID(),
    orgId,
    transferId,
  })
  if (reply.ok !== true) throw new Error(`move.status refused: ${reply.code}`)
  return { state: reply.state, leaseUntil: reply.leaseUntil }
}

const stateOf = (a: MoveState | MoveStatusAnswer): MoveState =>
  typeof a === "string" ? a : a.state

const defaultDeps = (): ResolverDeps => ({
  moving: () => orgTransferView.current(),
  askControl: askControlPlane,
  setState: setOrgTransferState,
  purgeIncoming: incomingPurge,
  resumeAfterCommit: afterCommitResume,
  now: Date.now,
})

const lastAlertAt = new Map<string, number>()

function alertUnresolved(rec: OrgTransferRecord, now: number, reason: string): void {
  const last = lastAlertAt.get(rec.orgId) ?? 0
  if (now - last < UNRESOLVED_ALERT_EVERY_MS) return
  lastAlertAt.set(rec.orgId, now)
  log.error(
    {
      alert: "org_move_unresolved",
      orgId: rec.orgId,
      transferId: rec.transferId,
      state: rec.state,
      sinceMs: now - rec.at,
      reason,
    },
    `org ${rec.state} past its move deadline and not resolved: ${reason}`,
  )
}

/** One pass: settle every moving org the control plane has decided. Never throws per org. */
export async function resolveOverdueMoves(
  partial: Partial<ResolverDeps> = {},
): Promise<ResolveOutcome[]> {
  const deps: ResolverDeps = { ...defaultDeps(), ...partial }
  const now = deps.now()
  const out: ResolveOutcome[] = []
  for (const rec of await deps.moving()) {
    if (rec.state === "moved") continue
    const age = now - rec.at
    if (age < CONTROL_ASK_AFTER_MS) continue
    // A time this release cannot read counts as overdue (alerts, never early action).
    const overdue = !(age < FREEZE_DEADLINE_MS)
    const base = { orgId: rec.orgId, transferId: rec.transferId, from: rec.state }
    if (rec.unknown) {
      // Read as frozen for the gates; acting on it (moved, unfrozen, purged)
      // would apply this release's handling to a state it does not know.
      if (overdue) alertUnresolved(rec, now, "its move state is unknown to this release")
      out.push({ ...base, decided: null, action: "unknown-state" })
      continue
    }
    let decided: MoveState
    let leaseUntil: number | undefined
    try {
      const answer = await deps.askControl(rec.orgId, rec.transferId)
      decided = stateOf(answer)
      if (typeof answer !== "string" && answer.leaseUntil) {
        const ms = Date.parse(answer.leaseUntil)
        if (Number.isFinite(ms)) leaseUntil = ms
      }
    } catch (err) {
      if (overdue) {
        log.warn({ err, orgId: rec.orgId }, "move status unavailable; the org stays as it is")
        alertUnresolved(rec, now, "control plane unreachable")
      }
      out.push({ ...base, decided: null, action: "unreachable" })
      continue
    }
    try {
      const committed = decided === "committed" || decided === "finalized"
      const aborted = decided === "aborted" || decided === "failed"
      if (rec.state === "incoming") {
        if (committed) {
          await deps.setState(rec.orgId, null, rec.transferId)
          out.push({ ...base, decided, action: "served" })
        } else if (aborted && overdue) {
          if (!deps.purgeIncoming) {
            alertUnresolved(rec, now, "aborted, but no purge of the incoming copy is wired")
            out.push({ ...base, decided, action: "purge-unavailable" })
          } else {
            await deps.purgeIncoming(rec.orgId, rec.transferId)
            out.push({ ...base, decided, action: "purged" })
          }
        } else {
          out.push({ ...base, decided, action: "waiting" })
        }
      } else if (committed) {
        await deps.setState(rec.orgId, "moved", rec.transferId)
        out.push({ ...base, decided, action: "marked-moved" })
      } else if (aborted) {
        await deps.setState(rec.orgId, null, rec.transferId)
        out.push({ ...base, decided, action: "unfrozen" })
      } else {
        if (overdue) alertUnresolved(rec, now, `the control plane still has it ${decided}`)
        out.push({
          ...base,
          decided,
          action: "waiting",
          ...(leaseUntil === undefined ? {} : { leaseUntil }),
        })
      }
      if (out.at(-1)?.action !== "waiting") {
        lastAlertAt.delete(rec.orgId)
        log.info({ ...base, decided }, "moving org settled from the control plane")
      }
    } catch (err) {
      log.error({ err, orgId: rec.orgId, decided }, "resolving an overdue org move failed")
    }
  }
  // After the states settle: a committed move whose source agent died before
  // its after-commit steps finished is completed from the staged set.
  if (deps.resumeAfterCommit) {
    const ask = deps.askControl
    await deps
      .resumeAfterCommit(async (orgId, transferId) => stateOf(await ask(orgId, transferId)))
      .catch((err) => {
        log.warn({ err }, "resuming after-commit steps failed; retried on the next pass")
      })
  }
  return out
}

/**
 * When to ask again before the next regular pass: just past the earliest lease
 * end of an open move, when that comes sooner than the pass. Null: the pass is
 * soon enough (or no lease is known).
 *
 * A lease already over by this cell's clock while Control still holds the move
 * open means the clocks disagree (this one ahead): asking again at once would
 * poll Control every margin for the whole move. Such a transfer gets ONE extra
 * ask; after that (`askedEarly` holds it) only the regular pass asks.
 */
export function nextLeaseAskDelay(
  outcomes: readonly ResolveOutcome[],
  now: number,
  intervalMs: number = RESOLVER_INTERVAL_MS,
  askedEarly: ReadonlySet<string> = new Set(),
): number | null {
  let soonest: number | null = null
  for (const o of outcomes) {
    if (o.action !== "waiting" || o.leaseUntil === undefined) continue
    if (o.leaseUntil <= now && askedEarly.has(o.transferId)) continue
    const delay = Math.max(0, o.leaseUntil - now) + LEASE_LAPSE_MARGIN_MS
    if (delay < intervalMs && (soonest === null || delay < soonest)) soonest = delay
  }
  return soonest
}

let timer: ReturnType<typeof setInterval> | null = null
let leaseTimer: ReturnType<typeof setTimeout> | null = null
/** One pass at a time: the interval and the lease timer never run two together. */
let passRunning = false
/** Transfers whose already-lapsed lease got its one extra ask (see nextLeaseAskDelay). */
const askedEarly = new Set<string>()

function runPass(): void {
  if (passRunning) return
  passRunning = true
  void resolveOverdueMoves()
    .then((outcomes) => {
      const now = Date.now()
      // Forget transfers no longer waiting, or whose lease is ahead again.
      const open = new Set(
        outcomes
          .filter(
            (o) => o.action === "waiting" && o.leaseUntil !== undefined && o.leaseUntil <= now,
          )
          .map((o) => o.transferId),
      )
      for (const id of askedEarly) if (!open.has(id)) askedEarly.delete(id)
      const delay = nextLeaseAskDelay(outcomes, now, RESOLVER_INTERVAL_MS, askedEarly)
      if (delay === null || leaseTimer || !timer) return
      for (const id of open) askedEarly.add(id)
      leaseTimer = setTimeout(() => {
        leaseTimer = null
        if (timer) runPass()
      }, delay)
      leaseTimer.unref?.()
    })
    .catch((err) => log.error({ err }, "org move resolver failed"))
    .finally(() => {
      passRunning = false
    })
}

/** Test access: run one pass of the loop as the leader would (in-flight guard included). */
export const ResolverLoopTestAccess = {
  runPass,
  isRunning: () => passRunning,
}

/** The leader's resolver loop. */
export function registerOrgTransferResolver(): void {
  registerSingleton({
    name: "org-transfer-resolver",
    onAcquired: () => {
      if (timer) return
      timer = setInterval(runPass, RESOLVER_INTERVAL_MS)
      timer.unref?.()
    },
    onLost: () => {
      if (timer) clearInterval(timer)
      timer = null
      if (leaseTimer) clearTimeout(leaseTimer)
      leaseTimer = null
    },
  })
}
