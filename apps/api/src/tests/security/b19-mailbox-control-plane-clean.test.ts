// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, end to end: no mail plaintext in the control plane.
//
// One fixture, a real enrolled personal mailbox ingested through the REAL
// sandbox bridge, then every derived surface is checked against two distinctive
// nonce phrases that exist nowhere else in the database.
//
//   T-SEC-3   the plaintext columns themselves, read with BYPASSRLS
//   T-SEC-4   the search projection, the thread title, the agent's ref context
//   T-SEC-8   the agent's persisted tool-result metadata and replay buffer
//   T-SEC-9   events, audit log, timeline entries
//   T-SEC-11  approval requests: tool_params, current_payload, summary, outbox
//   T-SEC-13  Redis and the stream registry
//   T-SEC-15  the two server export surfaces (part one; attachments are Phase 7)
//
// EVERY negative assertion in this file is preceded by a positive one. A pure
// "the phrase is nowhere" test passes trivially against a pipeline that ingested
// nothing, sealed nothing, or threw before it emitted, which is exactly the
// failure mode a leak test must not have. Where a group's non-vacuity precondition
// fails, that is a HARD failure, never a skip.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import {
  summarizeMailCompose,
  summarizeMailForward,
  summarizeMailReply,
} from "~/apps/mail/summarizers"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
// The BullMQ connection deliberately: it is the one WITHOUT a `keyPrefix`, so a
// SCAN of the whole keyspace and a read of each key address the same names. The
// prefixed client would SCAN raw names and then GET prefixed ones, and every
// read would miss.
import { redisBullMQ } from "~/lib/redis"
import {
  MailPlaintextRedactionTestAccess,
  redactMailToolResult,
} from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { getLiveAgentStream, recordAgentStreamEvent } from "~/modules/agent/runtime/stream-registry"
import { createApprovalRequestInBundle } from "~/modules/apps/execute-tool"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { ContentSuppressionTestAccess } from "~/modules/mailbox-crypto/content-suppression"
import { MAIL_HEADER_ALLOWLIST } from "~/modules/mailbox-crypto/header-allowlist"
import { buildSearchDocument } from "~/modules/search/doc-builder"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL_SCHEMA = schemaRef("app_mail")
const MAIL = drizzleSql.raw(`"${MAIL_SCHEMA}"`)

/** The two phrases. They exist in the fixture's mail and nowhere else. */
const BODY_NONCE = "CINNABARBODYNONCE"
const SUBJECT_NONCE = "CINNABARSUBJECTNONCE"
const KEY_ID = 57

const CONVERSATION_COUNT = 3
const MESSAGES_PER_CONVERSATION = 7

/**
 * T-SEC-3, exported so Task 12.4's post-purge fixture and Task 14.3 can re-run
 * the identical assertion against a MIGRATED corpus rather than a fresh one.
 * Do not duplicate it: the whole point is that both corpora are held to the same
 * bar by the same code.
 */
