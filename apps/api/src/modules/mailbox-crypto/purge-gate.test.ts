// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The purge gate, and the draft backfill it depends on.
//
// Two defects this file exists to pin, both of them silent data loss:
//
//   1. The gate proved something about `app_mail.messages` and then authorised
//      destruction in three tables. The acknowledgement is derived from message
//      ids only, so a backfill that stopped after its messages phase (a restart,
//      or BACKFILL_MAX_CONSECUTIVE_FAILURES in the conversations phase) leaves a
//      corpus where every message is sealed, the ack verifies, and the purge
//      NULLs conversation subjects and draft bodies with no ciphertext behind
//      them.
//
//   2. The draft backfill chose its body with `html_body ?? text_body`. Drafts
//      shipped NOT NULL DEFAULT '', so a legacy draft whose html_body is '' and
//      whose text_body holds the content sealed NOTHING while still being
//      stamped enc_version = 1, and the purge then NULLed the text body. A draft
//      carrying BOTH bodies lost whichever one was not chosen.
//
// Nothing here is hand-sealed: the sealing is done by the REAL backfill job
// against a real identity row, so a broken backfill cannot make this file pass.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { runMailboxBackfillForUser } from "~/modules/mailbox-crypto/backfill-job"
import { assertFullySealed } from "~/modules/mailbox-crypto/purge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const KEY_ID = 91

type Executor = Pick<PrivilegedDb, "execute">

const TEXT_ONLY = "PURGEGATE text only draft body"
const BOTH_TEXT = "PURGEGATE both, the text alternative"
const BOTH_HTML = "<p>PURGEGATE both, the html alternative</p>"

