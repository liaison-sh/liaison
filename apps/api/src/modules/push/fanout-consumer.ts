// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Turns one durable event into zero or more pushes.
//
// IT REGISTERS ON THE EXISTING OUTBOX, it does not build a delivery mechanism.
// `registerDurableEventConsumer` (infra/events/durable-consumers.ts) runs this
// for every durable event BEFORE the outbox stamps `processed_at`, and retries
// the row if it throws. That contract is why the two rules below are what they
// are.
//
// IDEMPOTENCY IS PER (EVENT ID, TOKEN). The outbox may hand the same event to
// this consumer more than once (a crash, or another consumer throwing after
// this one ran), and a phone that buzzes twice for one message is the visible
// failure. The mechanism, named explicitly: a BOUNDED IN-PROCESS SET of
// `<eventId>:<tokenId>` keys (`delivered`, capped at DEDUPE_MAX and trimmed
// oldest-first). It is in memory on purpose: the alternative is a delivery
// ledger table, and an event whose process died between the send and the
// ledger write would be re-sent anyway. So the guarantee is honest: no double
// send within a process lifetime, and at most one duplicate across a restart.
// A duplicate notification is recoverable; a wedged outbox is not.
//
// AND IDEMPOTENCY IS PER RECIPIENT ACROSS RESTARTS. The event level mark is
// written after the whole fanout, so a crash between the last send and that
// write replayed everybody; a mark per recipient, written as that recipient's
// devices are done, means a replay re-sends to at most the one recipient who
// was in flight (`recipientMarkKey`).
//
// EVERY SEND IS ROUTED (S2, S3). A push goes out only through `deliver`, which
// takes the recipient's `RouterDecision` (notifications/router.ts, the only
// place one is built) and sends nothing unless its push channel delivers. The
// source rule, no double push: chat groups (`direct`, `replies`) push from
// message events here; every other group pushes from attention-row inserts
// through `pushRouted` (notifications/dispatch.ts), never from its event.
//
// THIS HANDLER DOES NOT THROW. A throw leaves the outbox row unprocessed and
// every OTHER durable consumer's work for that event re-runs on the retry. A
// notification is not worth that, so per-recipient failures are retried here,
// with backoff, and dead-lettered after the budget.
import {
  agentNoticeCode,
  isRunLogThreadType,
  localizeAgentNotice,
  PERSONAL_AGENT_DISPLAY_NAME,
  resolveLocale,
  type ShippedLocale,
  threadAnchorMessageRoute,
  threadAnchorTitle,
} from "@liaison/shared"
import { and, count, eq, inArray, lt } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  organizations,
  pushTokens,
  threadParticipants,
  threadReferences,
  threads,
  userPreferences,
  users,
} from "~/db/schema/kernel"
import {
  hasConsumerHandled,
  loadHandledEventIds,
  markConsumerHandled,
} from "~/infra/events/consumer-marks"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import { EffectInFlight, effectOnce } from "~/lib/effect-once"
import { recordSinkEffect } from "~/lib/effect-sink"
import { isLoadOrg } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { serverT } from "~/modules/i18n/server-i18n"
import { admitBurst, type BurstDeps } from "~/modules/notifications/burst"
import {
  type DeliveryRecord,
  recordDeliveries,
  routerSuppressionRecords,
} from "~/modules/notifications/delivery-log"
import { onDesktopDecision } from "~/modules/notifications/desktop-hook"
import {
  isDirectAsk,
  notificationIdFor,
  ownBannerId,
  type RouterDecision,
  type RouterItem,
  type RouterRecipient,
  resolveChannels,
} from "~/modules/notifications/router"
import { isSeededWrite } from "~/modules/notifications/seeded"
import { recordThreadInteraction } from "~/modules/notifications/thread-activity"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { computeBadgeCount } from "~/modules/push/badge-count"
import { orgLabel as defaultOrgLabel } from "~/modules/push/org-label"
import {
  buildAttentionDeepLink,
  buildDeepLink,
  buildPushPayload,
  PUSH_BODY_MAX,
} from "~/modules/push/redact"
import { sendPush } from "~/modules/push/sender"
import type {
  PushEnvironment,
  PushPayload,
  PushSendResult,
  PushTokenRow,
} from "~/modules/push/types"
import { isDmShapedThread, isPlainThreadShape } from "~/modules/threads/dm-shape"
import { resolveThreadAnchorForReaders, threadAnchorRef } from "~/modules/threads/thread-anchor"
import { isMessageVisible } from "~/services/security/visibility"

const log = rootLogger.child({ module: "push-fanout" })

/** How many times one (event, token) pair is attempted before dead-lettering. */
export const PUSH_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_MS = 500
const DEDUPE_MAX = 10_000

/**
 * How many devices are addressed at once.
 *
 * This handler runs INSIDE the outbox tick, and the tick is the whole
 * platform's event ordering: one provider answering slowly used to stall every
 * remaining token in the batch, then the batch behind it. A small pool keeps
 * the slow one out of everybody else's way without opening an unbounded number
 * of sockets to APNs and FCM on a busy channel.
 */
export const PUSH_CONCURRENCY = 8

/**
 * The whole backoff budget ONE token may spend sleeping in this handler.
 *
 * The retry is a courtesy for a blip, not the delivery guarantee: with an
 * uncapped exponential backoff a provider 5xx held the tick for the sum of
 * every attempt. Past the budget the token is dead-lettered, which is what
 * dead-lettering is for.
 */
export const PUSH_MAX_WAIT_MS = 1_000

export interface PushDeadLetter {
  eventId: string
  tokenId: string
  reason: string
}

