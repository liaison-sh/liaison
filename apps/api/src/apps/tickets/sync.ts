// SPDX-License-Identifier: FSL-1.1-ALv2
import { type GmailMessageResource, parseGmailPayload } from "../../lib/email/parse"
import type { ParsedEmail } from "../../lib/email/types"
import { rootLogger } from "../../lib/logger"
import { INBOUND_ATTACHMENT_MAX_BYTES, INBOUND_EMAIL_MAX_BYTES } from "./inbound"

const log = rootLogger.child({ module: "tickets-sync" })

export type SyncCtx = {
  fetch: typeof fetch
  getAccessToken(connectionName: "gmail" | "imap", accountEmail: string): Promise<string>
  enqueueJob(jobName: string, payload: unknown, opts?: { jobId?: string }): Promise<void>
  imapFetch(
    accountEmail: string,
    opts: { mode: "incremental" | "initial"; cursor?: string },
  ): Promise<{ messages: ParsedEmail[]; cursor?: string; uidValidity?: string }>
  loadAccount(connectedAccountId: string): Promise<{
    id: string
    email_address: string
    metadata: Record<string, unknown>
    status: string
  }>
  saveAccountMetadata(connectedAccountId: string, metadata: Record<string, unknown>): Promise<void>
  loadInboxByAccountId(connectedAccountId: string): Promise<{
    id: string
    email_address: string
    org_id: string
  } | null>
}

export type ProcessOutcome =
  | { outcome: "created"; ticketId: string; messageId: string }
  | { outcome: "appended"; ticketId: string; messageId: string }
  | { outcome: "dropped"; reason: string }
  | { outcome: "rerouted"; conversationId: string }
  | { outcome: "rerouted_failed"; conversationId: string; reason: string }

export type ProcessMessageFn = (
  parsed: ParsedEmail,
  inbox: { id: string; email_address: string; org_id: string },
  /** `backfill`: a first sync reading the mailbox's history, not mail that
   *  just arrived (so nothing it opens is acknowledged). */
  opts?: { backfill: boolean },
) => Promise<ProcessOutcome>

const LIVE = { backfill: false } as const
const BACKFILL = { backfill: true } as const

export type SyncResult = {
  processed: number
  dropped: { reason: string; count: number }[]
  reroutedFailed?: { reason: string; count: number }[]
}

function tally(outcomes: ProcessOutcome[]): SyncResult {
  let processed = 0
  const dropMap = new Map<string, number>()
  const reroutedFailedMap = new Map<string, number>()
  for (const o of outcomes) {
    if (o.outcome === "dropped") dropMap.set(o.reason, (dropMap.get(o.reason) ?? 0) + 1)
    else if (o.outcome === "rerouted_failed") {
      reroutedFailedMap.set(o.reason, (reroutedFailedMap.get(o.reason) ?? 0) + 1)
    } else processed += 1
  }
  return {
    processed,
    dropped: Array.from(dropMap.entries()).map(([reason, count]) => ({ reason, count })),
    reroutedFailed: Array.from(reroutedFailedMap.entries()).map(([reason, count]) => ({
      reason,
      count,
    })),
  }
}

function hasRerouteFailure(outcomes: ProcessOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.outcome === "rerouted_failed")
}

function gmailBase(): string {
  const override = process.env.TICKETS_E2E_GMAIL_API_BASE_URL
  if (override) {
    return `${override.replace(/\/$/, "")}/users/me`
  }
  return "https://gmail.googleapis.com/gmail/v1/users/me"
}

const GMAIL_BASE = gmailBase()

async function gmailRequest(
  ctx: SyncCtx,
  accountEmail: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await ctx.getAccessToken("gmail", accountEmail)
  const extraHeaders: Record<string, string> = {}
  if (process.env.TICKETS_E2E_GMAIL_API_BASE_URL) {
    // The localhost Gmail HTTP fixture identifies the calling account via this header.
    extraHeaders["X-Test-Account"] = accountEmail
  }
  return ctx.fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  })
}

/**
 * Gmail's `format=full` payload inlines bytes (`body.data`) only for small
 * parts — every real attachment (images, videos, PDFs) carries a server-side
 * `attachmentId` instead. Fetch those bytes via the Gmail attachments API and
 * fill `bytesBase64` in place so `persistInboundAttachments` can store them.
 *
 * Skips parts that already carry bytes and parts the persist caps would drop
 * anyway (never download what won't be kept). A per-attachment fetch failure
 * leaves that part byte-less — persist skips it — so one bad attachment never
 * breaks message ingest.
 */
