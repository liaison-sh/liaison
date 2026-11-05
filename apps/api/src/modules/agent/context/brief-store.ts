// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T49: the brief as rows, and the reads that make it worth being rows.
//
// The store is deliberately dumb about MEANING and strict about ORDER. It never
// decides which of two values of a key is the true one by looking at them: it
// decides by where each one's first message sits in the thread. A model that
// emits an old value after a new one, or emits both in one batch, converges on
// the same chain either way, because the chain is recomputed from message order
// every time the key is touched.
//
// WHY A LOCK AND NOT A CONSTRAINT. The unique index makes a single line
// idempotent, but a supersession CHAIN is a statement about several rows at
// once: two writers interleaving row inserts and chain recomputes can leave two
// rows `current` on one key, which is exactly the ambiguity the table exists to
// remove. So every write path takes one transaction scoped advisory lock keyed
// on the THREAD (not the key: a thread's writes are rare and short, and one
// lock per thread is also what makes the mark advance atomic with the rows it
// covers).
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { advisoryXactLock, assertTransactionScoped } from "~/db/advisory-lock"
import {
  type BriefRowKind,
  type BriefRowStatus,
  threadBriefMarks,
  threadBriefs,
  threadEpisodes,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { BRIEF_CORE_TOKEN_BUDGET } from "~/modules/agent/context/cold-resume"
import { estimateTokens } from "~/modules/agent/context/compaction"

const log = rootLogger.child({ module: "brief-store" })

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** At most this many rows come back from `openLoopWithClosure`. */
export const OPEN_LOOP_FOLLOW_UP_LIMIT = 4

/** One extracted line, as the brief writer hands it over. */
export interface BriefRowInput {
  kind: BriefRowKind
  /** What the line is about. Supersession is keyed on it. */
  key: string
  /** What the line says. */
  value: string
  /** Every message the line was drawn from. The first is the ordering key. */
  messageIds: string[]
  /**
   * The earliest message of `messageIds`, when the caller already knows it.
   * Defaults to `messageIds[0]`, which is how the extractor emits them.
   */
  firstMessageId?: string
  /** This line CLOSES the open loop already recorded on the same key. */
  closes?: boolean
  /** The message that closed it. Defaults to this line's own first message. */
  closingMessageId?: string
}

export interface BriefRow {
  id: string
  orgId: string
  threadId: string
  kind: BriefRowKind
  key: string
  value: string
  status: BriefRowStatus
  supersededBy: string | null
  messageIds: string[]
  firstMessageId: string
  closingMessageId: string | null
}

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[]
}

/* -------------------------------------------------------------------------- */
/* The write path                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Write one region's extracted lines onto a thread.
 *
 * Idempotent per (thread, kind, key, first message): re-running the same region
 * rewrites the same rows rather than stacking duplicates, which is what lets a
 * second agent advance over a stretch a first one already covered without the
 * brief doubling.
 */
export async function upsertBriefRows(
  tx: PrivilegedDb,
  params: {
    orgId: string
    threadId: string
    agentId: string | null
    rows: BriefRowInput[]
    regionStart?: string | null
    regionEnd?: string | null
  },
): Promise<string[]> {
  const { orgId, threadId, agentId } = params
  assertTransactionScoped(tx, "upsertBriefRows")
  if (params.rows.length === 0) return []
  // Serialized per THREAD: the chain recompute below reads and rewrites several
  // rows of one key, and two writers interleaving those reads is how a key ends
  // up with two `current` rows.
  await tx.execute(advisoryXactLock(briefLockName(threadId)))

  const touched = new Map<string, { kind: BriefRowKind; key: string }>()
  const writtenIds: string[] = []

  for (const input of params.rows) {
    const firstMessageId = input.firstMessageId ?? input.messageIds[0]
    if (!firstMessageId) {
      log.warn({ threadId, key: input.key }, "A brief row with no message ids was dropped")
      continue
    }
    const closing = input.closes ? (input.closingMessageId ?? firstMessageId) : null
    const [row] = await tx
      .insert(threadBriefs)
      .values({
        orgId,
        threadId,
        kind: input.kind,
        key: input.key,
        value: input.value,
        status: input.closes ? "closed" : "current",
        messageIds: input.messageIds,
        firstMessageId,
        regionStartMessageId: params.regionStart ?? null,
        regionEndMessageId: params.regionEnd ?? null,
        writtenByAgentId: agentId,
        closingMessageId: closing,
      })
      .onConflictDoUpdate({
        target: [
          threadBriefs.threadId,
          threadBriefs.kind,
          threadBriefs.key,
          threadBriefs.firstMessageId,
        ],
        set: {
          value: input.value,
          messageIds: input.messageIds,
          updatedAt: new Date(),
          ...(input.closes ? { status: "closed" as const, closingMessageId: closing } : {}),
        },
      })
      .returning({ id: threadBriefs.id })
    if (row) writtenIds.push(row.id)
    touched.set(`${input.kind}\u0000${input.key}`, { kind: input.kind, key: input.key })
  }

  for (const { kind, key } of touched.values()) {
    await recomputeKey(tx, { orgId, threadId, kind, key })
  }
  return writtenIds
}

