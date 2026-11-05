// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the downgrade detector runs in a live tab (blueprint task 13.1).
//
// It owns four wirings and nothing else:
//   * rehydrate the persisted alarm on mount, so a reload is not a way to
//     silence a finding,
//   * sweep on mount and on every resync, which is when new mail has landed,
//   * keep the client MAC ledger on that same sweep: record what was seen,
//     check this browser's own record has not been edited, and check the rows
//     the server is serving now against the digests it recorded then,
//   * render the alarm, which is not dismissable; its owner can clear it only
//     by proving the mailbox secret again (see `MailboxDowngradeAlarm`).
//
// The seal verdict and the ledger answer two different questions and BOTH are
// needed. The verdict looks at mail as it arrives; only the ledger sees a
// message that was fine on arrival and was rewritten afterwards.
//
// The sweep is deliberately cheap: it checks the identity list once, and the
// rows the tab has actually loaded for a personal mailbox the server says is
// `ready`, minus the rows it has already verified in this tab. One ECDH plus
// one AES-KW per new row, no field decryption, `MAX_ROWS_PER_SYNC` per pass
// with the overflow deferred to the next one. The ledger adds one MAC per
// newly recorded row plus one bounded batch of MACs for the chain window, and
// one SHA-256 per loaded row for the digest comparison.

