// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the client-verified sweep is actually wired up (spec section 7 step 6).
//
// `verification-sweep.ts` is the walk and the refusal. This file is the two
// ends it plugs into: the sealed listing on the server, and the crypto worker
// session that holds the Ed25519 identity key. Nothing here decrypts and
// nothing here signs; both happen in the worker.
//
// It reads the listing in `mode=verify`, and that is not a detail. The default
// mode returns only rows with `enc_version > 0`, which is right for the search
// index and WRONG here: the acknowledgement's digest is recomputed server side
// over every personal message, sealed or not, so a walk that never saw the
// unsealed rows would either fail to verify or, far worse, claim coverage it
// does not have. An unsealed row must reach the sweep so the sweep can refuse.
//
// `openMessage` is called on the crypto client DIRECTLY rather than through the
// store's `openSealedMessage`, which flattens every failure to null. The sweep
// needs the difference between "the mailbox locked" (stop, resume later) and
// "this message does not decrypt" (refuse, sign nothing).

import type { MailboxApi } from "~/modules/mailbox/mailbox-api"
import { isMailboxUnlocked, mailboxCryptoClient } from "~/modules/mailbox/mailbox-store"
import {
  runMailboxVerificationSweep,
  type SweepPage,
  type SweepProgress,
  type SweepResult,
  type SweepSource,
} from "~/modules/mailbox/verification-sweep"

/** The listing route. Kept in one place so the client half and the server half
 *  cannot drift apart quietly. */
export const MAILBOX_VERIFY_LISTING_PATH = "/mailbox/sync-cursor"

function readPage(value: unknown): SweepPage | null {
  if (!value || typeof value !== "object") return null
  const page = value as Record<string, unknown>
  if (typeof page.cursor !== "string" || typeof page.done !== "boolean") return null
  if (!Array.isArray(page.items)) return null
  return {
    cursor: page.cursor,
    done: page.done,
    items: page.items as SweepPage["items"],
    ...(typeof page.total === "number" ? { total: page.total } : {}),
  }
}

export function createVerifyListingSource(api: MailboxApi): SweepSource {
  return {
    async fetchPage(cursor, limit) {
      const params = new URLSearchParams({ mode: "verify", limit: String(limit) })
      if (cursor) params.set("cursor", cursor)
      const page = readPage(await api.get(`${MAILBOX_VERIFY_LISTING_PATH}?${params.toString()}`))
      if (!page) {
        throw new Error("the message listing answered in a shape the sweep cannot read")
      }
      return page
    },
  }
}

export interface StartSweepOptions {
  api: MailboxApi
  accountId: string
  source?: SweepSource
  onProgress?(progress: SweepProgress): void
  signal?: AbortSignal
}

/**
 * Run the sweep for the caller's mailbox. Rejects with `MailboxSweepError` if
 * anything failed to verify, and with a plain error if there is no unlocked
 * session to decrypt with. It never resolves over an unverified message.
 */
export async function startMailboxVerificationSweep(
  options: StartSweepOptions,
): Promise<SweepResult> {
  const client = mailboxCryptoClient()
  if (!client || !isMailboxUnlocked()) {
    throw new Error("unlock the mailbox before verifying it: the sweep decrypts every message")
  }
  return runMailboxVerificationSweep({
    api: options.api,
    accountId: options.accountId,
    source: options.source ?? createVerifyListingSource(options.api),
    open: (sealed) => client.openMessage(sealed),
    signAck: (statement) => client.signAck(statement),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
