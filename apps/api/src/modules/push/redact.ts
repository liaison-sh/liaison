// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S17, D14: what a push payload may carry.
//
// THE RULE IS ONE LINE AND IT IS CONSERVATIVE. A message that carries
// `requiredScopes` at all gets a payload with no text on it: no content, no
// body, no title, no scope name, no thread title, no author name. Not "no text
// the recipient cannot read": no text. A notification is delivered by a third
// party (Apple, Google), it is rendered on a lock screen a stranger can read
// over a shoulder, and it survives in the OS notification centre after the
// grant that justified it is gone. None of those places re-evaluate the
// visibility predicate, so the only safe payload for a tagged message is one
// that says a message exists and where.
//
// spec-security.md line 81: "the conservative default is redact unless the
// message is required-scope-free".
//
// The wording the user actually sees for a redacted push is a constant in the
// sender (GENERIC_PUSH_BODY), derived from nothing about the message.
//
// WHO gets a push at all is not decided here: that is the fanout consumer's
// read-time predicate (A18). This function answers only "what may the payload
// say", and it answers it the same way for every recipient.
import { messagePlainText, threadAnchorRoute } from "@liaison/shared"
import type { PushKind, PushPayload } from "~/modules/push/types"

/** The most text a payload may carry for an untagged message. */
export const PUSH_BODY_MAX = 120

/** The scheme the mobile app registers (P7-T06/T07). */
export const PUSH_DEEP_LINK_SCHEME = "liaison://thread/"

export function buildDeepLink(threadId: string): string {
  return `${PUSH_DEEP_LINK_SCHEME}${threadId}`
}

/**
 * The deep link of a thread-less attention item: `liaison://attention/<app>/<type>/<id>`,
 * the one other shape the mobile router accepts (apps/mobile/src/deep-link.ts).
 */
export function buildAttentionDeepLink(route: string): string {
  return `liaison://${route}`
}

/** What the fanout read off the message row, and nothing more. */
export interface PushSourceMessage {
  id: string
  threadId: string
  /** `[]` is the positive assertion that the row carries no scoped data. */
  requiredScopes: string[] | null
  content: string
  authorName: string
  threadTitle?: string | null
  /** The reply thread the message belongs to, when it is a reply. */
  replyRootId?: string | null
  /**
   * The entity the thread belongs to (a task's comments), with its title in the
   * recipient's language (`threadAnchorTitle`): the push is news of the entity
   * and its tap opens it, on this message.
   */
  anchor?: PushAnchor | null
}

/** What a push says about, and where it opens, the entity a thread belongs to. */
export interface PushAnchor {
  app: string
  entityType: string
  entityId: string
  title: string
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function buildPushPayload(
  message: PushSourceMessage,
  type: PushKind,
  badgeCount: number,
): PushPayload {
  const scopes = message.requiredScopes
  // Fail closed on an unreadable value exactly as `messageVisibilityFacts`
  // does: a row whose scopes could not be parsed is not a row anybody can
  // claim carries no scoped data.
  const untagged = Array.isArray(scopes) && scopes.length === 0
  const anchor = message.anchor ?? null
  // An entity's thread opens on the entity (ids only, so a tagged message's
  // push still goes there): the route the mobile router and the web resolver
  // both accept, with the message beside it for the discussion to bring into view.
  const route = anchor ? threadAnchorRoute(anchor) : null
  const payload: PushPayload = {
    type,
    threadId: message.threadId,
    deepLink: route ? buildAttentionDeepLink(route) : buildDeepLink(message.threadId),
    badgeCount,
    ...(message.replyRootId ? { replyRootId: message.replyRootId } : {}),
    ...(route ? { route, ...(message.id ? { messageId: message.id } : {}) } : {}),
    // Rule 5: the phone withdraws it once THIS message is read (a reply by its
    // reply thread's mark, not its channel's), never by its thread id.
    ...(message.id ? { settle: `message/${message.id}` } : {}),
  }
  if (!untagged) return payload
  // The markup (`@[Name](user:<id>)`, links, emphasis) is for the renderer;
  // a lock screen shows the plain text.
  const text = messagePlainText(message.content)
  if (anchor) {
    // The title names the entity; the body keeps who wrote.
    return {
      ...payload,
      title: anchor.title,
      body: truncate(`${message.authorName}: ${text}`, PUSH_BODY_MAX),
    }
  }
  return {
    ...payload,
    title: message.threadTitle ?? message.authorName,
    body: truncate(text, PUSH_BODY_MAX),
  }
}

/**
 * THE SETTLE KEY of a push (rule 5, read once, read everywhere): what the
 * notification announced, so the phone can ask the server whether exactly
 * that was read or resolved. A message is judged by its own read mark (a
 * reply by its reply thread's), an attention item by its rows (and an
 * approval by its decision); a thread id alone never settles anything.
 */
export type SettleKey =
  | { kind: "message"; messageId: string }
  | { kind: "attention"; app: string; entityType: string; entityId: string }

/** The key of an attention item's push: `attention/<app>/<entityType>/<entityId>`. */
export function attentionSettleKey(app: string, entityType: string, entityId: string): string {
  return `attention/${app}/${entityType}/${entityId}`
}

/** A settle key read back, or null for anything else. Never throws. */
export function parseSettleKey(key: unknown): SettleKey | null {
  if (typeof key !== "string" || key.length > 300) return null
  const parts = key.split("/")
  if (parts[0] === "message" && parts.length === 2 && parts[1]) {
    return { kind: "message", messageId: parts[1] }
  }
  if (parts[0] === "attention" && parts.length >= 4 && parts[1] && parts[2]) {
    const entityId = parts.slice(3).join("/")
    if (!entityId) return null
    return { kind: "attention", app: parts[1], entityType: parts[2], entityId }
  }
  return null
}
