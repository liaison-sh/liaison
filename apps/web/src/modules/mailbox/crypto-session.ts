// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The unlocked mailbox session. This module runs INSIDE the crypto Web Worker
// and nowhere else: it is the only place in the product that holds the Account
// Key or an unwrapped identity private key.
//
// The normative unlock sequence (spec section 3.3):
//   1. Unwrap the Account Key to raw bytes in worker memory.
//   2. Import from those bytes the non-extractable handles this session needs.
//   3. Zero the bytes immediately unless the session may mint new wraps.
//   4. Persist only the derived non-extractable handles, never the bytes.
//
// Step 1 exists because `crypto.subtle.wrapKey` performs an internal export and
// throws `InvalidAccessError` on a non-extractable key, and an AES key cannot
// be HKDF input material: a single non-extractable Account Key handle cannot
// serve the design.
//
// `extractable: false` at every step, including the identity private keys.
// Passing `true` there, the default in most examples, turns an XSS from a
// bounded compromise into a permanent total one.

import {
  deriveFieldSubkey,
  deriveIndexKey,
  deriveLedgerMacKey,
  MAILBOX_ENC_VERSION,
  type MailboxAadContext,
  mailboxAad,
  STREAM_TAG_BYTES,
  sealField,
} from "@liaison/mailbox-crypto"
import { signAck } from "@liaison/mailbox-crypto/src/ack"
import {
  type AccountKeyWrap,
  type Argon2idFn,
  decryptAttachmentStream,
  importAccountKeyForDerivation,
  isLegacyPassphraseWrap,
  type KeyringEntry,
  type KeyStoreBackend,
  LegacyPassphraseUnavailableError,
  loadPersistedKey,
  openField,
  persistKey,
  unsealContentKey,
  unwrapIdentityKey,
  unwrapWithPassphrase,
  unwrapWithPrfSecret,
  WrapError,
  wipePersistedKeys,
  wrapWithPassphrase,
  wrapWithPrfSecret,
  zeroBytes,
} from "@liaison/mailbox-crypto/src/client"
import {
  clampIdleTimeoutMs,
  type DeviceLeaseRequest,
  type ExtendLeaseRequest,
  IDLE_TIMEOUT_DEFAULT_MS,
  type KeyringEntryPayload,
  MAILBOX_DEVICE_PRF_MISMATCH,
  MAILBOX_KEYRING_UNAVAILABLE,
  MAILBOX_LOCKED,
  MAILBOX_PASSWORD_FORMAT_UNSUPPORTED,
  MAILBOX_RUNTIME_FAILED,
  MAILBOX_UNLOCK_REFUSED,
  type MailboxAckRequest,
  type MailboxAckSigned,
  MailboxCryptoError,
  type MintedWrap,
  type MintWrapRequest,
  type OpenedApprovalDraft,
  type OpenedAttachment,
  type OpenedConversation,
  type OpenedMessage,
  type OpenOptions,
  type RestoreRequest,
  type SealedApprovalDraft,
  type SealedAttachmentPayload,
  type SealedConversationPayload,
  type SealedMessagePayload,
  type SealVerdict,
  type UnlockPrompting,
  type UnlockRequest,
  type UnlockResult,
  type WrapBlobPayload,
} from "~/modules/mailbox/crypto-protocol"
import {
  type Bytes,
  base64ToBytes,
  bytesToBase64,
  decodeUtf8,
  encodeUtf8,
} from "~/modules/mailbox/mailbox-bytes"

export interface MailboxSessionDeps {
  keyStore: KeyStoreBackend
  now?: () => number
  /**
   * The LEGACY passphrase KDF, injected in tests. Production uses the package
   * default (hash-wasm Argon2id), or none at all in the native build. Named for
   * what it is to this module rather than for the algorithm, so the native
   * bundle carries no trace of it.
   */
  legacyKdf?: Argon2idFn
}

interface UnlockedState {
  userId: string
  /** The organisation of the lease this session was opened or restored under. */
  orgId: string | null
  /** Per key id: the identity private halves and the public SPKI they bind. */
  identities: Map<number, { ecdhPrivate: CryptoKey; signPrivate: CryptoKey; ecdhSpki: Bytes }>
  /** Non-extractable HKDF handle over the Account Key, for D7 and D8. */
  accountKeyHkdf: CryptoKey
  /**
   * Which key id new sealing binds to. Retired ids stay in `identities` so old
   * mail keeps opening; sealing to one of them would be a silent downgrade.
   */
  activeKeyId: number
  /** Only for a session that may mint new wraps. Otherwise null. */
  accountKeyBytes: Bytes | null
  lastActivity: number
}

