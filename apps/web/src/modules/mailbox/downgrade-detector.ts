// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The downgrade detector (spec section 9.2 and section 9.6, blueprint tasks
// 13.1 and 13.2).
//
// WHAT IT DEFENDS AGAINST. An operator ordered to retain plaintext can simply
// stop sealing new inbound mail, or seal it to a key they hold. Nothing about
// the message rows would look wrong to the reader, so the compulsion would be
// invisible. This module makes it visible.
//
// WHY THE CHECK IS CRYPTOGRAPHIC. Comparing `enc_version` and `enc_key_id`
// proves nothing: both are values the server writes, so an operator sealing to
// their own key would write the victim's key id and pass. The only check worth
// having is the real one, so `verifySyncBatch` asks the worker to UNWRAP each
// row's content key under a private key from this device's own keyring. The D1
// binding puts the recipient user id, the key id, the recipient's static public
// key and the ephemeral public key inside the KEK derivation, so an unwrap that
// succeeds is proof of all four at once.
//
// The keyring itself gets the same treatment. The server returns the identity
// list, so the list is verified against an Ed25519 `keyring_attestation` under
// a signing key PINNED on this device. An operator who inserts an extra active
// identity changes the signed statement, and no attestation they can produce
// verifies under a key they do not hold.
//
// WHAT THE LEDGER CAN AND CANNOT DO. Honesty first, because a detector that is
// oversold is worse than none. The ledger records
// `(messageId, external_message_id, receivedAt, SHA-256(ciphertext))` in an
// append-only chain, each entry MACed under D8 over the previous MAC, so:
//   * modification of a ciphertext this client has already seen is detected,
//   * deletion of such a message is detected when the listing is authoritative,
//   * local tampering with the ledger file itself is detected.
// It CANNOT detect injection of a new message, and this module must never be
// described as if it could. The seal is anonymous ECDH-ES, every org member can
// read the recipient public key by design, and anyone who can read it and write
// an `app_mail.messages` row can mint a content key and insert a message that
// decrypts with a valid tag. Signing at ingest is impossible by construction,
// because the server has no user signing key, and that impossibility is exactly
// what makes unattended sealing work (spec section 9.6).
// It also cannot detect a server that WITHHOLDS or REORDERS messages that this
// client never saw: the ledger only knows what it was shown. A message
// suppressed before it was ever recorded leaves no trace here, and message
// ORDER is not part of the chain, only arrival into this client's own view.
//
// COST. Verification is one ECDH plus one HKDF plus one AES-KW per newly
// arrived row, with no field decryption, and it runs on rows the client has not
// verified before rather than on the whole mailbox. `maxRows` bounds one sync's
// work; the overflow is DEFERRED and returned to the caller, never skipped, so
// bounding the cost cannot silently create a hole.
//
// The ledger's own per sync cost is bounded three ways, because it is the half
// whose work grows with the size of the mailbox rather than with new mail:
//   * appends happen once per message, on the sync that first verifies it, so
//     they are bounded by the same `maxRows`,
//   * chain verification recomputes at most `MAX_LEDGER_VERIFY_PER_SYNC` MACs,
//     in one batched worker round trip: the tail always, plus a rotating slice
//     of the older prefix,
//   * the ledger itself is capped at `MAX_LEDGER_ENTRIES`, oldest dropped, the
//     chain kept intact across the drop by carrying the absolute index and the
//     dropped entry's MAC.

