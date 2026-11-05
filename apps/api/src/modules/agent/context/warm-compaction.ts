// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE COLD RESUME, RUN WHILE THE CACHE IS STILL WARM.
//
// The cold resume (P4c-T23, `coldResumeAdvanceForTurn`) compresses a thread's
// raw tail to COLD_TAIL_TOKEN_BUDGET when its agent turns again after an idle
// gap. It used to run AT the returning turn, after the provider's prompt cache
// had expired: its brief call read the whole region at the full input price,
// and so did nothing else, because the turn then started from the short tail.
//
// This module runs the same advance AHEAD of the gap, just before the cache
// goes cold, and sends its brief call as the thread's own last request (same
// system prompt, same tools, same history bytes, same model, same pinned
// upstream host) with the brief instruction APPENDED. The provider reads the
// whole history from its cache (a fraction of the price), and the turn after
// the gap starts from the checkpoint and the short tail. The checkpoint it
// writes is the cold resume's: same advance, same brief prompt and format,
// same storage, same `cold_resume` prefix rebuild cause. A returning turn
// whose tail already fits finds nothing left to do; a thread the job missed
// is still compressed at the returning turn, as before.
//
// HOW IT RUNS
// - Every request of an agent's TURN through OpenRouter is kept in Redis (the
//   body as sent, gzipped) beside its time, and re-arms ONE delayed job per
//   (agent, thread) for `lastCall + TTL - margin`, where TTL is the cache
//   lifetime of the upstream host the thread is pinned to
//   (openrouter-provider-pin.ts). Re-arming slides the job (`replaceDelayed`),
//   so a thread in use never fires it.
// - The job fires on any worker. It does nothing unless the thread is still
//   idle (no newer request, no live run, no newer message from a person), the
//   org has the setting on, the history is past WARM_COMPACTION_FLOOR_TOKENS,
//   and it wins the one claim per idle window (Redis NX on the last request's
//   time), so replicas and retries advance once.
// - Other providers keep no request here, so for them the cold resume runs at
//   the returning turn as before.

import { gunzipSync, gzipSync } from "node:zlib"
import type { UserContext } from "~/db/rls"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { env, isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  advanceCheckpoint,
  type CheckpointSummarizer,
  type CheckpointSummarizerInput,
  type HistoryMessageRow,
  loadBoundedHistory,
} from "~/modules/agent/context/checkpoint"
import { COLD_TAIL_TOKEN_BUDGET, WARM_WINDOW_MS } from "~/modules/agent/context/cold-resume"
import { loadOrgHistorySettings } from "~/modules/agent/context/history-settings"

const log = rootLogger.child({ module: "warm-compaction" })

export const WARM_COMPACTION_QUEUE_APP = "kernel"
export const WARM_COMPACTION_JOB = "agent-warm-compaction"

/**
 * Below this much replayed history (tokens) an idle thread is left alone. The
 * summary costs a cached read of the history plus a written brief (about
 * 1,000 to 2,000 output tokens) and a brief row extraction; it saves the next
 * turn an uncached read of the history less the brief and the kept tail
 * (COLD_TAIL_TOKEN_BUDGET, 8,000). Under about 32,000 tokens the saving is a
 * few cents per million at best and the thread may never be resumed.
 */
export const WARM_COMPACTION_FLOOR_TOKENS = 32_000

/** Fire this long before the cache is expected to expire: job pickup plus the request's own latency. */
export const WARM_COMPACTION_MARGIN_MS = 45_000

/**
 * Measured prompt cache lifetimes, in seconds, per OpenRouter upstream host
 * (the `provider` a response names, which is what the thread pins). Measured
 * 2026-10-30 on deepseek/deepseek-v4.1-flash: a ~8,600 token prompt primed
 * once, re-sent after N minutes with the same `session_id` and `provider.order`
 * pinned to the host, `prompt_tokens_details.cached_tokens` read. The value is
 * the longest delay still read from cache, so it is a floor of the real
 * lifetime. A host not listed gets AGENT_PROMPT_CACHE_TTL_S.
 *
 * DeepInfra, Relace and Morph still read from cache after 12 minutes, Decart
 * after 8 but not 12. Wafer read from cache after 1 minute, missed after 4 and
 * 8, then hit again after 12 (several replicas, so a hit depends on which one
 * answers): it is held to 60 s, which is under the minimum idle time, so a
 * Wafer thread is left to the cold resume.
 */
