// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The message protocol between the page and the crypto Web Worker.
//
// Everything on the wire here is base64 or plain strings: the page never holds
// a key handle and never holds raw key bytes, so nothing in this file names a
// `CryptoKey`. The one direction that carries plaintext is worker to page, and
// only for a field the user is about to read on screen.

/**
 * The wrap types a server listing can carry. `recovery_phrase` is legacy: rows
 * enrolled before the phrase was retired still exist, but nothing offers,
 * generates or unlocks with one any more.
 */
export type MailboxUnlockMethod = "passkey_prf" | "recovery_phrase" | "passphrase"

/** The unlock methods the product actually uses: a passkey, or the mailbox password. */
export type MailboxUnlockSecretMethod = "passkey_prf" | "passphrase"

/**
 * A new unlock method, minted in the worker from the Account Key of the session
 * that is open right now. Only possible after an unlock with `mintWraps: true`.
 * The page supplies the new secret; the Account Key never leaves the worker.
 */
export type MintWrapRequest =
  | { kind: "passphrase"; passphrase: string }
  | {
      kind: "passkey_prf"
      /** Base64 PRF output of this device's authenticator. */
      prfSecret: string
      /** Base64 WebAuthn credential id. */
      credentialId: string
      /** Base64 PRF salt the secret was evaluated under. */
      salt: string
    }

/**
 * A wrap row's KDF parameters as the REST surface stores them. `salt` always,
 * base64; `credentialId` for a passkey wrap; `kdf` and `iterations` for a
 * passphrase wrap minted with PBKDF2. A passphrase row with no `kdf` is legacy
 * (Argon2id).
 */
export type WrapKdfParamsPayload = {
  salt: string
  credentialId?: string
  kdf?: "pbkdf2-sha256"
  iterations?: number
}

/** The minted wrap, base64, in the shape the `POST /mailbox-keys/wraps` route takes. */
export interface MintedWrap {
  wrapType: MailboxUnlockSecretMethod
  wrappedAccountKey: string
  kdfParams: WrapKdfParamsPayload
}

/** A wrapped Account Key as the REST surface returns it. */
export interface WrapBlobPayload {
  id: string
  wrapType: MailboxUnlockMethod
  wrappedAccountKey: string
  kdfParams: WrapKdfParamsPayload | null
  verifier?: string | null
}

/** One key id of the identity keyring, public halves plus wrapped privates. */
export interface KeyringEntryPayload {
  keyId: number
  status: "active" | "retired"
  ecdhSpki: string
  signSpki: string
  wrappedEcdhPrivate: string
  wrappedSignPrivate: string
  ecdhWrapIv: string
  signWrapIv: string
}

/** A sealed row exactly as the mail API projects it. All bytea are base64. */
export interface SealedMessagePayload {
  id: string
  encVersion: number
  encKeyId: number
  contentKeyWrapped: string
  contentKeyEpk: string
  subjectCiphertext?: string | null
  textBodyCiphertext?: string | null
  htmlBodyCiphertext?: string | null
  snippetCiphertext?: string | null
  /** The sealed extra headers, when the caller needs them (making a mailbox transparent). */
  rawHeadersCiphertext?: string | null
}

/**
 * A conversation row's sealed half, as the conversation LIST projects it.
 *
 * Two shapes exist. A row sealed on its own (the backfill) has its own content
 * key and is bound to the CONVERSATION id under the conversation contexts. A
 * row kept current by ingest holds a verbatim COPY of one message's subject and
 * snippet ciphertext and key material (`pointConversationAtMessage`), bound to
 * that message's id under the message contexts; `sourceMessageId` names it.
 */
export interface SealedConversationPayload {
  id: string
  /** The message whose ciphertext this row copies, when it is a pointer. */
  sourceMessageId?: string | null
  encVersion: number
  encKeyId: number
  contentKeyWrapped: string
  contentKeyEpk: string
  subjectCiphertext?: string | null
  snippetCiphertext?: string | null
}

export interface OpenedConversation {
  id: string
  subject: string | null
  snippet: string | null
  /** Only when asked (`withFieldKeys`): see `OpenOptions`. */
  fieldKeys?: Record<string, string>
}

