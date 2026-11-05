// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox reset (forgot the mailbox password), against real rows, the real
// mail schema and the real Invariant P trigger.
//
// Pinned here:
//   * it touches the CALLER's data only: another user in the same org keeps
//     their keyring, their mail and their approvals,
//   * it deletes the keyring (identities and wraps) and every sealed row of the
//     caller's personal mailboxes (messages, conversations, drafts, attachment
//     rows), cancels their pending sealed approvals and strips the payload,
//   * it keeps the mail account and the OAuth connection, and resets the sync
//     cursor so the mailbox re-downloads after the next enrollment,
//   * it writes an audit row,
//   * the mailbox stays ARMED with no key at all: plaintext is refused by the
//     database until the owner enrolls again,
//   * it is refused without a step-up confirmation,
//   * re-enrollment after a reset works and lifts the mailbox back to `ready`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { appBridgeManifest } from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { stepUpCodeKey, stepUpEmailCopy } from "~/modules/auth/step-up"
import { TestKeyring } from "~/modules/mailbox-keys/__fixtures__/keyring"
import { mailboxKeysRoutes } from "~/modules/mailbox-keys/routes"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"
import { pgLockWaiters } from "~/tests/helpers/pg-lock-waiters"
import { waitFor } from "~/tests/helpers/wait-for"

function appFor(user: minimal.Person): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    c.set("scopes", ["mail:*"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox-keys", mailboxKeysRoutes)
  app.onError(errorHandler)
  keyrings.set(app, new TestKeyring(user.id))
  return app
}

const keyrings = new WeakMap<Hono<AppEnv>, TestKeyring>()

async function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const passwordWrap = {
  wrapType: "passphrase" as const,
  label: "Mailbox password",
  wrappedAccountKey: Buffer.from("wrapped-under-the-password").toString("base64"),
  kdfParams: { salt: "c2FsdA==" },
}
const passkeyWrap = {
  wrapType: "passkey_prf" as const,
  label: "Passkey",
  credentialId: Buffer.from("credential").toString("base64"),
  wrappedAccountKey: Buffer.from("wrapped-under-the-prf").toString("base64"),
  kdfParams: { salt: "c2FsdA==" },
}

async function enroll(app: Hono<AppEnv>): Promise<Response> {
  return post(app, "/api/mailbox-keys/enroll", {
    ...(await keyrings.get(app)!.enrollPayload(1)),
    wraps: [passwordWrap, passkeyWrap],
  })
}

/** A valid emailed step-up code for this user, as `/api/auth/totp/step-up` stores it. */
async function stepUpCode(userId: string): Promise<string> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(userId, "mailbox_reset"), hashToken(code), "EX", 600)
  return code
}

const CIPHER = Buffer.from("opaque ciphertext under the old key")

interface Seeded {
  user: minimal.Person
  app: Hono<AppEnv>
  connectionId: string
  accountId: string
  conversationId: string
  messageId: string
  draftId: string
  fileId: string
  approvalId: string
}

/**
 * An enrolled owner with one personal Gmail mailbox holding sealed content of
 * every kind the reset deletes, plus a pending sealed approval for it.
 */
