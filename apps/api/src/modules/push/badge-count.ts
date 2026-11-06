// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two counts, one query. `computeUnreadMessageCount` is the Messages entry's
// number: every unread message the Messages list shows. `computeBadgeCount` is
// THE badge (the app icon on the phone, the dock, the tab title): the
// unread messages of direct conversations plus the direct asks among the
// person's attention rows, counted by the shared `countBadge`
// (packages/shared/src/notifications/badge.ts) that the web counts with too.
//
// THE COUNT RUNS AS THE USER, not privileged, and that is the whole design.
// A18 requires the badge to reflect "only messages the read-time predicate
// admits", and the read-time predicate is the `kernel.messages` SELECT policy.
// Counting privileged and then re-deriving visibility in the count's own SQL
// would be a second predicate, free to drift from the first; a badge that
// disagrees with the list it points at is the bug this avoids. So the count
// opens an RLS transaction with the user's real effective scopes and lets the
// policy do the filtering, which is also what makes the scope-tagged case in
// the test pass and fail on a grant alone.
//
// The unread expression itself mirrors `listThreads`' (thread.ts): messages
// newer than the `created_at` of `last_read_message_id`, soft deleted rows
// excluded, `1970-01-01` when the thread was never opened. It is counted per
// thread (a lateral count bounded by the read mark), not per message. There is no
// reusable unread-count function in the tree to call, only that one inline
// subquery inside a large raw list query; it is mirrored here rather than
// extracted because extracting it would edit a frozen module.
//
// Muted and archived threads do not count. A badge is a nudge, and a thread
// the user silenced must not produce one. Neither does a thread the Messages
// list never shows (a routine's output thread, an approval anchor, a subrun):
// the badge sits on Messages, so it counts only what Messages lets the user
// open, through the list's own predicate (`messagesListShows`).
import {
  type AttentionItem,
  badgeItemThreadId,
  countBadge,
  isDirectMessageShape,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { computeApprovalBadgeItems } from "~/modules/approvals/attention"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { parseSettleKey } from "~/modules/push/redact"
import { notStatusLine } from "~/modules/threads/status-line-sql"
import { messagesListShows } from "~/modules/threads/thread"

/** A thread with unread messages for the reader. */
interface UnreadThreadRow {
  id: string
  type: string | null
  title: string | null
  n: number
}

/** The scope that makes an access request the viewer's to grant. */
const ACCESS_GRANT_SCOPE = "kernel:scope_requests:admin"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function asUser<T>(
  userId: string,
  orgId: string,
  fn: (tx: RlsClient, scopes: string[]) => Promise<T>,
): Promise<T> {
  const permissions = await withPrivilegedDb(orgId, "push-badge-count-permissions", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: permissions.scopes,
      dimensionGrants: permissions.dimensionGrants,
      roles: permissions.roles,
    },
    (tx) => fn(tx, permissions.scopes),
  )
}