export async function hydrateGmailAttachments(
  ctx: SyncCtx,
  accountEmail: string,
  gmailMessageId: string,
  parsed: ParsedEmail,
): Promise<void> {
  let cumulative = 0
  for (const att of parsed.attachments ?? []) {
    if (att.bytesBase64) {
      cumulative += Math.ceil((att.bytesBase64.length * 3) / 4)
      continue
    }
    if (!att.providerAttachmentId) continue
    const expected = att.sizeBytes ?? 0
    if (expected > INBOUND_ATTACHMENT_MAX_BYTES) continue
    if (cumulative + expected > INBOUND_EMAIL_MAX_BYTES) continue
    try {
      const res = await gmailRequest(
        ctx,
        accountEmail,
        `${GMAIL_BASE}/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(att.providerAttachmentId)}`,
      )
      if (!res.ok) continue
      const body = (await res.json()) as { data?: string; size?: number }
      if (!body.data) continue
      // Gmail returns base64url — normalize to the standard alphabet the
      // downstream `Buffer.from(x, "base64")` decoders expect.
      att.bytesBase64 = body.data.replace(/-/g, "+").replace(/_/g, "/")
      cumulative += Math.ceil((att.bytesBase64.length * 3) / 4)
    } catch {
      // Leave the part byte-less; persistInboundAttachments skips it.
    }
  }
}

/**
 * Look up a Gmail message by its RFC-822 `Message-ID` header (the value stored
 * in `app_tickets.messages.external_message_id`) and return it parsed with
 * attachments hydrated. `null` when the mailbox has no such message. Used by
 * the attachment backfill CLI to re-fetch attachments for already-ingested
 * messages.
 */
export async function gmailFetchByRfc822MessageId(
  ctx: SyncCtx,
  accountEmail: string,
  rfc822MessageId: string,
): Promise<ParsedEmail | null> {
  const bare = rfc822MessageId.replace(/^<|>$/g, "")
  const qs = new URLSearchParams({ q: `rfc822msgid:${bare}`, maxResults: "1" })
  const listRes = await gmailRequest(ctx, accountEmail, `${GMAIL_BASE}/messages?${qs.toString()}`)
  if (!listRes.ok) throw new Error(`gmail search failed ${listRes.status}`)
  const listBody = (await listRes.json()) as { messages?: Array<{ id: string }> }
  const ref = listBody.messages?.[0]
  if (!ref) return null
  const msgRes = await gmailRequest(
    ctx,
    accountEmail,
    `${GMAIL_BASE}/messages/${encodeURIComponent(ref.id)}?format=full`,
  )
  if (!msgRes.ok) throw new Error(`gmail message fetch failed ${msgRes.status}`)
  const parsed = parseGmailPayload((await msgRes.json()) as GmailMessageResource)
  await hydrateGmailAttachments(ctx, accountEmail, ref.id, parsed)
  return parsed
}