export interface PushFanoutDeps {
  /** The wire. Injected so a test can prove the DECISION without a network. */
  send?: (token: PushTokenRow, payload: PushPayload) => Promise<PushSendResult>
  badgeCount?: (userId: string, orgId: string) => Promise<number>
  retryBaseMs?: number
  /** Devices addressed at once. Defaults to `PUSH_CONCURRENCY`. */
  concurrency?: number
  /** Backoff budget per token. Defaults to `PUSH_MAX_WAIT_MS`. */
  maxWaitMs?: number
  onDeadLetter?: (info: PushDeadLetter) => void
  /** The router. Injected in tests; defaults to `resolveChannels`. */
  route?: (recipient: RouterRecipient, item: RouterItem) => Promise<RouterDecision>
  /** The organisation's name every push is labelled with. Defaults to `orgLabel`. */
  orgLabel?: (orgId: string) => Promise<string | undefined>
  /** The effect ledger door. Injected in tests; defaults to `effectOnce`. */
  effectOnce?: typeof effectOnce
  /**
   * The anchored entity's words per recipient, under each one's own visibility.
   * Injected in tests to count reads; defaults to `resolveThreadAnchorForReaders`.
   */
  resolveThreadAnchors?: typeof resolveThreadAnchorForReaders
  /** The burst gate's clock, Redis and summary scheduler (notifications/burst.ts). */
  burst?: BurstDeps
}

const delivered = new Set<string>()

/** This consumer's name in `kernel.durable_consumer_marks`. */
export const PUSH_FANOUT_CONSUMER = "push-fanout"

/**
 * Event ids this process has already fanned out, whatever the outcome.
 *
 * A18's teeth: the fanout reacts to the ORIGINAL event and to nothing else, so
 * a recipient who gains the scope afterwards is never told about the earlier
 * message. They find it on their next fetch, where the read-time predicate
 * admits it. Without this guard a replay of that event id (the outbox retries
 * a row when any OTHER durable consumer throws) would be evaluated against the
 * NEW grants and would push retroactively, which is precisely the behaviour
 * A18 forbids. Same bound and same trim as `delivered`.
 *
 * IT IS A CACHE, NOT THE GUARD. A process-local set dies with the process, and
 * a restart is exactly when the outbox replays: the durable answer is the
 * `durable_consumer_marks` row written beside it, and this set only spares the
 * common case a query. Deciding the question at the event's own time was the
 * alternative and is not available: the grant tables carry no `created_at`,
 * so "was this grant already there" cannot be asked of them at all.
 */
const handled = new Set<string>()

function markHandled(eventId: string): void {
  handled.add(eventId)
  if (handled.size <= DEDUPE_MAX) return
  const oldest = handled.values().next()
  if (!oldest.done) handled.delete(oldest.value)
}

/**
 * The mark key for ONE recipient of one event.
 *
 * The event-level mark is written after the whole fanout, so a process that
 * died between the last send and that write replayed every recipient. A mark
 * written the moment a recipient's own deliveries finish narrows that window
 * to the single recipient who was in flight: everybody already told is skipped
 * on the replay, and the rest are told for the first time.
 *
 * It shares the table and the consumer name with the event-level mark, so the
 * outbox's prune sweeps both, and the `#` separator cannot collide with an
 * event id (a uuid or an outbox row id carries none).
 */
function recipientMarkKey(eventId: string, recipient: string): string {
  return `${eventId}#${recipient}`
}

/**
 * Drops the recipients this consumer already finished for this event, in one
 * query. A replay after a crash is the only case that removes anything.
 */
async function unmarkedRecipients(
  orgId: string,
  eventId: string,
  recipients: string[],
): Promise<string[]> {
  const handledKeys = await loadHandledEventIds(
    orgId,
    PUSH_FANOUT_CONSUMER,
    recipients.map((recipient) => recipientMarkKey(eventId, recipient)),
  )
  return recipients.filter((recipient) => !handledKeys.has(recipientMarkKey(eventId, recipient)))
}

/**
 * Counts a recipient's devices down and writes that recipient's mark when the
 * last one is done.
 *
 * Why a counter rather than one job per recipient: the delivery pool is over
 * TOKENS, and it must stay that way. A recipient with four devices and a
 * provider answering slowly would otherwise hold its whole job, which is the
 * stall the bounded pool exists to prevent.
 */
function recipientMarkers(
  orgId: string,
  eventId: string,
  deviceCounts: Map<string, number>,
): (recipient: string) => Promise<void> {
  const remaining = new Map(deviceCounts)
  return async (recipient: string) => {
    const left = (remaining.get(recipient) ?? 1) - 1
    remaining.set(recipient, left)
    if (left > 0) return
    await markConsumerHandled(orgId, PUSH_FANOUT_CONSUMER, recipientMarkKey(eventId, recipient))
  }
}

function markDelivered(key: string): void {
  delivered.add(key)
  if (delivered.size <= DEDUPE_MAX) return
  // Sets iterate in insertion order, so the first key is the oldest.
  const oldest = delivered.values().next()
  if (!oldest.done) delivered.delete(oldest.value)
}

interface MessageEventData {
  id?: string
  threadId?: string
  authorId?: string
  authorName?: string
  authorType?: string
  content?: string
  participantIds?: unknown
  mentions?: unknown
  requiredScopes?: unknown
  disclosureList?: unknown
  /** 0112: the reply thread's root, when the message is a reply. */
  replyRootId?: unknown
  alsoInChannel?: unknown
  /** The reply thread's followers, carried on a reply's event. */
  followerIds?: unknown
  /** The message's metadata (`type` names a system notice). */
  metadata?: unknown
  /** An agent row that ends its turn or run (`SendMessageParams.endsTurn`). */
  endsTurn?: unknown
}