/** The advisory lock name for one thread's brief writes. */
export function briefLockName(threadId: string): string {
  return `thread-brief-rows:${threadId}`
}

/**
 * Rebuild one key's chain from MESSAGE ORDER, which is the only authority on
 * which value is newer. Called after every write to the key, so a batch that
 * arrived out of order and a batch that arrived in order leave the same rows.
 *
 * A key that carries a closure is CLOSED end to end: an open loop that was
 * answered is not "superseded", it is finished, and every row on it points at
 * the message that finished it.
 */
async function recomputeKey(
  tx: PrivilegedDb,
  params: { orgId: string; threadId: string; kind: BriefRowKind; key: string },
): Promise<void> {
  const { orgId, threadId, kind, key } = params
  const ordered = rows<{ id: string; status: BriefRowStatus; closing_message_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT b.id, b.status, b.closing_message_id
      FROM ${K()}.thread_briefs b
      LEFT JOIN ${K()}.messages m ON m.id = b.first_message_id AND m.org_id = b.org_id
      WHERE b.org_id = ${orgId} AND b.thread_id = ${threadId}
        AND b.kind = ${kind} AND b.key = ${key}
      ORDER BY m.created_at ASC NULLS LAST, m.id ASC NULLS LAST, b.first_message_id ASC`),
  )
  if (ordered.length === 0) return

  const closure = ordered.find((r) => r.status === "closed")
  if (closure) {
    await tx
      .update(threadBriefs)
      .set({
        status: "closed",
        closingMessageId: closure.closing_message_id,
        supersededBy: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threadBriefs.orgId, orgId),
          eq(threadBriefs.threadId, threadId),
          eq(threadBriefs.kind, kind),
          eq(threadBriefs.key, key),
        ),
      )
    return
  }

  for (let i = 0; i < ordered.length; i++) {
    const isLast = i === ordered.length - 1
    await tx
      .update(threadBriefs)
      .set({
        status: isLast ? "current" : "superseded",
        supersededBy: isLast ? null : ordered[i + 1].id,
        updatedAt: new Date(),
      })
      .where(eq(threadBriefs.id, ordered[i].id))
  }
}

/**
 * Move the thread's extraction mark forward to `uptoMessageId`, and only
 * forward: a second agent advancing over a stretch the first already extracted
 * must not drag the mark BACK and make the region eligible again.
 */
export async function advanceMark(
  tx: PrivilegedDb,
  params: { orgId: string; threadId: string; uptoMessageId: string },
): Promise<void> {
  const { orgId, threadId, uptoMessageId } = params
  await tx.execute(drizzleSql`
    INSERT INTO ${K()}.thread_brief_marks AS mark (thread_id, org_id, extracted_upto_message_id, updated_at)
    VALUES (${threadId}, ${orgId}, ${uptoMessageId}, now())
    ON CONFLICT (thread_id) DO UPDATE
      SET extracted_upto_message_id = EXCLUDED.extracted_upto_message_id,
          updated_at = now()
    WHERE mark.extracted_upto_message_id IS NULL
       OR (SELECT ROW(m.created_at, m.id) FROM ${K()}.messages m
            WHERE m.id = EXCLUDED.extracted_upto_message_id)
        > (SELECT ROW(m.created_at, m.id) FROM ${K()}.messages m
            WHERE m.id = mark.extracted_upto_message_id)`)
}

/** How far extraction has run on this thread, or null when it never has. */
export async function readMark(
  tx: PrivilegedDb,
  params: { orgId: string; threadId: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ upto: threadBriefMarks.extractedUptoMessageId })
    .from(threadBriefMarks)
    .where(
      and(eq(threadBriefMarks.orgId, params.orgId), eq(threadBriefMarks.threadId, params.threadId)),
    )
    .limit(1)
  return row?.upto ?? null
}

/**
 * The part of `region` the mark has NOT already covered. The region is assumed
 * to be in thread order, which is how every caller builds it.
 */
export async function regionPastMark<T extends { id: string; createdAt: Date }>(
  tx: PrivilegedDb,
  params: { orgId: string; threadId: string; region: T[] },
): Promise<T[]> {
  const mark = await readMark(tx, params)
  if (!mark) return params.region
  const idx = params.region.findIndex((m) => m.id === mark)
  if (idx >= 0) return params.region.slice(idx + 1)
  // The mark names a message outside this region: either behind it (nothing to
  // skip) or ahead of it (already extracted). Ask the database rather than
  // guess, because "ahead" is a message-order question.
  const [row] = rows<{ ahead: boolean }>(
    await tx.execute(drizzleSql`
      SELECT (SELECT ROW(m.created_at, m.id) FROM ${K()}.messages m WHERE m.id = ${mark})
           >= (SELECT ROW(m.created_at, m.id) FROM ${K()}.messages m
                WHERE m.id = ${params.region[params.region.length - 1]?.id ?? mark}) AS ahead`),
  )
  return row?.ahead ? [] : params.region
}

/* -------------------------------------------------------------------------- */
/* The read path                                                              */
/* -------------------------------------------------------------------------- */

/** One line of a rendered core, before it is joined into text. */
export function renderBriefLine(row: { kind: string; key: string; value: string }): string {
  return `- [${row.kind}] ${row.key}: ${row.value}`
}

/**
 * ONE AGENT'S core of one thread: the thread's current rows, newest first,
 * bounded by what THIS agent may see and capped at BRIEF_CORE_TOKEN_BUDGET.
 *
 * The rows are the conversation's; the window is the agent's. Nothing before
 * the agent's join point enters (invariant I5, the same rule the bounded
 * history load applies to raw messages) and nothing after the checkpoint's own
 * boundary does either, so the core an agent freezes describes exactly the
 * stretch its summary covers.
 *
 * Byte identical for identical inputs: the ordering is total (message order,
 * then row id), the line format is fixed, and the cap is a running sum with no
 * floating point in it.
 */
export async function renderCore(
  tx: PrivilegedDb,
  params: {
    orgId: string
    threadId: string
    agentId?: string | null
    uptoMessageId?: string | null
    joinPointMessageId?: string | null
  },
): Promise<string> {
  const { orgId, threadId } = params
  const upto = params.uptoMessageId
    ? drizzleSql`AND (m.created_at, m.id) <= (SELECT u.created_at, u.id FROM ${K()}.messages u WHERE u.id = ${params.uptoMessageId})`
    : drizzleSql``
  const join = params.joinPointMessageId
    ? drizzleSql`AND (m.created_at, m.id) >= (SELECT j.created_at, j.id FROM ${K()}.messages j WHERE j.id = ${params.joinPointMessageId})`
    : drizzleSql``

  const selected = rows<{ kind: string; key: string; value: string }>(
    await tx.execute(drizzleSql`
      SELECT b.kind, b.key, b.value
      FROM ${K()}.thread_briefs b
      JOIN ${K()}.messages m ON m.id = b.first_message_id AND m.org_id = b.org_id
      WHERE b.org_id = ${orgId} AND b.thread_id = ${threadId} AND b.status = 'current'
        ${upto}
        ${join}
      ORDER BY m.created_at DESC, m.id DESC, b.id DESC`),
  )

  const lines: string[] = []
  let tokens = 0
  for (const row of selected) {
    const line = renderBriefLine(row)
    const cost = estimateTokens(`${line}\n`)
    if (tokens + cost > BRIEF_CORE_TOKEN_BUDGET) break
    lines.push(line)
    tokens += cost
  }
  return lines.join("\n")
}

/**
 * One open loop and what followed it on the same key, up to and including the
 * closure. A hit on "we still owe them a ship date" that does not carry the
 * message where the ship date was finally given is worse than no hit at all:
 * the agent reads the loop as open and asks again.
 */
export async function openLoopWithClosure(tx: PrivilegedDb, rowId: string): Promise<BriefRow[]> {
  const [anchor] = rows<{
    thread_id: string
    kind: BriefRowKind
    key: string
    org_id: string
    first_message_id: string
  }>(
    await tx.execute(drizzleSql`
      SELECT b.thread_id, b.kind, b.key, b.org_id, b.first_message_id
      FROM ${K()}.thread_briefs b WHERE b.id = ${rowId} LIMIT 1`),
  )
  if (!anchor) return []

  const followed = rows<{
    id: string
    thread_id: string
    kind: BriefRowKind
    key: string
    value: string
    status: BriefRowStatus
    superseded_by: string | null
    message_ids: string[]
    first_message_id: string
    closing_message_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT b.id, b.thread_id, b.kind, b.key, b.value, b.status, b.superseded_by,
             b.message_ids, b.first_message_id, b.closing_message_id
      FROM ${K()}.thread_briefs b
      LEFT JOIN ${K()}.messages m ON m.id = b.first_message_id AND m.org_id = b.org_id
      WHERE b.org_id = ${anchor.org_id} AND b.thread_id = ${anchor.thread_id}
        AND b.kind = ${anchor.kind} AND b.key = ${anchor.key}
        AND (m.created_at, m.id) >= (
          SELECT a.created_at, a.id FROM ${K()}.messages a WHERE a.id = ${anchor.first_message_id})
      ORDER BY m.created_at ASC, m.id ASC, b.id ASC
      LIMIT ${OPEN_LOOP_FOLLOW_UP_LIMIT}`),
  )
  return followed.map((r) => ({
    id: r.id,
    orgId: anchor.org_id,
    threadId: r.thread_id,
    kind: r.kind,
    key: r.key,
    value: r.value,
    status: r.status,
    supersededBy: r.superseded_by,
    messageIds: r.message_ids ?? [],
    firstMessageId: r.first_message_id,
    closingMessageId: r.closing_message_id,
  }))
}

