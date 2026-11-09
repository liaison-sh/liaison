// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * SCRIPTED MODEL PROVIDER — the e2e lane's deterministic agent turn.
 *
 * Until P4c-T17 the browser scenarios scripted the agent by stubbing
 * `**\/api/agent/chat` SSE and driving the retired panel's CLIENT-side stream.
 * The panel is gone: a turn now runs on the SERVER (the api dispatches it after
 * `POST /threads/:id/messages` and streams `agent_stream:*` frames over the
 * websocket), so the browser has nothing left to intercept.
 *
 * This is the replacement seam, one layer lower: a `LanguageModelV3` that
 * replays a per-thread SCRIPT instead of calling a provider. It is selected in
 * `resolveModel` only when `LIAISON_MODEL_PROVIDER=scripted` (set by the
 * Playwright worker env, never in dev or prod), so the default path is
 * untouched.
 *
 * The point of scripting the MODEL rather than the stream: the script says only
 * which tool the model calls and with what arguments. The call itself goes
 * through the REAL tool bridge — permissions, approval gating, handlers, the
 * world's data — and the script's NEXT step is produced after those real tool
 * results land. Nothing about the agent loop is faked, only the token source.
 *
 * One `doStream` call is ONE step. A step carrying tool calls finishes with
 * `tool-calls` (the loop runs them and comes back for the next step); a step
 * with only text finishes with `stop` (the turn ends). A thread with no script
 * left answers a fixed short line, so an unscripted turn (auto-title,
 * compaction) settles instead of hanging.
 */
import { createHash } from "node:crypto"
import { APICallError } from "ai"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { RUNTIME_TAIL_OPEN } from "~/modules/agent/context/context"
import { SCRIPTED_FALLBACK_REPLY } from "~/modules/agent/providers/load-script-catalog"

// The `LanguageModelV3` shapes are declared structurally rather than imported:
// `@ai-sdk/provider` is a transitive dependency of `ai`, not a direct one, so
// importing it here would add a package this app does not declare. Only the
// parts this provider produces are modelled; `resolveModel` casts the result to
// the SDK's `LanguageModel` at the seam.
type StreamPart = Record<string, unknown> & { type: string }
interface ScriptedLanguageModel {
  readonly specificationVersion: "v3"
  readonly provider: string
  readonly modelId: string
  supportedUrls: Record<string, RegExp[]>
  doGenerate(options: unknown): Promise<Record<string, unknown>>
  doStream(options: unknown): Promise<{ stream: ReadableStream<StreamPart> }>
}

const log = rootLogger.child({ mod: "scripted-model" })

/** One step of a scripted turn — what the model "says" on one round trip. */
export interface ScriptedStep {
  /** Assistant text for this step. */
  text?: string
  /** Reasoning emitted BEFORE this step's tool calls (the interleave order). */
  reasoning?: string
  /** Tool calls the agent loop then executes for real through the bridge. */
  toolCalls?: Array<{ name: string; args?: unknown }>
  /** Pause before the step's parts are emitted, so a live render stays on screen. */
  delayMs?: number
  /**
   * How long the step's test effect tools wait inside their execution, in ms
   * (passed to them as `waitMs`): a turn can be cut while a write tool runs.
   */
  toolDelayMs?: number
  /**
   * ANSWER FROM WHAT THE MODEL WAS ACTUALLY SHOWN.
   *
   * A regular expression, as a source string, matched against this call's whole
   * serialized prompt. The step's text becomes the first match, or
   * `ECHO_MISS` when the pattern is not in the prompt at all.
   *
   * WHY IT EXISTS (P4c-T21b-b, `mailbox-encryption-local` L5). Everything else
   * in a script is written before the turn runs, so a scripted answer can never
   * be evidence about what a tool RETURNED. That is fine almost everywhere,
   * because the real result is readable off the turn's persisted
   * `metadata.toolCalls`. It is not fine for the encrypted mailbox: the two-phase
   * broker deliberately injects decrypted mail as an EPHEMERAL context block
   * that `extractToolCalls` cannot reach, precisely so plaintext never lands in
   * `kernel.messages.metadata` (Invariant K). The prompt is therefore the ONLY
   * place that plaintext is observable, and "did the decrypted body reach the
   * model" is exactly what that scenario has to prove.
   *
   * Takes precedence over `text` on the same step. Matching is case-sensitive
   * and the pattern is applied without flags, so a scenario passes a literal
   * (escaped) phrase rather than relying on regex features.
   */
  echo?: string
  /**
   * THE PROVIDER BREAKS THIS STEP OFF. The step's first `times` plays stream its
   * reasoning and tool calls, then `partial` as text, and then fail the way a
   * dropped upstream does: an in-band error (a 2xx whose body stopped arriving)
   * and no finish. Later plays (the turn running the step again) are the step as
   * written. Plays are counted in Redis per turn and step, so a resume on another
   * process sees the same count.
   */
  streamFailure?: { times: number; partial?: string }
}