/** The mentioned USERS, and only those: an agent mention is never a push. */
function mentionedUserIds(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return []
  const ids: string[] = []
  for (const mention of mentions) {
    if (mention && typeof mention === "object") {
      const m = mention as { type?: unknown; id?: unknown }
      if (m.type === "user" && typeof m.id === "string") ids.push(m.id)
    }
  }
  return ids
}

export async function loadTokens(
  orgId: string,
  userIds: string[],
): Promise<Array<PushTokenRow & { userId: string }>> {
  if (userIds.length === 0) return []
  return withPrivilegedDb(orgId, "push-fanout-tokens", (tx) =>
    tx
      .select({
        id: pushTokens.id,
        userId: pushTokens.userId,
        platform: pushTokens.platform,
        token: pushTokens.token,
        environment: pushTokens.environment,
        multiServer: pushTokens.multiServer,
      })
      .from(pushTokens)
      .where(and(eq(pushTokens.orgId, orgId), inArray(pushTokens.userId, userIds))),
  )
}

/**
 * A18: WHO may be told at all.
 *
 * The predicate is `isMessageVisible`, the app-level mirror of the messages
 * SELECT policy, IMPORTED and not restated. A push is a read of the fact that
 * a message exists, delivered to a device, and a second predicate here would
 * be free to disagree with the one the read path and the RLS policy share.
 * Membership is the caller's half, as everywhere else that calls this: the
 * recipients handed in are already thread participants.
 *
 * It fails closed for free: an event whose `requiredScopes` is not a readable
 * array satisfies no scope branch, so nobody is told rather than everybody.
 */
async function visibleRecipients(
  orgId: string,
  recipients: string[],
  message: { requiredScopes: unknown; disclosureList: unknown },
): Promise<string[]> {
  if (recipients.length === 0) return []
  const facts = {
    requiredScopes: message.requiredScopes as string[],
    disclosureList: Array.isArray(message.disclosureList)
      ? (message.disclosureList as string[])
      : null,
  }
  // An untagged message is visible to every member, so no grants are loaded.
  if (Array.isArray(facts.requiredScopes) && facts.requiredScopes.length === 0) return recipients
  return withPrivilegedDb(orgId, "push-fanout-recipient-grants", async (tx) => {
    const kept: string[] = []
    for (const userId of recipients) {
      const { scopes } = await loadEffectivePermissions(tx, userId, orgId)
      if (isMessageVisible(facts, { userId, grants: scopes })) kept.push(userId)
    }
    return kept
  })
}

/**
 * The thread's HUMAN participants. Agent seats carry `user_id` NULL (0075), so
 * they cannot appear here at all: an agent is never a push target, and that is
 * a property of the query rather than a filter somebody can forget.
 *
 * This is the MEMBERSHIP half of the visibility predicate, which
 * `isMessageVisible` leaves to its caller. Without it a mention of somebody who
 * is not in the room would push them a notification about a room they cannot
 * open, and the deep link would land on a 404 at best.
 */
async function threadSeats(
  orgId: string,
  threadId: string,
): Promise<{ humanIds: string[]; agentCount: number }> {
  const rows = await withPrivilegedDb(orgId, "push-fanout-participants", (tx) =>
    tx
      .select({ userId: threadParticipants.userId, agentId: threadParticipants.agentId })
      .from(threadParticipants)
      .where(and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.orgId, orgId))),
  )
  return {
    humanIds: rows.map((r) => r.userId).filter((id): id is string => typeof id === "string"),
    // The AGENT seats, which the DM rule needs and this query used to throw
    // away (P6d-FX7, SK-3). A row is one or the other by a table check.
    agentCount: rows.filter((r) => typeof r.agentId === "string").length,
  }
}

/** Everything `isDmShapedThread` asks about a stored thread. */
interface ThreadShape {
  type: string
  title: string | null
  isPinned: boolean
  createdFrom: unknown
  referenceCount: number
}

async function loadThread(orgId: string, threadId: string): Promise<ThreadShape | null> {
  return withPrivilegedDb(orgId, "push-fanout-thread", async (tx) => {
    const [row] = await tx
      .select({
        type: threads.type,
        title: threads.title,
        isPinned: threads.isPinned,
        createdFrom: threads.createdFrom,
      })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      .limit(1)
    if (!row) return null
    const [refs] = await tx
      .select({ value: count() })
      .from(threadReferences)
      .where(and(eq(threadReferences.threadId, threadId), eq(threadReferences.orgId, orgId)))
    return { ...row, referenceCount: Number(refs?.value ?? 0) }
  })
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/**
 * The provider says this device is gone for good (APNs 410 or BadDeviceToken,
 * FCM UNREGISTERED). The row is REMOVED, not flagged: a dead token is a
 * wasted request on every future fanout, and a stale row would otherwise live
 * as long as the account.
 *
 * BUT ONLY A ROW NOBODY REGISTERED SINCE. The verdict is about the token as
 * it was when it died, and a phone posts the same token again on an app
 * update or a fresh sign-in, possibly while this push was in flight. Apple's
 * rule: stop sending only if the token was not registered after the 410's
 * `timestamp`. So the DELETE is guarded in SQL by the row's `updated_at`
 * (which every registration POST rewrites) being older than both that
 * timestamp and the moment this send started; a re-registration that lands
 * at any point keeps the row, and the handset keeps receiving.
 */
async function deleteDeadToken(
  orgId: string,
  tokenId: string,
  sendStartedAt: Date,
  unregisteredAt?: Date,
): Promise<void> {
  const cutoff =
    unregisteredAt && unregisteredAt.getTime() < sendStartedAt.getTime()
      ? unregisteredAt
      : sendStartedAt
  await withPrivilegedDb(orgId, "push-fanout-delete-dead-token", (tx) =>
    tx
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.id, tokenId),
          eq(pushTokens.orgId, orgId),
          lt(pushTokens.updatedAt, cutoff),
        ),
      ),
  )
}