export interface EpisodeRecord {
  id: string
  orgId: string
  threadId: string
  title: string
  body: string
  spanStartMessageId: string | null
  spanEndMessageId: string | null
  messageIds: string[]
  createdAt: Date
}

/** One episode by id, or null. Episodes are FETCHED, never fed forward. */
export async function getEpisode(tx: PrivilegedDb, id: string): Promise<EpisodeRecord | null> {
  const [row] = await tx.select().from(threadEpisodes).where(eq(threadEpisodes.id, id)).limit(1)
  if (!row) return null
  return {
    id: row.id,
    orgId: row.orgId,
    threadId: row.threadId,
    title: row.title,
    body: row.body,
    spanStartMessageId: row.spanStartMessageId,
    spanEndMessageId: row.spanEndMessageId,
    messageIds: row.messageIds ?? [],
    createdAt: row.createdAt,
  }
}

/** At most this many episode titles ride along on a checkpoint's summary. */
export const BRIEF_EPISODE_TITLE_LIMIT = 12

/**
 * Write the ONE episode a region produces (P4c-T24), keyed on its span so the
 * same region written twice updates one row instead of stacking two. The body
 * is already capped by the caller at BRIEF_EPISODE_TOKEN_BUDGET: the column
 * holds whatever it is given, the budget lives with the writer.
 */
