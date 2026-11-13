// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { initEventBus } from "~/infra/events/event-bus"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { resetAppRegistries, setDeclaredEmits } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/rpc-bridge"
import * as mailService from "~/modules/mail/service"

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const ACTIVE_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY
let orgId: string
let userId: string
let accountId: string
let conversationId: string
const events: any[] = []
const mailDb = db as any
mailDb.queueEvent = async (event: any) => {
  events.push(event)
}
const originalTransaction = mailDb.transaction.bind(mailDb)
mailDb.transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    const attachQueueEvent = (target: any) => {
      target.queueEvent = async (event: any) => {
        events.push(event)
      }
      const nestedTransaction = target.transaction.bind(target)
      target.transaction = async (nestedFn: any) => {
        return nestedTransaction(async (nestedTx: any) => {
          attachQueueEvent(nestedTx)
          return nestedFn(nestedTx)
        })
      }
    }

    attachQueueEvent(tx)
    return fn(tx)
  })
}

// Mail send now persists in its own committed `withPrivilegedDb` transaction,
// so its events land in the real outbox (`kernel.pending_events`) rather than
// the in-memory `events` capture. Read them back from the outbox for the send
// paths; non-send paths (e.g. getConversation) still use the `events` mock.
async function loadOutboxEvents(): Promise<any[]> {
  // The mail app's own events only. The org's first touch also sets its apps
  // up, and that queues role grants (`kernel` `role_scope`) whenever it runs,
  // which is not what these tests are about.
  const rows = extractRows<{ payload: any }>(
    await db.execute(
      drizzleSql`SELECT payload FROM kernel.pending_events
                  WHERE org_id = ${orgId} AND payload->>'app' = 'mail' ORDER BY seq ASC`,
    ),
  )
  return rows.map((r) => r.payload)
}

beforeAll(async () => {
  initEventBus()
  await initSandboxPool()

  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Mail Test Org', ${`mail-test-org-${Date.now()}`}) RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, 'mailuser@test.com', 'Mail User', 'active', 'hash') RETURNING id
    `),
  )
  userId = user.id

  resetAppRegistries()
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect", "contact:merge"]),
  )
  const mailOnlyManifest = {
    ...mailAppManifest,
    dependencies: { ...(mailAppManifest as any).dependencies, tools: [] },
  }
  await registerApps([mailOnlyManifest as any, ticketsAppManifest as any], orgId)
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app_mail`)
  await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS app_mail.accounts (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        connected_account_id uuid NOT NULL,
        owner_type text NOT NULL,
        owner_id uuid,
        provider text NOT NULL,
        email_address text NOT NULL,
        sync_status text NOT NULL,
        sync_state jsonb,
        last_sync_at timestamptz,
        last_sync_error text,
        disconnected_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, email_address)
      )
    `)
  await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS app_mail.conversations (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        account_id uuid NOT NULL,
        owner_type text NOT NULL,
        owner_id uuid,
        external_thread_id text NOT NULL,
        subject text,
        snippet text,
        contact_id uuid,
        assigned_to uuid,
        status text NOT NULL,
        labels jsonb NOT NULL,
        is_read boolean NOT NULL,
        is_starred boolean NOT NULL,
        internal_thread_id uuid,
        last_message_at timestamptz,
        message_count integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
  await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS app_mail.messages (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        conversation_id uuid NOT NULL,
        account_id uuid NOT NULL,
        external_message_id text NOT NULL,
        external_provider_id text NOT NULL,
        in_reply_to text,
        message_references jsonb NOT NULL,
        from_address jsonb NOT NULL,
        to_addresses jsonb NOT NULL,
        cc_addresses jsonb NOT NULL,
        bcc_addresses jsonb NOT NULL,
        subject text,
        text_body text,
        html_body text,
        snippet text,
        is_read boolean NOT NULL,
        is_starred boolean NOT NULL,
        labels jsonb NOT NULL,
        direction text NOT NULL,
        sent_at timestamptz,
        synced_at timestamptz,
        raw_headers jsonb NOT NULL,
        owner_type text NOT NULL,
        owner_id uuid,
        sent_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, account_id, external_message_id)
      )
    `)
  await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS app_mail.drafts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        account_id uuid NOT NULL,
        conversation_id uuid,
        reply_to_message_id uuid,
        "to" jsonb NOT NULL DEFAULT '[]',
        cc jsonb NOT NULL DEFAULT '[]',
        bcc jsonb NOT NULL DEFAULT '[]',
        subject text NOT NULL DEFAULT '',
        html_body text NOT NULL DEFAULT '',
        text_body text NOT NULL DEFAULT '',
        created_by uuid NOT NULL,
        sent_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
  // The arbiter of sendReply's idempotent ON CONFLICT is migration 0116's
  // (org_id, account_id, external_message_id) unique index. This file used to
  // create its own (account_id, external_message_id) index, which is what hid
  // that production had no index the ON CONFLICT could match (every reply's
  // local save failed after delivery). Drop it where an earlier run left it.
  await sql.unsafe(`DROP INDEX IF EXISTS app_mail.app_mail_messages_acct_extmsg_uniq`)
  await sql.unsafe(`GRANT USAGE ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
  await sql.unsafe(
    `GRANT ALL ON ALL TABLES IN SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`,
  )
  await sql.unsafe(
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`,
  )
})

