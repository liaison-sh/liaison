// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint Task 9.9. Re-attaching a sealed file to an outgoing message is only
// possible if THIS browser can turn the stored ciphertext back into the exact
// bytes that were imported. Everything here is a real seal to open round trip
// against the same STREAM encryptor the host uses, because the failure this
// guards against is not "an error is thrown", it is "a slightly wrong file is
// mailed to a customer and everyone reports success".

import { describe, expect, it } from "vitest"
import { createAttachmentOpener } from "~/modules/mailbox/attachment-opener"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import type { SealedAttachmentPayload } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealAttachmentFixture,
  TEST_USER_ID,
} from "~/modules/mailbox/mailbox-fixtures"

const PASSPHRASE = "correct horse battery staple 42"
const FILE_ID = "33333333-3333-4333-8333-333333333333"

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** A PDF-ish payload of two full chunks plus a short tail, so the multi chunk
 *  and final chunk paths both run. */
function payload(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length))
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 11) % 251
  return bytes
}

async function unlockedClient() {
  const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  const client = createMailboxCryptoClient({
    post: (request) => handleWorkerRequest(session, request),
  })
  await client.unlock({
    userId: TEST_USER_ID,
    method: "passphrase",
    secret: PASSPHRASE,
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })
  return { enrollment, session, client }
}

interface Wire {
  metadata: Record<string, unknown>
  ciphertext: Uint8Array
}

/** The two server reads the opener makes, as the routes shape them. */
function wireFor(sealed: SealedAttachmentPayload): Wire {
  return {
    metadata: {
      id: sealed.fileId,
      filename: "contract.pdf",
      mimeType: "application/pdf",
      sizeBytes: sealed.plaintextLength,
      encryption: {
        encVersion: sealed.encVersion,
        keyId: sealed.encKeyId,
        chunkSize: sealed.chunkSize,
        chunkCount: sealed.chunkCount,
        plaintextLength: sealed.plaintextLength,
        noncePrefixBase64: sealed.noncePrefix,
        contentKeyWrappedBase64: sealed.contentKeyWrapped,
        contentKeyEpkBase64: sealed.contentKeyEpk,
      },
    },
    ciphertext: base64ToBytes(sealed.ciphertext),
  }
}

function openerFor(
  client: Awaited<ReturnType<typeof unlockedClient>>["client"],
  wires: Record<string, Wire>,
  overrides: { maxBytes?: number } = {},
) {
  return createAttachmentOpener({
    client,
    fetchMetadata: async (fileId: string) => {
      const wire = wires[fileId]
      if (!wire) throw new Error(`no such file ${fileId}`)
      return wire.metadata
    },
    fetchCiphertext: async (fileId: string) => {
      const wire = wires[fileId]
      if (!wire) throw new Error(`no such file ${fileId}`)
      return wire.ciphertext
    },
    ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
  })
}

describe("opening a sealed attachment for an outgoing message", () => {
  it("returns the imported bytes, byte for byte", async () => {
    const { enrollment, client } = await unlockedClient()
    const plaintext = payload(300)
    const sealed = await sealAttachmentFixture(enrollment, {
      fileId: FILE_ID,
      bytes: plaintext,
      chunkSize: 128,
    })
    // Non-vacuity: what the server holds is NOT the file.
    expect(sealed.ciphertext).not.toBe(bytesToBase64(plaintext))
    expect(sealed.chunkCount).toBe(3)

    const open = openerFor(client, { [FILE_ID]: wireFor(sealed) })
    const opened = await open([FILE_ID])
    expect(opened).toHaveLength(1)
    expect(opened[0]?.fileId).toBe(FILE_ID)
    expect(base64ToBytes(opened[0]?.bytesBase64 ?? "")).toEqual(plaintext)
  })

  it("refuses a truncated object instead of returning the bytes it could open", async () => {
    const { enrollment, client } = await unlockedClient()
    const plaintext = payload(300)
    const sealed = await sealAttachmentFixture(enrollment, {
      fileId: FILE_ID,
      bytes: plaintext,
      chunkSize: 128,
    })
    const wire = wireFor(sealed)
    // Drop the last chunk. Every surviving chunk still authenticates, so only a
    // whole-stream check can catch this, and a partial file must never be sent.
    wire.ciphertext = wire.ciphertext.subarray(0, 2 * (128 + 16))
    const open = openerFor(client, { [FILE_ID]: wire })
    await expect(open([FILE_ID])).rejects.toThrow()
  })

  it("refuses bytes that were tampered with in the store", async () => {
    const { enrollment, client } = await unlockedClient()
    const plaintext = payload(300)
    const sealed = await sealAttachmentFixture(enrollment, {
      fileId: FILE_ID,
      bytes: plaintext,
      chunkSize: 128,
    })
    const wire = wireFor(sealed)
    wire.ciphertext = wire.ciphertext.slice()
    wire.ciphertext[5] = (wire.ciphertext[5] ?? 0) ^ 0xff
    const open = openerFor(client, { [FILE_ID]: wire })
    await expect(open([FILE_ID])).rejects.toThrow()
  })

  it("refuses when the mailbox is locked, and opens nothing", async () => {
    const { enrollment, client } = await unlockedClient()
    const sealed = await sealAttachmentFixture(enrollment, {
      fileId: FILE_ID,
      bytes: payload(64),
      chunkSize: 128,
    })
    await client.lock()
    const open = openerFor(client, { [FILE_ID]: wireFor(sealed) })
    await expect(open([FILE_ID])).rejects.toThrow()
  })

  it("refuses a request over its byte ceiling rather than sending part of it", async () => {
    const { enrollment, client } = await unlockedClient()
    const sealed = await sealAttachmentFixture(enrollment, {
      fileId: FILE_ID,
      bytes: payload(300),
      chunkSize: 128,
    })
    const open = openerFor(client, { [FILE_ID]: wireFor(sealed) }, { maxBytes: 100 })
    await expect(open([FILE_ID])).rejects.toThrow()
  })

  it("passes an unsealed file through unchanged, so a mixed send still goes out", async () => {
    const { client } = await unlockedClient()
    const plaintext = payload(48)
    const open = openerFor(client, {
      [FILE_ID]: {
        metadata: {
          id: FILE_ID,
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: plaintext.byteLength,
          encryption: null,
        },
        ciphertext: plaintext,
      },
    })
    const opened = await open([FILE_ID])
    expect(base64ToBytes(opened[0]?.bytesBase64 ?? "")).toEqual(plaintext)
  })
})
