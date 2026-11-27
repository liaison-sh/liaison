// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT A NOTIFICATION OPENS: the route every live notification carries (a
 * desktop notification, a browser notification, a Web Push), built here and
 * only here, so the server that writes it and the tests that prove where a
 * click lands use the same functions. The web app's one resolver
 * (apps/web/src/modules/notifications/open-route.ts) accepts exactly these
 * grammars:
 *
 *   thread/<id>[?replyRoot=<id>]               a conversation (+ reply panel)
 *   attention/<app>/<entityType>/<id>          an item (an approval: Home)
 *     [?thread=<id>&message=<id>]              + a message of its discussion
 *   home                                       Home, where the attention list is
 *
 * Ids are percent-encoded, so an id the resolver accepts never breaks the
 * route's shape.
 */

/** Home: a notification about several things at once (a burst summary). */
export const HOME_NOTIFICATION_ROUTE = "home"

/** `thread/<id>`, with `?replyRoot=<id>` when the message is a reply in a reply thread. */
export function threadNotificationRoute(threadId: string, replyRootId?: string | null): string {
  const base = `thread/${encodeURIComponent(threadId)}`
  return replyRootId ? `${base}?replyRoot=${encodeURIComponent(replyRootId)}` : base
}

/**
 * Where an attention item opens: its conversation when it is one or belongs to
 * one, else the item itself.
 */
export function attentionNotificationRoute(item: {
  app: string
  entityType: string
  entityId: string
  threadId?: string | null
}): string {
  if (item.entityType === "thread") return threadNotificationRoute(item.entityId)
  if (item.threadId) return threadNotificationRoute(item.threadId)
  return `attention/${item.app}/${item.entityType}/${encodeURIComponent(item.entityId)}`
}

/**
 * Where a burst summary opens (notifications/burst.ts). `conversations` are the
 * burst's distinct conversations, each with the route its newest item opens
 * (null for an entry stored before routes were kept: its conversation is a
 * thread id, or already an attention route). One conversation opens it; several
 * open Home, whose list holds them all.
 */
export function burstSummaryNotificationRoute(
  conversations: readonly { conversation: string; route: string | null }[],
): string {
  const distinct = new Map<string, string | null>()
  for (const c of conversations) distinct.set(c.conversation, c.route ?? null)
  if (distinct.size !== 1) return HOME_NOTIFICATION_ROUTE
  const [[conversation, route]] = [...distinct]
  if (route) return route
  if (conversation.startsWith("attention/") || conversation.startsWith("thread/")) {
    return conversation
  }
  if (conversation.includes("/")) return HOME_NOTIFICATION_ROUTE
  return threadNotificationRoute(conversation)
}
