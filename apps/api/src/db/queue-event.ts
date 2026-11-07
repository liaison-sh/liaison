// SPDX-License-Identifier: FSL-1.1-ALv2
import { pendingEvents } from "~/db/schema/kernel"
import { type AppEvent, declaredEmits } from "~/infra/events/event-bus"
import { signalOutboxWake } from "~/infra/events/outbox-wake"
import { captureActingAgentId, currentRunContext } from "~/modules/agent/runtime/run-context"
import { isSeeding } from "~/modules/notifications/seeded"

/**
 * Stamp the firing routine's id into an event emitted from INSIDE a routine tick, so an
 * event-routine never RE-TRIGGERS ITSELF on a record change IT just made. A kind:'event' routine
 * that MUTATES the entity it watches (e.g. a WIP-limit routine on `projects:task:moved` that itself
 * calls `projects:move`) would otherwise cascade: its own moves re-emit `projects:task:moved`,
 * re-fire the routine, and over-trim the column past the limit (the kanban 7→5→3 over-trim). The
 * event-routine subscriber drops any event whose `metadata.firedByRoutineId` equals the subscribed
 * routine — so the routine's own mutations never feed back into it. We merge (never overwrite) so an
 * event's existing metadata is preserved. Outside a routine tick this is a no-op.
 */
function stampFiringRoutineId(event: AppEvent): AppEvent {
  const routineId = currentRunContext()?.routineId
  if (!routineId) return event
  const existing =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>)
      : {}
  if (existing.firedByRoutineId) return event // already stamped (nested tick) — keep the outermost
  return { ...event, metadata: { ...existing, firedByRoutineId: routineId } }
}

/**
 * Mark an event queued by a seed (`runAsSeed`, notifications/seeded.ts) as the
 * seed's own, so no event routine reacts to the world a seed writes. Merged,
 * never overwriting the emitter's metadata. Outside a seed this is a no-op.
 */
function stampSeeded(event: AppEvent): AppEvent {
  if (!isSeeding()) return event
  const existing =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>)
      : {}
  if (existing.seeded === true) return event
  return { ...event, metadata: { ...existing, seeded: true } }
}

/**
 * Per-db-handle acting agent, for a caller that has already crossed a hop where
 * the ALS frame is gone. See {@link setEventAgentDefault}. A WeakMap, not a
 * property on the handle: the sandbox bridge is also built over a poison
 * transaction (a Proxy that throws on every property access) while its method
 * surface is enumerated, and a WeakMap key touches no property at all.
 *
 * The slot records WHICH TURN declared it, so the identity cannot be picked up
 * by a different turn that happens to reuse the same handle. Outside any frame
 * (a per-call bridge rebuild) the turn comes from the frame the caller captured
 * while it was live; `turnKey` is null only when nothing was captured either.
 */
interface HandleAgentDefault {
  agentId: string
  turnKey: string | null
  /** The message the declaring turn answers (`RunContext.turnMessageId`), when known. */
  turnMessageId: string | null
}

/** A handle's declaration; `null` is a positive "no agent acted". */
const handleAgentDefaults = new WeakMap<object, HandleAgentDefault | null>()

/**
 * Each savepoint handle's parent (`wireQueueEvent`): a handle with no
 * declaration of its own reads the nearest one up the chain, so a service that
 * opens its own savepoint inside a bridge call still writes as the bridge's
 * agent.
 */
const handleParents = new WeakMap<object, object>()

/**
 * Declare WHICH AGENT owns every event queued through this db handle from here
 * on, for a caller whose ALS frame will be lost by the time the write happens.
 * The sandbox bridge is the case: it captures the acting agent host-side, in
 * frame, then hands this handle to the app's own services (a knowledge document
 * create runs entirely inside `apps/knowledge/service.ts`, which knows nothing
 * about agents), and their callbacks run in a worker-pool hop where
 * `currentRunContext()` is undefined.
 *
 * A null agent CLEARS the handle rather than doing nothing: "no agent acted" is
 * a positive answer, and a declaration that could not overwrite one already on
 * the handle would leave the previous agent stamping writes that are not its
 * own. The sole caller declares unconditionally when it builds a bridge, so a
 * second bridge over a reused handle resets the identity instead of inheriting
 * whatever the first one left there.
 */
