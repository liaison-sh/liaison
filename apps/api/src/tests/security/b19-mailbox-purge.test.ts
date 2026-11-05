// SPDX-License-Identifier: FSL-1.1-ALv2
//
// b19, part two: the cutover proof and the purge.
//
//   T-SEC-7   verify-nonce / verify-decrypt: the client proves it read the whole
//             mailbox, and the server checks that proof without ever seeing
//             plaintext.
//   Task 12.4 the purge itself, which is IRREVERSIBLE and must refuse without
//             that proof, and which ends by re-running T-SEC-3 in its post-purge
//             mode through the exported `assertNoRecoverablePlaintext`.
//
// These are the tests standing between a user and permanent data loss, so every
// one of them is written to be falsifiable: each negative case is preceded by a
// positive one, the pre-purge fixture is asserted to actually hold plaintext,
// and the refusal cases assert both the throw AND that the plaintext survived.
//
// The fixture is a REAL pre-migration corpus: legacy plaintext rows inserted
// while the mailbox is disarmed, then armed, then sealed by the REAL backfill
// job. Nothing is hand-sealed, so a broken backfill cannot make this file pass.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { computeIdSetDigest, signAck } from "@liaison/mailbox-crypto/src/ack"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import {
  type AckSqlExecutor,
  collectPersonalMessageIds,
  issueVerifyNonce,
  MailboxAckError,
  type MailboxAckSubmission,
  readLedger,
  recordVerifiedAck,
  verifyMailboxAck,
} from "~/modules/mailbox-crypto/ack-verify"
import { runMailboxBackfillForUser } from "~/modules/mailbox-crypto/backfill-job"
import { MAIL_HEADER_ALLOWLIST } from "~/modules/mailbox-crypto/header-allowlist"
import { purgeMailboxPlaintext } from "~/modules/mailbox-crypto/purge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"
import { assertNoRecoverablePlaintext } from "~/tests/security/b19-mailbox-control-plane-clean.test"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)

const KEY_ID = 71
/** A second identity, with a DIFFERENT signing key, for the wrong-key-id case. */
const OTHER_KEY_ID = 72

const BODY_NONCE = "VERMILIONBODYNONCE"
const SUBJECT_NONCE = "VERMILIONSUBJECTNONCE"
const MESSAGE_COUNT = 12

