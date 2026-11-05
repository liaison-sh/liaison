// SPDX-License-Identifier: FSL-1.1-ALv2
//
// memory_search and memory_open (P4m-T21, P4m-T22; spec-memory.md L3).
//
// THREE LEGS, ONE FUSION. Topic files, episode files and the verbatim
// transcript are three independently ranked lists, fused by reciprocal rank
// fusion with k = 60, the same fusion Knowledge already uses
// (`apps/knowledge/federated-search.ts`). The shape is imported in spirit, not
// forked: that file is Knowledge's and ranks Knowledge's hits.
//
// THE DATABASE IS THE GATE, MEILI IS THE FAST PATH. Every transcript hit is
// re-read in the database and re-checked with `isMessageVisible` against the
// TURN's grants before it is returned. The index carries no disclosure list and
// no room membership, and its `required_scopes` can be stale relative to the
// row (an edit that narrowed a message reaches Meili on its own schedule). A
// filter is therefore a ranking aid; it is never the thing that decides who may
// read a message.
//
// NO RERANKER. A cross encoder measured WORSE on conversational memory, so
// there is none and adding one is a measured decision, not a default.
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agentMemory } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { effectiveIndexName, ensureMeiliVectorStore, getMeili } from "~/infra/search/client"
import { rootLogger } from "~/lib/logger"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { MMR_LAMBDA, mmr } from "~/modules/agent/memory/rrf"
import {
  MEMORY_EMBEDDER_NAME,
  memoryEmbedderDeclared,
  resolveOrgEmbedder,
} from "~/modules/search/message-indexer"
import { filterByVisibility, isMessageVisible } from "~/services/security/visibility"

const log = rootLogger.child({ module: "agent-memory-search" })

/** The fusion constant, the same k = 60 the knowledge fusion uses. */
export const RRF_K = 60

/** The whole serialized result payload, in tokens (spec-memory.md Budgets). */
export const MEMORY_SEARCH_PAYLOAD_TOKEN_CAP = 1000

/** The verbatim window `memory_open` may return, in messages. */
export const MEMORY_OPEN_MAX_MESSAGES = 40

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
/** How many documents each leg contributes before fusion. */
const LEG_DEPTH = 20

/** How deep the fused list the diversity pass reranks goes (P4c-T48). */
export const FUSED_DIVERSITY_DEPTH = 20

/**
 * How many hits a search returns after the diversity pass. Five, not ten: the
 * fourth leg makes the top of the list DENSER, and a tenth hit on a five hit
 * answer is padding the turn pays context for.
 */
export const MEMORY_SEARCH_TOP_N = 5

export interface MemorySearchContext {
  userId: string
  orgId: string
  db: RlsClient
  /** The TURN's effective scope, never the RLS actor's raw grants. */
  scopes?: string[]
  /**
   * The room this recall happened in. It is what makes "recalled in three
   * DISTINCT threads" answerable at all (P4m-T28's promotion rule): a counter
   * on the row says how many times, never how many different rooms. Absent
   * means no ledger row, which only costs the promotion signal.
   */
  recallThreadId?: string
  /** The agent whose ledger this recall belongs to. */
  recallAgentId?: string
  /**
   * The agent whose TREE is searched, when it is not the caller's own. The tail
   * (P4m-T14) reads MEMORY.md by `owner_agent_id`, so the search under it has
   * to key the same way or a role agent's turn recalls the human's files and
   * never its own. Defaults to `recallAgentId`, which every turn already sets.
   */
  ownerAgentId?: string
  /**
   * FX3-1. The agent acting in the TOOL call, stamped on the tool ctx by
   * execute-tool. The recall path names the agent itself (`recallAgentId`); a
   * tool call does not, and without this a role agent calling memory_search
   * from its own turn searched the calling human's tree while the same turn's
   * tail read MEMORY.md from the agent's. `null` is a positive "no agent".
   */
  actingAgentId?: string | null
}

/**
 * THE AGENT'S OWN MEMBERSHIP, on a verbatim transcript hit.
 *
 * The re-check joined `thread_participants` on the REQUESTING HUMAN alone, so a
 * recall returned verbatim messages out of every room that person is in,
 * including rooms the agent was never seated in and stretches of a room from
 * before it joined. The charter promises "the verbatim messages you were
 * allowed to read", and spec-memory.md is explicit that an agent that joins a
 * channel late gets nothing before its join point from the transcript index
 * (the membership predicate, and invariant I5's per agent tail).
 *
 * The seatless branch is the one `loadBoundedHistory` already makes for the
 * rendered history: a room with NO agent seat at all is a legacy 1:1 or a plain
 * human room, where there is no seat to measure against and the human's own
 * membership is the whole gate. A room that HAS agent seats is judged on them.
 */
function agentMembershipPredicate(agentId: string | undefined) {
  if (!agentId) return drizzleSql``
  const K = drizzleSql.raw(schemaRef("kernel"))
  return drizzleSql`AND (
    EXISTS (
      SELECT 1 FROM ${K}.thread_participants ap
      WHERE ap.thread_id = m.thread_id AND ap.org_id = m.org_id
        AND ap.agent_id = ${agentId} AND m.created_at >= ap.created_at
    )
    OR NOT EXISTS (
      SELECT 1 FROM ${K}.thread_participants seats
      WHERE seats.thread_id = m.thread_id AND seats.org_id = m.org_id
        AND seats.agent_id IS NOT NULL
    )
  )`
}

/**
 * The agent whose memory this call is about: the explicitly named tree first,/**
 * The agent whose memory this call is about: the explicitly named tree first,
 * then the recalling agent, then the agent acting in a tool call. Undefined
 * only for a caller with no agent at all, which is the legacy `user_id` key.
 */
