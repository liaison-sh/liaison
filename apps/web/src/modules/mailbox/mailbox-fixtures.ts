// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TEST FIXTURES ONLY. Imported by the mailbox and mail test files, never by a
// shipped component, so it never reaches the production bundle.
//
// It builds a real enrollment (real Account Key, real keyring, real wraps) and
// seals real messages with the SEAL SAFE half of the crypto package, the same
// half `apps/api` uses. The tests therefore exercise the actual seal to open
// round trip rather than a mock of it.

import {
  encryptAttachmentStream,
  generateContentKey,
  mailboxAad,
  sealContentKey,
  sealField,
} from "@liaison/mailbox-crypto"
import {
  type AccountKeyWrap,
  type Argon2idFn,
  generateAccountKey,
  generateIdentityKey,
  type KeyringEntry,
  type KeyStoreBackend,
  wrapWithLegacyPassphrase,
  wrapWithPassphrase,
  wrapWithPrfSecret,
} from "@liaison/mailbox-crypto/src/client"
import type {
  KeyringEntryPayload,
  SealedApprovalDraft,
  SealedAttachmentPayload,
  SealedConversationPayload,
  SealedMessagePayload,
  WrapBlobPayload,
} from "~/modules/mailbox/crypto-protocol"
import { type Bytes, bytesToBase64, encodeUtf8 } from "~/modules/mailbox/mailbox-bytes"

export const TEST_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

/**
 * A deterministic stand in for the LEGACY Argon2id. Tests inject it (the
 * session's `legacyKdf`) so a 64 MiB memory hard KDF does not run once per
 * case; the production default is the real one. New passphrase wraps use
 * PBKDF2 through WebCrypto, which is fast enough to run for real.
 */
export const fakeArgon2id: Argon2idFn = async (input) => {
  const material = new Uint8Array(input.password.length + input.salt.length)
  material.set(input.password, 0)
  material.set(input.salt, input.password.length)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material))
  return digest.subarray(0, input.hashLengthBytes) as Bytes
}

export interface TestKeyStore extends KeyStoreBackend {
  size(): number
}

export function memoryKeyStore(): TestKeyStore {
  // Plain records are copied in and out, as IndexedDB's structured clone does,
  // so a test cannot pass by mutating the object it wrote.
  const map = new Map<string, unknown>()
  const copy = (value: unknown) => (value instanceof CryptoKey ? value : structuredClone(value))
  return {
    async put(id, value) {
      map.set(id, copy(value))
    },
    async get(id) {
      return map.has(id) ? copy(map.get(id)) : undefined
    },
    async delete(id) {
      map.delete(id)
    },
    async clear() {
      map.clear()
    },
    async keys() {
      return [...map.keys()]
    },
    size: () => map.size,
  }
}

export interface TestEnrollment {
  userId: string
  accountKey: Bytes
  entry: KeyringEntry
  keyring: KeyringEntryPayload[]
  passphraseWrap: WrapBlobPayload
  passkeyWrap?: WrapBlobPayload
}

function wrapPayload(id: string, wrap: AccountKeyWrap): WrapBlobPayload {
  return {
    id,
    wrapType: wrap.wrapType,
    wrappedAccountKey: bytesToBase64(wrap.wrappedAccountKey),
    kdfParams: {
      salt: bytesToBase64(wrap.kdfParams.salt),
      ...(wrap.kdfParams.credentialId
        ? { credentialId: bytesToBase64(wrap.kdfParams.credentialId) }
        : {}),
      ...(wrap.kdfParams.kdf ? { kdf: wrap.kdfParams.kdf } : {}),
      ...(wrap.kdfParams.iterations !== undefined ? { iterations: wrap.kdfParams.iterations } : {}),
    },
    verifier: wrap.verifier ? bytesToBase64(wrap.verifier) : null,
  }
}

export function keyringPayload(entry: KeyringEntry): KeyringEntryPayload {
  return {
    keyId: entry.keyId,
    status: entry.status,
    ecdhSpki: bytesToBase64(entry.ecdhSpki),
    signSpki: bytesToBase64(entry.signSpki),
    wrappedEcdhPrivate: bytesToBase64(entry.wrappedEcdhPrivate),
    wrappedSignPrivate: bytesToBase64(entry.wrappedSignPrivate),
    ecdhWrapIv: bytesToBase64(entry.ecdhWrapIv),
    signWrapIv: bytesToBase64(entry.signWrapIv),
  }
}