describe("T-SEC-7 and Task 12.4: the cutover proof and the purge", () => {
  let orgId: string
  let userId: string
  let accountId: string
  let conversationId: string
  let fileId: string
  let signKeys: CryptoKeyPair

  async function sys<T>(reason: string, fn: (tx: AckSqlExecutor) => Promise<T>): Promise<T> {
    return withSystemDb(reason, (tx) => fn(tx as unknown as AckSqlExecutor))
  }

  /** The purge's privileged runner, pinned to the system connection in tests. */
  const purgeDeps = {
    privileged: <T>(
      _orgId: string,
      reason: string,
      fn: (tx: Pick<PrivilegedDb, "execute">) => Promise<T>,
    ) => withSystemDb(reason, (tx) => fn(tx as unknown as Pick<PrivilegedDb, "execute">)),
  }

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const user = await minimal.person((await createTestOrg()).id)
      orgId = user.orgId
      userId = user.id
      await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)

      accountId = crypto.randomUUID()
      conversationId = crypto.randomUUID()
      fileId = crypto.randomUUID()

      // The legacy corpus, inserted while DISARMED. This is what a mailbox that
      // predates the feature actually holds.
      await withSystemDb("b19-purge-seed", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${accountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                  ${userId}::uuid, 'gmail', ${`${accountId}@purge.test`}, 'active', 'ready')`)
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.conversations
            (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
             status, labels, is_read, is_starred, message_count, from_email)
          VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'user',
                  ${userId}::uuid, ${`thread-${conversationId}`},
                  ${`${SUBJECT_NONCE} conversation`}, ${`${BODY_NONCE} conversation`},
                  'open', '[]'::jsonb, false, false, ${MESSAGE_COUNT}, 'sender@purge.test')`)
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await tx.execute(drizzleSql`
            INSERT INTO ${MAIL}.messages
              (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
               from_address, to_addresses, direction, subject, text_body, html_body, snippet,
               raw_headers, created_at)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                    'user', ${userId}::uuid, ${`<purge-${i}-${crypto.randomUUID()}@purge.test>`},
                    ${JSON.stringify({ email: "sender@purge.test" })}::jsonb,
                    ${JSON.stringify([{ email: "me@purge.test" }])}::jsonb, 'inbound',
                    ${`${SUBJECT_NONCE} ${i}`}, ${`${BODY_NONCE} body ${i}`},
                    ${`<p>${BODY_NONCE} html ${i}</p>`}, ${`${BODY_NONCE} snippet ${i}`},
                    ${JSON.stringify({
                      "message-id": `<purge-${i}@purge.test>`,
                      from: "sender@purge.test",
                      subject: `${SUBJECT_NONCE} ${i}`,
                      "x-originating-ip": "203.0.113.7",
                    })}::jsonb,
                    ${new Date(Date.UTC(2026, 2, 1, 0, i)).toISOString()}::timestamptz)`)
        }
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.drafts
            (id, org_id, account_id, conversation_id, "to", cc, bcc, subject, html_body, text_body,
             created_by)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${accountId}::uuid, ${conversationId}::uuid,
                  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ${`${SUBJECT_NONCE} draft`},
                  ${`<p>${BODY_NONCE} draft</p>`}, ${`${BODY_NONCE} draft`}, ${userId}::uuid)`)

        // A pre-cutover attachment DERIVATIVE: a thumbnail and an LLM-written
        // description, both of which are content and both of which survive the
        // body purge unless step 7c runs.
        //
        // Its BYTES are marked sealed (`enc_version = 1`) so this fixture is
        // about the derivatives alone. Unsealed attachment bytes are a separate
        // property with its own case below: they block the cutover from being
        // declared complete, because nothing seals them and the purge only
        // removes their derivatives.
        const messageId = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id FROM ${MAIL}.messages
             WHERE account_id = ${accountId}::uuid LIMIT 1`),
        )[0]?.id
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.files
            (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
             storage_key, thumbnail_key, analysis_status, analysis_summary, analysis_model,
             enc_version)
          VALUES (${fileId}::uuid, ${orgId}::uuid, 'mail', 'message', ${messageId},
                  'contract.pdf', 'application/pdf', 1234,
                  ${`mail/${fileId}/contract.pdf`}, ${`thumbs/${fileId}.png`},
                  'done', ${`${BODY_NONCE} thumbnail description`}, 'gemini-2.5-flash', 1)`)
      })

      // ARM, then run the REAL backfill.
      const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair
      signKeys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      const otherSign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
      const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", signKeys.publicKey))
      const otherSignSpki = Buffer.from(await crypto.subtle.exportKey("spki", otherSign.publicKey))
      await withSystemDb("b19-purge-arm", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                  ${Buffer.from("attestation")}, 'active')`)
        // The second identity exists so "a signature made with a different key
        // id" is a real case rather than an unknown-key lookup failure.
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${OTHER_KEY_ID}, ${ecdhSpki}, ${otherSignSpki},
                  ${Buffer.from("attestation")}, 'retired')`)
      })
      await runMailboxBackfillForUser(userId, orgId, { batchIntervalMs: 0, batchSize: 50 })
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 180_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
    if (!orgId) return
    await withSystemDb("b19-purge-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${K}.files WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.drafts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function buildAck(
    overrides: Partial<MailboxAckSubmission> & { signWith?: CryptoKey; dropIds?: number } = {},
  ): Promise<MailboxAckSubmission> {
    const issued = await sys("b19-purge-nonce", (tx) => issueVerifyNonce(tx, userId, orgId))
    const allIds = await sys("b19-purge-ids", (tx) => collectPersonalMessageIds(tx, userId, orgId))
    const covered = overrides.dropIds ? allIds.slice(0, allIds.length - overrides.dropIds) : allIds
    const digest = await computeIdSetDigest(covered)
    const statement = {
      userId,
      accountId,
      keyId: overrides.keyId ?? KEY_ID,
      nonce: overrides.nonce ?? issued.nonce,
      count: overrides.count ?? covered.length,
      idSetDigest: digest,
      backfillCursor: overrides.backfillCursor ?? issued.backfillCursor,
    }
    const signature = Buffer.from(
      await signAck(overrides.signWith ?? signKeys.privateKey, statement),
    ).toString("base64")
    return {
      keyId: statement.keyId,
      nonce: statement.nonce,
      count: statement.count,
      idSetDigest: Buffer.from(digest).toString("base64"),
      signature: overrides.signature ?? signature,
      backfillCursor: statement.backfillCursor,
    }
  }

  async function submit(ack: MailboxAckSubmission): Promise<void> {
    await sys("b19-purge-verify", async (tx) => {
      const { digest } = await verifyMailboxAck(tx, userId, orgId, accountId, ack)
      await recordVerifiedAck(tx, userId, accountId, ack, digest)
    })
  }

  async function ledger() {
    return sys("b19-purge-ledger", (tx) => readLedger(tx, userId))
  }

  async function plaintextCounts() {
    return withSystemDb("b19-purge-counts", async (tx) => ({
      fullMessages: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.messages
           WHERE account_id = ${accountId}::uuid AND subject IS NOT NULL
             AND text_body IS NOT NULL AND html_body IS NOT NULL AND snippet IS NOT NULL`),
      )[0]?.n,
      disallowedHeaders: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.messages
           WHERE account_id = ${accountId}::uuid
             AND EXISTS (SELECT 1 FROM jsonb_object_keys(raw_headers) k
                          WHERE k NOT IN (${drizzleSql.join(
                            MAIL_HEADER_ALLOWLIST.map((h) => drizzleSql`${h}`),
                            drizzleSql.raw(", "),
                          )}))`),
      )[0]?.n,
      thumbnails: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.files
           WHERE org_id = ${orgId}::uuid AND thumbnail_key IS NOT NULL`),
      )[0]?.n,
      sealed: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.messages
           WHERE account_id = ${accountId}::uuid AND enc_version = 1`),
      )[0]?.n,
    }))
  }

  // ── The pre-purge fixture, asserted rather than assumed ───────────────────

  it("non-vacuity: the pre-purge fixture is sealed AND still holds full plaintext", async () => {
    const counts = await plaintextCounts()
    expect(counts.sealed).toBe(MESSAGE_COUNT)
    expect(counts.fullMessages).toBe(MESSAGE_COUNT)
    expect(counts.disallowedHeaders).toBeGreaterThan(0)
    expect(counts.thumbnails).toBe(1)
  })

  // ── The purge REFUSES with no acknowledgement on file ─────────────────────

  it("Task 12.4: a purge with no acknowledgement is refused and destroys nothing", async () => {
    const before = await plaintextCounts()
    expect(before.fullMessages).toBe(MESSAGE_COUNT)

    await expect(purgeMailboxPlaintext(userId, orgId, purgeDeps)).rejects.toThrow(MailboxAckError)

    const after = await plaintextCounts()
    expect(after.fullMessages).toBe(MESSAGE_COUNT)
    expect(after.thumbnails).toBe(1)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  // ── T-SEC-7 ───────────────────────────────────────────────────────────────

  it("T-SEC-7 non-vacuity: a fully correct acknowledgement IS accepted and recorded", async () => {
    const ack = await buildAck()
    await submit(ack)
    const row = await ledger()
    expect(row?.client_verified_at).not.toBeNull()
    expect(Number(row?.client_ack_count)).toBe(MESSAGE_COUNT)
    expect(row?.client_ack_key_id).toBe(KEY_ID)
    expect(row?.client_ack_account_id).toBe(accountId)
    // The nonce is BURNED: the issued-at marker is cleared, the value is kept so
    // the purge can re-verify the statement.
    expect(row?.verify_nonce_issued_at).toBeNull()
    expect(row?.client_ack_nonce).not.toBeNull()
    expect(row?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses a missing signature", async () => {
    const ack = await buildAck({ signature: "" })
    await expect(
      sys("b19-missing-sig", (tx) =>
        verifyMailboxAck(tx, userId, orgId, accountId, { ...ack, signature: "" }),
      ),
    ).rejects.toThrow(/BAD_SIGNATURE/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses a wrong signature", async () => {
    const ack = await buildAck()
    const flipped = Buffer.from(ack.signature, "base64")
    flipped[0] = (flipped[0] as number) ^ 0xff
    await expect(
      sys("b19-wrong-sig", (tx) =>
        verifyMailboxAck(tx, userId, orgId, accountId, {
          ...ack,
          signature: flipped.toString("base64"),
        }),
      ),
    ).rejects.toThrow(/BAD_SIGNATURE/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses a signature made under a different key id", async () => {
    // Signed correctly with the REAL private key, but claiming key id 72, whose
    // stored public key is a different Ed25519 key.
    const ack = await buildAck({ keyId: OTHER_KEY_ID })
    await expect(
      sys("b19-wrong-key-id", (tx) => verifyMailboxAck(tx, userId, orgId, accountId, ack)),
    ).rejects.toThrow(/BAD_SIGNATURE/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses a stale nonce", async () => {
    const ack = await buildAck()
    await withSystemDb("b19-age-nonce", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${K}.mailbox_migration_state
           SET verify_nonce_issued_at = now() - interval '2 hours'
         WHERE user_id = ${userId}::uuid`),
    )
    await expect(
      sys("b19-stale-nonce", (tx) => verifyMailboxAck(tx, userId, orgId, accountId, ack)),
    ).rejects.toThrow(/NONCE_EXPIRED/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses a reused nonce", async () => {
    const ack = await buildAck()
    await submit(ack)
    // Same acknowledgement, replayed. The first spend cleared the issued-at
    // marker, which is what makes the nonce single use.
    await expect(
      sys("b19-reused-nonce", (tx) => verifyMailboxAck(tx, userId, orgId, accountId, ack)),
    ).rejects.toThrow(/NONCE_EXPIRED/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses a digest short by one message id", async () => {
    // The client claims coverage of every message but signs a digest over one
    // fewer. The count matches, so only the independently recomputed digest can
    // catch it.
    const issued = await sys("b19-short-nonce", (tx) => issueVerifyNonce(tx, userId, orgId))
    const allIds = await sys("b19-short-ids", (tx) => collectPersonalMessageIds(tx, userId, orgId))
    const shortDigest = await computeIdSetDigest(allIds.slice(0, allIds.length - 1))
    const statement = {
      userId,
      accountId,
      keyId: KEY_ID,
      nonce: issued.nonce,
      count: allIds.length,
      idSetDigest: shortDigest,
      backfillCursor: issued.backfillCursor,
    }
    const ack: MailboxAckSubmission = {
      keyId: KEY_ID,
      nonce: issued.nonce,
      count: allIds.length,
      idSetDigest: Buffer.from(shortDigest).toString("base64"),
      signature: Buffer.from(await signAck(signKeys.privateKey, statement)).toString("base64"),
      backfillCursor: issued.backfillCursor,
    }
    await expect(
      sys("b19-short-digest", (tx) => verifyMailboxAck(tx, userId, orgId, accountId, ack)),
    ).rejects.toThrow(/DIGEST_MISMATCH/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 refuses an acknowledgement covering fewer messages than the server holds", async () => {
    const ack = await buildAck({ dropIds: 1 })
    await expect(
      sys("b19-short-count", (tx) => verifyMailboxAck(tx, userId, orgId, accountId, ack)),
    ).rejects.toThrow(/COUNT_MISMATCH/)
    expect((await ledger())?.plaintext_purged_at ?? null).toBeNull()
  })

  it("T-SEC-7 wires both endpoints on the mailbox route surface", () => {
    const routes = readFileSync(
      path.resolve(import.meta.dir, "../../modules/mailbox-keys/routes.ts"),
      "utf8",
    )
    expect(routes).toContain('mailboxRoutes.post("/verify-nonce"')
    expect(routes).toContain('mailboxRoutes.post("/verify-decrypt"')
    // The server-side plaintext HMAC that amendment A6 deleted must not return.
    // Matched against CODE, not prose: the file's own comment says the word.
    expect(routes).not.toContain("createHmac")
    expect(routes).not.toMatch(/["']HMAC["']/)
  })

  // ── The purge ─────────────────────────────────────────────────────────────

  it("Task 12.4 purges exactly the expected columns once an acknowledgement is on file", async () => {
    // A fresh, valid acknowledgement over the current corpus.
    await submit(await buildAck())
    const before = await plaintextCounts()
    expect(before.fullMessages).toBe(MESSAGE_COUNT)
    expect(before.disallowedHeaders).toBeGreaterThan(0)
    expect(before.thumbnails).toBe(1)

    const deleted: string[] = []
    const result = await purgeMailboxPlaintext(userId, orgId, {
      ...purgeDeps,
      deleteSearchDocuments: async (_index, ids) => {
        deleted.push(...ids)
      },
    })

    expect(result.messagesPurged).toBe(MESSAGE_COUNT)
    expect(result.conversationsPurged).toBe(1)
    expect(result.draftsPurged).toBe(1)
    expect(result.headersReduced).toBe(MESSAGE_COUNT)
    expect(result.derivativesCleared).toBe(1)
    expect(result.alreadyPurged).toBe(false)
    // Step 8 covered the mail entities AND the thread index.
    expect(deleted.length).toBeGreaterThan(0)

    const after = await plaintextCounts()
    expect(after.fullMessages).toBe(0)
    expect(after.disallowedHeaders).toBe(0)
    expect(after.thumbnails).toBe(0)
    // The ciphertext is untouched: the mailbox is still readable by its owner.
    expect(after.sealed).toBe(MESSAGE_COUNT)

    const row = await ledger()
    expect(row?.plaintext_purged_at).not.toBeNull()
    const stored = await withSystemDb("b19-purge-state", async (tx) =>
      extractRows<{
        meili_purged_at: Date | null
        derivatives_purged_at: Date | null
        backups_clear_after: Date | null
      }>(
        await tx.execute(drizzleSql`
          SELECT meili_purged_at, derivatives_purged_at, backups_clear_after
            FROM ${K}.mailbox_migration_state WHERE user_id = ${userId}::uuid`),
      ),
    )
    expect(stored[0]?.meili_purged_at).not.toBeNull()
    expect(stored[0]?.derivatives_purged_at).not.toBeNull()
    // Backup clearance is a DATE IN THE FUTURE, never a deletion: repo2's
    // objects are compliance locked and cannot be removed by anyone.
    expect(stored[0]?.backups_clear_after).not.toBeNull()
    expect(new Date(stored[0]?.backups_clear_after as Date).getTime()).toBeGreaterThan(Date.now())
    // Every attachment in scope is sealed, so this cutover really is complete.
    expect(result.unsealedAttachments).toBe(0)
    expect(result.cutoverComplete).toBe(true)
  }, 120_000)

  it("Task 12.4 refuses to declare the cutover complete while attachment bytes are unsealed", async () => {
    // Nothing seals HISTORICAL attachment bytes: the backfill covers messages,
    // conversations and drafts only. `purgeMailAttachmentDerivatives` clears
    // the thumbnail and the analysis text for every file in scope, sealed or
    // not, and the purge then stamped `plaintext_purged_at` and logged
    // "irreversible". After that an operator reading the ledger would conclude
    // the mailbox was closed while every attachment the user received before
    // enrolling was still cleartext in the object store.
    const rawFileId = crypto.randomUUID()
    const messageId = (
      await withSystemDb("b19-unsealed-att-msg", async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id FROM ${MAIL}.messages
             WHERE account_id = ${accountId}::uuid LIMIT 1`),
        ),
      )
    )[0]?.id as string
    await withSystemDb("b19-unsealed-att-seed", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${K}.files
          (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
           storage_key, enc_version)
        VALUES (${rawFileId}::uuid, ${orgId}::uuid, 'mail', 'message', ${messageId},
                'pre-enrollment.pdf', 'application/pdf', 999,
                ${`mail/${rawFileId}/pre-enrollment.pdf`}, 0)`),
    )
    try {
      const result = await purgeMailboxPlaintext(userId, orgId, {
        ...purgeDeps,
        deleteSearchDocuments: async () => {},
      })
      expect(result.unsealedAttachments).toBeGreaterThan(0)
      expect(result.cutoverComplete).toBe(false)
    } finally {
      await withSystemDb("b19-unsealed-att-cleanup", (tx) =>
        tx.execute(drizzleSql`DELETE FROM ${K}.files WHERE id = ${rawFileId}::uuid`),
      )
    }
  }, 120_000)

  it("Task 12.4 leaves only allowlisted header keys behind", async () => {
    const rows = await withSystemDb("b19-headers-after", async (tx) =>
      extractRows<{ raw_headers: Record<string, unknown> }>(
        await tx.execute(drizzleSql`
          SELECT raw_headers FROM ${MAIL}.messages WHERE account_id = ${accountId}::uuid`),
      ),
    )
    expect(rows).toHaveLength(MESSAGE_COUNT)
    const allowed = new Set<string>(MAIL_HEADER_ALLOWLIST)
    let nonEmpty = 0
    for (const row of rows) {
      const keys = Object.keys(row.raw_headers ?? {})
      for (const key of keys) expect(allowed.has(key)).toBe(true)
      if (keys.length > 0) nonEmpty++
    }
    // The allowlisted keys SURVIVED: a purge that emptied raw_headers entirely
    // would break threading and would pass a naive "no disallowed key" check.
    expect(nonEmpty).toBe(MESSAGE_COUNT)
  })

  it("Task 12.4 is idempotent: a second purge changes nothing", async () => {
    const second = await purgeMailboxPlaintext(userId, orgId, {
      ...purgeDeps,
      deleteSearchDocuments: async () => {},
    })
    expect(second.messagesPurged).toBe(0)
    expect(second.conversationsPurged).toBe(0)
    expect(second.draftsPurged).toBe(0)
    expect(second.headersReduced).toBe(0)
    expect(second.derivativesCleared).toBe(0)
    expect(second.alreadyPurged).toBe(true)
  }, 120_000)

  it("T-SEC-3 post-purge mode: no recoverable plaintext in the migrated corpus", async () => {
    await assertNoRecoverablePlaintext(orgId, accountId, {
      minMessages: MESSAGE_COUNT,
      minConversations: 1,
      phrases: [BODY_NONCE, SUBJECT_NONCE],
    })
  })
})