import { verifyKeyringAttestation } from "@liaison/mailbox-crypto"
import { createSignal } from "solid-js"
import {
  MAILBOX_LOCKED,
  MailboxCryptoError,
  type SealedMessagePayload,
  type SealVerdict,
} from "~/modules/mailbox/crypto-protocol"
import type { IdentityView } from "~/modules/mailbox/mailbox-api"
import {
  type Bytes,
  base64ToBytes,
  bytesToBase64,
  encodeUtf8,
} from "~/modules/mailbox/mailbox-bytes"
import type { IndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"

export const DOWNGRADE_FINDING_KINDS = [
  "unsealed-row",
  "unopenable-seal",
  "unattested-identity",
  "ledger-ciphertext-changed",
  "ledger-row-missing",
  "ledger-chain-broken",
] as const

export type DowngradeFindingKind = (typeof DOWNGRADE_FINDING_KINDS)[number]

export interface DowngradeFinding {
  kind: DowngradeFindingKind
  /** The message id, or `keyring` for a finding about the identity list. */
  subject: string
  detectedAt: string
}

/**
 * The two worker calls this module needs. Declared structurally so the detector
 * can be driven by a `MailboxCryptoClient`, by a `MailboxSession` in a test, or
 * by anything else that speaks the same two operations.
 */
export interface MailboxSealVerifier {
  verifySeals(rows: readonly SealedMessagePayload[]): Promise<SealVerdict[]>
  ledgerMac(statements: readonly string[]): Promise<string[]>
}

/**
 * How many rows one sync verifies. Chosen so a sync of a busy mailbox stays
 * well inside a frame budget's worth of worker time; the rest is deferred.
 */
export const MAX_ROWS_PER_SYNC = 200

const ALARM_STORE_VERSION = 1

function alarmStoreKey(userId: string): string {
  return `mailbox-alarm:${userId}`
}

function ledgerStoreKey(userId: string): string {
  return `mailbox-ledger:${userId}`
}

// ---------------------------------------------------------------------------
// The alarm
// ---------------------------------------------------------------------------

// Module scope on purpose: an alarm about the integrity of the mailbox is not
// owned by whichever screen happened to notice it.
const [findings, setFindings] = createSignal<DowngradeFinding[]>([])

/**
 * The findings raised so far. There is deliberately no bare "clear" in the
 * public surface: a detected downgrade is history, and nothing the server sends
 * may take it back. The owner's clear goes through `forgetDowngradeRecords`
 * after a proof of the mailbox secret (`alarm-clear.ts`). `resetDowngradeAlarm` exists for tests and for logout, both of
 * which are local, and even then the persisted copy is what a reload restores.
 */
export const currentDowngradeFindings = findings

function fingerprint(finding: DowngradeFinding): string {
  return `${finding.kind}:${finding.subject}`
}

/** Append, deduplicated by kind and subject. Order of first sighting is kept. */
export function raiseDowngradeFindings(next: readonly DowngradeFinding[]): DowngradeFinding[] {
  if (next.length === 0) return findings()
  const seen = new Set(findings().map(fingerprint))
  const added = next.filter((finding) => !seen.has(fingerprint(finding)))
  if (added.length === 0) return findings()
  const merged = [...findings(), ...added]
  setFindings(merged)
  return merged
}

/** Local only. Never called in response to anything the server says. */
export function resetDowngradeAlarm(): void {
  setFindings([])
}

/**
 * Bumped when this device's integrity records are dropped because the mailbox
 * was RE-KEYED by its owner (a mailbox reset). A host that keeps a ledger open
 * across syncs compares it and reopens, instead of checking the new mailbox
 * against a record chained under the old key.
 */
let integrityEpoch = 0

export function currentIntegrityEpoch(): number {
  return integrityEpoch
}

/**
 * Forget this device's downgrade records for one user: the alarm, the ledger
 * and a kept damaged ledger copy.
 *
 * Called ONLY when the user themselves proved the new keyring is theirs: after
 * a reset on this device, or after unlocking a re-keyed mailbox with the new
 * mailbox password (the server's wrapped private halves opened under the
 * Account Key that password recovers, which nobody without it can produce).
 * The third caller is the owner clearing the alarm (`alarm-clear.ts`), again
 * only after their mailbox secret opened the keyring in this tab.
 * Never in response to anything the server says on its own. The ledger is
 * chained under a MAC key derived from the OLD Account Key and records mail the
 * reset deleted, so keeping it would only raise findings about the user's own
 * action.
 */
export async function forgetDowngradeRecords(store: IndexBlobStore, userId: string): Promise<void> {
  integrityEpoch++
  setFindings([])
  for (const key of [
    alarmStoreKey(userId),
    ledgerStoreKey(userId),
    `${ledgerStoreKey(userId)}:damaged`,
  ]) {
    try {
      await store.delete(key)
    } catch {
      // A browser that blocks site data holds nothing to forget.
    }
  }
}

async function persistAlarm(store: IndexBlobStore, userId: string): Promise<void> {
  try {
    await store.put(
      alarmStoreKey(userId),
      JSON.stringify({ version: ALARM_STORE_VERSION, findings: findings() }),
    )
  } catch {
    // A browser that blocks site data still shows the alarm for this session.
    // Losing the persisted copy weakens the memory, never the detection.
  }
}

/** Rehydrate the alarm on load, so a reload cannot be a way to silence it. */
export async function loadDowngradeAlarm(
  store: IndexBlobStore,
  userId: string,
): Promise<DowngradeFinding[]> {
  let raw: string | null = null
  try {
    raw = await store.get(alarmStoreKey(userId))
  } catch {
    return findings()
  }
  if (!raw) return findings()
  try {
    const parsed = JSON.parse(raw) as { version?: number; findings?: DowngradeFinding[] }
    if (Array.isArray(parsed.findings)) raiseDowngradeFindings(parsed.findings)
  } catch {
    // A corrupted alarm file is not a reason to render nothing.
  }
  return findings()
}

// ---------------------------------------------------------------------------
// Task 13.1, per sync verification
// ---------------------------------------------------------------------------

export interface VerifySyncInput {
  userId: string
  /** The identity list exactly as the server returned it on this sync. */
  identities: readonly IdentityView[]
  /** The Ed25519 signing SPKI pinned on this device at enrollment, base64. */
  trustedSignSpki: string
  /** The newly arrived rows. Already verified rows do not belong here. */
  rows: readonly SealedMessagePayload[]
  crypto: MailboxSealVerifier
  maxRows?: number
  store?: IndexBlobStore
  now?: () => number
}

export interface VerifySyncReport {
  findings: DowngradeFinding[]
  verifiedIds: string[]
  /** Not skipped. Hand these back on the next sync. */
  deferredIds: string[]
  identitiesAttested: boolean
}

/**
 * Verify the returned identity list against the pinned signing key. The
 * attestation covers the WHOLE list, so any inserted, removed or re-statused
 * row changes the signed bytes and no attestation verifies. Each row carries an
 * attestation; the list is accepted if any one of them verifies over the exact
 * returned list under the pinned key, which is what a rotation writes.
 */
async function identitiesAreAttested(input: {
  userId: string
  identities: readonly IdentityView[]
  trustedSignSpki: string
}): Promise<boolean> {
  if (input.identities.length === 0) return true
  const attested = input.identities.map((identity) => ({
    keyId: identity.keyId,
    status: identity.status,
    ecdhSpki: base64ToBytes(identity.ecdhPublicKey),
    signSpki: base64ToBytes(identity.signPublicKey),
  }))
  const signPublicKey = base64ToBytes(input.trustedSignSpki)
  for (const identity of input.identities) {
    let attestation: Bytes
    try {
      attestation = base64ToBytes(identity.attestation)
    } catch {
      continue
    }
    // A malformed key or attestation must FAIL CLOSED. `verifyKeyringAttestation`
    // returns false for a bad signature but throws for a byte string that is
    // not an SPKI at all, and a detector that crashed on that input would be a
    // detector an operator could switch off by sending garbage.
    let ok = false
    try {
      ok = await verifyKeyringAttestation({
        signPublicKey,
        userId: input.userId,
        identities: attested,
        attestation,
      })
    } catch {
      ok = false
    }
    if (ok) return true
  }
  return false
}

function isLocked(error: unknown): boolean {
  return error instanceof MailboxCryptoError && error.code === MAILBOX_LOCKED
}

export async function verifySyncBatch(input: VerifySyncInput): Promise<VerifySyncReport> {
  const now = input.now ?? (() => Date.now())
  const detectedAt = new Date(now()).toISOString()
  const found: DowngradeFinding[] = []

  const attested = await identitiesAreAttested(input)
  if (!attested) {
    found.push({ kind: "unattested-identity", subject: "keyring", detectedAt })
  }

  const limit = Math.max(0, input.maxRows ?? MAX_ROWS_PER_SYNC)
  const batch = input.rows.slice(0, limit)
  const deferredIds = input.rows.slice(limit).map((row) => row.id)
  const verifiedIds: string[] = []

  if (batch.length > 0) {
    let verdicts: SealVerdict[]
    try {
      verdicts = await input.crypto.verifySeals(batch)
    } catch (error) {
      // A locked mailbox cannot verify anything, and "cannot check" is not
      // "found a downgrade". The rows come back on the next unlocked sync.
      if (isLocked(error)) {
        const report: VerifySyncReport = {
          findings: found,
          verifiedIds: [],
          deferredIds: batch.map((row) => row.id).concat(deferredIds),
          identitiesAttested: attested,
        }
        raiseDowngradeFindings(found)
        if (input.store && found.length > 0) await persistAlarm(input.store, input.userId)
        return report
      }
      throw error
    }
    for (const verdict of verdicts) {
      if (!verdict.sealed) {
        found.push({ kind: "unsealed-row", subject: verdict.id, detectedAt })
        continue
      }
      if (!verdict.opens) {
        found.push({ kind: "unopenable-seal", subject: verdict.id, detectedAt })
        continue
      }
      verifiedIds.push(verdict.id)
    }
  }

  raiseDowngradeFindings(found)
  if (input.store && found.length > 0) await persistAlarm(input.store, input.userId)
  return { findings: found, verifiedIds, deferredIds, identitiesAttested: attested }
}

// ---------------------------------------------------------------------------
// Task 13.2, the client MAC ledger
// ---------------------------------------------------------------------------

export const LEDGER_STATEMENT_LABEL = "liaison.mailbox.ledger.v1"

export interface LedgerRow {
  messageId: string
  externalMessageId: string
  receivedAt: string
  /** Base64 SHA-256 over the row's canonical ciphertext encoding. */
  ciphertextDigest: string
}

export interface LedgerEntry extends LedgerRow {
  /** HMAC-SHA256 under D8 over the canonical statement, base64. */
  mac: string
}

/**
 * The canonical bytes a ledger digest covers: every ciphertext column plus the
 * wrap that binds them. Single newline joined with NO trailing newline, the
 * same shape as the acknowledgement digest, so a value can never be silently
 * shifted from one field into the next.
 */
export function encodeCiphertextForDigest(row: SealedMessagePayload): string {
  return [
    row.id,
    String(row.encVersion),
    String(row.encKeyId),
    row.contentKeyWrapped,
    row.contentKeyEpk,
    row.subjectCiphertext ?? "",
    row.textBodyCiphertext ?? "",
    row.htmlBodyCiphertext ?? "",
    row.snippetCiphertext ?? "",
  ].join("\n")
}

export async function ciphertextDigest(row: SealedMessagePayload): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(encodeCiphertextForDigest(row)))
  return bytesToBase64(new Uint8Array(digest) as Bytes)
}