export interface MailboxSession {
  unlock(request: UnlockRequest): Promise<UnlockResult>
  /** Re-open from this device's persisted handles; false means unlock once more. */
  restore(request: RestoreRequest): Promise<boolean>
  /**
   * A token renewal: move this login's device lease to the new expiry. False
   * when there is no live lease for that user and organisation.
   */
  extendLease(request: ExtendLeaseRequest): Promise<boolean>
  openMessage(sealed: SealedMessagePayload, options?: OpenOptions): Promise<OpenedMessage>
  /**
   * Open a conversation row's own subject and snippet, the two fields the
   * conversation list shows. Separate from `openMessage` because the AAD binds
   * them to the conversation id under the conversation contexts.
   */
  openConversation(
    sealed: SealedConversationPayload,
    options?: OpenOptions,
  ): Promise<OpenedConversation>
  /**
   * Open the sealed draft of a gated mail send's approval payload (blueprint
   * Task 9.8). Separate from `openMessage` because the AAD is different: these
   * blobs are bound to the APPROVAL REQUEST id under the draft contexts, so one
   * approval's ciphertext cannot be opened as another's, nor as a message field.
   */
  openApprovalDraft(
    sealed: SealedApprovalDraft,
    options?: OpenOptions,
  ): Promise<OpenedApprovalDraft>
  /**
   * Open a stored attachment whole, so a forward or a re-attach can carry the
   * real file (blueprint Task 9.9). A truncated or tampered object is an error,
   * never a shorter file.
   */
  openAttachment(sealed: SealedAttachmentPayload, options?: OpenOptions): Promise<OpenedAttachment>
  lock(): Promise<void>
  isUnlocked(): boolean
  /**
   * Seal one client search-index shard under D7 (spec sections 3.6 and 5.5).
   * It lives here, in the worker, for the same reason everything else here
   * does: D7 takes the Account Key as input keying material, and the page has
   * no Account Key. Takes and returns strings; the caller stores the base64.
   */
  sealIndexShard(shardId: string, plaintext: string): Promise<string>
  openIndexShard(shardId: string, blob: string): Promise<string>
  /**
   * The downgrade detector's cryptographic half (spec section 9.2). It unwraps
   * each row's content key and throws the result away, so it costs one ECDH
   * plus one HKDF plus one AES-KW per row and decrypts no field.
   */
  verifySeals(rows: readonly SealedMessagePayload[]): Promise<SealVerdict[]>
  /**
   * Sign the migration acknowledgement (spec section 7 step 6). The statement's
   * `userId` and `keyId` come from this session, not from the caller, because
   * both are inside the signed bytes.
   */
  signAck(statement: MailboxAckRequest): Promise<MailboxAckSigned>
  /**
   * Wrap the open session's Account Key under a NEW secret: the mailbox
   * password (a legacy keyring that has none), or this device's passkey (added
   * after unlocking with the password). Only a session unlocked with
   * `mintWraps: true` still holds the bytes; any other session refuses. A
   * passkey wrap is proven by unwrapping it again before it is returned, so a
   * wrap that could never be reproduced is never saved.
   */
  mintWrap(request: MintWrapRequest): Promise<MintedWrap>
  /** Zero the Account Key bytes a `mintWraps` unlock kept. Idempotent. */
  endMinting(): void
  /**
   * HMAC-SHA256 under D8 over the client ledger's canonical statements. It
   * lives here for the same reason D7 does: D8 takes the Account Key as input
   * keying material and the page has no Account Key. Batched, so a chain of N
   * entries costs one worker round trip.
   */
  ledgerMac(statements: readonly string[]): Promise<string[]>
  expireIfIdle(): Promise<boolean>
  idleTimeoutMs(): number
  setIdleTimeoutMs(ms: number): void
  holdsAccountKeyBytes(): boolean
  /** Test seam. Returns HANDLES, never bytes, so it cannot become an oracle. */
  inspectHandlesForTest(): CryptoKey[]
}

const STORE_PREFIX = "mailbox-session"

/**
 * Every record is filed under the organisation AND the user it belongs to, so
 * a restore for anyone else misses: another user of this browser, or the same
 * person signed in to another organisation, never opens these handles.
 */
function ownerPrefix(orgId: string, userId: string): string {
  return `${STORE_PREFIX}:${orgId}:${userId}:`
}

function storeId(
  orgId: string,
  userId: string,
  tag: string,
  part: "ecdh" | "sign" | "hkdf",
): string {
  return `${ownerPrefix(orgId, userId)}${tag}:${part}`
}

function leaseId(orgId: string, userId: string): string {
  return `${ownerPrefix(orgId, userId)}lease`
}

/**
 * The record that makes the handles beside it usable: whose they are, the ids
 * written, and when the login they were unlocked under ends. Written LAST, so
 * a write cut short leaves handles no restore will read. Holds no key material.
 */
interface StoredLease {
  v: 1
  userId: string
  orgId: string
  expiresAt: number
  ids: string[]
}

function isStoredLease(value: unknown, orgId: string, userId: string): value is StoredLease {
  const lease = value as Partial<StoredLease> | null
  return (
    !!lease &&
    lease.v === 1 &&
    lease.userId === userId &&
    lease.orgId === orgId &&
    typeof lease.expiresAt === "number" &&
    Array.isArray(lease.ids) &&
    lease.ids.every((id) => typeof id === "string")
  )
}

/** A short SHA-256 tag over public key bytes, to name the handles they belong to. */
async function fingerprint(parts: readonly Bytes[]): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined))
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** The whole keyring's tag: the Account Key handle is valid for exactly this set. */
function keyringFingerprint(keyring: readonly KeyringEntryPayload[]): Promise<string> {
  const sorted = [...keyring].sort((a, b) => a.keyId - b.keyId)
  return fingerprint(sorted.map((entry) => base64ToBytes(entry.ecdhSpki)))
}

/**
 * Which key id new sealing binds to. No active entry at all means a keyring of
 * retired keys, which can still OPEN old mail; sealing picks the highest id so
 * a later rotation cannot be undone by ordering.
 */
function activeKeyIdOf(keyring: readonly KeyringEntryPayload[]): number {
  const active = keyring.find((entry) => entry.status === "active")
  return active?.keyId ?? Math.max(...keyring.map((e) => e.keyId))
}

function decodeKeyringEntry(entry: KeyringEntryPayload): KeyringEntry {
  return {
    keyId: entry.keyId,
    status: entry.status,
    ecdhSpki: base64ToBytes(entry.ecdhSpki),
    signSpki: base64ToBytes(entry.signSpki),
    wrappedEcdhPrivate: base64ToBytes(entry.wrappedEcdhPrivate),
    wrappedSignPrivate: base64ToBytes(entry.wrappedSignPrivate),
    ecdhWrapIv: base64ToBytes(entry.ecdhWrapIv),
    signWrapIv: base64ToBytes(entry.signWrapIv),
  }
}