export async function upsertEpisode(
  tx: PrivilegedDb,
  params: {
    orgId: string
    threadId: string
    title: string
    body: string
    spanStartMessageId: string | null
    spanEndMessageId: string | null
    messageIds: string[]
  },
): Promise<string | null> {
  const [row] = await tx
    .insert(threadEpisodes)
    .values({
      orgId: params.orgId,
      threadId: params.threadId,
      title: params.title,
      body: params.body,
      spanStartMessageId: params.spanStartMessageId,
      spanEndMessageId: params.spanEndMessageId,
      messageIds: params.messageIds,
    })
    .onConflictDoUpdate({
      target: [
        threadEpisodes.threadId,
        threadEpisodes.spanStartMessageId,
        threadEpisodes.spanEndMessageId,
      ],
      set: { title: params.title, body: params.body, messageIds: params.messageIds },
    })
    .returning({ id: threadEpisodes.id })
  return row?.id ?? null
}

/**
 * The thread's episode titles, NEWEST FIRST, at most `limit`. One line each:
 * the core carries them so a resumed agent knows which episodes exist to fetch,
 * without any episode BODY entering the prompt (episodes are fetched, never fed
 * forward).
 */
export async function recentEpisodeTitles(
  tx: PrivilegedDb,
  params: { orgId: string; threadId: string; limit?: number },
): Promise<string[]> {
  const selected = await tx
    .select({ title: threadEpisodes.title, createdAt: threadEpisodes.createdAt })
    .from(threadEpisodes)
    .where(
      and(eq(threadEpisodes.orgId, params.orgId), eq(threadEpisodes.threadId, params.threadId)),
    )
    .orderBy(drizzleSql`created_at DESC, id DESC`)
    .limit(params.limit ?? BRIEF_EPISODE_TITLE_LIMIT)
  return selected.map((r) => r.title)
}

/** One brief row by id, or null. The lookup `memory_open` resolves against. */
export async function getBriefRow(tx: PrivilegedDb, id: string): Promise<BriefRow | null> {
  const [row] = await tx.select().from(threadBriefs).where(eq(threadBriefs.id, id)).limit(1)
  if (!row) return null
  return {
    id: row.id,
    orgId: row.orgId,
    threadId: row.threadId,
    kind: row.kind,
    key: row.key,
    value: row.value,
    status: row.status,
    supersededBy: row.supersededBy,
    messageIds: row.messageIds ?? [],
    firstMessageId: row.firstMessageId,
    closingMessageId: row.closingMessageId,
  }
}
