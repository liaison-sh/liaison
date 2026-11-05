// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What producers do with a `RouterDecision` (S2): enqueue the email (the
 * digest row's state) and dispatch the live channels (push, desktop) of an
 * attention row. Both take the decision, so neither can run without the
 * router having decided first.
 *
 * The push source rule (no double push): chat groups (`direct`, `replies`)
 * push and raise desktop notifications from their message event
 * (push/fanout-consumer.ts); their attention rows never do. Every other group
 * goes live from its attention-row insert, here.
 */
import { NOTIFICATION_GROUPS, type NotificationGroupId } from "@liaison/shared"
import { rootLogger } from "~/lib/logger"
import { type PushFanoutDeps, pushRouted } from "~/modules/push/fanout-consumer"
import { attentionSettleKey } from "~/modules/push/redact"
import { admitBurst, type BurstDeps } from "./burst"
import { recordRouterSuppressions } from "./delivery-log"
import { onDesktopDecision } from "./desktop-hook"
import { isDirectAsk, ownBannerId, type RouterDecision } from "./router"

const log = rootLogger.child({ module: "notifications-dispatch" })

// `thread_followup` (a reply in a reply thread one follows) is in `direct`: its
// push comes from the reply's message event, sent to the followers only
// (push/fanout-consumer.ts), never from its attention row.
const CHAT_GROUPS = new Set<NotificationGroupId>(["direct", "replies"])

export interface DigestEnqueue {
  digestState: "pending" | "suppressed"
  digestEligibleAt: Date
}

/**
 * The digest row's email state from the decision. A delivered email is
 * `pending` from its eligibility time (the next work window for a held item);
 * a degraded decision stays `pending` so the digest decides again at send.
 * Anything else is `suppressed`: that user never receives it by email.
 */
export function emailEnqueue(decision: RouterDecision, at: Date): DigestEnqueue {
  const email = decision.channels.email
  if (email.deliver) return { digestState: "pending", digestEligibleAt: email.eligibleAt ?? at }
  return { digestState: "suppressed", digestEligibleAt: at }
}

/** Does this group go live from its attention rows (not from a message event)? */
export function isAttentionLiveGroup(group: NotificationGroupId): boolean {
  return !CHAT_GROUPS.has(group)
}

/** The English label of a group, the title of an attention push. */
export function groupLabel(group: NotificationGroupId): string {
  return NOTIFICATION_GROUPS.find((g) => g.id === group)?.label ?? "Liaison"
}

/**
 * What a live attention payload says when its item carries `requiredScopes`
 * (D14, as for a message push): a fixed line derived from nothing about the item.
 */
export const REDACTED_ATTENTION_BODY = "New notification"

/**
 * D14 for attention items. An item created from a tainted turn carries the
 * turn's read scopes; a push, a desktop banner, a web push and an email are
 * delivered or rendered by third parties and never re-check visibility, so such
 * an item goes out with no text derived from it. `[]` (or absent) is the
 * positive assertion that nothing scoped was read; anything else, an unreadable
 * value included, redacts (fail closed, as `buildPushPayload` does).
 */
export function attentionTextRedacted(requiredScopes: unknown): boolean {
  if (requiredScopes === undefined || requiredScopes === null) return false
  return !(Array.isArray(requiredScopes) && requiredScopes.length === 0)
}

export interface AttentionLiveItem {
  /** `attention:<rowId>` (or a source key): idempotency of the push and desktop raise. */
  notifyId: string
  summary: string
  /** The read scopes of the turn the item came from (D14): any, and no summary goes live. */
  requiredScopes?: string[] | null
  app: string
  entityType: string
  entityId: string
  threadId?: string | null
  /** A coalescing item's id: each revision re-alerts and replaces the previous push banner. */
  collapseId?: string
}

/** Where the client opens the item. */
export function attentionRoute(item: {
  app: string
  entityType: string
  entityId: string
  threadId?: string | null
}): string {
  if (item.entityType === "thread") return `thread/${item.entityId}`
  if (item.threadId) return `thread/${item.threadId}`
  return `attention/${item.app}/${item.entityType}/${item.entityId}`
}

export interface DispatchDeps {
  push?: (
    decision: RouterDecision,
    content: Parameters<typeof pushRouted>[1],
    deps?: PushFanoutDeps,
  ) => Promise<number>
  pushDeps?: PushFanoutDeps
  /** The burst gate's clock, Redis and summary scheduler (burst.ts). */
  burst?: BurstDeps
}

/**
 * Push and desktop for one freshly inserted attention row. Does nothing for a
 * chat group (its message event already went live) and nothing on a channel
 * the decision suppresses. Never throws.
 */
export async function dispatchAttentionLive(
  decision: RouterDecision,
  item: AttentionLiveItem,
  deps: DispatchDeps = {},
): Promise<void> {
  if (!isAttentionLiveGroup(decision.group)) return
  // S1: what the router held back on push and desktop is logged under the
  // item's notificationId (chat groups log from their message event).
  await recordRouterSuppressions(decision, item.notifyId)
  const redacted = attentionTextRedacted(item.requiredScopes)
  const title = groupLabel(decision.group)
  const body = redacted ? REDACTED_ATTENTION_BODY : item.summary
  const threadId =
    item.entityType === "thread" ? item.entityId : item.threadId ? item.threadId : null
  // Many live items at once reach the person as one summary (burst.ts); a
  // direct ask (an approval they decide) still notifies on its own, and keeps
  // its own banner: a later message of its conversation does not replace it.
  const directAsk = isDirectAsk(decision)
  const ownBanner =
    directAsk && !item.collapseId ? ownBannerId(decision.userId, item.notifyId) : null
  if (
    await admitBurst(
      decision,
      {
        notifyId: item.notifyId,
        actorKey: null,
        actorName: null,
        conversation: threadId ?? attentionRoute(item),
        conversationKind: item.entityType === "task" ? "task" : "conversation",
        kind: "notification",
        important: directAsk,
        redacted,
      },
      deps.burst,
    )
  )
    return
  try {
    await (deps.push ?? pushRouted)(
      decision,
      {
        notifyId: item.notifyId,
        title,
        body,
        threadId,
        // A thread-less item (an approval, a task) opens where the desktop
        // notification does: the tap carries the same route.
        ...(threadId ? {} : { route: attentionRoute(item) }),
        ...(item.collapseId ? { collapseId: item.collapseId } : {}),
        ...(ownBanner ? { collapseId: ownBanner } : {}),
        // Rule 5: the phone withdraws it once the item is read or resolved.
        settle: attentionSettleKey(item.app, item.entityType, item.entityId),
      },
      deps.pushDeps,
    )
  } catch (err) {
    log.warn({ err, notifyId: item.notifyId }, "attention push failed")
  }
  await onDesktopDecision(decision, {
    notifyId: item.notifyId,
    title,
    body,
    route: attentionRoute(item),
    ...(ownBanner ? { tag: ownBanner } : {}),
  })
}