afterEach(async () => {
  mock.restore()
  events.length = 0
  await db.execute(drizzleSql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.user_roles WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM app_mail.drafts WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`)
  await db.execute(
    drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId} AND app_name = 'mail'`,
  )
  await db.execute(drizzleSql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.thread_references WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.user_thread_state WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId} AND id != ${userId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`)
})

afterAll(async () => {
  if (!orgId || !userId) return
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE id = ${userId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
})

async function seedConversation() {
  const [connected] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by, access_token_encrypted
      )
      VALUES (
        gen_random_uuid(), ${orgId}, 'mail', 'gmail', 'user', ${userId},
        'oauth2', 'test@gmail.com', 'active', ${userId}, ${encryptSecret("mail-access-token", ACTIVE_ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)}
      )
      RETURNING id
    `),
  )
  const [acc] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
      VALUES (gen_random_uuid(), ${orgId}, ${connected.id}, 'user', ${userId}, 'gmail', 'test@gmail.com', 'active')
      RETURNING id
    `),
  )
  accountId = acc.id

  const [conv] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count)
      VALUES (gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-1', 'Test Subject', 'Hello...', 'open', '["INBOX"]'::jsonb, false, false, now(), 2)
      RETURNING id
    `),
  )
  conversationId = conv.id

  await db.execute(drizzleSql`
      INSERT INTO app_mail.messages (id, org_id, conversation_id, account_id, external_message_id, external_provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet, is_read, is_starred, labels, direction, sent_at, owner_type, owner_id, message_references, raw_headers)
      VALUES
        (gen_random_uuid(), ${orgId}, ${conversationId}, ${accountId}, '<msg1@test>', 'gm1', '{"email":"alice@test.com","name":"Alice"}'::jsonb, '[{"email":"test@gmail.com"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Test Subject', 'Hello', 'Hello', false, false, '["INBOX"]'::jsonb, 'inbound', now() - interval '1 hour', 'user', ${userId}, '[]'::jsonb, '{}'::jsonb),
        (gen_random_uuid(), ${orgId}, ${conversationId}, ${accountId}, '<msg2@test>', 'gm2', '{"email":"test@gmail.com"}'::jsonb, '[{"email":"alice@test.com"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Re: Test Subject', 'Reply', 'Reply', false, false, '["INBOX","SENT"]'::jsonb, 'outbound', now(), 'user', ${userId}, '[]'::jsonb, '{}'::jsonb)
    `)
}

describe("listConversations", () => {
  it("returns paginated conversations with cursor", async () => {
    await seedConversation()
    const result = await mailService.listConversations(mailDb, { orgId, userId, limit: 25 })
    expect(result.data.length).toBeGreaterThanOrEqual(1)
    expect(result.data[0].subject).toBe("Test Subject")
    expect(result.data[0].senderName).toBe("Alice")
    expect(result.data[0].senderEmail).toBe("alice@test.com")
    expect(result.meta.total).toBeGreaterThanOrEqual(1)
  })

  it("filters by ids: only the named conversations come back", async () => {
    await seedConversation()
    const named = await mailService.listConversations(mailDb, {
      orgId,
      userId,
      ids: [conversationId],
      limit: 25,
    })
    expect(named.data.map((c: { id: string }) => c.id)).toEqual([conversationId])
    const other = await mailService.listConversations(mailDb, {
      orgId,
      userId,
      ids: ["00000000-0000-4000-8000-000000000000"],
      limit: 25,
    })
    expect(other.data).toEqual([])
  })

  it("ownership=personal excludes conversations from org-owned mailboxes", async () => {
    await seedConversation()
    const [orgAcc] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
        SELECT gen_random_uuid(), ${orgId}, connected_account_id, 'org', ${orgId}, 'gmail', 'contact@test.com', 'active'
        FROM app_mail.accounts WHERE id = ${accountId}
        RETURNING id
      `),
    )
    await db.execute(drizzleSql`
      INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count)
      VALUES (gen_random_uuid(), ${orgId}, ${orgAcc.id}, 'org', ${orgId}, 'thread-org', 'Shared Subject', '...', 'open', '["INBOX"]'::jsonb, false, false, now(), 1)
    `)

    const all = await mailService.listConversations(mailDb, { orgId, userId, limit: 25 })
    expect(all.data.map((c: any) => c.subject)).toContain("Shared Subject")

    const personal = await mailService.listConversations(mailDb, {
      orgId,
      userId,
      ownership: "personal",
      limit: 25,
    })
    const subjects = personal.data.map((c: any) => c.subject)
    expect(subjects).toContain("Test Subject")
    expect(subjects).not.toContain("Shared Subject")
    expect(personal.meta.total).toBe(personal.data.length)
  })

  it("category (S13/A40): primary gives 3 of the four Gmail shapes, other 1, all 4", async () => {
    await seedConversation()
    const [acc] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
        SELECT gen_random_uuid(), ${orgId}, connected_account_id, 'user', ${userId}, 'gmail', ${`cat-${Date.now()}@test.com`}, 'active'
        FROM app_mail.accounts WHERE id = ${accountId}
        RETURNING id
      `),
    )
    const shapes: Array<[string, string[]]> = [
      ["cat-personal", ["INBOX", "CATEGORY_PERSONAL"]],
      ["cat-promotions", ["INBOX", "CATEGORY_PROMOTIONS"]],
      ["cat-none", ["INBOX"]],
      ["cat-updates-personal", ["INBOX", "CATEGORY_UPDATES", "CATEGORY_PERSONAL"]],
    ]
    for (const [subject, labels] of shapes) {
      await db.execute(drizzleSql`
        INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count)
        VALUES (gen_random_uuid(), ${orgId}, ${acc.id}, 'user', ${userId}, ${`thread-${subject}`}, ${subject}, '...', 'open', ${JSON.stringify(labels)}::jsonb, false, false, now(), 1)
      `)
    }
    const list = async (category?: "primary" | "other" | "all") =>
      mailService.listConversations(mailDb, {
        orgId,
        userId,
        accountId: acc.id,
        category,
        limit: 25,
      })
    const subjects = (r: { data: any[] }) => r.data.map((c) => c.subject).sort()

    const primary = await list("primary")
    expect(subjects(primary)).toEqual(["cat-none", "cat-personal", "cat-updates-personal"])
    expect(primary.meta.total).toBe(3)
    const other = await list("other")
    expect(subjects(other)).toEqual(["cat-promotions"])
    expect(other.meta.total).toBe(1)
    expect((await list("all")).meta.total).toBe(4)
    expect((await list()).meta.total).toBe(4)
  })

  it("filters by status", async () => {
    await seedConversation()
    const result = await mailService.listConversations(mailDb, {
      orgId,
      userId,
      status: "archived",
      limit: 25,
    })
    expect(result.data.length).toBe(0)
  })

  // D2 mail perf: `COUNT(*) OVER()` re-scanned the whole matching set on EVERY
  // page (a windowed scan inside the join-heavy page query). The fix computes
  // total via a separate cheap non-windowed COUNT(*) query, run concurrently
  // with the page query via Promise.all — so EVERY page (first or cursor)
  // issues exactly 2 queries, never the windowed one.
  it("first page total is correct and issues 2 queries (page + count)", async () => {
    await seedConversation()
    let executeCalls = 0
    const originalExecute = mailDb.execute.bind(mailDb)
    mailDb.execute = (...args: any[]) => {
      executeCalls++
      return originalExecute(...args)
    }
    try {
      const result = await mailService.listConversations(mailDb, { orgId, userId, limit: 25 })
      expect(result.meta.total).toBeGreaterThanOrEqual(1)
      expect(executeCalls).toBe(2)
    } finally {
      mailDb.execute = originalExecute
    }
  })

  // Mail D2-consistency fix: a cursor page must NOT report total=0 (that
  // regressed accuracy vs the pre-D2 COUNT(*) OVER() behavior). It still
  // costs only 2 queries (page + a cheap separate count, run concurrently via
  // Promise.all) — never the windowed COUNT(*) OVER() — and the count query
  // uses the filter predicate WITHOUT the cursor's `last_message_at <`
  // clause, so `meta.total` reflects every conversation matching the filters,
  // not just those remaining after the cursor.
  it("a cursor page still reports the accurate total and issues 2 queries (page + count, no windowed re-scan)", async () => {
    await seedConversation()
    let executeCalls = 0
    const originalExecute = mailDb.execute.bind(mailDb)
    mailDb.execute = (...args: any[]) => {
      executeCalls++
      return originalExecute(...args)
    }
    try {
      // The cursor predicate is `last_message_at < cursor`; seeded conversation's
      // last_message_at is now(), so a cursor set to a PAST instant matches
      // nothing further on the PAGE (there is nothing older to page into), but
      // the total must still count the conversation seeded above (the count
      // query uses `countWhere`, captured BEFORE the cursor clause is appended).
      const pastCursor = new Date(Date.now() - 3_600_000).toISOString()
      const result = await mailService.listConversations(mailDb, {
        orgId,
        userId,
        limit: 25,
        cursor: pastCursor,
      })
      expect(result.data.length).toBe(0)
      expect(result.meta.total).toBeGreaterThanOrEqual(1)
      expect(executeCalls).toBe(2)
    } finally {
      mailDb.execute = originalExecute
    }
  })
})

