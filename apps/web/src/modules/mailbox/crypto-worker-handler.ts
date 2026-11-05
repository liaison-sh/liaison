// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The worker side of the protocol, factored out of the worker entry so it can
// be driven directly in a test without a Worker. It runs in the worker only:
// it takes a session, which holds key material.

import {
  MAILBOX_LOCKED,
  MailboxCryptoError,
  type WorkerRequest,
  type WorkerResponse,
} from "~/modules/mailbox/crypto-protocol"
import type { MailboxSession } from "~/modules/mailbox/crypto-session"

export async function handleWorkerRequest(
  session: MailboxSession,
  request: WorkerRequest,
): Promise<WorkerResponse> {
  // Captured before the switch narrows `request`: after an exhaustive switch
  // the union is `never`, and the unreachable tail below still has to answer
  // with a correlation id if a malformed message ever reaches us at runtime.
  const id = request.id
  try {
    switch (request.op) {
      case "unlock":
        return { id, ok: true, value: await session.unlock(request.request) }
      case "restore":
        return { id, ok: true, value: { restored: await session.restore(request.request) } }
      case "extendLease":
        return { id, ok: true, value: { extended: await session.extendLease(request.request) } }
      case "openMessage":
        return { id, ok: true, value: await session.openMessage(request.sealed, request.options) }
      case "openConversation":
        return {
          id,
          ok: true,
          value: await session.openConversation(request.sealed, request.options),
        }
      case "openApprovalDraft":
        return {
          id,
          ok: true,
          value: await session.openApprovalDraft(request.sealed, request.options),
        }
      case "openAttachment":
        return {
          id,
          ok: true,
          value: await session.openAttachment(request.sealed, request.options),
        }
      case "sealIndexShard":
        return {
          id,
          ok: true,
          value: { shard: await session.sealIndexShard(request.shardId, request.plaintext) },
        }
      case "openIndexShard":
        return {
          id,
          ok: true,
          value: { shard: await session.openIndexShard(request.shardId, request.blob) },
        }
      case "verifySeals":
        return { id, ok: true, value: { verdicts: await session.verifySeals(request.rows) } }
      case "signAck":
        return { id, ok: true, value: await session.signAck(request.statement) }
      case "ledgerMac":
        return { id, ok: true, value: { macs: await session.ledgerMac(request.statements) } }
      case "mintWrap":
        return { id, ok: true, value: await session.mintWrap(request.request) }
      case "endMinting":
        session.endMinting()
        return { id, ok: true, value: { released: true } }
      case "lock":
        await session.lock()
        return { id, ok: true, value: { locked: true } }
      case "setIdleTimeout":
        session.setIdleTimeoutMs(request.ms)
        return { id, ok: true, value: { idleTimeoutMs: session.idleTimeoutMs() } }
      case "status": {
        const expired = await session.expireIfIdle()
        return {
          id,
          ok: true,
          value: {
            unlocked: session.isUnlocked(),
            expired,
            idleTimeoutMs: session.idleTimeoutMs(),
          },
        }
      }
    }
  } catch (error) {
    if (error instanceof MailboxCryptoError) {
      return { id, ok: false, code: error.code, message: error.message }
    }
    // Never echo an unexpected error's text back to the page: it can carry
    // fragments of what was being decrypted. The page gets a bare code.
    return {
      id,
      ok: false,
      code: "MAILBOX_INTERNAL",
      message: "the mailbox worker could not complete that operation",
    }
  }
  return { id, ok: false, code: MAILBOX_LOCKED, message: "unknown operation" }
}
