// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared machinery for the long memory harness (P4m-T33 to P4m-T36,
// spec-memory.md "Validation", scenarios 1 to 7).
//
// NO FUNDED KEY ON THIS MACHINE. The Anthropic key present here has no credit,
// so EVERY model backed step runs through the production test seams and is
// scripted: the turn stream (`AgentServiceTestAccess.setStreamText`, wrapped by
// `installRequestCapture`), the checkpoint summarizer
// (`CheckpointTestAccess.setSummarizer`) and consolidation's flush, summarizer and
// fact extractor (`setConsolidation*ForTest`). Everything BETWEEN those seams is
// the real production path: region resolution, the flush region marker, the
// checkpoint advance, the bounded history load, the memory tree writes, the
// scope filter, auto recall and the runtime context tail.
//
// THE SCRIPTED READER IS THE MODEL STAND IN. It may cite only what the captured
// request actually carried, so "the answer contains the account number" is a
// statement about retrieval, never about the script: switch recall off and the
// number is in no part of the request, so no reader could answer with it. The
// scripted fact extractor works the same way: it reads the REGION it is handed
// and emits a fact only when the region really contains one, so a wrong region
// produces no memory and the later scenarios fail.

import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import type { CapturedTurn } from "./capture-requests"
import { fullBuffer } from "./capture-requests"

/** The kernel schema as a quoted identifier, under the test namespace's prefix. */
const K = () => sql(schemaRef("kernel"))

/** The repo's own convention for pinning a scenario to the cheap model. */
export const HAIKU_MODEL_ID = "claude-haiku-4-5"

/** The shape every scripted carrier account number in the harness takes. */
export const ACCOUNT_RE = /\bK[A-Z]{2}-\d{5}\b/g

/** Chars per padded filler message; `estimateTokens` is chars / 4. */
export const FILLER_CHARS = 6_500

/** The history budget every seeded org runs under (its `ai.history.budgetTokens`). */
export const E2E_HISTORY_BUDGET = 48_000

export interface WorldParams {
  orgId: string
  userId: string
  userEmail: string
  agents: Array<{
    id: string
    handle: string
    displayName: string
    kind: "personal" | "role"
    ownerUserId?: string
    scopeCeiling?: string[]
  }>
  threads: Array<{ id: string; handle: string; type?: string }>
}

