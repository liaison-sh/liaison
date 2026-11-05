// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 7.2: attachment bytes are sealed HOST SIDE, on the way into the object
// store.
//
// The sandbox handler is unchanged: it still hands the host base64 and it never
// sees a key. What changes is what reaches the bucket. Whoever holds bucket
// credentials must find ciphertext, not the PDF the user was sent, and that is
// what the "no known magic" assertions below are for.
//
// Every assertion has its positive counterpart: the stored object is non-empty
// and at least as long as the plaintext, and the SAME import against a shared
// org mailbox still stores recognisable PNG magic. A bridge that stored nothing
// at all, or refused every import, cannot pass this file.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { decryptAttachmentStream } from "@liaison/mailbox-crypto/src/stream-open"
import { STREAM_CHUNK_SIZE, STREAM_TAG_BYTES } from "@liaison/mailbox-crypto/src/stream-seal"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import * as objectStorageModule from "~/infra/storage/object-storage"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { SandboxBridgeTestAccess } from "./bridge/shared"
import { createRpcBridge } from "./rpc-bridge"

const SCHEMA = schemaRef("app_mail")
const MAIL = drizzleSql.raw(`"${SCHEMA}"`)

/** The eight-byte PNG signature. A sealed object must not start with it. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A tiny but real PNG: signature, IHDR, IEND. */
function pngBytes(payload: number): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(payload, 0x42)])
}

let ORG_ID: string

interface Fixture {
  userId: string
  keys: CryptoKeyPair
  ecdhSpki: Buffer
  keyId: number
  readyAccountId: string
  readyMessageId: string
  orgAccountId: string
  orgMessageId: string
}

let fixture: Fixture

const KEY_ID = 73

async function insertAccount(
  orgId: string,
  ownerId: string | null,
  ownerType: string,
  encryptionState: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await withSystemDb("attachment-seal-account", (db) =>
    db.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
              ${ownerId}, 'gmail', ${`${id}@attach.test`}, 'active', ${encryptionState})`),
  )
  return id
}

/**
 * A conversation plus a message to hang the attachment from. Both are written
 * with every guarded plaintext column absent, which is what a sealed mailbox's
 * rows look like and what the Invariant P trigger permits.
 */
async function insertMessage(
  orgId: string,
  accountId: string,
  ownerType: string,
  ownerId: string | null,
): Promise<string> {
  const conversationId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  await withSystemDb("attachment-seal-message", async (db) => {
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count)
      VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, ${ownerType},
              ${ownerId}, ${`thread-${conversationId}`}, 'open', '[]'::jsonb, false, false, 1)`)
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
         message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
         is_read, is_starred, labels, direction, raw_headers)
      VALUES (${messageId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
              ${ownerType}, ${ownerId}, ${`ext-${messageId}`}, '[]'::jsonb,
              ${JSON.stringify({ email: "nadia@attach.test" })}::jsonb, '[]'::jsonb, '[]'::jsonb,
              '[]'::jsonb, false, false, '[]'::jsonb, 'inbound',
              ${JSON.stringify({ "message-id": `<${messageId}@attach.test>` })}::jsonb)`)
  })
  return messageId
}

beforeAll(async () => {
  await acquireTestLock()
  const owner = await minimal.person((await createTestOrg()).id)
  ORG_ID = owner.orgId

  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
  await withSystemDb("attachment-seal-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${ORG_ID}::uuid, ${owner.id}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
              ${Buffer.from("attestation")}, 'active')`),
  )

  const readyAccountId = await insertAccount(ORG_ID, owner.id, "user", "ready")
  const orgAccountId = await insertAccount(ORG_ID, null, "org", "none")
  fixture = {
    userId: owner.id,
    keys: ecdh,
    ecdhSpki,
    keyId: KEY_ID,
    readyAccountId,
    readyMessageId: await insertMessage(ORG_ID, readyAccountId, "user", owner.id),
    orgAccountId,
    orgMessageId: await insertMessage(ORG_ID, orgAccountId, "org", null),
  }
}, 120_000)

afterAll(async () => {
  if (ORG_ID) {
    await withSystemDb("attachment-seal-cleanup", async (db) => {
      await db.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${ORG_ID}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${ORG_ID}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${ORG_ID}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${ORG_ID}::uuid`)
      await db.execute(
        drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE org_id = ${ORG_ID}::uuid`,
      )
    })
  }
  await releaseTestLock()
})

interface StoredObject {
  key: string
  body: Buffer
}