import { type Component, onCleanup, onMount } from "solid-js"
import { subscribeResync } from "~/framework/resync"
import {
  type DowngradeLedgerMeta,
  ledgerMetaForDowngradeCheck,
  sealedRowsForDowngradeCheck,
} from "~/modules/mail/mail-message-store"
import type { SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import {
  currentIntegrityEpoch,
  type LedgerRow,
  ledgerRowFromSealed,
  loadDowngradeAlarm,
  type MailboxLedger,
  type MailboxSealVerifier,
  openMailboxLedger,
  verifySyncBatch,
} from "~/modules/mailbox/downgrade-detector"
import { loadWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import { MailboxDowngradeAlarm } from "~/modules/mailbox/MailboxDowngradeAlarm"
import { fetchKeyring, type MailboxApi } from "~/modules/mailbox/mailbox-api"
import { mailboxCryptoClient } from "~/modules/mailbox/mailbox-store"
import {
  createIndexedDbBlobStore,
  type IndexBlobStore,
} from "~/modules/mailbox/search-index/index-blob-store"
import { useApi } from "~/modules/shell/ApiContext"

export interface DowngradeSweepInput {
  userId: string
  api: MailboxApi
  crypto: MailboxSealVerifier
  store?: IndexBlobStore
  /** Rows already verified in this tab. Mutated with the ids just verified. */
  verified: Set<string>
  rows?: () => SealedMessagePayload[]
  meta?: () => Record<string, DowngradeLedgerMeta>
  /**
   * The ledger to append to and check. The host keeps ONE across resyncs so a
   * live tab does not re-read and re-parse the blob on every sync; a caller
   * that passes none gets a freshly opened one, which is what a test wants.
   */
  ledger?: MailboxLedger
}

/**
 * The pinned signing key. It comes from the DEVICE keyring, never from the
 * identity list the server just returned, because a key taken from the answer
 * being checked verifies nothing.
 */
export function pinnedSignSpki(userId: string): string | null {
  const entries = loadWrappedKeyring(userId)
  if (entries.length === 0) return null
  const active = entries.find((entry) => entry.status === "active") ?? entries[0]
  return active.signSpki
}

export async function runDowngradeSweep(input: DowngradeSweepInput): Promise<void> {
  const trustedSignSpki = pinnedSignSpki(input.userId)
  // No pinned key means this device has never enrolled, so there is nothing to
  // compare against and no claim to make. Silence here is honest.
  if (!trustedSignSpki) return
  const all = (input.rows ?? sealedRowsForDowngradeCheck)()
  const fresh = all.filter((row) => !input.verified.has(row.id))
  const keyring = await fetchKeyring(input.api)
  const report = await verifySyncBatch({
    userId: input.userId,
    identities: keyring.identities,
    trustedSignSpki,
    rows: fresh,
    crypto: input.crypto,
    store: input.store,
  })
  for (const id of report.verifiedIds) input.verified.add(id)

  // The ledger half (spec section 9.6). The seal verdict above only ever looks
  // at mail as it ARRIVES; what happens to a row afterwards is invisible to it.
  // Without this the ledger is code nobody runs, which is the same as no
  // detection at all.
  const ledger =
    input.ledger ??
    (input.store
      ? await openMailboxLedger({
          store: input.store,
          userId: input.userId,
          crypto: input.crypto,
        })
      : null)
  // No place to keep a ledger means no ledger. A browser that blocks site data
  // loses this check and keeps the per-row one, which is a weaker detector, not
  // a false one.
  if (!ledger) return

  const meta = (input.meta ?? ledgerMetaForDowngradeCheck)()
  const known = ledger.knownIds()
  // Recorded once, when the row is first seen and its seal has just been
  // verified. Re-recording a row every sync would both grow the blob without
  // bound and let a tampered ciphertext overwrite the digest that would have
  // convicted it.
  const toRecord = report.verifiedIds.filter((id) => !known.has(id))
  if (toRecord.length > 0) {
    const byId = new Map(all.map((row) => [row.id, row]))
    const rows: LedgerRow[] = []
    for (const id of toRecord) {
      const row = byId.get(id)
      if (!row) continue
      rows.push(
        await ledgerRowFromSealed(row, meta[id] ?? { externalMessageId: "", receivedAt: "" }),
      )
    }
    await ledger.append(rows)
  }

  await ledger.verifyChain()
  // NOT authoritative: this tab holds the conversations it has opened, and it
  // evicts them. A message absent from that view is far more often a message
  // this tab never loaded than a deleted one, and a false alarm is the one
  // thing a detector may not produce.
  await ledger.verifyAgainstServer(all, { authoritative: false })
}

export interface MailboxDowngradeAlarmHostProps {
  userId: string | null
}

export const MailboxDowngradeAlarmHost: Component<MailboxDowngradeAlarmHostProps> = (props) => {
  const api = useApi()
  const verified = new Set<string>()
  let store: IndexBlobStore | null = null
  let ledger: MailboxLedger | null = null
  let ledgerEpoch = currentIntegrityEpoch()

  const sweep = async (): Promise<void> => {
    const userId = props.userId
    const crypto = mailboxCryptoClient()
    if (!userId || !crypto) return
    try {
      // The owner re-keyed the mailbox (a reset) and this device's records were
      // dropped: start over rather than check new mail against the old chain.
      if (ledgerEpoch !== currentIntegrityEpoch()) {
        ledgerEpoch = currentIntegrityEpoch()
        ledger = null
        verified.clear()
      }
      // Opened once per tab, then reused: the blob is read and parsed on the
      // first sweep, not on every resync.
      if (!ledger && store) {
        ledger = await openMailboxLedger({ store, userId, crypto })
      }
      await runDowngradeSweep({
        userId,
        api,
        crypto,
        store: store ?? undefined,
        ledger: ledger ?? undefined,
        verified,
      })
    } catch {
      // A sweep that could not run is not a finding. Failing to check and
      // finding a downgrade are different facts and only one of them may
      // raise an alarm.
    }
  }

  onMount(() => {
    store = createIndexedDbBlobStore("liaison-mailbox-integrity", "records")
    const userId = props.userId
    if (userId && store) void loadDowngradeAlarm(store, userId)
    void sweep()
    const unsubscribe = subscribeResync(() => {
      void sweep()
    })
    onCleanup(unsubscribe)
  })

  return (
    <MailboxDowngradeAlarm
      userId={props.userId}
      store={() => store ?? createIndexedDbBlobStore("liaison-mailbox-integrity", "records")}
    />
  )
}
