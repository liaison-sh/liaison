// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The durable turns running in THIS process, for the shutdown's turn phase
 * (S10, M2). At the turn drain cap each one is asked to stop at its next step
 * boundary; its finalize then hands it off (turn-resume.ts `handOffTurn`)
 * instead of writing a reply. A step still running after the settle budget
 * has only its MODEL call cut: its tools run on (they hold a signal a drain
 * abort does not trip), so a write that started finishes and its ledger row
 * reaches `done` before the process goes.
 */
import { rootLogger } from "~/lib/logger"
import { awaitPrepared, awaitTurns, markTurnPrepared } from "~/modules/agent/runtime/active-turns"

const log = rootLogger.child({ module: "turn-handoff" })

/** How often a running turn's heartbeat moves while it runs (M3). */
export const TURN_TOUCH_INTERVAL_MS = 10_000

export interface DurableTurnControls {
  turnId: string
  orgId: string
  /**
   * False for a turn no resume can rebuild (its caller holds the reply): a
   * drain does not hand it off. It runs to the hard deadline like any work.
   * Default true.
   */
  resumable?: boolean
  /** Move the turn's heartbeat (called every TURN_TOUCH_INTERVAL_MS while it runs). */
  touch?: () => Promise<void>
  /** Stop after the current step; finalize hands the turn off. */
  requestHandoff: () => void
  /** Cut the model call now (tools keep running); finalize hands the turn off. */
  abortModel: () => void
}

interface Entry extends DurableTurnControls {
  settled: Promise<void>
  settle: () => void
}

const turns = new Map<string, Entry>()

/** Register a running durable turn; the returned function ends it (idempotent). */
export function registerDurableTurn(controls: DurableTurnControls): () => void {
  let settle = () => {}
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const entry: Entry = { ...controls, settled, settle }
  turns.set(controls.turnId, entry)
  // The tracked turn this runs in (active-turns.ts) is no longer preparing:
  // from here a drain can hand it off.
  markTurnPrepared()
  const touch = controls.touch
  const timer = touch
    ? setInterval(() => {
        touch().catch((err: unknown) =>
          log.warn({ err, turnId: controls.turnId }, "turn_touch_failed"),
        )
      }, TURN_TOUCH_INTERVAL_MS)
    : null
  timer?.unref?.()
  return () => {
    if (timer) clearInterval(timer)
    if (turns.get(controls.turnId) === entry) turns.delete(controls.turnId)
    settle()
  }
}

/** Is `turnId` running in THIS process right now (registered, not yet ended)? */
export function isDurableTurnRunningHere(turnId: string): boolean {
  return turns.has(turnId)
}

export function runningDurableTurns(): string[] {
  return [...turns.keys()]
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

/**
 * Hand off every durable turn still running: stop at the step boundary, wait
 * up to `settleMs`; cut the model call of the ones still in a step, wait up to
 * `toolSettleMs` more. Resolves with the turns that did not settle.
 */
export async function handOffRunningTurns(
  settleMs: number,
  toolSettleMs: number,
): Promise<{ requested: string[]; unsettled: string[] }> {
  const entries = [...turns.values()].filter((e) => e.resumable !== false)
  if (entries.length === 0) return { requested: [], unsettled: [] }
  for (const entry of entries) entry.requestHandoff()
  log.info({ turns: entries.map((e) => e.turnId), settleMs }, "turn_handoff_requested")
  const settledWithin = async (list: Entry[], ms: number): Promise<Entry[]> => {
    const done = new Set<Entry>()
    await Promise.race([Promise.all(list.map((e) => e.settled.then(() => done.add(e)))), wait(ms)])
    return list.filter((e) => !done.has(e))
  }
  let pending = await settledWithin(entries, settleMs)
  if (pending.length > 0) {
    for (const entry of pending) entry.abortModel()
    pending = await settledWithin(pending, toolSettleMs)
  }
  if (pending.length > 0) {
    log.warn({ turns: pending.map((e) => e.turnId) }, "turn_handoff_unsettled")
  }
  return { requested: entries.map((e) => e.turnId), unsettled: pending.map((e) => e.turnId) }
}

/**
 * The shutdown's turn phase (lib/shutdown-phases.ts): running turns finish
 * within `drainMs`. Past it the durable ones hand off. A turn accepted late in
 * the edge grace may still be preparing (message write, app setup, ledger
 * row), with nothing to hand off yet: it is waited for, inside the settle
 * budget, so it is handed off rather than cut when the pools close.
 */
export async function drainTurns(
  drainMs: number,
  settleMs: number,
  toolSettleMs: number,
): Promise<{ drained: boolean; requested: string[]; unsettled: string[]; preparing: string[] }> {
  const { drained, remaining } = await awaitTurns(drainMs)
  if (drained) return { drained, requested: [], unsettled: [], preparing: [] }
  log.warn({ remaining, budgetMs: drainMs }, "Turn drain budget spent")
  const prepStarted = Date.now()
  const prep = await awaitPrepared(settleMs)
  if (!prep.prepared) {
    log.warn({ preparing: prep.preparing }, "turn_handoff_still_preparing")
  }
  const handoff = await handOffRunningTurns(
    Math.max(0, settleMs - (Date.now() - prepStarted)),
    toolSettleMs,
  )
  return { drained, ...handoff, preparing: prep.preparing }
}

export const TurnHandoffTestAccess = {
  clear(): void {
    for (const entry of turns.values()) entry.settle()
    turns.clear()
  },
}
