// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The chat agent's provider requests must carry only the CORE tool schemas
// (kernel + explicitly-hot + already-discovered) — never the full app catalog.
// The full set stays executable (a tool discovered mid-run is callable on the
// next step via prepareStep/activeTools), and per-thread discoveries persist
// in threads.metadata so follow-up turns keep them loaded.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import * as mailboxContext from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-context"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { ROLLING_CACHE_PROVIDER_OPTIONS } from "~/modules/agent/runtime/rolling-cache-breakpoints"
import { agentInstructionsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000d50001"
const USER_ID = "00000000-0000-0000-0000-000000d50002"
const THREAD_ID = "00000000-0000-0000-0000-000000d50003"
const THREAD_ID_2 = "00000000-0000-0000-0000-000000d50004"
const THREAD_ID_3 = "00000000-0000-0000-0000-000000d50005"
const THREAD_ID_4 = "00000000-0000-0000-0000-000000d50006"
const THREAD_ID_5 = "00000000-0000-0000-0000-000000d50007"
const THREAD_ID_6 = "00000000-0000-0000-0000-000000d50008"
const THREAD_ID_7 = "00000000-0000-0000-0000-000000d50009"

let capturedParams: any = null

function capturingStreamText(params: any) {
  capturedParams = params
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1000, outputTokens: 10 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const ACTOR = {
  actorType: "user" as const,
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

describe("deferred tools in the chat agent loop", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(capturingStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'DeferredToolsOrg', 'deferred-tools-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'deferredtools@test.com', 'Deferred Tools')`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ORG_ID}, 'personal', '@deferredtools', 'Test agent', ${USER_ID}, '["*"]'::jsonb)`
    // The room floor reads the members' PERSISTED grants, so the actor's '*'
    // must exist in the database too or the agent turn runs at no scope.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER_ID}, ${ORG_ID}, '*')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'deferred-tools-chat', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_discovered_tools) VALUES (${THREAD_ID_2}, ${ORG_ID}, 'deferred-tools-chat-2', 'agent_chat', ${USER_ID}, '["doohickeys__search"]'::jsonb)`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID_2}, ${USER_ID}, ${ORG_ID})`
    // The turn that unlocked it is in the thread: a persisted name no stored
    // turn shows is not seeded (the discovery window).
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_agent_id, author_type, content, required_scopes, metadata)
      VALUES (${THREAD_ID_2}, ${ORG_ID}, ${USER_ID}, (SELECT id FROM kernel.agents WHERE org_id = ${ORG_ID} AND handle = '@deferredtools'), 'agent', 'found the doohickey search', '{}', '{"discoveredTools":["doohickeys__search"]}'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID_3}, ${ORG_ID}, 'deferred-tools-chat-3', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID_3}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID_4}, ${ORG_ID}, 'deferred-tools-chat-4', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID_4}, ${USER_ID}, ${ORG_ID})`
    // A long lived DM: two persisted discoveries, a checkpoint boundary, and
    // rows after the boundary that show only one of them.
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_discovered_tools) VALUES (${THREAD_ID_5}, ${ORG_ID}, 'deferred-tools-chat-5', 'agent_chat', ${USER_ID}, '["doohickeys__search","gizmos__list"]'::jsonb)`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID_5}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID_6}, ${ORG_ID}, 'deferred-tools-chat-6', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID_6}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID_7}, ${ORG_ID}, 'deferred-tools-chat-7', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID_7}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5-deferred', 'Claude Haiku Deferred', '1.00', '5.00', 200000, true, 'starter')`
    // Long per-app agent instructions: injected in FULL only for apps whose
    // tools this thread has discovered; otherwise a one-line summary.
    agentInstructionsRegistry.set(
      [ORG_ID, "doohickeys"],
      "Manage the doohickey fleet.\n\nDOOHICKEY-FULL-GUIDE-MARKER lots of detailed workflow guidance that must not ship on every request.",
    )
    // A plain app tool (no flag) — deferred by default.
    toolRegistry.set([ORG_ID, "doohickeys", "search"], {
      appName: "doohickeys",
      name: "search",
      description: "Search doohickeys.",
      requiredScopes: ["kernel:threads:read"],
      handler: async () => ({ ok: true }),
    } as any)
    agentInstructionsRegistry.set(
      [ORG_ID, "gizmos"],
      "Manage gizmos.\n\nGIZMO-FULL-GUIDE-MARKER a guide that must leave the prefix with the rows that used it.",
    )
    // A SECTIONED guide: the core rides with the app, a section only with its tool.
    agentInstructionsRegistry.set([ORG_ID, "widgets"], {
      core: "Widgets is the widget app.\n\nWIDGET-CORE-MARKER the rule for every widget call.",
      sections: [
        { tools: ["search"], text: "WIDGET-SEARCH-SECTION how to search." },
        { tools: ["zap"], text: "WIDGET-ZAP-SECTION how to zap." },
      ],
    })
    for (const name of ["search", "zap"]) {
      toolRegistry.set([ORG_ID, "widgets", name], {
        appName: "widgets",
        name,
        description: `Widgets ${name}.`,
        requiredScopes: ["kernel:threads:read"],
        handler: async () => ({ ok: true }),
      } as any)
    }
    // A kernel guide that is not an app (like kernel-config): it names its tools.
    agentInstructionsRegistry.set([ORG_ID, "kernel-frobs"], {
      core: "Frobs are set through kernel__frob_set.\n\nFROB-FULL-GUIDE-MARKER how to set a frob.",
      coveredTools: ["kernel__frob_*"],
    })
    toolRegistry.set([ORG_ID, "kernel", "frob_set"], {
      appName: "kernel",
      name: "frob_set",
      description: "Set a frob.",
      requiredScopes: ["kernel:threads:read"],
      deferLoading: true,
      handler: async () => ({ ok: true }),
    })
    toolRegistry.set([ORG_ID, "gizmos", "list"], {
      appName: "gizmos",
      name: "list",
      description: "List gizmos.",
      requiredScopes: ["kernel:threads:read"],
      handler: async () => ({ ok: true }),
    } as any)
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    toolRegistry.delete([ORG_ID, "doohickeys", "search"])
    agentInstructionsRegistry.delete([ORG_ID, "doohickeys"])
    toolRegistry.delete([ORG_ID, "gizmos", "list"])
    agentInstructionsRegistry.delete([ORG_ID, "gizmos"])
    toolRegistry.delete([ORG_ID, "widgets", "search"])
    toolRegistry.delete([ORG_ID, "widgets", "zap"])
    agentInstructionsRegistry.delete([ORG_ID, "widgets"])
    agentInstructionsRegistry.delete([ORG_ID, "kernel-frobs"])
    toolRegistry.delete([ORG_ID, "kernel", "frob_set"])
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'claude-haiku-4-5-deferred'`
    await releaseTestLock()
  })

  it("provider sees only core tools at step 0; deferred tools stay executable in the full set", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "hello",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })

      expect(capturedParams).not.toBeNull()
      // The FULL set (including deferred) is executable...
      expect(capturedParams.tools.doohickeys__search).toBeDefined()
      expect(capturedParams.tools.kernel__tool_search).toBeDefined()
      // ...but the provider-visible set at step 0 excludes undiscovered deferred tools.
      expect(typeof capturedParams.prepareStep).toBe("function")
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      expect(step0.activeTools).toContain("kernel__tool_search")
      expect(step0.activeTools).not.toContain("doohickeys__search")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("mid-run discovery expands activeTools on the next step and persists to thread metadata", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "use a doohickey",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      // Before discovery: the app's instructions appear only as a summary line.
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      expect(step0.system).toBeUndefined()
      const baseSystem = JSON.stringify(capturedParams.system)
      expect(baseSystem).toContain("doohickeys")
      expect(baseSystem).not.toContain("DOOHICKEY-FULL-GUIDE-MARKER")

      // Simulate the tool_search handler having discovered the tool mid-run.
      result.discoveredTools.add("doohickeys__search")
      const stepN = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      expect(stepN.activeTools).toContain("doohickeys__search")
      // The full app guide arrives as a runtime-context message APPENDED to the
      // step's message tail — never as a system-prefix mutation, which would
      // invalidate the provider's cached prefix on every discovery.
      expect(stepN.system).toBeUndefined()
      expect(JSON.stringify(stepN.messages)).toContain("DOOHICKEY-FULL-GUIDE-MARKER")

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      const rows =
        await sql`SELECT agent_discovered_tools FROM kernel.threads WHERE id = ${THREAD_ID}`
      expect(rows[0].agent_discovered_tools).toContain("doohickeys__search")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("a BLIND call to an undiscovered tool unlocks it AND injects the app's full guide next step", async () => {
    // The prod tickets__reply loop: the model calls a tool it never loaded,
    // guessing args the provider has no schema for. The call must not execute;
    // it becomes the discovery — next step the provider sees the schema and the
    // system prompt carries the app's FULL instructions.
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_4,
        content: "reply to the doohickey",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      // Blind calls now VALIDATE-THEN-EXECUTE (no reject-then-retry step tax):
      // the call still counts as the discovery, unlocking schema + guide.
      const blind = await capturedParams.tools.doohickeys__search.execute({})
      expect(JSON.stringify(blind)).not.toContain("NOT EXECUTED")
      expect(result.discoveredTools.has("doohickeys__search")).toBe(true)
      const stepN = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      expect(stepN.activeTools).toContain("doohickeys__search")
      expect(stepN.system).toBeUndefined()
      expect(JSON.stringify(stepN.messages)).toContain("DOOHICKEY-FULL-GUIDE-MARKER")
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("previously-discovered tools are seeded from thread metadata on the next turn", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_2,
        content: "again",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      expect(step0.activeTools).toContain("doohickeys__search")
      // Persisted discovery also brings the app's FULL instructions, as a guide
      // note before the first step: never into the system prompt, which stays
      // the same whatever the thread loaded (guide-notes.ts).
      expect(JSON.stringify(capturedParams.messages)).toContain("DOOHICKEY-FULL-GUIDE-MARKER")
      expect(JSON.stringify(capturedParams.system)).not.toContain("DOOHICKEY-FULL-GUIDE-MARKER")
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("persisted discoveries load WINDOWED to the checkpoint boundary: a tool no row after it and no recent turn shows expires", async () => {
    // The prod DM measured at 142 persisted discoveries: every padded search
    // hit since the thread was born, each app's full guide in the prefix.
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const [agentRow] =
        await sql`SELECT id FROM kernel.agents WHERE org_id = ${ORG_ID} AND handle = '@deferredtools'`
      const boundaryId = crypto.randomUUID()
      const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
      // Before the boundary: the turn that unlocked gizmos__list.
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_agent_id, author_type, content, created_at, required_scopes, metadata)
        VALUES (${crypto.randomUUID()}, ${THREAD_ID_5}, ${ORG_ID}, ${USER_ID}, ${agentRow.id}, 'agent', 'listed the gizmos', ${new Date(t0 + 1000).toISOString()}, '{}',
          ${JSON.stringify({ discoveredTools: ["gizmos__list"], toolCalls: [{ toolCallId: "g1", toolName: "gizmos__list", args: {}, result: {} }] })}::jsonb)`
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
        VALUES (${boundaryId}, ${THREAD_ID_5}, ${ORG_ID}, ${USER_ID}, 'user', 'thanks', ${new Date(t0 + 2000).toISOString()}, '{}')`
      await sql`INSERT INTO kernel.agent_thread_checkpoints
        (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
        VALUES (${ORG_ID}, ${agentRow.id}, ${THREAD_ID_5}, ${boundaryId}, 'The gizmos were listed.', '{}', 10, 1)`
      // After the boundary: turns that called doohickeys__search and nothing
      // else, enough of them that the gizmos turn is no longer one of the
      // last RECENT_TOOL_TURNS (those keep their tools across the boundary).
      for (let i = 0; i < 3; i++) {
        await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_agent_id, author_type, content, created_at, required_scopes, metadata)
          VALUES (${crypto.randomUUID()}, ${THREAD_ID_5}, ${ORG_ID}, ${USER_ID}, ${agentRow.id}, 'agent', 'searched the doohickeys', ${new Date(t0 + 3000 + i * 1000).toISOString()}, '{}',
            ${JSON.stringify({ toolCalls: [{ toolCallId: `d${i}`, toolName: "doohickeys__search", args: {}, result: {} }] })}::jsonb)`
      }

      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_5,
        content: "and now?",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      // Still in the window: shown to the provider, full guide in a note.
      expect(step0.activeTools).toContain("doohickeys__search")
      expect(JSON.stringify(capturedParams.messages)).toContain("DOOHICKEY-FULL-GUIDE-MARKER")
      // Expired with the rows that used it: schema and guide both gone.
      expect(step0.activeTools).not.toContain("gizmos__list")
      expect(JSON.stringify(capturedParams.messages)).not.toContain("GIZMO-FULL-GUIDE-MARKER")
      // Still one search away: the full set stays executable.
      expect(capturedParams.tools.gizmos__list).toBeDefined()

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      // The column now reflects the window, so the next turn does not reload the expired name.
      const rows =
        await sql`SELECT agent_discovered_tools FROM kernel.threads WHERE id = ${THREAD_ID_5}`
      expect(rows[0].agent_discovered_tools).toEqual(["doohickeys__search"])
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("the tools a turn unlocked are recorded on its row, so the window can read them back", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_3,
        content: "unlock one",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      result.discoveredTools.add("doohickeys__search")
      const done = await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      const [row] = await sql`SELECT metadata FROM kernel.messages WHERE id = ${done.messageId}`
      expect(row.metadata.discoveredTools).toEqual(["doohickeys__search"])
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("an app first CALLED mid-turn brings its anchored skills in the same turn, once", async () => {
    // Assembly surfaces the skills anchored to apps the conversation already used; an app
    // whose first tool is called in a later step of the same turn used to get its guide but
    // none of its playbooks until the next turn.
    const threadId = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${threadId}, ${ORG_ID}, ${`mid-turn-skills-${threadId.slice(0, 8)}`}, 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.skills (org_id, name, description, body, auto_attach, created_by_actor_type)
      VALUES (${ORG_ID}, 'gizmo-playbook', 'How to handle gizmos', 'GIZMO-PLAYBOOK-BODY count before you move.',
              '{"apps":["gizmos"]}'::jsonb, 'user')`
    // Scoped, so its delivery must taint the turn (security review F3).
    await sql`UPDATE kernel.skills SET required_scopes = '{kernel:threads:read}'
      WHERE org_id = ${ORG_ID} AND name = 'gizmo-playbook'`
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId,
        content: "hello",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      expect(JSON.stringify(capturedParams.system)).not.toContain("GIZMO-PLAYBOOK-BODY")
      expect(result.turnAccumulatedScopes()).not.toContain("kernel:threads:read")

      const called = [{ toolCalls: [{ toolName: "gizmos__list" }] }]
      const step1 = await capturedParams.prepareStep({ steps: called, stepNumber: 1, messages: [] })
      expect(JSON.stringify(step1.messages)).toContain("GIZMO-PLAYBOOK-BODY")
      expect(result.turnAccumulatedScopes()).toContain("kernel:threads:read")
      const step2 = await capturedParams.prepareStep({ steps: called, stepNumber: 2, messages: [] })
      expect(JSON.stringify(step2.messages ?? [])).not.toContain("GIZMO-PLAYBOOK-BODY")

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID} AND name = 'gizmo-playbook'`
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("a sectioned guide delivers its core once and each section the step its tool is discovered", async () => {
    // The tickets guide is 8,400 tokens and shopify 10,400: one loaded tool
    // used to pull the whole guide into the prefix for the life of the thread.
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_6,
        content: "find a widget",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const system0 = JSON.stringify(capturedParams.system)
      expect(system0).toContain("widgets")
      expect(system0).not.toContain("WIDGET-CORE-MARKER")

      result.discoveredTools.add("widgets__search")
      const step1 = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      const tail1 = JSON.stringify(step1.messages)
      expect(tail1).toContain("WIDGET-CORE-MARKER")
      expect(tail1).toContain("WIDGET-SEARCH-SECTION")
      expect(tail1).not.toContain("WIDGET-ZAP-SECTION")

      // Nothing new: no guide message at all.
      const step2 = await capturedParams.prepareStep({ steps: [], stepNumber: 2, messages: [] })
      expect(JSON.stringify(step2.messages ?? [])).not.toContain("WIDGET-")

      result.discoveredTools.add("widgets__zap")
      const step3 = await capturedParams.prepareStep({ steps: [], stepNumber: 3, messages: [] })
      const tail3 = JSON.stringify(step3.messages)
      expect(tail3).toContain("WIDGET-ZAP-SECTION")
      expect(tail3).not.toContain("WIDGET-CORE-MARKER")
      expect(tail3).not.toContain("WIDGET-SEARCH-SECTION")

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })

      // Next turn: the replayed history carries the core and BOTH sections,
      // once each, where the last turn got them; the system prompt does not
      // grow, and nothing is delivered again.
      capturedParams = null
      const again = await runAgentChat({
        threadId: THREAD_ID_6,
        content: "and again",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      expect(JSON.stringify(capturedParams.system)).toBe(system0)
      const historyAgain = JSON.stringify(capturedParams.messages)
      for (const marker of ["WIDGET-CORE-MARKER", "WIDGET-SEARCH-SECTION", "WIDGET-ZAP-SECTION"]) {
        expect(historyAgain.split(marker)).toHaveLength(2)
      }
      const againStep = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      expect(JSON.stringify(againStep.messages ?? [])).not.toContain("WIDGET-")
      await again.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("a blind call to a tool the provider was not shown is repaired into tool_search select, in the same step", async () => {
    // The SDK parses calls against the ACTIVE set, so a blind call used to die
    // as "Model tried to call unavailable tool" and cost a step for nothing.
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const { NoSuchToolError } = await import("ai")
      const result = await runAgentChat({
        threadId: THREAD_ID_3,
        content: "search the doohickeys",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const repair = capturedParams.experimental_repairToolCall
      expect(typeof repair).toBe("function")
      const blind = { toolCallId: "c-blind", toolName: "doohickeys__search", input: "{}" }
      const repaired = await repair({
        toolCall: blind,
        error: new NoSuchToolError({ toolName: "doohickeys__search", availableTools: [] }),
      })
      expect(repaired).toEqual({
        type: "tool-call",
        toolCallId: "c-blind",
        toolName: "kernel__tool_search",
        input: JSON.stringify({ query: "select:doohickeys__search" }),
      })
      // Executing the repaired call unlocks the tool for the next step.
      await capturedParams.tools.kernel__tool_search.execute(JSON.parse(repaired.input))
      expect(result.discoveredTools.has("doohickeys__search")).toBe(true)
      // A name that exists nowhere stays an error for the model to read, and
      // that error tells it how to find the tool instead.
      await expect(
        repair({
          toolCall: { toolCallId: "c-x", toolName: "nowhere__tool", input: "{}" },
          error: new NoSuchToolError({ toolName: "nowhere__tool", availableTools: [] }),
        }),
      ).rejects.toThrow(/No tool named "nowhere__tool".*kernel__tool_search/)
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("system prompt announces the deferred catalog with the discovery protocol", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_3,
        content: "what can you do",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      const systemText = JSON.stringify(capturedParams.system)
      expect(systemText).toContain("tool_search")
      // Grouped catalog names the app and its tool short names.
      expect(systemText).toContain("doohickeys")
      // The protocol wording that keeps a weak model from claiming a missing capability.
      expect(systemText).toContain("loaded on demand")
      expect(systemText).toContain("NEVER tell the user a capability is missing")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("prepareStep clips tool results older than the keep-window (intra-run micro-compaction)", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_4,
        content: "long multi-tool run",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const toolMsg = (id: string) => ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: "doohickeys__search",
            output: { type: "json", value: { blob: "x".repeat(60_000) } },
          },
        ],
      })
      const stepMessages = [
        { role: "user", content: "go" },
        toolMsg("old-1"),
        toolMsg("old-2"),
        toolMsg("r1"),
        toolMsg("r2"),
        toolMsg("r3"),
        toolMsg("r4"),
      ]
      const stepN = await capturedParams.prepareStep({
        steps: [],
        stepNumber: 6,
        messages: stepMessages,
      })
      // Old results are clipped to the replay cap; the recent four ride verbatim
      // (the newest one carries the rolling cache mark, on a copy).
      const outOld = JSON.stringify(stepN.messages[1])
      expect(outOld.length).toBeLessThan(20_000)
      expect(outOld).toContain("truncated by the platform")
      expect(stepN.messages[3]).toBe(stepMessages[3])
      expect(stepN.messages[6].content).toBe(stepMessages[6]?.content)
      // Clip-once: replaying the SAME (already clipped) list sends the same
      // bytes, marks included — byte-stability is what lets the provider
      // prefix-cache the clipped form.
      const again = await capturedParams.prepareStep({
        steps: [],
        stepNumber: 7,
        messages: stepN.messages,
      })
      expect(JSON.stringify(again.messages ?? stepN.messages)).toBe(JSON.stringify(stepN.messages))
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // The rebuilt step (initial + responses, the SDK's own unclipped list) must
  // carry every earlier clip again, byte for byte: otherwise a clipped result
  // is sent in full on the next step and clipped a second time after that,
  // two prefix rewrites (two cache writes) per result.
  it("a result clipped at one step is sent clipped, identically, at every later step", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_4,
        content: "long run",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const toolMsg = (id: string) => ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: "doohickeys__search",
            output: { type: "json", value: { blob: "x".repeat(60_000) } },
          },
        ],
      })
      const user = { role: "user", content: "go" }
      // Two results past the keep window: together they make a clip batch.
      const responses = ["c1", "c2", "c3", "c4", "c5", "c6"].map(toolMsg)
      const step5 = await capturedParams.prepareStep({
        steps: [],
        stepNumber: 5,
        initialMessages: [user],
        responseMessages: responses,
        messages: [user, ...responses],
      })
      const clippedC1 = JSON.stringify(step5.messages[1])
      expect(clippedC1).toContain("truncated by the platform")
      expect(JSON.stringify(step5.messages[2])).toContain("truncated by the platform")
      // Next step: the SDK rebuilds from its own full results, one more added.
      const more = [...responses, toolMsg("c7")]
      const step6 = await capturedParams.prepareStep({
        steps: [],
        stepNumber: 6,
        initialMessages: [user],
        responseMessages: more,
        messages: [...step5.messages, toolMsg("c7")],
      })
      // Same bytes (the rolling cache mark, which moves, aside).
      for (const i of [1, 2]) {
        expect(JSON.stringify(step6.messages[i].content)).toBe(
          JSON.stringify(step5.messages[i].content),
        )
      }
      expect(clippedC1).toContain(JSON.stringify(step6.messages[1].content))
      // c3 left the keep window alone: it waits for a batch, unclipped, so this
      // step rewrites nothing in the middle of the request.
      expect(JSON.stringify(step6.messages[3])).not.toContain("truncated by the platform")
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // AI SDK 7 carries a prepareStep `messages` override forward to later steps.
  // A per-step tail (here the browser-decrypted mail block) must not ride
  // along into the next step: that step is rebuilt from the SDK's own
  // accumulated messages (initial + responses) and overridden again.
  it("a per-step tail injected at one step is gone from the next (SDK 7 carry-forward)", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    let mail = ["MAIL-BLOCK"]
    const mailSpy = spyOn(mailboxContext, "getEphemeralMailboxContext").mockImplementation(
      () => mail,
    )
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_4,
        content: "read my mail",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const user = { role: "user", content: "go" }
      const reply = { role: "assistant", content: [{ type: "text", text: "reading" }] }
      const first = await capturedParams.prepareStep({
        steps: [],
        stepNumber: 0,
        initialMessages: [user],
        responseMessages: [],
        messages: [user],
      })
      // The rolling cache mark sits on the newest message BEFORE the per-step
      // tail, never on the tail (which is gone next step).
      expect(first.messages).toEqual([
        { ...user, providerOptions: ROLLING_CACHE_PROVIDER_OPTIONS },
        { role: "user", content: "MAIL-BLOCK" },
      ])
      // The SDK carries that override into step 1, with the step's reply after it.
      mail = []
      const second = await capturedParams.prepareStep({
        steps: [],
        stepNumber: 1,
        initialMessages: [user],
        responseMessages: [reply],
        messages: [...first.messages, reply],
      })
      expect(second.messages).toEqual([
        user,
        { ...reply, providerOptions: ROLLING_CACHE_PROVIDER_OPTIONS },
      ])
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      mailSpy.mockRestore()
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("a kernel guide that names its tools arrives once, the step its first tool is discovered", async () => {
    // kernel-config is not an app: discovering kernel__config_mail maps to the
    // app "kernel", whose overview is already in the prefix, so the config guide
    // never arrived. A guide that names its tools follows those tools.
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID_7,
        content: "set a frob",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const system0 = JSON.stringify(capturedParams.system)
      expect(system0).toContain("kernel-frobs")
      expect(system0).not.toContain("FROB-FULL-GUIDE-MARKER")

      result.discoveredTools.add("kernel__frob_set")
      const step1 = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      expect(step1.activeTools).toContain("kernel__frob_set")
      expect(JSON.stringify(step1.messages)).toContain("FROB-FULL-GUIDE-MARKER")

      const step2 = await capturedParams.prepareStep({ steps: [], stepNumber: 2, messages: [] })
      expect(JSON.stringify(step2.messages ?? [])).not.toContain("FROB-FULL-GUIDE-MARKER")

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })

      // Next turn: the guide is in the replayed history, where the last turn
      // got it, and is not delivered a second time; the system prompt is unchanged.
      capturedParams = null
      const again = await runAgentChat({
        threadId: THREAD_ID_7,
        content: "and another",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      expect(JSON.stringify(capturedParams.system)).toBe(system0)
      expect(JSON.stringify(capturedParams.messages).split("FROB-FULL-GUIDE-MARKER")).toHaveLength(
        2,
      )
      const againStep = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      expect(JSON.stringify(againStep.messages ?? [])).not.toContain("FROB-FULL-GUIDE-MARKER")
      await again.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
