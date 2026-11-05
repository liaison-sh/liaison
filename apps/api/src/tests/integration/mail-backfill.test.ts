// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-INT-3 (Task 12.1) and T-INT-2 (Task 12.2): the migration machinery.
//
// The fixture builds a REAL pre-migration corpus the only faithful way: the
// rows are inserted while the mailbox is DISARMED (no active identity), exactly
// as a mailbox that predates the feature looks, and the identity is inserted
// afterwards. Everything below then runs against an ARMED mailbox.
//
// Two properties are load bearing here and both have a named case:
//
//   * the cursor is `(created_at, id)`, not `(sent_at, id)`. `messages.sentAt`
//     is nullable and real rows carry NULL, so a keyset over it evaluates to
//     NULL for them and they are silently excluded from every batch after the
//     first while the job still reports completion. The fixture therefore holds
//     `sent_at IS NULL` rows and duplicate `sent_at` rows, and asserts every one
//     of them ends sealed.
//
//   * a half migrated mailbox stays WRITABLE. The Invariant P trigger fires on
//     values the encryption regime owns (an INSERT, or a changed value), not on
//     the mere presence of legacy plaintext, so `markRead`, `archive` and
//     `setLabels` on a not-yet-backfilled row still succeed. If that predicate
//     is ever widened to "any non-NULL guarded column", this test is what fails.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import {
  runMailboxBackfillForAccount,
  runMailboxBackfillForUser,
} from "~/modules/mailbox-crypto/backfill-job"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const KEY_ID = 61

const CORPUS_SIZE = 500
/** How many of the corpus rows carry `sent_at IS NULL`. The bug this pins made
 *  exactly these rows invisible to every batch after the first. */
const NULL_SENT_AT_ROWS = 4

interface SealedMessageRow {
  id: string
  subject: string | null
  text_body: string | null
  enc_version: number | null
  content_key_wrapped: Buffer | null
  content_key_epk: Buffer | null
  subject_ciphertext: Buffer | null
  text_body_ciphertext: Buffer | null
}

