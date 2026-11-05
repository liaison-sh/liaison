// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine run that needs its owner's PRIVATE mailbox waits for its owner.
//
// A private (zero-access) mailbox is readable only in its owner's own
// unlocked Liaison window: the server holds no key, and the browser decrypts
// only for a turn THAT browser started (its turn nonce, agent-plaintext-
// responder.ts). A routine tick runs with nobody's browser in the loop, so its
// read is refused (MAILBOX_LOCKED). Before this the run simply ended, and the
// routine silently did nothing.
//
// Now the run PARKS:
//
//   park     The tick of the owner's own routine (routine-mailbox-trust.ts:
//            created and last edited by the owner, run on its schedule, its
//            event or the owner's own run-now) met the owner's private mailbox
//            (the broker sets `routineMailboxWait` on the tick's frame). The run
//            row becomes `waiting_mailbox` (ids and times only, never mail),
//            and the owner gets one item in their approvals list, "Routine
//            run waiting for your private mailbox", with Run now and Dismiss
//            (attention kind `routine_mailbox_wait`). A SCHEDULED tick while
//            one waits is skipped, so a routine running every hour still makes
//            one item, not 24. An EVENT tick is never skipped for it: each
//            event is its own run (a new email is not covered by an earlier
//            run), so one that also needs the locked mailbox parks its own
//            run and item, and no event is dropped while the owner is away.
//   run      Run now, pressed in the owner's own window, mints a turn nonce in
//            that browser and starts the run in the API process with it
//            (`runWaitingMailboxRun`). Only the mailbox owner, signed in as
//            themselves, may run it; the routine trust is checked again (an
//            edit by someone else since the park refuses it).
//   handoff  The owner may close the window as soon as Run now answered. In
//            that click the browser opens the message(s) that started the run
//            (the trigger event's message, when it is in the owner's own
//            private mailbox): the server registers ONE broker request for
//            those ids under the click's nonce and returns it, the browser's
//            responder answers it like any turn's read (same consent bounds,
//            same caps, POST /agent/mailbox-plaintext/:id), and the answer is
//            held on the run's frame, in memory, for that run only, emptied
//            when it ends (run-context.ts `MailboxHandoff`). Nothing new is
//            stored or logged. A further private read of the run still goes
//            to a live window if one answers; with none it gets the named
//            MAILBOX_NEEDS_WINDOW result at once (the broker), never a hang.
//   queue    A Run now while another run of the routine holds the routine
//            lock (the first of two waiting runs, pressed one after the
//            other) is queued: it starts as soon as the lock frees, and the
//            answer says so (`queued`), so the row reads "starts after the
//            current run". It never answers 202 and silently gives the claim
//            back.
//   dismiss  The owner may decline it instead: the row turns
//            `mailbox_wait_dismissed` and its item leaves the list.
//   expire   A wait nobody ran lapses after 24 hours: the row turns
//            `mailbox_wait_expired` (the run history shows it) and its item
//            leaves the list. No backlog builds up.
//
// A routine someone else set up or changed (an admin, a delegate) never gets
// here: it has no mailbox reader, so its read is refused and nothing parks.
// No crypto changes: plaintext still reaches a turn only through the browser
// broker.

import crypto from "node:crypto"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { attentionEvents, auditLog, routineRuns, routines } from "~/db/schema/kernel"
import type { RoutineRunMailboxWait, RoutineRunWaitEvent } from "~/db/schema/kernel/routine-runs"
import { rootLogger } from "~/lib/logger"
import { routineMailboxReader } from "~/modules/agent/mailbox-plaintext/routine-mailbox-trust"
import { settleRunStarted } from "~/modules/agent/routines/routine-report"
import type {
  RoutineTickOpts,
  RoutineTickResult,
  RoutineTriggerEvent,
} from "~/modules/agent/routines/routine-worker"
import type {
  MailboxHandoff,
  MailboxHandoffItem,
  RoutineMailboxWaitSignal,
} from "~/modules/agent/runtime/run-context"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"

const log = rootLogger.child({ module: "routine-mailbox-wait" })

/** How long a parked run waits for its owner. */
export const MAILBOX_WAIT_TTL_MS = 24 * 60 * 60 * 1000

/** The run row's error while it waits: what the run history shows. */
export const MAILBOX_WAIT_REASON =
  "Waiting for you: this run needs your private mailbox, which only your own unlocked Liaison window can read. Press Run now in your approvals within 24 hours. Until then, this routine's other scheduled runs are skipped; each new event waits as its own run."