/** The one conversion from a sealed row to the four values the ledger keeps. */
export async function ledgerRowFromSealed(
  row: SealedMessagePayload,
  meta: { externalMessageId: string; receivedAt: string },
): Promise<LedgerRow> {
  return {
    messageId: row.id,
    externalMessageId: meta.externalMessageId,
    receivedAt: meta.receivedAt,
    ciphertextDigest: await ciphertextDigest(row),
  }
}

/**
 * The chained statement. `previousMac` is what makes the ledger append only in
 * a checkable way: removing an interior entry shifts every later index and
 * breaks every later MAC.
 */
export function encodeLedgerStatement(
  entry: LedgerRow,
  index: number,
  previousMac: string,
): string {
  return [
    LEDGER_STATEMENT_LABEL,
    String(index),
    previousMac,
    entry.messageId,
    entry.externalMessageId,
    entry.receivedAt,
    entry.ciphertextDigest,
  ].join("\n")
}

export interface VerifyAgainstServerOptions {
  /**
   * True only when `rows` is the COMPLETE server-side listing for the range the
   * ledger covers. A paginated page is not authoritative, and calling a message
   * absent from one page a deletion would be a false alarm, which is the one
   * thing a detector may not produce.
   */
  authoritative?: boolean
  now?: () => number
}

