// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sub-run a chat turn spawned has no parent run row: it is its own chain root, and its own
// thread is the hidden one. The conversation the turn ran in (`parent_thread_id`) is still its
// surface: the person there can open its transcript (and its children's), and an approval it
// raises lands in that conversation, labelled with the sub-run that asked.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { listMessages } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let person: minimal.Session
let outsiderId: string
let chatThreadId: string
let hiddenThreadId: string
let childThreadId: string
const rootRunId = crypto.randomUUID()
const childRunId = crypto.randomUUID()

const ctx = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: person.orgId,
  scopes: ["*"],
  dimensionGrants: {},
})

async function hiddenThread(): Promise<string> {
  const [t] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, type, hidden_from_list, created_by)
    VALUES (${person.orgId}, ${`sr-${crypto.randomUUID().slice(0, 8)}`}, 'Sub-run', 'subrun', true,
      ${person.userId})
    RETURNING id`
  await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${t.id}, ${person.orgId}, ${person.userId}, 'system', 'Researching...', '{}')`
  return t.id
}

async function insertRun(a: {
  id: string
  parentRunId: string | null
  threadId: string
  parentThreadId: string
  depth: number
}) {
  const actorJson = JSON.stringify(ctx(person.userId))
  await sql`INSERT INTO kernel.agent_runs (
    id, org_id, parent_run_id, root_run_id, thread_id, parent_thread_id, subagent_type, actor,
    effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget, nesting_depth
  ) VALUES (
    ${a.id}, ${person.orgId}, ${a.parentRunId}, ${rootRunId}, ${a.threadId}, ${a.parentThreadId},
    'researcher', ${actorJson}::jsonb, ARRAY[]::text[], 'running', '', 10, 60000, 3, ${a.depth}
  )`
}

const read = (userId: string, threadId: string) =>
  withRlsContext(ctx(userId), (tx) =>
    listMessages(tx, { orgId: person.orgId, userId, threadId, limit: 50 }),
  )

describe("a sub-run a chat turn spawned: its surface is the conversation", () => {
  beforeAll(async () => {
    await acquireTestLock()
    person = await minimal.adminSession((await createTestOrg()).id)
    outsiderId = (await minimal.person(person.orgId)).id
    await ensureAppsForOrg(person.orgId)
    chatThreadId = await minimal.thread(person.orgId, person.userId)
    hiddenThreadId = await hiddenThread()
    childThreadId = await hiddenThread()
    await insertRun({
      id: rootRunId,
      parentRunId: null,
      threadId: hiddenThreadId,
      parentThreadId: chatThreadId,
      depth: 1,
    })
    await insertRun({
      id: childRunId,
      parentRunId: rootRunId,
      threadId: childThreadId,
      parentThreadId: hiddenThreadId,
      depth: 2,
    })
    toolRegistry.set([person.orgId, "kernel", "t_gated_write"], {
      appName: "kernel",
      name: "t_gated_write",
      description: "a gated write (test stand-in)",
      requiredScopes: ["kernel:threads:read"],
      gated: true,
      readOnly: true,
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as never)
  })

  afterAll(async () => {
    toolRegistry.delete([person.orgId, "kernel", "t_gated_write"])
    await releaseTestLock()
  })

  it("the person in the conversation can open the sub-run's transcript and its child's", async () => {
    const root = await read(person.userId, hiddenThreadId)
    const child = await read(person.userId, childThreadId)
    expect(root?.messages[0]?.content).toBe("Researching...")
    expect(child?.messages[0]?.content).toBe("Researching...")
  })

  it("someone outside the conversation cannot", async () => {
    expect(await read(outsiderId, hiddenThreadId)).toBeNull()
  })

  it("an approval the sub-run raises lands in the conversation, labelled with the sub-run", async () => {
    const frame: RunContext = {
      runId: rootRunId,
      parentRunId: null,
      rootRunId,
      nestingDepth: 1,
      turnScopeAccumulator: createTurnScopeAccumulator(),
    } as RunContext
    const res = (await runContextStore.run(frame, () =>
      executeToolCore({
        toolName: "kernel:t_gated_write",
        orgId: person.orgId,
        actor: ctx(person.userId),
        params: {},
        threadId: hiddenThreadId,
        origin: "in-app-agent",
      }),
    )) as { blocked?: { approvalRequestId?: string } }
    const id = res.blocked?.approvalRequestId ?? ""
    expect(id).not.toBe("")
    const [row] =
      await sql`SELECT thread_id, metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row?.thread_id).toBe(chatThreadId)
    expect(row?.metadata?.runId).toBe(rootRunId)
    expect(row?.metadata?.subagentType).toBe("researcher")
    expect(row?.metadata?.hiddenThreadId).toBe(hiddenThreadId)
  })
})
