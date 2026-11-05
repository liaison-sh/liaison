// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, Task 6.4: personal mail contributes NOTHING to the server index
// or to the agent's referenced-entity context.
//
// Three sites, not one. Closing only the mail enrichment hook leaves the
// headline leak open, because a Meili document's `title` never comes from the
// hook: it comes from the generic projection reading the manifest's
// `indexFields.title = "subject"`. The case that matters is the DUAL-READ one, a
// conversation that is sealed but whose plaintext column has not been purged
// yet, which is the state every historical conversation sits in for the whole
// Phase 12 window. A test written against freshly ingested mail passes
// vacuously, because the column is already NULL there.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  ContentSuppressionTestAccess,
  isContentSuppressedForRow,
  isMailAccountSuppressed,
} from "~/modules/mailbox-crypto/content-suppression"
import { buildSearchDocument } from "~/modules/search/doc-builder"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

const BODY_NONCE = "VELLUMBODYNONCE"
const SUBJECT_NONCE = "VELLUMSUBJECTNONCE"

const conversationReg: SearchableEntityRegistration = {
  app: "mail",
  entityType: "conversation",
  schemaName: "app_mail",
  tableName: "conversations",
  readScope: "mail:conversations:read",
  indexFields: { title: "subject", labelSecondary: "from_email" },
  mentionable: true,
} as unknown as SearchableEntityRegistration