describe("T-INT-3 / T-INT-2: the mailbox backfill", () => {
  let orgId: string
  let userId: string
  let ecdh: CryptoKeyPair
  let bigAccountId: string
  let halfAccountId: string
  const legacyIds: string[] = []
  const nullSentAtIds: string[] = []
  const duplicateSentAtIds: string[] = []

  async function makeAccount(): Promise<string> {
    const id = crypto.randomUUID()
    await withSystemDb("t-int-3-account", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${userId}::uuid, 'gmail', ${`${id}@backfill.test`}, 'active', 'ready')`),
    )
    return id
  }

  /**
   * Insert a legacy PLAINTEXT corpus. Runs while the mailbox is disarmed, which
   * is the only way to produce the pre-migration state without fighting the
   * Invariant P trigger, and is exactly what a real historical mailbox holds.
   */
  async function seedLegacyCorpus(
    accountId: string,
    count: number,
    opts: { withNullSentAt?: boolean } = {},
  ): Promise<string[]> {
    const conversationId = crypto.randomUUID()
    const ids: string[] = []
    await withSystemDb("t-int-3-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
           status, labels, is_read, is_starred, message_count, from_email, created_at)
        VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'user', ${userId}::uuid,
                ${`thread-${conversationId}`}, ${"Legacy thread subject"}, ${"Legacy thread snippet"},
                'open', '[]'::jsonb, false, false, ${count}, 'sender@backfill.test',
                ${new Date(Date.UTC(2026, 0, 1)).toISOString()}::timestamptz)`)

      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID()
        ids.push(id)
        // Deliberate duplicates in created_at: the keyset is a ROW value, so the
        // id breaks the tie. A batch boundary landing inside a duplicate run is
        // exactly where a naive `created_at > cursor` loses rows.
        const createdAt = new Date(Date.UTC(2026, 0, 2, 0, Math.floor(i / 2))).toISOString()
        const nullSentAt = opts.withNullSentAt === true && i < NULL_SENT_AT_ROWS
        // Two rows share one sent_at, on top of the NULL rows.
        const duplicateSentAt = opts.withNullSentAt === true && (i === 10 || i === 11)
        if (nullSentAt) nullSentAtIds.push(id)
        if (duplicateSentAt) duplicateSentAtIds.push(id)
        const sentAt = nullSentAt
          ? null
          : duplicateSentAt
            ? new Date(Date.UTC(2026, 0, 3, 12, 0)).toISOString()
            : new Date(Date.UTC(2026, 0, 3, 0, i)).toISOString()
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.messages
            (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
             from_address, to_addresses, direction, subject, text_body, html_body, snippet,
             raw_headers, sent_at, created_at)
          VALUES (${id}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid, 'user',
                  ${userId}::uuid, ${`<legacy-${id}@backfill.test>`},
                  ${JSON.stringify({ email: "sender@backfill.test" })}::jsonb,
                  ${JSON.stringify([{ email: "me@backfill.test" }])}::jsonb, 'inbound',
                  ${`Legacy subject ${i}`}, ${`Legacy body ${i}`}, ${`<p>Legacy body ${i}</p>`},
                  ${`Legacy snippet ${i}`},
                  ${JSON.stringify({ "message-id": `<legacy-${i}@backfill.test>`, "x-legacy-trace": `trace-${i}` })}::jsonb,
                  ${sentAt}::timestamptz, ${createdAt}::timestamptz)`)
      }
    })
    return ids
  }

  async function messagesOf(accountId: string): Promise<SealedMessageRow[]> {
    return withSystemDb("t-int-3-read", async (tx) =>
      extractRows<SealedMessageRow>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, subject, text_body, enc_version, content_key_wrapped,
                 content_key_epk, subject_ciphertext, text_body_ciphertext
            FROM ${MAIL}.messages WHERE account_id = ${accountId}::uuid
           ORDER BY created_at ASC, id ASC`),
      ),
    )
  }

  async function openSubject(row: SealedMessageRow): Promise<string> {
    const contentKey = await unsealContentKey({
      privateKey: ecdh.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey)),
      userId,
      keyId: KEY_ID,
      wrapped: new Uint8Array(row.content_key_wrapped as Buffer),
      epkSpki: new Uint8Array(row.content_key_epk as Buffer),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.messageSubject(row.id),
      blob: new Uint8Array(row.subject_ciphertext as Buffer),
    })
    return new TextDecoder().decode(opened)
  }

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const user = await minimal.person((await createTestOrg()).id)
      orgId = user.orgId
      userId = user.id
      await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)

      bigAccountId = await makeAccount()
      halfAccountId = await makeAccount()
      const seeded = await seedLegacyCorpus(bigAccountId, CORPUS_SIZE, { withNullSentAt: true })
      legacyIds.push(...seeded)
      await seedLegacyCorpus(halfAccountId, 10)

      // ARM the mailbox only now: an active identity is what the trigger keys on.
      ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair
      const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
      const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
      await withSystemDb("t-int-3-arm", (tx) =>
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
    await withSystemDb("t-int-3-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  it("T-INT-3 non-vacuity: the fixture is a real unsealed legacy corpus", async () => {
    const rows = await messagesOf(bigAccountId)
    expect(rows).toHaveLength(CORPUS_SIZE)
    expect(rows.every((r) => Number(r.enc_version ?? 0) === 0)).toBe(true)
    expect(rows.every((r) => r.subject !== null && r.text_body !== null)).toBe(true)
    expect(rows.every((r) => r.content_key_wrapped === null)).toBe(true)

    const nullSentAt = await withSystemDb("t-int-3-nulls", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.messages
           WHERE account_id = ${bigAccountId}::uuid AND sent_at IS NULL`),
      ),
    )
    expect(nullSentAt[0]?.n).toBe(NULL_SENT_AT_ROWS)
    expect(duplicateSentAtIds).toHaveLength(2)
  })

  it("T-INT-3 resumes from its cursor after a kill, sealing every row exactly once", async () => {
    // Kill at batch 2: two batches of 100, then stop.
    const partial = await runMailboxBackfillForAccount(userId, orgId, bigAccountId, {
      batchSize: 100,
      batchIntervalMs: 0,
      maxBatches: 2,
    })
    expect(partial.completed).toBe(false)
    expect(partial.sealed).toBe(200)

    const afterPartial = await messagesOf(bigAccountId)
    const sealedFirst = afterPartial.filter((r) => Number(r.enc_version ?? 0) === 1)
    expect(sealedFirst).toHaveLength(200)
    // Fingerprint the already-sealed rows so "exactly once" is observable: a
    // re-seal would mint a new content key and change these bytes.
    const fingerprints = new Map(
      sealedFirst.map((r) => [
        r.id,
        Buffer.from(r.subject_ciphertext as Buffer).toString("base64"),
      ]),
    )

    const resumed = await runMailboxBackfillForAccount(userId, orgId, bigAccountId, {
      batchSize: 100,
      batchIntervalMs: 0,
    })
    expect(resumed.completed).toBe(true)

    const afterAll_ = await messagesOf(bigAccountId)
    expect(afterAll_).toHaveLength(CORPUS_SIZE)
    expect(afterAll_.every((r) => Number(r.enc_version ?? 0) === 1)).toBe(true)
    for (const row of afterAll_) {
      const before = fingerprints.get(row.id)
      if (before === undefined) continue
      expect(Buffer.from(row.subject_ciphertext as Buffer).toString("base64")).toBe(before)
    }
    // Plaintext is untouched by the backfill: the purge is what removes it.
    expect(afterAll_.every((r) => r.subject !== null)).toBe(true)
  }, 300_000)

  it("T-INT-3 cursor regression: every sent_at IS NULL and duplicate sent_at row is sealed", async () => {
    expect(nullSentAtIds.length).toBeGreaterThanOrEqual(3)
    const ids = [...nullSentAtIds, ...duplicateSentAtIds]
    const rows = await withSystemDb("t-int-3-cursor-case", async (tx) =>
      extractRows<{ id: string; enc_version: number }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, enc_version FROM ${MAIL}.messages
           WHERE id IN (${drizzleSql.join(
             ids.map((id) => drizzleSql`${id}::uuid`),
             drizzleSql.raw(", "),
           )})`),
      ),
    )
    expect(rows).toHaveLength(ids.length)
    expect(rows.every((r) => Number(r.enc_version) === 1)).toBe(true)
  })

  it("T-INT-3 is idempotent: a second full run writes nothing", async () => {
    const again = await runMailboxBackfillForUser(userId, orgId, {
      batchSize: 100,
      batchIntervalMs: 0,
    })
    expect(again.completed).toBe(true)
    const bigAgain = again.accounts.find((a) => a.accountId === bigAccountId)
    expect(bigAgain?.sealed).toBe(0)
    expect(again.messagesSealed).toBe(again.messagesTotal)
    expect(again.messagesTotal).toBe(CORPUS_SIZE + 10)
  }, 120_000)

  it("T-INT-3 records the ledger counters the migration UI reads", async () => {
    const ledger = await withSystemDb("t-int-3-ledger", async (tx) =>
      extractRows<{
        messages_total: string
        messages_sealed: string
        backfill_completed_at: Date | null
        backfill_cursor: Record<string, unknown> | null
      }>(
        await tx.execute(drizzleSql`
          SELECT messages_total, messages_sealed, backfill_completed_at, backfill_cursor
            FROM ${K}.mailbox_migration_state WHERE user_id = ${userId}::uuid`),
      ),
    )
    expect(Number(ledger[0]?.messages_total)).toBe(CORPUS_SIZE + 10)
    expect(Number(ledger[0]?.messages_sealed)).toBe(CORPUS_SIZE + 10)
    expect(ledger[0]?.backfill_completed_at).not.toBeNull()
    // The cursor is keyed by account, so two personal mailboxes resume apart.
    expect(Object.keys(ledger[0]?.backfill_cursor ?? {})).toContain(bigAccountId)
  })
})

