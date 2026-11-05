// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import * as realAi from "ai"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLockKeepRows } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

/**
 * An EAGER snapshot of the real `ai` module, taken before the mock below is
 * installed (`import * as` is a LIVE view that `mock.module` patches in place).
 *
 * WHY THE SPREAD, AND WHY IT IS SAFE. `ai` is the SDK's function surface, not a
 * provider: nothing here talks to a network until a model is handed to one of
 * the two entry points this file overrides, `generateText` and `streamText`.
 * Everything else it exports is a pure helper, and production imports a growing
 * set of them: `provider-schema.ts` alone needs `asSchema` and `jsonSchema`, and
 * a hand-listed fake silently loses every export the tree adds later (this file
 * failed to load at all with "Export named 'jsonSchema' not found" once that
 * import existed). The spread is the convention `mock-module-hygiene.test.ts`
 * requires of every other file.
 */
const realAiModule = { ...realAi }

mock.module("ai", () => ({
  ...realAiModule,
  generateText: async () => ({ text: "Created the calibration drift bug for Marie." }),
  streamText: (opts: {
    tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
  }) => ({
    fullStream: (async function* () {
      const toolName = "projects__create"
      const args = { title: "Calibration drift", assigneeName: "Marie" }
      const toolDef = opts.tools?.[toolName]
      if (!toolDef?.execute) throw new Error("projects tool unavailable")
      yield { type: "tool-call", toolCallId: "call-projects-create", toolName, input: args }
      const output = await toolDef.execute(args)
      yield { type: "tool-result", toolCallId: "call-projects-create", output }
      yield { type: "text-delta", text: "Created the calibration drift bug for Marie." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 100, outputTokens: 20 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }),
}))

const { app } = await import("~/app")
const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")

function fakeProjectStreamText(opts: {
  tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
}) {
  return {
    fullStream: (async function* () {
      const toolName = "projects__create"
      const args = { title: "Calibration drift", assigneeName: "Marie" }
      const toolDef = opts.tools?.[toolName]
      if (!toolDef?.execute) throw new Error("projects tool unavailable")
      yield { type: "tool-call", toolCallId: "call-projects-create", toolName, input: args }
      const output = await toolDef.execute(args)
      yield { type: "tool-result", toolCallId: "call-projects-create", output }
      yield { type: "text-delta", text: "Created the calibration drift bug for Marie." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 100, outputTokens: 20 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }
}

/**
 * What the human in this scenario holds, in the bearer AND in the database.
 * No `projects:approve`: `projects.create` is not gated since 2026-09-28, so the
 * agent's call writes the task itself and nobody has to approve anything.
 */
const USER_SCOPES = [
  "kernel:threads:read",
  "kernel:threads:write",
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
] as const

interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of body.split("\n\n").filter((b) => b.trim())) {
    let event = "message"
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      if (line.startsWith("data: ")) data = line.slice(6).trim()
    }
    events.push({ event, data: JSON.parse(data) })
  }
  return events
}

describe("projects agent runtime", () => {
  let orgId: string
  let userId: string
  let marieId: string
  let threadId: string
  let projectId: string
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = randomUUID()
    userId = randomUUID()
    marieId = randomUUID()
    threadId = randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'Projects Agent Runtime Org', ${`projects-agent-${orgId.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version) VALUES (${userId}, ${orgId}, ${`agent-${userId.slice(0, 8)}@test.com`}, 'Agent User', 'active', 'hash', 1, 1)`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version) VALUES (${marieId}, ${orgId}, ${`marie-${marieId.slice(0, 8)}@test.com`}, 'Marie', 'active', 'hash', 1, 1)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${threadId}, ${orgId}, ${`agent-${threadId.slice(0, 8)}`}, 'agent_chat', ${userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${userId}, ${orgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${orgId}, '10.00000000', '5.00000000', 'EUR')`
    // REAL GRANTS, not just a signed claim: the permission reads go to the
    // database, so a bearer this test minted for itself would prove nothing.
    for (const scope of USER_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
                VALUES (${userId}, ${orgId}, ${scope})`
    }
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter') ON CONFLICT (provider, model_id) DO NOTHING`
    AgentServiceTestAccess.setStreamText(fakeProjectStreamText as never)
    token = await signAccessToken(
      {
        userId,
        orgId,
        name: "Agent User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: [...USER_SCOPES],
        dimensionGrants: { "*": ["*"] },
      },
      env.JWT_SECRET,
    )
    const projectRes = await app.request("/api/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agent Runtime Project" }),
    })
    expect(projectRes.status).toBe(200)
    projectId = ((await projectRes.json()) as { data: { id: string } }).data.id
  }, 30_000)

  afterAll(async () => {
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    AgentServiceTestAccess.setStreamText()
    try {
      await sql`DELETE FROM app_projects.tasks WHERE org_id = ${orgId}`
      await sql`DELETE FROM app_projects.project_statuses WHERE org_id = ${orgId}`
      await sql`DELETE FROM app_projects.projects WHERE org_id = ${orgId}`
      // Before the threads: `approval_requests_thread_fk` references them, and a
      // parked call leaves a row behind whichever way the decision went.
      await sql`DELETE FROM kernel.approved_handler_executions
                WHERE approval_request_id IN (
                  SELECT id FROM kernel.approval_requests WHERE org_id = ${orgId})`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.message_reactions WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    } finally {
      await releaseTestLockKeepRows()
    }
  }, 30_000)

  it("projects.agent-runtime-create-assign-marie", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        content: "@liaison create a bug for calibration drift and assign it to Marie",
        // Auto-mode → gemini-flash-lite. Never hardcode Anthropic in E2E.
      }),
    })
    expect(res.status).toBe(200)
    const events = parseSseEvents(await res.text())
    expect(
      events.some(
        (e) => e.event === "tool-call" && (e.data as any).toolName === "projects__create",
      ),
    ).toBe(true)
    expect(events.some((e) => e.event === "tool-result")).toBe(true)

    // NO GATE (owner ruling 2026-09-28): the agent's call writes the task in the
    // turn itself. No approval row is parked, not even an auto-approved one.
    const [approvals] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    expect(approvals!.n).toBe(0)

    const tasksRes = await app.request(`/api/projects/${projectId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(tasksRes.status).toBe(200)
    const tasks = (
      (await tasksRes.json()) as {
        data: { items: Array<{ title: string; assigneeId: string | null }> }
      }
    ).data.items
    const task = tasks.find((t) => t.title === "Calibration drift")
    expect(task).toBeDefined()
    expect(task!.assigneeId).toBe(marieId)
  })
})