export interface VerifyChainOptions {
  /** MACs recomputed in one pass. Bounds a sync on a slow device. */
  maxEntries?: number
}

export interface MailboxLedger {
  entries(): LedgerEntry[]
  /** Message ids already recorded, so a sweep never appends the same row twice. */
  knownIds(): Set<string>
  append(rows: readonly LedgerRow[]): Promise<LedgerEntry[]>
  /** Local integrity: has this ledger file been edited under us. */
  verifyChain(options?: VerifyChainOptions): Promise<DowngradeFinding[]>
  /** Server integrity: has a message we recorded been changed or removed. */
  verifyAgainstServer(
    rows: readonly SealedMessagePayload[],
    options?: VerifyAgainstServerOptions,
  ): Promise<DowngradeFinding[]>
}

/**
 * How much of the chain one sync recomputes. The whole chain is NOT verified
 * every sync: a mailbox with tens of thousands of recorded messages would put
 * that many HMACs on the main thread of whatever device the user happens to
 * hold. Two windows are checked instead, which together cover the two ways a
 * chain breaks:
 *   * the TAIL, always. Removing or inserting an interior entry shifts the
 *     index of every later entry, so every entry after the splice fails its
 *     recomputation and the tail sees it on the very next sync.
 *   * a ROTATING window over the older prefix, which is what catches an edit
 *     made in place to one old entry. It is found within
 *     ceil(entries / MAX_LEDGER_VERIFY_PER_SYNC) syncs rather than instantly.
 */