/**
 * The OTHER APNs host accepted a token its row placed on the first one (S11):
 * the row learns the host that works, so the next fanout goes there first.
 */
async function rewriteTokenEnvironment(
  orgId: string,
  tokenId: string,
  environment: PushEnvironment,
): Promise<void> {
  await withPrivilegedDb(orgId, "push-fanout-token-environment", (tx) =>
    tx
      .update(pushTokens)
      .set({ environment, updatedAt: new Date() })
      .where(and(eq(pushTokens.id, tokenId), eq(pushTokens.orgId, orgId))),
  )
}

/**
 * The delivery-log rows of one send (S1): one per provider answer, so the
 * APNs sandbox/production retry leaves a row per host tried. A result with no
 * provider answer (no credential, a transport throw) is one row.
 */
function attemptRecords(
  decision: RouterDecision,
  token: PushTokenRow,
  payload: PushPayload,
  result: PushSendResult,
): DeliveryRecord[] {
  const notificationId = payload.notificationId
  if (!notificationId) return []
  const base = {
    orgId: decision.orgId,
    userId: decision.userId,
    notificationId,
    channel: "push" as const,
    deviceId: token.id,
    surface: token.platform,
    payload,
  }
  const now = Date.now()
  if (result.hosts && result.hosts.length > 0) {
    return result.hosts.map((h, i) => ({
      ...base,
      result: h.status >= 200 && h.status < 300 ? ("accepted" as const) : ("rejected" as const),
      providerStatus: h.status,
      reason: h.reason ?? null,
      attemptedAt: new Date(now + i),
    }))
  }
  return [
    {
      ...base,
      result: result.kind === "sent" ? "accepted" : "rejected",
      reason:
        result.kind === "sent"
          ? null
          : `${result.kind}${result.detail ? `: ${result.detail}` : ""}`,
      attemptedAt: new Date(now),
    },
  ]
}

/** A push still transient after its retry budget: it did not reach the device. */
class PushNotDelivered extends Error {
  constructor(readonly result: PushSendResult) {
    super(`push not delivered: ${result.detail ?? result.kind}`)
    this.name = "PushNotDelivered"
  }
}

/**
 * The one door to the wire. It takes the recipient's `RouterDecision` and
 * sends nothing unless the router said push delivers, so no caller can send a
 * push the router did not decide (S2: a hand-built object does not typecheck).
 */
async function deliver(
  decision: RouterDecision,
  eventId: string,
  token: PushTokenRow,
  payload: PushPayload,
  deps: PushFanoutDeps,
): Promise<void> {
  if (!decision.channels.push.deliver) return
  const orgId = decision.orgId
  const key = `${eventId}:${token.id}`
  if (delivered.has(key)) return
  const send = deps.send ?? sendPush
  // Every push names its organisation: a phone signed in to several servers
  // receives from all of them, and the user has to see which one is talking.
  if (payload.serverLabel === undefined) {
    const label = await (deps.orgLabel ?? defaultOrgLabel)(orgId).catch(() => undefined)
    if (label) payload = { ...payload, serverLabel: label }
  }
  // A load org's push goes to the effect sink, never to a device (A13). The
  // sink stands in for the send inside the ledger's claim below, so its count
  // is what would have reached devices: a doubled count is a doubled push.
  const sink = await isLoadOrg(orgId)
  const base = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  let budget = deps.maxWaitMs ?? PUSH_MAX_WAIT_MS
  // A registration newer than this survives a dead-token verdict.
  const sendStartedAt = new Date()
  const attempts = async (): Promise<PushSendResult> => {
    if (sink) {
      await recordSinkEffect(orgId, "push", `push:${key}`)
      return { kind: "sent" }
    }
    let result: PushSendResult = { kind: "transient", detail: "not attempted" }
    for (let attempt = 0; attempt < PUSH_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // The sleep never exceeds what is LEFT of the budget, and an exhausted
        // budget ends the attempts rather than sleeping zero and hammering.
        if (budget <= 0) break
        const wait = Math.min(base * 2 ** (attempt - 1), budget)
        budget -= wait
        await sleep(wait)
      }
      try {
        result = await send(token, payload)
      } catch (err) {
        result = { kind: "transient", detail: String(err) }
      }
      await recordDeliveries(attemptRecords(decision, token, payload, result))
      if (result.kind !== "transient") break
    }
    // Still transient after the budget: the push did not happen. Thrown so the
    // ledger releases the claim and a replay may try this device again.
    if (result.kind === "transient") throw new PushNotDelivered(result)
    return result
  }
  // Claimed in the effect ledger BEFORE the send (S11): the per-recipient
  // consumer mark is written only after a recipient's last device, so a
  // process that died between a send and that mark replayed the send. Now the
  // replay finds this device's key done (or unknown: at most once) and skips
  // it. The mark stays, for the re-decision rule above (A18).
  const once = deps.effectOnce ?? effectOnce
  let last: PushSendResult
  try {
    const outcome = await once(orgId, `push:${key}`, attempts)
    if (outcome.status !== "ran") {
      markDelivered(key)
      return
    }
    last = outcome.result
  } catch (err) {
    if (err instanceof EffectInFlight) {
      // Another process is sending this very push now: it owns the outcome.
      markDelivered(key)
      return
    }
    if (!(err instanceof PushNotDelivered)) throw err
    last = err.result
  }
  markDelivered(key)
  if (last.kind === "invalid_token") {
    await deleteDeadToken(orgId, token.id, sendStartedAt, last.unregisteredAt)
    return
  }
  if (last.kind === "sent" && last.environment && last.environment !== token.environment) {
    await rewriteTokenEnvironment(orgId, token.id, last.environment)
    return
  }
  if (last.kind === "transient") {
    const info: PushDeadLetter = {
      eventId,
      tokenId: token.id,
      reason: last.detail ?? "transient",
    }
    if (deps.onDeadLetter) deps.onDeadLetter(info)
    else log.warn(info, "Push dead-lettered after the retry budget")
  }
}

