// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S4 — Sub-agent gated tool call surfaces approval card in the PARENT thread
// (not the hidden sub-run thread), with the §1.4.6 breadcrumb wiring:
//   "Triggered by sub-run: <agentType>"  +  deep-link to the hidden thread.
//
// What this proves at the UI layer:
//   - `kernel.approval_requests.thread_id = <parent>` even though the gated
//     tool fired inside the sub-run's hidden thread (originating_thread_id).
//   - `metadata = { runId, parentRunId, subagentType, hiddenThreadId }`
//     drives the breadcrumb (`approval-card-subrun-breadcrumb`) and the
//     SPA deep-link (`approval-card-subrun-link` → `#/threads/<hidden>`).
//
// The worker-driven creation path (gated MCP call inside a sub-run loop →
// approval enqueue) is unit-tested separately in
// `approval-rerouting.test.ts` per the E2E plan. This scenario directly
// seeds the approval row + the parent sub_run card so the test exercises
// only the visible UI surface — which is what the spec calls out as the
// load-bearing failure mode (operators never see the gated call).

import crypto from "node:crypto"
import path from "node:path"
import { createUserWithScopes } from "@liaison/test-helpers"
import { expect } from "@playwright/test"
import { createSubAgentTest } from "./fixtures/sub-agent-test"
import { loginAs } from "./fixtures/test"
import { seedAgentThread, seedModelPricingAndCredits } from "./helpers/agent-seed"
import { clearSubAgentTables } from "./helpers/agent-test-fixtures"

const STUB = path.resolve(
  __dirname,
  "../../../../api/src/tests/e2e/helpers/sub-agent-smoke-stub.ts",
)

const test = createSubAgentTest(STUB)

