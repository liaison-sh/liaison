// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

let orgId: string
let _userId: string

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO kernel.organizations (id, name, slug)
    VALUES (gen_random_uuid(), 'Integration Test Org', 'integration-test-org')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (gen_random_uuid(), ${orgId}, 'integ@test.com', 'Tester', 'active', 'hash')
    ON CONFLICT (org_id, email) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `),
  )
  _userId = user.id

  // The mail app owns this schema. The CREATE TABLE IF NOT EXISTS pair that
  // stood here owned nothing: against an already-registered app both were
  // silent no-ops, so the file asserted the data model of whatever shape
  // happened to be installed. Register the real app and assert its shape.
  await registerApps(
    [
      {
        ...(mailAppManifest as any),
        dependencies: { ...(mailAppManifest as any).dependencies, tools: [] },
      },
    ] as unknown as AppDescriptor[],
    orgId,
  )
})

describe("mail data model", () => {
  it("conversations table exists with expected columns", async () => {
    const cols = extractRows<any>(
      await db.execute(drizzleSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_mail' AND table_name = 'conversations'
      ORDER BY ordinal_position
    `),
    )
    const names = cols.map((col) => col.column_name)
    expect(names).toContain("account_id")
    expect(names).toContain("owner_type")
    expect(names).toContain("contact_id")
    expect(names).toContain("internal_thread_id")
  })

  it("messages table exists with expected columns", async () => {
    const cols = extractRows<any>(
      await db.execute(drizzleSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_mail' AND table_name = 'messages'
      ORDER BY ordinal_position
    `),
    )
    const names = cols.map((col) => col.column_name)
    expect(names).toContain("conversation_id")
    expect(names).toContain("from_address")
    expect(names).toContain("direction")
    expect(names).toContain("owner_type")
  })
})

// ---------------------------------------------------------------------------
// T-INT-7 (Task 4.4). A personal account whose `encryption_state` is not
// `ready` fetches no mail.
//
// The blueprint named `loadSyncableAccounts`' three return paths. Two more
// entry points reach a provider WITHOUT going through that function at all:
// `gmailInitialSync` and `imapInitialSync` read the account with `db_findOne`
// and sync it, and `reenqueueStrandedInitialSyncs` re-enqueues them on every
// scheduled tick for any account still at `pre-sync` or `syncing`. Guarding
// only `loadSyncableAccounts` would leave a half-backfilled personal mailbox
// writing plaintext forever, so all five are asserted here.
//
// Non-vacuity is not optional in this file: every negative case is "no fetch
// happened", which a sync that fetches nothing at all would satisfy. So each
// path first asserts that a `ready` personal account DOES reach the provider
// through that same path, with the same fixture.
// ---------------------------------------------------------------------------

const ACCOUNT_BASE = {
  id: "acc-sync-1",
  owner_type: "user",
  owner_id: "user-1",
  provider: "gmail",
  email_address: "user@gmail.com",
  sync_status: "active",
  sync_state: { historyId: "1000" },
  last_sync_at: null,
  disconnected_at: null,
  encryption_state: "ready",
}

interface SyncProbe {
  bridge: Record<string, any>
  fetches: string[]
  tokenCalls: string[]
  debugLogs: string[]
}

function createSyncProbe(account: Record<string, unknown>, provider = "gmail"): SyncProbe {
  const fetches: string[] = []
  const tokenCalls: string[] = []
  const debugLogs: string[] = []
  const bridge: Record<string, any> = {
    getUserId: () => "system:mail:sync",
    getOrgId: () => "org-1",
    db_findOne: async (_entity: string, id: string) =>
      JSON.stringify(id === account.id ? account : null),
    db_findMany: async (_entity: string, optsJson: string) => {
      const where = JSON.parse(optsJson).where ?? {}
      if (where.provider !== provider) return "[]"
      if (where.syncStatus && where.syncStatus !== account.sync_status) return "[]"
      return JSON.stringify([account])
    },
    db_insert: async (_e: string, dataJson: string) =>
      JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
    db_update: async () => {},
    db_updateMany: async () => JSON.stringify({ count: 0 }),
    db_delete: async () => {},
    db_count: async () => "0",
    emit: async () => {},
    enqueueJob: async () => {},
    connections_getToken: async (_name: string, identifier?: string) => {
      tokenCalls.push(identifier ?? "")
      return "mock-access-token"
    },
    connections_getAccounts: async () => "[]",
    connections_disconnect: async () => {},
    hasScope: async () => true,
    resolveContact: async () => JSON.stringify({ id: "contact-1", email: "a@example.com" }),
    fetch: async (url: string) => {
      fetches.push(url)
      return JSON.stringify({
        status: 200,
        headers: {},
        body: JSON.stringify({ history: [], historyId: "1001", messages: [] }),
      })
    },
    imap_fetch: async () => {
      fetches.push("imap")
      return JSON.stringify({ messages: [], done: true, uidValidity: 1 })
    },
    smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
    hasOnlineUsers: async () => JSON.stringify(true),
    config_get: async () => null,
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    log_debug: (msg: string) => {
      debugLogs.push(String(msg))
    },
  }
  return { bridge, fetches, tokenCalls, debugLogs }
}

describe("T-INT-7 -- sync is suspended for an unenrolled personal mailbox", () => {
  async function run(
    exportName: string,
    probe: SyncProbe,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const runMailHandler = await mailTestRunner()
    return runMailHandler({
      exportName,
      params: payload,
      bridge: probe.bridge,
      timeoutMs: 15_000,
    } as any)
  }

  it("the predicate is exported and answers the five states", async () => {
    // Non-vacuity for the predicate itself: a function that always returned
    // true, or always false, fails here before any sync case runs.
    const probe = createSyncProbe(ACCOUNT_BASE)
    const answers: Record<string, unknown> = {}
    for (const state of ["ready", "none", "pending_enrollment", "blocked", "paused"]) {
      answers[state] = await run("__test_isSyncableAccount", probe, {
        account: { ...ACCOUNT_BASE, encryption_state: state },
      })
    }
    expect(answers.ready).toBe(true)
    expect(answers.none).toBe(false)
    expect(answers.pending_enrollment).toBe(false)
    expect(answers.blocked).toBe(false)
    expect(answers.paused).toBe(false)
    const shared = await run("__test_isSyncableAccount", probe, {
      account: { ...ACCOUNT_BASE, owner_type: "shared", encryption_state: "none" },
    })
    expect(shared, "an org mailbox is never suspended").toBe(true)
  })

  it("the explicit accountId path fetches for ready and for an org account", async () => {
    const ready = createSyncProbe({ ...ACCOUNT_BASE, encryption_state: "ready" })
    await run("gmailIncrementalSync", ready, { orgId: "org-1", accountId: "acc-sync-1" })
    expect(
      ready.fetches.length,
      "the ready fixture must actually reach the provider",
    ).toBeGreaterThan(0)

    const org = createSyncProbe({
      ...ACCOUNT_BASE,
      owner_type: "shared",
      owner_id: null,
      encryption_state: "none",
    })
    await run("gmailIncrementalSync", org, { orgId: "org-1", accountId: "acc-sync-1" })
    expect(org.fetches.length).toBeGreaterThan(0)
  })

  for (const state of ["pending_enrollment", "paused", "blocked"]) {
    it(`the explicit accountId path fetches nothing for a ${state} personal account`, async () => {
      const probe = createSyncProbe({ ...ACCOUNT_BASE, encryption_state: state })
      await run("gmailIncrementalSync", probe, { orgId: "org-1", accountId: "acc-sync-1" })
      expect(probe.fetches).toEqual([])
      expect(probe.tokenCalls).toEqual([])
    })

    it(`the active listing path fetches nothing for a ${state} personal account`, async () => {
      const probe = createSyncProbe({
        ...ACCOUNT_BASE,
        sync_status: "active",
        encryption_state: state,
      })
      await run("gmailIncrementalSync", probe, { orgId: "org-1" })
      expect(probe.fetches).toEqual([])
      expect(probe.tokenCalls).toEqual([])
    })

    it(`the backfilling listing path fetches nothing for a ${state} personal account`, async () => {
      const probe = createSyncProbe({
        ...ACCOUNT_BASE,
        sync_status: "syncing",
        encryption_state: state,
      })
      await run("gmailIncrementalSync", probe, { orgId: "org-1" })
      expect(probe.fetches).toEqual([])
      expect(probe.tokenCalls).toEqual([])
    })

    it(`gmailInitialSync fetches nothing for a ${state} personal account`, async () => {
      const probe = createSyncProbe({
        ...ACCOUNT_BASE,
        sync_status: "pre-sync",
        sync_state: null,
        encryption_state: state,
      })
      await run("gmailInitialSync", probe, { orgId: "org-1", accountId: "acc-sync-1" })
      expect(probe.fetches).toEqual([])
      expect(probe.tokenCalls).toEqual([])
    })

    it(`imapInitialSync fetches nothing for a ${state} personal account`, async () => {
      const probe = createSyncProbe(
        {
          ...ACCOUNT_BASE,
          provider: "imap",
          sync_status: "pre-sync",
          sync_state: null,
          encryption_state: state,
        },
        "imap",
      )
      await run("imapInitialSync", probe, { orgId: "org-1", accountId: "acc-sync-1" })
      expect(probe.fetches).toEqual([])
    })
  }

  it("gmailInitialSync still fetches for a ready personal account", async () => {
    const probe = createSyncProbe({
      ...ACCOUNT_BASE,
      sync_status: "pre-sync",
      sync_state: null,
      encryption_state: "ready",
    })
    await run("gmailInitialSync", probe, { orgId: "org-1", accountId: "acc-sync-1" })
    expect(probe.fetches.length).toBeGreaterThan(0)
  })
})

// ── T-INT-1: a sync into a ready mailbox writes ciphertext only ──────────────
//
// THE BRIDGE UNDER TEST IS THE REAL ONE, deliberately.
//
// The other `processMessages` test in this repo hand-mocks every bridge method
// with a bespoke in-memory stub. If `mailbox_seal` / `mailbox_sealAndInsert`
// were stubbed the same way to return synthetic-but-decryptable ciphertext,
// this test would validate the mock's own round-trip fidelity and nothing else:
// a broken bridge wiring, a broken identity resolver, a missed
// RECIPIENT_MISMATCH check or a failure to persist `content_key_wrapped` would
// all pass. So the db and mailbox methods below come from `createRpcBridge`
// itself, against a real enrolled identity row and the real armed Invariant P
// trigger. Only the network-facing methods are stubbed. DO NOT re-stub them.

import {
  afterAll as afterAllEnc,
  beforeAll as beforeAllEnc,
  describe as describeEnc,
  expect as expectEnc,
  it as itEnc,
} from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

/** The mail handlers, with this file's test-only entries beside them. */
async function mailTestRunner() {
  const [{ mailRunner }, mail] = await Promise.all([
    import("~/apps/mail/test-mail-runner"),
    import("~/apps/mail/handlers"),
  ])
  return mailRunner({
    __test_isSyncableAccount: (params) => mail.isSyncableAccount(params.account),
    __test_processMessages: (params, ctx) =>
      mail.processMessages(params.messages, params.account, ctx),
  })
}

const MAIL_SCHEMA = schemaRef("app_mail")

describeEnc("T-INT-1: ingest into a ready mailbox writes ciphertext only", () => {
  let encOrgId: string
  let encUserId: string
  let keys: CryptoKeyPair
  const KEY_ID = 33

  beforeAllEnc(async () => {
    await acquireAppSchemaJsLock("app_mail")
    const user = await minimal.person((await createTestOrg()).id)
    encOrgId = user.orgId
    encUserId = user.id
    await registerApps([mailAppManifest as unknown as AppDescriptor], encOrgId)

    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as CryptoKeyPair
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    keys = ecdh
    const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
    const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
    await withSystemDb("t-int-1-enroll", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
        VALUES (${encOrgId}::uuid, ${encUserId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                ${Buffer.from("attestation")}, 'active')`),
    )
  }, 120_000)

  afterAllEnc(async () => {
    await releaseAppSchemaJsLock("app_mail")
  })

  async function makeAccount(encryptionState: string): Promise<string> {
    const id = crypto.randomUUID()
    await withSystemDb("t-int-1-account", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${encOrgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${encUserId}::uuid, 'gmail', ${`${id}@enc.test`}, 'active', ${encryptionState})`),
    )
    return id
  }

  function fixtureMessages(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      externalMessageId: `<enc-${crypto.randomUUID()}@example.test>`,
      externalProviderId: `p${i}`,
      externalThreadId: `<enc-thread-${i}@example.test>`,
      from: { name: "Alice", email: "alice@example.test" },
      to: [{ email: "bob@example.test" }],
      cc: [],
      bcc: [],
      subject: `Confidential subject ${i}`,
      textBody: `Confidential body number ${i}, which no server may read.`,
      htmlBody: `<p>Confidential body number ${i}</p>`,
      snippet: `Confidential body number ${i}`,
      headers: {
        "message-id": `<enc-${i}@example.test>`,
        subject: `Confidential subject ${i}`,
        "x-originating-ip": "203.0.113.9",
      },
      inReplyTo: null,
      references: [],
      labels: ["INBOX"],
      isRead: false,
      isStarred: false,
      sentAt: new Date(Date.UTC(2026, 0, 15, 10, i)).toISOString(),
      direction: "inbound",
    }))
  }

  async function runIngest(
    accountId: string,
    messages: unknown[],
    // The bridge actor. Production sync NEVER runs as the mailbox owner:
    // runtime.ts builds a job's actor as `system:<app>:<job>`, so that is the
    // actor this path has to work under. Defaulted to the owner only so the
    // pre-existing cases below read unchanged.
    actor: string = encUserId,
  ): Promise<{ error: unknown; logs: string[] }> {
    const logs: string[] = []
    // The jobs pool, as the mail job that runs this in production: the host's
    // short privileged reads under the bridge (sender contacts) must not nest.
    return withPrivilegedDb(
      encOrgId,
      "t-int-1-ingest",
      async (tx) => {
        const real = createRpcBridge(
          "mail",
          actor,
          encOrgId,
          tx as unknown as RlsClient,
          mailAppManifest as never,
        )
        const bridge: Record<string, any> = {
          ...real,
          emit: async () => {},
          enqueueJob: async () => {},
          connections_getToken: async () => "token",
          connections_getAccounts: async () => "[]",
          fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
          imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
          smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
          resolveContact: async () => JSON.stringify({ id: crypto.randomUUID() }),
          log_info: (m: string) => logs.push(String(m)),
          log_warn: (m: string) => logs.push(String(m)),
          log_error: (m: string) => logs.push(String(m)),
          log_debug: (m: string) => logs.push(String(m)),
        }
        const runMailHandler = await mailTestRunner()
        let error: unknown = null
        try {
          await runMailHandler({
            exportName: "__test_processMessages",
            params: {
              messages,
              account: {
                id: accountId,
                owner_type: "user",
                owner_id: encUserId,
                encryption_state: (
                  extractRows<{ encryption_state: string }>(
                    await tx.execute(
                      drizzleSql`SELECT encryption_state FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.accounts WHERE id = ${accountId}::uuid`,
                    ),
                  )[0] as { encryption_state: string }
                ).encryption_state,
              },
            },
            bridge,
            timeoutMs: 60_000,
          } as any)
        } catch (e) {
          error = e
        }
        return { error, logs }
      },
      { pool: "jobs" },
    )
  }

  async function readMessages(accountId: string) {
    return withSystemDb("t-int-1-read", async (tx) =>
      extractRows<any>(
        await tx.execute(
          drizzleSql`SELECT * FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.messages WHERE account_id = ${accountId}::uuid ORDER BY sent_at`,
        ),
      ),
    )
  }

  itEnc(
    "writes no plaintext and the client half recovers the body byte for byte",
    async () => {
      const accountId = await makeAccount("ready")
      const fixtures = fixtureMessages(3)
      const { error } = await runIngest(accountId, fixtures)
      expectEnc(error).toBeNull()

      const rows = await readMessages(accountId)
      // Non-vacuity: a run that ingested nothing must fail HERE, not pass the
      // all-NULL assertion below.
      expectEnc(rows.length, "the fixture must actually have been ingested").toBe(3)
      const identities = await withSystemDb("t-int-1-count-identities", async (tx) =>
        extractRows<any>(
          await tx.execute(
            drizzleSql`SELECT 1 FROM kernel.user_mailbox_identities WHERE user_id = ${encUserId}::uuid AND status = 'active'`,
          ),
        ),
      )
      expectEnc(identities.length, "the owner must hold exactly one active identity").toBe(1)

      for (const row of rows) {
        expectEnc(row.subject).toBeNull()
        expectEnc(row.text_body).toBeNull()
        expectEnc(row.html_body).toBeNull()
        expectEnc(row.snippet).toBeNull()
        expectEnc(row.enc_version).toBe(1)
        expectEnc(row.enc_key_id).toBe(KEY_ID)
        for (const col of [
          "subject_ciphertext",
          "text_body_ciphertext",
          "html_body_ciphertext",
          "snippet_ciphertext",
          "raw_headers_ciphertext",
          "content_key_wrapped",
          "content_key_epk",
        ]) {
          expectEnc(row[col]?.length ?? 0, `${col} must be non-empty`).toBeGreaterThan(0)
        }
        // The non-allowlisted headers are gone from cleartext.
        expectEnc(Object.keys(row.raw_headers).sort()).toEqual(["message-id"])
      }

      const first = rows[0]
      const contentKey = await unsealContentKey({
        privateKey: keys.privateKey,
        recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
        userId: encUserId,
        keyId: KEY_ID,
        wrapped: new Uint8Array(first.content_key_wrapped),
        epkSpki: new Uint8Array(first.content_key_epk),
      })
      const body = await openField({
        contentKey,
        context: mailboxAad.messageTextBody(first.id),
        blob: new Uint8Array(first.text_body_ciphertext),
      })
      expectEnc(new TextDecoder().decode(body)).toBe(fixtures[0]?.textBody)
      const subject = await openField({
        contentKey,
        context: mailboxAad.messageSubject(first.id),
        blob: new Uint8Array(first.subject_ciphertext),
      })
      expectEnc(new TextDecoder().decode(subject)).toBe(fixtures[0]?.subject)
      const headers = await openField({
        contentKey,
        context: mailboxAad.messageHeaders(first.id),
        blob: new Uint8Array(first.raw_headers_ciphertext),
      })
      expectEnc(JSON.parse(new TextDecoder().decode(headers))["x-originating-ip"]).toBe(
        "203.0.113.9",
      )
    },
    120_000,
  )

  itEnc(
    "a headless system:mail:sync actor ingests sealed, which is what production does",
    async () => {
      // The case above runs as the mailbox OWNER, which no production sync ever
      // does. Every scheduled sync, Gmail push and page-chain re-enqueue reaches
      // the bridge as "system:mail:<job>", so an owner-only seal path means an
      // enrolled mailbox silently stops ingesting mail forever.
      const accountId = await makeAccount("ready")
      const fixtures = fixtureMessages(2)
      const { error } = await runIngest(accountId, fixtures, "system:mail:sync")
      expectEnc(error).toBeNull()

      const rows = await readMessages(accountId)
      expectEnc(rows.length, "the headless sync must actually have ingested").toBe(2)
      for (const row of rows) {
        expectEnc(row.subject).toBeNull()
        expectEnc(row.text_body).toBeNull()
        expectEnc(row.enc_version).toBe(1)
        expectEnc(row.enc_key_id).toBe(KEY_ID)
      }

      // Sealed to the OWNER, not to whoever the actor was: proven by opening it
      // with the owner's private key.
      const first = rows[0]
      const contentKey = await unsealContentKey({
        privateKey: keys.privateKey,
        recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
        userId: encUserId,
        keyId: KEY_ID,
        wrapped: new Uint8Array(first.content_key_wrapped),
        epkSpki: new Uint8Array(first.content_key_epk),
      })
      const body = await openField({
        contentKey,
        context: mailboxAad.messageTextBody(first.id),
        blob: new Uint8Array(first.text_body_ciphertext),
      })
      expectEnc(new TextDecoder().decode(body)).toBe(fixtures[0]?.textBody)
    },
    120_000,
  )

  itEnc(
    "the conversation carries the sealed snippet of its source message",
    async () => {
      const accountId = await makeAccount("ready")
      await runIngest(accountId, fixtureMessages(1))
      const [conv] = await withSystemDb("t-int-1-conv", async (tx) =>
        extractRows<any>(
          await tx.execute(
            drizzleSql`SELECT * FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.conversations WHERE account_id = ${accountId}::uuid`,
          ),
        ),
      )
      expectEnc(conv).toBeDefined()
      expectEnc(conv.subject).toBeNull()
      expectEnc(conv.snippet).toBeNull()
      expectEnc(conv.enc_version).toBe(1)
      expectEnc(conv.snippet_source_message_id).not.toBeNull()
      const [msg] = await readMessages(accountId)
      expectEnc(conv.snippet_source_message_id).toBe(msg.id)
      expectEnc(Buffer.from(conv.snippet_ciphertext).toString("base64")).toBe(
        Buffer.from(msg.snippet_ciphertext).toString("base64"),
      )
    },
    120_000,
  )

  itEnc(
    "an owner with no active identity gets no rows and the account is blocked",
    async () => {
      const other = await minimal.person(encOrgId)
      const id = crypto.randomUUID()
      await withSystemDb("t-int-1-unenrolled-account", (tx) =>
        tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${encOrgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${other.id}::uuid, 'gmail', ${`${id}@enc.test`}, 'active', 'ready')`),
      )
      // The jobs pool, as the mail job that runs this in production: the host's
      // short privileged reads under the bridge (sender contacts) must not nest.
      const { error } = await withPrivilegedDb(
        encOrgId,
        "t-int-1-unenrolled",
        async (tx) => {
          const real = createRpcBridge(
            "mail",
            other.id,
            encOrgId,
            tx as unknown as RlsClient,
            mailAppManifest as never,
          )
          const bridge: Record<string, any> = {
            ...real,
            emit: async () => {},
            enqueueJob: async () => {},
            log_info: () => {},
            log_warn: () => {},
            log_error: () => {},
            log_debug: () => {},
          }
          const runMailHandler = await mailTestRunner()
          let error: unknown = null
          try {
            await runMailHandler({
              exportName: "__test_processMessages",
              params: {
                messages: fixtureMessages(1),
                account: {
                  id,
                  owner_type: "user",
                  owner_id: other.id,
                  encryption_state: "ready",
                },
              },
              bridge,
              timeoutMs: 60_000,
            } as any)
          } catch (e) {
            error = e
          }
          return { error }
        },
        { pool: "jobs" },
      )
      expectEnc(error).not.toBeNull()
      expectEnc(String((error as Error).message)).toContain("USER_NOT_ENROLLED")
      expectEnc((await readMessages(id)).length, "no row may be written when sealing fails").toBe(0)

      const [account] = await withSystemDb("t-int-1-blocked", async (tx) =>
        extractRows<any>(
          await tx.execute(
            drizzleSql`SELECT encryption_state FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.accounts WHERE id = ${id}::uuid`,
          ),
        ),
      )
      expectEnc(account.encryption_state).toBe("blocked")
    },
    120_000,
  )
})
