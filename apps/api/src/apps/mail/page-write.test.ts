// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail sync's page write, end to end on a real database: the real bundle in
// the real sandbox over the real session bridge (one short RLS transaction per
// bridge call, as production mail jobs run), with only the logs stubbed.
//
// Two findings of the 2026-09-30 design audit are pinned here:
//
//   #3  a sync page is written in a CONSTANT number of bridge calls (it was ~8
//       per message, each its own transaction, two of them unindexed scans),
//       idempotently, with the conversation roll-up right;
//   #6  a personal mailbox never adds its correspondents to the org's shared
//       CRM: it links to contacts that already exist and creates none. A shared
//       (org-owned) mailbox still creates contacts for human senders, and no
//       mailbox creates one for a newsletter. The mail app cannot go around the
//       rule through the generic `resolveContact`.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { createRlsSession } from "~/db/rls"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { applyConversationLabelDelta } from "~/modules/mail/gmail-write-back"

let orgId: string
let ownerId: string
let sharedAccountId: string
let personalAccountId: string
let knownContactId: string
let bundleSource: string
const suffix = crypto.randomUUID().slice(0, 8)

/** Bridge methods that never reach the database. */
const NON_DB = /^(fetch|imap_|smtp_|codec_|log_|getUserId|getOrgId)/

function bridgeFor(
  counter: { db: number; byMethod: Record<string, number> },
  overrides: Record<string, unknown> = {},
) {
  const session = createRlsSession({
    actorType: "system",
    orgId,
    purpose: "job",
    scopes: ["mail:*"],
  })
  const real = createSessionRpcBridge(
    "mail",
    "system:mail:sync",
    orgId,
    session,
    mailAppManifest as never,
  )
  const bridge: Record<string, any> = {}
  for (const [name, member] of Object.entries(real)) {
    if (typeof member !== "function" || member.constructor.name !== "AsyncFunction") {
      bridge[name] = member
      continue
    }
    bridge[name] = async (...args: unknown[]) => {
      if (!NON_DB.test(name)) {
        counter.db++
        counter.byMethod[name] = (counter.byMethod[name] ?? 0) + 1
      }
      return member(...args)
    }
  }
  for (const level of ["log_info", "log_warn", "log_error", "log_debug"]) {
    bridge[level] = () => {}
  }
  return Object.assign(bridge, overrides)
}

async function ingest(
  accountId: string,
  messages: unknown[],
  overrides: Record<string, unknown> = {},
  origin = "incremental",
) {
  const [account] = extractRows<Record<string, unknown>>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, owner_type, owner_id::text AS owner_id, encryption_state
        FROM app_mail.accounts WHERE id = ${accountId}::uuid`),
  )
  const counter = { db: 0, byMethod: {} as Record<string, number> }
  await executeInSandbox({
    pool: getSandboxPool(),
    bundleSource,
    exportName: "__test_processMessages",
    params: { messages, account, origin },
    bridge: bridgeFor(counter, overrides),
    timeoutMs: 60_000,
  } as never)
  return counter
}

let seq = 0
function message(opts: {
  thread: string
  from: string
  name?: string
  sentAt: string
  unread?: boolean
  headers?: Record<string, string>
}) {
  seq++
  return {
    externalMessageId: `<pw-${suffix}-${seq}@test.example>`,
    externalProviderId: `pw-${suffix}-${seq}`,
    externalThreadId: `pw-${suffix}-${opts.thread}`,
    from: { email: opts.from, name: opts.name },
    to: [{ email: "owner@test.example" }],
    cc: [],
    bcc: [],
    subject: `Subject ${opts.thread}`,
    textBody: `Body ${seq}`,
    htmlBody: `<p>Body ${seq}</p>`,
    snippet: `Body ${seq}`,
    headers: opts.headers ?? {},
    inReplyTo: null,
    references: [],
    labels: opts.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
    isRead: !opts.unread,
    isStarred: false,
    sentAt: opts.sentAt,
    direction: "inbound",
  }
}

async function conversation(accountId: string, thread: string) {
  const [row] = extractRows<{
    id: string
    contact_id: string | null
    message_count: number
    is_read: boolean
    last_message_at: string
    snippet: string | null
    from_email: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, contact_id::text AS contact_id, message_count, is_read,
             last_message_at::text AS last_message_at, snippet, from_email
        FROM app_mail.conversations
       WHERE account_id = ${accountId}::uuid AND external_thread_id = ${`pw-${suffix}-${thread}`}`),
  )
  return row
}

