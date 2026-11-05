// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Consolidation (P4m-T25 to T28, spec-memory.md L5): the background job that
// closes an episode and turns raw conversation into durable memory.
//
// WHAT CLOSES AN EPISODE. A thread that has gone quiet for six hours after
// agent activity, a routine tick ending, and a checkpoint advancing. Each close
// enqueues one job whose id names the close, so a duplicate trigger is one job
// and not two.
//
// THE FLUSH IS STEP 1 ON EVERY PATH, NOT ONLY THE CHECKPOINT ONE. A quiet close
// and a tick close each summarize a region no checkpoint advance covered, so
// each must flush first or durable facts from that region are lost. The marker
// that makes the flush once-only is therefore keyed on the REGION,
// (agentId, threadId, fromMessageId, toMessageId), of which a checkpoint
// advance's region is one case. It is an audit row, which is where "what did
// consolidation do" is already asked from, so it needs no table of its own.
//
// IT WRITES MEMORY FILES AND CHECKPOINT VERSIONS ONLY. It never inserts, edits
// or deletes a message row, which is what keeps invariant I1 (pure render)
// true: a thread's rendered history cannot move because consolidation ran.
import { and, sql as drizzleSql, eq, gte, inArray, or } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import {
  agentMemory as agentMemoryTable,
  agents,
  approvalRequests,
  auditLog,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { isMessageVisible } from "~/services/security/visibility"

const K = () => drizzleSql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "agent-memory-consolidation" })

export const CONSOLIDATION_QUEUE_APP = "kernel"
export const CONSOLIDATION_JOB = "agent-memory-consolidation"

/** Six hours of quiet after agent activity closes an episode. */
export const EPISODE_QUIET_MS = 6 * 60 * 60 * 1000

/** Model calls per agent per day. Past it the job DEFERS, never skips. */
export const CONSOLIDATION_DAILY_MODEL_CALL_CAP = 200

/** The audit action every model call the job makes records itself under. */
export const CONSOLIDATION_USAGE_ACTION = "memory_consolidation"

/** The audit action that marks one region as flushed. */
export const FLUSH_REGION_ACTION = "memory_flush_region"

export type CloseReason = "quiet" | "routine-tick" | "checkpoint"

export interface EpisodeCloseKey {
  orgId: string
  agentId: string
  threadId: string
  closeReason: CloseReason
}

export interface ConsolidationPayload extends EpisodeCloseKey {
  /** Set by the checkpoint path, which already knows its region. */
  fromMessageId?: string
  toMessageId?: string
  /** The BullMQ job id, recorded on every audit row this run writes. */
  jobId?: string
}

/**
 * One id per (agent, thread, close cause), so a close fired twice is one job.
 * Two different causes are two jobs on purpose: they cover different regions
 * and the region marker, not the job id, is what stops the flush running twice.
 */
export function consolidationJobId(key: EpisodeCloseKey): string {
  return `${CONSOLIDATION_JOB}:${key.orgId}:${key.agentId}:${key.threadId}:${key.closeReason}`
}

export async function closeEpisode(
  payload: ConsolidationPayload,
  opts: { delay?: number; replaceDelayed?: boolean } = {},
): Promise<void> {
  await enqueueAppJob(CONSOLIDATION_QUEUE_APP, CONSOLIDATION_JOB, payload, {
    jobId: consolidationJobId(payload),
    ...(opts.delay ? { delay: opts.delay } : {}),
    ...(opts.replaceDelayed ? { replaceDelayed: true } : {}),
  })
}

/**
 * Re-armed on every agent message of a thread, so the delayed job fires six
 * hours after the LAST one (spec-memory.md L5 trigger (a): a thread that "has
 * had no message for 6 hours after agent activity"). Every arm carries the same
 * job id, so the queue holds exactly one job -- but BullMQ DEDUPLICATES an
 * `add` on an existing id rather than replacing it, which pinned the deadline
 * to the FIRST turn of the thread and closed the episode mid-conversation.
 * `replaceDelayed` drops the still-delayed job first so the deadline slides.
 */
export async function armQuietClose(key: Omit<EpisodeCloseKey, "closeReason">): Promise<void> {
  await closeEpisode(
    { ...key, closeReason: "quiet" },
    { delay: EPISODE_QUIET_MS, replaceDelayed: true },
  )
}

// --- Test seams ------------------------------------------------------------
//
// Every seam is GUARDED, the way `AgentServiceTestAccess.setStreamText` is: a seam that
// can be called in production is a way to silence the model-backed half of
// consolidation from anywhere that can reach the module.
//
// The flush and the summarizer are the two model-backed steps, so they are the
// two seams. Production never sets them.

/** The one guard every seam below shares. */
function assertTestEnv(seam: string): void {
  if (!isTestEnv()) throw new Error(`${seam} is only available in tests`)
}

type FlushFn = (region: RegionMessage[]) => Promise<boolean>
let flushOverride: FlushFn | null = null

export type ConsolidationSummarizer = (region: RegionMessage[]) => Promise<string | null>
let summarizerOverride: ConsolidationSummarizer | null = null

export interface FactCandidate {
  /** The slug the file lives at, `<type>/<name>.md`. */
  name: string
  description: string
  body: string
  /** The SPECIFIC messages this fact was drawn from, never the whole region. */
  sourceMessageIds: string[]
  type?: string
}

export type ConsolidationFactExtractor = (region: RegionMessage[]) => Promise<FactCandidate[]>
let factExtractorOverride: ConsolidationFactExtractor | null = null

export interface RegionMessage {
  id: string
  content: string | null
  createdAt: Date
  requiredScopes: string[]
  disclosureList: string[] | null
  authorType: string
  authorId: string | null
}

// --- What memory may be drawn from ------------------------------------------
//
// MEMORY IS WRITTEN ONLY WHEN THE USER ASKS. A topic file exists because a
// person asked the agent to remember something, corrected it, or stated a
// lasting preference about how it works; never to copy what an app already
// holds (contacts, addresses, orders, prices). A prompt asking the model for
// that is not enough: a weak model copied a customer's address and generalised
// one order's price into "the unit price" from a turn's tool results and reply,
// and wrote both after the person had DENIED the agent's own request to save a
// note. The rules below are structural, so no model can get past them:
//
//   - the memory writers (the flush and the fact extractor) are given only the
//     messages a person typed: no agent reply, no system card, so nothing an
//     app returned during the turn is ever in their input;
//   - a window in which a person denied a memory write writes no memory at all;
//   - a candidate is written under the same host rule as the agent's own write
//     (hostRequiresApproval): when the agent would have needed a person's
//     approval, the background job does not write it either.
// Episode files still summarise the whole conversation: they are the record of
// what happened, not the agent's notes about the user.

/** The kernel tools whose approval decides a write to an agent's memory. */
export const MEMORY_WRITE_TOOL_NAMES: readonly string[] = [
  "kernel:user_memory_set",
  "kernel:user_memory_delete",
  "kernel:memory_create",
  "kernel:memory_str_replace",
  "kernel:memory_insert",
  "kernel:memory_delete",
  "kernel:memory_rename",
]

/** The messages a person typed. Agent replies and system messages are not memory sources. */
export function humanAuthoredMessages(region: RegionMessage[]): RegionMessage[] {
  return region.filter((m) => m.authorType === "user")
}

/**
 * Did a person deny a memory write in this thread during this window? Counted
 * from the window's first message, so a request the turn filed and the person
 * turned down after the window's last message still counts. A denial is the
 * person's answer about memory for this stretch of conversation: no topic
 * matching is attempted, because a model can name the same note differently.
 */