export async function buildEnrollment(input: {
  passphrase: string
  userId?: string
  keyId?: number
  withPasskey?: { prfSecret: Bytes; credentialId: Bytes }
  /**
   * Mint the password row in the LEGACY format (Argon2id, here the fake), as
   * enrolments made before the PBKDF2 switch hold it.
   */
  legacyPassphrase?: boolean
}): Promise<TestEnrollment> {
  const userId = input.userId ?? TEST_USER_ID
  const keyId = input.keyId ?? 1
  const accountKey = generateAccountKey()
  const { entry } = await generateIdentityKey({ accountKey, userId, keyId })

  const passphraseInput = {
    accountKey,
    passphrase: input.passphrase,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    userId,
  }
  const passphraseWrap = input.legacyPassphrase
    ? await wrapWithLegacyPassphrase({ ...passphraseInput, legacyKdf: fakeArgon2id })
    : await wrapWithPassphrase(passphraseInput)
  const passkeyWrap = input.withPasskey
    ? await wrapWithPrfSecret({
        accountKey,
        prfSecret: input.withPasskey.prfSecret,
        salt: crypto.getRandomValues(new Uint8Array(16)),
        userId,
        credentialId: input.withPasskey.credentialId,
      })
    : undefined

  return {
    userId,
    accountKey,
    entry,
    keyring: [keyringPayload(entry)],
    passphraseWrap: wrapPayload("wrap-passphrase", passphraseWrap),
    passkeyWrap: passkeyWrap ? wrapPayload("wrap-passkey", passkeyWrap) : undefined,
  }
}

/** Seals one message exactly the way the server's seal service does. */
export async function sealMessageFixture(
  enrollment: TestEnrollment,
  message: { id: string; subject: string; textBody: string; htmlBody: string; snippet?: string },
): Promise<SealedMessagePayload> {
  const contentKey = generateContentKey()
  const sealed = await sealContentKey({
    recipientEcdhSpki: enrollment.entry.ecdhSpki,
    userId: enrollment.userId,
    keyId: enrollment.entry.keyId,
    contentKey,
  })
  const seal = async (value: string, context: ReturnType<typeof mailboxAad.messageSubject>) =>
    bytesToBase64(
      await sealField({
        contentKey,
        context,
        keyId: enrollment.entry.keyId,
        plaintext: encodeUtf8(value),
      }),
    )
  return {
    id: message.id,
    encVersion: 1,
    encKeyId: enrollment.entry.keyId,
    contentKeyWrapped: bytesToBase64(sealed.wrapped),
    contentKeyEpk: bytesToBase64(sealed.epkSpki),
    subjectCiphertext: await seal(message.subject, mailboxAad.messageSubject(message.id)),
    textBodyCiphertext: await seal(message.textBody, mailboxAad.messageTextBody(message.id)),
    htmlBodyCiphertext: await seal(message.htmlBody, mailboxAad.messageHtmlBody(message.id)),
    snippetCiphertext: message.snippet
      ? await seal(message.snippet, mailboxAad.messageSnippet(message.id))
      : null,
  }
}

/**
 * Seals one conversation row's subject and snippet in either shape the server
 * writes. Without `pointedAtMessageId` it is the backfill's own seal
 * (`MAILBOX_SEALED_FIELDS.conversations`), bound to the conversation id. With
 * it, it is what ingest leaves (`pointConversationAtMessage`): a copy of that
 * message's ciphertext, bound to the MESSAGE id under the message contexts.
 */
export async function sealConversationFixture(
  enrollment: TestEnrollment,
  conversation: { id: string; subject: string; snippet?: string; pointedAtMessageId?: string },
): Promise<SealedConversationPayload & { snippetSourceMessageId: string | null }> {
  const contentKey = generateContentKey()
  const sealed = await sealContentKey({
    recipientEcdhSpki: enrollment.entry.ecdhSpki,
    userId: enrollment.userId,
    keyId: enrollment.entry.keyId,
    contentKey,
  })
  const seal = async (value: string, context: ReturnType<typeof mailboxAad.conversationSubject>) =>
    bytesToBase64(
      await sealField({
        contentKey,
        context,
        keyId: enrollment.entry.keyId,
        plaintext: encodeUtf8(value),
      }),
    )
  const source = conversation.pointedAtMessageId
  return {
    id: conversation.id,
    encVersion: 1,
    encKeyId: enrollment.entry.keyId,
    contentKeyWrapped: bytesToBase64(sealed.wrapped),
    contentKeyEpk: bytesToBase64(sealed.epkSpki),
    subjectCiphertext: await seal(
      conversation.subject,
      source ? mailboxAad.messageSubject(source) : mailboxAad.conversationSubject(conversation.id),
    ),
    snippetCiphertext: conversation.snippet
      ? await seal(
          conversation.snippet,
          source
            ? mailboxAad.messageSnippet(source)
            : mailboxAad.conversationSnippet(conversation.id),
        )
      : null,
    snippetSourceMessageId: source ?? null,
  }
}