describe("T-INT-2: a half migrated mailbox is fully usable", () => {
  let orgId: string
  let userId: string
  let accountId: string
  let conversationId: string
  let ecdh: CryptoKeyPair

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const user = await minimal.person((await createTestOrg()).id)
      orgId = user.orgId
      userId = user.id
      await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)

      accountId = crypto.randomUUID()
      conversationId = crypto.randomUUID()
      await withSystemDb("t-int-2-seed", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${accountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                  ${userId}::uuid, 'gmail', ${`${accountId}@half.test`}, 'active', 'ready')`)
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.conversations
            (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
             status, labels, is_read, is_starred, message_count, from_email)
          VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'user',
                  ${userId}::uuid, ${`thread-${conversationId}`}, 'Half migrated thread',
                  'Half migrated snippet', 'open', '[]'::jsonb, false, false, 8,
                  'sender@half.test')`)
        for (let i = 0; i < 8; i++) {
          await tx.execute(drizzleSql`
            INSERT INTO ${MAIL}.messages
              (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
               from_address, to_addresses, direction, subject, text_body, html_body, snippet,
               raw_headers, created_at)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                    'user', ${userId}::uuid, ${`<half-${i}-${crypto.randomUUID()}@half.test>`},
                    ${JSON.stringify({ email: "sender@half.test" })}::jsonb,
                    ${JSON.stringify([{ email: "me@half.test" }])}::jsonb, 'inbound',
                    ${`Half subject ${i}`}, ${`Half body ${i}`}, ${`<p>Half body ${i}</p>`},
                    ${`Half snippet ${i}`}, '{}'::jsonb,
                    ${new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString()}::timestamptz)`)
        }
      })

      ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair
      const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      const ecdhSpki2 = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
      const signSpki2 = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
      await withSystemDb("t-int-2-arm", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${K}.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki2}, ${signSpki2},
                  ${Buffer.from("attestation")}, 'active')`),
      )

      // Seal three of the eight, leaving the mailbox genuinely half migrated.
      await runMailboxBackfillForAccount(userId, orgId, accountId, {
        batchSize: 3,
        batchIntervalMs: 0,
        maxBatches: 1,
      })
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 180_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
    if (!orgId) return
    await withSystemDb("t-int-2-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  async function rows(): Promise<SealedMessageRow[]> {
    return withSystemDb("t-int-2-read", async (tx) =>
      extractRows<SealedMessageRow>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, subject, text_body, enc_version, content_key_wrapped,
                 content_key_epk, subject_ciphertext, text_body_ciphertext
            FROM ${MAIL}.messages WHERE account_id = ${accountId}::uuid
           ORDER BY created_at ASC, id ASC`),
      ),
    )
  }

  it("non-vacuity: the mailbox really is half migrated", async () => {
    const all = await rows()
    expect(all).toHaveLength(8)
    const sealed = all.filter((r) => Number(r.enc_version ?? 0) === 1)
    const legacy = all.filter((r) => Number(r.enc_version ?? 0) === 0)
    expect(sealed.length).toBeGreaterThan(0)
    expect(legacy.length).toBeGreaterThan(0)
    expect(sealed).toHaveLength(3)
    expect(legacy).toHaveLength(5)
  })

  it("renders every message through both representations", async () => {
    const all = await rows()
    const recipientSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey))
    let fromCiphertext = 0
    let fromPlaintext = 0
    for (const row of all) {
      if (Number(row.enc_version ?? 0) === 1) {
        const contentKey = await unsealContentKey({
          privateKey: ecdh.privateKey,
          recipientEcdhSpki: recipientSpki,
          userId,
          keyId: KEY_ID,
          wrapped: new Uint8Array(row.content_key_wrapped as Buffer),
          epkSpki: new Uint8Array(row.content_key_epk as Buffer),
        })
        const subject = new TextDecoder().decode(
          await openField({
            contentKey,
            context: mailboxAad.messageSubject(row.id),
            blob: new Uint8Array(row.subject_ciphertext as Buffer),
          }),
        )
        const body = new TextDecoder().decode(
          await openField({
            contentKey,
            context: mailboxAad.messageTextBody(row.id),
            blob: new Uint8Array(row.text_body_ciphertext as Buffer),
          }),
        )
        expect(subject).toMatch(/^Half subject \d$/)
        expect(body).toMatch(/^Half body \d$/)
        fromCiphertext++
      } else {
        expect(row.subject).toMatch(/^Half subject \d$/)
        expect(row.text_body).toMatch(/^Half body \d$/)
        fromPlaintext++
      }
    }
    // Every one of the eight resolved, through one representation or the other.
    expect(fromCiphertext + fromPlaintext).toBe(8)
    expect(fromCiphertext).toBeGreaterThan(0)
    expect(fromPlaintext).toBeGreaterThan(0)
  }, 60_000)

  it("markRead succeeds on a legacy plaintext row of the enrolled mailbox", async () => {
    const legacy = (await rows()).find((r) => Number(r.enc_version ?? 0) === 0)
    expect(legacy).toBeDefined()
    await withSystemDb("t-int-2-mark-read", (tx) =>
      tx.execute(
        drizzleSql`UPDATE ${MAIL}.messages SET is_read = true WHERE id = ${legacy?.id}::uuid`,
      ),
    )
    const after = await withSystemDb("t-int-2-mark-read-check", async (tx) =>
      extractRows<{ is_read: boolean }>(
        await tx.execute(
          drizzleSql`SELECT is_read FROM ${MAIL}.messages WHERE id = ${legacy?.id}::uuid`,
        ),
      ),
    )
    expect(after[0]?.is_read).toBe(true)
  })

  it("archive succeeds on a legacy plaintext conversation of the enrolled mailbox", async () => {
    await withSystemDb("t-int-2-archive", (tx) =>
      tx.execute(
        drizzleSql`UPDATE ${MAIL}.conversations SET status = 'archived' WHERE id = ${conversationId}::uuid`,
      ),
    )
    const after = await withSystemDb("t-int-2-archive-check", async (tx) =>
      extractRows<{ status: string }>(
        await tx.execute(
          drizzleSql`SELECT status FROM ${MAIL}.conversations WHERE id = ${conversationId}::uuid`,
        ),
      ),
    )
    expect(after[0]?.status).toBe("archived")
  })

  it("setLabels succeeds on a legacy plaintext row of the enrolled mailbox", async () => {
    const legacy = (await rows()).find((r) => Number(r.enc_version ?? 0) === 0)
    expect(legacy).toBeDefined()
    await withSystemDb("t-int-2-labels", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${MAIL}.messages SET labels = ${JSON.stringify(["INBOX", "IMPORTANT"])}::jsonb
         WHERE id = ${legacy?.id}::uuid`),
    )
    const after = await withSystemDb("t-int-2-labels-check", async (tx) =>
      extractRows<{ labels: string[] }>(
        await tx.execute(
          drizzleSql`SELECT labels FROM ${MAIL}.messages WHERE id = ${legacy?.id}::uuid`,
        ),
      ),
    )
    expect(after[0]?.labels).toEqual(["INBOX", "IMPORTANT"])
  })
})
