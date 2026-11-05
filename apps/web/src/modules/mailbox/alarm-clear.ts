// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Clearing the downgrade alarm, by its owner, on this device.
//
// The alarm must stay out of the server's reach, so the clear is built from
// three steps in a fixed order, and only the browser takes the one that
// removes anything:
//   1. PROOF. The owner opens the mailbox again with the mailbox password (or,
//      when the keyring has no password, with this computer's passkey). This is
//      the ordinary unlock path: the worker unwraps the Account Key from the
//      wrap and then every private key in the keyring with it. The server can
//      serve a wrap, but it cannot produce one that opens without the owner's
//      secret, so a server cannot pass this step on the owner's behalf.
//   2. RECORD. The server is told which findings are being cleared, so the
//      clear appears in the audit trail. If that record cannot be written,
//      nothing is cleared: a clear nobody can see afterwards is worse than a
//      warning that stays.
//   3. FORGET. The persisted alarm and the ledger are dropped with
//      `forgetDowngradeRecords`, and a resync runs a fresh sweep at once. A
//      clear only forgets history: whatever is STILL wrong with the mailbox is
//      found again by that sweep and the warning comes back.

import { requestResync } from "~/framework/resync"
import type { WrapBlobPayload } from "~/modules/mailbox/crypto-protocol"
import { startMailboxCryptoWorker } from "~/modules/mailbox/crypto-worker-boot"
import { type DowngradeFinding, forgetDowngradeRecords } from "~/modules/mailbox/downgrade-detector"
import {
  type MailboxApi,
  recordIntegrityAlarmCleared,
  type WrapMetadataView,
} from "~/modules/mailbox/mailbox-api"
import { mailboxCryptoClient, unlockMailbox } from "~/modules/mailbox/mailbox-store"
import type { IndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"

export type AlarmClearOutcome =
  /** Proved, recorded and forgotten. */
  | "cleared"
  /** The secret did not open the mailbox. Nothing was recorded or cleared. */
  | "refused"
  /** Proved, but the server did not record it. Nothing was cleared. */
  | "not-recorded"
  /** The decrypting worker is not running in this tab. */
  | "worker-missing"

export interface ClearAlarmInput {
  api: MailboxApi
  userId: string
  /** The wrap the owner is proving: the mailbox password, else a passkey. */
  wrap: WrapMetadataView
  /** The mailbox password, for a `passphrase` wrap. */
  secret?: string
  /** The passkey ceremony, for a `passkey_prf` wrap. */
  resolveSecret?: (blob: WrapBlobPayload) => Promise<string>
  /** Exactly the findings the owner was shown. Only these are recorded. */
  findings: readonly DowngradeFinding[]
  store: IndexBlobStore
}

export async function clearDowngradeAlarmWithProof(
  input: ClearAlarmInput,
): Promise<AlarmClearOutcome> {
  if (!mailboxCryptoClient()) await startMailboxCryptoWorker()
  if (!mailboxCryptoClient()) return "worker-missing"

  const proved = await unlockMailbox(input.api, {
    userId: input.userId,
    wrap: input.wrap,
    secret: input.secret,
    resolveSecret: input.resolveSecret,
  })
  if (!proved) return "refused"

  try {
    await recordIntegrityAlarmCleared(input.api, input.findings)
  } catch {
    return "not-recorded"
  }

  await forgetDowngradeRecords(input.store, input.userId)
  requestResync("mailbox-alarm-cleared")
  return "cleared"
}