export function setEventAgentDefault(
  tx: unknown,
  agentId: string | null,
  captured?: { turnMessageId?: string; run?: { rootRunId: string } } | null,
): void {
  if (typeof tx !== "object" || tx === null) return
  if (!agentId) {
    handleAgentDefaults.set(tx, null)
    return
  }
  // The live frame when there is one; otherwise the turn the caller captured
  // while its frame was live. A per-call sandbox bridge rebuild declares here
  // OUTSIDE the frame, and without the capture its writes named the agent but
  // not the request it answered.
  const frame = currentRunContext()
  handleAgentDefaults.set(tx, {
    agentId,
    turnKey: frame?.rootRunId ?? captured?.run?.rootRunId ?? null,
    turnMessageId: frame?.turnMessageId ?? captured?.turnMessageId ?? null,
  })
}

/**
 * The handle default, honoured only for the turn that declared it. A LIVE frame
 * belonging to some other turn gets nothing: this is the weakest rung of the
 * precedence ladder and it must never outlive or cross into a turn that did not
 * declare it. No live frame at all IS the lost-frame hop the default exists for,
 * so that case still reads it.
 */
function handleDefaultFor(handle: object): HandleAgentDefault | null {
  let current: object | undefined = handle
  while (current && !handleAgentDefaults.has(current)) current = handleParents.get(current)
  const declared = current ? handleAgentDefaults.get(current) : null
  if (!declared) return null
  const live = currentRunContext()
  if (live && live.rootRunId !== declared.turnKey) return null
  return declared
}

function handleAgentDefaultFor(handle: object): string | null {
  return handleDefaultFor(handle)?.agentId ?? null
}

/**
 * Stamp the message the emitting agent turn answers (`metadata.turnMessageId`),
 * so a consumer can tell which request an agent's write came from: a guided
 * tour beat completes only on the work its own request caused, never on what
 * another turn of the same agent did meanwhile. Same sources, same precedence
 * and same refusal to cross turns as the acting agent below; outside a turn it
 * stays absent. Merged, never overwriting a value the emitter set.
 */
function stampTurnMessageId(event: AppEvent, handle: object): AppEvent {
  const turnMessageId =
    currentRunContext()?.turnMessageId ?? handleDefaultFor(handle)?.turnMessageId ?? null
  if (!turnMessageId) return event
  const existing =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>)
      : {}
  if (existing.turnMessageId) return event
  return { ...event, metadata: { ...existing, turnMessageId } }
}

/**
 * Stamp WHICH AGENT is acting onto an event emitted during a turn (A11), so
 * `kernel.audit_log.agent_id` can answer "what did this agent do" for EVERY
 * durable row, not just the handful of emit sites that remember to pass one.
 * The audit consumer has no entity allowlist: every non-ephemeral event with a
 * valid org becomes an audit row, so anything less than a central stamp leaves
 * an agent's writes filed under no agent.
 *
 * Precedence, and the reason for each:
 *   1. an EXPLICIT `agentId` on the event always wins, null included — that
 *      emitter either knows the agent (it carried one across a hop) or knows
 *      positively that there was none;
 *   2. the LIVE run frame, which is the turn actually executing this write;
 *   3. the handle default the sandbox bridge set for the hop that lost the frame.
 *
 * Outside all three it stays absent, which is the true answer there: a human
 * request, a job, a cron or a webhook has no acting agent. Never guessed, and
 * never the human's id: an unknown agent reads as no agent.
 */
function stampActingAgentId(event: AppEvent, handle: object): AppEvent {
  if (event.agentId !== undefined) return event
  const agentId = captureActingAgentId() ?? handleAgentDefaultFor(handle) ?? null
  if (!agentId) return event
  return { ...event, agentId }
}

/**
 * Fail loudly at insert time when a kernel event type is not declared in the
 * kernel emit set. Without this, an undeclared kernel emit commits to
 * `pending_events`, then the outbox worker throws on every publish attempt and
 * silently dead-letters after MAX_ATTEMPTS — losing audit/timeline/WS dispatch
 * with no surfaced error. Kernel emits are fully known at boot (`initEventBus`),
 * so a missing declaration is always a programming error caught here.
 *
 * Only enforced once the kernel set is populated (i.e. `initEventBus` ran).
 * Non-kernel apps validate at publish time against their org-scoped emit sets.
 */
function assertKernelEventDeclared(event: AppEvent): void {
  if (event.app !== "kernel" || event.ephemeral) return
  const kernelEmits = declaredEmits.get("kernel")
  if (!kernelEmits || kernelEmits.size === 0) return
  const key = `${event.entity}:${event.action}`
  if (!kernelEmits.has(key)) {
    throw new Error(
      `Kernel event type "${key}" is not declared in the kernel emit set — ` +
        `add it to declaredEmits in infra/events/event-bus.ts`,
    )
  }
}