export const MAILBOX_WAIT_EXPIRED_REASON =
  "Nobody ran it within 24 hours, so this run did not happen. The routine runs again at its next time."
export const MAILBOX_WAIT_DISMISSED_REASON =
  "Dismissed: you chose not to run it, so this run did not happen. The routine runs again at its next time."
/** A scheduled tick while an earlier run waits: skipped, so one routine makes one wait. */
export const MAILBOX_WAIT_SKIP_REASON =
  "Skipped: an earlier run of this routine is waiting for you to open your private mailbox (Run now in your approvals). The routine runs on its schedule again once that run ran or expired (24 hours at most)."

export function newMailboxWaitSignal(): RoutineMailboxWaitSignal {
  return { needed: false, accountIds: [] }
}

/** The approvals item's key: one per waiting run. */
export function mailboxWaitEntityId(runId: string): string {
  return `routine-mailbox-wait:${runId}`
}

/**
 * Take a waiting run's item out of its owner's list (it ran, was dismissed or
 * expired): its unread row is marked read and the owner's windows are told.
 */
async function resolveMailboxWaitItems(
  orgId: string,
  items: ReadonlyArray<{ runId: string; ownerUserId: string }>,
): Promise<void> {
  for (const { runId, ownerUserId } of items) {
    const entityId = mailboxWaitEntityId(runId)
    try {
      const rows = await withPrivilegedDb(orgId, "routine-mailbox-wait-item-read", (tx) =>
        tx
          .update(attentionEvents)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(attentionEvents.orgId, orgId),
              eq(attentionEvents.userId, ownerUserId),
              eq(attentionEvents.app, "kernel"),
              eq(attentionEvents.entityType, "agent_notification"),
              eq(attentionEvents.entityId, entityId),
              isNull(attentionEvents.readAt),
            ),
          )
          .returning({ id: attentionEvents.id }),
      )
      if (rows.length > 0) {
        await broadcastReadState(orgId, ownerUserId, {
          kind: "attention",
          app: "kernel",
          entityType: "agent_notification",
          entityId,
        })
      }
    } catch (err) {
      log.error({ err, orgId, runId }, "taking a waiting run's item out of the list failed")
    }
  }
}

/** Mark every lapsed wait of this routine (or of the whole org) expired. Returns how many. */
export async function expireMailboxWaits(orgId: string, routineId?: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "routine-mailbox-wait-expire", (tx) =>
    tx
      .update(routineRuns)
      .set({ status: "mailbox_wait_expired", error: MAILBOX_WAIT_EXPIRED_REASON })
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          ...(routineId ? [eq(routineRuns.routineId, routineId)] : []),
          eq(routineRuns.status, "waiting_mailbox"),
          sql`(${routineRuns.mailboxWait}->>'expiresAt')::timestamptz <= now()`,
        ),
      )
      .returning({ id: routineRuns.id, wait: routineRuns.mailboxWait }),
  )
  await resolveMailboxWaitItems(
    orgId,
    rows.flatMap((r) => (r.wait ? [{ runId: r.id, ownerUserId: r.wait.ownerUserId }] : [])),
  )
  return rows.length
}

/** Every org's lapsed waits, for the scheduled sweep. */
export async function sweepExpiredMailboxWaits(): Promise<number> {
  const { withSystemDb } = await import("~/db/privileged")
  const orgs = await withSystemDb("routine-mailbox-wait-orgs", (db) =>
    db
      .selectDistinct({ orgId: routineRuns.orgId })
      .from(routineRuns)
      .where(eq(routineRuns.status, "waiting_mailbox")),
  )
  let expired = 0
  for (const { orgId } of orgs) expired += await expireMailboxWaits(orgId)
  return expired
}