interface ImportResult {
  fileId: string
  stored: StoredObject
  row: {
    enc_version: number
    content_key_wrapped: Buffer | null
    content_key_epk: Buffer | null
    enc_key_id: number | null
    chunk_size: number | null
    chunk_count: number | null
    plaintext_length: string | number | null
    nonce_prefix: Buffer | null
    size_bytes: string | number
    filename: string
    mime_type: string
  }
}

let restorePut: (() => void) | null = null

afterEach(() => {
  restorePut?.()
  restorePut = null
})

async function importAttachment(
  messageId: string,
  bytes: Buffer,
  filename = "photo.png",
): Promise<ImportResult> {
  const stored: StoredObject[] = []
  const spy = spyOn(objectStorageModule, "putObject").mockImplementation((async (args: {
    key: string
    body: Buffer | Uint8Array
    contentType: string
  }) => {
    stored.push({ key: args.key, body: Buffer.from(args.body) })
  }) as unknown as typeof objectStorageModule.putObject)
  restorePut = () => spy.mockRestore()

  const response = await withPrivilegedDb(ORG_ID, "attachment-seal-import", async (tx) => {
    const bridge = createRpcBridge(
      "mail",
      fixture.userId,
      ORG_ID,
      tx as unknown as RlsClient,
      mailAppManifest as never,
    ) as unknown as Record<string, (json: string) => Promise<string>>
    return bridge.files_importAttachment(
      JSON.stringify({
        targetApp: "mail",
        targetEntityType: "message",
        targetEntityId: messageId,
        filename,
        mimeType: "image/png",
        bytesBase64: bytes.toString("base64"),
        disposition: "attachment",
        ordinal: 0,
      }),
    )
  })
  const parsed = JSON.parse(response) as { id: string }
  expect(stored).toHaveLength(1)

  const row = await withSystemDb("attachment-seal-row", async (db) =>
    extractRows<ImportResult["row"]>(
      await db.execute(drizzleSql`
        SELECT enc_version, content_key_wrapped, content_key_epk, enc_key_id, chunk_size,
               chunk_count, plaintext_length, nonce_prefix, size_bytes, filename, mime_type
          FROM kernel.files WHERE id = ${parsed.id}::uuid`),
    ),
  )
  expect(row).toHaveLength(1)
  return {
    fileId: parsed.id,
    stored: stored[0] as StoredObject,
    row: row[0] as ImportResult["row"],
  }
}

/** Cut the concatenated ciphertext back into the chunks the decryptor expects. */
function splitChunks(
  body: Buffer,
  chunkSize: number,
  chunkCount: number,
): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (let i = 0; i < chunkCount; i++) {
    const remaining = body.byteLength - offset
    const take = i === chunkCount - 1 ? remaining : chunkSize + STREAM_TAG_BYTES
    out.push(new Uint8Array(body.subarray(offset, offset + take)) as Uint8Array<ArrayBuffer>)
    offset += take
  }
  return out
}

async function openStored(result: ImportResult): Promise<Buffer> {
  const contentKey = await unsealContentKey({
    privateKey: fixture.keys.privateKey,
    recipientEcdhSpki: new Uint8Array(fixture.ecdhSpki),
    userId: fixture.userId,
    keyId: Number(result.row.enc_key_id),
    wrapped: new Uint8Array(result.row.content_key_wrapped as Buffer),
    epkSpki: new Uint8Array(result.row.content_key_epk as Buffer),
  })
  const chunkSize = Number(result.row.chunk_size)
  const chunkCount = Number(result.row.chunk_count)
  const parts: Buffer[] = []
  for await (const piece of decryptAttachmentStream({
    contentKey,
    fileId: result.fileId,
    header: {
      version: Number(result.row.enc_version),
      keyId: Number(result.row.enc_key_id),
      noncePrefix: new Uint8Array(result.row.nonce_prefix as Buffer),
      chunkSize,
      chunkCount,
      plaintextLength: Number(result.row.plaintext_length),
    },
    chunks: splitChunks(result.stored.body, chunkSize, chunkCount),
  })) {
    parts.push(Buffer.from(piece))
  }
  return Buffer.concat(parts)
}

