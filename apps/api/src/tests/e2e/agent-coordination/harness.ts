// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T15: the real model harness for the agent coordination slice.
//
// The blueprint's one allowed exception to the gestalt rule "a walk is DRIVEN,
// never built": these scenarios need real models, and a real model is not a
// thing you click through by hand six times, three times over, to get a
// standard deviation. So the harness stays MINIMAL: it seeds a fixture, posts
// a human message, lets the PRODUCTION dispatch do everything else, and reads
// rows back. It contains no model behaviour of its own, stubs nothing, and
// asserts nothing: the scenarios assert, the database answers.
//
// One org per scenario, torn down at the end of the run (the gestalt rule:
// walk artifacts are removed), in `liaison_hardening_test` and nowhere else.
import { generateText } from "ai"
import { z } from "zod"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { resolveModel } from "~/modules/agent/providers/provider"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { type AgentsAskResult, handleAgentsAsk } from "~/modules/agent/tools/coordination-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  type DispatchVerdict,
  dispatchAgentMention,
  evaluateAgentDispatch,
} from "~/modules/threads/agent-dispatch-guard"
import { sendMessage } from "~/modules/threads/message"
import { resolveLiveAgentIds } from "~/modules/threads/participant"
import {
  callAgentSdkJudge,
  type JudgePath,
  type ProviderJudgeResult,
  runJudge,
  type SdkJudgeCall,
} from "./sdk-judge"

/** The kernel schema as a quoted identifier, under the test namespace's prefix. */
const K = () => sql(schemaRef("kernel"))

/** The agents' model, by its id in the shared catalog. */
export const AGENT_MODEL_ID = "gemini-flash-lite-latest"
/** The judge, when the org's Anthropic key is present. */
export const JUDGE_MODEL_ANTHROPIC = "claude-opus-4-6"
/** The judge otherwise, on the same Google key the agents use. */
export const JUDGE_MODEL_GOOGLE = "gemini-pro-latest"

/** The scope the invoice lookup needs. Real scope, real projection gate. */
export const INVOICE_SCOPE = "app_ledger:invoices:read"
export const SHIPMENT_SCOPE = "app_courier:shipments:read"
const KERNEL_SCOPE = "kernel"

/** The figure only the tool knows. No agent prompt carries it. */
export const INVOICE_REFERENCE = "INV-2026-0042"
export const INVOICE_TOTAL = "4127.60"
export const INVOICE_CURRENCY = "EUR"

/** The human in every scenario. A stand in name: the report is PII free. */
const HUMAN_NAME = "Robin"

export interface AgentRow {
  id: string
  handle: string
  displayName: string
  ceiling: string[]
}

export interface Fixture {
  label: string
  orgId: string
  userId: string
  userName: string
  /** The room the scenario runs in. */
  threadId: string
  alex: AgentRow
  finance: AgentRow
  logistics: AgentRow
  invoiceScope: string
  invoiceReference: string
  invoiceTotal: string
  /** The human's own grants, as the dispatch actor carries them. */
  humanScopes: string[]
}

export interface SeedOptions {
  label: string
  /** Vary ONE ceiling: that is the whole point of a fixture function. */
  alexCeiling?: string[]
  alexPrompt?: string
  financePrompt?: string
  logisticsPrompt?: string
  /** Seat these agents in the room up front. Default: Alex alone. */
  seated?: Array<"alex" | "finance" | "logistics">
}

function alexDefaultPrompt(): string {
  return [
    `You are Alex, the personal assistant of ${HUMAN_NAME}.`,
    "You keep no financial records of your own and you never guess a number.",
    'When the question is about an invoice, an amount or any accounting figure, call agents_ask with agentHandle "@finance" and pass the question as it was asked.',
    "Wait for the answer, then reply in one or two sentences with the figure exactly as the finance agent gave it.",
    'Your reply MUST name where the figure came from, in these words: "the finance agent reports".',
    'If the finance agent cannot answer, reply with exactly this sentence and nothing else: "I could not get that figure."',
    "Never mention tools, permissions, capabilities or access levels in a reply to a person.",
  ].join(" ")
}

/**
 * The finance agent as a KNOWLEDGE holder: the figure is in its own prompt and
 * nowhere else in the org. A4 means a delegated turn can never hold MORE scope
 * than its caller, so what one agent has and another lacks is knowledge and
 * tools, never permission: the only way Alex can reach this figure is to ask.
 */
