// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Making a private mailbox transparent: its attachments, and the owner's notice.
//
// The owner's unlocked browser opens each private attachment and hands the
// server its bytes, with the per-file key (D5) it opened them with. The server
// writes the attachment only when those bytes, sealed again under that key
// with the stored nonce prefix and chunk bindings, reproduce the stored object.
// A session that cannot open the mailbox cannot replace an attachment.
//
// When the move completes, the owner is told in their attention feed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { deriveFieldSubkey } from "@liaison/mailbox-crypto/src/kdf"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { deleteObject, getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { stepUpCodeKey } from "~/modules/auth/step-up"
import { sealAttachmentBytes } from "~/modules/mailbox-crypto/attachment-seal"
import { sealMailFields } from "~/modules/mailbox-crypto/mail-writer"
import { mailboxEncryptionRoutes } from "~/modules/mailbox-keys/encryption-mode-routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const orgs = new Set<string>()
const storageKeys = new Set<string>()

beforeAll(acquireTestLock)
afterAll(async () => {
  await withSystemDb("make-transparent-files-cleanup", async (tx) => {
    for (const orgId of orgs) {
      await tx.execute(drizzleSql`DELETE FROM ${K}.files WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.mailbox_server_keys WHERE org_id = ${orgId}::uuid`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${K}.pending_events WHERE org_id = ${orgId}::uuid`)
    }
  })
  for (const key of storageKeys) await deleteObject(key).catch(() => undefined)
  await releaseTestLock()
})

function sessionOnly(user: minimal.Person): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    c.set("scopes", ["mail:*"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox/encryption", mailboxEncryptionRoutes)
  app.onError(errorHandler)
  return app
}

interface Owner {
  user: minimal.Person
  ecdh: CryptoKeyPair
  ecdhSpki: Uint8Array<ArrayBuffer>
}

async function enrolledOwner(): Promise<Owner> {
  const user = await minimal.person((await createTestOrg()).id)
  orgs.add(user.orgId)
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  const ecdhSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
  await withSystemDb("make-transparent-files-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO ${K}.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${user.orgId}::uuid, ${user.id}::uuid, 1, ${Buffer.from(ecdhSpki)}, ${signSpki},
              ${Buffer.from("attestation")}, 'active')`),
  )
  await withSystemDb("make-transparent-files-policy", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${K}.organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{mail}',
        ${JSON.stringify({ allowPrivateMailboxes: false })}::jsonb, true)
       WHERE id = ${user.orgId}::uuid`),
  )
  return { user, ecdh, ecdhSpki }
}

const ORIGINAL = { subject: "PRIVATE ORIGINAL", textBody: "the contract", snippet: "x" }
// Two full chunks and a short one, at a small chunk size: the proof runs per chunk.
const CHUNK = 64
const REAL_BYTES = new Uint8Array(CHUNK * 2 + 17).map((_, i) => (i * 7 + 3) % 251)

async function privateMailboxWithAttachment(user: minimal.Person) {
  const accountId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const fileId = crypto.randomUUID()
  const email = `${accountId}@transparent.test`
  await withSystemDb("make-transparent-files-account", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${accountId}::uuid, ${user.orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
              ${user.id}::uuid, 'gmail', ${email}, 'active', 'ready')`),
  )
  const sealed = await sealMailFields({
    userId: user.id,
    orgId: user.orgId,
    entity: "messages",
    entityId: messageId,
    values: ORIGINAL,
    account: { id: accountId, encryptionState: "ready" },
  })
  const c = sealed.columns
  const file = await sealAttachmentBytes({
    userId: user.id,
    orgId: user.orgId,
    fileId,
    bytes: REAL_BYTES,
    chunkSize: CHUNK,
  })
  const storageKey = `test/make-transparent/${fileId}/contract.pdf`
  storageKeys.add(storageKey)
  await putObject({ key: storageKey, body: file.body, contentType: "application/pdf" })
  const f = file.columns
  await withSystemDb("make-transparent-files-rows", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, account_id, conversation_id, external_message_id, owner_type, owner_id,
         direction, sent_at, labels, is_read, is_starred, raw_headers,
         subject_ciphertext, text_body_ciphertext, snippet_ciphertext,
         content_key_wrapped, content_key_epk, enc_key_id, enc_version)
      VALUES (${messageId}::uuid, ${user.orgId}::uuid, ${accountId}::uuid,
              ${crypto.randomUUID()}::uuid, ${`ext-${messageId}`}, 'user', ${user.id}::uuid,
              'inbound', now(), '[]'::jsonb, false, false, '{}'::jsonb,
              ${c.subjectCiphertext as Buffer}, ${c.textBodyCiphertext as Buffer},
              ${c.snippetCiphertext as Buffer}, ${c.contentKeyWrapped as Buffer},
              ${(c.contentKeyEpk as Buffer | undefined) ?? null}, ${c.encKeyId as number},
              ${c.encVersion as number})`)
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.files
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key,
         enc_version, content_key_wrapped, content_key_epk, enc_key_id, chunk_size, chunk_count,
         plaintext_length, nonce_prefix)
      VALUES (${fileId}::uuid, ${user.orgId}::uuid, 'mail', 'message', ${messageId},
              'contract.pdf', 'application/pdf', ${file.body.byteLength}, ${storageKey},
              ${f.encVersion}, ${f.contentKeyWrapped}, ${f.contentKeyEpk}, ${f.encKeyId},
              ${f.chunkSize}, ${f.chunkCount}, ${f.plaintextLength}, ${f.noncePrefix})`)
  })
  return { accountId, messageId, fileId, storageKey, email, stored: file.body }
}

