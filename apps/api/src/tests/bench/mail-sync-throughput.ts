// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail sync throughput bench: a synthetic Gmail mailbox imported through the
// REAL `gmailInitialSync` page chain, in the real sandbox, over the real
// session bridge (one short RLS transaction per bridge call, exactly as
// production mail jobs run), against whatever database DATABASE_URL names.
// Only the provider side is synthetic: `fetch` answers the Gmail list and
// message endpoints from generated data, and the OAuth token is a constant.
//
// What it reports, per phase:
//   - wall time, bridge calls and the time spent inside DB-touching bridge
//     calls (the host side of every RPC: transaction, RLS setup, SQL). That
//     sum is the "DB time" of the sync, as close as we can get without
//     pg_stat_statements;
//   - tuples read by sequential scans on app_mail.messages / conversations
//     (pg_stat_user_tables deltas), the signature of an unindexed lookup.
// Phases: the initial import of N messages, then an incremental sync that
// delivers ONE new message into the full mailbox.
//
// Usage (cwd apps/api, a PRIVATE database, never liaison_dev/liaison_test):
//   bun --env-file <env> run bench:mail-sync [messages] [threads] [senders]
// Prints one JSON line.

import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { createRlsSession } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

/** The mail handlers, run as `runApp` runs a core app. */
async function mailTestRunner() {
  const { runMailHandler } = await import("~/apps/mail/test-mail-runner")
  return runMailHandler
}

const K = () => drizzleSql.raw(schemaRef("kernel"))

const TOTAL = Number(process.argv[2] ?? 10_000)
const THREADS = Number(process.argv[3] ?? Math.round(TOTAL * 0.57))
const SENDERS = Number(process.argv[4] ?? 400)
const PAGE = 25

/** Bridge methods that never touch the database (external I/O, logs, codecs). */
const NON_DB = /^(fetch|imap_|smtp_|log_|getUserId|getOrgId|connections_getToken|config_get)/

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url")
}

/** Deterministic synthetic Gmail message `i` (newest first, like messages.list). */
function gmailMessage(i: number): unknown {
  const thread = i % THREADS
  const sender = i % SENDERS
  // One sender in ten is a newsletter: List-Unsubscribe plus a no-reply local part.
  const bulk = sender % 10 === 0
  const from = bulk
    ? `Newsletter ${sender} <no-reply@news${sender}.example>`
    : `Person ${sender} <p${sender}@corp${sender % 37}.example>`
  const sentAt = new Date(Date.UTC(2026, 0, 1) + (TOTAL - i) * 60_000).toUTCString()
  const headers = [
    { name: "From", value: from },
    { name: "To", value: "owner@bench.example" },
    { name: "Subject", value: `Subject for thread ${thread}` },
    { name: "Date", value: sentAt },
    { name: "Message-ID", value: `<bench-${i}@bench.example>` },
    ...(bulk ? [{ name: "List-Unsubscribe", value: `<mailto:unsub@news${sender}.example>` }] : []),
  ]
  const body = `Body of message ${i} in thread ${thread}. ${"lorem ipsum ".repeat(40)}`
  return {
    id: `gm-${i}`,
    threadId: `gt-${thread}`,
    labelIds: i % 3 === 0 ? ["INBOX", "UNREAD"] : ["INBOX"],
    internalDate: String(Date.parse(sentAt)),
    payload: {
      headers,
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url(body) } },
        { mimeType: "text/html", body: { data: b64url(`<p>${body}</p>`) } },
      ],
    },
  }
}

interface Meter {
  calls: number
  dbCalls: number
  dbMs: number
  byMethod: Record<string, { calls: number; ms: number }>
}

function meteredBridge(
  real: Record<string, any>,
  meter: Meter,
  overrides: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [name, member] of Object.entries({ ...real, ...overrides })) {
    if (typeof member !== "function" || member.constructor.name !== "AsyncFunction") {
      out[name] = member
      continue
    }
    const counted = !(name in overrides) && !NON_DB.test(name)
    out[name] = async (...args: unknown[]) => {
      meter.calls++
      if (!counted) return member(...args)
      meter.dbCalls++
      const entry = meter.byMethod[name] ?? { calls: 0, ms: 0 }
      meter.byMethod[name] = entry
      entry.calls++
      const t0 = performance.now()
      try {
        return await member(...args)
      } finally {
        const ms = performance.now() - t0
        meter.dbMs += ms
        entry.ms = Math.round((entry.ms + ms) * 10) / 10
      }
    }
  }
  return out
}

async function seqTupRead(): Promise<Record<string, number>> {
  // An idle backend flushes its table statistics within ten seconds: wait it out so a
  // phase's scans are counted in its own delta.
  await Bun.sleep(11_000)
  const rows = extractRows<{ relname: string; seq_tup_read: string }>(
    await db.execute(drizzleSql`
      SELECT relname, seq_tup_read::text FROM pg_stat_user_tables
       WHERE schemaname = 'app_mail' AND relname IN ('messages', 'conversations')`),
  )
  return Object.fromEntries(rows.map((r) => [r.relname, Number(r.seq_tup_read)]))
}

