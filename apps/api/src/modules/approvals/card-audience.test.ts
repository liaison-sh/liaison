// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO READS A RECORD'S NAME ON A REQUEST. Two people may decide the same request, and only one may
// read the record it is about. Home, the list and the request itself name it to that one; what is
// stored, sent to many at once (a live event) or sent with nobody reading (a reminder, and so its
// push and its digest) names it to nobody.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  type DealWorld,
  makeTask,
  makeWorkProject,
} from "~/apps/projects/service/__tests__/deal-world"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { loadApprovalSummary } from "~/modules/approvals/event-data"
import { getApproval, listApprovals } from "~/modules/approvals/list"
import { runRoutedReminderSweep } from "~/modules/approvals/routed-reminders"
import { entityRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"
import { executeTool } from "~/modules/apps/execute-tool"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TOOL = "invoicing:billing_step_add"
const NAME = "Harbour portal rebuild"

let w: DealWorld
let request = ""
let taskId = ""
let threadId = ""
/** A step's stored card, of the same task. */
let step: unknown
let reader: UserContext
let decider: UserContext

const person = async (scopes: string[]): Promise<UserContext> => {
  const { id } = await minimal.person(w.orgId, { name: "Fixture decider" })
  for (const scope of scopes) await minimal.grantScope(id, scope)
  return { actorType: "user", userId: id, orgId: w.orgId, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await acquireTestLock()
  const orgId = (await createTestOrg()).id
  const userId = (await minimal.orgAdmin(orgId)).id
  w = {
    orgId,
    userId,
    actor: { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
  }
  entityRegistry.set([w.orgId, "projects", "task"], {
    labelField: "title",
    handlePrefix: "x",
    tableName: "tasks",
    readScope: "projects:projects:read",
  } as never)
  const project = (await makeWorkProject(w, "Client portal")).projectId
  const task = await makeTask(w, project, NAME)
  taskId = task
  decider = await person(["invoicing:approve"])
  reader = await person(["invoicing:approve", "projects:projects:read"])
  const params = { taskId: task, step: "Kick-off" }
  const summary = await withRlsContext({ ...w.actor, scopes: ["*"] }, (tx) =>
    generateApprovalSummary(
      w.orgId,
      "invoicing",
      "billing_step_add",
      params,
      { tx, orgId: w.orgId, userId: w.userId, actor: w.actor },
      TOOL,
    ),
  )
  const thread = await minimal.thread(w.orgId, w.userId, { title: "Audience fixtures" })
  threadId = thread
  step = await withRlsContext({ ...w.actor, scopes: ["*"] }, (tx) =>
    generateApprovalSummary(
      w.orgId,
      "projects",
      "archive",
      { id: task },
      { tx, orgId: w.orgId, userId: w.userId, actor: w.actor },
      "projects:archive",
    ),
  )
  request = randomUUID()
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id: request,
      org_id: w.orgId,
      handle: `request-${request.slice(0, 8)}`,
      thread_id: thread,
      originating_thread_id: thread,
      tool_name: TOOL,
      tool_params: JSON.stringify(params),
      current_payload: JSON.stringify(params),
      approve_scope: "invoicing:approve",
      expires_at: { raw: "now() + INTERVAL '3 days'" },
      created_at: { raw: "now() - INTERVAL '25 hours'" },
      notify_user_ids: `{${decider.userId},${reader.userId}}`,
      route_person_id: reader.userId,
      requested_by: w.userId,
      status: "pending",
      summary: JSON.stringify(summary),
      metadata: JSON.stringify({ originRoutineId: randomUUID() }),
    }),
  )
}, 120_000)

afterAll(async () => {
  entityRegistry.deleteByPrefix([w.orgId])
  await releaseTestLock()
})

/** What one person is sent about the request, on the three surfaces that show its card. */
async function seenBy(who: UserContext): Promise<string[]> {
  return withRlsContext(who, async (tx) => {
    const home = await computeApprovalAttentionItems(tx, w.orgId, who.userId)
    const list = await listApprovals(tx, {
      orgId: w.orgId,
      userId: who.userId,
      scopes: who.scopes,
    })
    const one = await getApproval(tx, {
      orgId: w.orgId,
      userId: who.userId,
      requestId: request,
    })
    expect(home.some((i) => i.entityId === request)).toBe(true)
    expect(list.map((r) => r.id)).toEqual([request])
    expect(one?.id).toBe(request)
    return [home, list, one].map((surface) => JSON.stringify(surface))
  })
}