/** Every thread the Messages list shows with unread messages for the reader. */
async function unreadThreads(
  tx: RlsClient,
  userId: string,
  orgId: string,
): Promise<UnreadThreadRow[]> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  return extractRows<UnreadThreadRow>(
    await tx.execute(drizzleSql`
          SELECT t.id, t.type, t.title, unread.n::int AS n
          FROM ${k}.threads t
          JOIN ${k}.thread_participants tp
            ON tp.thread_id = t.id AND tp.user_id = ${userId}
          LEFT JOIN ${k}.user_thread_state uts
            ON uts.thread_id = t.id AND uts.user_id = ${userId}
          LEFT JOIN ${k}.messages lr ON lr.id = uts.last_read_message_id
          -- The read mark, resolved ONCE per thread. As a plain column (OFFSET 0
          -- keeps the subquery from being flattened back into an expression) it
          -- becomes an index bound on messages(thread_id, created_at), so a
          -- thread costs its unread tail, not its whole history. Counting with a
          -- correlated last-read lookup per message cost one RLS-checked probe
          -- per message ever posted in the user's threads, which timed out on
          -- orgs with large imported channels.
          CROSS JOIN LATERAL (
            SELECT COALESCE(lr.created_at, '1970-01-01'::timestamptz) AS at OFFSET 0
          ) last_read
          CROSS JOIN LATERAL (
            SELECT COUNT(*) AS n
            FROM ${k}.messages m
            WHERE m.thread_id = t.id
              AND m.created_at > last_read.at
              AND m.org_id = ${orgId}
              AND m.deleted_at IS NULL
              -- The reader's own words, exactly as the thread list reads them:
              -- a row the reader wrote AS A PERSON. Agent rows carry the same
              -- author_id (the person whose turn it is), so \`author_id <> me\`
              -- also dropped every agent reply in the reader's own DMs, and the
              -- badge never rose for the answers the reader was waiting for. A system
              -- line the reader's own action wrote (a compaction summary, a participant
              -- they added) is theirs too.
              AND NOT (m.author_id = ${userId} AND m.author_type IN ('user', 'system'))
              -- A status line ("Routine X is running") is never unread.
              AND ${notStatusLine()}
              -- A4: a reply the channel does not show is not a channel badge.
              AND (m.reply_root_id IS NULL OR m.also_in_channel)
          ) unread
          WHERE t.org_id = ${orgId}
            AND ${messagesListShows(k)}
            AND COALESCE(uts.is_muted, false) = false
            AND COALESCE(uts.is_archived, false) = false
            AND unread.n > 0
        `),
  )
}

/** The Messages entry's number: every unread message the Messages list shows. */
export async function computeUnreadMessageCount(userId: string, orgId: string): Promise<number> {
  return asUser(userId, orgId, async (tx) => {
    const rows = await unreadThreads(tx, userId, orgId)
    return rows.reduce((sum, row) => sum + row.n, 0)
  })
}

/** The reader's unread persisted attention rows that can be a direct ask. */
async function askRows(tx: RlsClient, userId: string, orgId: string) {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows<{
    kind: string
    entity_type: string
    entity_id: string
    urgency: number | string
    metadata: Record<string, unknown> | null
  }>(
    await tx.execute(drizzleSql`
      SELECT kind, entity_type, entity_id, urgency, metadata
      FROM ${k}.attention_events
      WHERE org_id = ${orgId}
        AND user_id = ${userId}
        AND read_at IS NULL
        AND email_only = false
        AND kind <> 'approval_pending'
        AND NOT COALESCE((metadata->>'quiet')::boolean, false)
        AND (
          kind IN ('mention', 'thread_followup', 'scope_request', 'routine_mailbox_wait')
          OR kind LIKE '%.critical'
          OR metadata ? 'nodePermissionPromptId'
          OR metadata ? 'nodePermission'
        )
      LIMIT 1000
    `),
  )
  return rows.map((r) => ({
    kind: r.kind as AttentionItem["kind"],
    entity: r.entity_type,
    entityId: r.entity_id,
    urgency: Number(r.urgency),
    metadata: r.metadata ?? undefined,
  }))
}

/**
 * The most approvals the badge reads for one person. The read runs per
 * recipient on every push, so it is bounded: past this many open decisions the
 * number stops rising, and Home's list still shows every one.
 */
export const APPROVAL_BADGE_CAP = 200

/** The most settle keys one foreground sweep may ask about. */
export const SETTLE_KEYS_MAX = 200

/** What the badge reads for one person, for the count and for the phone's foreground sync. */
export interface BadgeReading {
  count: number
  /**
   * The asked settle keys (`PushPayload.settle`) whose notification is known
   * to be read or resolved: the phone withdraws those and keeps the rest.
   */
  settled: string[]
}

/**
 * THE badge for one person (rule 6): the shared `countBadge` over the threads
 * with unread messages, the person's unread attention rows and the approvals
 * they are asked to decide. Runs as the user, so every row is one the read-time
 * predicates admit. With `settle` keys (the phone's delivered notifications),
 * it also says which of them are settled (rule 5).
 */