async function main(): Promise<void> {
  // BENCH_ACCOUNT=<orgId>:<accountId> re-runs only the incremental phase against
  // a mailbox a previous run imported (the one-message cost on a full mailbox).
  const reuse = process.env.BENCH_ACCOUNT?.split(":")
  let orgId: string
  let account: { id: string }
  if (reuse?.length === 2) {
    orgId = reuse[0] as string
    account = { id: reuse[1] as string }
  } else {
    const suffix = crypto.randomUUID().slice(0, 8)
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO ${K()}.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Mail bench', ${`mail-bench-${suffix}`}) RETURNING id`),
    )
    orgId = org.id
    // The mail app's columns exist once it is registered for an org.
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(orgId)
    // An org-owned (shared) mailbox: syncable without enrollment, unsealed.
    ;[account] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mail.accounts
          (org_id, connected_account_id, owner_type, provider, email_address, sync_status, visibility)
        VALUES (${orgId}, gen_random_uuid(), 'org', 'gmail', ${`bench-${suffix}@bench.example`},
                'pre-sync', 'shared')
        RETURNING id`),
    )
  }
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId as string)

  const runMailHandler = await mailTestRunner()

  const session = createRlsSession({
    actorType: "system",
    orgId,
    purpose: "job",
    scopes: ["mail:*"],
  })
  const real = createSessionRpcBridge(
    "mail",
    "system:mail:gmail-initial-sync",
    orgId,
    session,
    mailAppManifest as never,
  )

  let historyId = 5000
  let extra: number | null = null
  const enqueued: string[] = []
  const overrides = {
    connections_getToken: async () => "bench-token",
    config_get: async () => null,
    hasOnlineUsers: async () => JSON.stringify(true),
    enqueueJob: async (name: string) => {
      enqueued.push(name)
    },
    fetch: async (url: string) => {
      const ok = (body: unknown) =>
        JSON.stringify({ status: 200, headers: {}, body: JSON.stringify(body) })
      if (url.includes("/profile")) return ok({ historyId: String(historyId) })
      if (url.includes("/history")) {
        return ok(
          extra === null
            ? { historyId: String(historyId) }
            : {
                history: [
                  { id: String(historyId), messagesAdded: [{ message: { id: `gm-${extra}` } }] },
                ],
                historyId: String(historyId),
              },
        )
      }
      const single = url.match(/\/messages\/(gm-\d+)/)
      if (single) return ok(gmailMessage(Number(single[1].slice(3))))
      if (url.includes("/messages")) {
        const token = new URL(url).searchParams.get("pageToken")
        const start = token ? Number(token) : 0
        const ids = []
        for (let i = start; i < Math.min(start + PAGE, TOTAL); i++) ids.push({ id: `gm-${i}` })
        return ok({
          messages: ids,
          ...(start + PAGE < TOTAL ? { nextPageToken: String(start + PAGE) } : {}),
        })
      }
      return JSON.stringify({ status: 404, headers: {}, body: "" })
    },
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    log_debug: () => {},
  }

  async function phase(exportName: string, payload: unknown, runs: () => boolean) {
    const meter: Meter = { calls: 0, dbCalls: 0, dbMs: 0, byMethod: {} }
    const bridge = meteredBridge(real, meter, overrides)
    const before = await seqTupRead()
    const t0 = performance.now()
    let invocations = 0
    do {
      enqueued.length = 0
      invocations++
      await runMailHandler({
        exportName,
        params: payload,
        bridge,
        timeoutMs: 600_000,
      } as any)
    } while (runs())
    const wallMs = performance.now() - t0
    const after = await seqTupRead()
    return {
      invocations,
      wallMs: Math.round(wallMs),
      bridgeCalls: meter.calls,
      dbCalls: meter.dbCalls,
      dbMs: Math.round(meter.dbMs),
      seqTupRead: {
        messages: (after.messages ?? 0) - (before.messages ?? 0),
        conversations: (after.conversations ?? 0) - (before.conversations ?? 0),
      },
      byMethod: meter.byMethod,
    }
  }

  const initial = reuse
    ? null
    : await phase("gmailInitialSync", { orgId, accountId: account.id }, () =>
        enqueued.includes("gmail-initial-sync"),
      )

  // Incremental: one new message lands in an existing thread of the full mailbox.
  // Measured WARM, like a long-running server: the first run pays the process's
  // one-time costs (bundle, pool, JIT) and is discarded.
  async function oneNewMessage() {
    extra = TOTAL + 1 + Math.floor(Math.random() * 1_000_000)
    historyId++
    await db.execute(
      drizzleSql`UPDATE app_mail.accounts SET last_sync_at = NULL WHERE id = ${account.id}::uuid`,
    )
    return phase("gmailIncrementalSync", { orgId, accountId: account.id }, () => false)
  }
  await oneNewMessage()
  const incremental = await oneNewMessage()

  const [counts] = extractRows<{ messages: number; conversations: number; contacts: number }>(
    await db.execute(drizzleSql`
      SELECT (SELECT count(*)::int FROM app_mail.messages WHERE org_id = ${orgId}) AS messages,
             (SELECT count(*)::int FROM app_mail.conversations WHERE org_id = ${orgId}) AS conversations,
             (SELECT count(*)::int FROM ${K()}.contacts WHERE org_id = ${orgId}) AS contacts`),
  )
  process.stdout.write(
    `${JSON.stringify({ total: TOTAL, threads: THREADS, senders: SENDERS, orgId, initial, incremental, counts })}\n`,
  )
  process.exit(0)
}

void main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