export async function gmailIncrementalSync(
  orgId: string,
  connectedAccountId: string,
  ctx: SyncCtx,
  opts?: { processMessage?: ProcessMessageFn },
): Promise<SyncResult> {
  const account = await ctx.loadAccount(connectedAccountId)
  const meta = (account.metadata as { gmail?: { historyId?: string } }) ?? {}
  const cursor = meta.gmail?.historyId
  if (!cursor) {
    await ctx.enqueueJob(
      "gmail-initial-sync",
      { orgId, connectedAccountId },
      { jobId: `gmail-initial-sync:${connectedAccountId}` },
    )
    return { processed: 0, dropped: [{ reason: "no_cursor", count: 1 }] }
  }
  const inbox = await ctx.loadInboxByAccountId(connectedAccountId)
  if (!inbox) return { processed: 0, dropped: [{ reason: "no_inbox", count: 1 }] }

  const histRes = await gmailRequest(
    ctx,
    account.email_address,
    `${GMAIL_BASE}/history?startHistoryId=${encodeURIComponent(cursor)}&historyTypes=messageAdded`,
  )
  if (histRes.status === 404 || histRes.status === 410) {
    await ctx.saveAccountMetadata(connectedAccountId, { ...meta, gmail: {} })
    await ctx.enqueueJob(
      "gmail-initial-sync",
      { orgId, connectedAccountId },
      { jobId: `gmail-initial-sync:${connectedAccountId}` },
    )
    return { processed: 0, dropped: [{ reason: "history_id_invalid", count: 1 }] }
  }
  if (!histRes.ok) {
    throw new Error(`gmail history failed ${histRes.status}`)
  }
  const histBody = (await histRes.json()) as {
    history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>
    historyId?: string
  }

  const outcomes: ProcessOutcome[] = []
  const processFn =
    opts?.processMessage ?? (async () => ({ outcome: "dropped" as const, reason: "no_processor" }))

  for (const record of histBody.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      // Wrap the per-message fetch+parse+process in a single try/catch so that
      // a transient fetch error or malformed message is counted as `dropped`
      // rather than throwing and abandoning the rest of the batch. This ensures
      // the cursor still advances past the failed message on the next tick
      // instead of permanently wedging sync behind one bad entry.
      try {
        const msgRes = await gmailRequest(
          ctx,
          account.email_address,
          `${GMAIL_BASE}/messages/${encodeURIComponent(added.message.id)}?format=full`,
        )
        if (!msgRes.ok) {
          outcomes.push({ outcome: "dropped", reason: `fetch_error_${msgRes.status}` })
          continue
        }
        const json = (await msgRes.json()) as GmailMessageResource
        const parsed = parseGmailPayload(json)
        await hydrateGmailAttachments(ctx, account.email_address, added.message.id, parsed)
        outcomes.push(await processFn(parsed, inbox, LIVE))
      } catch {
        outcomes.push({ outcome: "dropped", reason: "fetch_or_parse_error" })
      }
    }
  }

  if (histBody.historyId && !hasRerouteFailure(outcomes)) {
    // Stamp lastSyncAt on every successful incremental run (even a 0-message tick):
    // it records that ingestion is ALIVE, not that mail arrived. /diag reads this
    // to alert on a mailbox whose connection still shows "active" but whose sync
    // has silently stalled (dead push watch, wedged worker, etc.).
    await ctx.saveAccountMetadata(connectedAccountId, {
      ...meta,
      gmail: {
        ...(meta.gmail ?? {}),
        historyId: histBody.historyId,
        lastSyncAt: new Date().toISOString(),
      },
    })
  }

  return tally(outcomes)
}

// users.watch request body. With GMAIL_PUBSUB_TOPIC set (a Cloud Pub/Sub topic, e.g.
// projects/<project>/topics/gmail-push), Gmail PUSHES change notifications to it AND the call
// returns the current historyId -- so incremental sync gets its cursor and we get instant push.
// Without the env the call 400s; the deployment is then poll-only with no saved cursor (the
// incremental sync re-enqueues the bounded initial sync each tick).
/** The Pub/Sub topic Gmail push publishes to, or null when push is unconfigured. */
function gmailPushTopic(): string | null {
  const topic = process.env.GMAIL_PUBSUB_TOPIC
  return topic && topic.length > 0 ? topic : null
}

function gmailWatchBody(): string {
  const topic = gmailPushTopic()
  return topic ? JSON.stringify({ topicName: topic }) : JSON.stringify({})
}