describe("account preferences", () => {
  it("projects unread counts and sender-image preferences through listAccounts", async () => {
    await seedConversation()

    const rows = await mailService.listAccounts(mailDb, { orgId, userId })
    expect(rows).toEqual([
      expect.objectContaining({
        id: accountId,
        unreadCount: 1,
        allowedImageSenderDomains: [],
      }),
    ])
  })

  it("listAccounts reports connectionHealth from the kernel account row", async () => {
    await seedConversation()

    let rows = await mailService.listAccounts(mailDb, { orgId, userId })
    expect(rows[0]?.connectionHealth).toEqual({ status: "ok" })

    await db.execute(drizzleSql`
      UPDATE kernel.connected_accounts
      SET status = 'error', status_message = 'Authorization expired, reconnect required'
      WHERE org_id = ${orgId} AND app_name = 'mail' AND identifier = 'test@gmail.com'`)

    rows = await mailService.listAccounts(mailDb, { orgId, userId })
    expect(rows[0]?.connectionHealth).toEqual({
      status: "needs_reconnect",
      reason: "error",
      statusMessage: "Authorization expired, reconnect required",
    })
  })

  it("stores sender-image preferences per user", async () => {
    await seedConversation()

    const result = await mailService.allowSenderImageDomain(mailDb, {
      orgId,
      userId,
      accountId,
      senderDomain: "Images.Example.com",
    })

    expect(result.allowedImageSenderDomains).toEqual(["images.example.com"])

    const rows = await mailService.listAccounts(mailDb, { orgId, userId })
    expect(rows[0]?.allowedImageSenderDomains).toEqual(["images.example.com"])
  })
})