export const MAX_LEDGER_VERIFY_PER_SYNC = 500

/**
 * The ledger's own size cap. Past this the oldest entries are dropped, and the
 * chain survives the drop because the surviving head keeps the absolute index
 * and the dropped entry's MAC it was signed against. Dropping history weakens
 * detection for mail that old, which is the honest trade for not growing an
 * unbounded blob in a browser store.
 */
export const MAX_LEDGER_ENTRIES = 5000

interface LedgerBlob {
  version?: number
  userId?: string
  baseIndex?: number
  basePrevMac?: string
  entries?: unknown
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.messageId === "string" &&
    typeof entry.externalMessageId === "string" &&
    typeof entry.receivedAt === "string" &&
    typeof entry.ciphertextDigest === "string" &&
    typeof entry.mac === "string"
  )
}

export interface OpenLedgerInput {
  store: IndexBlobStore
  userId: string
  crypto: MailboxSealVerifier
  now?: () => number
}

export async function openMailboxLedger(input: OpenLedgerInput): Promise<MailboxLedger> {
  const now = input.now ?? (() => Date.now())
  const key = ledgerStoreKey(input.userId)
  let entries: LedgerEntry[] = []
  let baseIndex = 0
  let basePrevMac = ""
  let rotation = 0

  // Three states have to be told apart here, because they mean opposite things:
  //   * nothing stored: a first run on this device. There is no history to
  //     contradict, so raising anything would be a false alarm.
  //   * stored for someone else: not this user's record. Ignored, not evidence.
  //   * stored, unreadable: this browser's own record was damaged, which is one
  //     of the things the ledger exists to notice. It is reported, and the
  //     damaged bytes are kept under a second key rather than thrown away.
  let raw: string | null = null
  let readable = true
  try {
    raw = await input.store.get(key)
  } catch {
    // A store that cannot be read at all is a browser condition, not a finding.
    raw = null
  }
  if (raw) {
    let parsed: LedgerBlob | null = null
    try {
      parsed = JSON.parse(raw) as LedgerBlob
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== "object") {
      readable = false
    } else if (typeof parsed.userId === "string" && parsed.userId !== input.userId) {
      entries = []
    } else if (Array.isArray(parsed.entries) && parsed.entries.every(isLedgerEntry)) {
      entries = parsed.entries as LedgerEntry[]
      baseIndex = typeof parsed.baseIndex === "number" ? parsed.baseIndex : 0
      basePrevMac = typeof parsed.basePrevMac === "string" ? parsed.basePrevMac : ""
    } else {
      readable = false
    }
  }
  if (!readable) {
    entries = []
    try {
      await input.store.put(`${key}:damaged`, raw ?? "")
    } catch {
      // Keeping the damaged copy is best effort. The finding below is not.
    }
    const damaged: DowngradeFinding[] = [
      {
        kind: "ledger-chain-broken",
        subject: "ledger",
        detectedAt: new Date(now()).toISOString(),
      },
    ]
    raiseDowngradeFindings(damaged)
    await persistAlarm(input.store, input.userId)
  }

  async function save(): Promise<void> {
    try {
      await input.store.put(
        key,
        JSON.stringify({ version: 1, userId: input.userId, baseIndex, basePrevMac, entries }),
      )
    } catch {
      // Same reasoning as the alarm: a cache that cannot be written means
      // "less memory", never an error page.
    }
  }

  function knownIds(): Set<string> {
    return new Set(entries.map((entry) => entry.messageId))
  }

  async function append(rows: readonly LedgerRow[]): Promise<LedgerEntry[]> {
    if (rows.length === 0) return entries
    // Appending cannot batch: each statement covers the PREVIOUS entry's MAC,
    // which does not exist until that entry is signed. Chaining and batching
    // cannot both be had here and the chain is the property worth keeping, so
    // an append is one round trip per new row. Verification, where every MAC is
    // already known, does batch: see `verifyChain`.
    let previousMac = entries.length > 0 ? entries[entries.length - 1].mac : basePrevMac
    const produced: LedgerEntry[] = []
    for (let i = 0; i < rows.length; i++) {
      const statement = encodeLedgerStatement(rows[i], baseIndex + entries.length + i, previousMac)
      const [mac] = await input.crypto.ledgerMac([statement])
      produced.push({ ...rows[i], mac })
      previousMac = mac
    }
    entries = [...entries, ...produced]
    if (entries.length > MAX_LEDGER_ENTRIES) {
      const dropped = entries.length - MAX_LEDGER_ENTRIES
      basePrevMac = entries[dropped - 1].mac
      baseIndex += dropped
      entries = entries.slice(dropped)
    }
    await save()
    return entries
  }

  /** The absolute index and preceding MAC an entry at array position i signed. */
  function statementAt(i: number): string {
    return encodeLedgerStatement(
      entries[i],
      baseIndex + i,
      i === 0 ? basePrevMac : entries[i - 1].mac,
    )
  }

  async function verifyChain(options: VerifyChainOptions = {}): Promise<DowngradeFinding[]> {
    const detectedAt = new Date(now()).toISOString()
    if (entries.length === 0) return []
    const window = Math.max(1, options.maxEntries ?? MAX_LEDGER_VERIFY_PER_SYNC)

    // The tail always, because a splice anywhere shifts every later index.
    const positions = new Set<number>()
    for (let i = Math.max(0, entries.length - window); i < entries.length; i++) positions.add(i)
    // Plus one rotating slice of the older prefix, for an in-place edit that
    // the tail cannot see. Successive syncs walk the whole prefix.
    const prefix = Math.max(0, entries.length - window)
    if (prefix > 0) {
      const start = (rotation * window) % prefix
      for (let i = start; i < Math.min(start + window, prefix); i++) positions.add(i)
      rotation += 1
    }

    const ordered = [...positions].sort((a, b) => a - b)
    const macs = await input.crypto.ledgerMac(ordered.map(statementAt))
    const findingsFound: DowngradeFinding[] = []
    for (let i = 0; i < ordered.length; i++) {
      if (macs[i] !== entries[ordered[i]].mac) {
        findingsFound.push({
          kind: "ledger-chain-broken",
          subject: entries[ordered[i]].messageId,
          detectedAt,
        })
      }
    }
    raiseDowngradeFindings(findingsFound)
    if (findingsFound.length > 0) await persistAlarm(input.store, input.userId)
    return findingsFound
  }

  async function verifyAgainstServer(
    rows: readonly SealedMessagePayload[],
    options: VerifyAgainstServerOptions = {},
  ): Promise<DowngradeFinding[]> {
    const detectedAt = new Date((options.now ?? now)()).toISOString()
    const byId = new Map(rows.map((row) => [row.id, row]))
    const findingsFound: DowngradeFinding[] = []
    for (const entry of entries) {
      const row = byId.get(entry.messageId)
      if (!row) {
        // Only an authoritative listing can call this a deletion.
        if (options.authoritative) {
          findingsFound.push({
            kind: "ledger-row-missing",
            subject: entry.messageId,
            detectedAt,
          })
        }
        continue
      }
      if ((await ciphertextDigest(row)) !== entry.ciphertextDigest) {
        findingsFound.push({
          kind: "ledger-ciphertext-changed",
          subject: entry.messageId,
          detectedAt,
        })
      }
    }
    // Rows the ledger has never seen are NOT an anomaly. Injection is
    // undetectable by construction (spec section 9.6) and reporting it here
    // would be a claim this design cannot back.
    raiseDowngradeFindings(findingsFound)
    if (findingsFound.length > 0) await persistAlarm(input.store, input.userId)
    return findingsFound
  }

  return { entries: () => [...entries], knownIds, append, verifyChain, verifyAgainstServer }
}