function decodeWrap(wrap: WrapBlobPayload): AccountKeyWrap {
  const salt = wrap.kdfParams?.salt
  if (!salt) {
    throw new MailboxCryptoError(MAILBOX_UNLOCK_REFUSED, "this wrap is missing its salt")
  }
  const credentialId = wrap.kdfParams?.credentialId
  const kdf = wrap.kdfParams?.kdf
  const iterations = wrap.kdfParams?.iterations
  return {
    wrapType: wrap.wrapType,
    wrappedAccountKey: base64ToBytes(wrap.wrappedAccountKey),
    kdfParams: {
      salt: base64ToBytes(salt),
      ...(credentialId ? { credentialId: base64ToBytes(credentialId) } : {}),
      // Carried as served: the package refuses a KDF name or an iteration
      // count it does not accept, and a row with neither is the legacy format.
      ...(kdf !== undefined ? { kdf } : {}),
      ...(iterations !== undefined ? { iterations } : {}),
    },
    ...(wrap.verifier ? { verifier: base64ToBytes(wrap.verifier) } : {}),
  }
}

/**
 * Cut a stored attachment object back into the chunks it was sealed as.
 *
 * Every chunk but the last is exactly `chunkSize` plaintext bytes plus one GCM
 * tag; the last is whatever remains. The decryptor authenticates each chunk
 * under its own index, so a wrong split fails loudly rather than yielding
 * plausible-looking bytes.
 */
function splitStreamChunks(body: Bytes, chunkSize: number, chunkCount: number): Bytes[] {
  const sealedChunk = chunkSize + STREAM_TAG_BYTES
  const out: Bytes[] = []
  let offset = 0
  for (let index = 0; index < chunkCount; index++) {
    const take = index === chunkCount - 1 ? body.byteLength - offset : sealedChunk
    out.push(body.subarray(offset, offset + take) as Bytes)
    offset += take
  }
  return out
}

/** A passphrase wrap in the shape the REST surface stores, KDF named. */
function mintedPassphraseWrap(wrap: AccountKeyWrap): MintedWrap {
  return {
    wrapType: "passphrase",
    wrappedAccountKey: bytesToBase64(wrap.wrappedAccountKey),
    kdfParams: {
      salt: bytesToBase64(wrap.kdfParams.salt),
      ...(wrap.kdfParams.kdf ? { kdf: wrap.kdfParams.kdf } : {}),
      ...(wrap.kdfParams.iterations !== undefined ? { iterations: wrap.kdfParams.iterations } : {}),
    },
  }
}

/**
 * True when the unwrap ran and its integrity check refused the key material:
 * the one failure that says something about the secret. WebCrypto names it
 * OperationError, and `unwrapUnder` wraps it in a WrapError whose cause it is.
 */
export function isUnwrapRefusal(error: unknown): boolean {
  const name = (value: unknown) => (value as { name?: unknown } | null)?.name
  if (name(error) === "OperationError") return true
  return (
    error instanceof WrapError && name((error as { cause?: unknown }).cause) === "OperationError"
  )
}

function describeRuntimeFailure(error: unknown): string {
  const named = error as { name?: unknown; message?: unknown; cause?: unknown } | null
  const cause = named?.cause as { name?: unknown; message?: unknown } | undefined
  return [
    `${String(named?.name ?? typeof error)}: ${String(named?.message ?? "")}`,
    cause ? `cause ${String(cause.name ?? "")}: ${String(cause.message ?? "")}` : "",
  ]
    .filter(Boolean)
    .join("; ")
}

const exactUtf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true })

/**
 * Open one sealed text field. With `keys` (an open asked `withFieldKeys`), also
 * record under `field` the D5 subkey it opened with: the proof the server checks
 * when the plaintext is handed to it (`OpenOptions`).
 */
async function openTextField(
  contentKey: CryptoKey,
  blob: string | null | undefined,
  context: MailboxAadContext,
  keys: Record<string, string> | null,
  field: string,
): Promise<string | null> {
  if (!blob) return null
  const bytes = await openField({ contentKey, context, blob: base64ToBytes(blob) })
  // Handed back for a byte-exact check, the text keeps a leading BOM, which the
  // default decoder drops (and the check would then fail for that row forever).
  const plaintext = keys ? exactUtf8Decoder.decode(bytes) : decodeUtf8(bytes)
  if (keys) {
    const subkey = await deriveFieldSubkey({
      contentKey,
      fieldName: context.fieldName,
      entityId: context.entityId,
    })
    keys[field] = bytesToBase64(subkey)
    subkey.fill(0)
  }
  return plaintext
}