/**
 * Is this room one where EVERY message is addressed to everybody in it, so a
 * mention is not required to earn a notification?
 *
 * `kernel.threads.type` is a plain text column with no DM value: a DM is the
 * SHAPE `createThread` dedupes as one, and that shape is `isDmShapedThread`
 * (modules/threads/dm-shape.ts), CALLED here rather than restated. It carries
 * no bound on how many people are in the room, and neither does this: an
 * untitled thread between three people is one conversation, and a copy of the
 * predicate with a `<= 2` bound in it silently notified nobody there.
 *
 * An `agent_chat` with an agent seat is the other 1:1 room, and there the human
 * is told when their agent answers, and so is a TITLED room whose only other
 * seat is an agent (P6d-FX7, SK-3): a channel to the lists since 2026-10-12,
 * but its one human is the only person any message in it can be for, and a
 * room that never notifies them is the same silence by another route. A titled channel with people in it is neither: it
 * pushes on a mention only, or every standup message would buzz every phone.
 */
function isDirectRoom(
  thread: ThreadShape | null,
  humanMemberCount: number,
  agentMemberCount: number,
): boolean {
  if (!thread) return false
  if (thread.type === "agent_chat") return true
  const facts = {
    type: thread.type,
    title: thread.title,
    isPinned: thread.isPinned,
    createdFrom: thread.createdFrom,
    referenceCount: thread.referenceCount,
    humanCount: humanMemberCount,
    agentCount: agentMemberCount,
  }
  if (isDmShapedThread(facts)) return true
  // A titled plain room of one human and one agent is a CHANNEL to every list
  // since A35 was amended (2026-10-12), but every message in it is still for
  // its one human: nobody else is there to be told. Narrowing this to
  // mention-only is the P6d-FX7 silence again.
  return isPlainThreadShape(facts) && facts.humanCount === 1 && facts.agentCount === 1
}

/**
 * Runs the deliveries with a bounded number in flight. The jobs are already
 * built (payloads and badge counts settled), so nothing here reads the
 * database: it is the wire, and only the wire, that is parallel.
 *
 * A job never rejects: `deliver` swallows its own failures into the retry and
 * the dead-letter path, which is what keeps one bad token from failing the
 * batch it shares a pool with.
 */
async function runBounded(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  if (jobs.length === 0) return
  const width = Math.max(1, Math.min(limit, jobs.length))
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      if (index >= jobs.length) return
      await jobs[index]()
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
}

/**
 * The system lines of the approval and access-request lifecycle
 * (`metadata.type`), whose news reaches people through an `approvals` group
 * attention kind instead of the message.
 */
const DECISION_NOTICE_TYPES: ReadonlySet<string> = new Set([
  "approval-created",
  "approval-decision",
  "approval-partial",
  "approval-result",
  "approval-error",
  "scope-request-decision",
])

/** A post an app made through `messages.post` (messages/post.ts `origin_kind`). */
function isAppPost(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false
  return (metadata as { origin_kind?: unknown }).origin_kind === "app_post"
}

function isDecisionNotice(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false
  const type = (metadata as { type?: unknown }).type
  return typeof type === "string" && DECISION_NOTICE_TYPES.has(type)
}