function expectSealedRow(
  result: ImportResult,
  plaintextLength: number,
  filename = "photo.png",
): void {
  // Non-vacuity: something real was stored, and it is at least as long as the
  // plaintext (STREAM adds one tag per chunk, it never shrinks).
  expect(result.stored.body.byteLength).toBeGreaterThan(0)
  expect(result.stored.body.byteLength).toBeGreaterThanOrEqual(plaintextLength)
  // No known magic. The tiny PNG's signature is the one that matters here: the
  // very bytes that went in must not be the bytes at rest.
  expect(result.stored.body.subarray(0, 8).equals(PNG_MAGIC)).toBe(false)
  expect(result.stored.body.subarray(0, 64).includes(PNG_MAGIC)).toBe(false)

  expect(Number(result.row.enc_version)).toBe(1)
  expect(result.row.content_key_wrapped).not.toBeNull()
  expect(result.row.content_key_epk).not.toBeNull()
  expect(Number(result.row.enc_key_id)).toBe(KEY_ID)
  expect(Number(result.row.chunk_size)).toBe(STREAM_CHUNK_SIZE)
  expect((result.row.nonce_prefix as Buffer).byteLength).toBe(7)
  expect(Number(result.row.plaintext_length)).toBe(plaintextLength)
  // Envelope level stays cleartext: the list UI renders both with no key.
  expect(result.row.filename).toBe(filename)
  expect(result.row.mime_type).toBe("image/png")
}