export function createMailboxSession(deps: MailboxSessionDeps): MailboxSession {
  const now = deps.now ?? (() => Date.now())
  let state: UnlockedState | null = null
  let idleMs = IDLE_TIMEOUT_DEFAULT_MS

  async function dropState(): Promise<void> {
    if (state?.accountKeyBytes) zeroBytes(state.accountKeyBytes)
    state = null
    // The wipe deletes the IndexedDB RECORDS, not only the in-memory handles.
    await wipePersistedKeys(deps.keyStore)
  }

  function requireUnlocked(): UnlockedState {
    if (!state) throw new MailboxCryptoError(MAILBOX_LOCKED)
    return state
  }

  async function openAccountKey(request: UnlockRequest): Promise<Bytes> {
    const wrap = decodeWrap(request.wrap)
    try {
      if (request.method === "passphrase") {
        return await unwrapWithPassphrase({
          wrap,
          passphrase: request.secret,
          userId: request.userId,
          legacyKdf: deps.legacyKdf,
        })
      }
      return await unwrapWithPrfSecret({
        wrap,
        prfSecret: base64ToBytes(request.secret),
        userId: request.userId,
      })
    } catch (error) {
      // A legacy password row in a build without the legacy KDF: not a wrong
      // secret, and the only error whose TYPE is read. Its message is fixed
      // text that carries nothing from the wrap.
      if (error instanceof LegacyPassphraseUnavailableError) {
        throw new MailboxCryptoError(
          MAILBOX_PASSWORD_FORMAT_UNSUPPORTED,
          "this mailbox password row is in a format this app cannot open",
        )
      }
      // Only an unwrap the AES-KW integrity check refused is a verdict on the
      // secret. Anything else (a WebAssembly compile a policy blocked, memory,
      // a primitive this engine lacks, a malformed row) means the secret was
      // never checked, and calling that a wrong password sends the user to a
      // reset they do not need. Only the error's NAME and the primitive's
      // fixed message are logged, never anything from the wrap.
      if (!isUnwrapRefusal(error)) {
        console.error("[mailbox] the unlock could not run", describeRuntimeFailure(error))
        throw new MailboxCryptoError(
          MAILBOX_RUNTIME_FAILED,
          "the unlock could not run on this device",
        )
      }
      // A PRF-derived KEK that fails the unwrap means "this device's PRF output
      // does not match this wrap", which is a runtime condition that can appear
      // on a device that used to work (spec 3.2). It is never corruption.
      if (request.method === "passkey_prf") {
        throw new MailboxCryptoError(
          MAILBOX_DEVICE_PRF_MISMATCH,
          "this device's passkey cannot unlock this mailbox",
        )
      }
      throw new MailboxCryptoError(
        MAILBOX_UNLOCK_REFUSED,
        "that secret does not unlock this mailbox",
      )
    }
  }

  async function unlock(request: UnlockRequest): Promise<UnlockResult> {
    if (request.keyring.length === 0) {
      throw new MailboxCryptoError(MAILBOX_KEYRING_UNAVAILABLE, "no keyring entry to unwrap")
    }
    const accountKey = await openAccountKey(request)
    let prompting: UnlockPrompting = "re-prompt-each-session"
    let upgradedWrap: MintedWrap | undefined
    try {
      const identities = new Map<
        number,
        { ecdhPrivate: CryptoKey; signPrivate: CryptoKey; ecdhSpki: Bytes }
      >()
      for (const payload of request.keyring) {
        const entry = decodeKeyringEntry(payload)
        const keys = await unwrapIdentityKey({ accountKey, userId: request.userId, entry })
        identities.set(entry.keyId, { ...keys, ecdhSpki: entry.ecdhSpki })
      }
      const accountKeyHkdf = await importAccountKeyForDerivation(accountKey)
      // The silent migration of a legacy password row: re-wrapped here, while
      // the bytes still exist, and handed to the page to save.
      if (request.method === "passphrase" && isLegacyPassphraseWrap(decodeWrap(request.wrap))) {
        upgradedWrap = await upgradePassphraseWrap(accountKey, request.secret, request.userId)
      }

      state = {
        userId: request.userId,
        orgId: request.lease?.orgId ?? null,
        identities,
        accountKeyHkdf,
        activeKeyId: activeKeyIdOf(request.keyring),
        accountKeyBytes: request.mintWraps ? accountKey : null,
        lastActivity: now(),
      }
      // Step 4. The handles are what `restore` reads back on the next page
      // load or app start, so one unlock lasts as long as the login does. A
      // write that fails is not an error: this device then asks again next time.
      if (await persistSession(request.userId, request.keyring, state, request.lease)) {
        prompting = "restored-from-store"
      }
    } finally {
      // Step 3. Zeroed unless this session was explicitly opened to mint wraps,
      // in which case the bytes are now owned by `state` and zeroed at lock.
      if (!request.mintWraps) zeroBytes(accountKey)
    }
    return {
      unlocked: true,
      prompting,
      holdsAccountKeyBytes: state.accountKeyBytes !== null,
      ...(upgradedWrap ? { upgradedWrap } : {}),
    }
  }

  /**
   * The same Account Key under the same password, with PBKDF2, proven to open
   * again before it is offered: the page deletes the legacy row once this one
   * is saved, so a wrap that could not reopen would cost the user their
   * password. Any failure yields nothing, and the next unlock tries again.
   */
  async function upgradePassphraseWrap(
    accountKey: Bytes,
    passphrase: string,
    userId: string,
  ): Promise<MintedWrap | undefined> {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)) as Bytes
      const wrap = await wrapWithPassphrase({ accountKey, passphrase, salt, userId })
      const reopened = await unwrapWithPassphrase({ wrap, passphrase, userId })
      const same =
        reopened.length === accountKey.length &&
        reopened.every((byte, index) => byte === accountKey[index])
      zeroBytes(reopened)
      if (!same) return undefined
      return mintedPassphraseWrap(wrap)
    } catch {
      return undefined
    }
  }

  /**
   * Re-open the session from the handles the last unlock persisted, with no
   * secret. The page passes the SERVER's keyring: every entry must have its
   * handles stored under that entry's own public key, so a keyring that was
   * reset or rotated elsewhere misses and the user unlocks once more.
   *
   * The handles open only under a live lease for this same user and
   * organisation (spec 3.3 step 4). An expired lease is deleted on the spot,
   * and a restore that succeeds moves the lease to the login's current expiry.
   */
  async function restore(request: RestoreRequest): Promise<boolean> {
    const lease = request.lease
    if (state) {
      return (
        state.userId === request.userId &&
        (!lease || state.orgId === null || state.orgId === lease.orgId)
      )
    }
    if (!lease?.orgId || request.keyring.length === 0) return false
    const { orgId } = lease
    const userId = request.userId
    // One login per browser origin: whatever another identity left here is a
    // session that has ended (a user switch), and it goes before anything opens.
    if (lease.exclusive) await forgetEveryoneBut(orgId, userId)
    const stored = await readLease(orgId, userId)
    if (!stored) return false
    if (stored.expiresAt <= now() || lease.expiresAt <= now()) {
      await forgetOwner(orgId, userId)
      return false
    }
    const identities = new Map<
      number,
      { ecdhPrivate: CryptoKey; signPrivate: CryptoKey; ecdhSpki: Bytes }
    >()
    for (const payload of request.keyring) {
      const ecdhSpki = base64ToBytes(payload.ecdhSpki)
      const tag = await fingerprint([ecdhSpki])
      const ecdhPrivate = await loadOwned(stored, storeId(orgId, userId, tag, "ecdh"))
      const signPrivate = await loadOwned(stored, storeId(orgId, userId, tag, "sign"))
      if (!ecdhPrivate || !signPrivate) return false
      identities.set(payload.keyId, { ecdhPrivate, signPrivate, ecdhSpki })
    }
    const accountKeyHkdf = await loadOwned(
      stored,
      storeId(orgId, userId, await keyringFingerprint(request.keyring), "hkdf"),
    )
    if (!accountKeyHkdf) return false
    state = {
      userId,
      orgId,
      identities,
      accountKeyHkdf,
      activeKeyId: activeKeyIdOf(request.keyring),
      accountKeyBytes: null,
      lastActivity: now(),
    }
    await writeLease({ ...stored, expiresAt: lease.expiresAt })
    return true
  }

  /** A handle the lease lists, and only one it lists. */
  async function loadOwned(lease: StoredLease, id: string): Promise<CryptoKey | null> {
    if (!lease.ids.includes(id)) return null
    return loadPersistedKey(deps.keyStore, id)
  }

  async function readLease(orgId: string, userId: string): Promise<StoredLease | null> {
    try {
      const value = await deps.keyStore.get(leaseId(orgId, userId))
      return isStoredLease(value, orgId, userId) ? value : null
    } catch {
      return null
    }
  }

  async function writeLease(lease: StoredLease): Promise<boolean> {
    try {
      await deps.keyStore.put(leaseId(lease.orgId, lease.userId), lease)
      const back = await deps.keyStore.get(leaseId(lease.orgId, lease.userId))
      return isStoredLease(back, lease.orgId, lease.userId) && back.expiresAt === lease.expiresAt
    } catch {
      return false
    }
  }

  /** Delete one identity's records: its lease, every id it lists, and strays under its prefix. */
  async function forgetOwner(orgId: string, userId: string): Promise<void> {
    const lease = await readLease(orgId, userId)
    const ids = new Set(lease?.ids ?? [])
    ids.add(leaseId(orgId, userId))
    const prefix = ownerPrefix(orgId, userId)
    for (const id of await storedIds()) if (id.startsWith(prefix)) ids.add(id)
    await wipePersistedKeys(deps.keyStore, [...ids])
  }

  /**
   * Delete every record that does not belong to this identity. A store that
   * cannot list its records is wiped whole, which costs this identity nothing
   * more than the write that follows.
   */
  async function forgetEveryoneBut(orgId: string, userId: string): Promise<void> {
    if (!deps.keyStore.keys) {
      const keep = await readLease(orgId, userId)
      if (!keep) await wipePersistedKeys(deps.keyStore)
      return
    }
    const prefix = ownerPrefix(orgId, userId)
    const others = (await storedIds()).filter((id) => !id.startsWith(prefix))
    await wipePersistedKeys(deps.keyStore, others)
  }

  /**
   * Delete what no live lease covers: other identities whose login has ended,
   * handles a cut-short write left without a lease, and the records of the
   * format before leases existed. Live leases of other identities stay (a
   * desktop or phone shell keeps one login per saved server).
   */
  async function pruneUnleased(): Promise<void> {
    if (!deps.keyStore.keys) return
    const all = await storedIds()
    const keep = new Set<string>()
    for (const id of all) {
      if (!id.endsWith(":lease")) continue
      const value = await deps.keyStore.get(id).catch(() => undefined)
      const lease = value as Partial<StoredLease> | undefined
      if (!lease?.orgId || !lease.userId || leaseId(lease.orgId, lease.userId) !== id) continue
      if (!isStoredLease(value, lease.orgId, lease.userId) || value.expiresAt <= now()) continue
      keep.add(id)
      for (const owned of value.ids) keep.add(owned)
    }
    await wipePersistedKeys(
      deps.keyStore,
      all.filter((id) => !keep.has(id)),
    )
  }

  async function storedIds(): Promise<string[]> {
    try {
      return (await deps.keyStore.keys?.()) ?? []
    } catch {
      return []
    }
  }

  async function extendLease(request: ExtendLeaseRequest): Promise<boolean> {
    const stored = await readLease(request.orgId, request.userId)
    if (!stored) return false
    if (stored.expiresAt <= now() || request.expiresAt <= now()) {
      await forgetOwner(request.orgId, request.userId)
      return false
    }
    return writeLease({ ...stored, expiresAt: request.expiresAt })
  }

  async function persistSession(
    userId: string,
    keyring: readonly KeyringEntryPayload[],
    current: UnlockedState,
    lease: DeviceLeaseRequest | undefined,
  ): Promise<boolean> {
    // No lease, no persistence: a handle that outlives the login it was
    // unlocked under is exactly what the lease exists to prevent.
    if (!lease?.orgId || lease.expiresAt <= now()) return false
    const { orgId } = lease
    if (lease.exclusive) {
      // One login per browser origin: whatever an earlier unlock left (another
      // user, another organisation, another keyring) goes first.
      await wipePersistedKeys(deps.keyStore)
    } else {
      await forgetOwner(orgId, userId)
      await pruneUnleased()
    }
    const writes: Array<[string, CryptoKey]> = [
      [storeId(orgId, userId, await keyringFingerprint(keyring), "hkdf"), current.accountKeyHkdf],
    ]
    for (const identity of current.identities.values()) {
      const tag = await fingerprint([identity.ecdhSpki])
      writes.push([storeId(orgId, userId, tag, "ecdh"), identity.ecdhPrivate])
      writes.push([storeId(orgId, userId, tag, "sign"), identity.signPrivate])
    }
    const ids = writes.map(([id]) => id)
    for (const [id, key] of writes) {
      const result = await persistKey(deps.keyStore, id, key)
      if (!result.persisted) {
        await wipePersistedKeys(deps.keyStore, ids)
        return false
      }
    }
    if (!(await writeLease({ v: 1, userId, orgId, expiresAt: lease.expiresAt, ids }))) {
      await wipePersistedKeys(deps.keyStore, [...ids, leaseId(orgId, userId)])
      return false
    }
    return true
  }

  async function openMessage(
    sealed: SealedMessagePayload,
    options?: OpenOptions,
  ): Promise<OpenedMessage> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const identity = current.identities.get(sealed.encKeyId)
    if (!identity) {
      throw new MailboxCryptoError(
        MAILBOX_KEYRING_UNAVAILABLE,
        `this keyring has no key id ${sealed.encKeyId}`,
      )
    }
    const contentKey = await unsealContentKey({
      privateKey: identity.ecdhPrivate,
      recipientEcdhSpki: identity.ecdhSpki,
      userId: current.userId,
      keyId: sealed.encKeyId,
      wrapped: base64ToBytes(sealed.contentKeyWrapped),
      epkSpki: base64ToBytes(sealed.contentKeyEpk),
    })

    const keys: Record<string, string> | null = options?.withFieldKeys ? {} : null
    const open = (
      blob: string | null | undefined,
      context: MailboxAadContext,
      field: string,
    ): Promise<string | null> => openTextField(contentKey, blob, context, keys, field)

    const id = sealed.id
    const opened: OpenedMessage = {
      id,
      subject: await open(sealed.subjectCiphertext, mailboxAad.messageSubject(id), "subject"),
      textBody: await open(sealed.textBodyCiphertext, mailboxAad.messageTextBody(id), "textBody"),
      htmlBody: await open(sealed.htmlBodyCiphertext, mailboxAad.messageHtmlBody(id), "htmlBody"),
      snippet: await open(sealed.snippetCiphertext, mailboxAad.messageSnippet(id), "snippet"),
    }
    if (sealed.rawHeadersCiphertext) {
      opened.rawHeaders = await open(
        sealed.rawHeadersCiphertext,
        mailboxAad.messageHeaders(id),
        "rawHeaders",
      )
    }
    if (keys) opened.fieldKeys = keys
    current.lastActivity = now()
    return opened
  }

  async function openConversation(
    sealed: SealedConversationPayload,
    options?: OpenOptions,
  ): Promise<OpenedConversation> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const identity = current.identities.get(sealed.encKeyId)
    if (!identity) {
      throw new MailboxCryptoError(
        MAILBOX_KEYRING_UNAVAILABLE,
        `this keyring has no key id ${sealed.encKeyId}`,
      )
    }
    const contentKey = await unsealContentKey({
      privateKey: identity.ecdhPrivate,
      recipientEcdhSpki: identity.ecdhSpki,
      userId: current.userId,
      keyId: sealed.encKeyId,
      wrapped: base64ToBytes(sealed.contentKeyWrapped),
      epkSpki: base64ToBytes(sealed.contentKeyEpk),
    })
    const keys: Record<string, string> | null = options?.withFieldKeys ? {} : null
    const open = (
      blob: string | null | undefined,
      context: MailboxAadContext,
      field: string,
    ): Promise<string | null> => openTextField(contentKey, blob, context, keys, field)
    // A pointer row carries a message's own bytes, so it opens under that
    // message's contexts; a row sealed on its own opens under the
    // conversation's. Either way the AAD binds the id, so a wrong claim fails.
    const source = sealed.sourceMessageId
    const opened: OpenedConversation = {
      id: sealed.id,
      subject: await open(
        sealed.subjectCiphertext,
        source ? mailboxAad.messageSubject(source) : mailboxAad.conversationSubject(sealed.id),
        "subject",
      ),
      snippet: await open(
        sealed.snippetCiphertext,
        source ? mailboxAad.messageSnippet(source) : mailboxAad.conversationSnippet(sealed.id),
        "snippet",
      ),
    }
    if (keys) opened.fieldKeys = keys
    current.lastActivity = now()
    return opened
  }

  async function openApprovalDraft(
    sealed: SealedApprovalDraft,
    options?: OpenOptions,
  ): Promise<OpenedApprovalDraft> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const identity = current.identities.get(sealed.encKeyId)
    if (!identity) {
      throw new MailboxCryptoError(
        MAILBOX_KEYRING_UNAVAILABLE,
        `this keyring has no key id ${sealed.encKeyId}`,
      )
    }
    const contentKey = await unsealContentKey({
      privateKey: identity.ecdhPrivate,
      recipientEcdhSpki: identity.ecdhSpki,
      userId: current.userId,
      keyId: sealed.encKeyId,
      wrapped: base64ToBytes(sealed.contentKeyWrapped),
      epkSpki: base64ToBytes(sealed.contentKeyEpk),
    })
    const id = sealed.approvalRequestId
    const keys: Record<string, string> | null = options?.withFieldKeys ? {} : null
    const open = (
      blob: string | null | undefined,
      context: MailboxAadContext,
      field: string,
    ): Promise<string | null> => openTextField(contentKey, blob, context, keys, field)
    const opened: OpenedApprovalDraft = {
      approvalRequestId: id,
      subject: await open(sealed.subjectCiphertext, mailboxAad.draftSubject(id), "subject"),
      textBody: await open(sealed.bodyCiphertext, mailboxAad.draftBody(id), "textBody"),
      htmlBody: await open(
        sealed.htmlBodyCiphertext,
        mailboxAad.draftBody(`${id}:html`),
        "htmlBody",
      ),
      note: await open(sealed.noteCiphertext, mailboxAad.draftBody(`${id}:note`), "note"),
    }
    if (keys) opened.fieldKeys = keys
    current.lastActivity = now()
    return opened
  }

  /**
   * Blueprint Task 9.9. Opens a stored attachment whole, so its bytes can be put
   * back on the wire by a forward or a re-attach.
   *
   * WHOLE STREAM, deliberately. `decryptAttachmentStream` is the half that also
   * authenticates the chunk COUNT and the total length, so a truncated object is
   * an error here rather than a short file arriving at the recipient.
   * `decryptAttachmentChunks` (the range half) structurally cannot see a missing
   * tail, which makes it right for showing one page on screen and wrong for
   * sending. The AAD binds the file id, so the id passed here has to be the one
   * the bytes were sealed under, never a staged copy's.
   */
  async function openAttachment(
    sealed: SealedAttachmentPayload,
    options?: OpenOptions,
  ): Promise<OpenedAttachment> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const identity = current.identities.get(sealed.encKeyId)
    if (!identity) {
      throw new MailboxCryptoError(
        MAILBOX_KEYRING_UNAVAILABLE,
        `this keyring has no key id ${sealed.encKeyId}`,
      )
    }
    const contentKey = await unsealContentKey({
      privateKey: identity.ecdhPrivate,
      recipientEcdhSpki: identity.ecdhSpki,
      userId: current.userId,
      keyId: sealed.encKeyId,
      wrapped: base64ToBytes(sealed.contentKeyWrapped),
      epkSpki: base64ToBytes(sealed.contentKeyEpk),
    })
    const body = base64ToBytes(sealed.ciphertext)
    const parts: Bytes[] = []
    let total = 0
    for await (const piece of decryptAttachmentStream({
      contentKey,
      fileId: sealed.fileId,
      header: {
        version: sealed.encVersion,
        keyId: sealed.encKeyId,
        noncePrefix: base64ToBytes(sealed.noncePrefix),
        chunkSize: sealed.chunkSize,
        chunkCount: sealed.chunkCount,
        plaintextLength: sealed.plaintextLength,
      },
      chunks: splitStreamChunks(body, sealed.chunkSize, sealed.chunkCount),
    })) {
      parts.push(piece)
      total += piece.byteLength
    }
    const out = new Uint8Array(total) as Bytes
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    const opened: OpenedAttachment = { fileId: sealed.fileId, bytesBase64: bytesToBase64(out) }
    if (options?.withFieldKeys) {
      // The stream's D5 subkey: the server re-seals these bytes under it and
      // writes them only when they reproduce the stored object.
      const context = mailboxAad.attachment(sealed.fileId)
      const subkey = await deriveFieldSubkey({
        contentKey,
        fieldName: context.fieldName,
        entityId: context.entityId,
      })
      opened.fieldKey = bytesToBase64(subkey)
      subkey.fill(0)
    }
    current.lastActivity = now()
    return opened
  }

  /**
   * D7 is derived per shard, so one shard's key opens exactly one shard, and
   * the AAD binds the same pair. The derived bytes are zeroed before the call
   * returns: an index key is a mailbox-wide secret and this session already
   * holds enough.
   */
  async function withIndexKey<T>(
    shardId: string,
    body: (indexKey: Bytes, current: UnlockedState) => Promise<T>,
  ): Promise<T> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const indexKey = await deriveIndexKey({
      accountKey: current.accountKeyHkdf,
      userId: current.userId,
      shardId,
    })
    try {
      const result = await body(indexKey as Bytes, current)
      current.lastActivity = now()
      return result
    } finally {
      zeroBytes(indexKey)
    }
  }

  async function sealIndexShard(shardId: string, plaintext: string): Promise<string> {
    return withIndexKey(shardId, async (indexKey, current) =>
      bytesToBase64(
        await sealField({
          contentKey: indexKey,
          context: mailboxAad.index(current.userId, shardId),
          keyId: current.activeKeyId,
          plaintext: encodeUtf8(plaintext),
        }),
      ),
    )
  }

  async function openIndexShard(shardId: string, blob: string): Promise<string> {
    return withIndexKey(shardId, async (indexKey, current) =>
      decodeUtf8(
        await openField({
          contentKey: indexKey,
          context: mailboxAad.index(current.userId, shardId),
          blob: base64ToBytes(blob),
        }),
      ),
    )
  }

  /**
   * Verification, never opening. A row that unwraps is reported as opening and
   * its content key is dropped on the spot; nothing here can return plaintext,
   * which is why a per-sync sweep over every new row is not a decryption
   * oracle for the page.
   */
  async function verifySeals(rows: readonly SealedMessagePayload[]): Promise<SealVerdict[]> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const verdicts: SealVerdict[] = []
    for (const row of rows) {
      const sealed =
        row.encVersion === MAILBOX_ENC_VERSION &&
        row.contentKeyWrapped.length > 0 &&
        row.contentKeyEpk.length > 0
      if (!sealed) {
        verdicts.push({ id: row.id, sealed: false, opens: false, keyId: row.encKeyId })
        continue
      }
      const identity = current.identities.get(row.encKeyId)
      if (!identity) {
        verdicts.push({ id: row.id, sealed: true, opens: false, keyId: row.encKeyId })
        continue
      }
      try {
        await unsealContentKey({
          privateKey: identity.ecdhPrivate,
          recipientEcdhSpki: identity.ecdhSpki,
          userId: current.userId,
          keyId: row.encKeyId,
          wrapped: base64ToBytes(row.contentKeyWrapped),
          epkSpki: base64ToBytes(row.contentKeyEpk),
        })
        verdicts.push({ id: row.id, sealed: true, opens: true, keyId: row.encKeyId })
      } catch {
        // Any failure at all is a negative verdict. The thrown error is not
        // read: an unwrap failure has exactly one meaning here, and its text
        // can carry fragments of what failed.
        verdicts.push({ id: row.id, sealed: true, opens: false, keyId: row.encKeyId })
      }
    }
    current.lastActivity = now()
    return verdicts
  }

  /**
   * Sign the migration acknowledgement of spec section 7 step 6.
   *
   * It lives in the worker because the Ed25519 identity private key does, and
   * for one more reason: `userId` and `keyId` are inside the signed bytes and
   * are taken from the SESSION, never from the page. A page that could name
   * either could have this mailbox's key sign a statement about a different
   * user or a retired key id.
   *
   * It signs under the ACTIVE key id. Signing under a retired one would be a
   * silent downgrade, exactly as sealing under one would be.
   *
   * The bytes are assembled by `encodeAckStatement` in the shared crypto
   * package, which is the same encoder the server recomputes with. Never
   * assemble them here.
   */
  async function signAckStatement(statement: MailboxAckRequest): Promise<MailboxAckSigned> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const identity = current.identities.get(current.activeKeyId)
    if (!identity) throw new MailboxCryptoError(MAILBOX_KEYRING_UNAVAILABLE, "no active identity")
    const signature = await signAck(identity.signPrivate, {
      userId: current.userId,
      accountId: statement.accountId,
      keyId: current.activeKeyId,
      nonce: statement.nonce,
      count: statement.count,
      idSetDigest: base64ToBytes(statement.idSetDigest),
      backfillCursor: statement.backfillCursor,
    })
    current.lastActivity = now()
    return { keyId: current.activeKeyId, signature: bytesToBase64(signature as Bytes) }
  }

  async function ledgerMac(statements: readonly string[]): Promise<string[]> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const macKeyBytes = await deriveLedgerMacKey({
      accountKey: current.accountKeyHkdf,
      userId: current.userId,
    })
    try {
      const macKey = await crypto.subtle.importKey(
        "raw",
        macKeyBytes as Bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const macs: string[] = []
      for (const statement of statements) {
        macs.push(
          bytesToBase64(
            new Uint8Array(
              await crypto.subtle.sign("HMAC", macKey, encodeUtf8(statement)),
            ) as Bytes,
          ),
        )
      }
      current.lastActivity = now()
      return macs
    } finally {
      zeroBytes(macKeyBytes as Bytes)
    }
  }

  async function mintWrap(request: MintWrapRequest): Promise<MintedWrap> {
    if (await expireIfIdle()) throw new MailboxCryptoError(MAILBOX_LOCKED)
    const current = requireUnlocked()
    const accountKey = current.accountKeyBytes
    if (!accountKey) {
      throw new MailboxCryptoError(
        MAILBOX_LOCKED,
        "this session cannot add an unlock method: unlock again first",
      )
    }
    current.lastActivity = now()
    if (request.kind === "passphrase") {
      const salt = crypto.getRandomValues(new Uint8Array(16)) as Bytes
      const wrap = await wrapWithPassphrase({
        accountKey,
        passphrase: request.passphrase,
        salt,
        userId: current.userId,
      })
      return mintedPassphraseWrap(wrap)
    }
    const prfSecret = base64ToBytes(request.prfSecret)
    const credentialId = base64ToBytes(request.credentialId)
    const salt = base64ToBytes(request.salt)
    const wrap = await wrapWithPrfSecret({
      accountKey,
      prfSecret,
      salt,
      userId: current.userId,
      credentialId,
    })
    let reproduced: Bytes
    try {
      reproduced = await unwrapWithPrfSecret({ wrap, prfSecret, userId: current.userId })
    } catch {
      throw new MailboxCryptoError(
        MAILBOX_DEVICE_PRF_MISMATCH,
        "this passkey wrap could not be reproduced, so it was not saved",
      )
    }
    const same =
      reproduced.length === accountKey.length &&
      reproduced.every((byte, index) => byte === accountKey[index])
    zeroBytes(reproduced)
    zeroBytes(prfSecret)
    if (!same) {
      throw new MailboxCryptoError(
        MAILBOX_DEVICE_PRF_MISMATCH,
        "this passkey wrap could not be reproduced, so it was not saved",
      )
    }
    return {
      wrapType: "passkey_prf",
      wrappedAccountKey: bytesToBase64(wrap.wrappedAccountKey),
      kdfParams: { salt: request.salt, credentialId: request.credentialId },
    }
  }

  function endMinting(): void {
    if (!state?.accountKeyBytes) return
    zeroBytes(state.accountKeyBytes)
    state.accountKeyBytes = null
  }

  async function expireIfIdle(): Promise<boolean> {
    if (!state) return false
    if (now() - state.lastActivity < idleMs) return false
    await dropState()
    return true
  }

  return {
    unlock,
    restore,
    extendLease,
    openMessage,
    openConversation,
    openApprovalDraft,
    openAttachment,
    lock: dropState,
    isUnlocked: () => state !== null,
    sealIndexShard,
    openIndexShard,
    verifySeals,
    signAck: signAckStatement,
    mintWrap,
    endMinting,
    ledgerMac,
    expireIfIdle,
    idleTimeoutMs: () => idleMs,
    setIdleTimeoutMs(ms: number) {
      idleMs = clampIdleTimeoutMs(ms)
    },
    holdsAccountKeyBytes: () => state?.accountKeyBytes !== null && state !== null,
    inspectHandlesForTest() {
      if (!state) return []
      const handles: CryptoKey[] = [state.accountKeyHkdf]
      for (const identity of state.identities.values()) {
        handles.push(identity.ecdhPrivate, identity.signPrivate)
      }
      return handles
    },
  }
}