export const MEASURED_CACHE_TTL_S: Readonly<Record<string, number>> = {
  DeepInfra: 720,
  Relace: 720,
  Morph: 720,
  Decart: 480,
  Wafer: 60,
}

/**
 * A thread is summarized only after at least this much idle time. A shorter
 * cache lifetime would put the summary in the middle of a live conversation
 * (the person still typing), where the next turn would pay a fresh prefix for
 * a summary it did not need.
 */
export const WARM_COMPACTION_MIN_IDLE_MS = 120_000

/** The prompt cache lifetime assumed for an upstream host, in seconds. */
export function promptCacheTtlSeconds(host: string | null): number {
  const measured = host ? MEASURED_CACHE_TTL_S[host] : undefined
  return measured ?? env.AGENT_PROMPT_CACHE_TTL_S
}

/**
 * How long after the last request the job fires: just before the cache
 * expires, and never later than the cold resume's own warm window (past it,
 * the returning turn would compress anyway).
 */
export function warmCompactionDelayMs(ttlSeconds: number): number {
  return Math.max(0, Math.min(ttlSeconds * 1000, WARM_WINDOW_MS) - WARM_COMPACTION_MARGIN_MS)
}

/** What the turn hands the model resolver so its requests can be kept (provider.ts). */
export interface IdleCompactionTurn {
  orgId: string
  agentId: string
  actor: UserContext
  /** The model key the turn ran on (`openrouter/<id>`): the brief runs on the same model. */
  modelKey: string
  contextWindow?: number
}

/** A turn's last request, as kept. */
export interface LastTurnRequest extends IdleCompactionTurn {
  threadId: string
  /** Epoch ms the request was sent. */
  at: number
  /** The host the request was pinned to, null on a thread's first request. */
  host: string | null
  /** The request body as sent. */
  body: Record<string, unknown>
}

/** How long a kept request outlives its turn: past the warm window nothing reads it. */
const LAST_REQUEST_TTL_S = Math.ceil(WARM_WINDOW_MS / 1000) + 15 * 60

/**
 * Keyed under the org: the kept request holds the thread's history, and the org
 * purge removes every Redis key that names the org (org/purge/external.ts).
 */
export function lastRequestKey(orgId: string, threadId: string): string {
  return `agent:warm-compaction:last-request:${orgId}:${threadId}`
}

function claimKey(orgId: string, threadId: string, agentId: string, at: number): string {
  return `agent:warm-compaction:claim:${orgId}:${threadId}:${agentId}:${at}`
}

export function warmCompactionJobId(p: { orgId: string; agentId: string; threadId: string }) {
  return `${WARM_COMPACTION_JOB}:${p.orgId}:${p.agentId}:${p.threadId}`
}

export interface WarmCompactionPayload {
  orgId: string
  agentId: string
  threadId: string
}

/** The store the kept requests live in (Redis; a test swaps it). */
export interface LastRequestStore {
  put(key: string, value: Buffer, ttlSeconds: number): Promise<void>
  get(key: string): Promise<Buffer | null>
  /** Set `key` only if absent; true when this call set it. */
  claim(key: string, ttlSeconds: number): Promise<boolean>
}

const redisStore: LastRequestStore = {
  async put(key, value, ttlSeconds) {
    const { redis } = await import("~/lib/redis")
    await redis.set(key, value, "EX", ttlSeconds)
  },
  async get(key) {
    const { redis } = await import("~/lib/redis")
    return redis.getBuffer(key)
  },
  async claim(key, ttlSeconds) {
    const { redis } = await import("~/lib/redis")
    return (await redis.set(key, "1", "EX", ttlSeconds, "NX")) === "OK"
  },
}