/** What an `echo` step emits when its pattern is nowhere in the prompt. */
export const ECHO_MISS = "ECHO_MISS"

/**
 * Resolve a step's text: an `echo` step answers out of the prompt it was given,
 * anything else answers with its own `text`. Exported for its unit test.
 */
export function resolveStepText(step: ScriptedStep, options: unknown): string | undefined {
  if (!step.echo) return step.text
  let pattern: RegExp
  try {
    pattern = new RegExp(step.echo)
  } catch {
    return ECHO_MISS
  }
  // The whole call, not just the messages: the ephemeral context blocks the
  // broker injects are part of what the model was shown, and they are what this
  // is looking for. Non-serializable corners are dropped rather than thrown on.
  let serialized = ""
  try {
    serialized = JSON.stringify(options) ?? ""
  } catch {
    serialized = String(options)
  }
  return pattern.exec(serialized)?.[0] ?? ECHO_MISS
}

/** The line an unscripted thread gets. Short, deterministic, never empty. */
export const UNSCRIPTED_REPLY = SCRIPTED_FALLBACK_REPLY

/** Key used when a caller has no thread (auto-title, compaction, consolidation). */
const NO_THREAD_KEY = "__no_thread__"

/** How long a script lives in Redis after it was set. */
export const SCRIPT_TTL_S = 60 * 60

/**
 * Scripts live in Redis, not in this process, so a turn that runs (or resumes)
 * in another process of the cell plays the same script. One hash per script
 * key, `agent:script:<key>`:
 * - `steps`: the steps, as JSON; `len`: how many;
 * - `next`: the first step no turn has played yet;
 * - `t:<turn>`: the step a turn started at (its base). A turn's FIRST call
 *   fixes its base at `next`; every later call of that turn, on any process,
 *   finds the same base. `<turn>` is the turn's id (the message it answers,
 *   when the caller names it) with the prompt's identity: two turns of one
 *   agent asked moments apart read the same history (the newer ask is in the
 *   older turn's prompt too), and keyed on the prompt alone they took one base
 *   and both played the first step.
 * The step a call plays is its turn's base plus the number of assistant steps
 * the turn already has in the call's prompt (`scriptedStepPosition`), never a
 * cursor: a resumed turn re-issues its cut step and plays that same step.
 * `agent:scripts` indexes the keys so they can all be cleared.
 */
const SCRIPT_PREFIX = "agent:script:"
const SCRIPT_INDEX = "agent:scripts"

function scriptRedisKey(key: string): string {
  return `${SCRIPT_PREFIX}${key}`
}

/**
 * Pick the step for one call: KEYS[1] the script hash; ARGV[1] the turn field,
 * ARGV[2] the assistant steps the turn already has. Returns nil when nothing
 * is scripted for the key, else { index, steps JSON }.
 */
const PICK_STEP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local base = redis.call('HGET', KEYS[1], ARGV[1])
if not base then
  base = redis.call('HGET', KEYS[1], 'next') or '0'
  redis.call('HSET', KEYS[1], ARGV[1], base)
