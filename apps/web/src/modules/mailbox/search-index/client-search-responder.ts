// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint task 10.5: the free-text half of `mail__search`, answered by the
// browser's own index.
//
// The shape of the exchange (spec section 5.5). The server has already run the
// structured half. It cannot run the free-text half, because it holds only
// ciphertext, so it hands the turn a `needsClientSearch` marker. This module
// runs the query against the local index and returns MESSAGE IDS. The server
// intersects those ids with the structured filters and the caller's RLS and
// projects envelope rows.
//
// Three rules, each of which is the difference between this being a search and
// this being a leak:
//
//   1. The query term never leaves the browser. It is an argument to a local
//      function and appears in no request this module makes. `post` is handed a
//      body with three fields, and the test asserts on the serialized body.
//   2. The answer is ids, never snippets and never bodies. The adapter cannot
//      return anything else, which is why the adapter's contract says so.
//   3. The turn's id scope and caps apply to the RESULT as well as the request.
//      A client that answered outside the scope would hand the agent ids it was
//      never allowed to enumerate, and ids are the metadata this design already
//      concedes; conceding MORE of them for free is not on.
//
// WHERE THIS IS WIRED. `mailbox-agent-runtime.ts` routes the ephemeral
// `mailbox_search_request` event here, supplying the real `post`, the turn nonce
// and the live index adapter, and adds the ids this call returns to the turn's
// own scope. The server then spends them: the broker hands them back to
// `mail:search` as `__mailboxSearchIds`, which intersects them with the
// structured filters and the caller's RLS instead of raising the marker a second
// time. This module stays transport free on purpose, so it is the caller that
// knows about any of that.

import { MAILBOX_LOCKED, MailboxCryptoError } from "~/modules/mailbox/crypto-protocol"
import {
  clampSearchLimit,
  type IndexMode,
  type SearchIndexAdapter,
} from "~/modules/mailbox/search-index/adapter"

/** The per-request result cap, applied to the RESULT as well as the ask. */
export const CLIENT_SEARCH_MAX_RESULTS = 100

export interface ClientSearchRequest {
  requestId: string
  /** The turn this request belongs to. A mismatch is refused, never served. */
  turnNonce: string
  query: string
  filters?: { accountIds?: readonly string[] }
  limit?: number
}

/** Exactly what goes on the wire. Three fields, and no text of any kind. */
export interface ClientSearchResponseBody {
  messageIds: string[]
  indexComplete: boolean
  indexMode: IndexMode
}

export interface ClientSearchOutcome extends ClientSearchResponseBody {
  requestId: string
  appliedLimit: number
}

export interface ClientSearchDeps {
  adapter: SearchIndexAdapter
  isUnlocked(): boolean
  /** The nonce of the turn currently in flight. */
  turnNonce(): string
  /** Accounts this turn may enumerate. Absent means every indexed account. */
  allowedAccountIds?: readonly string[]
  /**
   * Whether the index may be presented as a complete answer. Defaults to true;
   * the store's `complete` flag is what a real caller passes.
   */
  indexComplete?(): boolean
  post(requestId: string, body: ClientSearchResponseBody): Promise<void>
}

export async function answerClientSearch(
  deps: ClientSearchDeps,
  request: ClientSearchRequest,
): Promise<ClientSearchOutcome> {
  // Order matters. The nonce is checked before the lock state so a stale turn
  // cannot learn whether the mailbox is open by watching which refusal it gets.
  if (request.turnNonce !== deps.turnNonce()) {
    throw new MailboxCryptoError(
      MAILBOX_LOCKED,
      "this search belongs to a turn that is no longer in flight",
    )
  }
  if (!deps.isUnlocked()) {
    throw new MailboxCryptoError(MAILBOX_LOCKED, "the mailbox is locked, so it cannot be searched")
  }

  const allowed = deps.allowedAccountIds
  let accountIds = request.filters?.accountIds
  if (accountIds && accountIds.length > 0 && allowed) {
    const permitted = accountIds.filter((id) => allowed.includes(id))
    if (permitted.length === 0) {
      // Silently widening to "every account" would answer a question the caller
      // was not allowed to ask, so this refuses instead.
      throw new MailboxCryptoError(
        MAILBOX_LOCKED,
        "this search named an account that is out of scope for this turn",
      )
    }
    accountIds = permitted
  } else if (allowed) {
    accountIds = allowed
  }

  const appliedLimit = Math.min(CLIENT_SEARCH_MAX_RESULTS, clampSearchLimit(request.limit))
  const messageIds = (
    await deps.adapter.search({
      text: request.query,
      limit: appliedLimit,
      ...(accountIds && accountIds.length > 0 ? { accountIds } : {}),
    })
  ).slice(0, appliedLimit)

  const body: ClientSearchResponseBody = {
    messageIds,
    indexComplete: deps.indexComplete ? deps.indexComplete() : true,
    indexMode: deps.adapter.mode(),
  }
  await deps.post(request.requestId, body)
  return { requestId: request.requestId, appliedLimit, ...body }
}
