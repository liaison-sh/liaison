// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the browser knows about the turns IT started (blueprint Task 9.5), plus
// the Phase 11 integration point the client job drainer left for Phase 9.
//
// The responder's three client-side questions all resolve here:
//
//   * is this a turn I started and still have open?     -> `isOpenTurn`
//   * was this id surfaced in that turn?                -> `isIdInTurnScope`
//   * do I already hold the plaintext this turn wants?  -> `preOpened`
//
// The last one is what makes the client job queue work without a second
// mechanism. A drained job has ALREADY decrypted the messages it names, in the
// crypto worker, before it submits its turn. Re-opening them when the turn asks
// would be pointless work; posting them in the prompt instead would be a
// different, worse mechanism wearing this one's name (spec section 5.3c). So the
// job registers the plaintext against its own turn nonce, and the responder
// answers the turn's decrypt request from it.

import type { OpenedMessage } from "~/modules/mailbox/crypto-protocol"

export interface OpenTurn {
  turnNonce: string
  /** Ids this turn is allowed to ask for. Nothing outside it is served. */
  allowedIds: Set<string>
  /** Plaintext this client already holds for the turn, keyed by message id. */
  preOpened: Map<string, OpenedMessage>
  openedAt: number
}

export interface AgentTurnSession {
  /** Mint a nonce and open a turn scope for it. */
  begin(input?: { allowedIds?: readonly string[]; preOpened?: readonly OpenedMessage[] }): string
  /** Widen the scope of an open turn as new envelope results name new ids. */
  addIds(turnNonce: string, ids: readonly string[]): void
  end(turnNonce: string): void
  isOpenTurn(turnNonce: string): boolean
  isIdInTurnScope(messageId: string, turnNonce: string): boolean
  preOpened(turnNonce: string, ids: readonly string[]): OpenedMessage[]
  openTurnCount(): number
  /** The nonces of the turns this client has open, for its status frame. */
  openTurnNonces(): string[]
  reset(): void
}

/**
 * The `openMessages` a production responder should use: plaintext this client
 * already holds for the turn is served from the turn scope, and only the rest
 * reaches the crypto worker. A drained job has already opened everything it
 * names, so this is the difference between one decryption and two.
 */
export function openMessagesForTurn(
  session: AgentTurnSession,
  fallback: (ids: string[]) => Promise<OpenedMessage[]>,
): (ids: string[], turnNonce: string) => Promise<OpenedMessage[]> {
  return async (ids, turnNonce) => {
    const preOpened = session.preOpened(turnNonce, ids)
    const have = new Set(preOpened.map((m) => m.id))
    const missing = ids.filter((id) => !have.has(id))
    if (missing.length === 0) return preOpened
    return [...preOpened, ...(await fallback(missing))]
  }
}

/** A turn nobody closed must not keep its scope open forever. */
const TURN_STALE_AFTER_MS = 15 * 60 * 1000

export function createAgentTurnSession(
  deps: { now?: () => number; mintNonce?: () => string } = {},
): AgentTurnSession {
  const now = deps.now ?? (() => Date.now())
  const mintNonce = deps.mintNonce ?? (() => crypto.randomUUID())
  const turns = new Map<string, OpenTurn>()

  function sweep(): void {
    const cutoff = now() - TURN_STALE_AFTER_MS
    for (const [nonce, turn] of turns) {
      if (turn.openedAt < cutoff) turns.delete(nonce)
    }
  }

  return {
    begin(input) {
      sweep()
      const turnNonce = mintNonce()
      const preOpened = new Map<string, OpenedMessage>()
      for (const message of input?.preOpened ?? []) preOpened.set(message.id, message)
      const allowedIds = new Set<string>(input?.allowedIds ?? [])
      for (const id of preOpened.keys()) allowedIds.add(id)
      turns.set(turnNonce, { turnNonce, allowedIds, preOpened, openedAt: now() })
      return turnNonce
    },
    addIds(turnNonce, ids) {
      const turn = turns.get(turnNonce)
      if (!turn) return
      for (const id of ids) turn.allowedIds.add(id)
    },
    end(turnNonce) {
      turns.delete(turnNonce)
    },
    openTurnNonces() {
      sweep()
      return [...turns.keys()]
    },
    isOpenTurn(turnNonce) {
      sweep()
      return turns.has(turnNonce)
    },
    isIdInTurnScope(messageId, turnNonce) {
      return turns.get(turnNonce)?.allowedIds.has(messageId) ?? false
    },
    preOpened(turnNonce, ids) {
      const turn = turns.get(turnNonce)
      if (!turn) return []
      const out: OpenedMessage[] = []
      for (const id of ids) {
        const hit = turn.preOpened.get(id)
        if (hit) out.push(hit)
      }
      return out
    },
    openTurnCount() {
      return turns.size
    },
    reset() {
      turns.clear()
    },
  }
}