export async function readBadge(
  userId: string,
  orgId: string,
  settle: readonly string[] = [],
): Promise<BadgeReading> {
  return asUser(userId, orgId, async (tx, scopes) => {
    const threads = await unreadThreads(tx, userId, orgId)
    const rows = await askRows(tx, userId, orgId)
    const approvals = await computeApprovalBadgeItems(tx, orgId, userId, APPROVAL_BADGE_CAP)
    // The conversations the rows sit in, read or not: a mention in a direct
    // conversation is one of its messages, counted (or read) with them.
    const listed = new Set(threads.map((t) => t.id))
    const k = drizzleSql.raw(schemaRef("kernel"))
    const around = [
      ...new Set(rows.map(badgeItemThreadId).filter((id): id is string => !!id && UUID.test(id))),
    ].filter((id) => !listed.has(id))
    const context =
      around.length === 0
        ? []
        : extractRows<{ id: string; type: string | null; title: string | null }>(
            await tx.execute(drizzleSql`
              SELECT id, type, title FROM ${k}.threads
              WHERE org_id = ${orgId} AND id IN (${drizzleSql.join(
                around.map((id) => drizzleSql`${id}::uuid`),
                drizzleSql`, `,
              )})`),
          )
    const count = countBadge({
      threads: [
        ...threads.map((t) => ({ id: t.id, type: t.type, title: t.title, unreadCount: t.n })),
        ...context.map((t) => ({ id: t.id, type: t.type, title: t.title, unreadCount: 0 })),
      ],
      items: [...rows, ...approvals],
      viewer: { canGrantAccess: hasScope(ACCESS_GRANT_SCOPE, scopes) },
    })
    const settled = settle.length === 0 ? [] : await settledKeys(tx, userId, orgId, settle)
    return { count, settled }
  })
}

/**
 * RULE 5: which of these notifications are known to be read or resolved, by
 * the exact thing each announced. Never by absence: a key it cannot judge (an
 * id it cannot find or see, a shape it does not know) is not settled, so the
 * notification stays until the person or a later answer clears it.
 *
 *  - `message/<id>`: deleted, or read where it lives: a reply only its reply
 *    thread shows by the reader's mark on that reply thread; a channel
 *    message (or a reply the channel shows too) by the channel's read mark,
 *    and such a reply also by the reply thread's. Whatever thread it is in
 *    (an entity's thread the Messages list hides included).
 *  - `attention/<app>/<type>/<id>`: every one of the reader's rows for that
 *    item is read (at least one exists), or, for an approval, it is no
 *    longer waiting for a decision.
 */
