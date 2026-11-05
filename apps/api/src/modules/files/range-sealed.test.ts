// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 7.3: range reads over sealed attachments.
//
// A sealed attachment is served as ciphertext and opened in the browser. The
// server therefore has two jobs and only two: hand the client the envelope it
// needs (the metadata route) and return the exact stored bytes for a requested
// span (the inline route's `Range` branch). It never assembles a plaintext file
// and it could not read one if it tried.
//
// Non-vacuity first, deliberately: the first case is a range request against an
// UNSEALED file, asserting the plaintext slice. Without it the whole file could
// pass against a route that returned an error, an empty body, or 200 with the
// wrong bytes for everything.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { decryptAttachmentChunks } from "@liaison/mailbox-crypto/src/stream-open"
import { STREAM_CHUNK_SIZE, STREAM_TAG_BYTES } from "@liaison/mailbox-crypto/src/stream-seal"
import { sql as drizzleSql } from "drizzle-orm"
import type { Hono } from "hono"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  type AttachmentEncryptionMetadata,
  ciphertextSpanForPlaintextRange,
} from "~/modules/files/encryption-metadata"
import * as minimal from "~/seed/tiers/minimal"
import { buildTestApp } from "~/tests/helpers/build-app"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCHEMA = schemaRef("app_mail")
const MAIL = drizzleSql.raw(`"${SCHEMA}"`)
const KEY_ID = 91

let app: Hono
let orgId: string
let ownerId: string
let ownerBearer: string
let strangerBearer: string
let ownerKeys: CryptoKeyPair
let ownerSpki: Buffer

/** Three chunks: two full, one short, so a range can span a boundary. */
const SEALED_PLAINTEXT = (() => {
  const bytes = Buffer.alloc(STREAM_CHUNK_SIZE * 2 + 1000)
  for (let i = 0; i < bytes.byteLength; i++) bytes[i] = i % 251
  return bytes
})()
const CLEAR_PLAINTEXT = Buffer.from("the shared team mailbox keeps its bytes readable, by design")

let sealedFileId: string
let sealedStorageKey: string
let clearMessageId: string
let clearFileId: string

async function insertAccount(
  ownerType: string,
  owner: string | null,
  encryptionState: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await withSystemDb("range-sealed-account", (db) =>
    db.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
              ${owner}, 'gmail', ${`${id}@range.test`}, 'active', ${encryptionState})`),
  )
  return id
}

async function insertMessage(
  accountId: string,
  ownerType: string,
  owner: string | null,
): Promise<string> {
  const conversationId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  await withSystemDb("range-sealed-message", async (db) => {
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count)
      VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, ${ownerType},
              ${owner}, ${`thread-${conversationId}`}, 'open', '[]'::jsonb, false, false, 1)`)
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
         message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
         is_read, is_starred, labels, direction, raw_headers)
      VALUES (${messageId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
              ${ownerType}, ${owner}, ${`ext-${messageId}`}, '[]'::jsonb,
              ${JSON.stringify({ email: "nadia@range.test" })}::jsonb, '[]'::jsonb, '[]'::jsonb,
              '[]'::jsonb, false, false, '[]'::jsonb, 'inbound',
              ${JSON.stringify({ "message-id": `<${messageId}@range.test>` })}::jsonb)`)
  })
  return messageId
}

async function importAttachment(
  messageId: string,
  bytes: Buffer,
  filename: string,
): Promise<{ id: string; storageKey: string }> {
  const response = await withPrivilegedDb(orgId, "range-sealed-import", async (tx) => {
    const bridge = createRpcBridge(
      "mail",
      ownerId,
      orgId,
      tx as unknown as RlsClient,
      mailAppManifest as never,
    ) as unknown as Record<string, (json: string) => Promise<string>>
    return bridge.files_importAttachment(
      JSON.stringify({
        targetApp: "mail",
        targetEntityType: "message",
        targetEntityId: messageId,
        filename,
        mimeType: "application/pdf",
        bytesBase64: bytes.toString("base64"),
        disposition: "attachment",
        ordinal: 0,
      }),
    )
  })
  const parsed = JSON.parse(response) as { id: string; storageKey: string }
  return { id: parsed.id, storageKey: parsed.storageKey }
}

/**
 * Mint a bearer AFTER the scope grants land. `createTestUserSession` signs the
 * token at creation time, so a scope granted afterwards would not be in it and
 * every case below would fail for the wrong reason.
 */
async function mintToken(userId: string): Promise<string> {
  const { signAccessToken } = await import("~/modules/auth/jwt")
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const row = await withSystemDb("range-sealed-token", async (db) =>
    extractRows<{
      org_id: string
      name: string
      auth_version: number
      permission_version: number
    }>(
      await db.execute(drizzleSql`
        SELECT org_id::text AS org_id, name, auth_version, permission_version
          FROM kernel.users WHERE id = ${userId}::uuid`),
    ),
  )
  const user = row[0]
  if (!user) throw new Error(`mintToken: user ${userId} not found`)
  const perms = await withPrivilegedDb(user.org_id, "range-sealed-perms", (tx) =>
    loadEffectivePermissions(tx, userId, user.org_id),
  )
  const { env } = await import("~/lib/env")
  return signAccessToken(
    {
      userId,
      orgId: user.org_id,
      name: user.name,
      authVersion: user.auth_version,
      permissionVersion: user.permission_version,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    900,
  )
}

beforeAll(async () => {
  await acquireTestLock()
  const owner = await minimal.session((await createTestOrg()).id)
  orgId = owner.orgId
  ownerId = owner.userId
  const stranger = await minimal.person(orgId)
  // Both users hold the SAME mail read scope, so the refusal below is about
  // owning the mailbox and not about holding the capability.
  await minimal.grantScope(ownerId, "mail:conversations:read")
  await minimal.grantScope(stranger.id, "mail:conversations:read")
  ownerBearer = await mintToken(ownerId)
  strangerBearer = await mintToken(stranger.id)
  // The kernel.files SELECT policy ships as `USING (false)` and is rebuilt from
  // the manifest fileParent registry at boot. Without this the route sees zero
  // rows and every case 404s for a reason that has nothing to do with ranges.
  await rebuildFilesSelectPolicy()

  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  ownerKeys = ecdh
  ownerSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))

  const account = await insertAccount("user", ownerId, "ready")
  const clearMessage = await insertMessage(account, "user", ownerId)
  clearMessageId = clearMessage
  const sealedMessage = await insertMessage(account, "user", ownerId)

  // The unsealed control is imported BEFORE the owner enrols, which is exactly
  // how a real pre-migration attachment came to be stored in the clear. Same
  // mailbox, same route, same reader: the only difference between the two files
  // below is that one was written after the identity existed.
  clearFileId = (await importAttachment(clearMessage, CLEAR_PLAINTEXT, "team.pdf")).id

  await withSystemDb("range-sealed-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${orgId}::uuid, ${ownerId}::uuid, ${KEY_ID}, ${ownerSpki}, ${signSpki},
              ${Buffer.from("attestation")}, 'active')`),
  )

  const sealed = await importAttachment(sealedMessage, SEALED_PLAINTEXT, "contract.pdf")
  sealedFileId = sealed.id
  sealedStorageKey = sealed.storageKey

  app = await buildTestApp()
}, 180_000)