function memoryAgentId(ctx: MemorySearchContext): string | undefined {
  return ctx.ownerAgentId ?? ctx.recallAgentId ?? ctx.actingAgentId ?? undefined
}

export interface MemorySearchParams {
  query: string
  since?: string
  until?: string
  threadId?: string
  limit?: number
  includeSuperseded?: boolean
  /** Recall for a routine tick puts these first (P4m-T24). */
  preferThreadId?: string
}

export type MemoryHitKind = "file" | "episode" | "transcript" | "brief"

/** The minimum a leg entry must carry to be fused. */
export interface FusableHit {
  key: string
  requiredScopes: string[]
}

export interface MemorySearchHit extends FusableHit {
  kind: MemoryHitKind
  /** A file path for a memory hit. */
  path?: string
  description?: string
  snippet: string
  /** Citations for a transcript hit. */
  threadHandle?: string
  messageId?: string
  author?: string
  date?: string
  /** The memory row behind a file or episode hit, for recall bookkeeping. */
  rowId?: string
  fusedScore: number
  /**
   * The OTHER members of this hit's near-duplicate cluster: the same fact,
   * said again elsewhere. Listed rather than returned, so the turn pays for one
   * of them and `memory_open` can still reach the rest.
   */
  clusterMessageIds?: string[]
  /**
   * The stored vector, when the document has one. Carried on the hit only so
   * the diversity pass can measure it; stripped before the payload is sized or
   * returned, because a 3072 float array is not something a turn pays for.
   */
  vector?: number[] | null
}

/**
 * Reciprocal rank fusion, `1 / (RRF_K + rank)` summed over the legs a hit
 * appears in, ranks one based. Pure and exported so the constant and the
 * arithmetic are testable without a database or an index behind them.
 */
export function fuseLegs<T extends FusableHit>(legs: T[][]): Array<T & { fusedScore: number }> {
  const scores = new Map<string, number>()
  const byKey = new Map<string, T>()
  for (const leg of legs) {
    leg.forEach((hit, index) => {
      scores.set(hit.key, (scores.get(hit.key) ?? 0) + 1 / (RRF_K + index + 1))
      if (!byKey.has(hit.key)) byKey.set(hit.key, hit)
    })
  }
  return [...byKey.values()]
    .map((hit) => ({ ...hit, fusedScore: scores.get(hit.key) ?? 0 }))
    .sort((a, b) => b.fusedScore - a.fusedScore || a.key.localeCompare(b.key))
}

/** Query terms worth matching on: two characters or more, case folded. */
function queryTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2))]
}

/**
 * The lexical score of one memory file. A name match is the strongest signal
 * (the model named the file), then the description (the line it sees in
 * MEMORY.md every turn), then the body.
 */
function lexicalScore(
  terms: string[],
  row: { name: string; description: string; content: string },
) {
  const name = row.name.toLowerCase()
  const description = row.description.toLowerCase()
  const content = row.content.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += 5
    if (description.includes(term)) score += 3
    if (content.includes(term)) score += 1
  }
  return score
}

function snippetOf(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)
  const from = at.length > 0 ? Math.max(0, Math.min(...at) - 40) : 0
  return text
    .slice(from, from + 200)
    .replace(/\s+/g, " ")
    .trim()
}

interface MemoryRow {
  id: string
  type: string
  name: string
  path: string | null
  description: string
  content: string
  requiredScopes: string[]
  updatedAt: Date
  supersededAt: Date | null
  sourceThreadId: string | null
}

/**
 * Whose tree this search reads. KEYED ON THE AGENT whenever the turn has one,
 * exactly as the runtime tail is: the legacy `user_id` key is what a turn with
 * no agent at all (a REST assembler, a test) still falls back to.
 */
function memoryOwnerFilter(ctx: MemorySearchContext) {
  const owner = memoryAgentId(ctx)
  return owner ? eq(agentMemory.ownerAgentId, owner) : eq(agentMemory.userId, ctx.userId)
}

/**
 * Every memory row this caller may read, already scope filtered by the TURN's
 * grants. The index row is never a hit (it quotes the others) and a checkpoint
 * is not a memory row at all, so no `checkpoints/` path can reach a leg.
 */
async function readableMemoryRows(
  params: MemorySearchParams,
  ctx: MemorySearchContext,
): Promise<MemoryRow[]> {
  const rows = (await ctx.db
    .select({
      id: agentMemory.id,
      type: agentMemory.type,
      name: agentMemory.name,
      path: agentMemory.path,
      description: agentMemory.description,
      content: agentMemory.content,
      requiredScopes: agentMemory.requiredScopes,
      updatedAt: agentMemory.updatedAt,
      supersededAt: agentMemory.supersededAt,
      sourceThreadId: agentMemory.sourceThreadId,
    })
    .from(agentMemory)
    .where(and(eq(agentMemory.orgId, ctx.orgId), memoryOwnerFilter(ctx)))) as MemoryRow[]
  const visible = filterByVisibility(rows, {
    userId: ctx.userId,
    grants: ctx.scopes ?? [],
  }) as MemoryRow[]
  const since = params.since ? new Date(params.since) : null
  const until = params.until ? new Date(params.until) : null
  return visible.filter((row) => {
    if (row.type === "_index") return false
    if ((row.path ?? "").startsWith("checkpoints/")) return false
    if (!params.includeSuperseded && row.supersededAt !== null) return false
    if (since && row.updatedAt < since) return false
    if (until && row.updatedAt > until) return false
    // `preferThreadId` narrows EVERY leg, not just the transcript one: a
    // routine tick's first leg is "what did my own past ticks conclude", and a
    // memory row answers that through its source thread.
    const onlyThread = params.threadId ?? params.preferThreadId
    if (onlyThread && row.sourceThreadId !== onlyThread) return false
    return true
  })
}