/** The run of this routine that waits for its owner's mailbox now, if any (lapsed ones expire first). */
export async function pendingMailboxWait(
  orgId: string,
  routineId: string,
): Promise<{ id: string } | null> {
  await expireMailboxWaits(orgId, routineId)
  const [row] = await withPrivilegedDb(orgId, "routine-mailbox-wait-pending", (tx) =>
    tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          eq(routineRuns.routineId, routineId),
          eq(routineRuns.status, "waiting_mailbox"),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

/**
 * The event an event run was fired for, as a wait keeps it: its ids and kind,
 * never its data (which can carry a subject or a snippet). Run now reads the
 * data back by `eventId` (`eventForRunNow`).
 */
function waitEventOf(ev: RoutineTriggerEvent | undefined): RoutineRunWaitEvent | null {
  if (!ev) return null
  return {
    app: ev.app,
    entity: ev.entity,
    action: ev.action,
    entityId: ev.entityId,
    ...(ev.origin ? { origin: ev.origin } : {}),
    ...(ev.eventId ? { eventId: ev.eventId } : {}),
    ...(ev.retryAttempt !== undefined ? { retryAttempt: ev.retryAttempt } : {}),
  }
}

/**
 * The event a Run now handles: the kept ids with the event's data read back
 * from the audit log (where every durable event lands with its outbox id), or
 * no data when it is not there (an event with no id, or a row pruned since).
 */
async function eventForRunNow(
  orgId: string,
  wait: RoutineRunWaitEvent,
): Promise<RoutineTriggerEvent> {
  let data: unknown = wait.data ?? null
  if (wait.data === undefined && wait.eventId) {
    const [row] = await withPrivilegedDb(orgId, "routine-mailbox-wait-event", (tx) =>
      tx
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.eventId, wait.eventId as string)))
        .limit(1),
    )
    data = row?.changes ?? null
  }
  return { ...wait, data } as RoutineTriggerEvent
}

/**
 * The owner's approvals item for a waiting run (attention kind
 * `routine_mailbox_wait`, kernel-translations.ts): one row per run, for the
 * owner alone. What started the run is said by the event's kind only (a new
 * email), never its data: a private mailbox's sender and subject are sealed.
 */
async function queueWaitItem(
  tx: PrivilegedDb,
  routine: typeof routines.$inferSelect,
  runId: string,
  wait: RoutineRunMailboxWait,
): Promise<void> {
  const ev = wait.triggerEvent
  await tx.queueEvent({
    app: "kernel",
    entity: "agent_notification",
    action: "create",
    entityId: mailboxWaitEntityId(runId),
    data: {
      summary: `Routine "${routine.name}" is waiting for your private mailbox`,
      urgency: 60,
      targetUserIds: [wait.ownerUserId],
      link: { tabType: "thread", entityId: wait.outputThreadId },
      routineMailboxWait: {
        routineId: routine.id,
        routineName: routine.name,
        runId,
        expiresAt: wait.expiresAt,
        trigger: ev ? { app: ev.app, entity: ev.entity, action: ev.action } : null,
      },
    },
    actorId: wait.ownerUserId,
    actorType: "system",
    agentId: routine.ownerAgentId ?? null,
    orgId: routine.orgId,
    timestamp: new Date().toISOString(),
  })
}

/**
 * Park a run whose turn met its owner's locked private mailbox: the run row
 * waits, and the owner gets one item in their approvals list, with Run now
 * and Dismiss. Ids and times only.
 */
export async function parkRunForMailbox(input: {
  orgId: string
  routine: typeof routines.$inferSelect
  signal: RoutineMailboxWaitSignal
  outputThreadId: string
  startedAt: number
  runLineId: string | null
  tick: Pick<RoutineTickOpts, "triggerEvent" | "requestUuid">
  turnsAdded: number
}): Promise<RoutineTickResult> {
  const { orgId, routine } = input
  const accountId = input.signal.accountIds[0] ?? null
  const expiresAt = new Date(Date.now() + MAILBOX_WAIT_TTL_MS).toISOString()
  const wait: RoutineRunMailboxWait = {
    ownerUserId: routine.ownerUserId,
    accountId,
    expiresAt,
    outputThreadId: input.outputThreadId,
    triggerEvent: waitEventOf(input.tick.triggerEvent),
    claimedAt: null,
  }
  const { writeRunRow, emitRunSkipped } = await import("~/modules/agent/routines/routine-worker")
  const runId = await writeRunRow(orgId, routine.id, "waiting_mailbox", {
    durationMs: Date.now() - input.startedAt,
    error: MAILBOX_WAIT_REASON,
    turnsAdded: input.turnsAdded,
    tick: input.tick,
    startedAt: new Date(input.startedAt),
  })
  await withPrivilegedDb(orgId, "routine-mailbox-wait-park", async (tx) => {
    await tx.update(routineRuns).set({ mailboxWait: wait }).where(eq(routineRuns.id, runId))
    await queueWaitItem(tx, routine, runId, wait)
  })
  await settleRunStarted(orgId, input.runLineId, "failed")
  await emitRunSkipped(
    { orgId, routineId: routine.id, scheduledAt: new Date().toISOString(), ...input.tick },
    routine,
    runId,
    "waiting_mailbox",
    MAILBOX_WAIT_REASON,
  )
  log.info({ orgId, routineId: routine.id, runId }, "routine run waits for its owner's mailbox")
  return { status: "waiting_mailbox", runId }
}