async function seedEnrolledMailbox(orgId?: string): Promise<Seeded> {
  const user = await minimal.person(orgId ?? (await createTestOrg()).id)
  const app = appFor(user)
  const stamp = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const draftId = crypto.randomUUID()
  const threadId = crypto.randomUUID()

  const connectionId = await withSystemDb("mailbox-reset-test-account", async (tx) => {
    const conn = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
           access_token_encrypted, refresh_token_encrypted, created_by)
        VALUES (${user.orgId}::uuid, 'mail', 'gmail', 'user', ${user.id}::uuid, 'oauth2',
                ${`reset-${stamp}@test.com`}, 'enc-access', 'enc-refresh', ${user.id}::uuid)
        RETURNING id::text AS id`),
    )[0] as { id: string }
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, sync_state, last_sync_at, encryption_state)
      VALUES (${accountId}::uuid, ${user.orgId}::uuid, ${conn.id}::uuid, 'user', ${user.id}::uuid,
              'gmail', ${`reset-${stamp}@test.com`}, 'active',
              ${JSON.stringify({ historyId: "4242" })}::jsonb, now(), 'pending_enrollment')`)
    return conn.id
  })

  expect((await enroll(app)).status).toBe(201)

  // Sealed rows only: the owner is enrolled, so the trigger is armed and a
  // plaintext column would be refused.
  await withSystemDb("mailbox-reset-test-content", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count, subject_ciphertext, content_key_wrapped,
         content_key_epk, enc_key_id, enc_version)
      VALUES (${conversationId}::uuid, ${user.orgId}::uuid, ${accountId}::uuid, 'user',
              ${user.id}::uuid, ${`thread-${stamp}`}, 'open', '[]'::jsonb, false, false, 1,
              ${CIPHER}, ${CIPHER}, ${CIPHER}, 1, 1)`)
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.messages
        (id, org_id, account_id, conversation_id, owner_type, owner_id, external_message_id,
         message_references, from_address, to_addresses, cc_addresses, bcc_addresses, is_read,
         is_starred, labels, direction, raw_headers, subject_ciphertext, text_body_ciphertext,
         content_key_wrapped, content_key_epk, enc_key_id, enc_version)
      VALUES (${messageId}::uuid, ${user.orgId}::uuid, ${accountId}::uuid,
              ${conversationId}::uuid, 'user', ${user.id}::uuid, ${`msg-${stamp}`},
              '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false, false,
              '[]'::jsonb, 'inbound', '{}'::jsonb, ${CIPHER}, ${CIPHER}, ${CIPHER}, ${CIPHER}, 1, 1)`)
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.drafts
        (id, org_id, account_id, "to", cc, bcc, created_by, subject_ciphertext, body_ciphertext,
         content_key_wrapped, content_key_epk, enc_key_id, enc_version)
      VALUES (${draftId}::uuid, ${user.orgId}::uuid, ${accountId}::uuid, '[]'::jsonb, '[]'::jsonb,
              '[]'::jsonb, ${user.id}::uuid, ${CIPHER}, ${CIPHER}, ${CIPHER}, ${CIPHER}, 1, 1)`)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${threadId}::uuid, ${user.orgId}::uuid, ${`reset-${stamp}`}, 'Mail conversation',
              ${user.id}::uuid)`)
  })

  const fileId = await withSystemDb(
    "mailbox-reset-test-file",
    async (tx) =>
      (
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
          INSERT INTO kernel.files
            (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key,
             uploaded_by, enc_version)
          VALUES (${user.orgId}::uuid, 'mail', 'message', ${messageId}, 'contract.pdf',
                  'application/pdf', 10, ${`test/mailbox-reset/${stamp}`}, ${user.id}::uuid, 1)
          RETURNING id::text AS id`),
        )[0] as { id: string }
      ).id,
  )

  const approvalId = await withSystemDb(
    "mailbox-reset-test-approval",
    async (tx) =>
      (
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
             current_payload, expires_at, requested_by, resource_owner_id)
          VALUES (${user.orgId}::uuid, ${`reset-approval-${stamp}`}, ${threadId}::uuid,
                  ${threadId}::uuid, 'mail__compose',
                  ${JSON.stringify({ accountId, mailboxSealed: true, bodyCiphertext: "AAAA" })}::jsonb,
                  ${JSON.stringify({ accountId, mailboxSealed: true, bodyCiphertext: "AAAA" })}::jsonb,
                  now() + interval '1 day', ${user.id}::uuid, ${user.id}::uuid)
          RETURNING id::text AS id`),
        )[0] as { id: string }
      ).id,
  )

  return {
    user,
    app,
    connectionId,
    accountId,
    conversationId,
    messageId,
    draftId,
    fileId,
    approvalId,
  }
}