let storeOverride: LastRequestStore | null = null
function store(): LastRequestStore {
  return storeOverride ?? redisStore
}

type Arm = (payload: WarmCompactionPayload, delayMs: number, jobId: string) => Promise<void>
const defaultArm: Arm = async (payload, delayMs, jobId) => {
  await enqueueAppJob(WARM_COMPACTION_QUEUE_APP, WARM_COMPACTION_JOB, payload, {
    jobId,
    delay: delayMs,
    replaceDelayed: true,
    attempts: 1,
  })
}
let armOverride: Arm | null = null
function arm(): Arm {
  return armOverride ?? defaultArm
}

/** Rough size of a request, in tokens: a request this small has no history worth compressing. */
/** The conversation a request carries (its system prompt left out), in estimated tokens. */
function requestTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const conversation = messages.filter(
    (m) => !(m && typeof m === "object" && (m as { role?: unknown }).role === "system"),
  )
  return Math.ceil(JSON.stringify(conversation).length / 4)
}

/**
 * Keep a turn's request and slide its thread's idle compaction to
 * `now + TTL - margin`. Called for every request of a turn (provider.ts),
 * never awaited by it; failures are logged and cost only the early summary.
 */
export async function recordTurnRequest(
  turn: IdleCompactionTurn & { threadId: string },
  sent: Record<string, unknown>,
  pinnedHost: string | null,
  now: number = Date.now(),
): Promise<void> {
  try {
    if (requestTokens(sent) < WARM_COMPACTION_FLOOR_TOKENS) return
    const delayMs = warmCompactionDelayMs(promptCacheTtlSeconds(pinnedHost))
    // Too short a cache to wait for an idle moment: the cold resume handles it.
    if (delayMs < WARM_COMPACTION_MIN_IDLE_MS) return
    const record: LastTurnRequest = { ...turn, at: now, host: pinnedHost, body: sent }
    await store().put(
      lastRequestKey(turn.orgId, turn.threadId),
      gzipSync(Buffer.from(JSON.stringify(record))),
      LAST_REQUEST_TTL_S,
    )
    const payload: WarmCompactionPayload = {
      orgId: turn.orgId,
      agentId: turn.agentId,
      threadId: turn.threadId,
    }
    await arm()(payload, delayMs, warmCompactionJobId(payload))
  } catch (err) {
    log.warn(
      { err, threadId: turn.threadId },
      "could not keep the turn request for idle compaction",
    )
  }
}

export async function readLastTurnRequest(
  orgId: string,
  threadId: string,
): Promise<LastTurnRequest | null> {
  const raw = await store().get(lastRequestKey(orgId, threadId))
  if (!raw) return null
  try {
    return JSON.parse(gunzipSync(raw).toString("utf-8")) as LastTurnRequest
  } catch {
    return null
  }
}

// --- The brief request: the thread's last request plus one instruction -----

const QUOTE_CHARS = 300

function speakerOf(row: HistoryMessageRow): string {
  if (row.authorType === "user") return "a person"
  if (row.authorType === "agent") return "an agent"
  return "the platform"
}

/**
 * The instruction appended to the thread's request. It carries exactly what the
 * side-call writer's user message carries (the brief so far, then the new
 * region) and the brief prompt itself, so the brief comes back in the same
 * format; the region is the conversation ABOVE, named by where it stops,
 * rather than re-sent.
 */
