// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool that tool_search loads is callable on the NEXT STEP of the same turn,
// not on the next turn. Live: a connected MCP server whose tool list was not
// stored yet got it from the dial tool_search makes, so its tools were
// registered after the turn had built its tool set. tool_search answered
// "LOADED: <name>, call it on your next step", the call that followed named a
// tool the turn did not hold, and the model searched again and again until the
// turn's search limit, then answered that it could not run the search. The
// person's "continue" worked, because the next turn built its set after the dial.
//
// Driven through the real agent loop (runAgentChat, tool bridge, executeTool)
// with the scripted model provider: only the model's tokens are scripted.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import {
  clearScriptedTurns,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import { runAgentChat } from "~/modules/agent/runtime/agent-service"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as mcpClientModule from "~/modules/mcp-client/index"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_PROVIDER = process.env.LIAISON_MODEL_PROVIDER

/** The projected name of the late MCP tool, as tool_search reports it. */
const LATE_TOOL = "mcp__notes_notes_search"
/** A deferred app tool registered before the turn starts. */
const EARLY_TOOL = "gizmos__lookup"

let owner: minimal.Session
let agentId: string
let threadId: string
let lateRuns = 0
let earlyRuns = 0

interface TurnTrace {
  text: string
  calls: Array<{ toolName: string }>
  results: Array<{ toolName: string; output: unknown }>
  errors: unknown[]
}

/** Consume a turn's stream the way the chat route does, then persist it. */
async function drive(r: Awaited<ReturnType<typeof runAgentChat>>): Promise<TurnTrace> {
  const trace: TurnTrace = { text: "", calls: [], results: [], errors: [] }
  const steps: Array<{ toolCalls?: unknown[]; toolResults?: unknown[] }> = []
  let calls: unknown[] = []
  let results: unknown[] = []
  for await (const part of r.fullStream as AsyncIterable<any>) {
    if (part.type === "text-delta") trace.text += part.text
    if (part.type === "tool-call") {
      trace.calls.push({ toolName: part.toolName })
      calls.push({ toolCallId: part.toolCallId, toolName: part.toolName, args: part.input })
    }
    if (part.type === "tool-result") {
      trace.results.push({ toolName: part.toolName, output: part.output })
      results.push({ toolCallId: part.toolCallId, result: part.output })
    }
    if (part.type === "tool-error") trace.errors.push(part.error)
    if (part.type === "finish-step") {
      steps.push({
        toolCalls: calls.length ? calls : undefined,
        toolResults: results.length ? results : undefined,
      })
      calls = []
      results = []
    }
  }
  await r.finalize({
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: "stop",
    text: trace.text,
    steps,
  } as never)
  return trace
}

const turn = (content: string) => ({
  threadId,
  content,
  actor: {
    actorType: "user" as const,
    userId: owner.userId,
    orgId: owner.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  },
  orgId: owner.orgId,
  actingAgentId: agentId,
})

function registerLateTool(): void {
  toolRegistry.set([owner.orgId, "mcp", "notes:notes_search"], {
    appName: "mcp",
    name: "notes:notes_search",
    description: "Search the notes workspace (test stand-in for an MCP server's tool).",
    requiredScopes: ["kernel:threads:read"],
    readOnly: true,
    params: z.object({ query: z.string() }),
    handler: async () => {
      lateRuns++
      return { results: [{ title: "Rack 6U", price: "899" }] }
    },
  } as never)
}

async function freshThread(): Promise<void> {
  threadId = await minimal.thread(owner.orgId, owner.userId)
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
}

describe("a tool loaded by tool_search is callable on the next step of the same turn", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    owner = await minimal.adminSession((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@st-${crypto.randomUUID().slice(0, 8)}`}, 'Sam',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${owner.orgId}, '10.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    toolRegistry.set([owner.orgId, "gizmos", "lookup"], {
      appName: "gizmos",
      name: "lookup",
      description: "Look up a gizmo by name (test stand-in for an app tool).",
      requiredScopes: ["kernel:threads:read"],
      readOnly: true,
      params: z.object({ name: z.string() }),
      handler: async () => {
        earlyRuns++
        return { name: "gizmo", stock: 3 }
      },
    } as never)
  })

  afterEach(async () => {
    await clearScriptedTurns(threadId)
    toolRegistry.delete([owner.orgId, "mcp", "notes:notes_search"])
  })

  afterAll(async () => {
    toolRegistry.delete([owner.orgId, "gizmos", "lookup"])
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    if (ORIG_PROVIDER !== undefined) process.env.LIAISON_MODEL_PROVIDER = ORIG_PROVIDER
    else delete process.env.LIAISON_MODEL_PROVIDER
    broadcastSpy.mockRestore()
    await releaseTestLock()
  })

  it("an app tool registered before the turn: search on step 1, call on step 2", async () => {
    await freshThread()
    earlyRuns = 0
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "gizmo lookup" } }] },
      { toolCalls: [{ name: EARLY_TOOL, args: { name: "gizmo" } }] },
      { text: "3 in stock" },
    ])
    const trace = await drive(await runAgentChat(turn("how many gizmos?")))
    expect(earlyRuns).toBe(1)
    const search = JSON.stringify(trace.results.find((r) => r.toolName === "kernel__tool_search"))
    expect(search).toContain(`LOADED: ${EARLY_TOOL}`)
  })

  it("an MCP tool whose list arrives with tool_search's own dial: search on step 1, call on step 2", async () => {
    await freshThread()
    lateRuns = 0
    // The dial tool_search makes for a connection with no stored tool list
    // (ensureOrgToolLists) is what registers the server's tools, mid-turn.
    const dial = spyOn(mcpClientModule, "ensureOrgToolLists").mockImplementation(async () => {
      registerLateTool()
    })
    try {
      await setScriptedTurn(threadId, [
        { toolCalls: [{ name: "kernel__tool_search", args: { query: "notes search" } }] },
        { toolCalls: [{ name: LATE_TOOL, args: { query: "Rack 6U" } }] },
        { text: "899" },
      ])
      const trace = await drive(await runAgentChat(turn("what does the Rack 6U cost?")))
      const search = JSON.stringify(trace.results.find((r) => r.toolName === "kernel__tool_search"))
      const observed = {
        // The result names the exact callable name, and says to call it now.
        resultNamesCallableTool: search.includes(`LOADED: ${LATE_TOOL}`),
        resultSaysCallNow: /call (it|them|one of them) now/i.test(search),
        // The step-2 call ran in THIS turn.
        lateRuns,
        calledByName: trace.calls.some((c) => c.toolName === LATE_TOOL),
        toolErrors: trace.errors.length,
      }
      expect(observed).toEqual({
        resultNamesCallableTool: true,
        resultSaysCallNow: true,
        lateRuns: 1,
        calledByName: true,
        toolErrors: 0,
      })
    } finally {
      dial.mockRestore()
    }
  })
})