interface Snapshot {
  identities: number
  wraps: number
  messages: number
  conversations: number
  drafts: number
  files: number
  connections: number
  account: {
    encryption_state: string
    sync_status: string
    sync_state: Record<string, unknown> | null
    connected_account_id: string
  } | null
  approval: { status: string; tool_params: Record<string, unknown> } | null
  armed: boolean
}

async function snapshot(s: Seeded): Promise<Snapshot> {
  return withSystemDb("mailbox-reset-test-snapshot", async (tx) => {
    const n = async (query: ReturnType<typeof drizzleSql>) =>
      Number((extractRows<{ n: number }>(await tx.execute(query))[0] as { n: number }).n)
    const account = extractRows<Snapshot["account"] & object>(
      await tx.execute(drizzleSql`
        SELECT encryption_state, sync_status, sync_state, connected_account_id::text
          FROM app_mail.accounts WHERE id = ${s.accountId}::uuid`),
    )[0]
    const approval = extractRows<Snapshot["approval"] & object>(
      await tx.execute(drizzleSql`
        SELECT status, tool_params FROM kernel.approval_requests WHERE id = ${s.approvalId}::uuid`),
    )[0]
    const armed = extractRows<{ armed: boolean }>(
      await tx.execute(
        drizzleSql`SELECT app_mail.mailbox_invariant_armed(${s.accountId}::uuid) AS armed`,
      ),
    )[0]
    return {
      identities: await n(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.user_mailbox_identities WHERE user_id = ${s.user.id}::uuid`,
      ),
      wraps: await n(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.user_key_wraps WHERE user_id = ${s.user.id}::uuid`,
      ),
      messages: await n(
        drizzleSql`SELECT count(*)::int AS n FROM app_mail.messages WHERE account_id = ${s.accountId}::uuid`,
      ),
      conversations: await n(
        drizzleSql`SELECT count(*)::int AS n FROM app_mail.conversations WHERE account_id = ${s.accountId}::uuid`,
      ),
      drafts: await n(
        drizzleSql`SELECT count(*)::int AS n FROM app_mail.drafts WHERE account_id = ${s.accountId}::uuid`,
      ),
      files: await n(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.files WHERE id = ${s.fileId}::uuid`,
      ),
      connections: await n(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.connected_accounts
                    WHERE id = ${s.connectionId}::uuid AND refresh_token_encrypted = 'enc-refresh'`,
      ),
      account: account ?? null,
      approval: approval ?? null,
      armed: armed?.armed === true,
    }
  })
}