export function financeLedgerPrompt(): string {
  return [
    "You are the finance agent. You keep the invoice ledger.",
    `Your ledger says: invoice ${INVOICE_REFERENCE} totals ${INVOICE_TOTAL} ${INVOICE_CURRENCY}.`,
    "Answer in one sentence with the exact figure and currency from your ledger.",
    "If an invoice is not in your ledger, say so in one sentence and state no amount.",
    "You answer yourself: never call agents_ask.",
  ].join(" ")
}

function financeDefaultPrompt(): string {
  return [
    "You are the finance agent. You answer questions about invoices.",
    // The tool is described, never NAMED: a machine name written into an
    // agent's own prompt comes back out of it, and a relayed decline then
    // carries that name to a person (observed, recorded in the findings).
    "To find an invoice total, use the invoice lookup tool available to you, passing the invoice reference.",
    "Answer in one sentence with the exact figure and currency the tool returned.",
    'If that tool is not available to you in this turn, reply with exactly this sentence and nothing else: "I cannot reach the invoicing records right now."',
    "You answer yourself: never call agents_ask.",
  ].join(" ")
}

function logisticsDefaultPrompt(): string {
  return [
    "You are the logistics agent. You answer questions about shipments and deliveries.",
    `Begin every reply with "${HUMAN_NAME}," and then answer in one or two sentences.`,
    "Answer from what you know; do not pass the question to another agent, and never call agents_ask.",
  ].join(" ")
}

/**
 * The invoice ledger the fixture tool reads. Per org, so one scenario's figure
 * can never leak into another's, and the figure lives in exactly one place: a
 * tool the scope projection can take away.
 */
const invoiceLedger = new Map<string, { reference: string; total: string; currency: string }>()

function registerLedgerTool(orgId: string): void {
  toolRegistry.set([orgId, "ledger", "invoice_total"], {
    appName: "ledger",
    name: "invoice_total",
    description:
      "Look up the total amount of one invoice by its reference (for example INV-2026-0042). Returns the reference, the total and the currency.",
    requiredScopes: [INVOICE_SCOPE],
    params: z.object({ reference: z.string().min(3).max(64) }),
    handler: async (params: unknown, ctx: unknown) => {
      const { reference } = params as { reference: string }
      const row = invoiceLedger.get((ctx as { orgId: string }).orgId)
      if (!row || row.reference.toUpperCase() !== reference.trim().toUpperCase()) {
        return { found: false }
      }
      return { found: true, reference: row.reference, total: row.total, currency: row.currency }
    },
    readOnly: true,
    // Kept hot: this is the fixture's data source, not a discovery exercise.
    // The deferred-tool loop has its own live test; measuring it again here
    // would only add a tool_search step to every token number below.
    deferLoading: false,
  })
}

function registerCourierTool(orgId: string): void {
  toolRegistry.set([orgId, "courier", "shipment_status"], {
    appName: "courier",
    name: "shipment_status",
    description: "Look up the delivery status of one shipment by its tracking reference.",
    requiredScopes: [SHIPMENT_SCOPE],
    params: z.object({ reference: z.string().min(3).max(64) }),
    handler: async () => ({
      found: true,
      status: "delivered",
      deliveredOn: "2026-09-02",
    }),
    readOnly: true,
    deferLoading: false,
  })
}

async function seedModelPricing(): Promise<void> {
  const rows: Array<[string, string, string, string, string, number, boolean]> = [
    ["google", AGENT_MODEL_ID, "Gemini Flash-Lite", "0.09", "0.35", 1048576, true],
    ["google", JUDGE_MODEL_GOOGLE, "Gemini Pro", "1.09", "8.70", 1048576, false],
    ["anthropic", JUDGE_MODEL_ANTHROPIC, "Claude Opus 4.6", "4.35", "21.74", 1000000, false],
  ]
  for (const [provider, modelId, name, inCost, outCost, ctxWindow, auto] of rows) {
    await sql`INSERT INTO ${K()}.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES (${provider}, ${modelId}, ${name}, ${inCost}, ${outCost}, ${ctxWindow}, ${auto}, 'starter')
      ON CONFLICT (provider, model_id) DO NOTHING`
  }
}

/**
 * One org, one human, three agents, one room. A function, never a snapshot:
 * a scenario varies one ceiling or one prompt and gets a clean world for it.
 */