async function readFile(fileId: string) {
  return withSystemDb("make-transparent-files-read", async (tx) =>
    extractRows<Record<string, unknown>>(
      await tx.execute(drizzleSql`SELECT * FROM ${K}.files WHERE id = ${fileId}::uuid`),
    ),
  )
}

async function readAccount(accountId: string) {
  return withSystemDb("make-transparent-files-account-read", async (tx) =>
    extractRows<Record<string, unknown>>(
      await tx.execute(drizzleSql`SELECT * FROM ${MAIL}.accounts WHERE id = ${accountId}::uuid`),
    ),
  )
}

async function transparentStepUpCode(userId: string): Promise<string> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(userId, "mailbox_transparent"), hashToken(code), "EX", 600)
  return code
}

function post(app: Hono<AppEnv>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function postBytes(app: Hono<AppEnv>, path: string, bytes: Uint8Array) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  })
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/** The owner's browser: the content key opened from the row, then a D5 subkey. */
async function ownerContentKey(owner: Owner, wrapped: unknown, epk: unknown) {
  return unsealContentKey({
    privateKey: owner.ecdh.privateKey,
    recipientEcdhSpki: owner.ecdhSpki,
    userId: owner.user.id,
    keyId: 1,
    wrapped: new Uint8Array(wrapped as Buffer),
    epkSpki: new Uint8Array(epk as Buffer),
  })
}

async function subkey(contentKey: CryptoKey, context: { fieldName: string; entityId: string }) {
  return b64(
    await deriveFieldSubkey({
      contentKey,
      fieldName: context.fieldName,
      entityId: context.entityId,
    }),
  )
}

async function ownerFileKey(owner: Owner, fileId: string): Promise<string> {
  const [row] = await readFile(fileId)
  const contentKey = await ownerContentKey(owner, row?.content_key_wrapped, row?.content_key_epk)
  return subkey(contentKey, mailboxAad.attachment(fileId))
}

async function begin(app: Hono<AppEnv>, owner: Owner, base: string) {
  const res = await post(app, base, { stepUpCode: await transparentStepUpCode(owner.user.id) })
  expect(res.status).toBe(200)
}