/**
 * Attach `queueEvent` to a transaction handle AND wrap `.transaction()` so that
 * nested/savepoint transactions also carry `queueEvent`.
 *
 * This is critical: Drizzle's `db.transaction(fn)` produces a fresh `tx` object
 * that doesn't inherit properties from the parent. Without this wrapper, calling
 * `tx.queueEvent()` inside a nested transaction would fail with "not a function".
 *
 * The orgId for the pending_events row is taken from `event.orgId`. The row is
 * inserted as the transaction's own role (liaison_rls or liaison_admin).
 *
 * Each handle queues through ITSELF: the row is inserted through the handle the
 * event was queued on and stamped from that handle's agent declaration. Bound
 * to the outer transaction instead, an event queued inside a savepoint lost
 * the agent the sandbox bridge declared on the savepoint, and a failed outbox
 * insert the caller caught still failed the whole transaction (postgres.js
 * rethrows a scope's failed query when the scope ends).
 */
function wireQueueEvent(
  tx: any,
  impl: (handle: any, event: AppEvent) => Promise<void>,
  implMany: (handle: any, events: AppEvent[]) => Promise<void>,
): void {
  Object.defineProperty(tx, "queueEvent", {
    value: (event: AppEvent) => impl(tx, event),
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(tx, "queueEvents", {
    value: (events: AppEvent[]) => implMany(tx, events),
    enumerable: false,
    configurable: true,
  })
  const originalTransaction = tx.transaction.bind(tx)
  Object.defineProperty(tx, "transaction", {
    value: async (fn: (nestedTx: any) => Promise<any>) => {
      return originalTransaction(async (nestedTx: any) => {
        handleParents.set(nestedTx, tx)
        wireQueueEvent(nestedTx, impl, implMany) // Recursive — works at ANY depth
        return fn(nestedTx)
      })
    },
    enumerable: false,
    configurable: true,
  })
}

/** Outbox rows per INSERT statement (two bound parameters each). */
const QUEUE_EVENTS_CHUNK = 500

/**
 * What a transaction queued, read by its wrapper once it has committed: a
 * transaction that queued an event wakes the outbox worker (`outbox-wake.ts`).
 */
export interface QueuedEventsMark {
  queued: boolean
}

/**
 * Wake the outbox worker once `txPromise` (the whole transaction, so its
 * commit) has resolved, when it queued an event. A rolled-back transaction
 * wakes nothing: its rows are gone.
 */
export function wakeOutboxAfterCommit(txPromise: Promise<unknown>, mark: QueuedEventsMark): void {
  txPromise.then(
    () => {
      if (mark.queued) signalOutboxWake()
    },
    () => {},
  )
}

export function attachQueueEvent(tx: any, defaultOrgId: string, mark?: QueuedEventsMark): void {
  // Every event is stamped and checked exactly as before; `queueEvents` only
  // collapses N outbox inserts into one multi-row insert per chunk. A sync page
  // announces dozens of rows at once.
  //
  // The insert runs as the transaction's own role, never elevated: liaison_rls
  // has INSERT on pending_events and an INSERT-only policy (WITH CHECK true,
  // 0000_initial.sql), and liaison_admin bypasses RLS. A request transaction on
  // the split request login cannot step into liaison_admin at all, and the
  // outbox row still commits or rolls back with the transaction that queued it.
  const insertRows = async (handle: any, rows: Array<{ orgId: string; payload: AppEvent }>) => {
    for (let start = 0; start < rows.length; start += QUEUE_EVENTS_CHUNK) {
      await handle.insert(pendingEvents).values(rows.slice(start, start + QUEUE_EVENTS_CHUNK))
    }
    if (mark && rows.length > 0) mark.queued = true
  }
  const toRow = (handle: object, rawEvent: AppEvent) => {
    const event = stampTurnMessageId(
      stampActingAgentId(stampFiringRoutineId(stampSeeded(rawEvent)), handle),
      handle,
    )
    assertKernelEventDeclared(event)
    return { orgId: event.orgId || defaultOrgId, payload: event }
  }
  const queueEventImpl = async (handle: any, rawEvent: AppEvent) => {
    await insertRows(handle, [toRow(handle, rawEvent)])
  }
  const queueEventsImpl = async (handle: any, rawEvents: AppEvent[]) => {
    // All stamped and checked before anything is written: one undeclared kernel
    // event refuses the batch.
    const rows = rawEvents.map((event) => toRow(handle, event))
    if (rows.length > 0) await insertRows(handle, rows)
  }

  wireQueueEvent(tx, queueEventImpl, queueEventsImpl)
}