export async function seedFixture(opts: SeedOptions): Promise<Fixture> {
  const orgId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const tag = orgId.slice(0, 8)
  const humanScopes = [KERNEL_SCOPE, INVOICE_SCOPE, SHIPMENT_SCOPE]

  const alex: AgentRow = {
    id: crypto.randomUUID(),
    handle: "@alexs-agent",
    displayName: "Alex",
    ceiling: opts.alexCeiling ?? [KERNEL_SCOPE, INVOICE_SCOPE, SHIPMENT_SCOPE],
  }
  const finance: AgentRow = {
    id: crypto.randomUUID(),
    handle: "@finance",
    displayName: "Finance",
    ceiling: [KERNEL_SCOPE, INVOICE_SCOPE],
  }
  const logistics: AgentRow = {
    id: crypto.randomUUID(),
    handle: "@logistics",
    displayName: "Logistics",
    ceiling: [KERNEL_SCOPE, SHIPMENT_SCOPE],
  }

  // The fixture exists BEFORE the first insert, so a seed that throws half way
  // through is torn down by the same function the happy path uses. It used to
  // exist only once the seed RETURNED, and every row a failed seed had already
  // written stayed in the database for good (the gestalt rule is that walk
  // artifacts do not survive the walk, and a failed walk is still a walk).
  // Every delete keys on `org_id`, so the thread id filled in below is not
  // needed for the teardown to be complete.
  const fixture: Fixture = {
    label: opts.label,
    orgId,
    userId,
    userName: HUMAN_NAME,
    threadId: "",
    alex,
    finance,
    logistics,
    invoiceScope: INVOICE_SCOPE,
    invoiceReference: INVOICE_REFERENCE,
    invoiceTotal: INVOICE_TOTAL,
    humanScopes,
  }

  try {
    await seedModelPricing()
    await sql`INSERT INTO ${K()}.organizations (id, name, slug)
      VALUES (${orgId}, ${`Coord ${opts.label}`}, ${`p3b-${opts.label}-${tag}`})`
    await sql`INSERT INTO ${K()}.users (id, org_id, email, name, status)
      VALUES (${userId}, ${orgId}, ${`p3b-${tag}@example.test`}, ${HUMAN_NAME}, 'active')`
    const roleId = crypto.randomUUID()
    await sql`INSERT INTO ${K()}.roles (id, org_id, name) VALUES (${roleId}, ${orgId}, 'coord-operator')`
    for (const scope of humanScopes) {
      await sql`INSERT INTO ${K()}.role_scope_grants (role_id, scope) VALUES (${roleId}, ${scope})`
    }
    await sql`INSERT INTO ${K()}.user_roles (user_id, role_id, org_id) VALUES (${userId}, ${roleId}, ${orgId})`
    await sql`INSERT INTO ${K()}.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '100.00000000', '0', 'EUR')`

    await sql`INSERT INTO ${K()}.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
      VALUES (${alex.id}, ${orgId}, 'personal', ${alex.handle}, ${alex.displayName}, ${userId},
              ${JSON.stringify(alex.ceiling)}::text::jsonb, ${opts.alexPrompt ?? alexDefaultPrompt()})`
    await sql`INSERT INTO ${K()}.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${finance.id}, ${orgId}, 'role', ${finance.handle}, ${finance.displayName},
              ${JSON.stringify(finance.ceiling)}::text::jsonb, ${opts.financePrompt ?? financeDefaultPrompt()})`
    await sql`INSERT INTO ${K()}.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${logistics.id}, ${orgId}, 'role', ${logistics.handle}, ${logistics.displayName},
              ${JSON.stringify(logistics.ceiling)}::text::jsonb, ${opts.logisticsPrompt ?? logisticsDefaultPrompt()})`

    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO ${K()}.threads (org_id, handle, type, agent_model_id, created_by)
      VALUES (${orgId}, ${`coord-${opts.label}-${tag}`}, 'thread', ${AGENT_MODEL_ID}, ${userId})
      RETURNING id`
    fixture.threadId = thread.id
    await sql`INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id)
      VALUES (${thread.id}, ${userId}, ${orgId})`
    const byName = { alex, finance, logistics }
    for (const name of opts.seated ?? ["alex"]) {
      await sql`INSERT INTO ${K()}.thread_participants (thread_id, agent_id, org_id, participant_type)
        VALUES (${thread.id}, ${byName[name].id}, ${orgId}, 'agent')`
    }

    invoiceLedger.set(orgId, {
      reference: INVOICE_REFERENCE,
      total: INVOICE_TOTAL,
      currency: INVOICE_CURRENCY,
    })
    await ensureAppsForOrg(orgId)
    // The `example` fixture app's sandbox bundle cannot load in this env; a model
    // that picks it gets a hard error through no fault of this slice.
    toolRegistry.deleteByPrefix([orgId, "example"])
    registerLedgerTool(orgId)
    registerCourierTool(orgId)
  } catch (err) {
    // The seed's own failure is what the caller must see, so a teardown that
    // fails on top of it is logged and swallowed rather than replacing it.
    await teardownFixture(fixture).catch((cleanupErr) => {
      console.log(`[p3b-harness] teardown after a failed seed also failed: ${cleanupErr}`)
    })
    throw err
  }

  return fixture
}

/** Everything this fixture created, removed. Walk artifacts do not survive. */
export async function teardownFixture(f: Fixture | undefined): Promise<void> {
  if (!f) return
  invoiceLedger.delete(f.orgId)
  toolRegistry.deleteByPrefix([f.orgId])
  await sql`DELETE FROM ${K()}.messages WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.thread_participants WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.threads WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.agents WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.user_roles WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.role_scope_grants WHERE role_id IN
    (SELECT id FROM ${K()}.roles WHERE org_id = ${f.orgId})`
  await sql`DELETE FROM ${K()}.roles WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.credit_transactions WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.credit_balances WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.users WHERE org_id = ${f.orgId}`
  await sql`DELETE FROM ${K()}.organizations WHERE id = ${f.orgId}`
}

function humanActor(f: Fixture): UserContext {
  return {
    actorType: "user",
    userId: f.userId,
    orgId: f.orgId,
    scopes: f.humanScopes,
    dimensionGrants: {},
  }
}

/** The mention token the message writer parses. */
export function mention(agent: AgentRow): string {
  return `@[${agent.displayName}](agent:${agent.id})`
}

/**
 * A human posts, exactly as the threads route does it: one `sendMessage`, then
 * the ONE dispatch path per live mentioned agent. Awaits every turn it started,
 * because a scenario that asserts before the turn lands asserts nothing.
 */
export async function humanSays(
  f: Fixture,
  content: string,
  opts: { threadId?: string } = {},
): Promise<string> {
  const threadId = opts.threadId ?? f.threadId
  const actor = humanActor(f)
  const msg = await withRlsContext(actor, (db) =>
    sendMessage(db, {
      orgId: f.orgId,
      userId: f.userId,
      threadId,
      content,
      authorType: "user",
      requiredScopes: [],
    }),
  )
  if (!msg) throw new Error("the human message was not persisted")

  const mentioned = Array.isArray(msg.mentions)
    ? [
        ...new Set(
          (msg.mentions as Array<{ type: string; id?: string }>)
            .filter((m) => m.type === "agent" && typeof m.id === "string")
            .map((m) => m.id as string),
        ),
      ]
    : []
  const live = new Set(
    await withRlsContext(actor, (db) =>
      resolveLiveAgentIds(db, { orgId: f.orgId, agentIds: mentioned }),
    ),
  )
  for (const agentId of mentioned) {
    if (!live.has(agentId)) continue
    const outcome = await dispatchAgentMention((fn) => withRlsContext(actor, fn), {
      orgId: f.orgId,
      threadId,
      calleeAgentId: agentId,
      callerAgentId: null,
      parentMessageId: null,
      triggerMessageId: msg.id,
      questionText: msg.content,
      actor: {
        userId: f.userId,
        orgId: f.orgId,
        scopes: f.humanScopes,
        dimensionGrants: {},
      },
      adderName: f.userName,
    })
    if (outcome.allowed) await outcome.turn
  }
  return msg.id
}

/**
 * ONE ask, driven by the harness rather than by the model, inside the turn
 * frame a real turn opens.
 *
 * The deterministic seam. A live agent is free to decline to ask, and a
 * scenario about what happens when the SAME question is asked twice cannot be
 * built on a model's willingness to repeat itself. So the caller's frame is
 * opened here exactly as the tool bridge opens it and the production
 * `handleAgentsAsk` is called: the callee's turn, the guard, the dedupe and the
 * persistence are all the real ones, and only the decision to ask is the
 * harness's.
 */
export async function askAsAgent(
  f: Fixture,
  params: {
    caller: AgentRow
    agentHandle: string
    question: string
    /** The caller's own turn message: the question hangs under it. */
    turnMessageId: string
    threadId?: string
  },
): Promise<AgentsAskResult> {
  const runId = crypto.randomUUID()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId: params.caller.id,
    agentCeiling: params.caller.ceiling,
    // Every real agent turn computes this before its tool catalog is built, and
    // the dispatch refuses without it (A4).
    effectiveScope: params.caller.ceiling,
    turnScopeAccumulator: createTurnScopeAccumulator(),
    turnMessageId: params.turnMessageId,
  }
  return withRlsContext(humanActor(f), (db) =>
    runContextStore.run(frame, () =>
      handleAgentsAsk(
        { agentHandle: params.agentHandle, question: params.question },
        {
          userId: f.userId,
          orgId: f.orgId,
          db,
          agentExecutionThreadId: params.threadId ?? f.threadId,
          scopes: f.humanScopes,
          actingAgentId: params.caller.id,
        },
      ),
    ),
  )
}

export interface MessageRow {
  id: string
  parentMessageId: string | null
  authorType: string
  authorAgentId: string | null
  content: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

/** Every row the scenario wrote, oldest first. */
export async function readMessages(f: Fixture, threadId?: string): Promise<MessageRow[]> {
  const rows = await sql<
    Array<{
      id: string
      parent_message_id: string | null
      author_type: string
      author_agent_id: string | null
      content: string
      metadata: Record<string, unknown> | null
      created_at: string
    }>
  >`
    SELECT id, parent_message_id, author_type, author_agent_id, content, metadata, created_at
    FROM ${K()}.messages
    WHERE org_id = ${f.orgId} AND thread_id = ${threadId ?? f.threadId} AND deleted_at IS NULL
    ORDER BY created_at ASC, id ASC`
  return rows.map((r) => ({
    id: r.id,
    parentMessageId: r.parent_message_id,
    authorType: r.author_type,
    authorAgentId: r.author_agent_id,
    content: r.content,
    metadata: r.metadata,
    createdAt: r.created_at,
  }))
}

/** Every tool call one agent message's turn recorded, args included. */
export function toolCallsOf(
  row: MessageRow,
): Array<{ toolName: string; args: unknown; result: unknown }> {
  const calls = (
    row.metadata as {
      toolCalls?: Array<{ toolName?: string; args?: unknown; result?: unknown }>
    } | null
  )?.toolCalls
  return (calls ?? []).map((c) => ({
    toolName: c.toolName ?? "",
    args: c.args ?? null,
    result: c.result ?? null,
  }))
}

/** The agent seats in this room, as the participant table holds them. */
export async function readAgentParticipants(f: Fixture, threadId?: string): Promise<string[]> {
  const rows = await sql<Array<{ agent_id: string }>>`
    SELECT agent_id FROM ${K()}.thread_participants
    WHERE org_id = ${f.orgId} AND thread_id = ${threadId ?? f.threadId}
      AND participant_type = 'agent' AND agent_id IS NOT NULL`
  return rows.map((r) => r.agent_id)
}

/** The tool names one agent message's turn actually called. */
export function toolNamesOf(row: MessageRow): string[] {
  const calls = (row.metadata as { toolCalls?: Array<{ toolName?: string }> } | null)?.toolCalls
  return (calls ?? []).map((c) => c.toolName ?? "")
}

/**
 * The result ONE tool call on this turn returned, as the turn persisted it.
 *
 * `executeTool` wraps a handler's value in an envelope; the envelope shape is
 * not this slice's business, so the raw result is unwrapped one level when it
 * carries a `data` key and handed back as it is otherwise.
 */
export function toolResultOf(row: MessageRow, toolName: string): unknown {
  const calls = (
    row.metadata as { toolCalls?: Array<{ toolName?: string; result?: unknown }> } | null
  )?.toolCalls
  const call = (calls ?? []).find((c) => c.toolName === toolName)
  const result = call?.result ?? null
  if (result && typeof result === "object" && "data" in (result as Record<string, unknown>)) {
    return (result as { data: unknown }).data
  }
  return result
}

/**
 * The guard's own verdict on a chain the live run actually wrote.
 *
 * A model is free to decline to ask; the GUARD is not free to decline to
 * refuse. So a scenario reads the rows the live agents produced and asks the
 * production guard what it would do with the next link, which is the same call
 * `agents_ask` makes and is deterministic on a fixed chain.
 */
export async function guardVerdict(
  f: Fixture,
  params: {
    parentMessageId: string | null
    callerAgentId: string | null
    calleeAgentId: string
    questionText: string
    threadId?: string
  },
): Promise<DispatchVerdict> {
  return withRlsContext(humanActor(f), (db) =>
    evaluateAgentDispatch(db, {
      orgId: f.orgId,
      threadId: params.threadId ?? f.threadId,
      parentMessageId: params.parentMessageId,
      callerAgentId: params.callerAgentId,
      calleeAgentId: params.calleeAgentId,
      questionText: params.questionText,
    }),
  )
}

/** The judge model this run uses, and the key it runs on. */
export function judgeModelChoice(): { provider: string; modelId: string; apiKey: string } | null {
  const anthropic = process.env.LIAISON_ANTHROPIC_API_KEY
  if (anthropic) {
    return { provider: "anthropic", modelId: JUDGE_MODEL_ANTHROPIC, apiKey: anthropic }
  }
  const google = process.env.GOOGLE_API_KEY
  if (google) return { provider: "google", modelId: JUDGE_MODEL_GOOGLE, apiKey: google }
  return null
}

/** The judge that actually scored, the path it came from, and why not the preferred one. */
export let judgeModelUsed = ""
export let judgePathUsed: JudgePath | "" = ""
export let judgeFallbackReason = ""

/**
 * The SDK grading call, replaceable so a test can prove the selection without
 * spawning the Claude Code CLI. The live run uses the real one.
 */
let sdkJudgeCall: SdkJudgeCall = callAgentSdkJudge
export function setSdkJudgeCall(fn: SdkJudgeCall): void {
  sdkJudgeCall = fn
}
export function resetSdkJudgeCall(): void {
  sdkJudgeCall = callAgentSdkJudge
}

export interface JudgeVerdict {
  score: number
  sentence: string
  /** The exact prompt the judge saw, so a test can prove what it did not see. */
  prompt: string
}

/**
 * The judge sees the rubric and the answer, and nothing else: no assertion
 * text, no expected value, no scenario name. A judge shown the expected figure
 * scores its own recall, not the system's answer.
 */
export function buildJudgePrompt(rubric: string, answer: string): string {
  return [
    "You are grading one reply written by an assistant.",
    "",
    "RUBRIC:",
    rubric,
    "",
    "REPLY:",
    answer,
    "",
    'Answer with one line of JSON only: {"score": <integer 0 to 5>, "why": "<one sentence>"}.',
  ].join("\n")
}

/**
 * The provider layer judge: the fallback, reached only when the Claude Code
 * login refuses every model. It keeps its own second step, because a run must
 * always state which model scored it and a silent swap would hide a dead key.
 */
async function providerJudge(
  choice: { provider: string; modelId: string; apiKey: string },
  prompt: string,
): Promise<ProviderJudgeResult> {
  try {
    const out = await generateText({ model: await resolveModel(choice), prompt, temperature: 0 })
    return { modelId: choice.modelId, text: out.text }
  } catch (err) {
    const google = process.env.GOOGLE_API_KEY
    if (choice.provider !== "anthropic" || !google) throw err
    const reason = `the ${choice.modelId} judge could not run: ${String(err).slice(0, 160)}`
    const used = { provider: "google", modelId: JUDGE_MODEL_GOOGLE, apiKey: google }
    const out = await generateText({ model: await resolveModel(used), prompt, temperature: 0 })
    return { modelId: used.modelId, text: out.text, reason }
  }
}

/**
 * One judgment. The Claude Code login on this machine scores it, through the
 * Claude Agent SDK and with no API key of any kind; the provider layer judge
 * is the fallback, and the run header names whichever one actually scored.
 */
export async function judgeAnswer(params: {
  rubric: string
  answer: string
}): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(params.rubric, params.answer)
  const choice = judgeModelChoice()
  const run = await runJudge({
    prompt,
    sdk: sdkJudgeCall,
    provider: choice ? () => providerJudge(choice, prompt) : null,
  })
  judgeModelUsed = run.modelId
  judgePathUsed = run.path
  judgeFallbackReason = run.fallbackReason
  if (run.fallbackReason) {
    console.log(`[p3b-judge] FELL BACK to ${run.modelId} (${run.path}): ${run.fallbackReason}`)
  }
  const match = run.text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`the judge returned no JSON: ${run.text.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as { score?: unknown; why?: unknown }
  const score = Number(parsed.score)
  if (!Number.isFinite(score)) throw new Error(`the judge returned no score: ${match[0]}`)
  return { score, sentence: String(parsed.why ?? ""), prompt }
}

/** One agent turn's usage, as the turn itself persisted it. */
export interface TurnUsage {
  messageId: string
  agentId: string | null
  modelId: string | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

/**
 * Every agent turn of this scenario, from `messages.metadata.usage` (written
 * by the turn's own finalize). A message with no `usage` block is not a turn:
 * the question `agents_ask` posts is an agent authored row that no model
 * produced, and counting it would invent a turn.
 */
export async function readTurnUsage(f: Fixture, threadId?: string): Promise<TurnUsage[]> {
  const rows = await sql<
    Array<{
      id: string
      author_agent_id: string | null
      metadata: { modelId?: string; usage?: Record<string, number> } | null
    }>
  >`
    SELECT id, author_agent_id, metadata
    FROM ${K()}.messages
    WHERE org_id = ${f.orgId}
      ${threadId ? sql`AND thread_id = ${threadId}` : sql``}
      AND author_type = 'agent'
      AND metadata -> 'usage' IS NOT NULL
    ORDER BY created_at ASC, id ASC`
  return rows.map((r) => ({
    messageId: r.id,
    agentId: r.author_agent_id,
    modelId: r.metadata?.modelId ?? null,
    inputTokens: Number(r.metadata?.usage?.inputTokens ?? 0),
    outputTokens: Number(r.metadata?.usage?.outputTokens ?? 0),
    cachedInputTokens: Number(r.metadata?.usage?.cachedInputTokens ?? 0),
  }))
}

/**
 * The same usage as the credit ledger recorded it, one row per finalize. Read
 * alongside the turn rows so the accounting can be checked against a second
 * persisted source rather than trusted.
 */
export async function readCreditUsage(
  f: Fixture,
): Promise<{ rows: number; inputTokens: number; outputTokens: number }> {
  const rows = await sql<Array<{ input_tokens: number | null; output_tokens: number | null }>>`
    SELECT input_tokens, output_tokens FROM ${K()}.credit_transactions
    WHERE org_id = ${f.orgId} AND input_tokens IS NOT NULL`
  return {
    rows: rows.length,
    inputTokens: rows.reduce((n, r) => n + Number(r.input_tokens ?? 0), 0),
    outputTokens: rows.reduce((n, r) => n + Number(r.output_tokens ?? 0), 0),
  }
}

/** Input plus output, the number the gates below are expressed in. */
export function totalTokens(turns: TurnUsage[]): number {
  return turns.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0)
}

// ---------------------------------------------------------------------------
// The measured gates. Per the calibration rule these are MEASUREMENTS, not
// choices: the numbers below come from three full runs of this suite and the
// gate is max(mean + 3 sd, mean * 1.5). Editing one by hand, without three new
// measurements and a new date, is the defect the third T18a case looks for.
//
// What each one IS matters as much as its value. The first measures the cost of
// coordination and is expressed as a ratio against a control turn, because that
// is the only form in which the number is comparable at all. The second is a
// runaway alarm in absolute tokens and is labelled as one: it catches a loop,
// it does not say what an ask costs.
// ---------------------------------------------------------------------------

/**
 * Ask overhead, as a RATIO: the tokens one `agents_ask` exchange costs BEYOND
 * the callee's own turn and beyond one direct answer turn, divided by what that
 * direct answer turn itself cost. Scenario 1 total minus the finance turn minus
 * a control run in which the human asks the finance agent directly, over the
 * control.
 *
 * A ratio, and not the raw token count, because the raw count is dominated by
 * the weak model's own step size: one extra full context step is about 22,000
 * tokens whatever the coordination did, so an absolute gate calibrated on three
 * samples of it stands a hundred times above the samples and means nothing. The
 * ratio says the thing A30 asks: 100 means the ask exchange costs about one
 * extra answer turn, 10 means it costs a tenth of one.
 *
 * Measured 2026-09-13 on gemini-flash-lite-latest, percent, three runs: 102.23, 1.6, 100.8
 * (overhead 22556 over control 22064; 709 over 44240; 22447 over 22268, the
 * last being the run retained in the gestalt directory).
 * mean 68.21, sd 47.1, gate max(mean + 3 sd, mean * 1.5) rounded up.
 *
 * All three are POSITIVE and none exceeds one extra answer turn: the two modes
 * are the control taking one step (ratio about 100) or two (ratio about 2), and
 * the ask exchange itself costs at most one extra step in either.
 */
export const K_ASK_OVERHEAD_RATIO_PERCENT = 210

/**
 * THE RUNAWAY ALARM, and nothing finer: no scenario may cost more input plus
 * output than this. It is not a measure of what coordination costs (the ratio
 * above is); it is the tripwire for a turn loop that never ends.
 *
 * Measured 2026-09-13 on gemini-flash-lite-latest, three runs: 362879, 283169,
 * 1438900 (the largest scenario total of each of three consecutive runs).
 * mean 694982.67, sd 527034.58, gate max(mean + 3 sd, mean * 1.5) rounded up.
 *
 * The distribution is heavy tailed and the worst scenario is always the ask
 * loop: a weak model that keeps re-reading a long thread costs far more than
 * the coordination does. Three samples of a maximum is a thin estimator, which
 * is exactly why this one alarms rather than measures.
 */
export const K_SCENARIO_TOTAL_TOKENS = 2276087

/** One scenario as the report records it. */
export interface ScenarioReport {
  scenario: string
  verdict: string
  judgeScore: number
  judgeSentence: string
  turns: Array<{
    agent: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
  }>
  total: number
}

export interface RunReport {
  date: string
  agentModelId: string
  judgeModelId: string
  /** Which judge scored it: the Claude Code login, or the provider layer. */
  judgePath: JudgePath
  /** The raw overhead, in tokens, reported beside the ratio it is judged by. */
  askOverhead: number
  /** What one direct answer turn cost in the same run: the ratio's divisor. */
  controlTurnTokens: number
  /** The overhead as a percentage of that control turn. The gated number. */
  askOverheadRatioPercent: number
  askOverheadRatioGatePercent: number
  worstScenarioTotal: number
  scenarioTotalGate: number
  loopCutReason: string
  /** Which guard refused the third link of the two hop chain. */
  thirdLinkReason: string
  /** Empty when the preferred judge ran; the reason it did not otherwise. */
  judgeFallbackReason: string
  scenarios: ScenarioReport[]
}

/**
 * The header line of a run report. It names the judge that ACTUALLY scored and
 * the path it came from, so a run scored by the fallback can never be read as
 * a run scored by the login.
 */
export function reportHeaderLine(report: {
  date: string
  agentModelId: string
  judgeModelId: string
  judgePath: JudgePath
}): string {
  return `Run date: ${report.date}. Agents: \`${report.agentModelId}\`. Judge: \`${report.judgeModelId}\` (path: ${report.judgePath}).`
}

/** Where a run writes its report (the repo's gitignored logs/), from this file rather than from the cwd. */
export function reportDirectory(date: string): string {
  return `${import.meta.dir}/../../../../../../logs/agent-coordination/${date}`
}

/**
 * The run report, in the gestalt run shape: a readable findings page and the
 * same data machine readable. PII free by construction: the fixture's human is
 * a stand in name and no real record is touched.
 */
export async function writeRunReport(report: RunReport): Promise<string> {
  const dir = reportDirectory(report.date)
  const lines: string[] = [
    "# Agent coordination, live model run",
    "",
    reportHeaderLine(report),
    "",
    ...(report.judgeFallbackReason ? [`Judge fallback: ${report.judgeFallbackReason}`, ""] : []),
    "Every scenario below ran against real models through the production dispatch,",
    "the production tool projection and the production message persistence. The",
    "structure was asserted from the database; the judge scored the answer only.",
    "",
    "Scenarios 5 and 6 share one room (6 continues 5), so they report the same",
    "cumulative token table: the invite turn and the mention turn both sit in it.",
    "",
    "| measure | value | gate |",
    "|---|---|---|",
    `| ask overhead (percent of one control turn) | ${report.askOverheadRatioPercent} | ${report.askOverheadRatioGatePercent} |`,
    `| ask overhead (tokens, reported not gated) | ${report.askOverhead} | control turn ${report.controlTurnTokens} |`,
    `| worst scenario total (tokens) | ${report.worstScenarioTotal} | ${report.scenarioTotalGate} |`,
    `| loop cut by | ${report.loopCutReason} | hop_bound or duplicate_ask |`,
    `| third link of the chain refused by | ${report.thirdLinkReason} | a guard refusal |`,
    "",
  ]
  for (const s of report.scenarios) {
    lines.push(
      `## ${s.scenario}`,
      "",
      `Structure: ${s.verdict}. Judge: ${s.judgeScore} of 5. ${s.judgeSentence}`,
      "",
      "| turn | input | output | cached input |",
      "|---|---|---|---|",
      ...s.turns.map(
        (t) => `| ${t.agent} | ${t.inputTokens} | ${t.outputTokens} | ${t.cachedInputTokens} |`,
      ),
      `| total | ${s.total} | | |`,
      "",
    )
  }
  await Bun.write(`${dir}/report.md`, `${lines.join("\n")}\n`)
  await Bun.write(`${dir}/raw.json`, `${JSON.stringify(report, null, 2)}\n`)
  return dir
}