describe("the purge gate covers every table the purge destroys", () => {
  let orgId: string
  let userId: string
  let accountId: string
  let ecdhKeys: CryptoKeyPair

  async function sys<T>(reason: string, fn: (tx: Executor) => Promise<T>): Promise<T> {
    return withSystemDb(reason, (tx) => fn(tx as unknown as Executor))
  }

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const user = await minimal.person((await createTestOrg()).id)
      orgId = user.orgId
      userId = user.id
      await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)
      accountId = crypto.randomUUID()

      await sys("purge-gate-seed-account", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${accountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                  ${userId}::uuid, 'gmail', ${`${accountId}@gate.test`}, 'active', 'ready')`),
      )

      const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair
      const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      ecdhKeys = ecdh
      const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
      const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
      await sys("purge-gate-arm", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${K}.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                  ${Buffer.from("attestation")}, 'active')`),
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 180_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
    if (!orgId) return
    await sys("purge-gate-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.drafts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  async function clearCorpus(): Promise<void> {
    await sys("purge-gate-clear", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.drafts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.mailbox_migration_state WHERE user_id = ${userId}::uuid`,
      )
    })
  }

  /**
   * Run a seed with the mailbox DISARMED, which is the only way to write the
   * legacy plaintext a pre-feature corpus actually holds: Invariant P refuses a
   * plaintext INSERT on an armed account, deliberately. Arming is the existence
   * of an ACTIVE identity, so retiring it for the duration is the same lever the
   * trigger reads.
   */
  async function legacy<T>(fn: () => Promise<T>): Promise<T> {
    await sys("purge-gate-disarm", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${K}.user_mailbox_identities SET status = 'retired'
         WHERE user_id = ${userId}::uuid`),
    )
    try {
      return await fn()
    } finally {
      await sys("purge-gate-rearm", (tx) =>
        tx.execute(drizzleSql`
          UPDATE ${K}.user_mailbox_identities SET status = 'active'
           WHERE user_id = ${userId}::uuid`),
      )
    }
  }

  /** A legacy conversation, inserted with plaintext exactly as a pre-feature row holds it. */
  async function seedConversation(subject: string, snippet: string): Promise<string> {
    const id = crypto.randomUUID()
    await legacy(() =>
      sys("purge-gate-seed-conv", (tx) =>
        tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
           status, labels, is_read, is_starred, message_count, from_email)
        VALUES (${id}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'user', ${userId}::uuid,
                ${`thread-${id}`}, ${subject}, ${snippet}, 'open', '[]'::jsonb, false, false, 1,
                'sender@gate.test')`),
      ),
    )
    return id
  }

  async function seedMessage(conversationId: string): Promise<string> {
    const id = crypto.randomUUID()
    await legacy(() =>
      sys("purge-gate-seed-msg", (tx) =>
        tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.messages
          (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
           from_address, to_addresses, direction, subject, text_body, html_body, snippet,
           raw_headers)
        VALUES (${id}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid, 'user',
                ${userId}::uuid, ${`<gate-${id}@gate.test>`},
                ${JSON.stringify({ email: "sender@gate.test" })}::jsonb,
                ${JSON.stringify([{ email: "me@gate.test" }])}::jsonb, 'inbound',
                'gate subject', 'gate text body', '<p>gate html body</p>', 'gate snippet',
                '{"message-id": "<gate@x>"}'::jsonb)`),
      ),
    )
    return id
  }

  /** The legacy shape migration 0035's header records: NOT NULL DEFAULT ''. */
  async function seedDraft(
    conversationId: string,
    subject: string,
    htmlBody: string,
    textBody: string,
  ): Promise<string> {
    const id = crypto.randomUUID()
    await legacy(() =>
      sys("purge-gate-seed-draft", (tx) =>
        tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.drafts
          (id, org_id, account_id, conversation_id, "to", cc, bcc, subject, html_body, text_body,
           created_by)
        VALUES (${id}::uuid, ${orgId}::uuid, ${accountId}::uuid, ${conversationId}::uuid,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ${subject}, ${htmlBody}, ${textBody},
                ${userId}::uuid)`),
      ),
    )
    return id
  }

  async function gate(): Promise<unknown> {
    return sys("purge-gate-run", (tx) =>
      assertFullySealed(tx, [accountId]).then(
        () => null,
        (e: unknown) => e,
      ),
    )
  }

  async function draftRow(id: string) {
    return (
      await sys("purge-gate-read-draft", async (tx) =>
        extractRows<Record<string, any>>(
          await tx.execute(drizzleSql`SELECT * FROM ${MAIL}.drafts WHERE id = ${id}::uuid`),
        ),
      )
    )[0] as Record<string, any>
  }

  async function openDraftField(row: Record<string, any>, column: string, suffix: string) {
    const contentKey = await unsealContentKey({
      privateKey: ecdhKeys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", ecdhKeys.publicKey)),
      userId,
      keyId: KEY_ID,
      wrapped: new Uint8Array(row.content_key_wrapped),
      epkSpki: new Uint8Array(row.content_key_epk),
    })
    return new TextDecoder().decode(
      await openField({
        contentKey,
        context: mailboxAad.draftBody(`${row.id}${suffix}`),
        blob: new Uint8Array(row[column]),
      }),
    )
  }

  it("refuses when a conversation still carries unsealed plaintext", async () => {
    await clearCorpus()
    const conversationId = await seedConversation("gate conversation subject", "gate snippet")
    await seedMessage(conversationId)
    // Seal the MESSAGES only, which is exactly the half-migrated state a
    // restart or a failing conversations phase leaves behind. The stored
    // acknowledgement is derived from message ids, so it would verify here.
    await sys("purge-gate-seal-messages-only", (tx) =>
      tx.execute(drizzleSql`
          UPDATE ${MAIL}.messages
             SET enc_version = 1, enc_key_id = ${KEY_ID},
                 subject_ciphertext = '\\x00'::bytea, text_body_ciphertext = '\\x00'::bytea,
                 html_body_ciphertext = '\\x00'::bytea, snippet_ciphertext = '\\x00'::bytea,
                 content_key_wrapped = '\\x00'::bytea, content_key_epk = '\\x00'::bytea
           WHERE account_id = ${accountId}::uuid`),
    )

    const err = (await gate()) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("COUNT_MISMATCH")
    expect(String(err.message)).toContain("conversation")
  }, 120_000)

  it("refuses when a draft still carries unsealed plaintext", async () => {
    await clearCorpus()
    const conversationId = await seedConversation("gate conversation subject", "gate snippet")
    await seedMessage(conversationId)
    await seedDraft(conversationId, "gate draft subject", "", TEXT_ONLY)
    await sys("purge-gate-seal-all-but-drafts", async (tx) => {
      await tx.execute(drizzleSql`
          UPDATE ${MAIL}.messages
             SET enc_version = 1, enc_key_id = ${KEY_ID},
                 subject_ciphertext = '\\x00'::bytea, text_body_ciphertext = '\\x00'::bytea,
                 html_body_ciphertext = '\\x00'::bytea, snippet_ciphertext = '\\x00'::bytea,
                 content_key_wrapped = '\\x00'::bytea, content_key_epk = '\\x00'::bytea
           WHERE account_id = ${accountId}::uuid`)
      await tx.execute(drizzleSql`
          UPDATE ${MAIL}.conversations
             SET enc_version = 1, enc_key_id = ${KEY_ID},
                 subject_ciphertext = '\\x00'::bytea, snippet_ciphertext = '\\x00'::bytea,
                 content_key_wrapped = '\\x00'::bytea, content_key_epk = '\\x00'::bytea
           WHERE account_id = ${accountId}::uuid`)
    })

    const err = (await gate()) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("COUNT_MISMATCH")
    expect(String(err.message)).toContain("draft")
  }, 120_000)

  it("seals a legacy draft whose body lives in text_body and html_body is the empty default", async () => {
    await clearCorpus()
    const conversationId = await seedConversation("gate conversation subject", "gate snippet")
    await seedMessage(conversationId)
    const draftId = await seedDraft(conversationId, "gate draft subject", "", TEXT_ONLY)

    await runMailboxBackfillForUser(userId, orgId, { batchIntervalMs: 0, batchSize: 50 })

    const row = await draftRow(draftId)
    expect(row.enc_version).toBe(1)
    // Non-vacuity: the row must actually carry a body ciphertext. Before the
    // fix `html_body ?? text_body` evaluated to '' here, `isPresent` treated
    // that as absence, and this column stayed NULL while enc_version became 1.
    expect(row.body_ciphertext).not.toBeNull()
    expect(await openDraftField(row, "body_ciphertext", "")).toBe(TEXT_ONLY)
  }, 180_000)

  it("seals BOTH bodies of a legacy draft that carries a text and an html alternative", async () => {
    await clearCorpus()
    const conversationId = await seedConversation("gate conversation subject", "gate snippet")
    await seedMessage(conversationId)
    const draftId = await seedDraft(conversationId, "gate draft subject", BOTH_HTML, BOTH_TEXT)

    await runMailboxBackfillForUser(userId, orgId, { batchIntervalMs: 0, batchSize: 50 })

    const row = await draftRow(draftId)
    expect(row.enc_version).toBe(1)
    expect(row.body_ciphertext).not.toBeNull()
    expect(row.html_body_ciphertext).not.toBeNull()
    expect(await openDraftField(row, "body_ciphertext", "")).toBe(BOTH_TEXT)
    expect(await openDraftField(row, "html_body_ciphertext", ":html")).toBe(BOTH_HTML)

    // Both bodies are behind ciphertext, so the gate now lets the purge run.
    expect(await gate()).toBeNull()
  }, 180_000)

  it("refuses a message whose non-allowlisted headers have no header ciphertext", async () => {
    // Step 7b reduces `raw_headers` to the section 5.2 allowlist and the
    // reduction is IRREVERSIBLE. Nothing in the browser can open
    // `raw_headers_ciphertext` today, so a header the purge drops is gone for
    // everyone including the owner. That is an accepted cost only where the
    // ciphertext actually exists; where it does not, the purge would destroy
    // headers the backfill never sealed, which is the same defect the
    // uncovered-column gate exists to prevent, one column further along.
    await clearCorpus()
    const conversationId = await seedConversation("gate conversation subject", "gate snippet")
    await seedMessage(conversationId)
    // A legacy header map, written while DISARMED exactly as a pre-feature row
    // holds it. Invariant P forbids adding one to an armed mailbox, which is
    // why this has to go through the same disarm the other seeds use.
    await legacy(() =>
      sys("purge-gate-legacy-headers", (tx) =>
        tx.execute(drizzleSql`
          UPDATE ${MAIL}.messages
             SET raw_headers = raw_headers || '{"x-originating-ip": "203.0.113.7"}'::jsonb
           WHERE account_id = ${accountId}::uuid`),
      ),
    )
    await runMailboxBackfillForUser(userId, orgId, { batchIntervalMs: 0, batchSize: 50 })
    // Non-vacuity: the backfill sealed those headers, so the gate passes.
    expect(await gate()).toBeNull()

    // The state a row sealed by an earlier build is in: stamped, bodies
    // covered, and no header ciphertext at all. Only the ciphertext column is
    // touched here, so the trigger is not involved.
    await sys("purge-gate-naked-headers", (tx) =>
      tx.execute(drizzleSql`
          UPDATE ${MAIL}.messages SET raw_headers_ciphertext = NULL
           WHERE account_id = ${accountId}::uuid`),
    )

    const err = (await gate()) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("COUNT_MISMATCH")
    expect(String(err.message)).toContain("header")
  }, 180_000)

  it("refuses a stamped row whose plaintext column has no matching ciphertext", async () => {
    await clearCorpus()
    const conversationId = await seedConversation("gate conversation subject", "gate snippet")
    await seedMessage(conversationId)
    await seedDraft(conversationId, "gate draft subject", BOTH_HTML, BOTH_TEXT)
    await runMailboxBackfillForUser(userId, orgId, { batchIntervalMs: 0, batchSize: 50 })
    expect(await gate()).toBeNull()

    // enc_version = 1 is not proof of coverage: knock out one ciphertext and
    // the plaintext behind it becomes destroyable with nothing to restore it.
    await sys("purge-gate-uncover", (tx) =>
      tx.execute(drizzleSql`
          UPDATE ${MAIL}.drafts SET html_body_ciphertext = NULL
           WHERE account_id = ${accountId}::uuid`),
    )

    const err = (await gate()) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("COUNT_MISMATCH")
  }, 180_000)
})
