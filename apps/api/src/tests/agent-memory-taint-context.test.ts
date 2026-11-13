// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  assembleContext,
  CAPABILITY_CATEGORIES_PREFIX,
  MEMORY_INDEX_NEAR_LIMIT,
  systemPartsToText,
} from "~/modules/agent/context/context"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-000000e20001"
const USER_A = "00000000-0000-4000-8000-000000e20002"
const USER_B = "00000000-0000-4000-8000-000000e20003"
const THREAD_ID = "00000000-0000-4000-8000-000000e20004"

/**
 * The ephemeral `<runtime-context>` tail message appended after the history.
 * Per-request VOLATILE content (current time, referenced entities, the user
 * memory index) rides there rather than in the cacheable system prefix, so the
 * system+history prefix stays byte-identical across turns for provider prompt
 * caching. Returns "" when the last message is not the tail, so an assertion on
 * it fails loudly instead of passing on a missing tail.
 */
function tailText(ctx: Awaited<ReturnType<typeof assembleContext>>): string {
  const last = ctx.messages[ctx.messages.length - 1]
  const content = typeof last?.content === "string" ? last.content : ""
  return content.startsWith("<runtime-context") ? content : ""
}

/** The persisted history, without the ephemeral runtime-context tail. */
function historyOf(ctx: Awaited<ReturnType<typeof assembleContext>>) {
  return ctx.messages.filter(
    (m) => !(typeof m.content === "string" && m.content.startsWith("<runtime-context")),
  )
}