/** The broker request Run now returns for the browser to answer in the same click. */
export interface MailboxHandoffRequest {
  requestId: string
  messageIds: string[]
  expiresAt: string
}

export type MailboxWaitRunOutcome =
  | {
      ok: true
      runId: string
      queued: boolean
      handoff: MailboxHandoffRequest | null
      /** Settles once the launched run has ended and its handoff is released.
       *  The run row reads finished a moment before that, so a caller that must
       *  know the held mail is gone awaits this, not the row. */
      settled: Promise<void>
    }
  | { ok: false; code: "not_found" | "expired" | "claimed" | "refused"; message: string }

export type MailboxWaitDismissOutcome =
  | { ok: true; runId: string }
  | { ok: false; code: "not_found"; message: string }

export interface MailboxWaitRunDeps {
  /** Starts the tick. Production: `runRoutineTick` with the real agent deps. */
  startTick?: (opts: RoutineTickOpts) => Promise<RoutineTickResult>
  /** The trigger's message ids that sit in the owner's own private mailbox. */
  handoffMessageIds?: (input: {
    orgId: string
    userId: string
    event: RoutineRunWaitEvent | null
  }) => Promise<string[]>
  /** True while another run of the routine holds the routine lock. */
  routineBusy?: (routineId: string) => Promise<boolean>
  /** Pause between two tries of a queued run. */
  retryDelayMs?: number
  /** How long the browser has to answer the handoff. */
  handoffWaitMs?: number
}

/** How long the owner's browser has to open the handoff mail, in the click. */
export const MAILBOX_HANDOFF_WAIT_MS = 60_000
/** A queued Run now retries this often while the routine is busy. */
export const MAILBOX_QUEUE_RETRY_MS = 5_000
/** A queued Run now waits at most this long for the routine to free up. */
export const MAILBOX_QUEUE_MAX_MS = 30 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A new message's id, from any app: the owner's private mailbox lookup below
 * keeps only ids that are messages of a mailbox, so no app name is checked here.
 */
function triggerMessageIds(event: RoutineRunWaitEvent | null): string[] {
  if (!event || event.action !== "create") return []
  if (event.entity !== "message" && event.entity !== "email") return []
  return typeof event.entityId === "string" && UUID_RE.test(event.entityId) ? [event.entityId] : []
}

/** Only messages of the owner's OWN private mailbox are handed off. */
async function productionHandoffMessageIds(input: {
  orgId: string
  userId: string
  event: RoutineRunWaitEvent | null
}): Promise<string[]> {
  const ids = triggerMessageIds(input.event)
  if (ids.length === 0) return []
  const { privateMailboxAccountsOf } = await import(
    "~/modules/agent/mailbox-plaintext/mailbox-managed-reader"
  )
  const owned = await privateMailboxAccountsOf({
    orgId: input.orgId,
    userId: input.userId,
    marker: { requestKind: "mail.read", messageIds: ids, purpose: "" },
  })
  return owned ? ids : []
}

async function productionRoutineBusy(routineId: string): Promise<boolean> {
  const { redis } = await import("~/lib/redis")
  try {
    return (await redis.exists(`routine-lock:${routineId}`)) > 0
  } catch {
    return false
  }
}

/**
 * Register the handoff request and resolve with what the browser opened, kept
 * to the ids asked for. A refusal, a timeout or nothing to hand off is an
 * empty handoff: the run still runs, and its private reads take the live path
 * (or the named MAILBOX_NEEDS_WINDOW result).
 */
async function registerHandoff(input: {
  orgId: string
  userId: string
  turnNonce: string
  messageIds: string[]
  waitMs: number
}): Promise<{ request: MailboxHandoffRequest; handoff: Promise<MailboxHandoff> }> {
  const { mintMailboxRequestId, registerMailboxRequest } = await import(
    "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
  )
  const requestId = mintMailboxRequestId()
  const pending = registerMailboxRequest({
    requestId,
    userId: input.userId,
    orgId: input.orgId,
    turnNonce: input.turnNonce,
    kind: "mail.read",
    messageIds: input.messageIds,
  })
  const timer = setTimeout(() => pending.cancel("timeout"), input.waitMs)
  const asked = new Set(input.messageIds)
  const handoff = pending.promise.then((outcome) => {
    clearTimeout(timer)
    const items = new Map<string, MailboxHandoffItem>()
    if (outcome.kind === "plaintext") {
      for (const item of outcome.items) {
        if (!asked.has(item.messageId)) continue
        items.set(item.messageId, {
          messageId: item.messageId,
          subject: item.subject ?? null,
          textBody: item.textBody ?? null,
          htmlBody: item.htmlBody ?? null,
        })
      }
    }
    return { items }
  })
  return {
    request: {
      requestId,
      messageIds: input.messageIds,
      expiresAt: new Date(Date.now() + input.waitMs).toISOString(),
    },
    handoff,
  }
}