function memoryLeg(
  rows: MemoryRow[],
  terms: string[],
  kind: MemoryHitKind,
): Array<MemorySearchHit> {
  return rows
    .map((row) => ({ row, score: lexicalScore(terms, row) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.row.path ?? "").localeCompare(b.row.path ?? ""))
    .slice(0, LEG_DEPTH)
    .map(({ row }) => ({
      kind,
      key: `memory:${row.id}`,
      rowId: row.id,
      path: row.path ?? `${row.type}/${row.name}.md`,
      description: row.description,
      snippet: snippetOf(row.content, terms),
      requiredScopes: row.requiredScopes,
      fusedScore: 0,
    }))
}

/** A Meilisearch filter string literal: backslash first, then the quote, or a
 *  value ending in `\` or containing `\"` would close the literal early. */
function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function quoteList(values: string[]): string {
  return `[${values.map(quoteString).join(", ")}]`
}

/* -------------------------------------------------------------------------- */
/* P4c-T48: the period a question names                                       */
/* -------------------------------------------------------------------------- */

export interface TimeWindow {
  from: Date
  to: Date
  /** What was recognised, for the telemetry line. Never shown to the model. */
  label: string
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]

const DAY_MS = 24 * 60 * 60 * 1000

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** The Monday of `d`'s ISO week, at UTC midnight. */
function isoWeekStart(d: Date): Date {
  const day = utcDay(d)
  // getUTCDay is 0 for Sunday; an ISO week starts on Monday.
  const shift = (day.getUTCDay() + 6) % 7
  return new Date(day.getTime() - shift * DAY_MS)
}

/** The Monday of ISO week `week` of `year`: the week containing 4 January. */
function isoWeekOf(year: number, week: number): Date {
  return new Date(isoWeekStart(new Date(Date.UTC(year, 0, 4))).getTime() + (week - 1) * 7 * DAY_MS)
}

function span(from: Date, days: number, label: string): TimeWindow {
  return { from, to: new Date(from.getTime() + days * DAY_MS - 1), label }
}

function monthSpan(year: number, month: number, label: string): TimeWindow {
  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 1) - 1),
    label,
  }
}

/**
 * The period a question names, or null. A SMALL DETERMINISTIC PARSER: a date,
 * an ISO week, "last week", "last month", "in March". No model call, because a
 * filter that narrows what a search can reach must be reproducible: a
 * mis-parsed window is a fact the agent cannot find at all, and a model that
 * parses it differently on two turns is a search that answers differently on
 * two turns.
 *
 * Anything unrecognised is null, which is the whole transcript: the parser
 * FAILS OPEN, never onto a guessed window.
 */
export function parseTimeWindow(query: string, now: Date = new Date()): TimeWindow | null {
  const q = query.toLowerCase()

  const isoDate = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (isoDate) {
    const from = new Date(Date.UTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3])))
    if (!Number.isNaN(from.getTime())) return span(from, 1, isoDate[0])
  }

  const isoWeek = q.match(/\b(\d{4})-w(\d{1,2})\b/)
  if (isoWeek) return span(isoWeekOf(Number(isoWeek[1]), Number(isoWeek[2])), 7, isoWeek[0])

  const namedWeek = q.match(/\bweek\s+(\d{1,2})(?:\s+of\s+(\d{4}))?\b/)
  if (namedWeek) {
    const year = namedWeek[2] ? Number(namedWeek[2]) : now.getUTCFullYear()
    return span(isoWeekOf(year, Number(namedWeek[1])), 7, namedWeek[0])
  }

  if (/\blast week\b/.test(q)) {
    return span(new Date(isoWeekStart(now).getTime() - 7 * DAY_MS), 7, "last week")
  }
  if (/\b(this|the current) week\b/.test(q)) return span(isoWeekStart(now), 7, "this week")
  if (/\byesterday\b/.test(q)) return span(new Date(utcDay(now).getTime() - DAY_MS), 1, "yesterday")
  if (/\btoday\b/.test(q)) return span(utcDay(now), 1, "today")
  if (/\blast month\b/.test(q)) {
    return monthSpan(now.getUTCFullYear(), now.getUTCMonth() - 1, "last month")
  }
  if (/\bthis month\b/.test(q)) {
    return monthSpan(now.getUTCFullYear(), now.getUTCMonth(), "this month")
  }
  if (/\blast year\b/.test(q)) {
    const year = now.getUTCFullYear() - 1
    return {
      from: new Date(Date.UTC(year, 0, 1)),
      to: new Date(Date.UTC(year + 1, 0, 1) - 1),
      label: "last year",
    }
  }

  for (let m = 0; m < MONTHS.length; m++) {
    const name = MONTHS[m] as string
    const match = q.match(new RegExp(`\\b${name}(?:\\s+(\\d{4}))?\\b`))
    if (!match) continue
    // A bare month name with no year means the most recent one that has
    // already happened, which is what "what did we decide in March" means in
    // April and what it means in February.
    const year = match[1]
      ? Number(match[1])
      : m <= now.getUTCMonth()
        ? now.getUTCFullYear()
        : now.getUTCFullYear() - 1
    return monthSpan(year, m, match[0])
  }
  return null
}

const unixSeconds = (d: Date) => Math.floor(d.getTime() / 1000)

/** The transcript document kinds, and the brief's own two (P4c-T49). */
const TRANSCRIPT_ENTITY_TYPES = ["message", "message_window"]
const BRIEF_ENTITY_TYPES = ["brief_row", "episode"]

/**
 * THE ONE PREDICATE. Every leg, keyword or vector, is narrowed by exactly this
 * filter, which is what makes "the database visibility predicate that gates the
 * keyword legs gates the vector leg too" a property of the code and not a
 * promise: there is one filter builder and four callers.
 */