describe("getConversation", () => {
  it("returns conversation with messages", async () => {
    await seedConversation()
    const result = await mailService.getConversation(mailDb, { orgId, userId, conversationId })
    expect(result?.conversation.id).toBe(conversationId)
    expect(result?.messages.length).toBe(2)
    expect(result?.messages[0].direction).toBeDefined()
    expect(events).toEqual([
      expect.objectContaining({
        entity: "conversation",
        action: "update",
        entityId: conversationId,
        actorType: "user",
        data: { id: conversationId, accountId, isRead: true },
      }),
    ])
  })

  it("reports read when a concurrent open marks it read first", async () => {
    // The web client opens a conversation with two parallel page loads. Hold
    // the other load's mark-read UPDATE uncommitted so this call reads the row
    // as unread, then blocks on the row lock and finds nothing left to flip.
    await seedConversation()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let lockHeld!: (pid: number) => void
    const holderPid = new Promise<number>((resolve) => {
      lockHeld = resolve
    })
    const holder = sql.begin(async (tx) => {
      const [{ pid }] = await tx.unsafe(`SELECT pg_backend_pid() AS pid`)
      await tx.unsafe(`UPDATE app_mail.conversations SET is_read = true WHERE id = $1`, [
        conversationId,
      ])
      lockHeld(pid)
      await released
    })
    const pid = await holderPid

    const pending = mailService.getConversation(mailDb, { orgId, userId, conversationId })
    let blocked = false
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      const [{ n }] = await sql.unsafe(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      )
      blocked = n > 0
      if (!blocked) await Bun.sleep(25)
    }
    release()
    await holder
    const result = await pending

    expect(blocked).toBe(true)
    expect(result?.conversation.isRead).toBe(true)
    // The load that flipped the row owns the update event; this one emits none.
    expect(events).toEqual([])
  })

  it("returns null for nonexistent conversation", async () => {
    const result = await mailService.getConversation(mailDb, {
      orgId,
      userId,
      conversationId: "00000000-0000-0000-0000-000000000000",
    })
    expect(result).toBeNull()
  })
})

describe("sendReply", () => {
  it("sends through the provider sandbox export and stores an outbound message", async () => {
    await seedConversation()
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id: "out-msg-1", threadId: "thread-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )

    try {
      const result = await mailService.sendReply(mailDb, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>Reply</p>",
        textBody: "Reply",
      })

      expect(result.messageId).toBe("out-msg-1")
      const rows = extractRows(
        await db.execute(
          drizzleSql`SELECT direction, text_body FROM app_mail.messages WHERE conversation_id = ${conversationId} ORDER BY created_at DESC`,
        ),
      )
      expect(
        rows.some((row: any) => row.direction === "outbound" && row.text_body === "Reply"),
      ).toBe(true)
      // The newest message in the seeded conversation is the team's OWN outbound
      // (test@gmail.com). The reply must still be addressed to the latest
      // inbound sender (alice@test.com), never to the mailbox's own address.
      const reply = extractRows(
        await db.execute(
          drizzleSql`SELECT to_addresses FROM app_mail.messages WHERE conversation_id = ${conversationId} AND external_message_id = 'out-msg-1' LIMIT 1`,
        ),
      )[0] as any
      expect(reply.to_addresses).toEqual([{ email: "alice@test.com", name: "Alice" }])
      expect(await loadOutboxEvents()).toEqual([
        expect.objectContaining({
          entity: "message",
          action: "create",
          actorType: "user",
        }),
        expect.objectContaining({
          entity: "conversation",
          action: "update",
          actorType: "user",
        }),
      ])
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })
})

describe("sendReply — threading correctness when newest message is outbound", () => {
  it("always replies to the inbound sender, even when the last stored message is outbound", async () => {
    // Seed a conversation whose most-recent message is an outbound one
    // (from the mailbox to alice). The reply must still be addressed to alice,
    // not to the mailbox's own address.
    await seedConversation()
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id: "out-msg-dir", threadId: "thread-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )

    try {
      await mailService.sendReply(mailDb, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>Following up</p>",
        textBody: "Following up",
      })

      // The reply must be addressed to the inbound sender (alice@test.com),
      // not to the mailbox's own address (test@gmail.com) which happens to be
      // the from_address of the newest (outbound) message in the seeded data.
      const rows = extractRows<{ to_addresses: unknown; direction: string }>(
        await db.execute(
          drizzleSql`SELECT to_addresses, direction FROM app_mail.messages WHERE conversation_id = ${conversationId} AND external_message_id = 'out-msg-dir' LIMIT 1`,
        ),
      )
      const reply = rows[0]
      expect(reply).toBeDefined()
      expect(reply.direction).toBe("outbound")
      expect(reply.to_addresses).toEqual([{ email: "alice@test.com", name: "Alice" }])
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })
})

