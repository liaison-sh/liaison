// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The cell-wide view of the WebSocket connections (S5, A12).
 *
 * Each process keeps its own sockets in a local table (`WebSocketManager`):
 * fan-out needs the socket refs synchronously, and refs never leave the
 * process. `RedisLiveState` answers the questions that span replicas: is a
 * user online, which users of an org are online, does any live socket hold
 * mail access for an account. Every entry it writes names its instance, and
 * readers ignore an entry whose instance has no heartbeat record
 * (`infra/instance-registry.ts`).
 */

/** One socket as the cell sees it: no ref, just who holds it and with what grants. */
export interface LiveConn {
  /** Unique within the instance. */
  connId: string
  instanceId: string
  userId: string
  orgId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  connectedAt: number
}

/** An account whose mail an agent turn wants to read through a live session. */
export interface MailAccessAccount {
  id: string
  ownerType: "user" | "org"
  ownerId: string | null
}

/**
 * A client's assertion that it currently holds an unlocked personal mailbox
 * (blueprint Task 9.4, spec section 6.2).
 *
 * Client-asserted, held per CONNECTION, and TTL-bound so it must be re-asserted:
 * it is not a server-derivable property and must never be treated as one. The
 * user reads unlocked while any live connection asserts it, so a tab that opens
 * locked never masks another that is unlocked. The flag only decides whether the
 * server should ASK; any unlocked connection of the user may answer.
 */
export interface MailboxUnlockEntry {
  unlocked: boolean
  keyIds: number[]
  /** Epoch ms. Past that instant the entry reads as absent. */
  expiresAt: number
  /**
   * The turn nonces this connection started and still has open. Absent from a
   * client that predates the field, which therefore cannot say whether it owns
   * a turn. Lets the server stop waiting when the window that started a turn
   * has gone, instead of spending the whole wait budget.
   */
  turns?: string[]
}

/**
 * Who can still answer a mailbox request for one turn: the user's live
 * connections whose mailbox is unlocked. `turnWindowUnlocked` is one that lists
 * the turn as open (the window that started it); `otherUnlocked` counts the
 * rest, including a client too old to send its turn list. `unknown` when the
 * state could not be read: the caller keeps waiting.
 */
export type MailboxAnswerers = { turnWindowUnlocked: boolean; otherUnlocked: number } | "unknown"