export async function gmailInitialSync(
  _orgId: string,
  connectedAccountId: string,
  ctx: SyncCtx,
  opts?: { processMessage?: ProcessMessageFn; lookbackDays?: number },
): Promise<SyncResult> {
  const account = await ctx.loadAccount(connectedAccountId)
  const inbox = await ctx.loadInboxByAccountId(connectedAccountId)
  if (!inbox) return { processed: 0, dropped: [{ reason: "no_inbox", count: 1 }] }

  // Window start. TICKETS_GMAIL_SYNC_SINCE (ISO-8601) pins an ABSOLUTE cutoff and takes precedence
  // over the rolling lookback -- used when migrating onto a mailbox whose history was already
  // imported out-of-band, so the first sync RECONCILES only mail that arrived after the import
  // (gap replies thread onto the imported tickets via their Message-IDs; the inbound matcher's
  // duplicate_external_message_id check drops anything already ingested) instead of re-ingesting a
  // duplicate backlog.
  const sinceRaw = process.env.TICKETS_GMAIL_SYNC_SINCE
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Number.NaN
  const after = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000)
    : Math.floor(Date.now() / 1000) - (opts?.lookbackDays ?? 30) * 24 * 60 * 60

  const outcomes: ProcessOutcome[] = []
  const processFn =
    opts?.processMessage ?? (async () => ({ outcome: "dropped" as const, reason: "no_processor" }))

  // Paginate the listing fully. The previous single-page list silently dropped everything past the
  // first ~100 messages -- fine for a quiet inbox, but a wide reconciliation window (or a busy
  // mailbox) needs every page or gap mail is lost.
  let pageToken: string | undefined
  do {
    const qs = new URLSearchParams({ q: `after:${after}`, maxResults: "100" })
    if (pageToken) qs.set("pageToken", pageToken)
    const listRes = await gmailRequest(
      ctx,
      account.email_address,
      `${GMAIL_BASE}/messages?${qs.toString()}`,
    )
    if (!listRes.ok) throw new Error(`gmail list failed ${listRes.status}`)
    const listBody = (await listRes.json()) as {
      messages?: Array<{ id: string }>
      nextPageToken?: string
    }
    for (const ref of listBody.messages ?? []) {
      const msgRes = await gmailRequest(
        ctx,
        account.email_address,
        `${GMAIL_BASE}/messages/${encodeURIComponent(ref.id)}?format=full`,
      )
      if (!msgRes.ok) throw new Error(`gmail message fetch failed ${msgRes.status}`)
      try {
        const parsed = parseGmailPayload((await msgRes.json()) as GmailMessageResource)
        await hydrateGmailAttachments(ctx, account.email_address, ref.id, parsed)
        outcomes.push(await processFn(parsed, inbox, BACKFILL))
      } catch {
        outcomes.push({ outcome: "dropped", reason: "parse_error" })
      }
    }
    pageToken = listBody.nextPageToken
  } while (pageToken)

  // Advance the cursor so the next incremental sync has somewhere to start.
  //
  // Registering the push watch is the PREFERRED way to get it (one call gives
  // both the historyId and instant push), but the two are separate concerns and
  // must not share a fate. Live on 2026-07-28 the watch failed — a missing
  // Pub/Sub grant — and because the cursor was only written inside
  // `if (watchRes.ok)`, it was never stored at all. Every incremental tick then
  // found no cursor and re-enqueued a FULL mailbox listing, every 5 minutes,
  // indefinitely, while the incremental path never ran once. Mail kept
  // arriving, so nothing looked wrong.
  //
  // So: try the watch; on failure fall back to `users/me/profile`, which
  // returns the same historyId without needing Pub/Sub. Push is lost until the
  // grant is fixed, incremental sync is not.
  if (!hasRerouteFailure(outcomes)) {
    const meta = (account.metadata as { gmail?: Record<string, unknown> }) ?? {}
    let historyId: string | undefined
    let expiration: string | undefined

    // No topic means push is not configured for this deployment. Gmail answers
    // `topicName required` (400) to a watch with no topicName, so calling it
    // anyway is a guaranteed-failing round trip on every single sync. Skip
    // straight to the profile cursor.
    const watchRes = gmailPushTopic()
      ? await gmailRequest(ctx, account.email_address, `${GMAIL_BASE}/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: gmailWatchBody(),
        })
      : null
    if (watchRes === null) {
      log.info(
        { connectedAccountId },
        "gmail push not configured (GMAIL_PUBSUB_TOPIC unset) — using the profile historyId; mail arrives on the incremental-sync schedule instead of instantly",
      )
      const profileRes = await gmailRequest(ctx, account.email_address, `${GMAIL_BASE}/profile`)
      if (profileRes.ok) {
        historyId = ((await profileRes.json()) as { historyId?: string }).historyId
      }
    } else if (watchRes.ok) {
      const watch = (await watchRes.json()) as { historyId?: string; expiration?: string }
      historyId = watch.historyId
      expiration = watch.expiration
    } else {
      // A silent watch failure is how this went unseen for a week: the old code
      // had no `else` at all, so an hour of logs held not one mention of it.
      log.warn(
        {
          connectedAccountId,
          status: watchRes.status,
          detail: (await watchRes.text().catch(() => "")).slice(0, 300),
        },
        "gmail watch registration failed — push is disabled for this mailbox; falling back to the profile historyId so incremental sync still works",
      )
      const profileRes = await gmailRequest(ctx, account.email_address, `${GMAIL_BASE}/profile`)
      if (profileRes.ok) {
        historyId = ((await profileRes.json()) as { historyId?: string }).historyId
      } else {
        log.error(
          { connectedAccountId, status: profileRes.status },
          "gmail profile read failed too — no cursor stored; the next incremental sync will re-run a full initial sync",
        )
      }
    }

    // Never invent a cursor: a wrong one makes incremental sync skip everything
    // between the real position and the fabricated one, which is silent mail
    // loss. No cursor just means another (correct, if wasteful) initial sync.
    if (historyId) {
      await ctx.saveAccountMetadata(connectedAccountId, {
        ...meta,
        gmail: {
          ...(meta.gmail ?? {}),
          historyId,
          // Only a real watch may claim an expiry — a stale one would make the
          // renewal cron believe a live push registration exists.
          ...(expiration !== undefined ? { expiration } : {}),
          lastSyncAt: new Date().toISOString(),
        },
      })
    }
  }

  return tally(outcomes)
}

export async function gmailWatchRenewal(
  _orgId: string,
  connectedAccountId: string,
  ctx: SyncCtx,
): Promise<{ historyId?: string; expiration?: string }> {
  const account = await ctx.loadAccount(connectedAccountId)
  const watchRes = await gmailRequest(ctx, account.email_address, `${GMAIL_BASE}/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: gmailWatchBody(),
  })
  if (!watchRes.ok) throw new Error(`gmail watch failed ${watchRes.status}`)
  const watch = (await watchRes.json()) as { historyId?: string; expiration?: string }
  const meta = (account.metadata as { gmail?: Record<string, unknown> }) ?? {}
  await ctx.saveAccountMetadata(connectedAccountId, {
    ...meta,
    gmail: { ...(meta.gmail ?? {}), historyId: watch.historyId, expiration: watch.expiration },
  })
  return watch
}