async function handleMessageCreate(
  ctx: DurableEventContext,
  event: AppEvent,
  deps: PushFanoutDeps,
): Promise<void> {
  const orgId = event.orgId
  const data = (event.data ?? {}) as MessageEventData
  if (!orgId || typeof data.threadId !== "string") return
  // A seed's conversation is history, not news (notifications/seeded.ts).
  if (isSeededWrite(data.metadata)) return

  const { humanIds: memberIds, agentCount } = await threadSeats(orgId, data.threadId)
  const members = new Set(memberIds)
  const thread = await loadThread(orgId, data.threadId)
  // A RUN LOG IS NOT A CHAT MESSAGE. A routine's output thread (and a sub-run
  // transcript) records what a run did; every run writing to it must not ping
  // its members as if someone had written to them, mentions included. A
  // routine that has something to say uses `notify_user`, its own channel.
  if (thread && isRunLogThreadType(thread.type)) return
  // A DECISION NOTICE IS NOT A CHAT MESSAGE. An approval's or access request's
  // lifecycle line ("Approval request request-N opened.", "Denied by X") is
  // carried by its own attention kind in the `approvals` group
  // (approval_pending, approval_decision, scope_request, scope_request_decided),
  // routed under that grid row and quiet time like every other approval. Pushed
  // from here too it went out a second time as a reply (or, in a direct room, a
  // mention), past an approvals row switched off, and to the very person whose
  // decision it records.
  if (data.authorType === "system" && isDecisionNotice(data.metadata)) return
  // Nobody is told about their own message (etiquette rule 1).
  const author = typeof data.authorId === "string" ? data.authorId : ""
  const excludeAuthor = data.authorType !== "agent" && data.authorType !== "system"
  // Nor about their own agent's work done for them. The author of an AGENT
  // authored row is the person the turn works for (sendMessage keeps the human
  // as `author_id`). Only the row that ENDS the turn or run (its answer or
  // summary, `endsTurn`) notifies them, as a direct message, unless they are
  // looking at that very conversation. Its progress lines, its questions to
  // other agents and the posts it makes elsewhere because they asked land
  // unread and interrupt nobody who asked for them.
  // A turn that ends in a refusal or a failure ends on a SYSTEM row written
  // for the person who started it (an out-of-credits line, a failed resume):
  // it tells them exactly like a finished answer.
  const ownAgentFor =
    (data.authorType === "agent" || (data.authorType === "system" && data.endsTurn === true)) &&
    author
      ? author
      : null
  const turnEnd = ownAgentFor !== null && data.endsTurn === true
  const skipAuthor = (excludeAuthor || (ownAgentFor !== null && !turnEnd)) && author !== ""
  // Every human member is a candidate; the router decides per recipient. A
  // direct room or a mention is the `direct` group, any other thread message
  // the `replies` group (push off by default, so a channel still pushes only
  // its mentioned members unless the user switched replies push on).
  const direct = isDirectRoom(thread, memberIds.length, agentCount)
  const mentioned = new Set(mentionedUserIds(data.mentions))
  // A REPLY THE CHANNEL DOES NOT SHOW (A5) is addressed to its reply thread's
  // followers, never to the room: not in a channel, not in a DM either. The
  // members it mentions are followers already (the send made them so), and a
  // follower who has since left the room is dropped by `members` below.
  const replyRootId = typeof data.replyRootId === "string" ? data.replyRootId : null
  const threadOnly = replyRootId !== null && data.alsoInChannel !== true
  // WHERE the message is on screen (router rule 6): the channel for a message
  // it shows, the reply thread's root for a reply that lives only there.
  const presenceKey = threadOnly ? (replyRootId as string) : data.threadId
  // A person who just posted there is in it: the answer that follows (their
  // agent's reply, a colleague's) is not pushed to their other devices while
  // they are still at a focused client (notifications/thread-activity.ts).
  if (excludeAuthor && author) await recordThreadInteraction(orgId, author, presenceKey)
  const followers = Array.isArray(data.followerIds)
    ? data.followerIds.filter((id): id is string => typeof id === "string")
    : []
  // A system line (a member added, a routine started) is nobody's direct
  // ask: it lands unread and interrupts only a member it mentions (rule 2).
  // Two system rows are addressed: the end of a person's turn (to them), and
  // an app's post in a direct room, which is a direct message to the people
  // there (in any other room an app's post follows the channel rules).
  const appPost = data.authorType === "system" && isAppPost(data.metadata)
  const audience =
    data.authorType === "system" && !(appPost && direct)
      ? turnEnd
        ? [author, ...mentioned]
        : appPost
          ? threadOnly
            ? [...followers, ...mentioned]
            : [...memberIds, ...mentioned]
          : [...mentioned]
      : threadOnly
        ? [...followers, ...mentioned]
        : [...memberIds, ...mentioned]
  const candidates = [...new Set(audience)].filter(
    (id) => members.has(id) && !(skipAuthor && id === author),
  )
  if (candidates.length === 0) return
  const visible = await visibleRecipients(orgId, candidates, {
    requiredScopes: data.requiredScopes,
    disclosureList: data.disclosureList,
  })
  const recipients = await unmarkedRecipients(orgId, ctx.eventId, visible)
  if (recipients.length === 0) return

  const route = deps.route ?? ((r: RouterRecipient, i: RouterItem) => resolveChannels(r, i))
  const notifyId = `message:${typeof data.id === "string" ? data.id : ctx.eventId}`
  const decisions = new Map<string, RouterDecision>()
  for (const recipient of recipients) {
    const isMention = mentioned.has(recipient)
    decisions.set(
      recipient,
      await route(
        { userId: recipient, orgId },
        turnEnd && recipient === ownAgentFor
          ? // The finished answer of the turn they started: addressed to them
            // like a direct message, held back only while that conversation
            // is on a focused screen (not by having posted there a moment ago).
            {
              kind: "mention",
              app: "kernel",
              threadId: data.threadId,
              isUrgent: false,
              isMention,
              chatMessage: { direct: true },
              presenceKey,
              presenceViewingOnly: true,
            }
          : threadOnly
            ? // A followed reply thread is addressed to its follower: the
              // `thread_followup` kind, whose group is `direct`.
              {
                kind: isMention ? "mention" : "thread_followup",
                app: "kernel",
                threadId: data.threadId,
                isUrgent: false,
                isMention,
                presenceKey,
              }
            : {
                kind: direct || isMention ? "mention" : "thread_reply",
                app: "kernel",
                threadId: data.threadId,
                isUrgent: false,
                isMention,
                chatMessage: { direct },
                presenceKey,
              },
      ),
    )
  }
  // S1: what the router held back is logged before anything is sent.
  await recordDeliveries(
    recipients.flatMap((r) =>
      routerSuppressionRecords(decisions.get(r) as RouterDecision, notifyId),
    ),
  )
  const live = recipients.filter(
    (r) => decisions.get(r)?.channels.push.deliver || decisions.get(r)?.channels.desktop.deliver,
  )
  if (live.length === 0) return

  const tokens = await loadTokens(
    orgId,
    live.filter((r) => decisions.get(r)?.channels.push.deliver),
  )
  const badge = deps.badgeCount ?? computeBadgeCount

  const jobs: Array<() => Promise<void>> = []
  const deviceCounts = new Map<string, number>()
  for (const recipient of live) {
    deviceCounts.set(recipient, tokens.filter((t) => t.userId === recipient).length)
  }
  const recipientDone = recipientMarkers(orgId, ctx.eventId, deviceCounts)
  const rawContent = typeof data.content === "string" ? data.content : ""
  // An agent's failure line is written by the runtime in fixed English: it is
  // rendered in each recipient's language, as every other surface renders it.
  const isAgentNotice = data.authorType === "agent" && agentNoticeCode(rawContent) !== null
  // A message in an ENTITY's thread (a task's comments) is news of the entity:
  // the notification names it and opens it, on this message
  // (modules/threads/thread-anchor.ts). The words are read under EACH
  // recipient's own visibility, in one call for the event: a recipient who may
  // not see the entity (seated by a mention, lost access, an anchor someone
  // else chose) is told only that a thread has a new message, and the tap opens
  // the thread. Locales are read in one query for every recipient.
  const anchorRef = thread ? threadAnchorRef(thread.createdFrom, orgId) : null
  const anchors = anchorRef
    ? await (deps.resolveThreadAnchors ?? resolveThreadAnchorForReaders)(orgId, anchorRef, live)
    : null
  const locales =
    isAgentNotice || anchorRef
      ? await recipientLocales(orgId, live)
      : new Map<string, ShippedLocale>()
  const messageId = typeof data.id === "string" ? data.id : ""
  // The burst gate's view of this message (notifications/burst.ts): who wrote
  // it, which conversation, and whether its text may be shown at all.
  const authorType = typeof data.authorType === "string" ? data.authorType : "user"
  const authorName = typeof data.authorName === "string" ? data.authorName : null
  const actorKey =
    authorType === "agent"
      ? `agent:${authorName ?? PERSONAL_AGENT_DISPLAY_NAME}`
      : author
        ? `${authorType}:${author}`
        : null
  const scopes = data.requiredScopes
  const redacted = !(Array.isArray(scopes) && scopes.length === 0)
  const conversationKind = isTaskDiscussion(thread?.createdFrom) ? "task" : "conversation"
  for (const recipient of live) {
    const decision = decisions.get(recipient) as RouterDecision
    const mine = tokens.filter((t) => t.userId === recipient)
    // A direct message, a mention or an urgent item keeps its own banner and
    // is never folded into someone else's burst.
    const directAsk = isDirectAsk(decision, mentioned.has(recipient))
    const held = await admitBurst(
      decision,
      {
        notifyId,
        actorKey,
        actorName:
          authorType === "agent" ? (authorName ?? PERSONAL_AGENT_DISPLAY_NAME) : authorName,
        conversation: data.threadId,
        conversationKind,
        kind: "message",
        important: directAsk,
        redacted,
      },
      deps.burst,
    )
    if (held) {
      // The burst's summary tells them (notifications/burst.ts). The recipient
      // is done for this event: a replay must not count the note again.
      for (let i = 0; i < Math.max(1, mine.length); i++) await recipientDone(recipient)
      continue
    }
    const anchor = anchors?.get(recipient) ?? null
    const t =
      isAgentNotice || anchorRef
        ? translatorFor(locales.get(recipient) ?? resolveLocale(null, null))
        : null
    const content = isAgentNotice && t ? localizeAgentNotice(rawContent, t) : rawContent
    const built = buildPushPayload(
      {
        id: messageId,
        threadId: data.threadId,
        requiredScopes: (data.requiredScopes ?? null) as string[] | null,
        content,
        authorName:
          typeof data.authorName === "string" ? data.authorName : PERSONAL_AGENT_DISPLAY_NAME,
        // An entity's thread the recipient may not see says nothing of it,
        // its own title included (it may name the entity).
        threadTitle:
          anchorRef && !anchor && t
            ? t("kernel.threadAnchor.hiddenTitle")
            : (thread?.title ?? null),
        replyRootId,
        anchor: anchor && t ? { ...anchor, title: threadAnchorTitle(anchor, t) } : null,
      },
      direct ? "dm" : "mention",
      mine.length > 0 ? await badge(recipient, orgId) : 0,
    )
    const ownBanner = directAsk ? ownBannerId(recipient, notifyId) : null
    const payload: PushPayload = {
      ...built,
      notificationId: notificationIdFor(recipient, notifyId),
      ...(ownBanner ? { collapseId: ownBanner } : {}),
    }
    // The desktop copy carries the same redacted text as the push.
    await onDesktopDecision(decision, {
      notifyId,
      title: payload.title ?? "Liaison",
      body: payload.body ?? GENERIC_MESSAGE_BODY,
      route:
        anchor && messageId
          ? threadAnchorMessageRoute(anchor, data.threadId, messageId)
          : replyRootId
            ? `thread/${data.threadId}?replyRoot=${replyRootId}`
            : `thread/${data.threadId}`,
      ...(ownBanner ? { tag: ownBanner } : {}),
    })
    for (const token of mine) {
      jobs.push(async () => {
        await deliver(
          decision,
          ctx.eventId,
          {
            id: token.id,
            platform: token.platform,
            token: token.token,
            environment: token.environment,
            multiServer: token.multiServer,
          },
          payload,
          deps,
        )
        await recipientDone(recipient)
      })
    }
  }
  await runBounded(jobs, deps.concurrency ?? PUSH_CONCURRENCY)
}