end
local index = tonumber(base) + tonumber(ARGV[2])
local len = tonumber(redis.call('HGET', KEYS[1], 'len') or '0')
local nxt = tonumber(redis.call('HGET', KEYS[1], 'next') or '0')
if index < len and index + 1 > nxt then
  redis.call('HSET', KEYS[1], 'next', tostring(index + 1))
end
return { index, redis.call('HGET', KEYS[1], 'steps') or '[]' }
`

async function writeScript(key: string, steps: ScriptedStep[]): Promise<void> {
  const redisKey = scriptRedisKey(key)
  await redis
    .multi()
    .del(redisKey)
    .hset(redisKey, { steps: JSON.stringify(steps), len: String(steps.length), next: "0" })
    .expire(redisKey, SCRIPT_TTL_S)
    .sadd(SCRIPT_INDEX, key)
    .expire(SCRIPT_INDEX, SCRIPT_TTL_S)
    .exec()
}

/**
 * `LIAISON_MODEL_PROVIDER` — the lane flag for this provider. The only value
 * that means anything is `"scripted"`; anything else (including absent) leaves
 * the normal provider path alone. It is set by the Playwright worker env
 * (`packages/test-helpers/src/worker-env.ts`) and must never be set in dev or
 * prod. Read straight off `process.env` rather than declared in `lib/env.ts`,
 * the way `resolveAnthropicCacheTtl` reads `LIAISON_ANTHROPIC_CACHE_TTL` in
 * `context.ts` — and read per call, so a test can flip it around an import
 * without a module-cache dance.
 */
export function scriptedModelEnabled(): boolean {
  return process.env.LIAISON_MODEL_PROVIDER === "scripted"
}

/** Register (replacing) the script for a thread. Steps are played in order,
 *  across as many turns as the scenario sends. */
export async function setScriptedTurn(
  threadId: string | null | undefined,
  steps: ScriptedStep[],
): Promise<void> {
  await writeScript(threadId ?? NO_THREAD_KEY, steps)
}

/** Register a script for `key` unless one is there (the load harness's turns,
 *  load-scripts.ts: every call of a thread finds the same script). */
export async function setScriptedTurnIfAbsent(key: string, steps: ScriptedStep[]): Promise<void> {
  if ((await redis.exists(scriptRedisKey(key))) > 0) return
  await writeScript(key, steps)
}

/** The key a routine's script is stored under. A routine run gets its own
 *  output thread, created by the worker after `run-now`, so a scenario cannot
 *  name that thread in advance; it scripts the ROUTINE instead. */
function routineKey(routineId: string): string {
  return `routine:${routineId}`
}

/** Register (replacing) the script every run of `routineId` replays when its
 *  run thread has no script of its own. Test-only, like `setScriptedTurn`. */
export async function setScriptedRoutine(routineId: string, steps: ScriptedStep[]): Promise<void> {
  await writeScript(routineKey(routineId), steps)
}

/**
 * Which script a turn replays, or null for the normal provider path: the
 * thread's own script first, then its routine's (a routine run's thread is
 * created by the worker, so only the routine id is known to the test).
 */
export async function scriptKeyFor(
  threadId: string | null | undefined,
  routineId?: string | null,
): Promise<string | null> {
  if (await hasScriptedTurn(threadId)) return threadId ?? NO_THREAD_KEY
  if (routineId && (await redis.exists(scriptRedisKey(routineKey(routineId)))) > 0) {
    return routineKey(routineId)
  }
  return null
}

/** Whether a script was registered for this key at all. The provider takes a
 *  turn over ONLY for such a key: an unscripted thread keeps the normal path,
 *  so turning the lane's env var on changes nothing until a test scripts
 *  something. Once registered, a key stays registered even after its last step
 *  is read, which is what makes the fixed fallback line reachable. */
export async function hasScriptedTurn(threadId: string | null | undefined): Promise<boolean> {
  return (await redis.exists(scriptRedisKey(threadId ?? NO_THREAD_KEY))) > 0
}

/** Drop one thread's or routine's script, or every script when neither is named. */
export async function clearScriptedTurns(
  threadId?: string | null,
  routineId?: string | null,
): Promise<void> {
  const keys: string[] = []
  if (routineId) keys.push(routineKey(routineId))
  if (threadId) keys.push(threadId)
  if (!threadId && !routineId) {
    keys.push(...(await redis.smembers(SCRIPT_INDEX)), NO_THREAD_KEY)
    await redis.del(SCRIPT_INDEX)
  }
  if (keys.length === 0) return
  await redis.del(...keys.map(scriptRedisKey))
  await redis.srem(SCRIPT_INDEX, ...keys)
}

/** Test/diagnostic view: how many steps of a thread's script no turn has played yet. */
export async function remainingScriptedSteps(threadId: string | null | undefined): Promise<number> {
  const [len, next] = await redis.hmget(scriptRedisKey(threadId ?? NO_THREAD_KEY), "len", "next")
  return Math.max(0, Number(len ?? 0) - Number(next ?? 0))
}

type PromptMessage = { role?: unknown; content?: unknown }

function promptOf(options: unknown): PromptMessage[] {
  if (!options || typeof options !== "object" || !("prompt" in options)) return []
  const prompt = options.prompt
  return Array.isArray(prompt) ? prompt : []
}

/**
 * The id prefix of every tool call this provider emits. The `.` keeps the ids
 * outside the portable id alphabet (`[A-Za-z0-9_-]`, PORTABLE_TOOL_CALL_ID_RE in
 * context.ts), so the thread history replays an earlier turn's calls under
 * rewritten ids while the turn's own steps (and a resume's journal) keep these:
 * that is what lets `scriptedStepPosition` stop counting at the turn's start.
 */
export const SCRIPTED_CALL_PREFIX = "scripted-call."

/** Does this assistant message carry a tool call this provider emitted? */
function isScriptedStep(message: PromptMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false
  return message.content.some(
    (part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      "toolCallId" in part &&
      typeof part.toolCallId === "string" &&
      part.toolCallId.startsWith(SCRIPTED_CALL_PREFIX),
  )
}

/** The turn's ephemeral runtime-context tail (context.ts RUNTIME_TAIL_OPEN). */
function isRuntimeTail(message: PromptMessage): boolean {
  if (message.role !== "user") return false
  const content = message.content as unknown
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find(
            (p): p is { type: "text"; text: string } =>
              typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
          )?.text ?? "")
        : ""
  return text.startsWith(RUNTIME_TAIL_OPEN)
}

/**
 * Where a call stands in its turn, read off the prompt it received.
 *
 * The steps this turn already completed are the assistant messages at the end
 * of the prompt that carry a tool call THIS provider emitted (`scripted-call-`
 * ids), user and tool messages in between skipped: the loop injects user-role
 * notes between steps (step budget, guide, mid-turn skills, events, the
 * runtime context). A turn's steps keep those ids, including when a resume
 * replays its journal; earlier turns come back from the thread history with
 * rewritten ids (the prefix is not a portable id, SCRIPTED_CALL_PREFIX), and a
 * step with no tool call ends a turn, so the count stops at the turn's start.
 *
 * `turn` identifies the turn: how many history assistant messages precede it,
 * how many user messages open it (a follow-up sent during an earlier turn adds
 * one), and the first of them (the person's message). Exported for its unit test.
 */
export function scriptedStepPosition(options: unknown): { stepsSoFar: number; turn: string } {
  const prompt = promptOf(options)
  let stepsSoFar = 0
  let boundary = -1
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]
    if (message?.role !== "assistant") continue
    if (!isScriptedStep(message)) {
      boundary = i
      break
    }
    stepsSoFar++
  }
  let history = 0
  for (let i = 0; i <= boundary; i++) if (prompt[i]?.role === "assistant") history++
  const opening = prompt.slice(boundary + 1).find((m) => m.role === "user")
  let content = ""
  try {
    content = JSON.stringify(opening?.content ?? null) ?? ""
  } catch {
    content = String(boundary)
  }
  // The user messages that open the turn, up to its first step or its runtime
  // tail (on a first call the tail and the per-step notes after it sit before
  // any step; later calls move them after the steps): a follow-up sent while
  // an earlier turn still answers shares that turn's history and first
  // message, and only this count tells the two apart.
  let leading = 0
  for (const m of prompt.slice(boundary + 1)) {
    if (m.role === "assistant" || isRuntimeTail(m)) break
    if (m.role === "user") leading++
  }
  const turn = createHash("sha256")
    .update(`${history}:${leading}:${content}`)
    .digest("hex")
    .slice(0, 24)
  return { stepsSoFar, turn }
}

/** The error a scripted `streamFailure` play ends with: an upstream that stopped mid-body. */
export function scriptedStreamDrop(): APICallError {
  return new APICallError({
    message: "Failed to process successful response",
    url: "https://scripted.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 200,
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    isRetryable: false,
  })
}

/** Whether this play of a `streamFailure` step is one that breaks off. */
async function playBreaksOff(
  threadId: string | null | undefined,
  turnId: string | null | undefined,
  options: unknown,
  step: ScriptedStep,
  index: number,
): Promise<boolean> {
  const failure = step.streamFailure
  if (!failure || index < 0) return false
  const { turn } = scriptedStepPosition(options)
  const plays = await redis.hincrby(
    scriptRedisKey(threadId ?? NO_THREAD_KEY),
    `fail:${turnField(turnId, turn)}:${index}`,
    1,
  )
  return plays <= failure.times
}

/** The script hash field naming one turn: its id when known, with its prompt identity. */
function turnField(turnId: string | null | undefined, turn: string): string {
  return turnId ? `${turnId}:${turn}` : turn
}

async function nextStep(
  threadId: string | null | undefined,
  turnId: string | null | undefined,
  options: unknown,
): Promise<{ step: ScriptedStep; index: number }> {
  const { stepsSoFar, turn } = scriptedStepPosition(options)
  const res = await redis.eval(
    PICK_STEP_LUA,
    1,
    scriptRedisKey(threadId ?? NO_THREAD_KEY),
    `t:${turnField(turnId, turn)}`,
    String(stepsSoFar),
  )
  if (!Array.isArray(res)) return { step: { text: UNSCRIPTED_REPLY }, index: -1 }
  const index = Number(res[0])
  const steps: unknown = JSON.parse(String(res[1]))
  const step = Array.isArray(steps) ? steps[index] : undefined
  if (!step || typeof step !== "object") return { step: { text: UNSCRIPTED_REPLY }, index: -1 }
  return { step: step as ScriptedStep, index }
}

/**
 * The test tools a step's `toolDelayMs` reaches: their calls get it as their
 * `waitMs` argument, so the tool waits inside its own execution (a turn cut
 * mid-tool). Registered by test-support only (`harness/test-effect-tools.ts`).
 */
const WAITING_TEST_TOOLS = /^kernel__test_(effect_then_wait|wait_then_effect)$/

function argsFor(step: ScriptedStep, call: { name: string; args?: unknown }): unknown {
  const args = call.args ?? {}
  if (step.toolDelayMs === undefined || !WAITING_TEST_TOOLS.test(call.name)) return args
  if (typeof args !== "object" || Array.isArray(args) || args === null) return args
  return { waitMs: step.toolDelayMs, ...args }
}

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
}

/** A step that called tools finishes with `tool-calls` so the agent loop runs
 *  them and comes back; a step with only text finishes the turn. The v3 spec
 *  carries the reason as `{ unified, raw }` — a bare string is silently treated
 *  as "not tool-calls" and the loop DROPS the pending tool calls. */
function finishReasonFor(toolCallCount: number) {
  const unified = toolCallCount > 0 ? ("tool-calls" as const) : ("stop" as const)
  return { unified, raw: unified }
}

/** Expand one step into provider stream parts, in the step's own order:
 *  reasoning first, then tool calls, then text. */
function partsForStep(step: ScriptedStep, seq: number, text: string | undefined): StreamPart[] {
  const parts: StreamPart[] = []
  if (step.reasoning) {
    const id = `scripted-reasoning-${seq}`
    parts.push({ type: "reasoning-start", id })
    parts.push({ type: "reasoning-delta", id, delta: step.reasoning })
    parts.push({ type: "reasoning-end", id })
  }
  const toolCalls = step.toolCalls ?? []
  toolCalls.forEach((call, i) => {
    const toolCallId = `${SCRIPTED_CALL_PREFIX}${seq}-${i}`
    const input = JSON.stringify(argsFor(step, call))
    parts.push({ type: "tool-input-start", id: toolCallId, toolName: call.name })
    parts.push({ type: "tool-input-delta", id: toolCallId, delta: input })
    parts.push({ type: "tool-input-end", id: toolCallId })
    parts.push({ type: "tool-call", toolCallId, toolName: call.name, input })
  })
  if (text) {
    const id = `scripted-text-${seq}`
    parts.push({ type: "text-start", id })
    parts.push({ type: "text-delta", id, delta: text })
    parts.push({ type: "text-end", id })
  }
  parts.push({ type: "finish", usage: USAGE, finishReason: finishReasonFor(toolCalls.length) })
  return parts
}

/** Content blocks for the non-streaming path, mirroring `partsForStep`. */
function contentForStep(step: ScriptedStep, seq: number, text: string | undefined) {
  const content: Array<Record<string, unknown>> = []
  if (step.reasoning) content.push({ type: "reasoning", text: step.reasoning })
  for (const [i, call] of (step.toolCalls ?? []).entries()) {
    content.push({
      type: "tool-call",
      toolCallId: `${SCRIPTED_CALL_PREFIX}${seq}-${i}`,
      toolName: call.name,
      input: JSON.stringify(argsFor(step, call)),
    })
  }
  if (text) content.push({ type: "text", text })
  return content
}

let turnSeq = 0

/**
 * Build the scripted model for one turn. `threadId` selects which script the
 * turn replays; a model built without one (auto-title, compaction) always gets
 * the unscripted line. `turnId` (the message the turn answers) tells apart two
 * turns whose prompts are the same.
 */
export function createScriptedModel(
  threadId?: string | null,
  turnId?: string | null,
): ScriptedLanguageModel {
  const modelId = "scripted-e2e"
  return {
    specificationVersion: "v3",
    provider: "scripted",
    modelId,
    supportedUrls: {},

    async doGenerate(options: unknown) {
      const { step, index } = await nextStep(threadId, turnId, options)
      const seq = turnSeq++
      const text = resolveStepText(step, options)
      if (step.delayMs) await Bun.sleep(step.delayMs)
      log.info(
        { threadId: threadId ?? null, stepIndex: index, tools: (step.toolCalls ?? []).length },
        "scripted_model_turn",
      )
      return {
        content: contentForStep(step, seq, text),
        finishReason: finishReasonFor((step.toolCalls ?? []).length),
        usage: USAGE,
        warnings: [],
      }
    },

    async doStream(options: unknown) {
      const { step, index } = await nextStep(threadId, turnId, options)
      const seq = turnSeq++
      const breaksOff = await playBreaksOff(threadId, turnId, options, step, index)
      const text = breaksOff ? step.streamFailure?.partial : resolveStepText(step, options)
      log.info(
        {
          threadId: threadId ?? null,
          stepIndex: index,
          tools: (step.toolCalls ?? []).map((t) => t.name),
          hasText: Boolean(text),
          echoed: Boolean(step.echo),
          hasReasoning: Boolean(step.reasoning),
          breaksOff,
        },
        "scripted_model_turn",
      )
      const stream = new ReadableStream<StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({
            type: "response-metadata",
            id: `scripted-${seq}`,
            modelId,
            timestamp: new Date(),
          })
          if (step.delayMs) await Bun.sleep(step.delayMs)
          for (const part of partsForStep(step, seq, text)) {
            if (breaksOff && part.type === "finish") {
              controller.enqueue({ type: "error", error: scriptedStreamDrop() })
              break
            }
            controller.enqueue(part)
          }
          controller.close()
        },
      })
      return { stream }
    },
  }
}