export function warmBriefInstruction(
  input: Pick<CheckpointSummarizerInput, "prompt" | "previousSummary" | "messages"> & {
    regionRows: HistoryMessageRow[]
    keptRows: HistoryMessageRow[]
  },
  requestAt: number,
): string {
  const parts: string[] = [
    "Stop the conversation here: do not answer it and call no tool. Instead, write the brief this instruction describes.",
    input.prompt.trim(),
    `## The brief so far\n\n${
      input.previousSummary && input.previousSummary.trim().length > 0
        ? input.previousSummary
        : "(empty, this is the first region)"
    }`,
  ]
  // The first kept row the conversation above already shows is where the region stops.
  const firstKept = input.keptRows.find((r) => r.createdAt.getTime() <= requestAt)
  const quoted = (firstKept?.content ?? "").trim().slice(0, QUOTE_CHARS)
  let region = "## The new region\n\n"
  if (firstKept && quoted.length > 0) {
    region += `The new region is the conversation above (after the summary of earlier turns, if it starts with one), up to the message from ${speakerOf(firstKept)} that begins as quoted below. That message and everything after it stay word for word and are NOT part of the region:\n\n> ${quoted.replace(/\n/g, "\n> ")}`
  } else {
    region +=
      "The new region is the whole conversation above (after the summary of earlier turns, if it starts with one)."
  }
  // Region rows written after the request (the turn's own answer, a later
  // event): the conversation above does not show them, so they are given here.
  const late: string[] = []
  input.regionRows.forEach((row, i) => {
    if (row.createdAt.getTime() <= requestAt) return
    const m = input.messages[i]
    if (!m) return
    late.push(`${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
  })
  if (late.length > 0) {
    region += `\n\nThe region also holds these messages, written after the conversation above:\n\n${late.join("\n\n")}`
  }
  parts.push(region)
  return parts.join("\n\n")
}

/**
 * The brief request: the thread's last request, byte for byte, with the
 * instruction appended as one user message. Only what does not enter the
 * prompt changes: no streaming, room for the brief, and no tool call.
 */
export function warmBriefRequestBody(
  last: Record<string, unknown>,
  instruction: string,
): Record<string, unknown> {
  const messages = Array.isArray(last.messages) ? last.messages : []
  const { stream: _stream, stream_options: _streamOptions, ...rest } = last
  const asked = typeof last.max_tokens === "number" ? last.max_tokens : 0
  return {
    ...rest,
    // `tools` and `tool_choice` stay exactly as the turn sent them. A host
    // renders the tool list into the prompt ahead of the messages, and
    // `tool_choice: "none"` makes it leave the list out: the prompt then
    // differs from the cached one right after the system prompt, and a live
    // brief on a 96,000-token thread read 3 percent from cache instead of all
    // of it (2026-10-30). The instruction says to call no tool; a reply that
    // calls one anyway carries no brief and leaves the thread to the cold resume.
    messages: [...messages, { role: "user", content: instruction }],
    max_tokens: Math.max(asked, 4096),
  }
}

type BriefSend = (params: {
  apiKey: string
  threadId: string
  body: Record<string, unknown>
  /** The org whose blocked OpenRouter hosts apply. */
  orgId?: string
}) => Promise<unknown>

const defaultSend: BriefSend = async ({ apiKey, threadId, body, orgId }) => {
  const { openRouterBaseURL, openRouterThreadFetch } = await import(
    "~/modules/agent/providers/openrouter"
  )
  const res = await openRouterThreadFetch(
    apiKey,
    threadId,
    orgId ?? null,
  )(`${openRouterBaseURL()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`)
  return JSON.parse(text) as unknown
}
let sendOverride: BriefSend | null = null

interface ChatCompletion {
  provider?: string
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cost?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** The credit gate of one brief call: may it run, on which key, and how it is settled. */
type CreditGate = (
  orgId: string,
  modelKey: string,
) => Promise<
  | { allowed: false }
  | { allowed: true; providerKey: string; settle: (usage: unknown, meta: unknown) => Promise<void> }
>

/** The side calls' own gate: a demo org's budget reserves it and pays for it (credit-meter.ts). */
const defaultCreditGate: CreditGate = async (orgId, modelKey) => {
  const { preCheck, meterSideCall } = await import("~/modules/agent/credits/credit-meter")
  const creditCheck = await preCheck(orgId, modelKey)
  if (!creditCheck.allowed) return { allowed: false }
  return {
    allowed: true,
    providerKey: creditCheck.providerKey,
    settle: (usage, meta) => meterSideCall(orgId, creditCheck, usage, meta),
  }
}
let creditGateOverride: CreditGate | null = null

/** The brief writer that sends the thread's own request (see above). */
export function warmBriefWriter(last: LastTurnRequest): CheckpointSummarizer {
  return async (input) => {
    const creditCheck = await (creditGateOverride ?? defaultCreditGate)(input.orgId, last.modelKey)
    if (!creditCheck.allowed) {
      log.warn({ orgId: input.orgId }, "Insufficient credits for an idle compaction, skipping")
      return null
    }
    let usage: unknown = null
    let providerMetadata: unknown
    try {
      const instruction = warmBriefInstruction(
        {
          prompt: input.prompt,
          previousSummary: input.previousSummary,
          messages: input.messages,
          regionRows: input.regionRows ?? [],
          keptRows: input.keptRows ?? [],
        },
        last.at,
      )
      const body = warmBriefRequestBody(last.body, instruction)
      const reply = (await (sendOverride ?? defaultSend)({
        apiKey: creditCheck.providerKey,
        threadId: last.threadId,
        body,
        orgId: input.orgId,
      })) as ChatCompletion
      const inputTokens = reply.usage?.prompt_tokens ?? 0
      const cacheReadTokens = reply.usage?.prompt_tokens_details?.cached_tokens ?? 0
      usage = {
        inputTokens,
        outputTokens: reply.usage?.completion_tokens ?? 0,
        inputTokenDetails: { cacheReadTokens },
      }
      providerMetadata = {
        openrouter: {
          ...(reply.provider ? { provider: reply.provider } : {}),
          ...(typeof reply.usage?.cost === "number" ? { usage: { cost: reply.usage.cost } } : {}),
        },
      }
      log.info(
        {
          threadId: last.threadId,
          agentId: last.agentId,
          upstream: reply.provider ?? null,
          pinnedHost: last.host,
          inputTokens,
          cacheReadTokens,
          cachedShare:
            inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 1000) / 1000 : 0,
          idleSeconds: Math.round((Date.now() - last.at) / 1000),
        },
        "checkpoint_warm_brief",
      )
      return reply.choices?.[0]?.message?.content ?? null
    } catch (err) {
      log.error({ err, threadId: last.threadId }, "Idle compaction brief failed, advance skipped")
      return null
    } finally {
      await creditCheck.settle(usage, providerMetadata)
    }
  }
}

// --- The job ---------------------------------------------------------------

export type WarmCompactionOutcome =
  | "advanced"
  | "no-request"
  | "other-agent"
  | "rearmed"
  | "cache-cold"
  | "turn-live"
  | "setting-off"
  | "org-gone"
  | "activity"
  | "claimed"
  | "under-floor"
  | "not-advanced"

/** The thread or org is gone (a deleted thread, an expired demo org). */
async function threadGone(orgId: string, threadId: string): Promise<boolean> {
  const { withPrivilegedDb } = await import("~/db/privileged")
  const { organizations, threads } = await import("~/db/schema/kernel")
  const { and, eq } = await import("drizzle-orm")
  const { isDemoOrgExpired } = await import("@liaison/shared")
  return withPrivilegedDb(orgId, "warm-compaction-liveness", async (tx) => {
    const [org] = await tx
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    if (!org || isDemoOrgExpired(org)) return true
    const [thread] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      .limit(1)
    return !thread
  })
}

export async function runWarmCompaction(
  payload: WarmCompactionPayload,
  now: number = Date.now(),
): Promise<WarmCompactionOutcome> {
  const { orgId, agentId, threadId } = payload
  const done = (outcome: WarmCompactionOutcome, extra: Record<string, unknown> = {}) => {
    log.info({ threadId, agentId, outcome, ...extra }, "warm_compaction")
    return outcome
  }
  const last = await readLastTurnRequest(orgId, threadId)
  if (!last) return done("no-request")
  // Another agent's turn is the thread's newest request: this agent's own
  // prefix is not the one in the cache.
  if (last.agentId !== agentId) return done("other-agent")

  const { providerPinKey } = await import("~/modules/agent/providers/openrouter-provider-pin")
  const model = typeof last.body.model === "string" ? last.body.model : ""
  let host = last.host
  try {
    const { redis } = await import("~/lib/redis")
    host = (await redis.get(providerPinKey(threadId, model))) ?? host
  } catch {
    // The pin read failing only means the default lifetime.
  }
  const ttlMs = promptCacheTtlSeconds(host) * 1000
  const due = last.at + warmCompactionDelayMs(ttlMs / 1000)
  if (now < due - 15_000) {
    // A newer request than the one that armed this run: fire for that one.
    await arm()(payload, due - now, `${warmCompactionJobId(payload)}:${last.at}`)
    return done("rearmed", { dueInMs: due - now })
  }
  if (now >= last.at + ttlMs) return done("cache-cold")

  const { hasOtherLiveRun, threadRunKey } = await import("~/modules/agent/scopes/live-runs")
  if (await hasOtherLiveRun(threadRunKey(threadId))) return done("turn-live")
  const settings = await loadOrgHistorySettings(orgId)
  if (!settings.warmCompaction) return done("setting-off")
  if (await threadGone(orgId, threadId)) return done("org-gone")

  const loaded = await loadBoundedHistory({
    threadId,
    orgId,
    actor: last.actor,
    agentId,
    ...(last.contextWindow ? { contextWindow: last.contextWindow } : {}),
  })
  // A person wrote after the last request: a turn is coming, and it starts warm.
  if (loaded.messages.some((m) => m.authorType === "user" && m.createdAt.getTime() > last.at)) {
    return done("activity")
  }
  if (loaded.estimatedTokens < WARM_COMPACTION_FLOOR_TOKENS) {
    return done("under-floor", { estimatedTokens: loaded.estimatedTokens })
  }
  // ONE ADVANCE PER IDLE WINDOW, whichever replica or retry gets here first.
  if (!(await store().claim(claimKey(orgId, threadId, agentId, last.at), 24 * 60 * 60))) {
    return done("claimed")
  }
  const result = await advanceCheckpoint({
    agentId,
    threadId,
    orgId,
    actor: last.actor,
    ...(last.contextWindow ? { contextWindow: last.contextWindow } : {}),
    // The cold resume's own advance: forced (the trigger is the clock, not the
    // budget) down to the cold tail.
    force: true,
    tailReserveTokens: COLD_TAIL_TOKEN_BUDGET,
    cause: "cold_resume",
    sinceLastTurnSeconds: Math.floor((now - last.at) / 1000),
    writer: warmBriefWriter(last),
  })
  return done(result.advanced ? "advanced" : "not-advanced", {
    reason: result.advanced ? undefined : result.reason,
    estimatedTokens: loaded.estimatedTokens,
  })
}

/** Registered from kernel-jobs beside the other kernel workers. */
export function registerWarmCompactionWorker(): void {
  registerJobWorker(
    WARM_COMPACTION_QUEUE_APP,
    WARM_COMPACTION_JOB,
    async (payload: WarmCompactionPayload) => {
      await runWarmCompaction(payload)
    },
    { txMode: "session" },
  )
}

// --- Test seams --------------------------------------------------------------

export const WarmCompactionTestAccess = {
  setStore(s?: LastRequestStore): void {
    if (!isTestEnv()) throw new Error("WarmCompactionTestAccess is test-only")
    storeOverride = s ?? null
  },
  setArm(fn?: Arm): void {
    if (!isTestEnv()) throw new Error("WarmCompactionTestAccess is test-only")
    armOverride = fn ?? null
  },
  setCreditGate(fn?: CreditGate): void {
    if (!isTestEnv()) throw new Error("WarmCompactionTestAccess is test-only")
    creditGateOverride = fn ?? null
  },
  setSend(fn?: BriefSend): void {
    if (!isTestEnv()) throw new Error("WarmCompactionTestAccess is test-only")
    sendOverride = fn ?? null
  },
}