async function settledKeys(
  tx: RlsClient,
  userId: string,
  orgId: string,
  keys: readonly string[],
): Promise<string[]> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const messageKeys = new Map<string, string>()
  const itemKeys = new Map<string, { app: string; entityType: string; entityId: string }>()
  for (const key of keys.slice(0, SETTLE_KEYS_MAX)) {
    const parsed = parseSettleKey(key)
    if (parsed?.kind === "message" && UUID.test(parsed.messageId)) {
      messageKeys.set(parsed.messageId, key)
    } else if (parsed?.kind === "attention") {
      itemKeys.set(key, parsed)
    }
  }
  const settled: string[] = []
  if (messageKeys.size > 0) {
    const ids = drizzleSql.join(
      [...messageKeys.keys()].map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    const read = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT m.id::text AS id
        FROM ${k}.messages m
        LEFT JOIN ${k}.user_thread_state uts
          ON uts.thread_id = m.thread_id AND uts.user_id = ${userId}
        LEFT JOIN ${k}.messages lr ON lr.id = uts.last_read_message_id
        LEFT JOIN ${k}.reply_thread_followers f
          ON f.root_message_id = m.reply_root_id AND f.user_id = ${userId}
        WHERE m.org_id = ${orgId}
          AND m.id IN (${ids})
          AND (
            m.deleted_at IS NOT NULL
            OR ((m.reply_root_id IS NULL OR m.also_in_channel) AND lr.created_at >= m.created_at)
            OR (m.reply_root_id IS NOT NULL AND f.last_read_at >= m.created_at)
          )`),
    )
    for (const row of read) {
      const key = messageKeys.get(row.id)
      if (key) settled.push(key)
    }
  }
  if (itemKeys.size > 0) {
    const values = drizzleSql.join(
      [...itemKeys].map(
        ([key, item]) =>
          drizzleSql`(${key}::text, ${item.app}::text, ${item.entityType}::text, ${item.entityId}::text)`,
      ),
      drizzleSql`, `,
    )
    const done = extractRows<{ key: string }>(
      await tx.execute(drizzleSql`
        WITH asked(key, app, entity_type, entity_id) AS (VALUES ${values})
        SELECT a.key
        FROM asked a
        WHERE (
          EXISTS (
            SELECT 1 FROM ${k}.attention_events e
            WHERE e.org_id = ${orgId} AND e.user_id = ${userId}
              AND e.app = a.app AND e.entity_type = a.entity_type AND e.entity_id = a.entity_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${k}.attention_events e
            WHERE e.org_id = ${orgId} AND e.user_id = ${userId}
              AND e.app = a.app AND e.entity_type = a.entity_type AND e.entity_id = a.entity_id
              AND e.read_at IS NULL
          )
        ) OR (
          a.app = 'kernel' AND a.entity_type = 'approval_request'
          AND EXISTS (
            SELECT 1 FROM ${k}.approval_requests ar
            WHERE ar.org_id = ${orgId}
              -- CASE: the cast runs only on an id shaped like one.
              AND ar.id = CASE
                WHEN a.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN a.entity_id::uuid
              END
              AND ar.status NOT IN ('pending', 'approving')
          )
        )`),
    )
    for (const row of done) settled.push(row.key)
  }
  return settled
}

/** The number the app icon shows on every device. */
export async function computeBadgeCount(userId: string, orgId: string): Promise<number> {
  return (await readBadge(userId, orgId)).count
}

/**
 * The people of a direct conversation, at most `limit` (none for any other
 * thread): whose badge a deleted message of it can lower (read-sync.ts).
 */
export async function directThreadMembers(
  orgId: string,
  threadId: string,
  limit: number,
): Promise<string[]> {
  if (!UUID.test(threadId)) return []
  const k = drizzleSql.raw(schemaRef("kernel"))
  return withPrivilegedDb(orgId, "badge-sync-direct-members", async (tx) => {
    const [thread] = extractRows<{ type: string; title: string | null }>(
      await tx.execute(drizzleSql`
        SELECT type, title FROM ${k}.threads WHERE id = ${threadId}::uuid AND org_id = ${orgId}`),
    )
    if (
      !thread ||
      !isDirectMessageShape({
        title: thread.title,
        type: thread.type,
        discoverable: false,
        participants: [],
        currentUserId: "",
      })
    )
      return []
    const rows = extractRows<{ user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT user_id FROM ${k}.thread_participants
        WHERE thread_id = ${threadId}::uuid AND org_id = ${orgId} AND user_id IS NOT NULL
        LIMIT ${limit}`),
    )
    return rows.map((r) => r.user_id)
  })
}

/**
 * The people an access request was put to (their `scope_request` rows), at
 * most `limit`: whose badge its decision lowers (read-sync.ts).
 */
export async function scopeRequestHolders(
  orgId: string,
  requestId: string,
  limit: number,
): Promise<string[]> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  return withPrivilegedDb(orgId, "badge-sync-scope-request-holders", async (tx) => {
    const rows = extractRows<{ user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT user_id FROM ${k}.attention_events
        WHERE org_id = ${orgId} AND app = 'kernel' AND kind = 'scope_request'
          AND entity_id = ${requestId}
        LIMIT ${limit}`),
    )
    return rows.map((r) => r.user_id)
  })
}