describe("Invariant K: mail content suppression at the generic projection", () => {
  let orgId: string
  let userId: string
  let readyAccountId: string
  let orgAccountId: string
  let readyConvId: string
  let orgConvId: string

  beforeAll(async () => {
    const user = await minimal.person((await createTestOrg()).id)
    orgId = user.orgId
    userId = user.id
    readyAccountId = crypto.randomUUID()
    orgAccountId = crypto.randomUUID()
    readyConvId = crypto.randomUUID()
    orgConvId = crypto.randomUUID()

    await withSystemDb("suppression-fixture", async (tx) => {
      for (const [id, ownerType, ownerId, state] of [
        [readyAccountId, "user", userId, "ready"],
        [orgAccountId, "org", null, "none"],
      ] as Array<[string, string, string | null, string]>) {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
                  ${ownerId}, 'gmail', ${`${id}@suppress.test`}, 'active', ${state})`)
      }
      // DUAL-READ STATE, deliberately. Both rows are written BEFORE any identity
      // exists, exactly as a pre-migration conversation was, so the Invariant P
      // trigger permits the plaintext `subject` that the whole test is about.
      for (const [id, acct, ownerType] of [
        [readyConvId, readyAccountId, "user"],
        [orgConvId, orgAccountId, "org"],
      ] as Array<[string, string, string]>) {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.conversations
            (id, org_id, account_id, owner_type, external_thread_id, subject, snippet,
             status, labels, is_read, is_starred, message_count, from_email)
          VALUES (${id}::uuid, ${orgId}::uuid, ${acct}::uuid, ${ownerType}, ${`t-${id}`},
                  ${`${SUBJECT_NONCE} quarterly`}, ${`${BODY_NONCE} preview`}, 'open', '[]',
                  false, false, 1, 'alice@example.test')`)
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.messages
            (org_id, conversation_id, account_id, external_message_id, message_references,
             from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body,
             html_body, snippet, is_read, is_starred, labels, direction, raw_headers, owner_type)
          VALUES (${orgId}::uuid, ${id}::uuid, ${acct}::uuid, ${`m-${id}`}, '[]',
                  '{"email":"alice@example.test"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                  ${`${SUBJECT_NONCE} quarterly`}, ${`${BODY_NONCE} full body`},
                  ${`<p>${BODY_NONCE}</p>`}, ${`${BODY_NONCE} preview`},
                  false, false, '[]'::jsonb, 'inbound', '{}'::jsonb, ${ownerType})`)
      }
    })
    ContentSuppressionTestAccess.resetCache()
  }, 60_000)

  afterAll(async () => {
    await withSystemDb("suppression-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
    })
    ContentSuppressionTestAccess.resetCache()
  })

  it("non-vacuity: the fixture really does hold a plaintext subject on a ready mailbox", async () => {
    const rows = await withSystemDb("suppression-nonvacuity", async (tx) =>
      extractRows<{ subject: string | null }>(
        await tx.execute(
          drizzleSql`SELECT subject FROM ${MAIL}.conversations WHERE id = ${readyConvId}::uuid`,
        ),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].subject).toContain(SUBJECT_NONCE)
  })

  it("recognises a ready personal mailbox and spares an org mailbox", async () => {
    ContentSuppressionTestAccess.resetCache()
    await withPrivilegedDb(orgId, "suppression-probe", async (tx) => {
      expect(await isMailAccountSuppressed(tx, orgId, readyAccountId)).toBe(true)
      expect(await isMailAccountSuppressed(tx, orgId, orgAccountId)).toBe(false)
      // Fails closed: an account id that resolves to nothing is suppressed.
      expect(await isMailAccountSuppressed(tx, orgId, crypto.randomUUID())).toBe(true)
      // A non-mail row is never suppressed.
      expect(
        await isContentSuppressedForRow(tx, orgId, "tickets", "ticket", { id: orgConvId }),
      ).toBe(false)
    })
  })

  it("keeps suppressing a mailbox that a seal failure moved from ready to blocked", async () => {
    // `ready -> blocked` is a LEGAL transition on any seal failure, and
    // `pending_enrollment -> paused` on an elapsed grace window. The database
    // trigger and the mail writers key on ARMED (an active identity exists)
    // precisely so neither transition can disarm them. Keying suppression on
    // the column instead meant one seal failure turned Meili titles, thread
    // titles, approval summaries and agent redaction back on, and the dual-read
    // plaintext columns still hold the real subjects for the whole window.
    const blockedAccountId = crypto.randomUUID()
    const pausedAccountId = crypto.randomUUID()
    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as CryptoKeyPair
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    await withSystemDb("suppression-blocked-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
        VALUES (${orgId}::uuid, ${userId}::uuid, 97,
                ${Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))},
                ${Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))},
                ${Buffer.from("attestation")}, 'active')
        ON CONFLICT DO NOTHING`)
      for (const [id, state] of [
        [blockedAccountId, "blocked"],
        [pausedAccountId, "paused"],
      ] as Array<[string, string]>) {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                  ${userId}::uuid, 'gmail', ${`${id}@suppress.test`}, 'active', ${state})`)
      }
    })
    ContentSuppressionTestAccess.resetCache()

    await withPrivilegedDb(orgId, "suppression-blocked-probe", async (tx) => {
      expect(await isMailAccountSuppressed(tx, orgId, blockedAccountId)).toBe(true)
      expect(await isMailAccountSuppressed(tx, orgId, pausedAccountId)).toBe(true)
      // Still not a licence to suppress an org mailbox.
      expect(await isMailAccountSuppressed(tx, orgId, orgAccountId)).toBe(false)
    })
    ContentSuppressionTestAccess.resetCache()
  })

  it("emits a null Meili title for a sealed-but-not-purged conversation", async () => {
    ContentSuppressionTestAccess.resetCache()
    const row = await withSystemDb("suppression-row", async (tx) =>
      extractRows<Record<string, unknown>>(
        await tx.execute(
          drizzleSql`SELECT * FROM ${MAIL}.conversations WHERE id = ${readyConvId}::uuid`,
        ),
      ),
    )
    const doc = await buildSearchDocument(conversationReg, orgId, row[0])
    // Non-vacuity: the document was built at all, and it still carries the
    // envelope fields the degraded search relies on.
    expect(doc.entity_id).toBe(readyConvId)
    expect(doc.title).toBeNull()
    expect(JSON.stringify(doc)).not.toContain(SUBJECT_NONCE)
    expect(JSON.stringify(doc)).not.toContain(BODY_NONCE)
  })

  it("still indexes the subject of an org mailbox conversation", async () => {
    ContentSuppressionTestAccess.resetCache()
    const row = await withSystemDb("suppression-row-org", async (tx) =>
      extractRows<Record<string, unknown>>(
        await tx.execute(
          drizzleSql`SELECT * FROM ${MAIL}.conversations WHERE id = ${orgConvId}::uuid`,
        ),
      ),
    )
    const doc = await buildSearchDocument(conversationReg, orgId, row[0])
    expect(String(doc.title)).toContain(SUBJECT_NONCE)
  })

  it("contributes no enrichment body and no message fragment for a ready mailbox", async () => {
    ContentSuppressionTestAccess.resetCache()
    const { registerMailSearchEnrichment, MailSearchEnrichmentTestAccess, planMailFragments } =
      await import("~/apps/mail/search-enrichment")
    const { lookupSearchEnrichment, buildEnrichmentHelpers, SearchEnrichmentTestAccess } =
      await import("~/modules/search/enrichment")
    const { entityRegistry } = await import("~/modules/apps/app-registries")
    SearchEnrichmentTestAccess.reset()
    MailSearchEnrichmentTestAccess.resetRegistration()
    registerMailSearchEnrichment()
    entityRegistry.set([orgId, "mail", "conversation"], {
      searchable: true,
      tableName: "conversations",
      readScope: "mail:conversations:read",
      indexFields: { title: "subject", labelSecondary: "from_email" },
      permissionFields: { readScope: "mail:conversations:read", participantIdsField: "owner_id" },
    } as never)
    try {
      const hook = lookupSearchEnrichment("mail", "conversation")
      expect(hook).toBeDefined()
      const readyRow = { id: readyConvId, account_id: readyAccountId, contact_id: null }
      const result = await hook?.(readyRow, buildEnrichmentHelpers(orgId))
      const body = typeof result === "string" ? result : (result?.bodyExtra ?? null)
      expect(body).toBeNull()

      // Message text lives in one FRAGMENT per message. Non-vacuity and
      // discrimination in one: the SAME planner over the org mailbox's message
      // carries the body, so an implementation that drops everything (or a
      // fixture with no messages) cannot pass.
      const messages = await withSystemDb("suppression-fragments", async (tx) =>
        extractRows<{ id: string; conversation_id: string }>(
          await tx.execute(
            drizzleSql`SELECT id, conversation_id FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`,
          ),
        ),
      )
      const orgMessage = messages.find((m) => m.conversation_id === orgConvId)?.id as string
      const readyMessage = messages.find((m) => m.conversation_id === readyConvId)?.id as string
      const plan = await planMailFragments(orgId, [
        { action: "upsert", messageId: orgMessage },
        { action: "upsert", messageId: readyMessage },
      ])
      expect(plan.docs).toHaveLength(1)
      expect(String(plan.docs[0]?.body)).toContain(BODY_NONCE)
      expect(plan.deleteIds).toEqual([`${orgId}_mail_message_${readyMessage}`])
    } finally {
      entityRegistry.delete([orgId, "mail", "conversation"])
      SearchEnrichmentTestAccess.reset()
      MailSearchEnrichmentTestAccess.resetRegistration()
    }
  })

  it("omits the label from the agent's referenced-entity context", async () => {
    ContentSuppressionTestAccess.resetCache()
    const { entityRegistry } = await import("~/modules/apps/app-registries")
    entityRegistry.set([orgId, "mail", "conversation"], {
      labelField: "subject",
      handlePrefix: "mail",
      tableName: "conversations",
    } as never)
    try {
      const resolved = await withPrivilegedDb(orgId, "suppression-refdisplay", async (tx) => {
        const { resolveReferenceDisplay } = await import("~/modules/threads/reference-display")
        return resolveReferenceDisplay(tx as unknown as RlsClient, {
          orgId,
          app: "mail",
          entityType: "conversation",
          entityId: readyConvId,
        })
      })
      // Non-vacuity: the reference still resolves to something the agent can
      // open. What it must not carry is the subject.
      expect(resolved.label.length).toBeGreaterThan(0)
      expect(`${resolved.label}${resolved.snippet ?? ""}`).not.toContain(SUBJECT_NONCE)
    } finally {
      entityRegistry.delete([orgId, "mail", "conversation"])
    }
  })
})