export function candidateFilter(
  params: MemorySearchParams,
  ctx: MemorySearchContext,
  entityTypes: string[],
  window: TimeWindow | null,
): string {
  const filters = [
    `org_id = ${quoteString(ctx.orgId)}`,
    `app = "kernel"`,
    `entity_type IN ${quoteList(entityTypes)}`,
  ]
  const grants = ctx.scopes ?? []
  const scopeTerms = ["NOT required_scopes EXISTS"]
  if (grants.length > 0) scopeTerms.push(`required_scopes IN ${quoteList(grants)}`)
  filters.push(`(${scopeTerms.join(" OR ")})`)
  const threadId = params.preferThreadId ?? params.threadId
  if (threadId) filters.push(`thread_id = ${quoteString(threadId)}`)
  // The period the question named. `created_at` is unix seconds on the
  // document (doc-builder.ts), so the window is a numeric range, not a string
  // comparison Meili would order lexically.
  if (window) {
    filters.push(`created_at >= ${unixSeconds(window.from)}`)
    filters.push(`created_at <= ${unixSeconds(window.to)}`)
  }
  return filters.join(" AND ")
}

interface Candidate {
  entityType: string
  entityId: string
  vector: number[] | null
}

function readCandidates(result: unknown): Candidate[] {
  const hits = (result as { hits?: Array<Record<string, unknown>> }).hits ?? []
  const out: Candidate[] = []
  for (const hit of hits) {
    const entityId = typeof hit.entity_id === "string" ? hit.entity_id : null
    const entityType = typeof hit.entity_type === "string" ? hit.entity_type : null
    if (!entityId || !entityType) continue
    const raw = (hit._vectors as Record<string, unknown> | undefined)?.[MEMORY_EMBEDDER_NAME]
    const embeddings = Array.isArray(raw)
      ? raw
      : ((raw as { embeddings?: unknown } | undefined)?.embeddings ?? null)
    const vector = Array.isArray(embeddings)
      ? ((Array.isArray(embeddings[0]) ? embeddings[0] : embeddings) as number[])
      : null
    out.push({ entityType, entityId, vector })
  }
  return out
}

/**
 * One keyword leg over `entityTypes`, narrowed by the turn's grants.
 * A window document's id is `<threadId>:<anchorId>`, so its anchor is what the
 * database half re-checks.
 */
async function keywordCandidates(
  params: MemorySearchParams,
  ctx: MemorySearchContext,
  entityTypes: string[],
  window: TimeWindow | null,
): Promise<Candidate[]> {
  try {
    await ensureMeiliVectorStore()
    const result = await getMeili()
      .index(effectiveIndexName())
      .search(params.query, {
        filter: candidateFilter(params, ctx, entityTypes, window),
        limit: LEG_DEPTH,
        retrieveVectors: true,
        // THE QUERY IS A QUESTION, NOT A KEYWORD LINE. Auto recall searches
        // with the incoming message verbatim, and Meili's default strategy
        // ("last") drops terms from the END, which makes every LEADING word
        // effectively required: "What is the carrier account number?" matched
        // nothing at all, because no message answering it starts with "what".
        // "frequency" drops the most common words first, which is exactly the
        // opening of a natural question.
        matchingStrategy: "frequency",
      })
    return readCandidates(result)
  } catch (err) {
    // Search being unwell costs recall, never the turn: the file legs still
    // answer and the charter's other paths still work.
    log.warn({ err, orgId: ctx.orgId }, "memory_search keyword leg unavailable")
    return []
  }
}

/**
 * THE FOURTH LEG. The query is embedded ONCE per search and matched against the
 * vectors already stored on the documents, over the SAME document set and the
 * SAME filter the keyword legs run under, so it is ranking and never
 * visibility: a document the predicate hides is not in the set the vector leg
 * searches, and every hit it does return still goes through the database
 * re-check below.
 *
 * Absent (an empty leg) when the org has no key, when no document has a vector
 * yet, or when the embedding call fails: hybrid search degrades to the keyword
 * search it already was.
 */
async function vectorCandidates(
  params: MemorySearchParams,
  ctx: MemorySearchContext,
  window: TimeWindow | null,
): Promise<{ candidates: Candidate[]; queryVector: number[] | null }> {
  try {
    const embedder = await resolveOrgEmbedder(ctx.orgId)
    if (!embedder) return { candidates: [], queryVector: null }
    // An index without the embedder answers a vector query with a 400: search
    // keyword only instead, and spend no embedding on the query.
    if (!(await memoryEmbedderDeclared(embedder.dimensions))) {
      return { candidates: [], queryVector: null }
    }
    const { vectors } = await embedder.embed([params.query])
    const queryVector = vectors[0]
    if (!Array.isArray(queryVector) || queryVector.length !== embedder.dimensions) {
      return { candidates: [], queryVector: null }
    }
    await ensureMeiliVectorStore()
    const result = await getMeili()
      .index(effectiveIndexName())
      .search(null, {
        filter: candidateFilter(
          params,
          ctx,
          [...TRANSCRIPT_ENTITY_TYPES, ...BRIEF_ENTITY_TYPES],
          window,
        ),
        limit: LEG_DEPTH,
        retrieveVectors: true,
        vector: queryVector,
        // semanticRatio 1 is a PURE vector leg: the keyword ranking is already
        // three legs of the fusion, and blending it in here a fourth time would
        // weight lexical agreement twice.
        hybrid: { embedder: MEMORY_EMBEDDER_NAME, semanticRatio: 1 },
      })
    return { candidates: readCandidates(result), queryVector }
  } catch (err) {
    log.warn({ err, orgId: ctx.orgId }, "memory_search vector leg unavailable")
    return { candidates: [], queryVector: null }
  }
}