describe("sendCompose", () => {
  it("sends through the provider sandbox export and creates a new conversation", async () => {
    await seedConversation()
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id: "out-msg-2", threadId: "thread-compose-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )

    try {
      const result = await mailService.sendCompose(mailDb, {
        orgId,
        userId,
        accountId,
        to: ["someone@test.com"],
        subject: "Compose Subject",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      })

      expect(result.messageId).toBe("out-msg-2")
      expect(result.conversationId).toBeTruthy()
      expect(await loadOutboxEvents()).toEqual([
        expect.objectContaining({
          entity: "conversation",
          action: "create",
          actorType: "user",
        }),
        expect.objectContaining({
          entity: "message",
          action: "create",
          actorType: "user",
        }),
      ])
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })
})

// Migration 0116 made (org_id, account_id, external_message_id) and
// (org_id, account_id, external_thread_id) unique. A send is delivered BEFORE it
// is stored, so a store that collides with a row the sync already wrote (or a
// retried send) must join that row, never fail after the email went out.
describe("persisting a delivered send is idempotent on the mail unique keys", () => {
  function provider(id: string, threadId: string) {
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id, threadId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )
  }
  async function countMessages(externalMessageId: string): Promise<number> {
    return extractRows<{ n: number }>(
      await db.execute(drizzleSql`SELECT count(*)::int AS n FROM app_mail.messages
        WHERE org_id = ${orgId} AND external_message_id = ${externalMessageId}`),
    )[0].n
  }

  it("a reply whose provider id is already stored is a no-op, not a failure", async () => {
    await seedConversation()
    provider("out-dup-1", "thread-1")
    try {
      const send = () =>
        mailService.sendReply(mailDb, {
          orgId,
          userId,
          conversationId,
          htmlBody: "<p>Once</p>",
          textBody: "Once",
        })
      await send()
      await send()
      expect(await countMessages("out-dup-1")).toBe(1)
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })

  it("a reply reads what it answered: the earlier messages and the conversation", async () => {
    await seedConversation()
    provider("out-read-1", "thread-1")
    try {
      await mailService.sendReply(mailDb, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>Seen</p>",
        textBody: "Seen",
      })
      const unread = extractRows<{ n: number }>(
        await db.execute(drizzleSql`SELECT count(*)::int AS n FROM app_mail.messages
          WHERE conversation_id = ${conversationId} AND is_read = false`),
      )[0].n
      expect(unread).toBe(0)
      const [conv] = extractRows<{ is_read: boolean }>(
        await db.execute(
          drizzleSql`SELECT is_read FROM app_mail.conversations WHERE id = ${conversationId}`,
        ),
      )
      expect(conv.is_read).toBe(true)
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })

  it("a compose whose thread the sync already imported joins that conversation", async () => {
    await seedConversation()
    // The sync imported the sent thread between the send and the store.
    const [existing] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, owner_id,
          external_thread_id, subject, status, labels, is_read, is_starred, message_count)
        VALUES (gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'thread-synced',
          'Compose', 'open', '["SENT"]'::jsonb, true, false, 0)
        RETURNING id`),
    )
    provider("out-compose-synced", "thread-synced")
    try {
      const result = await mailService.sendCompose(mailDb, {
        orgId,
        userId,
        accountId,
        to: ["someone@test.com"],
        subject: "Compose",
        htmlBody: "<p>Hi</p>",
        textBody: "Hi",
      })
      expect(result.conversationId).toBe(existing.id)
      const [conv] = extractRows<{ message_count: number }>(
        await db.execute(
          drizzleSql`SELECT message_count FROM app_mail.conversations WHERE id = ${existing.id}`,
        ),
      )
      expect(conv.message_count).toBe(1)
      expect(await countMessages("out-compose-synced")).toBe(1)
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })
})

describe("drafts", () => {
  it("createDraft creates a compose draft with empty defaults", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    expect(draft.id).toBeDefined()
    expect(draft.conversationId).toBeNull()
    expect(draft.accountId).toBe(accountId)
  })

  it("createDraft creates a reply draft linked to conversation", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, {
      orgId,
      userId,
      accountId,
      conversationId,
    })
    expect(draft.conversationId).toBe(conversationId)
  })

  it("createDraft stores a reply draft's recipients and subject from the start", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, {
      orgId,
      userId,
      accountId,
      conversationId,
      to: [{ email: "sender@example.com" }],
      cc: [{ email: "copy@example.com" }],
      subject: "Re: Invoice",
    })
    expect(draft.to).toEqual([{ email: "sender@example.com" }])
    expect(draft.cc).toEqual([{ email: "copy@example.com" }])
    expect(draft.subject).toBe("Re: Invoice")
    const [listed] = (await mailService.listDrafts(mailDb, { orgId, userId })).filter(
      (d: any) => d.id === draft.id,
    )
    expect(listed.to).toEqual([{ email: "sender@example.com" }])
    expect(listed.subject).toBe("Re: Invoice")
  })

  it("reply draft upsert returns existing draft on second call", async () => {
    await seedConversation()
    const first = await mailService.createDraft(mailDb, {
      orgId,
      userId,
      accountId,
      conversationId,
    })
    const second = await mailService.createDraft(mailDb, {
      orgId,
      userId,
      accountId,
      conversationId,
    })
    expect(first.id).toBe(second.id)
  })

  it("listDrafts returns only the current user's drafts", async () => {
    await seedConversation()
    await mailService.createDraft(mailDb, { orgId, userId, accountId })
    const result = await mailService.listDrafts(mailDb, { orgId, userId })
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result.every((d: any) => d.accountId === accountId)).toBe(true)
  })

  it("getDraft returns the draft", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    const found = await mailService.getDraft(mailDb, { orgId, userId, draftId: draft.id })
    expect(found?.id).toBe(draft.id)
  })

  it("getDraft returns null for nonexistent draft", async () => {
    const found = await mailService.getDraft(mailDb, {
      orgId,
      userId,
      draftId: "00000000-0000-0000-0000-000000000000",
    })
    expect(found).toBeNull()
  })

  it("updateDraft saves field changes", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    const updated = await mailService.updateDraft(mailDb, {
      orgId,
      userId,
      draftId: draft.id,
      changes: { subject: "Hello world", htmlBody: "<p>Hi</p>", textBody: "Hi" },
    })
    expect(updated?.subject).toBe("Hello world")
    expect(updated?.htmlBody).toBe("<p>Hi</p>")
  })

  it("deleteDraft removes the draft", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    await mailService.deleteDraft(mailDb, { orgId, userId, draftId: draft.id })
    const found = await mailService.getDraft(mailDb, { orgId, userId, draftId: draft.id })
    expect(found).toBeNull()
  })

  it("sendDraft sends compose email and deletes draft", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id: "sent-msg-1", threadId: "thread-compose-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )
    try {
      const result = await mailService.sendDraft(mailDb, {
        orgId,
        userId,
        draftId: draft.id,
        to: [{ email: "bob@test.com" }],
        subject: "Test Send",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      })
      expect(result.messageId).toBeDefined()
      const found = await mailService.getDraft(mailDb, { orgId, userId, draftId: draft.id })
      expect(found).toBeNull()
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  })

  it("sendDraft puts draft-staged files into the outgoing MIME and reparents them", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })

    // Stage a real object + kernel.files row on the draft, exactly what the
    // composer's attach control produces.
    const { putObject } = await import("~/infra/storage/object-storage")
    const storageKey = `orgs/${orgId}/mail/draft/${draft.id}/quote.pdf`
    const fileBytes = Buffer.from("%PDF-1.4\nattached quote\n")
    await putObject({ key: storageKey, body: fileBytes, contentType: "application/pdf" })
    const [fileRow] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                  size_bytes, storage_key, uploaded_by)
        VALUES (gen_random_uuid(), ${orgId}, 'mail', 'draft', ${draft.id}, 'quote.pdf',
                'application/pdf', ${fileBytes.byteLength}, ${storageKey}, ${userId})
        RETURNING id::text AS id
      `),
    )

    const bodies: string[] = []
    SandboxBridgeTestAccess.setFetch((async (_url: unknown, init?: { body?: unknown }) => {
      if (typeof init?.body === "string") bodies.push(init.body)
      return new Response(JSON.stringify({ id: "sent-msg-att-1", threadId: "thread-att-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch)
    try {
      const result = await mailService.sendDraft(mailDb, {
        orgId,
        userId,
        draftId: draft.id,
        to: [{ email: "bob@test.com" }],
        subject: "With attachment",
        htmlBody: "<p>see attached</p>",
        textBody: "see attached",
      })
      expect(result.messageId).toBeDefined()

      // The provider request carried the file: the raw MIME names the file and
      // includes its base64 payload.
      const joined = bodies.join("\n")
      expect(joined.length).toBeGreaterThan(0)
      const rawMatch = joined.match(/"raw"\s*:\s*"([^"]+)"/)
      expect(rawMatch).toBeTruthy()
      const mime = Buffer.from(
        rawMatch![1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8")
      expect(mime).toContain('filename="quote.pdf"')
      expect(mime.replace(/\r?\n/g, "")).toContain(fileBytes.toString("base64"))

      // The staged file row was reparented onto the persisted sent message.
      const reparented = extractRows<{ app: string; entity_type: string; entity_id: string }>(
        await db.execute(drizzleSql`
          SELECT app, entity_type, entity_id::text AS entity_id
          FROM kernel.files WHERE id = ${fileRow.id}
        `),
      )
      expect(reparented[0].app).toBe("mail")
      expect(reparented[0].entity_type).toBe("message")
      const msgRows = extractRows<{ id: string }>(
        await db.execute(
          drizzleSql`SELECT id::text AS id FROM app_mail.messages WHERE external_message_id = ${result.messageId}`,
        ),
      )
      expect(reparented[0].entity_id).toBe(msgRows[0].id)
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
      // The file row references the suite's user via uploaded_by — remove it so
      // afterAll's user cleanup doesn't trip the FK.
      await db.execute(drizzleSql`DELETE FROM kernel.files WHERE id = ${fileRow.id}`)
    }
  })
})

describe("a person's send happens once per draft", () => {
  let sends = 0
  /** Gmail answers the send after `delayMs`, with `status`. */
  function mockGmailSend(opts: { delayMs?: number; status?: number; id?: string } = {}) {
    sends = 0
    SandboxBridgeTestAccess.setFetch((async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.includes("/messages/send")) {
        sends += 1
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      }
      const status = opts.status ?? 200
      const body = status === 200 ? { id: opts.id ?? `once-${sends}`, threadId: "thread-once" } : {}
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch)
  }
  function withEnv(name: string, value: string | undefined): () => void {
    const before = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    return () => {
      if (before === undefined) delete process.env[name]
      else process.env[name] = before
    }
  }
  async function draftState(draftId: string) {
    const [row] = extractRows<{ send_state: string | null }>(
      await db.execute(drizzleSql`SELECT send_state FROM app_mail.drafts WHERE id = ${draftId}`),
    )
    return row
  }
  const sendIt = (draftId: string, extra: { confirmResend?: boolean } = {}) =>
    mailService.sendDraft(mailDb, {
      orgId,
      userId,
      draftId,
      to: [{ email: "bob@test.com" }],
      subject: "Once",
      htmlBody: "<p>Once</p>",
      textBody: "Once",
      ...extra,
    })

  afterEach(() => {
    SandboxBridgeTestAccess.setFetch(null)
  })

  it("waits for a provider slower than the sandbox default instead of failing a delivered send", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    mockGmailSend({ delayMs: 300, id: "slow-but-sent" })
    const restore = withEnv("LIAISON_SANDBOX_TIMEOUT_MS", "50")
    try {
      const result = await sendIt(draft.id)
      expect(result.messageId).toBe("slow-but-sent")
      expect(sends).toBe(1)
      expect(await draftState(draft.id)).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a send the provider never confirmed is reported as maybe delivered, and not sent again unless confirmed", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    mockGmailSend({ delayMs: 200, id: "maybe-sent" })
    const restore = withEnv("LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS", "50")
    try {
      await expect(sendIt(draft.id)).rejects.toMatchObject({
        status: 409,
        code: mailService.MAIL_SEND_OUTCOME_UNKNOWN,
      })
      await new Promise((r) => setTimeout(r, 250))
      expect(sends).toBe(1)
      expect((await draftState(draft.id))?.send_state).toBe("unknown")
      // A retry (a second click, a lost answer) sends nothing.
      await expect(sendIt(draft.id)).rejects.toMatchObject({
        code: mailService.MAIL_SEND_OUTCOME_UNKNOWN,
      })
      expect(sends).toBe(1)
    } finally {
      restore()
    }
    // The person checked Sent and says send it again: it goes, once.
    mockGmailSend({ id: "resent" })
    const result = await sendIt(draft.id, { confirmResend: true })
    expect(result.messageId).toBe("resent")
    expect(sends).toBe(1)
    expect(await draftState(draft.id)).toBeUndefined()
  })

  it("a send the provider refused left nothing, so it can be sent again", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    mockGmailSend({ status: 400 })
    await expect(sendIt(draft.id)).rejects.toMatchObject({ code: "GMAIL_SEND_FAILED" })
    expect((await draftState(draft.id))?.send_state).toBeNull()
    mockGmailSend({ id: "after-refusal" })
    const result = await sendIt(draft.id)
    expect(result.messageId).toBe("after-refusal")
    expect(sends).toBe(1)
  })

  it("a retry of a send the provider accepted records that message and sends nothing", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    await db.execute(drizzleSql`
      UPDATE app_mail.drafts
         SET send_state = 'sent', send_started_at = now(),
             sent_message_id = 'accepted-before', sent_thread_id = 'thread-accepted'
       WHERE id = ${draft.id}`)
    mockGmailSend({ id: "must-not-send" })
    const result = await sendIt(draft.id)
    expect(result.messageId).toBe("accepted-before")
    expect(sends).toBe(0)
    const stored = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM app_mail.messages
                    WHERE org_id = ${orgId} AND external_message_id = 'accepted-before'`,
      ),
    )
    expect(stored[0].n).toBe(1)
    expect(await draftState(draft.id)).toBeUndefined()
  })

  it("a draft another request is sending right now is refused, not sent twice", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })
    await db.execute(drizzleSql`
      UPDATE app_mail.drafts SET send_state = 'sending', send_started_at = now()
       WHERE id = ${draft.id}`)
    mockGmailSend()
    await expect(sendIt(draft.id)).rejects.toMatchObject({
      status: 409,
      code: mailService.MAIL_SEND_IN_PROGRESS,
    })
    await expect(sendIt(draft.id, { confirmResend: true })).rejects.toMatchObject({
      code: mailService.MAIL_SEND_IN_PROGRESS,
    })
    expect(sends).toBe(0)
  })
})

describe("internal sender attribution", () => {
  async function withMockedSend<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id: messageId, threadId: `thread-${messageId}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )
    try {
      return await fn()
    } finally {
      SandboxBridgeTestAccess.setFetch(null)
    }
  }

  it("sendReply persists sent_by_user_id and emits it", async () => {
    await seedConversation()

    const result = await withMockedSend("attr-reply-1", () =>
      mailService.sendReply(mailDb, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>hi</p>",
        textBody: "hi",
      }),
    )

    const rows = extractRows<{ sent_by_user_id: string }>(
      await db.execute(
        drizzleSql`SELECT sent_by_user_id FROM app_mail.messages WHERE external_message_id = ${result.messageId}`,
      ),
    )
    expect(rows[0].sent_by_user_id).toBe(userId)
    const messageEvent = (await loadOutboxEvents()).find(
      (event) => event.entity === "message" && event.action === "create",
    )
    expect(messageEvent).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ sentByUser: expect.objectContaining({ id: userId }) }),
      }),
    )
  })

  it("sendCompose persists sent_by_user_id", async () => {
    await seedConversation()

    const result = await withMockedSend("attr-compose-1", () =>
      mailService.sendCompose(mailDb, {
        orgId,
        userId,
        accountId,
        to: ["someone@test.com"],
        subject: "Attribution compose",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
      }),
    )

    const rows = extractRows<{ sent_by_user_id: string }>(
      await db.execute(
        drizzleSql`SELECT sent_by_user_id FROM app_mail.messages WHERE external_message_id = ${result.messageId}`,
      ),
    )
    expect(rows[0].sent_by_user_id).toBe(userId)
  })

  it("sendDraft persists sent_by_user_id from the draft sender", async () => {
    await seedConversation()
    const draft = await mailService.createDraft(mailDb, { orgId, userId, accountId })

    const result = await withMockedSend("attr-draft-1", () =>
      mailService.sendDraft(mailDb, {
        orgId,
        userId,
        draftId: draft.id,
        to: [{ email: "draft@test.com" }],
        subject: "Draft attribution",
        htmlBody: "<p>Draft</p>",
        textBody: "Draft",
      }),
    )

    const rows = extractRows<{ sent_by_user_id: string }>(
      await db.execute(
        drizzleSql`SELECT sent_by_user_id FROM app_mail.messages WHERE external_message_id = ${result.messageId}`,
      ),
    )
    expect(rows[0].sent_by_user_id).toBe(userId)
  })

  it("getConversation projects sentByUser for outbound messages", async () => {
    await seedConversation()
    await withMockedSend("attr-projection-1", () =>
      mailService.sendReply(mailDb, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>Projection</p>",
        textBody: "Projection",
      }),
    )
    events.length = 0

    const result = await mailService.getConversation(mailDb, { orgId, userId, conversationId })
    const outbound = result!.messages.find(
      (message: any) => message.externalMessageId === "attr-projection-1",
    )

    expect(outbound!.sentByUser).toEqual({ id: userId, name: "Mail User", avatarUrl: null })
  })

  it("getConversation returns sentByUser null for rows without sent_by_user_id", async () => {
    await seedConversation()

    const result = await mailService.getConversation(mailDb, { orgId, userId, conversationId })
    const nativeOutbound = result!.messages.find(
      (message: any) => message.externalMessageId === "<msg2@test>",
    )

    expect(nativeOutbound!.sentByUser).toBeNull()
  })

  it("getConversation does not project sentByUser from another org", async () => {
    const otherOrgId = "00000000-0000-0000-0000-00000000f901"
    const otherUserId = "00000000-0000-0000-0000-00000000f902"
    await seedConversation()
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${otherOrgId}, 'Other Sender Org', 'other-sender-org') ON CONFLICT DO NOTHING`,
    )
    await db.execute(
      drizzleSql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${otherUserId}, ${otherOrgId}, 'other-sender@test.com', 'Other Sender') ON CONFLICT DO NOTHING`,
    )
    await db.execute(drizzleSql`
      INSERT INTO app_mail.messages (
        org_id, conversation_id, account_id, external_message_id, external_provider_id, from_address, to_addresses,
        cc_addresses, bcc_addresses, subject, direction, text_body, html_body, snippet, is_read, is_starred,
        labels, sent_at, owner_type, owner_id, sent_by_user_id, message_references, raw_headers
      ) VALUES (
        ${orgId}, ${conversationId}, ${accountId}, 'cross-org-sender', 'cross-provider', '{}'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '[]'::jsonb, 'Cross org', 'outbound', 'Cross org', '', 'Cross org', false, false,
        '[]'::jsonb, now(), 'user', ${userId}, ${otherUserId}, '[]'::jsonb, '{}'::jsonb
      )
    `)

    const result = await mailService.getConversation(mailDb, { orgId, userId, conversationId })
    const outbound = result!.messages.find(
      (message: any) => message.externalMessageId === "cross-org-sender",
    )

    expect(outbound!.sentByUser).toBeNull()
  })
})