/** A task's discussion thread: its `created_from` names the task (projects app). */
function isTaskDiscussion(createdFrom: unknown): boolean {
  if (!createdFrom || typeof createdFrom !== "object") return false
  return (createdFrom as { entityType?: unknown }).entityType === "task"
}

/** Shown when a payload carries no text (redacted), same words as the push. */
const GENERIC_MESSAGE_BODY = "New message"

/** What an attention-row push says: the group's label over the item's summary. */
export interface RoutedPushContent {
  /** Idempotency key of the item (`attention:<rowId>`): one push per (key, token). */
  notifyId: string
  title: string
  body: string
  /** The item's thread, when it has one: the tap opens it. */
  threadId?: string | null
  /** A thread-less item's route (`attention/<app>/<type>/<id>`): the tap opens it. */
  route?: string | null
  /** APNs `apns-collapse-id`: a later revision of the item replaces the banner. */
  collapseId?: string
  /** The key the phone settles the notification by (`PushPayload.settle`). */
  settle?: string
}

/**
 * Push one routed attention item to the recipient's devices (every non-chat
 * group; chat groups push from their message event above). Sends nothing
 * unless the decision's push channel delivers. Returns the devices addressed.
 * Never throws.
 */
export async function pushRouted(
  decision: RouterDecision,
  content: RoutedPushContent,
  deps: PushFanoutDeps = {},
): Promise<number> {
  if (!decision.channels.push.deliver) return 0
  try {
    const threadId = content.threadId ?? ""
    const body =
      content.body.length <= PUSH_BODY_MAX
        ? content.body
        : `${content.body.slice(0, PUSH_BODY_MAX - 1)}…`
    const route = !threadId && content.route ? content.route : null
    return await deliverPayloadToUser(
      decision,
      content.notifyId,
      (badgeCount) => ({
        type: "attention",
        threadId,
        deepLink: threadId
          ? buildDeepLink(threadId)
          : route
            ? buildAttentionDeepLink(route)
            : "liaison://attention",
        ...(route ? { route } : {}),
        badgeCount,
        title: content.title,
        body,
        ...(content.collapseId ? { collapseId: content.collapseId } : {}),
        ...(content.settle ? { settle: content.settle } : {}),
        notificationId: notificationIdFor(decision.userId, content.notifyId),
      }),
      deps,
    )
  } catch (err) {
    log.error({ err, notifyId: content.notifyId }, "Routed push failed")
    return 0
  }
}