/**
 * A gated mail send's approval payload as `sealMailApprovalPayload` writes it
 * (blueprint Task 9.8). The AAD binds every part to the APPROVAL REQUEST id, not
 * to a message, which is what makes the blob openable under one approval and no
 * other.
 */
export async function sealApprovalDraftFixture(
  enrollment: TestEnrollment,
  draft: {
    approvalRequestId: string
    subject?: string
    textBody?: string
    htmlBody?: string
    note?: string
  },
): Promise<SealedApprovalDraft> {
  const contentKey = generateContentKey()
  const sealed = await sealContentKey({
    recipientEcdhSpki: enrollment.entry.ecdhSpki,
    userId: enrollment.userId,
    keyId: enrollment.entry.keyId,
    contentKey,
  })
  const seal = async (value: string, context: ReturnType<typeof mailboxAad.draftBody>) =>
    bytesToBase64(
      await sealField({
        contentKey,
        context,
        keyId: enrollment.entry.keyId,
        plaintext: encodeUtf8(value),
      }),
    )
  const id = draft.approvalRequestId
  return {
    approvalRequestId: id,
    encVersion: 1,
    encKeyId: enrollment.entry.keyId,
    contentKeyWrapped: bytesToBase64(sealed.wrapped),
    contentKeyEpk: bytesToBase64(sealed.epkSpki),
    subjectCiphertext: draft.subject
      ? await seal(draft.subject, mailboxAad.draftSubject(id))
      : null,
    bodyCiphertext: draft.textBody ? await seal(draft.textBody, mailboxAad.draftBody(id)) : null,
    htmlBodyCiphertext: draft.htmlBody
      ? await seal(draft.htmlBody, mailboxAad.draftBody(`${id}:html`))
      : null,
    noteCiphertext: draft.note ? await seal(draft.note, mailboxAad.draftBody(`${id}:note`)) : null,
  }
}

/**
 * Seals an attachment exactly the way the host does on the way into the object
 * store (`modules/mailbox-crypto/attachment-seal.ts`, spec section 5.8), and
 * returns it in the shape the metadata route plus the stored object give the
 * browser (blueprint Task 9.9).
 *
 * Real STREAM chunks with real tags: a test built on a stub would not notice a
 * chunking or nonce mistake, and those are exactly the mistakes that turn a
 * forwarded contract into an unreadable blob.
 */
export async function sealAttachmentFixture(
  enrollment: TestEnrollment,
  input: { fileId: string; bytes: Bytes; chunkSize?: number },
): Promise<SealedAttachmentPayload> {
  const contentKey = generateContentKey()
  const sealed = await sealContentKey({
    recipientEcdhSpki: enrollment.entry.ecdhSpki,
    userId: enrollment.userId,
    keyId: enrollment.entry.keyId,
    contentKey,
  })
  const stream = await encryptAttachmentStream({
    contentKey,
    fileId: input.fileId,
    keyId: enrollment.entry.keyId,
    plaintextLength: input.bytes.byteLength,
    source: input.bytes as Uint8Array<ArrayBuffer>,
    ...(input.chunkSize ? { chunkSize: input.chunkSize } : {}),
  })
  const parts: Bytes[] = []
  let total = 0
  for await (const chunk of stream.chunks) {
    parts.push(chunk)
    total += chunk.byteLength
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.byteLength
  }
  return {
    fileId: input.fileId,
    encVersion: stream.header.version,
    encKeyId: stream.header.keyId,
    contentKeyWrapped: bytesToBase64(sealed.wrapped),
    contentKeyEpk: bytesToBase64(sealed.epkSpki),
    chunkSize: stream.header.chunkSize,
    chunkCount: stream.header.chunkCount,
    plaintextLength: stream.header.plaintextLength,
    noncePrefix: bytesToBase64(stream.header.noncePrefix),
    ciphertext: bytesToBase64(body as Bytes),
  }
}