/** The anchor message ids of a set of transcript candidates, in rank order. */
function transcriptMessageIds(candidates: Candidate[]): string[] {
  const ids: string[] = []
  for (const c of candidates) {
    if (!TRANSCRIPT_ENTITY_TYPES.includes(c.entityType)) continue
    const messageId = c.entityId.includes(":") ? c.entityId.split(":")[1] : c.entityId
    if (messageId && !ids.includes(messageId)) ids.push(messageId)
  }
  return ids
}

interface TranscriptRow {
  id: string
  content: string
  created_at: Date
  required_scopes: string[]
  disclosure_list: string[] | null
  thread_handle: string
  author_id: string | null
  author_name: string | null
}

/**
 * THE BACKSTOP. Re-reads each candidate in the database, inside the room the
 * caller is a participant of, and answers with `isMessageVisible` against the
 * TURN's grants. A candidate with no row, in a room the caller is not in, or
 * whose indexed scopes were stale, is simply absent.
 */
async function visibleTranscriptRows(
  messageIds: string[],
  ctx: MemorySearchContext,
): Promise<TranscriptRow[]> {
  if (messageIds.length === 0) return []
  const K = drizzleSql.raw(schemaRef("kernel"))
  const agentId = memoryAgentId(ctx)
  const rows = await withPrivilegedDb(ctx.orgId, "memory-search:transcript-recheck", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT m.id AS id, m.content AS content, m.created_at AS created_at,
             m.required_scopes AS required_scopes, m.disclosure_list AS disclosure_list,
             t.handle AS thread_handle, m.author_id AS author_id, u.name AS author_name
      FROM ${K}.messages m
      JOIN ${K}.threads t ON t.id = m.thread_id AND t.org_id = m.org_id
      JOIN ${K}.thread_participants tp
        ON tp.thread_id = m.thread_id AND tp.org_id = m.org_id AND tp.user_id = ${ctx.userId}
      LEFT JOIN ${K}.users u ON u.id = m.author_id
      WHERE m.org_id = ${ctx.orgId} AND m.deleted_at IS NULL
        ${agentMembershipPredicate(agentId)}
        AND m.id IN (${drizzleSql.join(
          messageIds.map((id) => drizzleSql`${id}`),
          drizzleSql`, `,
        )})`)
    return ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as unknown as TranscriptRow[]
  })
  const viewer = { userId: ctx.userId, grants: ctx.scopes ?? [] }
  const byId = new Map(rows.map((r) => [r.id, r]))
  return messageIds
    .map((id) => byId.get(id))
    .filter((row): row is TranscriptRow => {
      if (!row) return false
      return isMessageVisible(
        { requiredScopes: row.required_scopes, disclosureList: row.disclosure_list },
        viewer,
      )
    })
}

interface BriefHitRow {
  id: string
  kind: string
  text: string
  created_at: Date
  thread_handle: string
  anchor_required_scopes: string[] | null
  anchor_disclosure_list: string[] | null
  anchor_message_id: string | null
}

/**
 * THE SAME BACKSTOP, for the brief's own documents. A brief row and an episode
 * are not messages, so `isMessageVisible` cannot be asked about them directly:
 * what it is asked about is their ANCHOR, the first message the row was drawn
 * from. A caller who may not read the turn a decision was made in may not read
 * the decision row either, and a caller who is not a participant of the thread
 * never reaches the join at all.
 */
async function visibleBriefRows(
  candidates: Array<{ entityType: string; entityId: string }>,
  ctx: MemorySearchContext,
): Promise<BriefHitRow[]> {
  const briefIds = candidates.filter((c) => c.entityType === "brief_row").map((c) => c.entityId)
  const episodeIds = candidates.filter((c) => c.entityType === "episode").map((c) => c.entityId)
  if (briefIds.length === 0 && episodeIds.length === 0) return []
  const K = drizzleSql.raw(schemaRef("kernel"))
  const idList = (ids: string[]) =>
    drizzleSql`SELECT value::uuid AS id FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`
  // Invariant I5, the same join point rule the transcript re-check applies,
  // measured at the row's ANCHOR message `m`: an agent seated after the stretch
  // a brief row or an episode was drawn from never recalls it. The index used
  // to carry the seated agents (`participant_agent_ids`) but nothing ever
  // filtered on them, so this predicate is the rule's only enforcement.
  const seat = agentMembershipPredicate(memoryAgentId(ctx))

  const rows = await withPrivilegedDb(ctx.orgId, "memory-search:brief-recheck", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT b.id AS id, 'brief_row' AS kind,
             (b.kind || ' ' || b.key || ': ' || b.value) AS text,
             b.created_at AS created_at, t.handle AS thread_handle,
             m.required_scopes AS anchor_required_scopes,
             m.disclosure_list AS anchor_disclosure_list,
             m.id AS anchor_message_id
        FROM ${K}.thread_briefs b
        JOIN ${K}.threads t ON t.id = b.thread_id AND t.org_id = b.org_id
        JOIN ${K}.thread_participants tp
          ON tp.thread_id = b.thread_id AND tp.org_id = b.org_id AND tp.user_id = ${ctx.userId}
        LEFT JOIN ${K}.messages m ON m.id = b.first_message_id AND m.org_id = b.org_id
       WHERE b.org_id = ${ctx.orgId} AND b.id IN (${idList(briefIds)})
         ${seat}
      UNION ALL
      SELECT e.id AS id, 'episode' AS kind, (e.title || E'\n' || e.body) AS text,
             e.created_at AS created_at, t.handle AS thread_handle,
             m.required_scopes AS anchor_required_scopes,
             m.disclosure_list AS anchor_disclosure_list,
             m.id AS anchor_message_id
        FROM ${K}.thread_episodes e
        JOIN ${K}.threads t ON t.id = e.thread_id AND t.org_id = e.org_id
        JOIN ${K}.thread_participants tp
          ON tp.thread_id = e.thread_id AND tp.org_id = e.org_id AND tp.user_id = ${ctx.userId}
        LEFT JOIN ${K}.messages m
          ON m.id = e.span_start_message_id AND m.org_id = e.org_id
       WHERE e.org_id = ${ctx.orgId} AND e.id IN (${idList(episodeIds)})
         ${seat}`)
    return ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as unknown as BriefHitRow[]
  })

  const viewer = { userId: ctx.userId, grants: ctx.scopes ?? [] }
  const byId = new Map(rows.map((r) => [r.id, r]))
  return candidates
    .map((c) => byId.get(c.entityId))
    .filter((row): row is BriefHitRow => {
      if (!row) return false
      // No anchor message at all (a deleted turn) is NOT a free pass: the row
      // quotes text nobody can re-read, so it is absent.
      if (!row.anchor_message_id) return false
      return isMessageVisible(
        {
          requiredScopes: row.anchor_required_scopes ?? [],
          disclosureList: row.anchor_disclosure_list,
        },
        viewer,
      )
    })
}