/**
 * One row's verdict from the downgrade detector (spec section 9.2). It carries
 * no plaintext and no key material: the check unwraps the CONTENT KEY and stops
 * there, so it costs one ECDH plus one AES-KW per row and never decrypts a body.
 *
 * `sealed` is the cheap half (`enc_version` and both wrap columns present) and
 * proves nothing on its own, because the server writes those values. `opens` is
 * the half that matters: the content key actually unwrapped under a private key
 * from this device's keyring, which the D1 binding makes a real check of
 * recipient identity, key id and both public keys.
 */
export interface SealVerdict {
  id: string
  sealed: boolean
  opens: boolean
  keyId: number
}

/**
 * The sealed halves of a gated mail send's approval payload (blueprint Task 9.8).
 *
 * It is NOT a `SealedMessagePayload` and must not be opened as one: the AAD binds
 * these blobs to the APPROVAL REQUEST id under the draft contexts, so a body
 * sealed for one approval cannot be opened as another's, nor as a message field.
 */
export interface SealedApprovalDraft {
  approvalRequestId: string
  encVersion: number
  encKeyId: number
  contentKeyWrapped: string
  contentKeyEpk: string
  subjectCiphertext?: string | null
  bodyCiphertext?: string | null
  htmlBodyCiphertext?: string | null
  noteCiphertext?: string | null
}

export interface OpenedApprovalDraft {
  approvalRequestId: string
  subject: string | null
  textBody: string | null
  htmlBody: string | null
  note: string | null
  /** Only when asked (`withFieldKeys`): see `OpenOptions`. */
  fieldKeys?: Record<string, string>
}

/**
 * A sealed attachment as `GET /api/files/:id/metadata` describes it, plus the
 * stored object itself (blueprint Task 9.9, spec section 3.5).
 *
 * WHOLE FILE, not a range. A range read authenticates every chunk it sees but
 * structurally cannot notice a missing tail, and this payload exists so an
 * attachment can be RE-SENT: a forward that silently drops the last chunk of a
 * contract is exactly the failure this feature must not introduce. Ranges stay
 * the right shape for showing one page of a PDF on screen; they are the wrong
 * shape for putting bytes back on the wire.
 */
export interface SealedAttachmentPayload {
  /** The `kernel.files` id. Bound into every chunk's AAD, so it must be the
   *  id the bytes were SEALED under, never a staged copy's id. */
  fileId: string
  encVersion: number
  encKeyId: number
  contentKeyWrapped: string
  contentKeyEpk: string
  chunkSize: number
  chunkCount: number
  plaintextLength: number
  /** Base64, seven bytes. */
  noncePrefix: string
  /** The whole stored object, base64: `chunkCount` chunks of plaintext||tag. */
  ciphertext: string
}

export interface OpenedAttachment {
  fileId: string
  /** The plaintext bytes, base64. */
  bytesBase64: string
  /** Only when asked (`withFieldKeys`): the file's base64 D5 subkey, see `OpenOptions`. */
  fieldKey?: string
}

export interface OpenedMessage {
  id: string
  subject: string | null
  textBody: string | null
  htmlBody: string | null
  snippet: string | null
  /** Only when the payload carried `rawHeadersCiphertext`: the JSON text. */
  rawHeaders?: string | null
  /** Only when asked (`withFieldKeys`): see `OpenOptions`. */
  fieldKeys?: Record<string, string>
}

/**
 * `withFieldKeys`: also return, per opened field, the base64 D5 subkey it was
 * opened with. Only making a mailbox transparent asks for them: the server
 * writes a row's plaintext only when it re-seals to the stored blob under that
 * subkey, so a session that cannot open the mailbox cannot invent its content.
 * A subkey opens that one field of that one row and nothing else, and the
 * plaintext it covers is being handed to the server in the same request. An
 * attachment opened this way returns its stream's subkey (`fieldKey`), which
 * the server checks the same way, chunk by chunk.
 */
export interface OpenOptions {
  withFieldKeys?: boolean
}

