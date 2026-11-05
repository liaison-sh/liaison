// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine's token budget and hard token limit (S17, A34).
//
// The BUDGET is advice: the runner tells the agent, in the tick prompt, roughly
// how many tokens it has for the job. The HARD LIMIT is enforced: every model
// step of the run adds its tokens (input, cached included, plus output, read
// through readStepUsage) to one shared account, and a stop condition on the
// agent loop ends the run once the account reaches the limit.
//
// The account rides on the run's ALS frame (`RunContext.tokenAccount`), by
// reference. A turn started inside the run inherits it: the routine tick's own
// turn reads it from the tick frame, and an `agents_ask` callee's turn, started
// from a tool call of the asking turn, reads it from that turn's frame. So a
// sub-run's tokens land in the same account and count toward the parent's
// limit, and the callee is stopped by the same limit. The fields travel with
// the job, which is what lets a node run (P4) enforce the same count.
//
// A spawn_agent sub-run is a job-queue run, possibly in another worker, so the
// in-memory object cannot reach it. The account therefore also lives in a
// shared Redis counter keyed by its id: every step adds to it (INCRBY returns
// the run-wide total, sub-runs included), the sub-run job carries the id and
// the limit, and a turn or sub-run reads it before its first model call. The
// in-memory `used` is the fallback when Redis is unreachable.

import crypto from "node:crypto"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { readStepUsage } from "~/modules/agent/providers/step-usage"

const log = rootLogger.child({ module: "run-token-limit" })

export interface RunTokenAccount {
  /** The shared counter's id: the job payload of a sub-run carries it. */
  id: string
  /** The routine's soft budget, said to the agent in the prompt. */
  tokenBudget: number | null
  /** The routine's hard limit: the run stops once `used` reaches it. */
  hardTokenLimit: number | null
  /** Tokens spent so far by the run and every turn started inside it. */
  used: number
}

/** The two routine fields, as the routine row carries them. */
export interface RoutineTokenFields {
  tokenBudget?: number | null
  hardTokenLimit?: number | null
}

/**
 * The account for a routine run, or undefined when the routine sets neither
 * field: an absent account changes nothing anywhere downstream.
 */
export function createRunTokenAccount(fields: RoutineTokenFields): RunTokenAccount | undefined {
  const tokenBudget = positiveOrNull(fields.tokenBudget)
  const hardTokenLimit = positiveOrNull(fields.hardTokenLimit)
  if (tokenBudget === null && hardTokenLimit === null) return undefined
  return { id: crypto.randomUUID(), tokenBudget, hardTokenLimit, used: 0 }
}

function positiveOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** Tokens one model step costs against the account: input (cached included) + output. */
export function stepTokens(usage: unknown): number {
  const u = readStepUsage(usage)
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

/** True once the run has spent its hard limit. False when there is no limit. */
export function hardTokenLimitReached(account: RunTokenAccount | undefined): boolean {
  return (
    account !== undefined &&
    account.hardTokenLimit !== null &&
    account.used >= account.hardTokenLimit
  )
}

/** The sentence the runner appends to the tick prompt when the routine has a budget. */
export function tokenBudgetSentence(tokenBudget: number): string {
  return `You have about ${tokenBudget} tokens for this job. Plan your work to finish within it.`
}

/** What the run's output says when the hard limit stopped it. */
export function hardTokenLimitStopText(hardTokenLimit: number): string {
  return `Stopped at the hard limit of ${hardTokenLimit} tokens.`
}

/** The tick prompt with the budget sentence appended, or unchanged without a budget. */
export function withTokenBudgetSentence(prompt: string, fields: RoutineTokenFields): string {
  const budget = positiveOrNull(fields.tokenBudget)
  return budget === null ? prompt : `${prompt}\n\n${tokenBudgetSentence(budget)}`
}

/** The limit a job-queue sub-run carries in its payload (see SubRunJobPayload). */
export interface SubRunTokenLimit {
  accountId: string
  hardTokenLimit: number
}

/** A run's counter outlives any tick (lock TTL 600 s, deadline 900 s) by far. */
const COUNTER_TTL_SECONDS = 2 * 24 * 3600

function counterKey(accountId: string): string {
  return `run-token-account:${accountId}`
}

/** Adds `tokens` to the shared counter; returns the run-wide total, or null when Redis failed. */
export async function addSharedTokens(accountId: string, tokens: number): Promise<number | null> {
  try {
    const key = counterKey(accountId)
    const total = await redis.incrby(key, Math.max(0, Math.floor(tokens)))
    await redis.expire(key, COUNTER_TTL_SECONDS)
    return total
  } catch (err) {
    log.warn({ err, accountId }, "run token counter: increment failed, counting locally")
    return null
  }
}

/** The run-wide total so far, or null when Redis failed. */
export async function sharedTokensUsed(accountId: string): Promise<number | null> {
  try {
    const v = await redis.get(counterKey(accountId))
    return v === null ? 0 : Number(v)
  } catch (err) {
    log.warn({ err, accountId }, "run token counter: read failed, using the local count")
    return null
  }
}

/** Records one step's tokens: locally, and in the shared counter (whose total wins). */
export async function recordStepTokens(account: RunTokenAccount, tokens: number): Promise<void> {
  account.used += tokens
  const total = await addSharedTokens(account.id, tokens)
  if (total !== null) account.used = Math.max(account.used, total)
}

/** Pulls in what other runs of the same account (sub-runs) spent since. */
export async function refreshTokenAccount(account: RunTokenAccount): Promise<void> {
  const total = await sharedTokensUsed(account.id)
  if (total !== null) account.used = Math.max(account.used, total)
}

/**
 * The account of a routine run that paused for an approval and now resumes: the same counter (its
 * id) and what the run spent before the pause, under the routine's current budget and limit. A
 * routine that no longer sets either field has no account, as for a new tick.
 */
export async function continueRunTokenAccount(
  fields: RoutineTokenFields,
  kept: { id: string; used: number } | null | undefined,
): Promise<RunTokenAccount | undefined> {
  const account = createRunTokenAccount(fields)
  if (!account || !kept) return account
  account.id = kept.id
  account.used = Math.max(0, kept.used)
  await refreshTokenAccount(account)
  return account
}

/** The account a job-queue sub-run rebuilds from its payload, for its own frame and steps. */
export function accountFromSubRunLimit(limit: SubRunTokenLimit): RunTokenAccount {
  return { id: limit.accountId, tokenBudget: null, hardTokenLimit: limit.hardTokenLimit, used: 0 }
}

/**
 * A model that makes no provider call: one empty step, zero usage, finish
 * "stop". A turn whose run has already spent its hard limit runs on it, so the
 * loop ends before any request while finalize still persists the stop text.
 */
export function hardLimitNoCallModel(modelId: string) {
  return {
    specificationVersion: "v3" as const,
    provider: "liaison-hard-token-limit",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("the hard token limit is spent: no model call is made")
    },
    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({
            type: "finish",
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
            finishReason: { unified: "stop", raw: "stop" },
          })
          controller.close()
        },
      })
      return { stream }
    },
  }
}