/* -------------------------------------------------------------------------- */
/* P4c-T48: one hit per near-duplicate cluster                                */
/* -------------------------------------------------------------------------- */

/** The cluster id of each of these documents, as the clusterer last wrote it. */
async function readClusters(
  entityIds: string[],
  ctx: MemorySearchContext,
): Promise<Map<string, string>> {
  if (entityIds.length === 0) return new Map()
  const K = drizzleSql.raw(schemaRef("kernel"))
  try {
    const rows = await withPrivilegedDb(ctx.orgId, "memory-search:clusters", async (tx) => {
      const result = await tx.execute(drizzleSql`
        SELECT entity_id, canonical_id FROM ${K}.search_document_clusters
         WHERE org_id = ${ctx.orgId}
           AND entity_id IN (
             SELECT value FROM jsonb_array_elements_text(${JSON.stringify(entityIds)}::jsonb))`)
      return ((result as { rows?: Record<string, unknown>[] }).rows ??
        (result as Record<string, unknown>[])) as Array<{
        entity_id: string
        canonical_id: string
      }>
    })
    return new Map(rows.map((r) => [r.entity_id, r.canonical_id]))
  } catch (err) {
    // No clusters is the honest fallback: the search returns every hit it
    // found, which is what it did before the clusterer existed.
    log.warn({ err, orgId: ctx.orgId }, "memory_search could not read near-duplicate clusters")
    return new Map()
  }
}

/**
 * Keep ONE hit per cluster, in the fused order.
 *
 * WHICH ONE. The newest member, because "what is the DHL account number" is a
 * question about the current state and the newest saying of a fact is the one
 * that is still true. When the question named a PERIOD, the member inside that
 * period wins instead: "what did we decide in March" is not asking for April's
 * revision of it.
 *
 * The cluster's other ids ride along on the survivor, so nothing becomes
 * unreachable: `memory_open` opens any of them.
 */
export function collapseClusters(
  hits: MemorySearchHit[],
  clusterOf: Map<string, string>,
  window: TimeWindow | null,
): { hits: MemorySearchHit[]; collapsed: number } {
  const idOf = (hit: MemorySearchHit) => hit.messageId ?? hit.key
  const inWindow = (hit: MemorySearchHit) => {
    if (!window || !hit.date) return false
    const at = new Date(hit.date).getTime()
    return at >= window.from.getTime() && at <= window.to.getTime()
  }

  const groups = new Map<string, MemorySearchHit[]>()
  const order: string[] = []
  for (const hit of hits) {
    const cluster = clusterOf.get(idOf(hit)) ?? idOf(hit)
    if (!groups.has(cluster)) {
      groups.set(cluster, [])
      order.push(cluster)
    }
    ;(groups.get(cluster) as MemorySearchHit[]).push(hit)
  }

  let collapsed = 0
  const kept: MemorySearchHit[] = []
  for (const cluster of order) {
    const members = groups.get(cluster) as MemorySearchHit[]
    if (members.length === 1) {
      kept.push(members[0] as MemorySearchHit)
      continue
    }
    collapsed += members.length - 1
    const pool = window && members.some(inWindow) ? members.filter(inWindow) : members
    const winner = [...pool].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0] as
      | MemorySearchHit
      | undefined
    const chosen = winner ?? (members[0] as MemorySearchHit)
    kept.push({
      ...chosen,
      clusterMessageIds: members
        .filter((m) => m !== chosen)
        .map((m) => m.messageId)
        .filter((id): id is string => typeof id === "string"),
    })
  }
  return { hits: kept, collapsed }
}

/** Drop the lowest fused score until the serialized payload fits, keeping one. */
function capPayload(hits: MemorySearchHit[]): MemorySearchHit[] {
  const kept = [...hits]
  while (
    kept.length > 1 &&
    estimateTokens(JSON.stringify(kept)) > MEMORY_SEARCH_PAYLOAD_TOKEN_CAP
  ) {
    kept.pop()
  }
  return kept
}

