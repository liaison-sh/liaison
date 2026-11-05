// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Making a private (zero-access) mailbox transparent must take more than a
// signed-in session.
//
// A private mailbox is sealed to a key only the owner's unlocked browser holds.
// Moving it to transparent hands the server its plaintext, so:
// - starting the move takes a fresh step-up (emailed code or password), like
//   the mailbox reset and the key rotation;
// - every row the browser hands back carries the per-field keys it opened the
//   row with, and the server writes the row only when the plaintext re-encrypts
//   to the stored ciphertext under them. A session that cannot open the
//   mailbox cannot invent its content.

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
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { stepUpCodeKey } from "~/modules/auth/step-up"
import { sealMailFields } from "~/modules/mailbox-crypto/mail-writer"
import { openManagedMailRows } from "~/modules/mailbox-crypto/managed-open"
import { mailboxEncryptionRoutes } from "~/modules/mailbox-keys/encryption-mode-routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw("kernel")
const orgs = new Set<string>()

beforeAll(acquireTestLock)
afterAll(async () => {
  await withSystemDb("make-transparent-test-cleanup", async (tx) => {
    for (const orgId of orgs) {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.mailbox_server_keys WHERE org_id = ${orgId}::uuid`,
      )
    }
  })
  await releaseTestLock()
})

/** The session's identity and scopes, nothing else. */
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
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  const ecdhSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
  await withSystemDb("make-transparent-test-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO ${K}.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${user.orgId}::uuid, ${user.id}::uuid, 1, ${Buffer.from(ecdhSpki)}, ${signSpki},
              ${Buffer.from("attestation")}, 'active')`),
  )
  // An org that keeps new mailboxes transparent: there "Make transparent" is offered.
  await withSystemDb("make-transparent-test-policy", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${K}.organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{mail}',
        ${JSON.stringify({ allowPrivateMailboxes: false })}::jsonb, true)
       WHERE id = ${user.orgId}::uuid`),
  )
  return { user, ecdh, ecdhSpki }
}

const ORIGINAL = { subject: "PRIVATE ORIGINAL", textBody: "the bank's real IBAN", snippet: "x" }

async function privateMailboxWithOneMessage(user: minimal.Person) {
  const accountId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  orgs.add(user.orgId)
  await withSystemDb("make-transparent-test-account", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${accountId}::uuid, ${user.orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
              ${user.id}::uuid, 'gmail', ${`${accountId}@transparent.test`}, 'active', 'ready')`),
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
  await withSystemDb("make-transparent-test-message", (tx) =>
    tx.execute(drizzleSql`
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
              ${c.encVersion as number})`),
  )
  return { accountId, messageId }
}

async function readRow(table: string, id: string) {
  return withSystemDb("make-transparent-test-read", async (tx) =>
    extractRows<Record<string, unknown> & { id: string }>(
      await tx.execute(
        drizzleSql`SELECT * FROM ${MAIL}.${drizzleSql.raw(`"${table}"`)} WHERE id = ${id}::uuid`,
      ),
    ),
  )
}

/** A valid emailed step-up code for the move, as `/api/auth/totp/step-up` stores it. */
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

/** What the owner's unlocked browser derives: one key per sealed field of the row. */
async function ownerFieldKeys(owner: Owner, item: Record<string, unknown> & { id: string }) {
  const contentKey = await unsealContentKey({
    privateKey: owner.ecdh.privateKey,
    recipientEcdhSpki: owner.ecdhSpki,
    userId: owner.user.id,
    keyId: Number(item.encKeyId),
    wrapped: new Uint8Array(Buffer.from(String(item.contentKeyWrapped), "base64")),
    epkSpki: new Uint8Array(Buffer.from(String(item.contentKeyEpk), "base64")),
  })
  const keys: Record<string, string> = {}
  for (const [field, context] of [
    ["subject", mailboxAad.messageSubject(item.id)],
    ["textBody", mailboxAad.messageTextBody(item.id)],
    ["snippet", mailboxAad.messageSnippet(item.id)],
  ] as const) {
    const subkey = await deriveFieldSubkey({
      contentKey,
      fieldName: context.fieldName,
      entityId: context.entityId,
    })
    keys[field] = Buffer.from(subkey).toString("base64")
  }
  return keys
}

async function pendingItem(app: Hono<AppEnv>, base: string, messageId: string) {
  const pending = (await (await app.request(`${base}/pending?entity=messages`)).json()) as {
    data?: { items: Array<Record<string, unknown> & { id: string; contentKeyWrapped: string }> }
  }
  return pending.data?.items.find((i) => i.id === messageId)
}

describe("making a private mailbox transparent", () => {
  test("a session alone cannot start the move: the mailbox stays private", async () => {
    const owner = await enrolledOwner()
    const { accountId, messageId } = await privateMailboxWithOneMessage(owner.user)
    const app = sessionOnly(owner.user)
    const base = `/api/mailbox/encryption/accounts/${accountId}/make-transparent`

    const begin = await post(app, base)
    expect(begin.status).toBeGreaterThanOrEqual(400)
    expect(begin.status).toBeLessThan(500)
    // A code for another purpose does not confirm the move either.
    const otherCode = String(100000 + Math.floor(Math.random() * 900000))
    await redis.set(stepUpCodeKey(owner.user.id, "mailbox_reset"), hashToken(otherCode), "EX", 600)
    const wrongPurpose = await post(app, base, { stepUpCode: otherCode })
    expect(wrongPurpose.status).toBe(422)

    const pending = await app.request(`${base}/pending?entity=messages`)
    expect(pending.status).toBe(409)
    const finish = await post(app, `${base}/finish`)
    expect(finish.status).toBe(409)

    const [acct] = await readRow("accounts", accountId)
    expect(acct?.encryption_state).toBe("ready")
    expect(acct?.encryption_conversion).toBeNull()
    const [row] = await readRow("messages", messageId)
    expect(Number(row?.enc_version)).toBe(1)
  })

  test("after the step-up, rows without the mailbox key are refused, not rewritten", async () => {
    const owner = await enrolledOwner()
    const { accountId, messageId } = await privateMailboxWithOneMessage(owner.user)
    const app = sessionOnly(owner.user)
    const base = `/api/mailbox/encryption/accounts/${accountId}/make-transparent`

    const begin = await post(app, base, { stepUpCode: await transparentStepUpCode(owner.user.id) })
    expect(begin.status).toBe(200)
    const item = await pendingItem(app, base, messageId)
    expect(item).toBeDefined()

    const forged = {
      id: messageId,
      contentKeyWrapped: item?.contentKeyWrapped ?? "x",
      subject: "FORGED BY SESSION",
      textBody: "pay to the attacker's IBAN",
      snippet: "forged",
    }
    // No proof at all.
    const noProof = await post(app, `${base}/batch`, { messages: [forged] })
    // Keys the session made up.
    const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    const madeUp = await post(app, `${base}/batch`, {
      messages: [
        { ...forged, fieldKeys: { subject: random(), textBody: random(), snippet: random() } },
      ],
    })
    // The real keys, with invented plaintext.
    const realKeys = await ownerFieldKeys(owner, item as Record<string, unknown> & { id: string })
    const realKeysForgedText = await post(app, `${base}/batch`, {
      messages: [{ ...forged, fieldKeys: realKeys }],
    })
    // The real plaintext, one field dropped.
    const dropped = await post(app, `${base}/batch`, {
      messages: [
        {
          id: messageId,
          contentKeyWrapped: item?.contentKeyWrapped,
          subject: ORIGINAL.subject,
          snippet: ORIGINAL.snippet,
          fieldKeys: realKeys,
        },
      ],
    })
    for (const res of [noProof, madeUp, realKeysForgedText, dropped]) {
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { resealed: number; skipped: string[] } }
      expect(body.data.resealed).toBe(0)
      expect(body.data.skipped).toEqual([messageId])
    }

    const finish = await post(app, `${base}/finish`)
    expect(((await finish.json()) as { data: { done: boolean } }).data.done).toBe(false)
    const [acct] = await readRow("accounts", accountId)
    expect(acct?.encryption_state).toBe("ready")
    const [row] = await readRow("messages", messageId)
    expect(Number(row?.enc_version)).toBe(1)
  })

  test("the owner's browser, with the step-up and the opened keys, converts the mailbox", async () => {
    const owner = await enrolledOwner()
    const { accountId, messageId } = await privateMailboxWithOneMessage(owner.user)
    const app = sessionOnly(owner.user)
    const base = `/api/mailbox/encryption/accounts/${accountId}/make-transparent`

    const begin = await post(app, base, { stepUpCode: await transparentStepUpCode(owner.user.id) })
    expect(begin.status).toBe(200)
    // Resuming a move already under way needs no second code.
    expect((await post(app, base)).status).toBe(200)

    const item = (await pendingItem(app, base, messageId)) as Record<string, unknown> & {
      id: string
      contentKeyWrapped: string
    }
    const batch = await post(app, `${base}/batch`, {
      messages: [
        {
          id: messageId,
          contentKeyWrapped: item.contentKeyWrapped,
          ...ORIGINAL,
          htmlBody: null,
          rawHeaders: null,
          fieldKeys: await ownerFieldKeys(owner, item),
        },
      ],
    })
    expect(((await batch.json()) as { data: { resealed: number } }).data.resealed).toBe(1)
    const finish = await post(app, `${base}/finish`)
    expect(((await finish.json()) as { data: { done: boolean } }).data.done).toBe(true)

    const [acct] = await readRow("accounts", accountId)
    expect(acct?.encryption_state).toBe("managed")
    const rows = await readRow("messages", messageId)
    expect(Number(rows[0]?.enc_version)).toBe(2)
    const opened = await openManagedMailRows({
      orgId: owner.user.orgId,
      accountId,
      entity: "messages",
      rows,
      actor: { userId: owner.user.id },
      purpose: { kind: "web_view" },
    })
    expect(opened.get(messageId)?.subject).toBe(ORIGINAL.subject)
    expect(opened.get(messageId)?.textBody).toBe(ORIGINAL.textBody)
  })
})