/** Org, human, agents, threads, credit and the cheap model row. */
export async function seedWorld(params: WorldParams): Promise<void> {
  const { orgId, userId } = params
  // The org's history budget is 48,000 tokens (Settings > AI models), so a few
  // hundred seeded messages cross it; the default (256,000) would need thousands.
  await sql`INSERT INTO ${K()}.organizations (id, name, slug, settings)
    VALUES (${orgId}, 'LongMemoryOrg', ${`long-memory-${orgId.slice(0, 8)}`}, '{"ai":{"history":{"budgetTokens":48000}}}'::jsonb)`
  await sql`INSERT INTO ${K()}.users (id, org_id, email, name)
    VALUES (${userId}, ${orgId}, ${params.userEmail}, 'Long Memory')`
  for (const agent of params.agents) {
    const ceiling = JSON.stringify(agent.scopeCeiling ?? ["*"])
    await sql`INSERT INTO ${K()}.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
      VALUES (${agent.id}, ${orgId}, ${agent.kind}, ${agent.handle}, ${agent.displayName},
              ${agent.ownerUserId ?? null}, ${ceiling}::jsonb, 'You help with logistics.')`
  }
  for (const thread of params.threads) {
    await sql`INSERT INTO ${K()}.threads (id, org_id, handle, type, created_by, agent_model_id)
      VALUES (${thread.id}, ${orgId}, ${thread.handle}, ${thread.type ?? "agent_chat"}, ${userId}, ${HAIKU_MODEL_ID})`
    await sql`INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id)
      VALUES (${thread.id}, ${userId}, ${orgId})`
  }
  await sql`INSERT INTO ${K()}.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${orgId}, '100.00000000', '0', 'EUR')`
  await sql`INSERT INTO ${K()}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${HAIKU_MODEL_ID}, 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
}

/**
 * A second human in a seeded world, holding `scopes` as direct grants. The
 * world has no admin to grant them (it is raw rows with fixed ids, no
 * registration), so the grants are rows like the rest of it.
 */
export async function addPerson(params: {
  orgId: string
  userId: string
  email: string
  name: string
  scopes?: string[]
}): Promise<void> {
  const { orgId, userId } = params
  await sql`INSERT INTO ${K()}.users (id, org_id, email, name)
    VALUES (${userId}, ${orgId}, ${params.email}, ${params.name})`
  for (const scope of params.scopes ?? []) {
    await sql`INSERT INTO ${K()}.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${orgId}, ${scope})`
  }
}

export async function dropWorld(orgId: string): Promise<void> {
  await sql`DELETE FROM ${K()}.agent_thread_checkpoints WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.agent_memory WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.audit_log WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.messages WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.thread_participants WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.threads WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.agents WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.credit_transactions WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.credit_balances WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.user_scope_grants WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.organizations WHERE id = ${orgId}`
}

/** Pad a line out to the filler width so a scripted script crosses a budget. */
export function padded(text: string, chars = FILLER_CHARS): string {
  return text + " ".repeat(Math.max(0, chars - text.length))
}

export interface SeededMessage {
  id: string
  content: string
}

/** One message row, written WITHOUT invoking an agent (cheap bulk history). */
export async function insertMessage(params: {
  orgId: string
  threadId: string
  /** The initiating human; an agent post carries it too (author_agent_id names the agent). */
  authorId: string
  authorType: "user" | "agent"
  content: string
  requiredScopes?: string[]
  authorAgentId?: string | null
  /**
   * An explicit clock. A scenario about a JOIN POINT has to set it: the join
   * comparison is `createdAt >= joinedAt` over JavaScript Dates, whose
   * millisecond resolution cannot separate two rows written in the same
   * millisecond, and a seeding loop writes far faster than that.
   */
  createdAt?: Date
  /**
   * The stored row's metadata, which is where a turn's tool calls live
   * (`{ toolCalls: [{ toolCallId, toolName, args, result }] }`). A scenario about
   * the REPLAY of a retrieval call seeds it here rather than driving a turn: the
   * scripted stream has no way to execute a tool.
   */
  metadata?: unknown
}): Promise<SeededMessage> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO ${K()}.messages
      (id, thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
       metadata, created_at)
    VALUES (${id}, ${params.threadId}, ${params.orgId}, ${params.authorId}, ${params.authorType},
            ${params.authorAgentId ?? null}, ${params.content}, ${params.requiredScopes ?? []}::text[],
            ${params.metadata === undefined ? null : JSON.stringify(params.metadata)}::text::jsonb,
            ${(params.createdAt ?? new Date()).toISOString()}::timestamptz)`
  return { id, content: params.content }
}

/**
 * Move a thread's whole history back so the newest AGENT row sits exactly
 * `minutesAgo` minutes before the moment this runs.
 *
 * EXACTLY, and computed here rather than at seed time: the cold resume rule
 * compares wall clock against a 60 minute window, so a control pinned "59
 * minutes back" when the fixture was built drifts past the window while the
 * earlier runs take their seconds and silently becomes a cold turn (P4c-T26b).
 * Every row moves by the SAME delta, so the thread's order is untouched.
 */
export async function stampLastAgentTurnMinutesAgo(params: {
  orgId: string
  threadId: string
  minutesAgo: number
}): Promise<Date> {
  const rows = await sql<{ created_at: Date }[]>`
    SELECT created_at FROM ${K()}.messages
    WHERE org_id = ${params.orgId} AND thread_id = ${params.threadId}
      AND author_type = 'agent' AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1`
  const newest = rows[0]?.created_at
  if (!newest) throw new Error("stampLastAgentTurnMinutesAgo: the thread has no agent message")
  const target = new Date(Date.now() - params.minutesAgo * 60_000)
  const deltaMs = target.getTime() - new Date(newest).getTime()
  await sql`UPDATE ${K()}.messages
    SET created_at = created_at + make_interval(secs => ${deltaMs / 1000})
    WHERE org_id = ${params.orgId} AND thread_id = ${params.threadId}`
  return target
}