/** Bump recall bookkeeping on the memory rows this search actually returned. */
async function recordRecall(rowIds: string[], ctx: MemorySearchContext): Promise<void> {
  if (rowIds.length === 0) return
  try {
    // ONE ledger row per search, not one per hit: the promotion rule needs the
    // set of rooms a file was recalled in, and nothing else does.
    if (ctx.recallThreadId && ctx.recallAgentId) {
      const { recordConsolidationAudit } = await import("~/modules/agent/memory/consolidation")
      await recordConsolidationAudit({
        orgId: ctx.orgId,
        agentId: ctx.recallAgentId,
        threadId: ctx.recallThreadId,
        action: "memory_recalled",
        metadata: { memoryIds: rowIds, threadId: ctx.recallThreadId },
      })
    }
    await ctx.db
      .update(agentMemory)
      .set({ recallCount: drizzleSql`${agentMemory.recallCount} + 1`, lastRecalledAt: new Date() })
      .where(
        and(
          eq(agentMemory.orgId, ctx.orgId),
          drizzleSql`${agentMemory.id} IN (${drizzleSql.join(
            rowIds.map((id) => drizzleSql`${id}`),
            drizzleSql`, `,
          )})`,
        ),
      )
  } catch (err) {
    // Bookkeeping is not the answer: a failed bump costs index upkeep quality,
    // never the recall the caller asked for.
    log.warn({ err, orgId: ctx.orgId }, "memory_search could not record recall")
  }
}

export async function memorySearch(
  params: MemorySearchParams,
  ctx: MemorySearchContext,
): Promise<{ hits: MemorySearchHit[] }> {
  const terms = queryTerms(params.query)
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  if (terms.length === 0) return { hits: [] }

  const rows = await readableMemoryRows(params, ctx)
  const fileLeg = memoryLeg(
    rows.filter((r) => r.type !== "episode"),
    terms,
    "file",
  )
  const episodeLeg = memoryLeg(
    rows.filter((r) => r.type === "episode"),
    terms,
    "episode",
  )
  // The period the question names, if it names one. Never applied on top of an
  // explicit `since`/`until`: a caller that already stated a window wins.
  const window = params.since || params.until ? null : parseTimeWindow(params.query)

  const [transcriptCandidates, briefCandidates, vectorLeg] = await Promise.all([
    keywordCandidates(params, ctx, TRANSCRIPT_ENTITY_TYPES, window),
    keywordCandidates(params, ctx, BRIEF_ENTITY_TYPES, window),
    vectorCandidates(params, ctx, window),
  ])

  // Every candidate any leg produced, re-checked in the DATABASE exactly once,
  // then dealt back out into the legs that named it. The vector leg's hits go
  // through the SAME re-check as the keyword legs', which is what makes the
  // fourth leg ranking and never visibility.
  const allCandidates = [...transcriptCandidates, ...briefCandidates, ...vectorLeg.candidates]
  const vectorByEntityId = new Map<string, number[]>()
  for (const c of allCandidates) if (c.vector) vectorByEntityId.set(c.entityId, c.vector)

  const [transcriptRows, briefRows] = await Promise.all([
    visibleTranscriptRows(transcriptMessageIds(allCandidates), ctx),
    visibleBriefRows(
      allCandidates.filter((c) => BRIEF_ENTITY_TYPES.includes(c.entityType)),
      ctx,
    ),
  ])

  const transcriptHits = new Map<string, MemorySearchHit>()
  for (const row of transcriptRows) {
    transcriptHits.set(row.id, {
      kind: "transcript" as const,
      key: `message:${row.id}`,
      messageId: row.id,
      threadHandle: row.thread_handle,
      author: row.author_name ?? row.author_id ?? "unknown",
      date: new Date(row.created_at).toISOString().slice(0, 10),
      snippet: snippetOf(row.content ?? "", terms),
      requiredScopes: row.required_scopes ?? [],
      fusedScore: 0,
      vector: vectorByEntityId.get(row.id) ?? null,
    })
  }
  const briefHits = new Map<string, MemorySearchHit>()
  for (const row of briefRows) {
    briefHits.set(row.id, {
      kind: row.kind === "episode" ? ("episode" as const) : ("brief" as const),
      key: `${row.kind}:${row.id}`,
      rowId: undefined,
      messageId: row.anchor_message_id ?? undefined,
      threadHandle: row.thread_handle,
      date: new Date(row.created_at).toISOString().slice(0, 10),
      snippet: snippetOf(row.text ?? "", terms),
      requiredScopes: row.anchor_required_scopes ?? [],
      fusedScore: 0,
      vector: vectorByEntityId.get(row.id) ?? null,
    })
  }

  /** A leg's candidates, in ITS rank order, as visible hits. */
  const legOf = (candidates: Candidate[]): MemorySearchHit[] => {
    const out: MemorySearchHit[] = []
    const seen = new Set<string>()
    for (const c of candidates) {
      const hit = BRIEF_ENTITY_TYPES.includes(c.entityType)
        ? briefHits.get(c.entityId)
        : transcriptHits.get(
            c.entityId.includes(":") ? (c.entityId.split(":")[1] as string) : c.entityId,
          )
      if (!hit || seen.has(hit.key)) continue
      seen.add(hit.key)
      out.push(hit)
    }
    return out
  }

  const fused = fuseLegs([
    fileLeg,
    episodeLeg,
    legOf(transcriptCandidates),
    legOf(briefCandidates),
    legOf(vectorLeg.candidates),
  ])

  // COLLAPSE, then diversity, then the cut. The clusterer's answer is applied
  // first because it is the exact one (two documents the clusterer joined ARE
  // the same fact); MMR is the approximate pass that follows it.
  const depth = fused.slice(0, FUSED_DIVERSITY_DEPTH)
  const { hits: deduped, collapsed } = collapseClusters(
    depth,
    await readClusters(
      depth.map((h) => h.messageId ?? h.key),
      ctx,
    ),
    window,
  )

  // DIVERSITY, then the cut. MMR over the fused top 20 with the stored vectors,
  // so a top five that is one fact said five ways becomes a top five that is
  // five facts.
  const diversified = mmr(
    deduped,
    (hit) => hit.vector ?? null,
    Math.min(limit, MEMORY_SEARCH_TOP_N),
    MMR_LAMBDA,
  )
  const hits = capPayload(diversified.map(({ vector: _vector, ...hit }) => hit))
  await recordRecall(
    hits.map((h) => h.rowId).filter((id): id is string => typeof id === "string"),
    ctx,
  )
  // The payload budget, measured (spec-memory.md "Budgets"): sizes only, no
  // hit content, so the line is safe at info on every search.
  log.info(
    {
      orgId: ctx.orgId,
      agentId: ctx.ownerAgentId ?? ctx.recallAgentId ?? ctx.actingAgentId ?? null,
      searchHits: hits.length,
      payloadTokens: estimateTokens(JSON.stringify(hits)),
      payloadCap: MEMORY_SEARCH_PAYLOAD_TOKEN_CAP,
    },
    "agent_memory_search",
  )
  // P4c-T48's own line: what the hybrid search actually did. Separate from the
  // budget line above, which an e2e asserts the shape of.
  log.info(
    {
      orgId: ctx.orgId,
      hits: hits.length,
      legs: {
        file: fileLeg.length,
        episode: episodeLeg.length,
        transcript: transcriptCandidates.length,
        brief: briefCandidates.length,
        vector: vectorLeg.candidates.length,
      },
      collapsed,
      window: window?.label ?? null,
    },
    hits.length === 0 ? "memory_search_empty" : "memory_search_hits",
  )
  return { hits }
}