afterAll(async () => {
  if (orgId) {
    await withSystemDb("range-sealed-cleanup", async (db) => {
      await db.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await db.execute(
        drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE org_id = ${orgId}::uuid`,
      )
    })
  }
  await releaseTestLock()
})

function auth(bearer: string, range?: string): Record<string, string> {
  return range
    ? { authorization: `Bearer ${bearer}`, range }
    : { authorization: `Bearer ${bearer}` }
}

async function metadata(fileId: string, bearer = ownerBearer) {
  const res = await app.request(`/api/files/${fileId}/metadata`, { headers: auth(bearer) })
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } }
}

describe("range reads over attachments", () => {
  test("non-vacuity: a range request on an UNSEALED file returns the plaintext slice", async () => {
    const res = await app.request(`/api/files/${clearFileId}/inline`, {
      headers: auth(ownerBearer, "bytes=4-12"),
    })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(`bytes 4-12/${CLEAR_PLAINTEXT.byteLength}`)
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(CLEAR_PLAINTEXT.subarray(4, 13))).toBe(true)

    // And the same file reports no encryption envelope, so the sealed case
    // below is a real difference rather than a fixture artefact.
    const meta = await metadata(clearFileId)
    expect(meta.status).toBe(200)
    expect(meta.body.data?.encryption).toBeNull()
  }, 60_000)

  test("the metadata response names the record the file is attached to", async () => {
    // The Home's file_shared card opens the file's parent from here (rows stored
    // before the event carried a link).
    const meta = await metadata(clearFileId)
    expect(meta.status).toBe(200)
    expect(meta.body.data?.app).toBe("mail")
    expect(meta.body.data?.entityType).toBe("message")
    expect(meta.body.data?.entityId).toBe(clearMessageId)
  }, 60_000)

  test("the metadata response carries every chunk field for a sealed attachment", async () => {
    const meta = await metadata(sealedFileId)
    expect(meta.status).toBe(200)
    const enc = meta.body.data?.encryption as AttachmentEncryptionMetadata
    expect(enc).toBeTruthy()
    expect(enc.encVersion).toBe(1)
    expect(enc.keyId).toBe(KEY_ID)
    expect(enc.chunkSize).toBe(STREAM_CHUNK_SIZE)
    expect(enc.chunkCount).toBe(3)
    expect(enc.plaintextLength).toBe(SEALED_PLAINTEXT.byteLength)
    expect(Buffer.from(enc.noncePrefixBase64, "base64").byteLength).toBe(7)
    expect(Buffer.from(enc.contentKeyWrappedBase64, "base64").byteLength).toBeGreaterThan(0)
    expect(Buffer.from(enc.contentKeyEpkBase64, "base64").byteLength).toBeGreaterThan(0)
  }, 60_000)

  test("a range spanning a chunk boundary returns the stored ciphertext and opens to the plaintext slice", async () => {
    const meta = await metadata(sealedFileId)
    const enc = meta.body.data?.encryption as AttachmentEncryptionMetadata

    // The plaintext the reader wants: the last bytes of chunk 0 through the
    // first bytes of chunk 1.
    const wantStart = STREAM_CHUNK_SIZE - 40
    const wantEnd = STREAM_CHUNK_SIZE + 60
    const span = ciphertextSpanForPlaintextRange(enc, wantStart, wantEnd, STREAM_TAG_BYTES)
    expect(span.firstChunk).toBe(0)
    expect(span.lastChunk).toBe(1)

    const stored = await getObjectBuffer(sealedStorageKey)
    // Non-vacuity for this case: the object really is longer than the
    // plaintext, by exactly one tag per chunk.
    expect(stored.byteLength).toBe(SEALED_PLAINTEXT.byteLength + 3 * STREAM_TAG_BYTES)

    const res = await app.request(`/api/files/${sealedFileId}/inline`, {
      headers: auth(ownerBearer, `bytes=${span.start}-${span.end}`),
    })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(
      `bytes ${span.start}-${span.end}/${stored.byteLength}`,
    )
    const body = Buffer.from(await res.arrayBuffer())
    // Byte for byte the stored ciphertext for the covering chunks.
    expect(body.equals(stored.subarray(span.start, span.end + 1))).toBe(true)
    // It is ciphertext, not the plaintext the reader asked for.
    expect(body.includes(SEALED_PLAINTEXT.subarray(wantStart, wantEnd + 1))).toBe(false)

    const contentKey = await unsealContentKey({
      privateKey: ownerKeys.privateKey,
      recipientEcdhSpki: new Uint8Array(ownerSpki),
      userId: ownerId,
      keyId: enc.keyId,
      wrapped: new Uint8Array(Buffer.from(enc.contentKeyWrappedBase64, "base64")),
      epkSpki: new Uint8Array(Buffer.from(enc.contentKeyEpkBase64, "base64")),
    })
    const sealedChunk = enc.chunkSize + STREAM_TAG_BYTES
    const chunks: Uint8Array<ArrayBuffer>[] = []
    for (let i = span.firstChunk; i <= span.lastChunk; i++) {
      const offset = (i - span.firstChunk) * sealedChunk
      chunks.push(
        new Uint8Array(body.subarray(offset, offset + sealedChunk)) as Uint8Array<ArrayBuffer>,
      )
    }
    const opened: Buffer[] = []
    for await (const piece of decryptAttachmentChunks({
      contentKey,
      fileId: sealedFileId,
      header: {
        version: enc.encVersion,
        keyId: enc.keyId,
        noncePrefix: new Uint8Array(Buffer.from(enc.noncePrefixBase64, "base64")),
        chunkSize: enc.chunkSize,
        chunkCount: enc.chunkCount,
        plaintextLength: enc.plaintextLength,
      },
      firstChunkIndex: span.firstChunk,
      chunks,
    })) {
      opened.push(Buffer.from(piece))
    }
    const window = Buffer.concat(opened)
    const sliceStart = wantStart - span.firstChunk * enc.chunkSize
    expect(
      window
        .subarray(sliceStart, sliceStart + (wantEnd - wantStart + 1))
        .equals(SEALED_PLAINTEXT.subarray(wantStart, wantEnd + 1)),
    ).toBe(true)
  }, 60_000)

  test("a range request from a user who does not own the mailbox is refused", async () => {
    const res = await app.request(`/api/files/${sealedFileId}/inline`, {
      headers: auth(strangerBearer, "bytes=0-63"),
    })
    expect([401, 403, 404]).toContain(res.status)
    const meta = await metadata(sealedFileId, strangerBearer)
    expect([401, 403, 404]).toContain(meta.status)

    // The control: the OWNER is not refused by the same route in the same
    // moment, so this is an authorization result and not a broken fixture.
    const owner = await app.request(`/api/files/${sealedFileId}/inline`, {
      headers: auth(ownerBearer, "bytes=0-63"),
    })
    expect(owner.status).toBe(206)
  }, 60_000)
})