describe("POST /api/mailbox-keys/reset", () => {
  let orgId: string

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const first = await minimal.person((await createTestOrg()).id)
      orgId = first.orgId
      await registerApps(
        [
          ticketsAppManifest as unknown as AppDescriptor,
          mailAppManifest as unknown as AppDescriptor,
        ],
        orgId,
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 180_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
  })

  test("deletes the caller's keyring and sealed mail, keeps the connection, audits", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const theirs = await seedEnrolledMailbox(orgId)

    const before = await snapshot(mine)
    // Non-vacuity: every kind of row the reset deletes is really there.
    expect(before).toMatchObject({
      identities: 1,
      wraps: 2,
      messages: 1,
      conversations: 1,
      drafts: 1,
      files: 1,
      connections: 1,
      armed: true,
    })
    expect(before.account?.encryption_state).toBe("ready")
    expect(before.approval?.status).toBe("pending")

    const res = await post(mine.app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(mine.user.id),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accountIds: string[] } }
    expect(body.data.accountIds).toEqual([mine.accountId])

    const after = await snapshot(mine)
    expect(after.identities).toBe(0)
    expect(after.wraps).toBe(0)
    expect(after.messages).toBe(0)
    expect(after.conversations).toBe(0)
    expect(after.drafts).toBe(0)
    expect(after.files).toBe(0)
    // The mail account and its OAuth grant stay: no reconnect is needed.
    expect(after.connections).toBe(1)
    expect(after.account?.connected_account_id).toBe(mine.connectionId)
    // Suspended until new keys exist, and re-imported from scratch after.
    expect(after.account?.encryption_state).toBe("pending_enrollment")
    expect(after.account?.sync_status).toBe("pre-sync")
    // No cursor survives; the only key is the reset marker (this reset's xid).
    expect(Object.keys(after.account?.sync_state ?? {})).toEqual(["resetXid"])
    // The approval is cancelled and its ciphertext is gone.
    expect(after.approval?.status).toBe("cancelled")
    expect(after.approval?.tool_params).toEqual({})
    const cancelled = await withSystemDb("mailbox-reset-test-approval-summary", async (tx) =>
      extractRows<{ reason: string; title: string | null }>(
        await tx.execute(drizzleSql`
          SELECT reason, summary ->> 'title' AS title FROM kernel.approval_requests
           WHERE id = ${mine.approvalId}::uuid`),
      ),
    )
    // Readable in an approval list, not a bare tool name.
    expect(cancelled[0]?.reason).toBe("Cancelled: mailbox was reset")
    expect(cancelled[0]?.title).toBe("Cancelled: mailbox was reset")
    const liveEvents = await withSystemDb("mailbox-reset-test-approval-event", async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          SELECT id FROM kernel.pending_events
           WHERE payload ->> 'entity' = 'approval_request' AND payload ->> 'action' = 'update'
             AND payload ->> 'entityId' = ${mine.approvalId}`),
      ),
    )
    expect(liveEvents.length, "open approval lists are told").toBeGreaterThan(0)

    const audit = await withSystemDb("mailbox-reset-test-audit", async (tx) =>
      extractRows<{ actor_id: string; metadata: Record<string, unknown> }>(
        await tx.execute(drizzleSql`
          SELECT actor_id::text AS actor_id, metadata FROM kernel.audit_log
           WHERE org_id = ${orgId}::uuid AND action = 'mailbox_reset'
             AND entity_id = ${mine.user.id}`),
      ),
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor_id).toBe(mine.user.id)
    expect(audit[0]?.metadata).toMatchObject({ messages: 1, conversations: 1, drafts: 1, wraps: 2 })

    // The other user in the same org is untouched, row for row.
    const others = await snapshot(theirs)
    expect(others).toMatchObject({
      identities: 1,
      wraps: 2,
      messages: 1,
      conversations: 1,
      drafts: 1,
      files: 1,
      connections: 1,
      armed: true,
    })
    expect(others.account?.encryption_state).toBe("ready")
    expect(others.account?.sync_state).toEqual({ historyId: "4242" })
    expect(others.approval?.status).toBe("pending")
    expect(others.approval?.tool_params).toMatchObject({ mailboxSealed: true })
  })

  test("a reset mailbox stays armed: plaintext is refused while it has no key", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const res = await post(mine.app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(mine.user.id),
    })
    expect(res.status).toBe(200)

    const after = await snapshot(mine)
    expect(after.identities, "non-vacuity: there is no key to seal to").toBe(0)
    expect(after.armed).toBe(true)

    // A draft saved from another device between the reset and re-enrolment.
    let refused: unknown = null
    try {
      await withSystemDb("mailbox-reset-test-plaintext", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO app_mail.drafts (org_id, account_id, "to", cc, bcc, created_by, subject)
          VALUES (${orgId}::uuid, ${mine.accountId}::uuid, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                  ${mine.user.id}::uuid, 'a plaintext subject')`),
      )
    } catch (err) {
      refused = err
    }
    // Drizzle wraps the Postgres error; the trigger's own message is the cause.
    const cause = (refused as { cause?: unknown } | null)?.cause
    expect(`${String(refused)} ${String(cause)}`).toContain("mailbox_plaintext_forbidden")
  })

  test("is refused without a step-up confirmation, and nothing is deleted", async () => {
    const mine = await seedEnrolledMailbox(orgId)

    const noProof = await post(mine.app, "/api/mailbox-keys/reset", {})
    expect(noProof.status).toBe(400)
    const wrongCode = await post(mine.app, "/api/mailbox-keys/reset", { stepUpCode: "000000" })
    expect(wrongCode.status).toBe(422)

    const after = await snapshot(mine)
    expect(after).toMatchObject({ identities: 1, wraps: 2, messages: 1, drafts: 1, files: 1 })
    expect(after.account?.encryption_state).toBe("ready")
  })

  test("re-enrolling after a reset arms the mailbox to the new key", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    expect(
      (
        await post(mine.app, "/api/mailbox-keys/reset", {
          stepUpCode: await stepUpCode(mine.user.id),
        })
      ).status,
    ).toBe(200)

    // Same key id as the first enrolment: the old identity is gone, so there is
    // no collision on (user, key id).
    const again = await enroll(mine.app)
    expect(again.status).toBe(201)
    const after = await snapshot(mine)
    expect(after.identities).toBe(1)
    expect(after.wraps).toBe(2)
    expect(after.account?.encryption_state).toBe("ready")
    // Still `pre-sync`: the import starts from nothing, not from the old cursor.
    expect(after.account?.sync_status).toBe("pre-sync")

    const ledger = await withSystemDb("mailbox-reset-test-ledger", async (tx) =>
      extractRows<{ enrolled_at: string | null; backfill_completed_at: string | null }>(
        await tx.execute(drizzleSql`
          SELECT enrolled_at::text, backfill_completed_at::text
            FROM kernel.mailbox_migration_state WHERE user_id = ${mine.user.id}::uuid`),
      ),
    )
    expect(ledger[0]?.enrolled_at).toBeTruthy()
    expect(ledger[0]?.backfill_completed_at).toBeNull()
  })

  test("deletes the conversations' internal threads, clears ticket links and outbox copies", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const internalThreadId = crypto.randomUUID()
    const ticketId = crypto.randomUUID()
    const stamp = crypto.randomUUID()
    await withSystemDb("mailbox-reset-test-links", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
        VALUES (${internalThreadId}::uuid, ${orgId}::uuid, ${`internal-${stamp}`},
                'Mail conversation', ${mine.user.id}::uuid)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${internalThreadId}::uuid, ${orgId}::uuid, ${mine.user.id}::uuid,
                'an internal note about this mail', '{}')`)
      await tx.execute(drizzleSql`
        UPDATE app_mail.conversations SET internal_thread_id = ${internalThreadId}::uuid
         WHERE id = ${mine.conversationId}::uuid`)
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets
          (id, org_id, handle, subject, channel, reply_token, sla_target_seconds,
           source_conversation_id, converted_to_mail_conversation_id)
        VALUES (${ticketId}::uuid, ${orgId}::uuid, ${`reset-ticket-${stamp}`}, 'Escalated',
                'email', ${`rt-${stamp}`}, 3600, ${mine.conversationId}::uuid,
                ${mine.conversationId}::uuid)`)
      // The outbox copies of the approval: one delivered, one not.
      for (const processed of [true, false]) {
        await tx.execute(drizzleSql`
          INSERT INTO kernel.pending_events (org_id, payload, processed_at)
          VALUES (${orgId}::uuid,
                  ${JSON.stringify({
                    app: "kernel",
                    entity: "approval_request",
                    action: "create",
                    entityId: mine.approvalId,
                    data: { bodyCiphertext: "AAAA", mailboxSealed: true },
                  })}::jsonb,
                  ${processed ? drizzleSql`now()` : drizzleSql`NULL`})`)
      }
    })

    const res = await post(mine.app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(mine.user.id),
    })
    expect(res.status).toBe(200)

    await withSystemDb("mailbox-reset-test-links-after", async (tx) => {
      const threads = extractRows(
        await tx.execute(
          drizzleSql`SELECT id FROM kernel.threads WHERE id = ${internalThreadId}::uuid`,
        ),
      )
      expect(threads).toHaveLength(0)
      const notes = extractRows(
        await tx.execute(
          drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${internalThreadId}::uuid`,
        ),
      )
      expect(notes).toHaveLength(0)
      const ticket = extractRows<{
        source_conversation_id: string | null
        converted_to_mail_conversation_id: string | null
      }>(
        await tx.execute(drizzleSql`
          SELECT source_conversation_id::text, converted_to_mail_conversation_id::text
            FROM app_tickets.tickets WHERE id = ${ticketId}::uuid`),
      )
      // The ticket stays; only its link to the deleted conversation goes.
      expect(ticket).toHaveLength(1)
      expect(ticket[0]?.source_conversation_id).toBeNull()
      expect(ticket[0]?.converted_to_mail_conversation_id).toBeNull()
      const events = extractRows<{ processed: boolean; data: Record<string, unknown> }>(
        await tx.execute(drizzleSql`
          SELECT processed_at IS NOT NULL AS processed, payload -> 'data' AS data
            FROM kernel.pending_events
           WHERE payload ->> 'entityId' = ${mine.approvalId}
             AND payload ->> 'action' = 'create'`),
      )
      // Delivered copy deleted, undelivered copy kept for delivery but emptied.
      expect(events).toHaveLength(1)
      expect(events[0]?.processed).toBe(false)
      expect(JSON.stringify(events[0]?.data)).not.toContain("Ciphertext")
    })
  })

  test("a sync run that read the mailbox before the reset cannot write to it after", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const manifest = appBridgeManifest(orgId, "mail")
    if (!manifest) throw new Error("the mail manifest is not registered")
    // A job run: system actor, one short transaction per bridge call.
    const session = {
      ctx: { actorType: "system" as const, userId: "system:mail:gmail-initial-sync", orgId },
      run: <T>(fn: (tx: never) => Promise<T>) =>
        withSystemDb("mailbox-reset-test-job", (tx) => fn(tx as never)),
    }
    const bridgeFor = () =>
      createSessionRpcBridge(
        "mail",
        "system:mail:gmail-initial-sync",
        orgId,
        session as never,
        manifest as never,
        ["mail:*"],
      )
    const stale = bridgeFor()
    // The page job reads its account (and its cursor) BEFORE the reset...
    const before = JSON.parse(await stale.db_findOne("accounts", mine.accountId))
    expect(before.sync_state).toEqual({ historyId: "4242" })

    const res = await post(mine.app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(mine.user.id),
    })
    expect(res.status).toBe(200)

    // ...and then tries to save its page cursor and to insert a row.
    const cursorWrite = stale.db_update(
      "accounts",
      mine.accountId,
      JSON.stringify({ syncState: { ...before.sync_state, cursor: "page-7" } }),
    )
    await expect(cursorWrite).rejects.toThrow(/MAILBOX_RESET_MID_RUN/)
    const rowWrite = stale.db_insert(
      "drafts",
      JSON.stringify({
        accountId: mine.accountId,
        to: [],
        cc: [],
        bcc: [],
        createdBy: mine.user.id,
      }),
    )
    await expect(rowWrite).rejects.toThrow(/MAILBOX_RESET_MID_RUN/)

    const after = await snapshot(mine)
    expect(after.drafts).toBe(0)
    expect(after.account?.sync_status).toBe("pre-sync")
    expect(after.account?.sync_state?.cursor).toBeUndefined()
    expect(after.account?.sync_state?.historyId).toBeUndefined()

    // Non-vacuity: a run that started AFTER the reset may write, and a handler
    // that writes an empty sync state keeps the reset marker.
    const fresh = bridgeFor()
    await fresh.db_findOne("accounts", mine.accountId)
    await fresh.db_update("accounts", mine.accountId, JSON.stringify({ syncState: {} }))
    const marker = (await snapshot(mine)).account?.sync_state?.resetXid
    expect(typeof marker).toBe("string")
  })

  test("refuses a caller who never enrolled, and arms nothing", async () => {
    const user = await minimal.person(orgId)
    const app = appFor(user)
    const accountId = crypto.randomUUID()
    await withSystemDb("mailbox-reset-test-unenrolled", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${accountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${user.id}::uuid, 'gmail', ${`unenrolled-${accountId}@test.com`}, 'active',
                'pending_enrollment')`),
    )
    const res = await post(app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(user.id),
    })
    expect(res.status).toBe(409)
    const ledger = await withSystemDb("mailbox-reset-test-unenrolled-ledger", async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          SELECT user_id FROM kernel.mailbox_migration_state WHERE user_id = ${user.id}::uuid`),
      ),
    )
    expect(ledger).toHaveLength(0)
    const armed = await withSystemDb("mailbox-reset-test-unenrolled-armed", async (tx) =>
      extractRows<{ armed: boolean }>(
        await tx.execute(
          drizzleSql`SELECT app_mail.mailbox_invariant_armed(${accountId}::uuid) AS armed`,
        ),
      ),
    )
    expect(armed[0]?.armed).toBe(false)
  })

  test("cancels a pending UNSEALED mail approval on the mailbox too", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const approvalId = await withSystemDb("mailbox-reset-test-unsealed", async (tx) => {
      const threadId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
        VALUES (${threadId}::uuid, ${orgId}::uuid, ${`unsealed-${threadId}`}, 'Chat',
                ${mine.user.id}::uuid)`)
      return (
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO kernel.approval_requests
              (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
               current_payload, expires_at, requested_by)
            VALUES (${orgId}::uuid, ${`unsealed-${threadId}`}, ${threadId}::uuid,
                    ${threadId}::uuid, 'mail__reply',
                    ${JSON.stringify({ conversationId: mine.conversationId })}::jsonb,
                    ${JSON.stringify({ conversationId: mine.conversationId })}::jsonb,
                    now() + interval '1 day', ${mine.user.id}::uuid)
            RETURNING id::text AS id`),
        )[0] as { id: string }
      ).id
    })
    const res = await post(mine.app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(mine.user.id),
    })
    expect(res.status).toBe(200)
    const row = await withSystemDb("mailbox-reset-test-unsealed-after", async (tx) =>
      extractRows<{ status: string; reason: string }>(
        await tx.execute(drizzleSql`
          SELECT status, reason FROM kernel.approval_requests WHERE id = ${approvalId}::uuid`),
      ),
    )
    expect(row[0]).toEqual({ status: "cancelled", reason: "Cancelled: mailbox was reset" })
  })

  test("answers 429 after five attempts an hour", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await post(mine.app, "/api/mailbox-keys/reset", { stepUpCode: "000000" })).status,
      )
    }
    expect(statuses.slice(0, 5)).toEqual([422, 422, 422, 422, 422])
    expect(statuses[5]).toBe(429)
    // Even a valid code is refused once the limit is reached, and nothing moved.
    const blocked = await post(mine.app, "/api/mailbox-keys/reset", {
      stepUpCode: await stepUpCode(mine.user.id),
    })
    expect(blocked.status).toBe(429)
    expect((await snapshot(mine)).identities).toBe(1)
  })

  test("accepts the current Liaison password as the step-up, and refuses a wrong one", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const wrong = await post(mine.app, "/api/mailbox-keys/reset", { currentPassword: "nope-nope" })
    expect(wrong.status).toBe(422)
    expect((await snapshot(mine)).identities).toBe(1)
    const right = await post(mine.app, "/api/mailbox-keys/reset", { currentPassword: "Passw0rd!" })
    expect(right.status).toBe(200)
    expect((await snapshot(mine)).identities).toBe(0)
  })

  test("a code issued for a two-factor change cannot reset the mailbox", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const code = "424242"
    await redis.set(stepUpCodeKey(mine.user.id), hashToken(code), "EX", 600)
    const res = await post(mine.app, "/api/mailbox-keys/reset", { stepUpCode: code })
    expect(res.status).toBe(422)
    expect((await snapshot(mine)).identities).toBe(1)
    // And the reset code's email says what the reset does.
    const copy = stepUpEmailCopy("123456", "mailbox_reset")
    const text = [copy.subject, copy.heading, ...copy.paragraphs].join(" ")
    expect(text).toMatch(/reset/i)
    expect(text).toMatch(/downloads again from Gmail/)
    expect(text).toMatch(/Drafts written in Liaison/)
  })

  test("a write in flight holds the reset back, and the reset then deletes what it wrote", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const manifest = appBridgeManifest(orgId, "mail")
    if (!manifest) throw new Error("the mail manifest is not registered")
    let resetPromise: Promise<Response> | null = null
    let resetDoneWhileWriting = false
    await withSystemDb("mailbox-reset-test-racing-write", async (tx) => {
      const bridge = createRpcBridge(
        "mail",
        "system:mail:gmail-initial-sync",
        orgId,
        tx as never,
        manifest as never,
        ["mail:*"],
      )
      await bridge.db_findOne("accounts", mine.accountId)
      await bridge.db_insert(
        "drafts",
        JSON.stringify({
          accountId: mine.accountId,
          to: [],
          cc: [],
          bcc: [],
          createdBy: mine.user.id,
        }),
      )
      // The reset starts while this write is uncommitted...
      const code = await stepUpCode(mine.user.id)
      resetPromise = post(mine.app, "/api/mailbox-keys/reset", { stepUpCode: code })
      let settled = false
      void resetPromise.then(() => {
        settled = true
      })
      // Until the reset is queued behind this transaction (or, wrongly, done).
      await waitFor(async () => settled || (await pgLockWaiters()) > 0, {
        label: "the reset to block on the open write",
      })
      // ...and must wait for it.
      resetDoneWhileWriting = settled
    })
    expect(resetDoneWhileWriting).toBe(false)
    const res = (await resetPromise) as unknown as Response
    expect(res.status).toBe(200)
    const after = await snapshot(mine)
    expect(after.drafts, "the draft the racing write committed is gone").toBe(0)
    expect(after.identities).toBe(0)
  })

  test("a run that started before the reset cannot add or move mail files", async () => {
    const mine = await seedEnrolledMailbox(orgId)
    const manifest = appBridgeManifest(orgId, "mail")
    if (!manifest) throw new Error("the mail manifest is not registered")
    const session = {
      ctx: { actorType: "system" as const, userId: "system:mail:gmail-initial-sync", orgId },
      run: <T>(fn: (tx: never) => Promise<T>) =>
        withSystemDb("mailbox-reset-test-files-job", (tx) => fn(tx as never)),
    }
    const stale = createSessionRpcBridge(
      "mail",
      "system:mail:gmail-initial-sync",
      orgId,
      session as never,
      manifest as never,
      ["mail:*"],
    )
    await stale.db_findOne("accounts", mine.accountId)
    expect(
      (
        await post(mine.app, "/api/mailbox-keys/reset", {
          stepUpCode: await stepUpCode(mine.user.id),
        })
      ).status,
    ).toBe(200)
    // Outbound staging hangs off the account, which the reset keeps.
    const target = {
      targetApp: "mail",
      targetEntityType: "outbound_staging",
      targetEntityId: mine.accountId,
    }
    await expect(
      stale.files_attachToParent(JSON.stringify({ ...target, sourceFileId: crypto.randomUUID() })),
    ).rejects.toThrow(/MAILBOX_RESET_MID_RUN/)
    await expect(
      stale.files_importFromUrl(
        JSON.stringify({ ...target, url: "https://example.invalid/a.pdf", filename: "a.pdf" }),
      ),
    ).rejects.toThrow(/MAILBOX_RESET_MID_RUN/)
  })
})