export async function windowHasDeniedMemoryWrite(
  orgId: string,
  threadId: string,
  region: RegionMessage[],
): Promise<boolean> {
  const first = region[0]
  if (!first) return false
  return withPrivilegedDb(orgId, "consolidation:denied-memory-write", async (tx) => {
    const [row] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          or(
            eq(approvalRequests.threadId, threadId),
            eq(approvalRequests.originatingThreadId, threadId),
          ),
          inArray(approvalRequests.toolName, [...MEMORY_WRITE_TOOL_NAMES]),
          eq(approvalRequests.status, "denied"),
          gte(approvalRequests.createdAt, first.createdAt),
        ),
      )
      .limit(1)
    return Boolean(row)
  })
}

/**
 * The stretch of conversation this close covers, as THIS agent may read it: a
 * message above the agent's ceiling is not in the region, so nothing built from
 * the region can carry what the agent never read.
 */
export async function resolveRegion(payload: ConsolidationPayload): Promise<RegionMessage[]> {
  const { orgId, agentId, threadId } = payload
  const rows = await withPrivilegedDb(orgId, "consolidation:region", async (tx) => {
    const [agent] = await tx
      .select({ scopeCeiling: agents.scopeCeiling })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .limit(1)
    const ceiling = Array.isArray(agent?.scopeCeiling) ? (agent.scopeCeiling as string[]) : []
    const result = await tx.execute(drizzleSql`
      SELECT id, content, created_at, required_scopes, disclosure_list, author_type, author_id
      FROM ${drizzleSql.raw("kernel")}.messages
      WHERE thread_id = ${threadId} AND org_id = ${orgId} AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC`)
    const all = ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Array<Record<string, unknown>>
    const mapped: RegionMessage[] = all.map((r) => ({
      id: r.id as string,
      content: (r.content as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
      requiredScopes: (r.required_scopes as string[]) ?? [],
      disclosureList: (r.disclosure_list as string[] | null) ?? null,
      authorType: (r.author_type as string) ?? "user",
      authorId: (r.author_id as string | null) ?? null,
    }))
    const visible = mapped.filter((m) =>
      // The agent's CEILING, with no disclosure branch: a disclosure is per
      // reader and memory has no reader to honour it with.
      isMessageVisible(
        { requiredScopes: m.requiredScopes, disclosureList: null },
        { userId: "", grants: ceiling },
      ),
    )
    if (!payload.fromMessageId && !payload.toMessageId) {
      // A CLOSE WITH NO BOUNDS COVERS WHAT IS NEW (spec-memory.md L5). A quiet
      // close and a routine tick close name no region, and answering them with
      // the whole thread meant a routine's eternal output thread was
      // re-summarized on every tick under a region key that never matched the
      // last one. The last flushed message is the boundary: everything after
      // it, and nothing that has already been folded into memory.
      const boundary = await lastFlushedMessageId(tx, orgId, agentId, threadId)
      if (!boundary) return visible
      const idx = visible.findIndex((m) => m.id === boundary)
      if (idx >= 0) return visible.slice(idx + 1)
      // The boundary message was deleted since: fall back to its timestamp, so
      // a deletion cannot re-open a region that was already flushed.
      const at = await tx.execute(
        drizzleSql`SELECT created_at FROM ${K()}.messages WHERE id = ${boundary} AND org_id = ${orgId} LIMIT 1`,
      )
      const atRows = ((at as { rows?: Record<string, unknown>[] }).rows ??
        (at as Record<string, unknown>[])) as Array<{ created_at: string }>
      if (!atRows[0]) return visible
      const cutoff = new Date(atRows[0].created_at)
      return visible.filter((m) => m.createdAt > cutoff)
    }
    const from = payload.fromMessageId
      ? visible.findIndex((m) => m.id === payload.fromMessageId)
      : 0
    const to = payload.toMessageId ? visible.findIndex((m) => m.id === payload.toMessageId) : -1
    return visible.slice(from < 0 ? 0 : from, to < 0 ? undefined : to + 1)
  })
  return rows
}

/**
 * The last message this agent has already flushed for this thread, from the
 * flush markers themselves. The audit log is the ledger: the marker rows are
 * what stop a region being flushed twice, so they are also what says where the
 * next unbounded region starts.
 */
async function lastFlushedMessageId(
  tx: PrivilegedDb,
  orgId: string,
  agentId: string,
  threadId: string,
): Promise<string | null> {
  const result = await tx.execute(drizzleSql`
    SELECT metadata ->> 'toMessageId' AS to_message_id
    FROM ${K()}.audit_log
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND entity_id = ${threadId}
      AND action = ${FLUSH_REGION_ACTION} AND metadata ->> 'toMessageId' IS NOT NULL
    ORDER BY timestamp DESC, id DESC
    LIMIT 1`)
  const rows = ((result as { rows?: Record<string, unknown>[] }).rows ??
    (result as Record<string, unknown>[])) as Array<{ to_message_id: string | null }>
  return rows[0]?.to_message_id ?? null
}

/** `(agentId, threadId, fromMessageId, toMessageId)`, the flush's unit of work. */
export function regionKey(agentId: string, threadId: string, region: RegionMessage[]): string {
  const from = region[0]?.id ?? "none"
  const to = region[region.length - 1]?.id ?? "none"
  return `${agentId}:${threadId}:${from}:${to}`
}

async function regionAlreadyFlushed(orgId: string, key: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "consolidation:flush-marker", (tx) =>
    tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.action, FLUSH_REGION_ACTION),
          drizzleSql`${auditLog.metadata} ->> 'regionKey' = ${key}`,
        ),
      )
      .limit(1),
  )
  return rows.length > 0
}

/**
 * Every write this job makes is an audit row: `actorType: 'system'`, the agent
 * id, and the BullMQ job id, so "what did consolidation change" is one audit
 * search. Written privileged because the job runs as the agent, unfloored, at
 * the agent's ceiling, and has no human RLS session of its own.
 */
export async function recordConsolidationAudit(params: {
  orgId: string
  agentId: string
  threadId: string
  action: string
  jobId?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  await withPrivilegedDb(params.orgId, "consolidation:audit", (tx) =>
    tx.insert(auditLog).values({
      orgId: params.orgId,
      actorId: null,
      actorType: "system",
      agentId: params.agentId,
      app: "kernel",
      entityType: "thread",
      entityId: params.threadId,
      action: params.action,
      metadata: { ...(params.metadata ?? {}), jobId: params.jobId ?? null },
    }),
  )
}

/** Model calls this agent has already made today, from its own usage rows. */
export async function modelCallsToday(orgId: string, agentId: string): Promise<number> {
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)
  const rows = await withPrivilegedDb(orgId, "consolidation:usage-count", (tx) =>
    tx
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.agentId, agentId),
          eq(auditLog.action, CONSOLIDATION_USAGE_ACTION),
          gte(auditLog.timestamp, since),
        ),
      ),
  )
  return rows[0]?.n ?? 0
}

/** Milliseconds until the next UTC day boundary, the deferral's delay. */
function untilNextDay(): number {
  const next = new Date()
  next.setUTCHours(24, 0, 0, 0)
  return Math.max(next.getTime() - Date.now(), 1000)
}