async function productionStartTick(opts: RoutineTickOpts): Promise<RoutineTickResult> {
  const { runRoutineTick } = await import("~/modules/agent/routines/routine-worker")
  const { productionRoutineTickDeps } = await import("~/infra/jobs/kernel-jobs")
  return runRoutineTick({ ...productionRoutineTickDeps(opts.routineId), ...opts })
}

/**
 * Run now, from the mailbox owner's own window. `userId` is the signed-in
 * person, `turnNonce` the nonce their browser minted for this run. Starts the
 * run in this process (the one the browser answers) and returns once it has
 * started; the run's reads go through the browser broker like any turn.
 */
export async function runWaitingMailboxRun(
  input: { orgId: string; userId: string; routineId: string; runId: string; turnNonce: string },
  deps: MailboxWaitRunDeps = {},
): Promise<MailboxWaitRunOutcome> {
  const { orgId, userId, routineId, runId, turnNonce } = input
  const notFound = {
    ok: false as const,
    code: "not_found" as const,
    message: "No run of this routine is waiting for your mailbox.",
  }
  const found = await withPrivilegedDb(orgId, "routine-mailbox-wait-load", async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
    const [run] = await tx
      .select()
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.id, runId),
          eq(routineRuns.orgId, orgId),
          eq(routineRuns.routineId, routineId),
        ),
      )
    return routine && run ? { routine, run } : null
  })
  if (!found) return notFound
  const { routine, run } = found
  const wait = run.mailboxWait
  // Only the mailbox owner, in their own session: never anyone else's.
  if (!wait || routine.ownerUserId !== userId || wait.ownerUserId !== userId) return notFound
  if (run.status === "mailbox_wait_expired" || Date.parse(wait.expiresAt) <= Date.now()) {
    await expireMailboxWaits(orgId, routineId)
    return {
      ok: false,
      code: "expired",
      message: "This run waited 24 hours and expired. The routine runs again at its next time.",
    }
  }
  if (run.status !== "waiting_mailbox") return notFound
  // The routine must still be the owner's own work: someone else's edit since
  // the park (or a delegated create) never reads the owner's mailbox.
  if (routineMailboxReader(routine, userId) !== userId) {
    return {
      ok: false,
      code: "refused",
      message:
        "Someone else changed this routine since it started waiting, so it cannot read your private mailbox. Check the routine and save it yourself, then it can run.",
    }
  }
  // One Run now per wait: a second press (or a second device) is refused.
  const claimedAt = new Date().toISOString()
  const claimed = await withPrivilegedDb(orgId, "routine-mailbox-wait-claim", (tx) =>
    tx
      .update(routineRuns)
      .set({ mailboxWait: { ...wait, claimedAt } })
      .where(
        and(
          eq(routineRuns.id, runId),
          eq(routineRuns.status, "waiting_mailbox"),
          sql`${routineRuns.mailboxWait}->>'claimedAt' IS NULL`,
        ),
      )
      .returning({ id: routineRuns.id }),
  )
  if (claimed.length === 0) {
    return { ok: false, code: "claimed", message: "This run is already running." }
  }
  await resolveMailboxWaitItems(orgId, [{ runId, ownerUserId: userId }])
  const startTick = deps.startTick ?? productionStartTick
  // The mail that started the run, opened by the owner's browser in this click.
  const handoffIds = await (deps.handoffMessageIds ?? productionHandoffMessageIds)({
    orgId,
    userId,
    event: wait.triggerEvent ?? null,
  }).catch(() => [] as string[])
  const registered =
    handoffIds.length > 0
      ? await registerHandoff({
          orgId,
          userId,
          turnNonce,
          messageIds: handoffIds,
          waitMs: deps.handoffWaitMs ?? MAILBOX_HANDOFF_WAIT_MS,
        })
      : null
  const queued = await (deps.routineBusy ?? productionRoutineBusy)(routineId)
  const tick: RoutineTickOpts = {
    orgId,
    routineId,
    scheduledAt: claimedAt,
    // A run-now by the owner: the trust check (routine-mailbox-trust.ts) reads it.
    requestUuid: crypto.randomUUID(),
    requestedByUserId: userId,
    ...(wait.triggerEvent ? { triggerEvent: await eventForRunNow(orgId, wait.triggerEvent) } : {}),
    deferOnOverlap: true,
    mailboxTurnNonce: turnNonce,
    mailboxWaitRunId: runId,
  }
  const retryDelayMs = deps.retryDelayMs ?? MAILBOX_QUEUE_RETRY_MS
  const queueUntil = Math.min(Date.parse(wait.expiresAt), Date.now() + MAILBOX_QUEUE_MAX_MS)
  // Not awaited: the run takes minutes. A routine another run holds is queued:
  // tried again once that run let go, never given back silently.
  const launch = async (handoff: MailboxHandoff): Promise<void> => {
    try {
      let result = await startTick({ ...tick, mailboxHandoff: handoff })
      while (result.status === "lock_busy" && Date.now() + retryDelayMs < queueUntil) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        result = await startTick({ ...tick, mailboxHandoff: handoff })
      }
      await settleUnfinishedWait(orgId, runId, wait, result)
    } catch (err) {
      log.error({ err, orgId, routineId, runId }, "Run now of a waiting routine run failed")
      await settleUnfinishedWait(orgId, runId, wait, { status: "failed" })
    } finally {
      // The handoff lives as long as the run, no longer.
      handoff.items.clear()
    }
  }
  const settled = registered ? registered.handoff.then(launch) : launch({ items: new Map() })
  return { ok: true, runId, queued, handoff: registered?.request ?? null, settled }
}