export async function imapIncrementalSync(
  orgId: string,
  connectedAccountId: string,
  ctx: SyncCtx,
  opts?: { processMessage?: ProcessMessageFn },
): Promise<SyncResult> {
  const account = await ctx.loadAccount(connectedAccountId)
  const inbox = await ctx.loadInboxByAccountId(connectedAccountId)
  if (!inbox) return { processed: 0, dropped: [{ reason: "no_inbox", count: 1 }] }

  const meta = (account.metadata as { imap?: { cursor?: string; uidValidity?: string } }) ?? {}
  const cursor = meta.imap?.cursor

  const fetched = await ctx.imapFetch(account.email_address, {
    mode: "incremental",
    cursor,
  })

  if (
    fetched.uidValidity &&
    meta.imap?.uidValidity &&
    fetched.uidValidity !== meta.imap.uidValidity
  ) {
    await ctx.saveAccountMetadata(connectedAccountId, {
      ...meta,
      imap: { uidValidity: fetched.uidValidity },
    })
    await ctx.enqueueJob(
      "imap-initial-sync",
      { orgId, connectedAccountId },
      { jobId: `imap-initial-sync:${connectedAccountId}` },
    )
    return { processed: 0, dropped: [{ reason: "uidvalidity_changed", count: 1 }] }
  }

  const outcomes: ProcessOutcome[] = []
  const processFn =
    opts?.processMessage ?? (async () => ({ outcome: "dropped" as const, reason: "no_processor" }))
  for (const parsed of fetched.messages) {
    outcomes.push(await processFn(parsed, inbox, LIVE))
  }

  if (fetched.cursor && !hasRerouteFailure(outcomes)) {
    await ctx.saveAccountMetadata(connectedAccountId, {
      ...meta,
      imap: {
        cursor: fetched.cursor,
        uidValidity: fetched.uidValidity ?? meta.imap?.uidValidity,
      },
    })
  }

  return tally(outcomes)
}

export async function imapInitialSync(
  _orgId: string,
  connectedAccountId: string,
  ctx: SyncCtx,
  opts?: { processMessage?: ProcessMessageFn },
): Promise<SyncResult> {
  const account = await ctx.loadAccount(connectedAccountId)
  const inbox = await ctx.loadInboxByAccountId(connectedAccountId)
  if (!inbox) return { processed: 0, dropped: [{ reason: "no_inbox", count: 1 }] }

  const fetched = await ctx.imapFetch(account.email_address, { mode: "initial" })
  const outcomes: ProcessOutcome[] = []
  const processFn =
    opts?.processMessage ?? (async () => ({ outcome: "dropped" as const, reason: "no_processor" }))
  for (const parsed of fetched.messages) {
    outcomes.push(await processFn(parsed, inbox, BACKFILL))
  }
  const meta = (account.metadata as { imap?: Record<string, unknown> }) ?? {}
  if (!hasRerouteFailure(outcomes)) {
    await ctx.saveAccountMetadata(connectedAccountId, {
      ...meta,
      imap: {
        cursor: fetched.cursor,
        uidValidity: fetched.uidValidity ?? (meta.imap?.uidValidity as string | undefined),
      },
    })
  }
  return tally(outcomes)
}