describe("a record of another app, on a request two people may decide", () => {
  it("is named to the one who may read it, on Home, in the list and on the request", async () => {
    for (const surface of await seenBy(reader)) expect(surface).toContain(NAME)
  })

  it("is not named to the other, on any of them", async () => {
    for (const surface of await seenBy(decider)) {
      expect(surface).not.toContain(NAME)
      expect(surface).toContain("a task")
    }
  })

  it("is not in what is stored, nor in a live event", async () => {
    const [row] = await sql<{ summary: unknown }[]>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${request}::uuid`
    expect(JSON.stringify(row)).not.toContain(NAME)
    const event = await withPrivilegedDb(w.orgId, "test-card-audience", (tx) =>
      loadApprovalSummary(tx, w.orgId, request),
    )
    expect(JSON.stringify(event)).not.toContain(NAME)
    expect(event.summary.namesHeld).toBe(true)
    expect(event.summary.names).toBeUndefined()
  })

  it("is named by the last step of a sequence only to who may read it", async () => {
    const bundle = randomUUID()
    await sql`
      INSERT INTO kernel.approval_requests
        (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, approve_scope, expires_at, notify_user_ids, requested_by, status, summary,
         bundle_id, bundle_position, depends_on_id)
      SELECT CASE WHEN step = 0 THEN ${bundle}::uuid ELSE gen_random_uuid() END, org_id,
             'step-' || step || handle, thread_id, originating_thread_id, 'projects:archive',
             tool_params, current_payload, approve_scope, expires_at, notify_user_ids, requested_by,
             'pending', ${JSON.stringify(step)}::text::jsonb, ${bundle}::uuid, step,
             CASE WHEN step = 1 THEN ${bundle}::uuid END
        FROM kernel.approval_requests, generate_series(0, 1) step
       WHERE id = ${request}::uuid ORDER BY step`
    const title = async (who: UserContext) =>
      withRlsContext(who, async (tx) => {
        const home = await computeApprovalAttentionItems(tx, w.orgId, who.userId)
        return JSON.stringify(home.find((i) => i.entityId === bundle))
      })
    const [named, plain] = [await title(reader), await title(decider)]
    await sql`DELETE FROM kernel.approval_requests WHERE bundle_id = ${bundle}::uuid AND id <> ${bundle}::uuid`
    await sql`DELETE FROM kernel.approval_requests WHERE id = ${bundle}::uuid`
    expect(named).toContain(`Projects: archive: ${NAME}`)
    expect(plain).not.toContain(NAME)
  })

  it("is not in what the agent that asked is answered, and stands by kind in what is stored", async () => {
    toolRegistry.set([w.orgId, "projects", "held"], {
      appName: "projects",
      name: "held",
      description: "A held change of a task",
      requiredScopes: ["projects:projects:write"],
      gated: true,
      handler: async () => ({ ok: true }),
    } as never)
    const answer = await executeTool({
      toolName: "projects:held",
      orgId: w.orgId,
      actor: w.actor,
      threadId,
      params: { taskId },
    })
    toolRegistry.delete([w.orgId, "projects", "held"])
    const id = answer.blocked?.approvalRequestId
    expect(id).toBeTruthy()
    expect(JSON.stringify(answer)).not.toContain(NAME)
    expect(JSON.stringify(answer.blocked?.summary)).not.toContain(taskId)
    const [row] = await sql<{ summary: { title: string; names?: unknown[] } }[]>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${id as string}::uuid`
    await sql`UPDATE kernel.approval_requests SET status = 'cancelled' WHERE id = ${id as string}::uuid`
    expect(row?.summary.title).toBe("Projects: held")
    expect(row?.summary.names).toHaveLength(2)
  })

  it("is not in the reminder its deciders are sent", async () => {
    await runRoutedReminderSweep({ orgId: w.orgId })
    const sent = await sql<{ text: string }[]>`
      SELECT payload::text AS text FROM kernel.pending_events
       WHERE org_id = ${w.orgId}::uuid AND payload->>'entityId' = ${request}
         AND payload->>'entity' = 'agent_notification'`
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).not.toContain(NAME)
    expect(sent[0]?.text).toContain("Invoicing: billing step add")
  })
})