export interface UnlockRequest {
  userId: string
  method: MailboxUnlockSecretMethod
  /** The mailbox password text, or a base64 PRF secret. */
  secret: string
  wrap: WrapBlobPayload
  keyring: KeyringEntryPayload[]
  /**
   * True only for a session that will mint new wraps (adding an unlock method).
   * It keeps the Account Key bytes alive for the unlock window; every other
   * session zeroes them the moment the handles it needs exist (spec 3.3 step 3).
   */
  mintWraps?: boolean
  /** The device lease the handles are persisted under. Without one, nothing is. */
  lease?: DeviceLeaseRequest
}

/**
 * How long, and for whom, this device keeps the unlocked mailbox (spec 3.3
 * step 4): "the unlock lives as long as the login does". The handles are kept
 * under the signed-in user AND organisation, and only until the login session
 * (the refresh token) ends. Every token renewal moves `expiresAt` forward.
 */
export interface DeviceLeaseRequest {
  orgId: string
  /** Epoch milliseconds at which the login session's refresh token expires. */
  expiresAt: number
  /**
   * True in a browser, where one origin holds one login at a time: any other
   * identity's handles on this device belong to a session that has ended, and
   * go. False in a desktop or phone shell, which keeps one login per saved
   * server and must not make one server's unlock cost another's.
   */
  exclusive: boolean
}

/** Re-open a session from this device's persisted handles, no secret. */
export interface RestoreRequest {
  userId: string
  /** The SERVER's keyring: stored handles must match every entry of it. */
  keyring: KeyringEntryPayload[]
  /** The current login's lease. Without one, nothing is restored. */
  lease?: DeviceLeaseRequest
}

/** A token renewal: the same login, now valid until `expiresAt`. */
export interface ExtendLeaseRequest {
  userId: string
  orgId: string
  expiresAt: number
}

export type UnlockPrompting = "restored-from-store" | "re-prompt-each-session"

export interface UnlockResult {
  unlocked: true
  prompting: UnlockPrompting
  /** Named so the settings page can state which mode the session is in. */
  holdsAccountKeyBytes: boolean
  /**
   * Set when a mailbox password unlocked a LEGACY (Argon2id) row: the same
   * Account Key, re-wrapped under the same password with PBKDF2, already
   * proven to open again. The page saves it and then deletes the legacy row,
   * in that order, so a failure never leaves the user without a password row.
   */
  upgradedWrap?: MintedWrap
}

/**
 * The refusal codes the UI branches on. They are codes, not sentences, so a
 * copy change cannot change a control flow, and none of them says "corrupt" or
 * "data loss": a wrap that does not open is a wrong secret or a device whose
 * passkey PRF output does not match, never damaged mail (spec 3.2).
 */
export const MAILBOX_LOCKED = "MAILBOX_LOCKED"
export const MAILBOX_UNLOCK_REFUSED = "MAILBOX_UNLOCK_REFUSED"
export const MAILBOX_DEVICE_PRF_MISMATCH = "MAILBOX_DEVICE_PRF_MISMATCH"
export const MAILBOX_KEYRING_UNAVAILABLE = "MAILBOX_KEYRING_UNAVAILABLE"
/**
 * The passkey prompt did not complete (cancelled, refused by the platform, or
 * no PRF output), so nothing was checked. Not a mismatch: the passkey may be
 * fine, and this device keeps offering it. Set by the page, never the worker.
 */
export const MAILBOX_PASSKEY_CEREMONY_FAILED = "MAILBOX_PASSKEY_CEREMONY_FAILED"
/**
 * A mailbox password row in the legacy format, met in a build that cannot open
 * it (the native mobile app). Not a wrong password: one unlock on a computer
 * converts the row, and a passkey works meanwhile.
 */
export const MAILBOX_PASSWORD_FORMAT_UNSUPPORTED = "MAILBOX_PASSWORD_FORMAT_UNSUPPORTED"

/**
 * The unlock could not RUN: the runtime refused a step (a WebAssembly compile
 * blocked by a policy, memory, a primitive this engine lacks). The secret was
 * never checked, so saying "wrong password" here would send the user to a reset
 * they do not need.
 */
export const MAILBOX_RUNTIME_FAILED = "MAILBOX_RUNTIME_FAILED"
/**
 * A refusal met while this device still holds the keyring from BEFORE a reset
 * made elsewhere: the password typed is almost certainly the old one. Set by
 * the page, never by the worker.
 */