/**
 * Dismiss, from the mailbox owner's approvals list: the run does not happen,
 * its row says so in the run history and its item leaves the list. Only the
 * mailbox owner; a run Run now already started is not dismissed.
 */
export async function dismissWaitingMailboxRun(input: {
  orgId: string
  userId: string
  routineId: string
  runId: string
}): Promise<MailboxWaitDismissOutcome> {
  const { orgId, userId, routineId, runId } = input
  const rows = await withPrivilegedDb(orgId, "routine-mailbox-wait-dismiss", (tx) =>
    tx
      .update(routineRuns)
      .set({ status: "mailbox_wait_dismissed", error: MAILBOX_WAIT_DISMISSED_REASON })
      .where(
        and(
          eq(routineRuns.id, runId),
          eq(routineRuns.orgId, orgId),
          eq(routineRuns.routineId, routineId),
          eq(routineRuns.status, "waiting_mailbox"),
          sql`${routineRuns.mailboxWait}->>'ownerUserId' = ${userId}`,
          sql`${routineRuns.mailboxWait}->>'claimedAt' IS NULL`,
          inArray(
            routineRuns.routineId,
            tx
              .select({ id: routines.id })
              .from(routines)
              .where(and(eq(routines.orgId, orgId), eq(routines.ownerUserId, userId))),
          ),
        ),
      )
      .returning({ id: routineRuns.id }),
  )
  if (rows.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message: "No run of this routine is waiting for your mailbox.",
    }
  }
  await resolveMailboxWaitItems(orgId, [{ runId, ownerUserId: userId }])
  return { ok: true, runId }
}

/**
 * The run Run now started ended without settling the waiting row (another run
 * held the routine, it was paused or skipped): a busy routine gives the wait
 * back for another press, anything else ends the wait with what happened.
 */
async function settleUnfinishedWait(
  orgId: string,
  runId: string,
  wait: RoutineRunMailboxWait,
  result: RoutineTickResult,
): Promise<void> {
  if (result.runId === runId) return
  await withPrivilegedDb(orgId, "routine-mailbox-wait-settle", async (tx) => {
    const rows = await tx
      .update(routineRuns)
      .set(
        result.status === "lock_busy"
          ? { mailboxWait: { ...wait, claimedAt: null } }
          : {
              status: "failed",
              error: `Run now did not run to the end (${result.status}); see the routine's next run.`,
            },
      )
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "waiting_mailbox")))
      .returning({ routineId: routineRuns.routineId })
    // A busy routine gives the wait back: its item returns to the owner's list.
    if (result.status === "lock_busy" && rows[0]) {
      const [routine] = await tx.select().from(routines).where(eq(routines.id, rows[0].routineId))
      if (routine) await queueWaitItem(tx, routine, runId, wait)
    }
  })
}