describe("updateConversation assignedTo validation", () => {
  async function seedOrgInbox() {
    const [grantedUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`grant-${Date.now()}@test.com`}, 'Granted User', 'active', 'hash')
      RETURNING id
    `),
    )
    const [noGrantUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`nogrant-${Date.now()}@test.com`}, 'No Grant User', 'active', 'hash')
      RETURNING id
    `),
    )
    const [connected] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by, access_token_encrypted
      )
      VALUES (
        gen_random_uuid(), ${orgId}, 'mail', 'gmail', 'org', null,
        'oauth2', ${`shared-${Date.now()}@gmail.com`}, 'active', ${userId}, ${encryptSecret("org-mail-token", ACTIVE_ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)}
      )
      RETURNING id
    `),
    )
    const [account] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
      VALUES (gen_random_uuid(), ${orgId}, ${connected.id}, 'org', null, 'gmail', ${`shared-${Date.now()}@gmail.com`}, 'active')
      RETURNING id
    `),
    )
    const [conversation] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
      INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count)
      VALUES (gen_random_uuid(), ${orgId}, ${account.id}, 'org', null, ${`shared-thread-${Date.now()}`}, 'Shared', 'Shared', 'open', '[]'::jsonb, true, false, now(), 0)
      RETURNING id
    `),
    )
    await db.execute(drizzleSql`
      INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${grantedUser.id}, ${orgId}, 'mail:inbox', ${JSON.stringify([account.id])}::jsonb)
    `)
    return {
      accountId: account.id,
      conversationId: conversation.id,
      grantedUserId: grantedUser.id,
      noGrantUserId: noGrantUser.id,
    }
  }

  // A shared mailbox's Retry now: the admin wildcard and the parent grant hold
  // `mail:accounts:admin` exactly as the route guard reads them (hasScope),
  // so the sync is enqueued.
  for (const scopes of [["*"], ["mail:*"], ["mail:accounts"], ["mail:accounts:admin"]]) {
    it(`lets ${scopes[0]} sync an org-owned mailbox`, async () => {
      const fixture = await seedOrgInbox()
      await expect(
        mailService.triggerSync(mailDb, { orgId, userId, accountId: fixture.accountId, scopes }),
      ).resolves.toEqual({ enqueued: true })
    })
  }

  it("refuses an org-owned mailbox sync without the mail admin scope", async () => {
    const fixture = await seedOrgInbox()
    await expect(
      mailService.triggerSync(mailDb, {
        orgId,
        userId,
        accountId: fixture.accountId,
        scopes: ["mail:conversations:read", "kernel:*"],
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it("rejects assignedTo for a user without mail:inbox grant", async () => {
    const fixture = await seedOrgInbox()

    await expect(
      mailService.updateConversation(mailDb, {
        orgId,
        userId,
        conversationId: fixture.conversationId,
        changes: { assignedTo: fixture.noGrantUserId },
      }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it("rejects assignedTo for a user outside the org", async () => {
    const fixture = await seedOrgInbox()

    await expect(
      mailService.updateConversation(mailDb, {
        orgId,
        userId,
        conversationId: fixture.conversationId,
        changes: { assignedTo: "00000000-0000-0000-0000-000000000099" },
      }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it("accepts assignedTo for a user with mail:inbox grant", async () => {
    const fixture = await seedOrgInbox()

    const result = await mailService.updateConversation(mailDb, {
      orgId,
      userId,
      conversationId: fixture.conversationId,
      changes: { assignedTo: fixture.grantedUserId },
    })

    expect(result?.assigned_to).toBe(fixture.grantedUserId)
  })

  it("accepts assignedTo null", async () => {
    const fixture = await seedOrgInbox()

    const result = await mailService.updateConversation(mailDb, {
      orgId,
      userId,
      conversationId: fixture.conversationId,
      changes: { assignedTo: null },
    })

    expect(result?.assigned_to).toBeNull()
  })

  it("rejects assignedTo on personal account conversations", async () => {
    await seedConversation()
    const fixture = await seedOrgInbox()

    await expect(
      mailService.updateConversation(mailDb, {
        orgId,
        userId,
        conversationId,
        changes: { assignedTo: fixture.grantedUserId },
      }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it("lists assignable users for a shared account", async () => {
    const fixture = await seedOrgInbox()

    const result = await mailService.listAssignableUsersForAccount(mailDb, {
      orgId,
      requesterId: fixture.grantedUserId,
      accountId: fixture.accountId,
    })

    expect(result).toEqual([
      expect.objectContaining({ id: fixture.grantedUserId, name: "Granted User" }),
    ])
    expect(result.some((row: any) => row.id === fixture.noGrantUserId)).toBe(false)
  })

  it("rejects assignee listing for users without shared inbox access", async () => {
    const fixture = await seedOrgInbox()

    await expect(
      mailService.listAssignableUsersForAccount(mailDb, {
        orgId,
        requesterId: fixture.noGrantUserId,
        accountId: fixture.accountId,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })
})