export const MAILBOX_RESET_ELSEWHERE = "MAILBOX_RESET_ELSEWHERE"

export type MailboxErrorCode =
  | typeof MAILBOX_LOCKED
  | typeof MAILBOX_UNLOCK_REFUSED
  | typeof MAILBOX_DEVICE_PRF_MISMATCH
  | typeof MAILBOX_KEYRING_UNAVAILABLE
  | typeof MAILBOX_PASSKEY_CEREMONY_FAILED
  | typeof MAILBOX_PASSWORD_FORMAT_UNSUPPORTED
  | typeof MAILBOX_RUNTIME_FAILED
  | typeof MAILBOX_RESET_ELSEWHERE

export class MailboxCryptoError extends Error {
  readonly code: MailboxErrorCode
  constructor(code: MailboxErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code)
    this.name = "MailboxCryptoError"
    this.code = code
  }
}

/**
 * The request bodies, WITHOUT the correlation id.
 *
 * The id is intersected in below rather than repeated on every member, because
 * the page builds a body and the transport stamps the id on. Writing the union
 * with the id inline forced callers to type themselves as `Omit<WorkerRequest,
 * "id">`, and `Omit` over a union collapses to the properties the members share
 * (`op` alone), which silently erased every payload field. Keeping the two
 * halves separate is what makes a body a checkable type on its own.
 */
/**
 * The migration acknowledgement the client-verified sweep signs (spec section 7
 * step 6).
 *
 * `userId` and `keyId` are DELIBERATELY absent: the worker fills both from the
 * unlocked session. They are inside the signed bytes, so letting the page name
 * either would let a compromised page sign a statement about another user or
 * another key id with this mailbox's key.
 */
export interface MailboxAckRequest {
  accountId: string
  nonce: string
  count: number
  /** Base64 of the 32 raw digest bytes over the covered id set. */
  idSetDigest: string
  backfillCursor: string
}

/** The signature, plus the key id the worker actually signed under. */
export interface MailboxAckSigned {
  keyId: number
  signature: string
}

export type WorkerRequestBody =
  | { op: "unlock"; request: UnlockRequest }
  | { op: "restore"; request: RestoreRequest }
  | { op: "extendLease"; request: ExtendLeaseRequest }
  | { op: "openMessage"; sealed: SealedMessagePayload; options?: OpenOptions }
  | { op: "openConversation"; sealed: SealedConversationPayload; options?: OpenOptions }
  | { op: "openApprovalDraft"; sealed: SealedApprovalDraft; options?: OpenOptions }
  | { op: "openAttachment"; sealed: SealedAttachmentPayload; options?: OpenOptions }
  | { op: "sealIndexShard"; shardId: string; plaintext: string }
  | { op: "openIndexShard"; shardId: string; blob: string }
  | { op: "verifySeals"; rows: SealedMessagePayload[] }
  | { op: "ledgerMac"; statements: string[] }
  | { op: "signAck"; statement: MailboxAckRequest }
  | { op: "mintWrap"; request: MintWrapRequest }
  | { op: "endMinting" }
  | { op: "lock" }
  | { op: "status" }
  | { op: "setIdleTimeout"; ms: number }

/** A body plus the correlation id the transport pairs the response with. */
export type WorkerRequest = WorkerRequestBody & { id: number }

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; code: MailboxErrorCode | "MAILBOX_INTERNAL"; message: string }

/** Idle wipe window: default two hours, configurable 15 minutes to 8 hours. */
/**
 * An unlock lasts as long as the login: logout (and an explicit lock) are what
 * close the mailbox, never a quiet tab.
 */
export const IDLE_TIMEOUT_DEFAULT_MS = Number.POSITIVE_INFINITY
export const IDLE_TIMEOUT_MIN_MS = 15 * 60 * 1000
export const IDLE_TIMEOUT_MAX_MS = 8 * 60 * 60 * 1000

export function clampIdleTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) return IDLE_TIMEOUT_DEFAULT_MS
  return Math.min(IDLE_TIMEOUT_MAX_MS, Math.max(IDLE_TIMEOUT_MIN_MS, Math.round(ms)))
}