async function contactIdsFor(email: string): Promise<string[]> {
  return extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id FROM kernel.contacts
       WHERE org_id = ${orgId}::uuid AND LOWER(email) = ${email}`),
  ).map((r) => r.id)
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Page write', ${`page-write-${suffix}`}) RETURNING id`),
  )
  orgId = org.id
  const [owner] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`owner-${suffix}@test.example`}, 'Owner', 'active', 'h')
      RETURNING id`),
  )
  ownerId = owner.id
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId)

  const [shared] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, provider, email_address, sync_status, visibility)
      VALUES (${orgId}, gen_random_uuid(), 'org', 'gmail', ${`support-${suffix}@test.example`},
              'active', 'shared')
      RETURNING id`),
  )
  sharedAccountId = shared.id
  const [personal] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status,
         visibility)
      VALUES (${orgId}, gen_random_uuid(), 'user', ${ownerId}, 'gmail',
              ${`me-${suffix}@test.example`}, 'active', 'personal')
      RETURNING id`),
  )
  personalAccountId = personal.id
  // A mailbox that predates the encryption feature: unsealed, so the page is
  // written with its plaintext columns like any unsealed mailbox. The contact rule
  // keys on ownership alone, sealed or not.
  await db.execute(
    drizzleSql`UPDATE app_mail.accounts SET encryption_state = 'none' WHERE id = ${personalAccountId}::uuid`,
  )
  const [known] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.contacts (org_id, handle, email, name)
      VALUES (${orgId}, ${`C-${suffix}`}, ${`known-${suffix}@partner.example`}, 'Known Partner')
      RETURNING id`),
  )
  knownContactId = known.id

  await initSandboxPool()
  const source = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  bundleSource = `${source}
async function __test_processMessages(params, ctx) { await processMessages(params.messages, params.account, ctx, params.origin ?? "incremental") }
async function __test_resolveContact(params, ctx) { return await ctx.resolveContact(JSON.stringify(params)) }
async function __test_storedProviderIds(params, ctx) { return [...(await storedProviderIds(params.accountId, params.ids, ctx))] }`
}, 120_000)

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}::uuid`)
})

describe("mail page write (#3)", () => {
  it("writes a 25-message page in a constant number of bridge calls, idempotently", async () => {
    const page = Array.from({ length: 25 }, (_, i) =>
      message({
        thread: `t${i % 10}`,
        from: `person${i % 5}-${suffix}@corp.example`,
        name: `Person ${i % 5}`,
        sentAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        unread: i === 24,
      }),
    )
    const first = await ingest(sharedAccountId, page)
    // stored lookup, thread lookup, senders, conversations insert, messages
    // It was ~8 calls PER message (185 for this page).
    expect(first.db).toBeLessThanOrEqual(8)

    const [counts] = extractRows<{ messages: number; conversations: number; events: number }>(
      await db.execute(drizzleSql`
        SELECT (SELECT count(*)::int FROM app_mail.messages WHERE account_id = ${sharedAccountId}::uuid) AS messages,
               (SELECT count(*)::int FROM app_mail.conversations WHERE account_id = ${sharedAccountId}::uuid) AS conversations,
               (SELECT count(*)::int FROM kernel.pending_events
                 WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'mail'
                   AND payload->>'entity' = 'message' AND payload->>'action' = 'create') AS events`),
    )
    expect(counts).toEqual({ messages: 25, conversations: 10, events: 25 })
    // Thread t4 holds messages 4, 14 and 24; 24 is the newest and unread.
    const t4 = await conversation(sharedAccountId, "t4")
    expect(t4.message_count).toBe(3)
    expect(t4.is_read).toBe(false)
    expect(new Date(t4.last_message_at).toISOString()).toBe(page[24].sentAt)
    expect(t4.snippet).toBe(page[24].snippet)

    // The same page again (a retried job): one lookup, nothing written.
    const again = await ingest(sharedAccountId, page)
    expect(again.db).toBe(1)

    // A newer message into an existing thread rolls it forward; an OLDER one
    // imported later counts but never rewinds its time or snippet.
    const newer = message({
      thread: "t4",
      from: `person0-${suffix}@corp.example`,
      sentAt: "2026-09-02T00:00:00.000Z",
    })
    const older = message({
      thread: "t4",
      from: `person0-${suffix}@corp.example`,
      sentAt: "2026-08-01T00:00:00.000Z",
      unread: true,
    })
    await ingest(sharedAccountId, [newer, older])
    const rolled = await conversation(sharedAccountId, "t4")
    expect(rolled.message_count).toBe(5)
    expect(new Date(rolled.last_message_at).toISOString()).toBe(newer.sentAt)
    expect(rolled.snippet).toBe(newer.snippet)
    // The old unread message still unreads the conversation.
    expect(rolled.is_read).toBe(false)
  }, 120_000)
})

describe("a page is never half written (review of #3)", () => {
  async function count(sql: ReturnType<typeof drizzleSql>): Promise<number> {
    return extractRows<{ n: number }>(await db.execute(sql))[0]?.n ?? 0
  }

  it("a failure inside the page write leaves nothing behind, and the retry writes it whole", async () => {
    const good = message({
      thread: "atomic",
      from: `a-${suffix}@corp.example`,
      sentAt: "2026-09-07T00:00:00.000Z",
    })
    // Fails in the MESSAGE insert, after the conversation insert ran.
    const bad = {
      ...message({ thread: "atomic", from: `a-${suffix}@corp.example`, sentAt: "x" }),
      sentAt: "not-a-date",
    }
    await expect(ingest(sharedAccountId, [good, bad])).rejects.toThrow()
    expect(await conversation(sharedAccountId, "atomic")).toBeUndefined()
    expect(
      await count(drizzleSql`SELECT count(*)::int AS n FROM app_mail.messages
        WHERE external_message_id = ${good.externalMessageId}`),
    ).toBe(0)

    await ingest(sharedAccountId, [good])
    const conv = await conversation(sharedAccountId, "atomic")
    expect(conv.message_count).toBe(1)
    expect(
      await count(drizzleSql`SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'message'
          AND payload->'data'->>'conversationId' = ${conv.id}`),
    ).toBe(1)
  }, 120_000)

  it("post-commit work interrupted after the page committed is finished by the retry, once", async () => {
    const imported: Array<{ entityId: string; ordinal: number }> = []
    const files = {
      files_importAttachment: async (json: string) => {
        const p = JSON.parse(json)
        imported.push({ entityId: p.targetEntityId, ordinal: p.ordinal })
        return JSON.stringify({ id: crypto.randomUUID() })
      },
      files_listAttachments: async (json: string) => {
        const p = JSON.parse(json)
        return JSON.stringify(
          imported
            .filter((f) => f.entityId === p.entityId)
            .map((f) => ({
              id: "f",
              filename: "a",
              mimeType: "x",
              sizeBytes: 1,
              ordinal: f.ordinal,
            })),
        )
      },
    }
    const withAttachment = {
      ...message({
        thread: "resume",
        from: `r-${suffix}@corp.example`,
        sentAt: "2026-09-08T00:00:00Z",
      }),
      attachments: [
        { filename: "a.pdf", mimeType: "application/pdf", bytesBase64: "AAAA" },
        { filename: "b.pdf", mimeType: "application/pdf", bytesBase64: "BBBB" },
      ],
    }
    // The run dies after the page committed and the attachments went out,
    // before it could record that the message is finished.
    await expect(
      ingest(sharedAccountId, [withAttachment], {
        ...files,
        mail_completeIngest: async () => {
          throw new Error("InternalError: interrupted (simulated)")
        },
      }),
    ).rejects.toThrow(/interrupted/)
    const [pending] = extractRows<{ id: string; ingest_pending: boolean | null }>(
      await db.execute(drizzleSql`SELECT id::text AS id, ingest_pending FROM app_mail.messages
        WHERE external_message_id = ${withAttachment.externalMessageId}`),
    )
    expect(pending.ingest_pending).toBe(true)
    // The Gmail loops ask which listed messages are done before fetching: an
    // unfinished one is not, so the retry re-fetches it instead of skipping it.
    const done = await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "__test_storedProviderIds",
      params: { accountId: sharedAccountId, ids: [withAttachment.externalProviderId] },
      bridge: bridgeFor({ db: 0, byMethod: {} }),
      timeoutMs: 30_000,
    } as never)
    expect(done).toEqual([])

    // The retried page: the message is not treated as done, its work is finished
    // without importing an attachment twice, and nothing is counted twice.
    await ingest(sharedAccountId, [withAttachment], files)
    expect(imported.map((f) => f.ordinal).sort()).toEqual([0, 1])
    const [after] = extractRows<{ ingest_pending: boolean | null }>(
      await db.execute(
        drizzleSql`SELECT ingest_pending FROM app_mail.messages WHERE id = ${pending.id}::uuid`,
      ),
    )
    expect(after.ingest_pending).toBeNull()
    expect(
      await executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: "__test_storedProviderIds",
        params: { accountId: sharedAccountId, ids: [withAttachment.externalProviderId] },
        bridge: bridgeFor({ db: 0, byMethod: {} }),
        timeoutMs: 30_000,
      } as never),
    ).toEqual([withAttachment.externalProviderId])
    const conv = await conversation(sharedAccountId, "resume")
    expect(conv.message_count).toBe(1)
    expect(
      await count(drizzleSql`SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'message'
          AND payload->'data'->>'conversationId' = ${conv.id}`),
    ).toBe(1)
  }, 120_000)

  it("an older unread message imported later unreads a read conversation", async () => {
    const first = message({
      thread: "older",
      from: `o-${suffix}@corp.example`,
      sentAt: "2026-09-05T00:00:00.000Z",
    })
    await ingest(sharedAccountId, [first])
    expect((await conversation(sharedAccountId, "older")).is_read).toBe(true)
    await ingest(sharedAccountId, [
      message({
        thread: "older",
        from: `o-${suffix}@corp.example`,
        sentAt: "2026-08-01T00:00:00.000Z",
        unread: true,
      }),
    ])
    const after = await conversation(sharedAccountId, "older")
    expect(after.is_read).toBe(false)
    expect(new Date(after.last_message_at).toISOString()).toBe(first.sentAt)
  }, 120_000)
})

describe("new mail on an archived conversation", () => {
  async function statusOf(thread: string): Promise<string> {
    const [row] = extractRows<{ status: string }>(
      await db.execute(drizzleSql`
        SELECT status FROM app_mail.conversations
         WHERE account_id = ${sharedAccountId}::uuid AND external_thread_id = ${`pw-${suffix}-${thread}`}`),
    )
    return row?.status as string
  }
  async function setStatus(thread: string, status: string) {
    await db.execute(drizzleSql`
      UPDATE app_mail.conversations SET status = ${status}
       WHERE account_id = ${sharedAccountId}::uuid AND external_thread_id = ${`pw-${suffix}-${thread}`}`)
  }

  it("an inbound message delivered to the inbox reopens an archived conversation", async () => {
    const from = `re-${suffix}@corp.example`
    await ingest(sharedAccountId, [
      message({ thread: "reopen", from, sentAt: "2026-09-10T00:00:00.000Z" }),
    ])
    await setStatus("reopen", "archived")
    await ingest(sharedAccountId, [
      message({ thread: "reopen", from, sentAt: "2026-09-11T00:00:00.000Z", unread: true }),
    ])
    expect(await statusOf("reopen")).toBe("open")
  }, 120_000)

  it("a trashed or escalated conversation is not reopened, nor one whose new mail skipped the inbox", async () => {
    const from = `nr-${suffix}@corp.example`
    for (const status of ["trashed", "escalated"]) {
      const thread = `keep-${status}`
      await ingest(sharedAccountId, [message({ thread, from, sentAt: "2026-09-10T00:00:00.000Z" })])
      await setStatus(thread, status)
      await ingest(sharedAccountId, [message({ thread, from, sentAt: "2026-09-11T00:00:00.000Z" })])
      expect(await statusOf(thread)).toBe(status)
    }
    await ingest(sharedAccountId, [
      message({ thread: "skip-inbox", from, sentAt: "2026-09-10T00:00:00.000Z" }),
    ])
    await setStatus("skip-inbox", "archived")
    await ingest(sharedAccountId, [
      {
        ...message({ thread: "skip-inbox", from, sentAt: "2026-09-11T00:00:00.000Z" }),
        labels: [],
      },
    ])
    expect(await statusOf("skip-inbox")).toBe("archived")
  }, 120_000)
})

describe("Gmail write-back label mirror", () => {
  it("applies the label delta to the stored labels in one transaction, keeping other labels", async () => {
    const from = `lm-${suffix}@corp.example`
    await ingest(sharedAccountId, [
      message({ thread: "mirror", from, sentAt: "2026-09-10T00:00:00.000Z", unread: true }),
      message({ thread: "mirror", from, sentAt: "2026-09-11T00:00:00.000Z" }),
    ])
    const conv = await conversation(sharedAccountId, "mirror")
    // A label the sync stored meanwhile, which the delta must keep.
    await db.execute(drizzleSql`
      UPDATE app_mail.messages SET labels = labels || '["STARRED"]'::jsonb
       WHERE conversation_id = ${conv.id}::uuid`)
    const labels = await applyConversationLabelDelta(
      { tx: db as never, schemaName: "app_mail", orgId },
      { accountId: sharedAccountId, conversationId: conv.id, add: ["TRASH"], remove: ["INBOX"] },
    )
    expect(labels).not.toContain("INBOX")
    expect(labels).toContain("TRASH")
    const rows = extractRows<{ labels: string[] }>(
      await db.execute(drizzleSql`
        SELECT labels FROM app_mail.messages WHERE conversation_id = ${conv.id}::uuid`),
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.labels).toContain("STARRED")
      expect(row.labels).toContain("TRASH")
      expect(row.labels).not.toContain("INBOX")
    }
    await expect(
      applyConversationLabelDelta(
        { tx: db as never, schemaName: "app_mail", orgId },
        { accountId: sharedAccountId, conversationId: conv.id, add: ["x'); --"], remove: [] },
      ),
    ).rejects.toThrow(/Gmail label ids/)
  }, 120_000)
})

describe("post-commit work and replies (review of #3, round 2)", () => {
  const files = () => {
    const imported: string[] = []
    return {
      imported,
      files_importAttachment: async (json: string) => {
        imported.push(JSON.parse(json).targetEntityId)
        return JSON.stringify({ id: crypto.randomUUID() })
      },
      files_listAttachments: async () => "[]",
    }
  }
  const attached = (thread: string, sentAt: string) => ({
    ...message({ thread, from: `f-${suffix}@corp.example`, sentAt }),
    attachments: [{ filename: "a.pdf", mimeType: "application/pdf", bytesBase64: "AAAA" }],
  })
  const interrupted = {
    mail_completeIngest: async () => {
      throw new Error("InternalError: interrupted (simulated)")
    },
  }
  async function pendingOf(externalMessageId: string) {
    return extractRows<{ ingest_pending: boolean | null; ingest_attempts: number | null }>(
      await db.execute(drizzleSql`SELECT ingest_pending, ingest_attempts FROM app_mail.messages
        WHERE external_message_id = ${externalMessageId}`),
    )[0]
  }

  it("gives up on post-commit work after its attempts, so the sync moves on", async () => {
    const m = attached("giveup", "2026-09-09T00:00:00Z")
    for (let run = 0; run < 7; run++) {
      await ingest(sharedAccountId, [m], { ...files(), ...interrupted }).catch(() => {})
    }
    // The first run stores it, five retries try again, the next one gives up.
    const row = await pendingOf(m.externalMessageId)
    expect(row.ingest_pending).toBeNull()
    expect(Number(row.ingest_attempts)).toBe(6)
    expect((await conversation(sharedAccountId, "giveup")).message_count).toBe(1)
  }, 120_000)

  it("a pending message whose re-fetch has no post-commit work left is settled", async () => {
    const m = attached("settle", "2026-09-10T00:00:00Z")
    await ingest(sharedAccountId, [m], { ...files(), ...interrupted }).catch(() => {})
    expect((await pendingOf(m.externalMessageId)).ingest_pending).toBe(true)
    const f = files()
    await ingest(sharedAccountId, [{ ...m, attachments: [] }], f)
    expect((await pendingOf(m.externalMessageId)).ingest_pending).toBeNull()
    expect(f.imported).toEqual([])
  }, 120_000)

  it("a reply the user sent reads the conversation up to it, and only up to it", async () => {
    const inbound = message({
      thread: "reply",
      from: `q-${suffix}@corp.example`,
      sentAt: "2026-09-11T00:00:00.000Z",
      unread: true,
    })
    await ingest(sharedAccountId, [inbound])
    expect((await conversation(sharedAccountId, "reply")).is_read).toBe(false)
    const reply = {
      ...message({
        thread: "reply",
        from: `support@corp.example`,
        sentAt: "2026-09-11T01:00:00.000Z",
      }),
      direction: "outbound",
    }
    await ingest(sharedAccountId, [reply], {}, "sent")
    expect((await conversation(sharedAccountId, "reply")).is_read).toBe(true)
    const [answered] = extractRows<{ is_read: boolean; labels: string[] }>(
      await db.execute(drizzleSql`SELECT is_read, labels FROM app_mail.messages
        WHERE external_message_id = ${inbound.externalMessageId}`),
    )
    expect(answered.is_read).toBe(true)
    expect(answered.labels).not.toContain("UNREAD")
    // A message arriving after the reply unreads it again, as it should.
    await ingest(sharedAccountId, [
      message({
        thread: "reply",
        from: `q-${suffix}@corp.example`,
        sentAt: "2026-09-11T02:00:00.000Z",
        unread: true,
      }),
    ])
    expect((await conversation(sharedAccountId, "reply")).is_read).toBe(false)
  }, 120_000)
})

describe("mail senders and contacts (#6): automated discovery never adds to the organisation", () => {
  const stranger = () => `stranger-${suffix}@private.example`
  const known = () => `known-${suffix}@partner.example`
  const newsletter = () => `hello-${suffix}@news.example`

  function senderPage(prefix: string) {
    return [
      message({
        thread: `${prefix}-known`,
        from: known(),
        name: "Known",
        sentAt: "2026-09-10T00:00:00Z",
      }),
      message({
        thread: `${prefix}-stranger`,
        from: stranger(),
        name: "A Private Correspondent",
        sentAt: "2026-09-10T00:01:00Z",
      }),
      message({
        thread: `${prefix}-news`,
        from: newsletter(),
        name: "News",
        sentAt: "2026-09-10T00:02:00Z",
        headers: { "List-Unsubscribe": "<mailto:unsub@news.example>" },
      }),
    ]
  }

  async function sharing(email: string) {
    return extractRows<{
      id: string
      org_access: string
      owner_user_id: string | null
      acl_user_ids: string[]
      acl_role_ids: string[]
    }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id, org_access, owner_user_id::text AS owner_user_id,
               acl_user_ids, acl_role_ids
          FROM kernel.contacts
         WHERE org_id = ${orgId}::uuid AND LOWER(email) = ${email}
         ORDER BY owner_user_id NULLS LAST`),
    )
  }

  it("a personal mailbox keeps a new correspondent private to its owner, and links known contacts", async () => {
    await ingest(personalAccountId, senderPage("p"))
    const [privateContact, ...rest] = await sharing(stranger())
    expect(rest).toEqual([])
    // Never the organisation's: only the mailbox owner can see or find it.
    expect(privateContact).toMatchObject({
      org_access: "none",
      owner_user_id: ownerId,
      acl_user_ids: [ownerId],
    })
    expect((await conversation(personalAccountId, "p-stranger")).contact_id).toBe(privateContact.id)
    expect(await contactIdsFor(newsletter())).toEqual([])
    expect((await conversation(personalAccountId, "p-known")).contact_id).toBe(knownContactId)
  }, 60_000)

  it("a shared mailbox shares a new human sender with its members only, never bulk ones", async () => {
    await ingest(sharedAccountId, senderPage("s"))
    // The owner's private contact is neither reused nor exposed: the shared
    // mailbox gets its own contact, granted to whoever can access the mailbox.
    const shared = (await sharing(stranger())).filter((c) => c.owner_user_id === null)
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatchObject({ org_access: "none" })
    expect(shared[0].acl_role_ids).toContain(`dim:mail:inbox=${sharedAccountId}`)
    expect((await conversation(sharedAccountId, "s-stranger")).contact_id).toBe(shared[0].id)
    expect(await contactIdsFor(newsletter())).toEqual([])
    expect((await conversation(sharedAccountId, "s-known")).contact_id).toBe(knownContactId)
  }, 60_000)

  it("mail the mailbox sends is linked to the contact it was addressed to, and creates none", async () => {
    const sent = (thread: string, to: unknown) => ({
      ...message({
        thread,
        from: `support-${suffix}@test.example`,
        sentAt: "2026-09-12T00:00:00Z",
      }),
      to: [to],
      labels: ["SENT"],
      direction: "outbound",
    })
    const unknown = `nobody-${suffix}@elsewhere.example`
    await ingest(
      sharedAccountId,
      [
        sent("out-known", `Known Partner <${known().toUpperCase()}>`),
        sent("out-object", { email: known() }),
        sent("out-unknown", unknown),
      ],
      {},
      "sent",
    )
    expect((await conversation(sharedAccountId, "out-known")).contact_id).toBe(knownContactId)
    expect((await conversation(sharedAccountId, "out-object")).contact_id).toBe(knownContactId)
    expect((await conversation(sharedAccountId, "out-unknown")).contact_id).toBeNull()
    expect(await contactIdsFor(unknown)).toEqual([])
  }, 60_000)

  it("the mail app cannot create a contact through the generic resolveContact", async () => {
    const counter = { db: 0, byMethod: {} as Record<string, number> }
    await expect(
      executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: "__test_resolveContact",
        params: { email: `bypass-${suffix}@private.example` },
        bridge: bridgeFor(counter),
        timeoutMs: 30_000,
      } as never),
    ).rejects.toThrow(/not available to the mail app/)
    expect(await contactIdsFor(`bypass-${suffix}@private.example`)).toEqual([])
  }, 60_000)
})