// --- memory_open (P4m-T22) -------------------------------------------------

export interface MemoryOpenParams {
  messageId: string
  before?: number
  after?: number
}

export interface MemoryOpenMessage {
  messageId: string
  threadHandle: string
  author: string
  date: string
  content: string
}

/**
 * The window sizes actually used, clamped so `before + after + 1` never exceeds
 * 40. A request for more is CLAMPED, not refused, and the clamp is split so
 * neither side collapses to nothing.
 */
export function clampWindow(before: number, after: number): { before: number; after: number } {
  const budget = MEMORY_OPEN_MAX_MESSAGES - 1
  if (before + after <= budget) return { before, after }
  const half = Math.floor(budget / 2)
  const b = Math.min(before, half)
  return { before: b, after: Math.min(after, budget - b) }
}

/**
 * The verbatim messages around a transcript hit, EACH re-checked against the
 * visibility predicate: the window may straddle a disclosure, so this is a per
 * message answer and never a bulk one. An anchor the caller may not read
 * returns nothing at all: a window around an invisible message would disclose
 * where in the conversation it sits.
 */
export async function memoryOpen(
  params: MemoryOpenParams,
  ctx: MemorySearchContext,
): Promise<{ messages: MemoryOpenMessage[] }> {
  const { before, after } = clampWindow(params.before ?? 10, params.after ?? 10)
  const K = drizzleSql.raw(schemaRef("kernel"))
  const viewer = { userId: ctx.userId, grants: ctx.scopes ?? [] }

  const rows = await withPrivilegedDb(ctx.orgId, "memory-open:window", async (tx) => {
    const anchorResult = await tx.execute(drizzleSql`
      SELECT m.id AS id, m.thread_id AS thread_id, m.created_at AS created_at,
             m.required_scopes AS required_scopes, m.disclosure_list AS disclosure_list
      FROM ${K}.messages m
      JOIN ${K}.thread_participants tp
        ON tp.thread_id = m.thread_id AND tp.org_id = m.org_id AND tp.user_id = ${ctx.userId}
      WHERE m.id = ${params.messageId} AND m.org_id = ${ctx.orgId} AND m.deleted_at IS NULL
      LIMIT 1`)
    const anchorRows = ((anchorResult as { rows?: Record<string, unknown>[] }).rows ??
      (anchorResult as Record<string, unknown>[])) as Array<{
      id: string
      thread_id: string
      created_at: Date
      required_scopes: string[]
      disclosure_list: string[] | null
    }>
    const anchor = anchorRows[0]
    if (!anchor) return []
    if (
      !isMessageVisible(
        { requiredScopes: anchor.required_scopes, disclosureList: anchor.disclosure_list },
        viewer,
      )
    ) {
      return []
    }

    const result = await tx.execute(drizzleSql`
      (SELECT m.id, m.content, m.created_at, m.required_scopes, m.disclosure_list,
              t.handle AS thread_handle, m.author_id, u.name AS author_name
         FROM ${K}.messages m
         JOIN ${K}.threads t ON t.id = m.thread_id AND t.org_id = m.org_id
         LEFT JOIN ${K}.users u ON u.id = m.author_id
        WHERE m.thread_id = ${anchor.thread_id} AND m.org_id = ${ctx.orgId}
          AND m.deleted_at IS NULL
          AND (m.created_at, m.id) <= (${anchor.created_at}, ${anchor.id})
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${before + 1})
      UNION ALL
      (SELECT m.id, m.content, m.created_at, m.required_scopes, m.disclosure_list,
              t.handle AS thread_handle, m.author_id, u.name AS author_name
         FROM ${K}.messages m
         JOIN ${K}.threads t ON t.id = m.thread_id AND t.org_id = m.org_id
         LEFT JOIN ${K}.users u ON u.id = m.author_id
        WHERE m.thread_id = ${anchor.thread_id} AND m.org_id = ${ctx.orgId}
          AND m.deleted_at IS NULL
          AND (m.created_at, m.id) > (${anchor.created_at}, ${anchor.id})
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ${after})`)
    return ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as unknown as TranscriptRow[]
  })

  const messages = rows
    .filter((row) =>
      isMessageVisible(
        { requiredScopes: row.required_scopes, disclosureList: row.disclosure_list },
        viewer,
      ),
    )
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((row) => ({
      messageId: row.id,
      threadHandle: row.thread_handle,
      author: row.author_name ?? row.author_id ?? "unknown",
      date: new Date(row.created_at).toISOString(),
      content: row.content ?? "",
    }))
  return { messages: messages.slice(0, MEMORY_OPEN_MAX_MESSAGES) }
}
