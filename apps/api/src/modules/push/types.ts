// SPDX-License-Identifier: FSL-1.1-ALv2

/** The APNs host a token belongs to (S11). */
export type PushEnvironment = "sandbox" | "production"

/**
 * What a push is ABOUT, so the client can route the tap. `attention` is an
 * attention-row push (every non-chat group: approvals, work, mail, agent,
 * system); its tap opens the thread when the item has one, else the app.
 * `node_session` is a node session waiting on its owner (C9); its tap opens
 * that session.
 */
export type PushKind = "mention" | "dm" | "approval" | "attention" | "node_session"

/**
 * The literal object the sender turns into an APNs/FCM request.
 *
 * `title` and `body` are OPTIONAL and their absence is the redaction (S17): a
 * payload built for a scope-tagged message carries neither, and no `content`
 * key exists on this type at all, at any depth. The generic wording the user
 * then sees is a constant in the sender, derived from nothing about the
 * message.
 */
export interface PushPayload {
  type: PushKind
  /** The thread the push is about. An id only, never content. Absent for a session push. */
  threadId?: string
  /**
   * The node session the push is about (`node_session`). An id only, never
   * content: no tool input, path or command ever rides on a push.
   */
  sessionId?: string
  deepLink: string
  badgeCount: number
  title?: string
  body?: string
  /**
   * The reply thread the message belongs to (0112): the tap opens the channel
   * with that root's reply panel. An id only, never content. The deep link
   * stays `liaison://thread/<id>`, the one shape the mobile router accepts.
   */
  replyRootId?: string
  /**
   * APNs `apns-collapse-id` (FCM `tag`): a later push with the same id
   * replaces the earlier one on the lock screen. Absent, the sender keys it on
   * the conversation (`pushCollapseId`), so a newer message of a conversation
   * replaces the older one.
   */
  collapseId?: string
  /**
   * The lock-screen stack (APNs `thread-id`) of a push about no thread and no
   * session: a burst summary stacks with the summaries before it.
   */
  groupId?: string
  /**
   * The notification's identity (S1): APNs custom data / FCM data, so the
   * NSE's and the app's receipts name it. An id only, never content.
   */
  notificationId?: string
  /**
   * Deliver without a sound and passively (P4, S12): a node session pushed
   * again within its sound window replaces its banner quietly. Absent sounds.
   */
  silent?: boolean
  /**
   * Where the tap opens an attention item that has no thread (an approval, a
   * task): `attention/<app>/<entityType>/<entityId>`, the route the desktop
   * notification carries too. Ids only, never content. Absent for a thread
   * item, whose `deepLink` already names it.
   */
  route?: string
  /**
   * The message a push about an entity's thread is about (a task comment): the
   * tap opens the entity (`route`) with this message brought into view in its
   * discussion. An id only, never content.
   */
  messageId?: string
  /**
   * The organisation the push comes from (its own name), so a phone signed in
   * to several servers says which one is talking: the APNs subtitle, the FCM
   * title's prefix, and `serverLabel` in the data. Not content: it names the
   * sender's organisation, never anything of the message. Set by the fanout's
   * one door to the wire (`deliver`), absent when the name is unknown.
   */
  serverLabel?: string
  /**
   * The key the phone settles the notification by (rule 5, read once, read
   * everywhere): `message/<id>` for a message, `attention/<app>/<type>/<id>`
   * for an attention item. On foreground the app asks the server which of its
   * delivered notifications' keys are read or resolved and withdraws those
   * only. Ids only, never content. Absent, nothing ever withdraws the
   * notification but the person (a burst summary, a push from an older server).
   */
  settle?: string
}

/** The row the sender addresses: what the fanout read out of `push_tokens`. */
export interface PushTokenRow {
  id: string
  platform: "ios" | "android"
  token: string
  /** APNs host of an iOS token. Absent is `production` (S11). */
  environment?: PushEnvironment
  /**
   * The app knows several servers (it says so when it registers). Only then do
   * its pushes carry the organisation in the alert (APNs subtitle, FCM title
   * prefix): a phone on one server has nothing to tell apart.
   */
  multiServer?: boolean
}

/**
 * Why a send did or did not happen.
 *  - `sent`: the provider accepted it.
 *  - `invalid_token`: the provider says this device is gone for good (APNs 410
 *    or BadDeviceToken, FCM UNREGISTERED). The row is deleted, never retried,
 *    unless the device registered it again after the token died or after the
 *    send started (fanout-consumer.ts `deleteDeadToken`).
 *  - `transient`: worth another attempt later.
 *  - `permanent`: the provider refused this message and will refuse it again
 *    (a malformed request, a revoked key). Retrying wastes the budget.
 *  - `disabled`: no credential is configured, so nothing was attempted.
 */
export interface PushSendResult {
  kind: "sent" | "invalid_token" | "transient" | "permanent" | "disabled"
  detail?: string
  /**
   * Set only when an iOS push was accepted by the OTHER APNs host than the
   * token's recorded one: the environment the row should now carry.
   */
  environment?: PushEnvironment
  /**
   * Every provider answer behind this result, in order: one per APNs host
   * tried (the sandbox/production retry), or the one FCM answer. The delivery
   * log writes one row per entry.
   */
  hosts?: PushHostAttempt[]
  /**
   * `invalid_token` from APNs 410 only: Apple's `timestamp`, the last moment
   * the token was valid. A row registered after it is a NEW registration of
   * the same token (an app update, a fresh sign-in) and is kept.
   */
  unregisteredAt?: Date
}

export interface PushHostAttempt {
  /** The APNs host tried; absent for FCM. */
  environment?: PushEnvironment
  status: number
  /** APNs `reason` / FCM error code, when the provider gave one. */
  reason?: string
}

export interface PushHttpRequest {
  url: string
  method: "POST"
  /** Header names are lowercase, the way both HTTP/2 and fetch normalise them. */
  headers: Record<string, string>
  body: string
}

export interface PushHttpResponse {
  status: number
  body: string
}

/**
 * The one hop this module makes to the outside world, behind an interface so
 * every test proves the real request builder and the real response classifier
 * without a network, an APNs key or a Firebase project.
 */
export interface PushTransport {
  request(req: PushHttpRequest): Promise<PushHttpResponse>
}