describe("files_importAttachment seals mail attachments host-side", () => {
  test("an attachment on a ready personal mailbox reaches the object store as ciphertext", async () => {
    const plaintext = pngBytes(4096)
    const result = await importAttachment(fixture.readyMessageId, plaintext)
    expectSealedRow(result, plaintext.byteLength)
    expect(Number(result.row.chunk_count)).toBe(1)
    expect(await openStored(result)).toEqual(plaintext)
  }, 60_000)

  test("a zero byte attachment seals as one final empty chunk and opens to zero bytes", async () => {
    const plaintext = Buffer.alloc(0)
    const result = await importAttachment(fixture.readyMessageId, plaintext, "empty.png")
    expect(result.stored.body.byteLength).toBe(STREAM_TAG_BYTES)
    expect(Number(result.row.enc_version)).toBe(1)
    expect(Number(result.row.chunk_count)).toBe(1)
    expect(Number(result.row.plaintext_length)).toBe(0)
    expect((await openStored(result)).byteLength).toBe(0)
  }, 60_000)

  test("an attachment of exactly n chunk sizes gains no extra chunk and opens byte for byte", async () => {
    const plaintext = Buffer.concat([
      PNG_MAGIC,
      Buffer.alloc(STREAM_CHUNK_SIZE * 2 - PNG_MAGIC.byteLength, 0x37),
    ])
    expect(plaintext.byteLength).toBe(STREAM_CHUNK_SIZE * 2)
    const result = await importAttachment(fixture.readyMessageId, plaintext, "exact.png")
    expectSealedRow(result, plaintext.byteLength, "exact.png")
    expect(Number(result.row.chunk_count)).toBe(2)
    expect(result.stored.body.byteLength).toBe(plaintext.byteLength + 2 * STREAM_TAG_BYTES)
    expect(await openStored(result)).toEqual(plaintext)
  }, 60_000)

  test("the same import on a shared org mailbox still stores recognisable PNG magic", async () => {
    const plaintext = pngBytes(1024)
    const result = await importAttachment(fixture.orgMessageId, plaintext, "shared.png")
    // The discriminating control. Without it every assertion above would pass
    // against a bridge that stored nothing recoverable for anyone.
    expect(result.stored.body.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(result.stored.body.equals(plaintext)).toBe(true)
    expect(Number(result.row.enc_version)).toBe(0)
    expect(result.row.content_key_wrapped).toBeNull()
    expect(result.row.chunk_count).toBeNull()
    expect(result.row.nonce_prefix).toBeNull()
  }, 60_000)
})

// -- Task 9.9: the send path has to SEE that a staged attachment is sealed -----
//
// `stageAndLoadAttachments` re-attaches a stored file by copying it onto the
// mail app's `outbound_staging` parent and reading the copy's bytes back. Once
// Task 7.2 seals those bytes the copy is ciphertext, and the ONLY thing that
// keeps it from being mailed to an external recipient is the copy telling the
// send path it is sealed. Two ways that fails silently, both asserted here:
// the copy row can drop the envelope columns, and the bytes bridge can decline
// to report them. Either one and the refusal never fires.
describe("the outbound staging copy of a sealed attachment reports itself sealed", () => {
  interface StagedRead {
    stagedFileId: string
    row: { enc_version: number; content_key_wrapped: Buffer | null; nonce_prefix: Buffer | null }
    bytes: { bytesBase64: string; encVersion?: number; filename?: string }
  }

  async function stageAndRead(
    sourceFileId: string,
    storedBody: Buffer,
    accountId: string,
  ): Promise<StagedRead> {
    const copySpy = spyOn(objectStorageModule, "copyObject").mockImplementation((async () => {
      // The bytes are copied verbatim by the store; only the row matters here.
    }) as unknown as typeof objectStorageModule.copyObject)
    const headSpy = spyOn(objectStorageModule, "headObject").mockImplementation((async () => ({
      contentLength: storedBody.byteLength,
      contentType: "image/png",
    })) as unknown as typeof objectStorageModule.headObject)
    const getSpy = spyOn(objectStorageModule, "getObjectBuffer").mockImplementation(
      (async () => storedBody) as unknown as typeof objectStorageModule.getObjectBuffer,
    )
    try {
      return await withPrivilegedDb(ORG_ID, "attachment-seal-stage", async (tx) => {
        const bridge = createRpcBridge(
          "mail",
          fixture.userId,
          ORG_ID,
          tx as unknown as RlsClient,
          mailAppManifest as never,
          ["mail:conversations:read", "mail:conversations:write"],
        ) as unknown as Record<string, (json: string) => Promise<string>>
        const copied = JSON.parse(
          await bridge.files_attachToParent(
            JSON.stringify({
              sourceFileId,
              targetApp: "mail",
              targetEntityType: "outbound_staging",
              targetEntityId: accountId,
            }),
          ),
        ) as { id: string }
        const bytes = JSON.parse(
          await bridge.files_getAttachmentBytes(
            JSON.stringify({
              fileId: copied.id,
              allowedParents: [
                { app: "mail", entityType: "outbound_staging", entityId: accountId },
              ],
            }),
          ),
        ) as StagedRead["bytes"]
        const rows = extractRows<StagedRead["row"]>(
          await tx.execute(drizzleSql`
            SELECT enc_version, content_key_wrapped, nonce_prefix
              FROM kernel.files WHERE id = ${copied.id}::uuid`),
        )
        return { stagedFileId: copied.id, row: rows[0] as StagedRead["row"], bytes }
      })
    } finally {
      copySpy.mockRestore()
      headSpy.mockRestore()
      getSpy.mockRestore()
    }
  }

  test("a staged copy of an unsealed attachment reads back as plaintext (non-vacuity)", async () => {
    const plaintext = pngBytes(512)
    const imported = await importAttachment(fixture.orgMessageId, plaintext, "staged-shared.png")
    const staged = await stageAndRead(imported.fileId, imported.stored.body, fixture.orgAccountId)
    expect(Number(staged.row.enc_version)).toBe(0)
    expect(Buffer.from(staged.bytes.bytesBase64, "base64").equals(plaintext)).toBe(true)
    expect(Number(staged.bytes.encVersion ?? 0)).toBe(0)
  }, 60_000)

  test("a staged copy of a sealed attachment keeps its envelope columns", async () => {
    const plaintext = pngBytes(2048)
    const imported = await importAttachment(fixture.readyMessageId, plaintext, "staged-sealed.png")
    expect(Number(imported.row.enc_version)).toBe(1)
    const staged = await stageAndRead(imported.fileId, imported.stored.body, fixture.readyAccountId)
    expect(Number(staged.row.enc_version)).toBe(1)
    expect(staged.row.content_key_wrapped).not.toBeNull()
    expect(staged.row.nonce_prefix).not.toBeNull()
  }, 60_000)

  test("the bytes bridge reports the staged copy as sealed, so the send can refuse", async () => {
    const plaintext = pngBytes(2048)
    const imported = await importAttachment(fixture.readyMessageId, plaintext, "staged-refuse.png")
    const staged = await stageAndRead(imported.fileId, imported.stored.body, fixture.readyAccountId)
    // The whole of Task 9.9's refusal hangs off this one number.
    expect(Number(staged.bytes.encVersion ?? 0)).toBeGreaterThanOrEqual(1)
    // And what came back really is the ciphertext, not the PNG: a bridge that
    // handed back plaintext here would make the assertion above pointless.
    const returned = Buffer.from(staged.bytes.bytesBase64, "base64")
    expect(returned.subarray(0, 8).equals(PNG_MAGIC)).toBe(false)
  }, 60_000)
})

// Gmail hands every real attachment over as an `attachmentId`; the bytes come
// from `attachments.get` as JSON `{ size, data }` with `data` in base64url. The
// mail sandbox cannot pull them itself (1 MB response cap, 32 MB heap), so it
// asks the host to download them with the mailbox's token. Those bytes must be
// stored exactly like an inbound attachment: decoded, sealed on a personal
// mailbox, with the part's ordinal, content id and disposition.
describe("files_importFromUrl stores a provider-hosted attachment like an inbound one", () => {
  const GMAIL_URL =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f0000000000001/attachments/ANGjdJ_test"

  /** PNG magic plus bytes whose base64url form needs `-` and `_`. */
  function urlSafeBytes(): Buffer {
    return Buffer.concat([PNG_MAGIC, Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xef]), pngBytes(600)])
  }

  interface SeenRequest {
    url: string
    authorization: string | null
  }

  async function importFromProvider(
    messageId: string,
    bytes: Buffer,
    headers: Record<string, string> = { Authorization: "Bearer gmail-token" },
  ): Promise<{
    response: string
    stored: StoredObject[]
    seen: SeenRequest[]
  }> {
    const stored: StoredObject[] = []
    const seen: SeenRequest[] = []
    const spy = spyOn(objectStorageModule, "putObject").mockImplementation((async (args: {
      key: string
      body: Buffer | Uint8Array
    }) => {
      stored.push({ key: args.key, body: Buffer.from(args.body) })
    }) as unknown as typeof objectStorageModule.putObject)
    restorePut = () => spy.mockRestore()
    SandboxBridgeTestAccess.setFetch((async (input: string | URL, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers)
      seen.push({ url: String(input), authorization: requestHeaders.get("authorization") })
      return new Response(
        JSON.stringify({ size: bytes.byteLength, data: bytes.toString("base64url") }),
        { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } },
      )
    }) as unknown as typeof fetch)
    try {
      const response = await withPrivilegedDb(ORG_ID, "attachment-url-import", async (tx) => {
        const bridge = createRpcBridge(
          "mail",
          fixture.userId,
          ORG_ID,
          tx as unknown as RlsClient,
          mailAppManifest as never,
        ) as unknown as Record<string, (json: string) => Promise<string>>
        return bridge.files_importFromUrl(
          JSON.stringify({
            targetApp: "mail",
            targetEntityType: "message",
            targetEntityId: messageId,
            url: GMAIL_URL,
            headers,
            jsonBase64Field: "data",
            filename: "CV 2026.pdf",
            mimeType: "image/png",
            disposition: "attachment",
            contentId: "<f_test0>",
            ordinal: 1,
          }),
        )
      })
      return { response, stored, seen }
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  }

  async function fileRow(fileId: string): Promise<ImportResult["row"] & Record<string, unknown>> {
    const rows = await withSystemDb("attachment-url-row", async (db) =>
      extractRows<ImportResult["row"] & Record<string, unknown>>(
        await db.execute(drizzleSql`
          SELECT enc_version, content_key_wrapped, content_key_epk, enc_key_id, chunk_size,
                 chunk_count, plaintext_length, nonce_prefix, size_bytes, filename, mime_type,
                 ordinal, content_id, disposition
            FROM kernel.files WHERE id = ${fileId}::uuid`),
      ),
    )
    expect(rows).toHaveLength(1)
    return rows[0] as ImportResult["row"] & Record<string, unknown>
  }

  test("a shared mailbox stores the decoded bytes, with the part's ordinal and content id", async () => {
    const plaintext = urlSafeBytes()
    const { response, stored, seen } = await importFromProvider(fixture.orgMessageId, plaintext)
    expect(seen).toEqual([{ url: GMAIL_URL, authorization: "Bearer gmail-token" }])
    expect(stored).toHaveLength(1)
    expect((stored[0] as StoredObject).body.equals(plaintext)).toBe(true)
    const row = await fileRow((JSON.parse(response) as { id: string }).id)
    expect(Number(row.enc_version)).toBe(0)
    expect(Number(row.size_bytes)).toBe(plaintext.byteLength)
    expect(String(row.filename)).toMatch(/^CV.2026\.pdf$/)
    expect(Number(row.ordinal)).toBe(1)
    expect(row.content_id).toBe("f_test0")
    expect(row.disposition).toBe("attachment")
  }, 60_000)

  test("a ready personal mailbox gets the downloaded bytes sealed before the bucket", async () => {
    const plaintext = urlSafeBytes()
    const { response, stored } = await importFromProvider(fixture.readyMessageId, plaintext)
    expect(stored).toHaveLength(1)
    const fileId = (JSON.parse(response) as { id: string }).id
    const row = await fileRow(fileId)
    const result: ImportResult = { fileId, stored: stored[0] as StoredObject, row }
    expectSealedRow(result, plaintext.byteLength, row.filename)
    expect(await openStored(result)).toEqual(plaintext)
  }, 60_000)

  test("a header outside the allowlist is refused before anything is fetched", async () => {
    let refused: unknown = null
    let seen: SeenRequest[] = []
    try {
      ;({ seen } = await importFromProvider(fixture.orgMessageId, urlSafeBytes(), {
        Cookie: "session=1",
      }))
    } catch (err) {
      refused = err
    }
    expect(String(refused)).toContain("invalid_header")
    expect(seen).toHaveLength(0)
  }, 60_000)
})
