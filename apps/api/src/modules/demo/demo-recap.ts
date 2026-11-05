// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a demo visitor did in their workspace, for the recap line of the "next
// steps" dialog (GET /api/demo/recap):
//
//   startedAt        when the workspace became the visitor's: the marker's
//                    `createdAt`, written when a signup (or a start over)
//                    claims or creates the org (demo-org.ts visitorMarker)
//   agentActions     tool calls the workspace's agents made since then: every
//                    agent message stores its calls in `metadata.toolCalls`
//                    (agent-service.ts)
//   approvalsDecided approval requests the visitor decided since then
//
// "Since then" matters: a pooled workspace is seeded before a visitor claims
// it, and the claim turns the seed's account into the visitor's (same user id),
// so anything the seed did must not count as theirs.
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

export interface DemoRecap {
  startedAt: string
  agentActions: number
  approvalsDecided: number
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >
}

/** The visitor's recap for `orgId`, counted from `startedAt` (an ISO 8601 time). */
export async function demoRecapForOrg(
  orgId: string,
  userId: string,
  startedAt: string,
): Promise<DemoRecap> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const [counts] = await withPrivilegedDb(orgId, "demo-recap", async (tx) =>
    rowsOf(
      await tx.execute(drizzleSql`
        SELECT
          (SELECT COALESCE(SUM(jsonb_array_length(m.metadata->'toolCalls')), 0)
             FROM ${k}.messages m
            WHERE m.org_id = ${orgId}::uuid
              AND m.author_type = 'agent'
              AND m.created_at >= ${startedAt}::timestamptz
              AND jsonb_typeof(m.metadata->'toolCalls') = 'array') AS agent_actions,
          (SELECT COUNT(*)
             FROM ${k}.approval_requests a
            WHERE a.org_id = ${orgId}::uuid
              AND a.decided_by = ${userId}::uuid
              AND a.decided_at >= ${startedAt}::timestamptz) AS approvals_decided
      `),
    ),
  )
  return {
    startedAt,
    agentActions: Number(counts?.agent_actions ?? 0),
    approvalsDecided: Number(counts?.approvals_decided ?? 0),
  }
}