test.describe("Sub-agent dispatch — S4 approval rerouting", () => {
  test.beforeEach(async ({ env, world }) => {
    await clearSubAgentTables(env)
    await seedModelPricingAndCredits(env, world.org.id)
  })

  test("approval card surfaces in parent thread with sub-run breadcrumb and deep-link", async ({
    page,
    env,
    world,
  }) => {
    const agentUser = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        email: `s4-${Date.now()}@test.local`,
        password: "S4Pass1!",
        name: "S4 Agent",
        scopes: [
          "kernel:threads:read",
          "kernel:threads:write",
          "kernel:approvals:read",
          "kernel:approvals:write",
        ],
        schemaPrefix: env.schemaPrefix,
      },
    )

    const parentThreadId = await seedAgentThread(env, world.org.id, agentUser.id)
    const ks = `${env.schemaPrefix}kernel`

    // Hidden sub-run thread.
    const hiddenRows = (await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.threads (id, org_id, handle, type, created_by, hidden_from_list)
      VALUES (gen_random_uuid(), ${world.org.id}, ${`subrun-${Math.random().toString(36).slice(2, 8)}`}, 'subrun', ${agentUser.id}, true)
      RETURNING id
    `) as unknown as Array<{ id: string }>
    const hiddenThreadId = hiddenRows[0]!.id

    // Sub-run row — generates the runId for the approval metadata.
    const runRows = (await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.agent_runs (
        id, org_id, parent_run_id, root_run_id, thread_id, parent_thread_id,
        subagent_type, actor, effective_scopes, status, prompt, max_steps,
        timeout_ms, schema_retry_budget, nesting_depth
      ) VALUES (
        gen_random_uuid(), ${world.org.id}, NULL, gen_random_uuid(),
        ${hiddenThreadId}, ${parentThreadId},
        'ticket-investigator',
        ${env.db.sql.json({
          actorType: "user",
          userId: agentUser.id,
          orgId: world.org.id,
          scopes: [],
          dimensionGrants: {},
        })},
        ${["kernel:threads:read", "mcp:slack:post"]},
        'running', 'Investigate the ops alert', 10, 60000, 3, 1
      ) RETURNING id, root_run_id
    `) as unknown as Array<{ id: string; root_run_id: string }>
    const runId = runRows[0]!.id
    await env.db.sql`
      UPDATE ${env.db.sql(ks)}.agent_runs SET root_run_id = id WHERE id = ${runId}
    `

    // Parent-thread sub_run card pinned to status="running" with
    // hasPendingApproval inferred from the approval row below.
    await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.messages
        (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes)
      VALUES (
        gen_random_uuid(), ${parentThreadId}, ${world.org.id}, ${agentUser.id},
        'agent', '',
        ${env.db.sql.json({
          kind: "sub_run",
          subRun: {
            runId,
            hiddenThreadId,
            agentType: "ticket-investigator",
            label: "Investigate ops alert",
            status: "running",
            summary: null,
            usage: { promptTokens: 200, completionTokens: 30, creditCost: "0.0003" },
          },
        })},
        '{}'
      )
    `

    // The approval row — KEY for S4:
    //   thread_id (parent)         → rerouted destination (production sets
    //                                this to the parent agent_chat thread,
    //                                verified by approval-rerouting.test.ts)
    //   originating_thread_id      → hidden subrun thread (where the tool fired)
    //   metadata.runId/parentRunId → drives the breadcrumb
    //   metadata.hiddenThreadId    → drives the deep-link
    const approvalId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.approval_requests (
        id, org_id, handle, thread_id, originating_thread_id,
        tool_name, tool_params, current_payload, expires_at,
        requested_by, status, summary, metadata, notify_user_ids
      ) VALUES (
        ${approvalId}, ${world.org.id}, ${`s4-${Math.random().toString(36).slice(2, 8)}`},
        ${parentThreadId}, ${hiddenThreadId},
        'mcp:slack:post',
        ${env.db.sql.json({ channel: "#ops", text: "Investigating the alert." })},
        ${env.db.sql.json({ channel: "#ops", text: "Investigating the alert." })},
        ${expiresAt}, ${agentUser.id}, 'pending',
        ${env.db.sql.json({
          kind: "mcp.slack.post",
          title: "Post to #ops",
          subtitle: "Slack message",
          lines: ["#ops", "Investigating the alert."],
          links: [],
        })},
        ${env.db.sql.json({
          runId,
          parentRunId: runId,
          subagentType: "ticket-investigator",
          hiddenThreadId,
          label: "Investigate ops alert",
        })},
        ${[agentUser.id]}
      )
    `

    // Discussion thread of type='approval' — this is where ThreadView renders
    // the inline ApprovalCard (the rerouting fix targets `thread_id` for the
    // operator's primary thread surface, but the UI card itself appears on
    // the auto-created `type='approval'` discussion thread via
    // ThreadView.tsx:376 — `t().type === "approval"` + `cf.entityId`).
    const discussionRows = (await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.threads
        (id, org_id, handle, type, created_by, created_from)
      VALUES (
        gen_random_uuid(), ${world.org.id},
        ${`approval-${Math.random().toString(36).slice(2, 8)}`}, 'approval',
        ${agentUser.id},
        ${env.db.sql.json({
          app: "kernel",
          entityType: "approval_request",
          entityId: approvalId,
        })}
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>
    const discussionThreadId = discussionRows[0]!.id
    // Make the agent user a participant of the discussion thread so they can read it.
    await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.thread_participants (thread_id, user_id, org_id)
      VALUES (${discussionThreadId}, ${agentUser.id}, ${world.org.id})
    `

    // The discussion thread renders the live ApprovalCard inline at its
    // "approval-created" system message (MessageRow / MessageList), not from the
    // thread's created_from alone: seed the message production writes there.
    await env.db.sql`
      INSERT INTO ${env.db.sql(ks)}.messages
        (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes)
      VALUES (
        gen_random_uuid(), ${discussionThreadId}, ${world.org.id}, ${agentUser.id},
        'system', 'Approval requested',
        ${env.db.sql.json({ type: "approval-created", requestId: approvalId })},
        '{}'
      )
    `

    await loginAs(page, env, agentUser.email, "S4Pass1!")
    await page.goto(`http://localhost:${env.ports[1]}/threads/${discussionThreadId}`)

    const approvalCard = page.getByTestId("approval-card").first()
    await approvalCard.waitFor({ state: "visible", timeout: 30_000 })

    const breadcrumb = approvalCard.getByTestId("approval-card-subrun-breadcrumb")
    await expect(breadcrumb).toBeVisible()
    await expect(breadcrumb).toContainText(/Triggered by sub-run:/)
    await expect(breadcrumb).toContainText("ticket-investigator")

    const link = approvalCard.getByTestId("approval-card-subrun-link")
    await expect(link).toBeVisible()
    const href = await link.getAttribute("href")
    expect(href).toBe(`#/threads/${hiddenThreadId}`)
  })
})