export async function assertNoRecoverablePlaintext(
  orgId: string,
  accountId: string,
  opts: { minMessages: number; minConversations: number; phrases: string[] },
): Promise<void> {
  const { messages, conversations } = await withSystemDb("t-sec-3-read", async (tx) => ({
    messages: extractRows<{
      id: string
      subject: string | null
      text_body: string | null
      html_body: string | null
      snippet: string | null
      raw_headers: Record<string, unknown> | null
    }>(
      await tx.execute(drizzleSql`
        SELECT id, subject, text_body, html_body, snippet, raw_headers
          FROM ${MAIL}.messages WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid`),
    ),
    conversations: extractRows<{ id: string; subject: string | null; snippet: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id, subject, snippet FROM ${MAIL}.conversations
         WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  }))

  // 1. Non-vacuity, and this is the whole point of the test. A zero-row query is
  //    a hard failure, never a pass.
  expect(messages.length).toBeGreaterThanOrEqual(opts.minMessages)
  expect(conversations.length).toBeGreaterThanOrEqual(opts.minConversations)

  // 2. Every covered row, not a sample and not a LIMIT.
  for (const row of messages) {
    expect(row.subject).toBeNull()
    expect(row.text_body).toBeNull()
    expect(row.html_body).toBeNull()
    expect(row.snippet).toBeNull()
  }
  for (const row of conversations) {
    expect(row.subject).toBeNull()
    expect(row.snippet).toBeNull()
  }

  // 3. `raw_headers` carries only the section 5.2 envelope allowlist, and at
  //    least one row was actually REDUCED, so an ingest that wrote empty headers
  //    cannot pass this.
  const allowed = new Set(MAIL_HEADER_ALLOWLIST as readonly string[])
  let reduced = 0
  for (const row of messages) {
    const headers = row.raw_headers ?? {}
    for (const key of Object.keys(headers)) {
      expect(allowed.has(key.toLowerCase())).toBe(true)
    }
    if (Object.keys(headers).length > 0) reduced++
  }
  expect(reduced).toBeGreaterThan(0)

  // 4. Belt and braces: no phrase anywhere in the concatenated selected columns,
  //    so a column added later is covered without editing this loop.
  const concatenated = JSON.stringify({ messages, conversations })
  for (const phrase of opts.phrases) {
    expect(concatenated).not.toContain(phrase)
  }
}

describe("Invariant K: the control plane holds no mail plaintext", () => {
  let orgId: string
  let userId: string
  let readyAccountId: string
  let orgAccountId: string
  let bundle: string
  let conversationIds: string[] = []
  let orgConversationId = ""

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const user = await minimal.person((await createTestOrg()).id)
      orgId = user.orgId
      userId = user.id
      await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)

      const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair
      const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
      const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))

      readyAccountId = crypto.randomUUID()
      orgAccountId = crypto.randomUUID()
      orgConversationId = crypto.randomUUID()

      await withSystemDb("b19-fixture", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO kernel.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                  ${Buffer.from("attestation")}, 'active')`)
        for (const [id, ownerType, ownerId, state] of [
          [readyAccountId, "user", userId, "ready"],
          [orgAccountId, "org", null, "none"],
        ] as Array<[string, string, string | null, string]>) {
          await tx.execute(drizzleSql`
            INSERT INTO ${MAIL}.accounts
              (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
               sync_status, encryption_state)
            VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
                    ${ownerId}, 'gmail', ${`${id}@b19.test`}, 'active', ${state})`)
        }
        // The ORG mailbox's conversation is the discriminating control: it keeps
        // its plaintext, so every "the phrase is absent" assertion below has a
        // matching "and here it IS present" counterpart.
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.conversations
            (id, org_id, account_id, owner_type, external_thread_id, subject, snippet, status,
             labels, is_read, is_starred, message_count, from_email)
          VALUES (${orgConversationId}::uuid, ${orgId}::uuid, ${orgAccountId}::uuid, 'org',
                  'b19-org-thread', ${`${SUBJECT_NONCE} org copy`}, ${`${BODY_NONCE} org copy`},
                  'open', '[]'::jsonb, false, false, 1, 'alice@b19.test')`)
      })

      const { initSandboxPool } = await import("~/modules/apps/sandbox/pool")
      const { loadBundle } = await import("~/modules/apps/sandbox/bundle-loader")
      await initSandboxPool()
      initEventBus()
      DurableConsumersTestAccess.reset()
      registerEventSubscribers({
        bufferAndBroadcast: async () => {},
        broadcast: async () => {},
        addThreadMember: () => {},
        removeThreadMember: () => {},
      } as never)
      const source = await loadBundle(path.resolve(import.meta.dir, "../../apps/mail/handlers.ts"))
      bundle = `${source}
async function __test_processMessages(params, ctx) { await processMessages(params.messages, params.account, ctx, "initial") }`
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 180_000)

  afterAll(async () => {
    resetEventBus()
    await releaseAppSchemaJsLock("app_mail")
    if (!orgId) return
    await withSystemDb("b19-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  /**
   * Write plaintext back onto a sealed row, reproducing the PRE-PURGE dual-read
   * state every historical conversation sits in for the whole Phase 12 window.
   *
   * The Invariant P trigger arms on the existence of an active identity, so the
   * only way to produce that state is the way a real pre-migration mailbox did:
   * with the mailbox disarmed. The identity is restored immediately afterwards,
   * so every assertion still runs against an ARMED mailbox. This is not a way
   * around the trigger; it is the only faithful way to build the fixture, and it
   * is why `subject` is restored to NULL after each such case.
   */
  async function withDisarmedMailbox(fn: () => Promise<void>): Promise<void> {
    const identity = await withSystemDb("b19-disarm-read", async (tx) =>
      extractRows<{
        ecdh_public_key: Buffer
        sign_public_key: Buffer
        keyring_attestation: Buffer
      }>(
        await tx.execute(drizzleSql`
          SELECT ecdh_public_key, sign_public_key, keyring_attestation
            FROM kernel.user_mailbox_identities WHERE user_id = ${userId}::uuid`),
      ),
    )
    expect(identity).toHaveLength(1)
    await withSystemDb("b19-disarm", (tx) =>
      tx.execute(
        drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      ),
    )
    try {
      await fn()
    } finally {
      await withSystemDb("b19-rearm", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO kernel.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${identity[0].ecdh_public_key},
                  ${identity[0].sign_public_key}, ${identity[0].keyring_attestation}, 'active')`),
      )
    }
  }

  function fixtureMessages(threadIndex: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      externalMessageId: `<b19-${threadIndex}-${i}-${crypto.randomUUID()}@b19.test>`,
      externalProviderId: `p${threadIndex}-${i}`,
      externalThreadId: `<b19-thread-${threadIndex}@b19.test>`,
      from: { name: "Nadia", email: "nadia@b19.test" },
      to: [{ email: `${readyAccountId}@b19.test` }],
      cc: [],
      bcc: [],
      subject: `${SUBJECT_NONCE} thread ${threadIndex} message ${i}`,
      textBody: `${BODY_NONCE} thread ${threadIndex} message ${i}, which no server may read.`,
      htmlBody: `<p>${BODY_NONCE} ${threadIndex}.${i}</p>`,
      snippet: `${BODY_NONCE} ${threadIndex}.${i}`,
      headers: {
        "message-id": `<b19-${threadIndex}-${i}@b19.test>`,
        subject: `${SUBJECT_NONCE} thread ${threadIndex} message ${i}`,
        "x-originating-ip": "203.0.113.9",
      },
      inReplyTo: null,
      references: [],
      labels: ["INBOX"],
      isRead: false,
      isStarred: false,
      sentAt: new Date(Date.UTC(2026, 0, 15, 10, threadIndex * 10 + i)).toISOString(),
      direction: "inbound",
    }))
  }

  /**
   * Run the REAL ingest: the real rpc bridge (real db methods, real
   * `mailbox_sealAndInsert`, real `emit`), only the network-facing methods
   * stubbed. A stubbed seal would validate the stub, and a stubbed `emit` would
   * make every event assertion below meaningless.
   */
  async function runIngest(
    accountId: string,
    encryptionState: string,
    messages: unknown[],
  ): Promise<{ error: unknown; emitted: unknown[] }> {
    const emitted: unknown[] = []
    return withPrivilegedDb(orgId, "b19-ingest", async (tx) => {
      // The page write queues its events host side: read back exactly what it
      // persisted to the outbox in this transaction (every mail event queued
      // after this point, in order).
      const [mark] = extractRows<{ seq: string | null }>(
        await tx.execute(drizzleSql`SELECT max(seq)::text AS seq FROM kernel.pending_events`),
      )
      const since = mark?.seq ?? "0"
      const real = createRpcBridge(
        "mail",
        userId,
        orgId,
        tx as unknown as RlsClient,
        mailAppManifest as never,
      )
      const bridge: Record<string, unknown> = {
        ...real,
        enqueueJob: async () => {},
        connections_getToken: async () => "token",
        connections_getAccounts: async () => "[]",
        fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
        imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
        smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
        log_info: () => {},
        log_warn: () => {},
        log_error: () => {},
        log_debug: () => {},
      }
      const { executeInSandbox } = await import("~/modules/apps/sandbox/executor")
      const { getSandboxPool } = await import("~/modules/apps/sandbox/pool")
      let error: unknown = null
      try {
        await executeInSandbox({
          pool: getSandboxPool(),
          bundleSource: bundle,
          exportName: "__test_processMessages",
          params: {
            messages,
            account: {
              id: accountId,
              owner_type: encryptionState === "none" ? "org" : "user",
              owner_id: encryptionState === "none" ? null : userId,
              encryption_state: encryptionState,
            },
          },
          bridge,
          timeoutMs: 120_000,
        } as never)
      } catch (e) {
        error = e
      }
      const persisted = extractRows<{ payload: unknown }>(
        await tx.execute(drizzleSql`
          SELECT payload FROM kernel.pending_events
           WHERE seq > ${since}::bigint AND org_id = ${orgId}::uuid AND payload->>'app' = 'mail'
           ORDER BY seq`),
      )
      emitted.push(...persisted.map((row) => row.payload))
      return { error, emitted }
    })
  }

  // ── The corpus. Every later group reads it. ────────────────────────────────
  const readyEmits: unknown[] = []
  let orgEmits: unknown[] = []

  it("ingests a real sealed corpus (the precondition every group below depends on)", async () => {
    for (let t = 0; t < CONVERSATION_COUNT; t++) {
      // Two sync pages per thread, as a real mailbox delivers them: the first
      // creates the conversation, the second rolls an EXISTING one up, so both
      // the create and the update emits are produced and inspected below.
      const thread = fixtureMessages(t, MESSAGES_PER_CONVERSATION)
      for (const page of [thread.slice(0, 1), thread.slice(1)]) {
        const { error, emitted } = await runIngest(readyAccountId, "ready", page)
        expect(error).toBeNull()
        readyEmits.push(...emitted)
      }
    }
    const orgRun = await runIngest(orgAccountId, "none", fixtureMessages(99, 2))
    expect(orgRun.error).toBeNull()
    orgEmits = orgRun.emitted

    const rows = await withSystemDb("b19-corpus", async (tx) => ({
      messages: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.messages
           WHERE account_id = ${readyAccountId}::uuid`),
      )[0].n,
      conversations: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.conversations
           WHERE account_id = ${readyAccountId}::uuid`),
      )[0].n,
      sealed: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${MAIL}.messages
           WHERE account_id = ${readyAccountId}::uuid AND enc_version = 1
             AND subject_ciphertext IS NOT NULL AND text_body_ciphertext IS NOT NULL`),
      )[0].n,
    }))
    expect(rows.messages).toBe(CONVERSATION_COUNT * MESSAGES_PER_CONVERSATION)
    expect(rows.conversations).toBe(CONVERSATION_COUNT)
    // The rows are SEALED, not merely empty. Without this the whole file could
    // pass against an ingest that silently dropped every field.
    expect(rows.sealed).toBe(CONVERSATION_COUNT * MESSAGES_PER_CONVERSATION)

    conversationIds = (
      await withSystemDb("b19-conv-ids", async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT id FROM ${MAIL}.conversations WHERE account_id = ${readyAccountId}::uuid`),
        ),
      )
    ).map((r) => r.id)
    expect(conversationIds).toHaveLength(CONVERSATION_COUNT)
  }, 180_000)

  // ── T-SEC-3 ───────────────────────────────────────────────────────────────
  describe("T-SEC-3: a privileged read over the plaintext columns recovers nothing", () => {
    it("finds no recoverable plaintext across the whole corpus", async () => {
      await assertNoRecoverablePlaintext(orgId, readyAccountId, {
        minMessages: CONVERSATION_COUNT * MESSAGES_PER_CONVERSATION,
        minConversations: CONVERSATION_COUNT,
        phrases: [BODY_NONCE, SUBJECT_NONCE],
      })
    })

    it("still returns plaintext for a shared org mailbox, so the query discriminates", async () => {
      const rows = await withSystemDb("b19-org-plaintext", async (tx) =>
        extractRows<{ subject: string | null }>(
          await tx.execute(drizzleSql`
            SELECT subject FROM ${MAIL}.conversations
             WHERE account_id = ${orgAccountId}::uuid AND subject IS NOT NULL`),
        ),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some((r) => (r.subject ?? "").includes(SUBJECT_NONCE))).toBe(true)
    })
  })

  // ── T-SEC-9 ───────────────────────────────────────────────────────────────
  describe("T-SEC-9: events, audit log and timeline entries carry ids only", () => {
    let pendingPayloads = ""
    let auditChanges = ""
    let timelineText = ""

    beforeAll(async () => {
      // Drive the durable consumers over the events the ingest actually emitted,
      // exactly as the outbox worker would, so `audit_log` and `timeline_entries`
      // are populated by the real handlers rather than by hand.
      // The whole event lives inside `pending_events.payload`, so the app /
      // entity / action discriminators are json fields, not columns.
      const events = await withSystemDb("b19-pending", async (tx) =>
        extractRows<{ id: string; payload: Record<string, unknown> }>(
          await tx.execute(drizzleSql`
            SELECT id, payload FROM kernel.pending_events
             WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'mail'`),
        ),
      )
      for (const event of events) {
        await runDurableConsumers({
          eventId: event.id,
          event: { ...event.payload, orgId } as never,
        })
      }
      // Scoped to the ENCRYPTED mailbox. The org mailbox's events legitimately
      // carry its subject and snippet, and a scan that swept them in would fail
      // for exactly the reason the design says it should not: an unencrypted
      // mailbox is out of scope. The "still carries the subject" case below is
      // what asserts the org half positively.
      const scans = await withSystemDb("b19-scan", async (tx) => ({
        pending: extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM kernel.pending_events
             WHERE org_id = ${orgId}::uuid
               AND payload->'data'->>'accountId' = ${readyAccountId}`),
        )[0].t,
        audit: extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(changes::text, ' '), '') AS t FROM kernel.audit_log
             WHERE org_id = ${orgId}::uuid AND changes->>'accountId' = ${readyAccountId}`),
        )[0].t,
        timeline: extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(summary || ' ' || coalesce(field_changes::text, ''), ' '), '') AS t
              FROM kernel.timeline_entries
             WHERE org_id = ${orgId}::uuid
               AND entity_id IN (
                 SELECT id::text FROM ${MAIL}.conversations WHERE account_id = ${readyAccountId}::uuid
                 UNION ALL
                 SELECT id::text FROM ${MAIL}.messages WHERE account_id = ${readyAccountId}::uuid)`),
        )[0].t,
      }))
      pendingPayloads = scans.pending
      auditChanges = scans.audit
      timelineText = scans.timeline
    }, 120_000)

    it("non-vacuity: the ingest produced events, audit rows and timeline entries", async () => {
      const counts = await withSystemDb("b19-counts", async (tx) => ({
        events: extractRows<{ n: number }>(
          await tx.execute(drizzleSql`
            SELECT count(*)::int AS n FROM kernel.pending_events
             WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'mail'`),
        )[0].n,
        audit: extractRows<{ n: number }>(
          await tx.execute(drizzleSql`
            SELECT count(*)::int AS n FROM kernel.audit_log
             WHERE org_id = ${orgId}::uuid AND app = 'mail'
               AND changes->>'accountId' = ${readyAccountId}`),
        )[0].n,
        timeline: extractRows<{ n: number }>(
          await tx.execute(drizzleSql`
            SELECT count(*)::int AS n FROM kernel.timeline_entries WHERE org_id = ${orgId}::uuid`),
        )[0].n,
      }))
      // A sealing bug that threw before the emit would produce zero of each and
      // would otherwise pass every assertion below.
      expect(counts.events).toBeGreaterThan(0)
      expect(counts.audit).toBeGreaterThan(0)
      expect(counts.timeline).toBeGreaterThan(0)
      expect(pendingPayloads.length).toBeGreaterThan(0)
      expect(auditChanges.length).toBeGreaterThan(0)
    })

    it("no phrase appears in pending_events, audit_log or timeline_entries", () => {
      for (const phrase of [BODY_NONCE, SUBJECT_NONCE]) {
        expect(pendingPayloads).not.toContain(phrase)
        expect(auditChanges).not.toContain(phrase)
        expect(timelineText).not.toContain(phrase)
      }
    })

    it("the conversation create emit for a ready mailbox carries ids only", () => {
      const created = readyEmits.filter(
        (e) =>
          (e as { entity: string; action: string }).entity === "conversation" &&
          (e as { action: string }).action === "create",
      ) as Array<{ data: Record<string, unknown> }>
      expect(created.length).toBe(CONVERSATION_COUNT)
      for (const event of created) {
        expect(Object.keys(event.data).sort()).toEqual(["accountId", "id"])
      }
    })

    it("the already-clean emits stay exactly as narrow as they are", () => {
      const msgCreate = readyEmits.filter(
        (e) =>
          (e as { entity: string }).entity === "message" &&
          (e as { action: string }).action === "create",
      ) as Array<{ data: Record<string, unknown> }>
      expect(msgCreate.length).toBeGreaterThan(0)
      for (const event of msgCreate) {
        // S16 added the sync origin and the inbound envelope facts the new-email
        // producer decides on (labels, read state, Gmail receipt time). None of
        // them is content (the phrase scan above covers every value).
        // senderAuth is the sender authentication verdict ("pass", "fail" or
        // "none") read off the provider's Authentication-Results header.
        expect(Object.keys(event.data).sort()).toEqual([
          "accountId",
          "conversationId",
          "direction",
          "from",
          "id",
          "internalDate",
          "isRead",
          "labels",
          "origin",
          "senderAuth",
        ])
      }
      const convUpdate = readyEmits.filter(
        (e) =>
          (e as { entity: string }).entity === "conversation" &&
          (e as { action: string }).action === "update",
      ) as Array<{ data: Record<string, unknown> }>
      expect(convUpdate.length).toBeGreaterThan(0)
      for (const event of convUpdate) {
        expect(event.data.snippet).toBeUndefined()
        expect(event.data.subject).toBeUndefined()
      }
    })

    it("STILL carries the subject for a mailbox that is not encrypted", () => {
      // The strip is conditional, not global. Without this the whole group could
      // be satisfied by deleting the field for everyone.
      const created = orgEmits.find(
        (e) =>
          (e as { entity: string; action: string }).entity === "conversation" &&
          (e as { action: string }).action === "create",
      ) as { data: Record<string, unknown> } | undefined
      expect(created).toBeDefined()
      expect(String(created?.data.subject)).toContain(SUBJECT_NONCE)
    })
  })

  // ── T-SEC-4 ───────────────────────────────────────────────────────────────
  describe("T-SEC-4: the search projection and the agent's reference context", () => {
    const conversationReg = {
      app: "mail",
      entityType: "conversation",
      schemaName: "app_mail",
      tableName: "conversations",
      readScope: "mail:conversations:read",
      indexFields: { title: "subject", labelSecondary: "from_email" },
      mentionable: true,
    } as unknown as SearchableEntityRegistration

    it("the ORG conversation's document DOES carry its subject (non-vacuity)", async () => {
      ContentSuppressionTestAccess.resetCache()
      const row = await withSystemDb("b19-org-row", async (tx) =>
        extractRows<Record<string, unknown>>(
          await tx.execute(drizzleSql`
            SELECT * FROM ${MAIL}.conversations WHERE id = ${orgConversationId}::uuid`),
        ),
      )
      const doc = await buildSearchDocument(conversationReg, orgId, row[0])
      expect(String(doc.title)).toContain(SUBJECT_NONCE)
    })

    it("a sealed-but-not-purged conversation projects a null title and no phrase", async () => {
      // The DUAL-READ case, which is what actually leaks. `subject` is written
      // back onto a sealed row here to reproduce exactly the state every
      // historical conversation sits in for the whole Phase 12 window: sealed,
      // reindexed, and still holding its plaintext column.
      ContentSuppressionTestAccess.resetCache()
      const conversationId = conversationIds[0]
      await withDisarmedMailbox(async () => {
        await withSystemDb("b19-dual-read", (tx) =>
          tx.execute(drizzleSql`
            UPDATE ${MAIL}.conversations SET subject = ${`${SUBJECT_NONCE} historical`}
             WHERE id = ${conversationId}::uuid`),
        )
      })
      const row = await withSystemDb("b19-dual-read-row", async (tx) =>
        extractRows<Record<string, unknown>>(
          await tx.execute(
            drizzleSql`SELECT * FROM ${MAIL}.conversations WHERE id = ${conversationId}::uuid`,
          ),
        ),
      )
      expect(String(row[0].subject)).toContain(SUBJECT_NONCE)

      const doc = await buildSearchDocument(conversationReg, orgId, row[0])
      expect(doc.title).toBeNull()
      expect(JSON.stringify(doc)).not.toContain(SUBJECT_NONCE)
      expect(JSON.stringify(doc)).not.toContain(BODY_NONCE)

      await withDisarmedMailbox(async () => {
        await withSystemDb("b19-dual-read-restore", (tx) =>
          tx.execute(drizzleSql`
            UPDATE ${MAIL}.conversations SET subject = NULL WHERE id = ${conversationId}::uuid`),
        )
      })
    })
  })

  // ── T-SEC-11 ──────────────────────────────────────────────────────────────
  describe("T-SEC-11: gated mail sends store sealed payloads and content-free summaries", () => {
    const REPLY_NONCE = "CINNABARREPLYNONCE"
    const COMPOSE_SUBJECT_NONCE = "CINNABARCOMPOSESUBJECT"
    const QUOTE_NONCE = "CINNABARQUOTENONCE"

    beforeAll(async () => {
      const conversationId = conversationIds[2]
      const { createThread } = await import("~/modules/threads/thread")
      const thread = await withPrivilegedDb(orgId, "b19-approval-thread", (tx) =>
        createThread(tx as unknown as RlsClient, {
          orgId,
          userId,
          participantIds: [userId],
          title: "b19 approvals",
          type: "thread",
        }),
      )
      const summaries = await withPrivilegedDb(orgId, "b19-summaries", async (tx) => ({
        reply: await summarizeMailReply(
          { conversationId, textBody: `${REPLY_NONCE} drafted` },
          { tx: tx as unknown as RlsClient, orgId, userId },
        ),
        forward: await summarizeMailForward(
          { conversationId, to: [{ email: "carol@b19.test" }], note: `${REPLY_NONCE} note` },
          { tx: tx as unknown as RlsClient, orgId, userId },
        ),
        compose: await summarizeMailCompose(
          {
            accountId: readyAccountId,
            to: [{ email: "dave@b19.test" }],
            subject: `${COMPOSE_SUBJECT_NONCE} plan`,
            textBody: `${REPLY_NONCE} composed`,
          },
          { tx: tx as unknown as RlsClient, orgId, userId },
        ),
      }))

      // Staged sequentially, and the ids are not kept: every assertion below
      // reads the persisted rows back, which is what proves what actually
      // landed in the database rather than what the call returned.
      await createApprovalRequestInBundle({
        orgId,
        threadId: thread.id,
        toolName: "mail:reply",
        toolParams: {
          conversationId,
          textBody: `${REPLY_NONCE} drafted`,
          subject: `${COMPOSE_SUBJECT_NONCE} re`,
          quotedOriginal: `${QUOTE_NONCE} the original`,
          to: [{ email: "nadia@b19.test" }],
        },
        requestedBy: userId,
        summary: summaries.reply,
        appName: "mail",
        toolShortName: "reply",
        requesterCanApprove: true,
        stepBundleId: null,
      })
      await createApprovalRequestInBundle({
        orgId,
        threadId: thread.id,
        toolName: "mail:forward",
        toolParams: {
          conversationId,
          to: [{ email: "carol@b19.test" }],
          note: `${REPLY_NONCE} note`,
          quotedOriginal: `${QUOTE_NONCE} the original`,
        },
        requestedBy: userId,
        summary: summaries.forward,
        appName: "mail",
        toolShortName: "forward",
        requesterCanApprove: true,
        stepBundleId: null,
      })
      await createApprovalRequestInBundle({
        orgId,
        threadId: thread.id,
        toolName: "mail:compose",
        toolParams: {
          accountId: readyAccountId,
          to: [{ email: "dave@b19.test" }],
          subject: `${COMPOSE_SUBJECT_NONCE} plan`,
          textBody: `${REPLY_NONCE} composed`,
        },
        requestedBy: userId,
        summary: summaries.compose,
        appName: "mail",
        toolShortName: "compose",
        requesterCanApprove: true,
        stepBundleId: null,
      })
    }, 120_000)

    it("non-vacuity: three approvals exist, each with a non-empty summary and a sealed payload", async () => {
      const rows = await withSystemDb("b19-approvals", async (tx) =>
        extractRows<{
          id: string
          summary: Record<string, unknown> | null
          current_payload: Record<string, unknown> | null
          resource_owner_id: string | null
        }>(
          await tx.execute(drizzleSql`
            SELECT id, summary, current_payload, resource_owner_id FROM kernel.approval_requests
             WHERE org_id = ${orgId}::uuid ORDER BY created_at`),
        ),
      )
      expect(rows).toHaveLength(3)
      for (const row of rows) {
        expect(typeof (row.summary as { title?: string })?.title).toBe("string")
        expect(((row.summary as { title?: string })?.title ?? "").length).toBeGreaterThan(0)
        // The payload really was SEALED, not merely emptied.
        expect(row.current_payload?.mailboxSealed).toBe(true)
        expect(typeof row.current_payload?.contentKeyWrapped).toBe("string")
        // The C6 regression guard: personal-resource approvals route to the owner.
        expect(row.resource_owner_id).toBe(userId)
      }
    })

    it("no phrase appears in tool_params, current_payload, summary or the approval outbox row", async () => {
      const scanned = await withSystemDb("b19-approval-scan", async (tx) => ({
        approvals: extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(tool_params::text || ' ' || current_payload::text || ' ' || summary::text, ' '), '') AS t
              FROM kernel.approval_requests WHERE org_id = ${orgId}::uuid`),
        )[0].t,
        outbox: extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM kernel.pending_events
             WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'approval_request'`),
        )[0].t,
      }))
      expect(scanned.approvals.length).toBeGreaterThan(0)
      expect(scanned.outbox.length).toBeGreaterThan(0)
      for (const phrase of [
        REPLY_NONCE,
        COMPOSE_SUBJECT_NONCE,
        QUOTE_NONCE,
        SUBJECT_NONCE,
        BODY_NONCE,
      ]) {
        expect(scanned.approvals).not.toContain(phrase)
        expect(scanned.outbox).not.toContain(phrase)
      }
    })

    it("the summary still names the correspondent and an id, so the approver can act", async () => {
      const rows = await withSystemDb("b19-approval-summaries", async (tx) =>
        extractRows<{ summary: { title?: string; subtitle?: string } }>(
          await tx.execute(drizzleSql`
            SELECT summary FROM kernel.approval_requests WHERE org_id = ${orgId}::uuid`),
        ),
      )
      const titles = rows.map((r) => r.summary?.title ?? "").join(" | ")
      expect(titles).toContain("nadia@b19.test")
      expect(titles).toContain("carol@b19.test")
      expect(titles).toContain("dave@b19.test")
      expect(titles).toContain(conversationIds[2].slice(0, 8))
    })
  })

  // ── T-SEC-8 and T-SEC-13 ──────────────────────────────────────────────────
  describe("T-SEC-8 and T-SEC-13: agent metadata, the replay buffer and Redis", () => {
    const streamThreadId = crypto.randomUUID()

    it("redacts a mail__read result and records only the redacted shape", async () => {
      MailPlaintextRedactionTestAccess.resetCache()
      const messageIds = await withSystemDb("b19-msg-ids", async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT id FROM ${MAIL}.messages WHERE account_id = ${readyAccountId}::uuid LIMIT 3`),
        ),
      )
      expect(messageIds.length).toBe(3)
      const toolResult = {
        conversation: {
          id: conversationIds[0],
          subject: `${SUBJECT_NONCE} read`,
          account: { id: readyAccountId },
        },
        messages: messageIds.map((m) => ({
          id: m.id,
          textBody: `${BODY_NONCE} body`,
          snippet: BODY_NONCE,
        })),
      }
      const redacted = (await redactMailToolResult(orgId, "mail__read", toolResult)) as {
        messageIds: string[]
        byteLength: number
        redacted: boolean
      }
      // Positive shape first: the documented replacement, with a non-empty
      // messageIds so the agent can still ask for those messages again.
      expect(redacted.redacted).toBe(true)
      expect(redacted.messageIds.sort()).toEqual(messageIds.map((m) => m.id).sort())
      expect(redacted.byteLength).toBeGreaterThan(0)
      expect(JSON.stringify(redacted)).not.toContain(BODY_NONCE)
      expect(JSON.stringify(redacted)).not.toContain(SUBJECT_NONCE)

      // The replay buffer sees the redacted value, which is the whole point of
      // redacting BEFORE `recordAgentStreamEvent`. The registry only tracks a
      // thread between `start` and `done`, so the turn is driven as a real one.
      await recordAgentStreamEvent(streamThreadId, orgId, "start")
      await recordAgentStreamEvent(streamThreadId, orgId, "tool_call", {
        toolCallId: "tc-1",
        toolName: "mail__read",
        args: { conversationId: conversationIds[0] },
      })
      await recordAgentStreamEvent(streamThreadId, orgId, "tool_result", {
        toolCallId: "tc-1",
        result: redacted,
      })
      const snapshot = await getLiveAgentStream(streamThreadId)
      // Non-vacuity: the registry really did record the turn AND the tool result
      // reached it. A registry that dropped the event would otherwise produce
      // the same "no phrase found" as a correct one.
      expect(snapshot).toBeTruthy()
      expect(snapshot?.toolCalls).toHaveLength(1)
      expect(snapshot?.toolCalls[0]?.result).toBeTruthy()
      const serialized = JSON.stringify(snapshot)
      expect(serialized).toContain("mail__read")
      expect(serialized).not.toContain(BODY_NONCE)
      expect(serialized).not.toContain(SUBJECT_NONCE)
    })

    it("no phrase appears anywhere in the Redis keyspace", async () => {
      const redis = redisBullMQ
      let cursor = "0"
      let keyCount = 0
      const hits: string[] = []
      do {
        const [next, keys] = await redis.scan(cursor, "COUNT", 500)
        cursor = next
        keyCount += keys.length
        for (const key of keys) {
          if (key.includes(BODY_NONCE) || key.includes(SUBJECT_NONCE)) hits.push(key)
          let value: string | null = null
          try {
            const type = await redis.type(key)
            if (type === "string") value = await redis.get(key)
            else if (type === "list") value = JSON.stringify(await redis.lrange(key, 0, -1))
            else if (type === "hash") value = JSON.stringify(await redis.hgetall(key))
            else if (type === "set") value = JSON.stringify(await redis.smembers(key))
          } catch {
            value = null
          }
          if (value && (value.includes(BODY_NONCE) || value.includes(SUBJECT_NONCE))) {
            hits.push(key)
          }
        }
      } while (cursor !== "0")
      // Non-vacuity: the SCAN must have SEEN keys. A Redis that answered nothing
      // produces the same "no hits" as a clean one.
      expect(keyCount).toBeGreaterThan(0)
      expect(hits).toEqual([])
    }, 120_000)

    it("kernel.messages.metadata holds no mail phrase (the residual is content, not metadata)", async () => {
      // SC13's residual, stated rather than tested away: `kernel.messages.content`
      // MAY legitimately carry model-authored text derived from mail the user
      // asked the agent to read. This assertion is deliberately scoped to
      // `metadata`, which is the half that is redactable. Do not widen it to
      // `content` and do not suppress agent output to make it pass.
      const rows = await withSystemDb("b19-agent-metadata", async (tx) =>
        extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(coalesce(metadata::text, ''), ' '), '') AS t
              FROM kernel.messages WHERE org_id = ${orgId}::uuid`),
        ),
      )
      expect(rows[0].t).not.toContain(BODY_NONCE)
      expect(rows[0].t).not.toContain(SUBJECT_NONCE)
    })
  })

  // ── T-SEC-15 (part one) ───────────────────────────────────────────────────
  describe("T-SEC-15 part one: the server export surfaces are envelope only", () => {
    let csv = ""

    beforeAll(async () => {
      // Reproduce the dual-read state again: an export of a mailbox whose
      // plaintext column is still populated is the case that can actually leak.
      await withDisarmedMailbox(async () => {
        await withSystemDb("b19-export-setup", (tx) =>
          tx.execute(drizzleSql`
            UPDATE ${MAIL}.conversations SET subject = ${`${SUBJECT_NONCE} export`},
                   snippet = ${`${BODY_NONCE} export`}
             WHERE account_id = ${readyAccountId}::uuid`),
        )
      })
      const { invokeAppExport } = await import("~/modules/export/invoke-export")
      csv = String(
        await invokeAppExport(orgId, "mail", "csv", {
          type: "user",
          userId,
          orgId,
          scopes: ["*"],
        } as never).catch((err: unknown) => {
          throw err
        }),
      )
    }, 120_000)

    afterAll(async () => {
      await withDisarmedMailbox(async () => {
        await withSystemDb("b19-export-restore", (tx) =>
          tx.execute(drizzleSql`
            UPDATE ${MAIL}.conversations SET subject = NULL, snippet = NULL
             WHERE account_id = ${readyAccountId}::uuid`),
        )
      })
    })

    it("the multi-app export artifact is non-empty and envelope only for the encrypted mailbox", () => {
      // Non-vacuity: the artifact must exist, carry the declared envelope
      // columns, and actually contain the encrypted mailbox's rows. An export
      // that silently produced nothing, or that skipped the mailbox entirely,
      // cannot pass.
      const lines = csv.trim().split("\n")
      expect(lines[0]).toContain("accountId")
      expect(lines[0]).toContain("subject")
      const readyRows = lines.filter((l) => l.includes(readyAccountId))
      const orgRows = lines.filter((l) => l.includes(orgAccountId))
      expect(readyRows.length).toBe(CONVERSATION_COUNT)
      expect(orgRows.length).toBeGreaterThan(0)

      // The encrypted mailbox's rows carry no content.
      for (const row of readyRows) {
        expect(row).not.toContain(SUBJECT_NONCE)
        expect(row).not.toContain(BODY_NONCE)
      }
      // And the ORG mailbox's rows still do, so the suppression discriminates
      // rather than blanking the column for everyone.
      expect(orgRows.join("\n")).toContain(SUBJECT_NONCE)
    })
  })

  // ── T-SEC-15 (part two) ───────────────────────────────────────────────────
  //
  // A thumbnail of a sealed PDF, or a model-written description of it, is the
  // content the whole feature exists to remove. The two jobs that produce them
  // must skip a sealed attachment, and anything they produced before the
  // mailbox was sealed must be purged.
  describe("T-SEC-15 part two: no server-side derivative of an encrypted attachment survives", () => {
    let fileId = ""
    let storageKey = ""

    beforeAll(async () => {
      const [message] = await withSystemDb("b19-attachment-parent", async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id FROM ${MAIL}.messages
             WHERE account_id = ${readyAccountId}::uuid ORDER BY id LIMIT 1`),
        ),
      )
      expect(message).toBeTruthy()

      const imported = await withPrivilegedDb(orgId, "b19-attachment-import", async (tx) => {
        const bridge = createRpcBridge(
          "mail",
          userId,
          orgId,
          tx as unknown as RlsClient,
          mailAppManifest as never,
        ) as unknown as Record<string, (json: string) => Promise<string>>
        return bridge.files_importAttachment(
          JSON.stringify({
            targetApp: "mail",
            targetEntityType: "message",
            targetEntityId: (message as { id: string }).id,
            filename: "scan.png",
            mimeType: "image/png",
            bytesBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
              "base64",
            ),
            disposition: "attachment",
            ordinal: 0,
          }),
        )
      })
      const parsed = JSON.parse(imported) as { id: string; storageKey: string }
      fileId = parsed.id
      storageKey = parsed.storageKey

      // The historical state this test exists for: derivatives produced back
      // when the server could still read the file.
      await withSystemDb("b19-attachment-derivatives", (tx) =>
        tx.execute(drizzleSql`
          UPDATE kernel.files
             SET thumbnail_key = ${`${storageKey}.thumb.webp`},
                 analysis_status = 'done',
                 analysis_summary = ${`A scan of the letter that says ${BODY_NONCE}`},
                 analysis_model = 'gemini-test', analysis_at = now(),
                 analysis_error = 'stale', analysis_context_hash = 'abc123'
           WHERE id = ${fileId}::uuid`),
      )
    }, 120_000)

    afterAll(async () => {
      if (!orgId) return
      await withSystemDb("b19-attachment-cleanup", (tx) =>
        tx.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}::uuid`),
      )
    })

    it("pre-purge: the attachment is sealed AND carries a thumbnail and an analysis summary", async () => {
      // Non-vacuity, and the whole reason this case is not a pure negative: a
      // purge run against zero attachment rows would otherwise pass.
      const [row] = await withSystemDb("b19-attachment-pre", async (tx) =>
        extractRows<{
          enc_version: number
          thumbnail_key: string | null
          analysis_summary: string | null
        }>(
          await tx.execute(drizzleSql`
            SELECT enc_version, thumbnail_key, analysis_summary FROM kernel.files
             WHERE id = ${fileId}::uuid`),
        ),
      )
      expect(row).toBeTruthy()
      expect(Number(row?.enc_version)).toBe(1)
      expect(row?.thumbnail_key).not.toBeNull()
      expect(row?.analysis_summary).toContain(BODY_NONCE)
    })

    it("purgeMailAttachmentDerivatives clears every derivative and records the purge", async () => {
      const { purgeMailAttachmentDerivatives } = await import(
        "~/modules/mailbox-crypto/attachment-derivatives"
      )
      const deleted: string[] = []
      const result = await purgeMailAttachmentDerivatives(userId, {
        deleteObject: (async (key: string) => {
          deleted.push(key)
        }) as never,
      })
      expect(result.filesCleared).toBeGreaterThan(0)
      expect(deleted).toContain(`${storageKey}.thumb.webp`)

      const [row] = await withSystemDb("b19-attachment-post", async (tx) =>
        extractRows<Record<string, unknown>>(
          await tx.execute(drizzleSql`
            SELECT thumbnail_key, analysis_status, analysis_summary, analysis_model,
                   analysis_at, analysis_error, analysis_context_hash
              FROM kernel.files WHERE id = ${fileId}::uuid`),
        ),
      )
      for (const value of Object.values(row ?? {})) {
        expect(value).toBeNull()
      }
      // And nothing that survived carries the phrase, over the whole table for
      // this org rather than the one row.
      const [all] = await withSystemDb("b19-attachment-scan", async (tx) =>
        extractRows<{ t: string }>(
          await tx.execute(drizzleSql`
            SELECT coalesce(string_agg(
                     concat_ws(' ', filename, thumbnail_key, analysis_summary, analysis_error),
                     ' '), '') AS t
              FROM kernel.files WHERE org_id = ${orgId}::uuid`),
        ),
      )
      expect(all?.t).not.toContain(BODY_NONCE)

      const [state] = await withSystemDb("b19-attachment-state", async (tx) =>
        extractRows<{ derivatives_purged_at: string | null }>(
          await tx.execute(drizzleSql`
            SELECT derivatives_purged_at FROM kernel.mailbox_migration_state
             WHERE user_id = ${userId}::uuid`),
        ),
      )
      expect(state?.derivatives_purged_at).toBeTruthy()
    }, 120_000)

    it("both derivative jobs skip a sealed attachment, log the skip, and complete rather than throw", async () => {
      const { processThumbnailJob } = await import("~/modules/files/thumbnail-job")
      const { processMediaAnalysisJob } = await import("~/modules/files/media-analysis-job")
      const { filesLogger } = await import("~/lib/logger")
      const infoSpy = spyOn(filesLogger, "info")
      try {
        let touchedStorage = false
        await processThumbnailJob(
          { fileId, orgId, storageKey, mimeType: "image/png" },
          {
            headObject: (async () => {
              touchedStorage = true
              return { contentLength: 10, contentType: "image/png" }
            }) as never,
            getObjectBuffer: (async () => {
              touchedStorage = true
              return Buffer.alloc(0)
            }) as never,
            putObject: (async () => {
              touchedStorage = true
            }) as never,
          },
        )
        await processMediaAnalysisJob(
          { fileId, orgId, storageKey, modelId: "gemini-test" },
          {
            preCheck: (async () => {
              touchedStorage = true
              throw new Error("media analysis must not run on a sealed attachment")
            }) as never,
            getObjectBuffer: (async () => {
              touchedStorage = true
              return Buffer.alloc(0)
            }) as never,
          },
        )
        // Neither job read the object, and neither threw.
        expect(touchedStorage).toBe(false)
        const skipLines = infoSpy.mock.calls.filter((call) =>
          String((call[0] as { reason?: string })?.reason ?? "").includes(
            "encrypted_mail_attachment",
          ),
        )
        expect(skipLines.length).toBe(2)
      } finally {
        infoSpy.mockRestore()
      }
    }, 120_000)
  })

  // ── T-SEC-5 ───────────────────────────────────────────────────────────────
  //
  // SC5, the whole-instance export. This is the third export surface: not the
  // mail tool's own export and not the multi-app orchestrator's, but
  // `export-full`, which pg_dumps the entire cluster. It is the surface most
  // likely to leak, because it copies bytes rather than projecting fields, and
  // the only defence is that the bytes themselves are sealed.
  //
  // The assertion has both halves, deliberately. Negative: neither nonce appears
  // anywhere in the decompressed artifact. Positive: the encrypted mailbox's own
  // rows are present in the dump AND carry bytea ciphertext. A dump of an empty
  // database satisfies the negative half perfectly, which is why the positive
  // half decides the test.
  describe("T-SEC-5: the whole-instance export carries ciphertext and no plaintext", () => {
    let dump = ""
    let workDir = ""

    interface CopyRow {
      table: string
      line: string
      cell: (column: string) => string | undefined
    }

    /**
     * The COPY data rows of the app_mail message, conversation and draft
     * tables, each with its columns addressable BY NAME.
     *
     * pg_dump plain output is `COPY <schema>.<table> (cols) FROM stdin;`, the
     * tab-separated rows, then a lone `\.`. The schema carries a per-worker
     * prefix in tests, so it is matched by suffix.
     *
     * Column positions are parsed rather than substring-matching the whole
     * line: the ORG mailbox's rows are deliberately still plaintext (that is
     * the discriminating case T-SEC-3 needs), and they reference the same org
     * and conversation ids, so "the line contains this uuid" selects rows that
     * belong to a different account.
     */
    function mailCopyRows(text: string): CopyRow[] {
      const out: CopyRow[] = []
      let columns: string[] | null = null
      let table = ""
      for (const line of text.split("\n")) {
        if (columns) {
          if (line === "\\.") {
            columns = null
            continue
          }
          const values = line.split("\t")
          const cols = columns
          out.push({
            table,
            line,
            cell: (column) => {
              const at = cols.indexOf(column)
              return at < 0 ? undefined : values[at]
            },
          })
          continue
        }
        const header =
          /^COPY\s+"?[\w]*app_mail"?\.(messages|conversations|drafts)\s*\(([^)]*)\)/.exec(line)
        if (header) {
          table = header[1]
          columns = header[2].split(",").map((c) => c.trim().replace(/^"|"$/g, ""))
        }
      }
      return out
    }

    /** The rows of the ENROLLED mailbox, selected on the account_id column. */
    function readyRows(): CopyRow[] {
      return mailCopyRows(dump).filter((r) => r.cell("account_id") === readyAccountId)
    }

    beforeAll(async () => {
      const { execFileSync } = await import("node:child_process")
      const { mkdtempSync, readFileSync } = await import("node:fs")
      const { tmpdir } = await import("node:os")
      const nodePath = await import("node:path")
      const { exportFull } = await import("~/cli/export-full")

      // The migration role: the app role cannot lock the drizzle schema. Mirrors
      // export-full.test.ts rather than inventing a second resolution rule.
      const explicit = process.env.MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL_TEST
      let dbUrl = explicit
      if (!dbUrl && process.env.DATABASE_URL) {
        const u = new URL(process.env.DATABASE_URL)
        u.username = "postgres"
        u.password = "postgres"
        dbUrl = u.toString()
      }
      workDir = mkdtempSync(nodePath.join(tmpdir(), "b19-export-"))
      const out = nodePath.join(workDir, "full.tar.gz")
      const res = await exportFull({
        output: out,
        dbUrl,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        storageObjectsIter: async function* () {},
        meili: {
          isHealthy: async () => false,
          listIndexUids: async () => [],
          getIndexDocuments: async () => [],
        },
      })
      expect(res.exitCode).toBe(0)
      execFileSync("tar", ["xzf", out, "-C", workDir, "./pg-dump.sql"])
      dump = readFileSync(nodePath.join(workDir, "pg-dump.sql"), "utf8")
    }, 180_000)

    afterAll(async () => {
      if (!workDir) return
      const { rmSync } = await import("node:fs")
      rmSync(workDir, { recursive: true, force: true })
    })

    it("the artifact holds the encrypted mailbox's rows, with ciphertext on every one", () => {
      // Non-vacuity: the dump must actually contain this mailbox's message rows.
      const messages = readyRows().filter((r) => r.table === "messages")
      expect(messages.length).toBe(CONVERSATION_COUNT * MESSAGES_PER_CONVERSATION)

      // pg_dump writes bytea in COPY output as an escaped hex literal. Every
      // sealed row must carry one, or the export produced envelope only rows and
      // the "positively contains ciphertext" half of SC5 is unmet.
      for (const row of messages) {
        expect(row.cell("enc_version")).toBe("1")
        expect(String(row.cell("text_body_ciphertext"))).toMatch(/^\\\\x[0-9a-f]{16}/)
        expect(String(row.cell("subject_ciphertext"))).toMatch(/^\\\\x[0-9a-f]{16}/)
      }
      // And the column exists in the schema half of the dump.
      expect(dump).toContain("text_body_ciphertext")
    })

    it("no row of the encrypted mailbox carries either nonce", () => {
      // Scoped to the enrolled mailbox's own rows, which is exactly what SC5
      // claims: "no plaintext body, subject or snippet FOR ENROLLED MAILBOXES".
      // Two things in the same dump legitimately still hold the phrases and are
      // deliberately out of scope: the shared ORG mailbox (the discriminating
      // case, which must keep working), and the agent's own persisted reply,
      // the consented bounded residual amendment A13 records.
      const rows = readyRows()
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.line).not.toContain(BODY_NONCE)
        expect(row.line).not.toContain(SUBJECT_NONCE)
      }
      // The discriminating half: the org mailbox's rows DO still carry it, so a
      // dump that blanked every mailbox cannot pass this test either.
      const org = mailCopyRows(dump).filter((r) => r.cell("account_id") === orgAccountId)
      expect(org.length).toBeGreaterThan(0)
      expect(org.some((r) => r.line.includes(BODY_NONCE))).toBe(true)
    })
  })
})
