// SPDX-License-Identifier: FSL-1.1-ALv2
//
// READ STATE IS THE SERVER'S, AND EVERY DEVICE HEARS IT MOVE.
//
// A read mark (a thread, a reply thread, an attention row) is written on the
// server by whichever device the reader used. Until this existed nothing told
// the reader's OTHER devices: a thread read on the phone kept its unread pill
// on the laptop until the laptop happened to reload its list, and the other
// way round. Every read write now ends with one of these frames, addressed to
// the reader's own sockets only (`forUserId`, enforced by the socket fan-out,
// fail closed), so each device drops the pill the moment another one reads.
//
// The same frame carries the reader's other per-user thread flags (mute,
// archive, pin: `thread_state`), for the same reason and with the same
// addressing: muting a thread on the laptop must stop it showing as live on
// the phone, and nobody else may learn that someone muted a conversation.
//
// Ephemeral on purpose: a read is not an audited business event, and a device
// that was offline when it fired does not need a replay. Every reconnect, and
// every return of a hidden page, refetches the lists this frame would patch.

import { type AppEvent, broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "read-state-broadcast" })

/** The kernel entity of the frame. The socket layer keys its per-user filter on it. */
export const READ_STATE_ENTITY = "read_state"

export type ReadStateChange =
  /** The channel read mark moved. `unreadCount` is the server's count after the move. */
  | { kind: "thread"; threadId: string; unreadCount: number }
  /** A reply thread's read mark moved (it clears that root's followup too). */
  | { kind: "reply_thread"; threadId: string; rootId: string }
  /**
   * The reader's own mute / archive / pin flags on a thread moved: the flags
   * as stored after the write, so a device applies them without a refetch.
   */
  | {
      kind: "thread_state"
      threadId: string
      isArchived: boolean
      isMuted: boolean
      isPinned: boolean
      notifyAllPosts: boolean
    }
  /**
   * The holder's "assistant may read my mail" switch moved on one device. The
   * devices, not the server, decide whether to apply it (an "on" must carry a
   * MAC under the mailbox key: web mailbox/agent-mail-access.ts).
   */
  | { kind: "agent_mail_access"; enabled: boolean; at: number; mac?: string }
  /** Attention rows were read: one entity, one app (optionally some kinds), all,
   *  or a Home slice (`bulk`, also its Undo). */
  | {
      kind: "attention"
      bulk?: boolean
      app?: string
      entityType?: string
      entityId?: string
      kinds?: string[]
      all?: boolean
    }

export interface ReadStateFrameData extends Record<string, unknown> {
  forUserId: string
  kind: ReadStateChange["kind"]
}

/** The frame, built apart from the send so a test can read it without a bus. */
export function readStateEvent(orgId: string, userId: string, change: ReadStateChange) {
  return {
    app: "kernel",
    entity: READ_STATE_ENTITY,
    action: "update",
    orgId,
    actorId: userId,
    actorType: "user" as const,
    data: { forUserId: userId, ...change } as ReadStateFrameData,
  }
}

/**
 * Tell the reader's devices that a read mark moved. Called AFTER the write
 * committed, never inside the transaction: a device that refetches on this
 * frame must read the new mark. Never throws: the mark is already stored, and
 * a lost frame is healed by the next refetch.
 */
export async function broadcastReadState(
  orgId: string,
  userId: string,
  change: ReadStateChange,
): Promise<void> {
  try {
    await broadcastEphemeral(readStateEvent(orgId, userId, change))
  } catch (err) {
    log.warn({ err, orgId, kind: change.kind }, "read state broadcast failed")
  }
}

/**
 * The same frame, for a writer running inside a transaction it does not own
 * (an agent tool handler: the tool pipeline commits after the handler
 * returns). Queued on the transactional outbox, so it is delivered only once
 * the write committed, and never if it rolls back; the socket fan-out applies
 * the same per-reader filter to it (also on replay).
 */
export async function queueReadState(
  tx: { queueEvent: (event: AppEvent) => Promise<void> },
  orgId: string,
  userId: string,
  change: ReadStateChange,
): Promise<void> {
  await tx.queueEvent(readStateEvent(orgId, userId, change))
}