describe("agent memory, taint and context integration", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG_ID}, 'IntegOrg', 'integ-org', '{"webContentProtection":"hardened"}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
      VALUES (${USER_A}, ${ORG_ID}, 'ia@test.com', 'Integ A', 'x', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
      VALUES (${USER_B}, ${ORG_ID}, 'ib@test.com', 'Integ B', 'x', 'active') ON CONFLICT DO NOTHING`
    // The actor below acts with every scope; a post's poster is judged on the grants stored for
    // them (scope taint rule 14), so the stored grants say the same.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER_A}, ${ORG_ID}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'integ-thread', 'agent_chat', ${USER_A}, false) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID}) ON CONFLICT DO NOTHING`

    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  const actorA: UserContext = {
    actorType: "user",
    userId: USER_A,
    orgId: ORG_ID,
    scopes: ["*"],
    dimensionGrants: {},
  }

  it("memory set → persists → appears in the context of the next assembleContext", async () => {
    await executeTool({
      toolName: "kernel:user_memory_set",
      orgId: ORG_ID,
      actor: actorA,
      params: {
        type: "user",
        name: "style",
        description: "Prefers concise bullet-point responses",
        content: "Prefers concise bullet points",
      },
      threadId: THREAD_ID,
    })

    const ctx = await assembleContext({ threadId: THREAD_ID, orgId: ORG_ID, actor: actorA })
    // MEMORY.md index line, tree form: `- [description](type/name.md), YYYY-MM-DD`
    const indexLine = "- [Prefers concise bullet-point responses](user/style.md), "
    // The saved memory DOES reach the model on the next turn — through the
    // ephemeral runtime-context tail message, which is where the volatile memory
    // index lives, not the cacheable system prefix.
    expect(tailText(ctx)).toContain(indexLine)
    // ...and it must NOT leak back into the system prefix: a per-request byte
    // there invalidates the provider prompt cache for the system prompt and the
    // whole history on every turn.
    expect(systemPartsToText(ctx.system)).not.toContain(indexLine)
  })

  it("web taint → hardened mode → trust-boundary tool blocked with approval request", async () => {
    toolRegistry.set([ORG_ID, "kernel", "test_taint_tool"], {
      appName: "kernel",
      name: "test_taint_tool",
      description: "Test taint source",
      requiredScopes: ["kernel:agent:web"],
      taintSource: true,
      handler: async () => ({ fetched: true }),
    })
    // A synthetic trust-boundary tool — taint escalation gates any tool that
    // declares `trustBoundary`. (threads_create/threads_reply are deliberately
    // un-gated: agent posts are attributed, not impersonated, so they carry no
    // trust boundary and are not subject to the taint gate.)
    toolRegistry.set([ORG_ID, "kernel", "test_tb_tool"], {
      appName: "kernel",
      name: "test_tb_tool",
      description: "Test trust-boundary tool",
      requiredScopes: ["kernel:agent:web"],
      trustBoundary: "user",
      handler: async () => ({ ok: true }),
    })

    // Execute taintSource tool → sets tainted flag
    await executeTool({
      toolName: "kernel:test_taint_tool",
      orgId: ORG_ID,
      actor: actorA,
      params: {},
      threadId: THREAD_ID,
    })

    const [thread] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${THREAD_ID}`
    expect(thread.tainted).toBe(true)

    // Trust-boundary tool in tainted+hardened thread → blocked
    const result = await executeTool({
      toolName: "kernel:test_tb_tool",
      orgId: ORG_ID,
      actor: actorA,
      params: {},
      threadId: THREAD_ID,
    })

    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe("taint_escalation")
    expect(result.blocked!.approvalRequestId).toBeDefined()

    const [approval] =
      await sql`SELECT * FROM kernel.approval_requests WHERE org_id = ${ORG_ID} ORDER BY created_at DESC LIMIT 1`
    expect(approval.reason).toBe("taint_escalation")
    expect(approval.tool_name).toBe("kernel:test_tb_tool")
    expect(approval.status).toBe("pending")

    toolRegistry.delete([ORG_ID, "kernel", "test_taint_tool"])
    toolRegistry.delete([ORG_ID, "kernel", "test_tb_tool"])
  })

  it("web taint → an outward tool parks as an approval; threads_reply to an internal thread still posts", async () => {
    toolRegistry.set([ORG_ID, "kernel", "test_taint_tool"], {
      appName: "kernel",
      name: "test_taint_tool",
      description: "Test taint source",
      requiredScopes: ["kernel:agent:web"],
      taintSource: true,
      handler: async () => ({ fetched: true }),
    })
    await executeTool({
      toolName: "kernel:test_taint_tool",
      orgId: ORG_ID,
      actor: actorA,
      params: {},
      threadId: THREAD_ID,
    })
    const [thread] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${THREAD_ID}`
    expect(thread.tainted).toBe(true)

    // An outward tool (externalEffect): a tainted turn may not use it on its own, in any
    // protection mode; the call becomes an approval request.
    toolRegistry.set([ORG_ID, "kernel", "test_outward_tool"], {
      appName: "kernel",
      name: "test_outward_tool",
      description: "Test outward effect",
      requiredScopes: ["kernel:threads:write"],
      externalEffect: true,
      handler: async () => ({ sent: true }),
    })
    const outward = await executeTool({
      toolName: "kernel:test_outward_tool",
      orgId: ORG_ID,
      actor: actorA,
      params: {},
      threadId: THREAD_ID,
    })
    expect(outward.blocked?.reason).toBe("taint_escalation")
    expect(outward.data ?? undefined).toBeUndefined()

    // threads_reply has no externalEffect: a post lands in an internal thread, attributed to
    // the agent, read only by the org's participants, so it is not gated by the taint.
    // It posts to ANOTHER thread: the turn's own conversation is answered by the
    // turn itself, and threads_reply refuses it.
    const OTHER_THREAD = "00000000-0000-4000-8000-000000e20006"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${OTHER_THREAD}, ${ORG_ID}, 'integ-other', 'agent_chat', ${USER_A}, false) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${OTHER_THREAD}, ${USER_A}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    const result = await executeTool({
      toolName: "kernel:threads_reply",
      orgId: ORG_ID,
      actor: actorA,
      params: { threadId: OTHER_THREAD, content: "Attributed agent post from tainted thread" },
      threadId: THREAD_ID,
    })
    expect(result.blocked).toBeUndefined()
    expect((result.data as { message?: { threadId?: string } })?.message?.threadId).toBe(
      OTHER_THREAD,
    )

    toolRegistry.delete([ORG_ID, "kernel", "test_taint_tool"])
    toolRegistry.delete([ORG_ID, "kernel", "test_outward_tool"])
  })

  it("compaction summary slices message history correctly", async () => {
    const COMPACT_THREAD = "00000000-0000-4000-8000-000000e20005"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${COMPACT_THREAD}, ${ORG_ID}, 'compact-integ', 'agent_chat', ${USER_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${COMPACT_THREAD}, ${USER_A}, ${ORG_ID}) ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, created_at, required_scopes) VALUES
      (${COMPACT_THREAD}, ${ORG_ID}, ${USER_A}, 'user', 'Old message 1', '2026-01-01T00:00:00Z', '{}'),
      (${COMPACT_THREAD}, ${ORG_ID}, ${USER_A}, 'user', 'Old message 2', '2026-01-01T01:00:00Z', '{}')`
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, metadata, created_at, required_scopes) VALUES
      (${COMPACT_THREAD}, ${ORG_ID}, ${USER_A}, 'system', 'Summary: discussed planning and migration', '{"type":"compaction_summary"}'::jsonb, '2026-01-01T02:00:00Z', '{}')`
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, created_at, required_scopes) VALUES
      (${COMPACT_THREAD}, ${ORG_ID}, ${USER_A}, 'user', 'New message after compaction', '2026-01-01T03:00:00Z', '{}')`

    const ctx = await assembleContext({ threadId: COMPACT_THREAD, orgId: ORG_ID, actor: actorA })
    // Every assembled context ends with the ephemeral runtime-context tail (it
    // always carries at least the current time) — it is appended after the
    // history and never persisted, so the compaction slice is what precedes it.
    expect(tailText(ctx)).not.toBe("")
    const history = historyOf(ctx)
    // The slice starts at the latest compaction_summary: the two older messages
    // are dropped, the summary and the message after it are kept.
    expect(history.length).toBe(2)
    expect(history[0].role).toBe("user")
    expect((history[0] as any).content).toContain("Summary:")
    expect(history[1].role).toBe("user")
    expect((history[1] as any).content).toBe("New message after compaction")
  })

  it("memory isolation: user B cannot access user A memories via executeTool", async () => {
    const actorB: UserContext = {
      actorType: "user",
      userId: USER_B,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    await executeTool({
      toolName: "kernel:user_memory_set",
      orgId: ORG_ID,
      actor: actorA,
      params: { type: "user", name: "pin", description: "Secret PIN", content: "1234" },
    })

    const result = await executeTool({
      toolName: "kernel:user_memory_get",
      orgId: ORG_ID,
      actor: actorB,
      params: { type: "user", name: "pin" },
    })
    const data = result.data as any
    expect(data.content).toBeUndefined()
  })

  it("gated tool creates approval request with approvalRequestId end-to-end", async () => {
    toolRegistry.set([ORG_ID, "test_integ", "risky"], {
      appName: "test_integ",
      name: "risky",
      description: "Risky action",
      requiredScopes: ["test_integ:risky"],
      gated: true,
      handler: async () => ({ done: true }),
    })

    const result = await executeTool({
      toolName: "test_integ:risky",
      orgId: ORG_ID,
      actor: actorA,
      params: { target: "test-item" },
      threadId: THREAD_ID,
      origin: "in-app-agent",
    })

    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe("gated")
    expect(result.blocked!.approvalRequestId).toBeDefined()
    const approvalRequestId = result.blocked?.approvalRequestId
    if (!approvalRequestId) throw new Error("expected approval request")

    const [row] = await sql`SELECT * FROM kernel.approval_requests WHERE id = ${approvalRequestId}`
    expect(row.tool_name).toBe("test_integ:risky")
    expect(row.tool_params).toEqual({ target: "test-item" })
    expect(row.status).toBe("pending")

    toolRegistry.delete([ORG_ID, "test_integ", "risky"])
  })
  // --- P4m-T14: the runtime context tail carries MEMORY.md, the capability
  // categories and the index fill level (spec-memory.md I2, budgets table).
  const ROLE_AGENT = "00000000-0000-4000-8000-000000e20009"
  const SCOPED_ROLE_AGENT = "00000000-0000-4000-8000-000000e2000a"

  it("the memory index is read by owning agent and not by user id", async () => {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${ROLE_AGENT}, ${ORG_ID}, 'role', '@integrole', 'Integ Role', '["*"]'::jsonb, 'You route work.')
      ON CONFLICT DO NOTHING`
    // Owned by the ROLE agent, with no user_id at all: the read keyed by the
    // requesting human returns nothing for it.
    await sql`INSERT INTO kernel.agent_memory (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
      VALUES (${ORG_ID}, NULL, ${ROLE_AGENT}, '_index', '_index', 'index', '- [Ships on Fridays](user/shipping.md), 2026-09-01', 'MEMORY.md', '{}'::text[])
      ON CONFLICT DO NOTHING`
    try {
      const ctx = await assembleContext({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        actor: actorA,
        agentId: ROLE_AGENT,
      })
      expect(tailText(ctx)).toContain("- [Ships on Fridays](user/shipping.md)")
    } finally {
      await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND owner_agent_id = ${ROLE_AGENT}`
    }
  })

  it("capability categories and the index fill level ride in the tail and never in a system part", async () => {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${ROLE_AGENT}, ${ORG_ID}, 'role', '@integrole', 'Integ Role', '["*"]'::jsonb, 'You route work.')
      ON CONFLICT DO NOTHING`
    const lines = Array.from(
      { length: 170 },
      (_, i) => `- [Note number ${i}](user/note-${i}.md), 2026-09-01`,
    ).join("\n")
    await sql`INSERT INTO kernel.agent_memory (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
      VALUES (${ORG_ID}, NULL, ${ROLE_AGENT}, '_index', '_index', 'index', ${lines}, 'MEMORY.md', '{}'::text[])
      ON CONFLICT DO NOTHING`
    try {
      const ctx = await assembleContext({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        actor: actorA,
        agentId: ROLE_AGENT,
        effectiveScope: ["tickets:read"],
      })
      const tail = tailText(ctx)
      const system = systemPartsToText(ctx.system)
      expect(tail).toContain(CAPABILITY_CATEGORIES_PREFIX)
      expect(tail).toContain(MEMORY_INDEX_NEAR_LIMIT)
      expect(system).not.toContain(CAPABILITY_CATEGORIES_PREFIX)
      expect(system).not.toContain(MEMORY_INDEX_NEAR_LIMIT)
    } finally {
      await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND owner_agent_id = ${ROLE_AGENT}`
    }
  })

  it("index lines the turn's scope does not cover are dropped and counted with the exact hidden rows string", async () => {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${SCOPED_ROLE_AGENT}, ${ORG_ID}, 'role', '@integscoped', 'Integ Scoped', '["*"]'::jsonb, 'You route work.')
      ON CONFLICT DO NOTHING`
    const open = ["a", "b", "c"]
    const closed = ["d", "e"]
    for (const name of open) {
      await sql`INSERT INTO kernel.agent_memory (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
        VALUES (${ORG_ID}, NULL, ${SCOPED_ROLE_AGENT}, 'user', ${name}, ${`Open note ${name}`}, 'body', ${`user/${name}.md`}, '{}'::text[])
        ON CONFLICT DO NOTHING`
    }
    for (const name of closed) {
      await sql`INSERT INTO kernel.agent_memory (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
        VALUES (${ORG_ID}, NULL, ${SCOPED_ROLE_AGENT}, 'user', ${name}, ${`Closed note ${name}`}, 'body', ${`user/${name}.md`}, ARRAY['pennylane:payouts:read']::text[])
        ON CONFLICT DO NOTHING`
    }
    const indexBody = [...open, ...closed]
      .map((n) => `- [Note ${n}](user/${n}.md), 2026-09-01`)
      .join("\n")
    await sql`INSERT INTO kernel.agent_memory (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
      VALUES (${ORG_ID}, NULL, ${SCOPED_ROLE_AGENT}, '_index', '_index', 'index', ${indexBody}, 'MEMORY.md', ARRAY['pennylane:payouts:read']::text[])
      ON CONFLICT DO NOTHING`
    try {
      const ctx = await assembleContext({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        actor: actorA,
        agentId: SCOPED_ROLE_AGENT,
        effectiveScope: ["tickets:read"],
      })
      const tail = tailText(ctx)
      for (const n of open) expect(tail).toContain(`- [Note ${n}](user/${n}.md)`)
      for (const n of closed) expect(tail).not.toContain(`- [Note ${n}](user/${n}.md)`)
      expect(tail).toContain("2 entries hidden")
    } finally {
      await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND owner_agent_id = ${SCOPED_ROLE_AGENT}`
    }
  })
})