/** The real flush: the region about to be summarized, the memory file verbs. */
async function defaultFlush(
  payload: ConsolidationPayload,
  region: RegionMessage[],
): Promise<boolean> {
  const { orgId, threadId } = payload
  const { preCheck, selectSideCallModelForOrg, settleReservedDemoSideCall } = await import(
    "~/modules/agent/credits/credit-meter"
  )
  // EVERY HOLD THIS PATH TAKES IS CLOSED HERE. A demo visitor's pre check
  // takes a step reservation on the box key; it ends settled at what the
  // flush's steps cost (runMemoryFlush) or, when nothing was sent, released.
  // Before, nothing closed it: each checkpoint advance of a visitor's thread
  // left a hold that expired counted at its full worst cost with no model call
  // behind it (live demo, 2026-10-27: 2 x 28,381 µEUR on one visitor).
  let credit: Parameters<typeof settleReservedDemoSideCall>[1] | null = null
  try {
    const { runMemoryFlush, summaryRequiredScopes } = await import(
      "~/modules/agent/context/compaction"
    )
    // What decides whether anything is sent is read BEFORE the pre check, so a
    // flush that will not run takes no reservation at all.
    const [thread] = await withPrivilegedDb(orgId, "consolidation:flush-thread", async (tx) => {
      const result = await tx.execute(
        drizzleSql`SELECT tainted FROM ${K()}.threads WHERE id = ${threadId} LIMIT 1`,
      )
      return ((result as { rows?: Record<string, unknown>[] }).rows ??
        (result as Record<string, unknown>[])) as Array<{ tainted: boolean }>
    })
    if (thread?.tainted) return false
    const owner = await withPrivilegedDb(orgId, "consolidation:flush-owner", async (tx) => {
      const [row] = await tx
        .select({ id: agents.id, ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(eq(agents.id, payload.agentId))
        .limit(1)
      return row ?? null
    })
    // AN AGENT WITH NO OWNING HUMAN STILL FLUSHES. A role or system agent has
    // no `owner_user_id`, and requiring one meant its regions were marked
    // flushed and never written: the marker advanced, the memory did not. It
    // runs as a system actor instead, writing the AGENT's rows (0057 admits a
    // role tree's write on scope, not on a user id). The tags are untouched by
    // that: they are still the union of the region's own message scopes.
    if (!owner) return false
    const cheapModel = await selectSideCallModelForOrg(orgId, "consolidation:flush-model")
    if (!cheapModel) return false
    const creditCheck = await preCheck(orgId, cheapModel.modelId)
    if (!creditCheck.allowed) return false
    credit = creditCheck
    const model = await (
      await import("~/modules/agent/providers/side-call-model")
    ).resolveSideCallModel(creditCheck)
    const actor: ActorContext = owner.ownerUserId
      ? {
          actorType: "user",
          userId: owner.ownerUserId,
          orgId,
          scopes: ["*"],
          dimensionGrants: {},
        }
      : { actorType: "system", orgId, purpose: "job", scopes: ["*"] }
    return await runMemoryFlush({
      orgId,
      actor,
      ownerAgentId: payload.agentId,
      ownerLegacyUserId: owner.ownerUserId ?? null,
      model,
      tainted: false,
      messages: region.map((m) => ({
        role: m.authorType === "user" ? "user" : "assistant",
        content: m.content ?? "",
      })),
      inputBudgetTokens: Math.floor(creditCheck.model.contextWindow * 0.5),
      requiredScopes: summaryRequiredScopes(region, orgId),
      credit: {
        model: creditCheck.model,
        keySource: creditCheck.keySource,
        ...(creditCheck.demo ? { demo: creditCheck.demo } : {}),
      },
    })
  } catch (err) {
    log.error({ err, threadId }, "Consolidation flush could not run")
    return false
  } finally {
    // Idempotent once the flush settled its meter; otherwise a sent request
    // with no usage stays at its max, an unsent one is released, and the
    // reserved org's turn reservation is handed back.
    if (credit) await settleReservedDemoSideCall(orgId, credit, null)
  }
}

/**
 * Flush one region exactly once, whichever close cause got there first. Shared
 * with the checkpoint advance (P4m-T17), whose region is one region among
 * several rather than a special case.
 */
export async function flushRegion(
  payload: ConsolidationPayload,
  region: RegionMessage[],
): Promise<{ flushed: boolean; alreadyFlushed: boolean }> {
  const key = regionKey(payload.agentId, payload.threadId, region)
  if (await regionAlreadyFlushed(payload.orgId, key)) {
    return { flushed: false, alreadyFlushed: true }
  }
  // The marker still covers the whole region; what the flush may READ is what a
  // person typed in it, and nothing at all once a person denied a memory write.
  const source = humanAuthoredMessages(region)
  const mayWrite =
    source.length > 0 &&
    !(await windowHasDeniedMemoryWrite(payload.orgId, payload.threadId, region))
  const flushed = !mayWrite
    ? false
    : flushOverride
      ? await flushOverride(source)
      : await defaultFlush(payload, source)
  await recordConsolidationAudit({
    orgId: payload.orgId,
    agentId: payload.agentId,
    threadId: payload.threadId,
    action: FLUSH_REGION_ACTION,
    ...(payload.jobId ? { jobId: payload.jobId } : {}),
    metadata: {
      regionKey: key,
      closeReason: payload.closeReason,
      fromMessageId: region[0]?.id ?? null,
      toMessageId: region[region.length - 1]?.id ?? null,
      messageCount: region.length,
      flushed,
    },
  })
  return { flushed, alreadyFlushed: false }
}

export interface ConsolidationResult {
  deferred: boolean
  flushed: boolean
  regionSize: number
  episodePath?: string | null
  factsWritten?: number
}

export async function runConsolidation(
  payload: ConsolidationPayload,
): Promise<ConsolidationResult> {
  // The reserved App Review demo org does not consolidate memory. Its three
  // model calls (flush, episode, facts) resolve the deployment's key outside a
  // turn and are never finalized, so they would be spend its daily token
  // ceiling cannot see; the reviewer's session is short and loses nothing it
  // would notice. No query on a normal deployment.
  // A demo VISITOR org is skipped the same way: these calls take no step
  // reservation, and without one the box key is not reachable for it.
  const { demoOrgKind } = await import("~/modules/demo/demo-spend")
  if ((await demoOrgKind(payload.orgId)) !== "none") {
    return { deferred: false, flushed: false, regionSize: 0 }
  }

  // THE CAP IS CHECKED BEFORE ANY MODEL CALL and past it the job is
  // re-enqueued for the next day boundary. Deferring is the whole point: a
  // silent skip loses the region for good, since nothing re-closes an episode
  // that already closed.
  const used = await modelCallsToday(payload.orgId, payload.agentId)
  if (used >= CONSOLIDATION_DAILY_MODEL_CALL_CAP) {
    log.warn(
      {
        orgId: payload.orgId,
        agentId: payload.agentId,
        used,
        cap: CONSOLIDATION_DAILY_MODEL_CALL_CAP,
      },
      "memory_consolidation_deferred",
    )
    await closeEpisode(payload, { delay: untilNextDay() })
    return { deferred: true, flushed: false, regionSize: 0 }
  }

  // A STALE EPISODE IS REBUILT WHATEVER THIS CLOSE COVERS. It is an artefact of
  // an OLDER region (a message inside it was deleted), so it has nothing to do
  // with the stretch this close is about, and a close whose own region is empty
  // is exactly when a deletion-triggered run arrives.
  await rebuildStaleEpisodes(payload)

  const region = await resolveRegion(payload)
  if (region.length === 0) return { deferred: false, flushed: false, regionSize: 0 }

  // Step 1, on every close path.
  const { flushed } = await flushRegion(payload, region)
  // Step 2: the episode file for the region, disclosure carrying messages
  // excluded (spec-memory.md L5 step 2).
  const episode = await writeEpisodeForRegion(payload, region)
  // Step 3: candidate topic files, each tagged with the scopes of ITS OWN
  // source messages, deduplicated and resolved as supersessions.
  const facts = await extractFacts(payload, region)
  // Steps 4 and 5: merge, rewrite dates, drop the long dead, rebuild the index.
  await consolidateFiles(payload)
  return {
    deferred: false,
    flushed,
    regionSize: region.length,
    episodePath: episode?.path ?? null,
    factsWritten: facts,
  }
}

// --- Step 3: facts, fine grained scopes, dedupe and supersession (T27) -----

/**
 * Two descriptions this similar are the same memory said twice. Trigram,
 * because Postgres ships it (`similarity()` from `pg_trgm`) and because it
 * needs no model call: freshness is decided at WRITE time by serial order,
 * never by the model answering a later question.
 */
export const DESCRIPTION_SIMILARITY_THRESHOLD = 0.8

/** What a region line is cut to when one message alone would not fit. */
const FACT_LINE_CLIPPED_MARKER = " [message clipped for length]"

/**
 * THE FACT EXTRACTOR'S INPUT, BOUNDED. A region is every message since the last
 * close, which on a busy routine thread is far more than any model window, and
 * the extractor used to send it whole: the provider refused it past its own
 * input ceiling and the region produced no facts at all. The most recent lines
 * are kept (the newest state of a decision is the one worth a fact), and a
 * single message larger than the whole budget is clipped rather than sent.
 * Each kept line still carries its message id, which the candidates cite.
 */
export function factExtractionInput(region: RegionMessage[], budgetTokens: number): string {
  const budgetChars = Math.max(0, budgetTokens) * 4
  const kept: string[] = []
  let used = 0
  for (let i = region.length - 1; i >= 0; i--) {
    const m = region[i]
    let line = `${m.id} ${m.authorType}: ${m.content ?? ""}`
    const room = budgetChars - used - (kept.length > 0 ? 1 : 0)
    if (line.length > room) {
      // Only the newest line is ever clipped: an older one that does not fit
      // ends the walk, so the kept stretch stays contiguous.
      if (kept.length > 0 || room <= FACT_LINE_CLIPPED_MARKER.length) break
      line = line.slice(0, room - FACT_LINE_CLIPPED_MARKER.length) + FACT_LINE_CLIPPED_MARKER
    }
    kept.push(line)
    used += line.length + (kept.length > 1 ? 1 : 0)
  }
  return kept.reverse().join("\n")
}

/**
 * The extractor's answer as candidates. Models asked for a JSON array often
 * wrap it in a Markdown code fence; that is the same answer, not an unusable
 * one, so the fence is stripped before parsing.
 */
export function parseFactCandidates(text: string): FactCandidate[] {
  return normalizeFactCandidates(parseFactArray(text))
}

/** The extractor's JSON array as the model wrote it, before any shape check. */
function parseFactArray(text: string): unknown[] {
  let body = text.trim()
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(body)
  if (fenced) body = fenced[1].trim()
  const parsed = JSON.parse(body) as unknown
  return Array.isArray(parsed) ? parsed : []
}

/** Postgres text cannot hold a NUL byte: a string carrying one is refused whole. */
function withoutNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value
}

/**
 * THE EXTRACTOR'S ANSWER IS MODEL OUTPUT, NOT A TYPED VALUE. Each candidate
 * reaches the dedupe query as bound parameters, so a field of the wrong shape
 * failed the query and with it the whole job, on every retry, and the well
 * formed facts beside it were never written: a boolean description bound as a
 * boolean (`similarity(text, boolean)` does not exist), a NUL byte is refused by
 * Postgres, a missing field took its placeholder out of the SQL. Which shapes
 * arrive depends on the model an instance runs. A candidate without a usable
 * name, description and body is dropped; a missing source list is the empty
 * one, which `scopesForCandidate` already answers fail closed.
 */
export function normalizeFactCandidates(raw: unknown): FactCandidate[] {
  if (!Array.isArray(raw)) return []
  const candidates: FactCandidate[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const c = item as Record<string, unknown>
    if (typeof c.name !== "string" || typeof c.description !== "string") continue
    if (typeof c.body !== "string") continue
    const name = withoutNul(c.name).trim()
    const description = withoutNul(c.description).trim()
    const body = withoutNul(c.body)
    if (name === "" || description === "" || body.trim() === "") continue
    const sourceMessageIds = Array.isArray(c.sourceMessageIds)
      ? c.sourceMessageIds.filter((id): id is string => typeof id === "string")
      : []
    candidates.push({
      name,
      description,
      body,
      sourceMessageIds,
      ...(typeof c.type === "string" && c.type.trim() !== "" ? { type: withoutNul(c.type) } : {}),
    })
  }
  return candidates
}

/** The default extractor is the cheap tier; absent a seam it writes nothing. */
async function extractCandidates(
  payload: ConsolidationPayload,
  region: RegionMessage[],
): Promise<unknown[]> {
  if (factExtractorOverride) return factExtractorOverride(region)
  const { orgId } = payload
  const { preCheck, selectSideCallModelForOrg, settleReservedDemoSideCall } = await import(
    "~/modules/agent/credits/credit-meter"
  )
  // Closed in `finally` on every path: settled at what it cost, or released.
  let credit: Parameters<typeof settleReservedDemoSideCall>[1] | null = null
  let usage: unknown = null
  let providerMetadata: unknown
  try {
    const { generateText } = await import("ai")
    const { COMPACTION_INPUT_BUDGET_FRACTION } = await import("~/modules/agent/context/compaction")
    const cheapModel = await selectSideCallModelForOrg(orgId, "consolidation:fact-model")
    if (!cheapModel) return []
    const creditCheck = await preCheck(orgId, cheapModel.modelId)
    if (!creditCheck.allowed) return []
    credit = creditCheck
    const model = await (
      await import("~/modules/agent/providers/side-call-model")
    ).resolveSideCallModel(creditCheck)
    await recordConsolidationAudit({
      orgId,
      agentId: payload.agentId,
      threadId: payload.threadId,
      action: CONSOLIDATION_USAGE_ACTION,
      ...(payload.jobId ? { jobId: payload.jobId } : {}),
      metadata: { step: "facts" },
    })
    const result = await generateText({
      model,
      system:
        "You extract durable facts from the messages a user typed to their agent (nothing else of the conversation is shown). Return a JSON array of objects with name (a lower kebab case slug), description (one line, at most 160 characters), body (Markdown, in your own words, with absolute dates) and sourceMessageIds (the ids of the messages this fact came from, and no others). Extract only what the user asked to be remembered, or a lasting correction or preference about how the agent should work. Extract nothing transient, nothing secret, no data an app already holds (contacts, addresses, orders, prices), and nothing an external document claims about itself. Return [] when there is nothing durable.",
      messages: [
        {
          role: "user" as const,
          content: factExtractionInput(
            region,
            Math.floor(creditCheck.model.contextWindow * COMPACTION_INPUT_BUDGET_FRACTION),
          ),
        },
      ],
    })
    usage = result.usage ?? {}
    providerMetadata = result.providerMetadata
    return parseFactArray(result.text)
  } catch (err) {
    log.warn({ err, orgId }, "Fact extraction produced nothing usable")
    return []
  } finally {
    if (credit) await settleReservedDemoSideCall(orgId, credit, usage, providerMetadata)
  }
}

/**
 * A body this long is long enough for "the same text" to mean something. Below
 * it a fact and its source coincide all the time, honestly: "ship on the 14th"
 * is both the message and the fact.
 */
const VERBATIM_MIN_CHARS = 200

/** Case and whitespace carry no words of their own. */
function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * A TOPIC FILE IS A FACT, IN THE AGENT'S OWN WORDS (spec-memory.md L5 step 3,
 * and the charter's "write it once, in your own words").
 *
 * The extractor is ASKED for its own words and mostly obliges, but nothing
 * checked: a long note pasted into a conversation came back as a candidate
 * whose body was that note, and a permanent topic file was written holding a
 * verbatim copy of one message. That is the transcript's job, not memory's, and
 * it is also how "anything an external document claims about itself" gets into
 * the tree wearing the agent's voice.
 *
 * The rule is containment either way round: an excerpt of a source message, or
 * a body that wrapped a source message whole.
 */
export function isVerbatimOfSource(candidate: FactCandidate, region: RegionMessage[]): boolean {
  const body = normalizeForComparison(candidate.body ?? "")
  if (body.length < VERBATIM_MIN_CHARS) return false
  const byId = new Map(region.map((m) => [m.id, m]))
  const named = candidate.sourceMessageIds
    .map((id) => byId.get(id))
    .filter((m): m is RegionMessage => Boolean(m))
  // A candidate that names no source is judged against the whole region: it is
  // the same claim about the same text, made less precisely.
  const pool = named.length > 0 ? named : region
  for (const message of pool) {
    const source = normalizeForComparison(message.content ?? "")
    if (source.length < VERBATIM_MIN_CHARS) continue
    if (source.includes(body) || body.includes(source)) return true
  }
  return false
}

/**
 * The scopes of the SPECIFIC messages a candidate came from, never the
 * episode's union: a low scope fact drawn from a mixed conversation stays
 * reachable in a low scope room while the episode summary stays hidden. A
 * candidate naming no message it can be matched to gets the union, which is the
 * fail closed answer.
 */
export function scopesForCandidate(candidate: FactCandidate, region: RegionMessage[]): string[] {
  const byId = new Map(region.map((m) => [m.id, m]))
  const sources = candidate.sourceMessageIds.map((id) => byId.get(id)).filter(Boolean)
  const from = sources.length > 0 ? (sources as RegionMessage[]) : region
  return [...new Set(from.flatMap((m) => m.requiredScopes))].sort()
}

async function extractFacts(
  payload: ConsolidationPayload,
  region: RegionMessage[],
): Promise<number> {
  // A disclosure carrying message is excluded from a FACT for the same reason
  // it is excluded from an episode: memory has no reader snapshot to honour it.
  // And a fact is drawn only from what a person typed (see "What memory may be
  // drawn from" above): an agent reply quoting a tool result is not a source.
  const eligible = humanAuthoredMessages(withoutDisclosedMessages(region))
  if (eligible.length === 0) return 0
  // A person said no to a memory write in this window: nothing is extracted.
  if (await windowHasDeniedMemoryWrite(payload.orgId, payload.threadId, region)) {
    log.info(
      { orgId: payload.orgId, agentId: payload.agentId, threadId: payload.threadId },
      "memory_fact_extraction_skipped_denied",
    )
    return 0
  }
  // THE SAME RULE AS THE AGENT'S OWN WRITE. A memory write the agent would have
  // had to wait on a person for (the turn read outside text) is not written by
  // the background job either: it would be the approval bypassed.
  const { hostRequiresApproval } = await import("~/modules/agent/scopes/host-approval-gates")
  const { SINK_KERNEL_AGENT_MEMORY } = await import("~/modules/agent/scopes/scope-taint")
  if (
    await hostRequiresApproval({
      toolName: "kernel:memory_create",
      params: {},
      orgId: payload.orgId,
      threadId: payload.threadId,
      writesToTable: SINK_KERNEL_AGENT_MEMORY,
    })
  ) {
    log.info(
      { orgId: payload.orgId, agentId: payload.agentId, threadId: payload.threadId },
      "memory_fact_extraction_skipped_needs_approval",
    )
    return 0
  }
  const raw = await extractCandidates(payload, eligible)
  const extracted = normalizeFactCandidates(raw)
  if (extracted.length < raw.length) {
    log.warn(
      {
        orgId: payload.orgId,
        agentId: payload.agentId,
        dropped: raw.length - extracted.length,
      },
      "memory_fact_malformed_dropped",
    )
  }
  // A candidate citing an agent reply or a system message of this window claims
  // a source the extractor was never given: it is dropped, never written.
  const notTyped = new Set(region.filter((m) => m.authorType !== "user").map((m) => m.id))
  const cited = extracted.filter((c) => !c.sourceMessageIds.some((id) => notTyped.has(id)))
  if (cited.length < extracted.length) {
    log.warn(
      {
        orgId: payload.orgId,
        agentId: payload.agentId,
        dropped: extracted.length - cited.length,
      },
      "memory_fact_foreign_source_dropped",
    )
  }
  // A candidate that is a copy of one of its own sources is not a fact.
  const candidates = cited.filter((candidate) => !isVerbatimOfSource(candidate, eligible))
  for (const dropped of cited.filter((c) => isVerbatimOfSource(c, eligible))) {
    log.warn(
      { orgId: payload.orgId, agentId: payload.agentId, name: dropped.name },
      "memory_fact_verbatim_dropped",
    )
  }
  if (candidates.length === 0) return 0

  const { orgId, agentId, threadId } = payload
  const ownerUserId = await withPrivilegedDb(orgId, "consolidation:fact-owner", async (tx) => {
    const [row] = await tx
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .limit(1)
    return row?.ownerUserId ?? null
  })

  let written = 0
  for (const candidate of candidates) {
    const requiredScopes = scopesForCandidate(candidate, eligible)
    const type = candidate.type ?? "user"
    const sourceMessageId = candidate.sourceMessageIds[0] ?? null
    const landed = await withPrivilegedDb(orgId, "consolidation:fact-write", async (tx) => {
      // The row this candidate REPLACES, if any: the same name first, then a
      // description similar enough to be the same memory said twice. Only
      // CURRENT rows are candidates, so a chain never forks.
      const result = await tx.execute(drizzleSql`
        SELECT id, name FROM ${K()}.agent_memory
        WHERE org_id = ${orgId} AND owner_agent_id = ${agentId}
          AND type NOT IN ('episode', '_index')
          AND superseded_at IS NULL
          AND (name = ${candidate.name}
               OR similarity(description, ${candidate.description}::text) >= ${DESCRIPTION_SIMILARITY_THRESHOLD}::real)
        ORDER BY (name = ${candidate.name}) DESC,
                 similarity(description, ${candidate.description}::text) DESC
        LIMIT 1`)
      const rows = ((result as { rows?: Record<string, unknown>[] }).rows ??
        (result as Record<string, unknown>[])) as Array<{ id: string; name: string }>
      const prior = rows[0] ?? null

      // A match becomes an UPDATE expressed as a supersession, never a delete:
      // the old row keeps its body and gains `superseded_at`, and the new row
      // points back at it. Every read path but the history view and
      // `includeSuperseded` stops seeing the old one.
      const name = prior ? prior.name : candidate.name
      const path = `${type}/${name}.md`
      if (prior) {
        await tx.execute(drizzleSql`
          UPDATE ${K()}.agent_memory SET superseded_at = now(),
                 name = ${`${name}-${Date.now()}`}, path = NULL
          WHERE id = ${prior.id}`)
      }
      // The query builder, not raw SQL: a text[] parameter interpolated into a
      // raw template binds one placeholder per element and Postgres rejects it.
      await tx.insert(agentMemoryTable).values({
        orgId,
        userId: ownerUserId,
        ownerAgentId: agentId,
        type,
        name,
        description: candidate.description.slice(0, 160),
        content: candidate.body,
        path,
        requiredScopes,
        sourceKind: "consolidation",
        sourceThreadId: threadId,
        sourceMessageId,
        supersedesId: prior?.id ?? null,
        lastConfirmedAt: new Date(),
      })
      return true
    })
    if (landed) {
      written++
      await recordConsolidationAudit({
        orgId,
        agentId,
        threadId,
        action: "memory_fact_written",
        ...(payload.jobId ? { jobId: payload.jobId } : {}),
        metadata: { name: candidate.name, requiredScopes },
      })
    }
  }
  return written
}

// --- Step 2: the episode file (P4m-T26) ------------------------------------

/**
 * A message carrying a disclosure list is summarized ONLY into that thread's
 * checkpoint, never into an episode or a fact: a disclosure is per message and
 * per reader, and memory has no reader snapshot to honour it with. A file that
 * quoted one would be readable by everyone the file is readable by, which is
 * precisely what the Share anyway mechanism refused.
 */
export function withoutDisclosedMessages(region: RegionMessage[]): RegionMessage[] {
  return region.filter((m) => !Array.isArray(m.disclosureList) || m.disclosureList.length === 0)
}

/**
 * The episode body: participants, what was asked, decisions, open items, next
 * steps, entities with ids. The cheap tier, and every call records itself as a
 * `memory_consolidation` usage row, which is what the 200 a day cap counts.
 */
async function summarizeRegion(
  payload: ConsolidationPayload,
  region: RegionMessage[],
): Promise<string | null> {
  if (summarizerOverride) return summarizerOverride(region)
  const { orgId } = payload
  const { preCheck, selectSideCallModelForOrg, settleReservedDemoSideCall } = await import(
    "~/modules/agent/credits/credit-meter"
  )
  // Closed in `finally` on every path: settled at what it cost, or released.
  let credit: Parameters<typeof settleReservedDemoSideCall>[1] | null = null
  let usage: unknown = null
  let providerMetadata: unknown
  try {
    const { generateText } = await import("ai")
    const { fitMessagesToBudget, COMPACTION_INPUT_BUDGET_FRACTION } = await import(
      "~/modules/agent/context/compaction"
    )
    const cheapModel = await selectSideCallModelForOrg(orgId, "consolidation:auto-model")
    if (!cheapModel) return null
    const creditCheck = await preCheck(orgId, cheapModel.modelId)
    if (!creditCheck.allowed) return null
    credit = creditCheck
    const model = await (
      await import("~/modules/agent/providers/side-call-model")
    ).resolveSideCallModel(creditCheck)
    const { messages: fitted } = fitMessagesToBudget(
      region.map((m) => ({
        role: m.authorType === "user" ? ("user" as const) : ("assistant" as const),
        content: m.content ?? "",
      })),
      Math.floor(creditCheck.model.contextWindow * COMPACTION_INPUT_BUDGET_FRACTION),
    )
    // Recorded BEFORE the call, so a crashed call still counts against the cap
    // rather than letting a retry loop spend without limit.
    await recordConsolidationAudit({
      orgId,
      agentId: payload.agentId,
      threadId: payload.threadId,
      action: CONSOLIDATION_USAGE_ACTION,
      ...(payload.jobId ? { jobId: payload.jobId } : {}),
      metadata: { step: "episode" },
    })
    const result = await generateText({
      model,
      system:
        "You summarize one stretch of a conversation into a durable record. Write short sections: participants, what was asked, decisions, open items, next steps, entities with their ids. State dates as absolute calendar dates. Write nothing you were not told.",
      messages: [
        {
          role: "user" as const,
          content: fitted
            .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`)
            .join("\n\n"),
        },
      ],
    })
    usage = result.usage ?? {}
    providerMetadata = result.providerMetadata
    return result.text
  } catch (err) {
    log.error({ err, orgId }, "Episode summarization failed, no episode written")
    return null
  } finally {
    if (credit) await settleReservedDemoSideCall(orgId, credit, usage, providerMetadata)
  }
}

interface EpisodeWriteResult {
  path: string
}

async function writeEpisodeForRegion(
  payload: ConsolidationPayload,
  region: RegionMessage[],
): Promise<EpisodeWriteResult | null> {
  const summarised = withoutDisclosedMessages(region)
  if (summarised.length === 0) return null

  const body = await summarizeRegion(payload, summarised)
  if (!body) return null

  const { orgId, agentId, threadId } = payload
  const context = await withPrivilegedDb(orgId, "consolidation:episode-context", async (tx) => {
    const [agent] = await tx
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .limit(1)
    const result = await tx.execute(
      drizzleSql`SELECT handle FROM ${K()}.threads WHERE id = ${threadId} AND org_id = ${orgId} LIMIT 1`,
    )
    const rows = ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Array<{ handle: string }>
    return { ownerUserId: agent?.ownerUserId ?? null, threadHandle: rows[0]?.handle ?? null }
  })
  // A ROLE AGENT HAS NO OWNING HUMAN. The tree is keyed on `owner_agent_id`
  // and `agent_memory.user_id` has been nullable since the rekey, so the owner
  // is provenance, not a key: refusing to write without one made consolidation
  // a silent no-op for every role agent in the org.
  if (!context.threadHandle) return null

  const { summaryRequiredScopes } = await import("~/modules/agent/context/compaction")
  const requiredScopes = summaryRequiredScopes(summarised, orgId)
  const closedOn = new Date().toISOString().slice(0, 10)
  const from = summarised[0].id
  const to = summarised[summarised.length - 1].id

  return await withPrivilegedDb(orgId, "consolidation:episode-write", async (tx) => {
    const ctx = {
      userId: context.ownerUserId ?? "",
      orgId,
      db: tx,
      // The job runs AS THE AGENT, unfloored, at the agent's ceiling (D16), and
      // the region was already narrowed to that ceiling.
      scopes: ["*"],
      sourceKind: "consolidation" as const,
      // THE TREE IS THE AGENT'S, whoever (if anyone) owns the agent. Without
      // this the write resolved the CALLER's personal agent, which for a role
      // agent is nobody at all.
      ownerAgentId: agentId,
      ownerLegacyUserId: context.ownerUserId,
    } as never

    const { writeEpisode } = await import("~/modules/agent/memory/memory")
    const written = await writeEpisode(
      {
        threadId,
        threadHandle: context.threadHandle,
        closedOn,
        description: `Conversation in ${context.threadHandle} on ${closedOn}`,
        body,
        fromMessageId: from,
        toMessageId: to,
      },
      ctx,
      requiredScopes,
    )
    await recordConsolidationAudit({
      orgId,
      agentId,
      threadId,
      action: "memory_episode_written",
      ...(payload.jobId ? { jobId: payload.jobId } : {}),
      metadata: { path: written.path, messageCount: summarised.length, requiredScopes },
    })
    return written
  })
}

/**
 * Rebuild every STALE episode of this (agent, thread), each one from ITS OWN
 * recorded range. Re-summarizing the CURRENT region into them instead put this
 * close's conversation into an older episode's file and left the close's own
 * region with no episode at all, which is two files wrong for one deletion.
 * The stale flag clears with the new body; an episode whose whole range is gone
 * keeps its row and loses its flag, since there is nothing left to summarize.
 */
async function rebuildStaleEpisodes(payload: ConsolidationPayload): Promise<number> {
  const { orgId, agentId, threadId } = payload
  const stale = await withPrivilegedDb(orgId, "consolidation:stale-episodes", (tx) =>
    tx
      .select({
        id: agentMemoryTable.id,
        from: agentMemoryTable.episodeFromMessageId,
        to: agentMemoryTable.episodeToMessageId,
      })
      .from(agentMemoryTable)
      .where(
        and(
          eq(agentMemoryTable.orgId, orgId),
          eq(agentMemoryTable.type, "episode"),
          eq(agentMemoryTable.ownerAgentId, agentId),
          eq(agentMemoryTable.sourceThreadId, threadId),
          drizzleSql`${agentMemoryTable.staleAt} IS NOT NULL`,
        ),
      ),
  )
  if (stale.length === 0) return 0

  const { summaryRequiredScopes } = await import("~/modules/agent/context/compaction")
  let rebuilt = 0
  for (const row of stale) {
    const region = withoutDisclosedMessages(
      await resolveRegion({
        ...payload,
        ...(row.from ? { fromMessageId: row.from } : {}),
        ...(row.to ? { toMessageId: row.to } : {}),
      }),
    )
    const body = region.length > 0 ? await summarizeRegion(payload, region) : ""
    await withPrivilegedDb(orgId, "consolidation:stale-episode-rebuild", (tx) =>
      tx
        .update(agentMemoryTable)
        .set({
          ...(body ? { content: body } : {}),
          ...(region.length > 0
            ? {
                requiredScopes: summaryRequiredScopes(region, orgId),
                episodeFromMessageId: region[0].id,
                episodeToMessageId: region[region.length - 1].id,
              }
            : {}),
          staleAt: null,
          lastConfirmedAt: new Date(),
        })
        .where(eq(agentMemoryTable.id, row.id)),
    )
    if (body) rebuilt++
  }
  await recordConsolidationAudit({
    orgId,
    agentId,
    threadId,
    action: "memory_episode_rebuilt",
    ...(payload.jobId ? { jobId: payload.jobId } : {}),
    metadata: { rebuilt, stale: stale.length },
  })
  return rebuilt
}

/** Registered from kernel-jobs beside the other kernel workers. */
export function registerConsolidationWorker(): void {
  registerJobWorker(
    CONSOLIDATION_QUEUE_APP,
    CONSOLIDATION_JOB,
    async (payload: ConsolidationPayload) => {
      await runConsolidation(payload)
    },
    // The job holds a long background transaction of its own per step, so it
    // takes the `session` mode and the jobs pool rather than one ambient
    // transaction around the whole run.
    { txMode: "session" },
  )
}

// --- Steps 4 and 5: file consolidation and index upkeep (P4m-T28) ---------

/** The rebuilt index lands UNDER this, rather than relying on T09's refusal. */
export const MEMORY_INDEX_REBUILD_MAX_LINES = 200

/** A file superseded longer ago than this and never recalled is dropped. */
export const SUPERSEDED_DROP_DAYS = 90
/** A file not recalled in this long keeps its file and loses its index line. */
export const INDEX_DEMOTE_DAYS = 90
/** The promotion window: recalled in three distinct threads inside it. */
export const INDEX_PROMOTE_DAYS = 14
export const INDEX_PROMOTE_THREADS = 3

const DAY_MS = 86_400_000
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const MONTH_STEMS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Rewrite the relative dates on a CLOSED, FIXED list to absolute ones, anchored
 * on the moment the text described rather than on `now()`: a re-run of
 * consolidation must produce the same answer, which anchoring on the clock
 * would not. Anything off the list is left VERBATIM: no heuristic parsing and
 * no model call, so an unmatched phrase is a no-op rather than a wrong rewrite.
 */
export function rewriteRelativeDates(text: string, anchor: Date): string {
  const at = new Date(anchor.getTime())
  const shift = (days: number) => isoDay(new Date(at.getTime() + days * DAY_MS))

  let out = text
  out = out.replace(/\byesterday\b/gi, () => shift(-1))
  out = out.replace(/\btoday\b/gi, () => shift(0))
  out = out.replace(/\btomorrow\b/gi, () => shift(1))

  // Only "last <weekday>" and "next <weekday>" say which way to go. A bare weekday is past or
  // future ("prepare one on Thursday" is the coming one, "we spoke on Monday" the last one), so
  // it is left verbatim, like every other phrase this list cannot resolve for sure. A weekday
  // that already carries its date ("next Thursday 5 November") is absolute and stays as written.
  const weekdayRe = new RegExp(
    `\\b(last|next) (${WEEKDAYS.join("|")})\\b(?!,?\\s+(?:\\d|(?:${MONTH_STEMS.join("|")})[a-z]*\\b))`,
    "gi",
  )
  out = out.replace(weekdayRe, (_m, lead: string, day: string) => {
    const target = WEEKDAYS.indexOf(day.toLowerCase())
    const current = at.getUTCDay()
    let delta = target - current
    if (lead.toLowerCase() === "last") delta = delta >= 0 ? delta - 7 : delta
    else delta = delta <= 0 ? delta + 7 : delta
    return shift(delta)
  })

  out = out.replace(
    /\b(last|next) (week|month|quarter|year)\b/gi,
    (_m, dir: string, unit: string) => {
      const sign = dir.toLowerCase() === "last" ? -1 : 1
      const d = new Date(at.getTime())
      if (unit.toLowerCase() === "week") return shift(sign * 7)
      if (unit.toLowerCase() === "month") {
        d.setUTCMonth(d.getUTCMonth() + sign)
        return d.toISOString().slice(0, 7)
      }
      if (unit.toLowerCase() === "quarter") {
        d.setUTCMonth(d.getUTCMonth() + sign * 3)
        return d.toISOString().slice(0, 7)
      }
      d.setUTCFullYear(d.getUTCFullYear() + sign)
      return String(d.getUTCFullYear())
    },
  )
  return out
}

interface UpkeepRow {
  id: string
  type: string
  name: string
  path: string | null
  description: string
  content: string
  requiredScopes: string[]
  sourceKind: string
  recallCount: number
  lastRecalledAt: Date | null
  lastConfirmedAt: Date | null
  supersededAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Distinct threads each memory row was recalled in over the promotion window,
 * read from the recall ledger `memory_search` writes. The ledger is one audit
 * row per search, not one per hit, so it stays cheap and it is durable, which a
 * counter column on the row could not be (it would say how MANY, never how many
 * DIFFERENT rooms).
 */
async function recallThreadsByMemory(
  orgId: string,
  agentId: string,
): Promise<Map<string, Set<string>>> {
  const since = new Date(Date.now() - INDEX_PROMOTE_DAYS * DAY_MS)
  const rows = await withPrivilegedDb(orgId, "consolidation:recall-ledger", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT metadata FROM ${K()}.audit_log
      WHERE org_id = ${orgId} AND agent_id = ${agentId}
        AND action = 'memory_recalled' AND timestamp >= ${since.toISOString()}`)
    return ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Array<{ metadata: Record<string, unknown> }>
  })
  const byMemory = new Map<string, Set<string>>()
  for (const row of rows) {
    const meta = row.metadata ?? {}
    const threadId = typeof meta.threadId === "string" ? meta.threadId : null
    const ids = Array.isArray(meta.memoryIds) ? (meta.memoryIds as string[]) : []
    if (!threadId) continue
    for (const id of ids) {
      if (!byMemory.has(id)) byMemory.set(id, new Set())
      byMemory.get(id)?.add(threadId)
    }
  }
  return byMemory
}

/**
 * Steps 4 and 5 of L5: merge near duplicates, rewrite relative dates, drop the
 * long superseded and never recalled, then rebuild `MEMORY.md` under its cap
 * with the promotion and demotion rules that keep it small WITHOUT deleting a
 * file. A demoted file keeps its body and stays reachable through
 * `memory_search` and `memory_view`; only its index line goes.
 */
export async function consolidateFiles(payload: ConsolidationPayload): Promise<void> {
  const { orgId, agentId, threadId } = payload
  const anchorDate = await resolveAnchorDate(payload)
  const recalls = await recallThreadsByMemory(orgId, agentId)

  await withPrivilegedDb(orgId, "consolidation:file-upkeep", async (tx) => {
    const rows = (await tx
      .select()
      .from(agentMemoryTable)
      .where(
        and(eq(agentMemoryTable.orgId, orgId), eq(agentMemoryTable.ownerAgentId, agentId)),
      )) as unknown as UpkeepRow[]

    const now = Date.now()
    const index = rows.find((r) => r.type === "_index")
    const files = rows.filter((r) => r.type !== "_index")

    // (a) DROP: superseded longer than 90 days AND never recalled. NEVER a file
    // a human wrote, whatever else it meets.
    for (const row of files) {
      const droppable =
        row.sourceKind !== "human" &&
        row.supersededAt !== null &&
        now - new Date(row.supersededAt).getTime() > SUPERSEDED_DROP_DAYS * DAY_MS &&
        row.recallCount === 0
      if (droppable) {
        await tx.delete(agentMemoryTable).where(eq(agentMemoryTable.id, row.id))
      }
    }
    const surviving = files.filter(
      (row) =>
        !(
          row.sourceKind !== "human" &&
          row.supersededAt !== null &&
          now - new Date(row.supersededAt).getTime() > SUPERSEDED_DROP_DAYS * DAY_MS &&
          row.recallCount === 0
        ),
    )

    // (b) REWRITE relative dates, anchored on the moment EACH FILE'S TEXT
    // described. A file written a month ago says "yesterday" about a month ago,
    // so rewriting it against THIS region's anchor moved an old note's date
    // forward every time any conversation closed. The file's own stored date is
    // the one its frontmatter shows; this region's anchor only applies to what
    // this region just wrote, which is every row younger than it.
    for (const row of surviving) {
      if (row.type === "_index") continue
      const own = new Date(row.updatedAt).getTime()
      const rowAnchor = new Date(Math.min(own, anchorDate.getTime()))
      const rewritten = rewriteRelativeDates(row.content, rowAnchor)
      if (rewritten !== row.content) {
        await tx
          .update(agentMemoryTable)
          // THE TAG IS NAMED, and it is the row's OWN: a date rewrite brings no
          // text in from anywhere, so there is nothing to union and nothing to
          // narrow. Naming it is what tells the tagged-sink guard that this
          // content change considered the tag rather than forgot it.
          .set({ content: rewritten, requiredScopes: row.requiredScopes })
          .where(eq(agentMemoryTable.id, row.id))
        row.content = rewritten
      }
    }

    // (c) REBUILD the index. One line per CURRENT topic file that still earns
    // one, plus one folder line per thread with episodes, promoted lines first
    // inside their type section, and the whole thing capped by construction.
    const current = surviving.filter((r) => r.supersededAt === null)
    const topics = current.filter((r) => r.type !== "episode")
    const episodes = current.filter((r) => r.type === "episode")

    const earnsALine = (row: UpkeepRow): boolean => {
      const last = row.lastRecalledAt ?? row.createdAt
      return now - new Date(last).getTime() <= INDEX_DEMOTE_DAYS * DAY_MS
    }
    const promoted = (row: UpkeepRow): boolean =>
      (recalls.get(row.id)?.size ?? 0) >= INDEX_PROMOTE_THREADS && row.lastConfirmedAt !== null

    const byType = new Map<string, UpkeepRow[]>()
    for (const row of topics.filter(earnsALine)) {
      if (!byType.has(row.type)) byType.set(row.type, [])
      byType.get(row.type)?.push(row)
    }
    const lines: string[] = []
    for (const type of [...byType.keys()].sort()) {
      const section = byType.get(type) ?? []
      section.sort((a, b) => {
        const pa = promoted(a) ? 0 : 1
        const pb = promoted(b) ? 0 : 1
        return pa - pb || a.name.localeCompare(b.name)
      })
      for (const row of section) {
        lines.push(
          `- [${row.description}](${row.path ?? `${row.type}/${row.name}.md`}), ${isoDay(
            new Date(row.updatedAt),
          )}`,
        )
      }
    }
    // ONE line per thread, never one per episode: a line per episode would
    // flood an index that is in context on every turn.
    const episodeFolders = new Map<string, number>()
    for (const row of episodes) {
      const folder = (row.path ?? "").split("/").slice(0, 2).join("/")
      if (!folder.startsWith("episodes/")) continue
      episodeFolders.set(folder, (episodeFolders.get(folder) ?? 0) + 1)
    }
    for (const [folder, count] of [...episodeFolders.entries()].sort()) {
      lines.push(`- [Past conversations (${count})](${folder}/), ${isoDay(new Date())}`)
    }

    // Under the cap BY CONSTRUCTION. The rebuild is the one write that could
    // legitimately produce an overflowing index, so it trims here rather than
    // handing T09 a refusal it cannot act on.
    const capped = lines.slice(0, MEMORY_INDEX_REBUILD_MAX_LINES)
    const content = capped.join("\n")
    // THE INDEX CARRIES THE UNION OF WHAT IT QUOTES (the rule writeIndex
    // already follows). A rebuild changes the set of quoted entries, so
    // keeping the row's previous tag left it describing a set it no longer
    // holds: an entry needing a scope the index row lacked was quoted by a row
    // readable without it.
    const quoted = new Set<string>()
    for (const row of [...topics.filter(earnsALine), ...episodes]) {
      for (const scope of row.requiredScopes) quoted.add(scope)
    }
    const requiredScopes = [...quoted].sort()
    if (index) {
      await tx
        .update(agentMemoryTable)
        .set({ content, requiredScopes, updatedAt: new Date() })
        .where(eq(agentMemoryTable.id, index.id))
    } else if (content.length > 0) {
      const [agent] = await tx
        .select({ ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      await tx.insert(agentMemoryTable).values({
        orgId,
        userId: agent?.ownerUserId ?? null,
        ownerAgentId: agentId,
        type: "_index",
        name: "_index",
        description: "index",
        path: "MEMORY.md",
        content,
        requiredScopes,
      })
    }
  })

  await recordConsolidationAudit({
    orgId,
    agentId,
    threadId,
    action: "memory_index_rebuilt",
    ...(payload.jobId ? { jobId: payload.jobId } : {}),
  })
}

/**
 * The moment the region described: the date of the message the episode ends at,
 * never `now()` and never the row's `updatedAt`. A re-run must resolve a
 * relative date to the same absolute one it resolved to the first time.
 */
async function resolveAnchorDate(payload: ConsolidationPayload): Promise<Date> {
  const { orgId, threadId } = payload
  const anchorId = payload.toMessageId
  const rows = await withPrivilegedDb(orgId, "consolidation:anchor-date", async (tx) => {
    const result = anchorId
      ? await tx.execute(
          drizzleSql`SELECT created_at FROM ${K()}.messages WHERE id = ${anchorId} AND org_id = ${orgId} LIMIT 1`,
        )
      : await tx.execute(drizzleSql`
          SELECT created_at FROM ${K()}.messages
          WHERE thread_id = ${threadId} AND org_id = ${orgId} AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1`)
    return ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Array<{ created_at: string }>
  })
  return rows[0] ? new Date(rows[0].created_at) : new Date()
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ConsolidationTestAccess = {
  /** Swap the model-backed flush step; pass nothing to restore the real one. */
  setFlush(fn?: FlushFn): void {
    assertTestEnv("ConsolidationTestAccess.setFlush")
    flushOverride = fn ?? null
  },

  /** Swap the model-backed summarizer; pass nothing to restore the real one. */
  setSummarizer(fn?: ConsolidationSummarizer): void {
    assertTestEnv("ConsolidationTestAccess.setSummarizer")
    summarizerOverride = fn ?? null
  },

  /** Swap the model-backed fact extractor; pass nothing to restore the real one. */
  setFactExtractor(fn?: ConsolidationFactExtractor): void {
    assertTestEnv("ConsolidationTestAccess.setFactExtractor")
    factExtractorOverride = fn ?? null
  },

  /** Restore every seam above to its shipped implementation. */
  resetSeams(): void {
    flushOverride = null
    summarizerOverride = null
    factExtractorOverride = null
  },
}