describe("making a private mailbox transparent: attachments", () => {
  test("bytes the mailbox key did not open are refused and the original stays", async () => {
    const owner = await enrolledOwner()
    const { accountId, fileId, storageKey, stored } = await privateMailboxWithAttachment(owner.user)
    const app = sessionOnly(owner.user)
    const base = `/api/mailbox/encryption/accounts/${accountId}/make-transparent`
    await begin(app, owner, base)

    const [row] = await readFile(fileId)
    const ck = encodeURIComponent(b64(row?.content_key_wrapped as Buffer))
    // Same length as the original, so only the proof can tell them apart.
    const forged = new Uint8Array(REAL_BYTES.byteLength).fill(0x41)
    const random = b64(crypto.getRandomValues(new Uint8Array(32)))
    const realKey = await ownerFileKey(owner, fileId)
    const tampered = REAL_BYTES.slice()
    tampered[CHUNK * 2 + 3] ^= 0x01

    const attempts = [
      // No proof at all.
      `${base}/files/${fileId}?ck=${ck}`,
      // A key the session made up.
      `${base}/files/${fileId}?ck=${ck}&fk=${encodeURIComponent(random)}`,
    ]
    const results: Array<{ status: number; resealed: unknown }> = []
    for (const path of attempts) {
      const res = await postBytes(app, path, forged)
      const body = (await res.json().catch(() => ({}))) as { data?: { resealed?: boolean } }
      results.push({ status: res.status, resealed: body.data?.resealed })
    }
    // The real key, over invented bytes, and over the real bytes with one byte changed.
    for (const bytes of [forged, tampered]) {
      const res = await postBytes(
        app,
        `${base}/files/${fileId}?ck=${ck}&fk=${encodeURIComponent(realKey)}`,
        bytes,
      )
      const body = (await res.json().catch(() => ({}))) as { data?: { resealed?: boolean } }
      results.push({ status: res.status, resealed: body.data?.resealed })
    }
    console.log("forged attachment attempts", JSON.stringify(results))
    for (const r of results) expect(r.resealed === true).toBe(false)

    const [after] = await readFile(fileId)
    expect(Number(after?.enc_version)).toBe(1)
    const object = await getObjectBuffer(storageKey)
    expect(Buffer.from(object).equals(stored)).toBe(true)
  })

  test("the owner's opened bytes and key convert it; completing the move tells the owner", async () => {
    const owner = await enrolledOwner()
    const { accountId, messageId, fileId, email } = await privateMailboxWithAttachment(owner.user)
    const app = sessionOnly(owner.user)
    const base = `/api/mailbox/encryption/accounts/${accountId}/make-transparent`
    await begin(app, owner, base)

    const [row] = await readFile(fileId)
    const ck = encodeURIComponent(b64(row?.content_key_wrapped as Buffer))
    const fk = encodeURIComponent(await ownerFileKey(owner, fileId))
    const res = await postBytes(app, `${base}/files/${fileId}?ck=${ck}&fk=${fk}`, REAL_BYTES)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { resealed: boolean } }).data.resealed).toBe(true)
    const [after] = await readFile(fileId)
    expect(Number(after?.enc_version)).toBe(2)

    // The message, with the keys the browser opened it with.
    const pending = (await (await app.request(`${base}/pending?entity=messages`)).json()) as {
      data: { items: Array<Record<string, unknown> & { id: string; contentKeyWrapped: string }> }
    }
    const item = pending.data.items.find((i) => i.id === messageId)
    expect(item).toBeDefined()
    const contentKey = await ownerContentKey(
      owner,
      Buffer.from(String(item?.contentKeyWrapped), "base64"),
      Buffer.from(String(item?.contentKeyEpk), "base64"),
    )
    const batch = await post(app, `${base}/batch`, {
      messages: [
        {
          id: messageId,
          contentKeyWrapped: item?.contentKeyWrapped,
          ...ORIGINAL,
          htmlBody: null,
          rawHeaders: null,
          fieldKeys: {
            subject: await subkey(contentKey, mailboxAad.messageSubject(messageId)),
            textBody: await subkey(contentKey, mailboxAad.messageTextBody(messageId)),
            snippet: await subkey(contentKey, mailboxAad.messageSnippet(messageId)),
          },
        },
      ],
    })
    expect(((await batch.json()) as { data: { resealed: number } }).data.resealed).toBe(1)
    const finish = await post(app, `${base}/finish`)
    expect(((await finish.json()) as { data: { done: boolean } }).data.done).toBe(true)
    const [acct] = await readAccount(accountId)
    expect(acct?.encryption_state).toBe("managed")

    // The owner's notice, through the attention pipeline (an agent_notification
    // naming the owner alone), queued in the transaction that flipped the state.
    const notices = await withSystemDb("make-transparent-files-notice", async (tx) =>
      extractRows<{ payload: { entity: string; data: Record<string, unknown> } }>(
        await tx.execute(drizzleSql`
          SELECT payload FROM ${K}.pending_events
           WHERE org_id = ${owner.user.orgId}::uuid
             AND payload->>'entity' = 'agent_notification'`),
      ),
    )
    console.log("owner notices", JSON.stringify(notices.map((n) => n.payload.data)))
    expect(notices).toHaveLength(1)
    const data = notices[0]?.payload.data ?? {}
    expect(data.targetUserIds).toEqual([owner.user.id])
    expect(String(data.summary)).toContain(email)

    // Finishing again (already transparent) does not tell the owner twice.
    await post(app, `${base}/finish`)
    const again = await withSystemDb("make-transparent-files-notice-2", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.pending_events
           WHERE org_id = ${owner.user.orgId}::uuid
             AND payload->>'entity' = 'agent_notification'`),
      ),
    )
    expect(again[0]?.n).toBe(1)
  })
})