/**
 * Send one routed payload to every device of the decision's recipient: the
 * token load, the badge and the bounded `deliver` loop. `notifyId` is the
 * idempotency key: one send per (notifyId, token) per process. The payload is
 * built once the badge is known. Returns the devices addressed; sends nothing
 * unless the decision's push channel delivers. It may throw (a token or badge
 * read failing): callers catch, as `pushRouted` does.
 */
export async function deliverPayloadToUser(
  decision: RouterDecision,
  notifyId: string,
  buildPayload: (badgeCount: number) => PushPayload,
  deps: PushFanoutDeps = {},
): Promise<number> {
  if (!decision.channels.push.deliver) return 0
  const tokens = await loadTokens(decision.orgId, [decision.userId])
  if (tokens.length === 0) return 0
  const badge = await (deps.badgeCount ?? computeBadgeCount)(decision.userId, decision.orgId)
  const payload = buildPayload(badge)
  await runBounded(
    tokens.map(
      (token) => () =>
        deliver(
          decision,
          notifyId,
          {
            id: token.id,
            platform: token.platform,
            token: token.token,
            environment: token.environment,
            multiServer: token.multiServer,
          },
          payload,
          deps,
        ),
    ),
    deps.concurrency ?? PUSH_CONCURRENCY,
  )
  return tokens.length
}

export async function handlePushFanout(
  ctx: DurableEventContext,
  deps: PushFanoutDeps = {},
): Promise<void> {
  const event = ctx.event
  if (handled.has(ctx.eventId)) return
  try {
    // The durable read comes BEFORE any decision, so a replay after a restart
    // is answered by what this consumer already did rather than by the grants
    // of the moment (A18). An event with no org is not one this consumer acts
    // on, and there is no privileged connection to ask.
    if (!event.orgId) return
    if (await hasConsumerHandled(event.orgId, PUSH_FANOUT_CONSUMER, ctx.eventId)) {
      markHandled(ctx.eventId)
      return
    }
    // Approvals are not pushed from their event any more: the approvals group
    // pushes from its attention row (the state materializer's first sighting
    // of the `approval_pending` item), so one approval is one push.
    if (event.entity === "message" && event.action === "create") {
      await handleMessageCreate(ctx, event, deps)
    }
    // Marked only once the fanout finished: a throw below leaves no mark, so
    // the outbox's own retry is still free to run this event again.
    await markConsumerHandled(event.orgId, PUSH_FANOUT_CONSUMER, ctx.eventId)
    markHandled(ctx.eventId)
  } catch (err) {
    // Never rethrow: see the header. An unexpected failure costs the
    // notification, never the outbox row's other consumers.
    log.error({ err, eventId: ctx.eventId, entity: event.entity }, "Push fanout failed")
  }
}

export function registerPushFanoutConsumer(): void {
  registerDurableEventConsumer("push-fanout", (ctx) => handlePushFanout(ctx))
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const PushFanoutTestAccess = {
  resetDedupe(): void {
    delivered.clear()
    handled.clear()
  },
}

/** The recipient's language: their own choice, else their org's default (as the digest reads it). */
/** Every recipient's language, in one query (`recipientLocale` for many). */
async function recipientLocales(
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, ShippedLocale>> {
  const out = new Map<string, ShippedLocale>()
  if (userIds.length === 0) return out
  const rows = await withPrivilegedDb(orgId, "push-recipient-locales", (tx) =>
    tx
      .select({
        userId: users.id,
        language: userPreferences.language,
        orgDefault: organizations.defaultLocale,
      })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(and(inArray(users.id, [...userIds]), eq(users.orgId, orgId))),
  )
  for (const row of rows)
    out.set(row.userId, resolveLocale(row.language ?? null, row.orgDefault ?? null))
  return out
}

export async function recipientLocale(orgId: string, userId: string): Promise<ShippedLocale> {
  const [row] = await withPrivilegedDb(orgId, "push-recipient-locale", (tx) =>
    tx
      .select({ language: userPreferences.language, orgDefault: organizations.defaultLocale })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  return resolveLocale(row?.language ?? null, row?.orgDefault ?? null)
}

function translatorFor(locale: ShippedLocale): (key: string) => string {
  return (key) => serverT(locale, key)
}