/** Drive one real turn through the production path and return its reply text. */
export async function driveTurn(params: {
  orgId: string
  threadId: string
  userId: string
  agentId: string
  content: string
  routineId?: string
  scopes?: string[]
}): Promise<string> {
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
  const msg = await insertMessage({
    orgId: params.orgId,
    threadId: params.threadId,
    authorId: params.userId,
    authorType: "user",
    content: params.content,
  })
  await invokeAgentForThread(
    params.threadId,
    msg.id,
    {
      userId: params.userId,
      orgId: params.orgId,
      scopes: params.scopes ?? ["*"],
      dimensionGrants: {},
    },
    params.orgId,
    false,
    undefined,
    params.routineId,
    undefined,
    undefined,
    params.agentId,
  )
  return lastAgentReply(params.orgId, params.threadId)
}

/** The newest agent-authored message of a thread, which is the turn's answer. */
export async function lastAgentReply(orgId: string, threadId: string): Promise<string> {
  const rows = await sql<{ content: string | null }[]>`
    SELECT content FROM ${K()}.messages
    WHERE org_id = ${orgId} AND thread_id = ${threadId} AND author_type = 'agent'
      AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1`
  return rows[0]?.content ?? ""
}

/**
 * The model stand in: every byte of the captured request, so an answer drawn
 * from it is an answer the request really carried.
 */
export function requestText(turn: CapturedTurn): string {
  return fullBuffer(turn).toString("utf8")
}

/**
 * The reader. It answers with the LAST account number the request carries, so a
 * correction that superseded an older value wins only when retrieval really
 * stopped surfacing the old one. With nothing to cite it says so.
 */
export function readAccountNumber(turn: CapturedTurn): string | null {
  const matches = requestText(turn).match(ACCOUNT_RE)
  return matches && matches.length > 0 ? matches[matches.length - 1] : null
}

/** The scripted stream a reader turn produces. */
export function readerStream(answer: string, inputTokens = 1_000): unknown {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: answer }
      yield {
        type: "finish-step",
        usage: { inputTokens, outputTokens: 12 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

/** The reader's answer for one captured turn: cite it, or say it is unknown. */
export function answerFromRequest(turn: CapturedTurn): string {
  const account = readAccountNumber(turn)
  return account
    ? `The carrier account number is ${account}.`
    : "I do not have a carrier account number on file."
}

// --- Per turn log lines (spec-memory.md Budgets) ----------------------------

export interface LogLine {
  msg: string
  fields: Record<string, unknown>
}

export interface LogCapture {
  lines: LogLine[]
  of(msg: string): Array<Record<string, unknown>>
  restore(): void
}

/**
 * Capture the structured log lines the budgets are measured by. Every module
 * logger is a child of `rootLogger`, and a pino child resolves its level
 * methods through the parent, so one spy sees them all.
 *
 * BOTH LEVELS. The budget lines are `info`, but the overruns they are measured
 * against are `warn` (`cold_resume_over_budget`): a capture that watched only
 * `info` could assert that a cap holds and never see the line saying it did
 * not. `of()` is unchanged, so a caller asking for an info line still gets
 * exactly the same rows.
 */
export function captureLogLines(): LogCapture {
  const lines: LogLine[] = []
  const levels = ["info", "warn"] as const
  const originals = new Map<string, (...a: unknown[]) => unknown>()
  for (const level of levels) {
    const original = (
      rootLogger[level] as unknown as { bind: (t: unknown) => (...a: unknown[]) => unknown }
    ).bind(rootLogger)
    originals.set(level, original)
    const patched = (first: unknown, second?: unknown, ...rest: unknown[]) => {
      if (typeof first === "object" && first !== null && typeof second === "string") {
        lines.push({ msg: second, fields: first as Record<string, unknown> })
      } else if (typeof first === "string") {
        lines.push({ msg: first, fields: {} })
      }
      return original(first, second, ...rest)
    }
    ;(rootLogger as unknown as Record<string, unknown>)[level] = patched
  }
  return {
    lines,
    of: (msg: string) => lines.filter((l) => l.msg === msg).map((l) => l.fields),
    restore: () => {
      for (const level of levels) {
        const original = originals.get(level)
        if (original) (rootLogger as unknown as Record<string, unknown>)[level] = original
      }
    },
  }
}
