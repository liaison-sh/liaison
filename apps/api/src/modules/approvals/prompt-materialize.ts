// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APPROVAL REACHES ITS APPROVERS AT ONCE.
//
// The approvals group pushes from the attention row the state materializer
// writes when it first sees a pending approval (fanout-consumer.ts: one
// approval, one push). That materializer is a once-a-minute scheduled job, so a
// gated call reached the approvers' phones 0 to 60 s after it was made (48 s
// and 18 s measured on demo, 2026-10-07). This durable consumer runs the same
// materializer for the approval's notify audience as soon as its `create`
// event leaves the outbox. The minute job is unchanged and still the backstop:
// the materializer's insert-once rule means whichever run sees the approval
// first pushes it, and the other finds the row and pushes nothing.

import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import { rootLogger } from "~/lib/logger"
import { runStateMaterializeOnce } from "~/modules/attention/state-materializer"

const log = rootLogger.child({ module: "approval-prompt-materialize" })
const K = sql.raw(schemaRef("kernel"))

export const APPROVAL_MATERIALIZE_CONSUMER = "approval-materialize"

export interface ApprovalMaterializeDeps {
  /** The approval's notify audience, active users only. */
  loadAudience: (orgId: string, approvalId: string) => Promise<string[]>
  /** One materializer pass over these users of the org. */
  materialize: (orgId: string, userIds: string[]) => Promise<void>
}

async function defaultLoadAudience(orgId: string, approvalId: string): Promise<string[]> {
  return withPrivilegedDb(
    orgId,
    "approval-prompt-materialize:audience",
    async (tx: PrivilegedDb) => {
      const rows = (await tx.execute(
        sql`SELECT u.id FROM ${K}.approval_requests ar
          JOIN ${K}.users u ON u.org_id = ar.org_id AND u.id = ANY(ar.notify_user_ids)
          WHERE ar.org_id = ${orgId} AND ar.id = ${approvalId} AND u.status = 'active'`,
      )) as unknown as Array<{ id: string }>
      return rows.map((r) => r.id)
    },
  )
}

const defaultDeps: ApprovalMaterializeDeps = {
  loadAudience: defaultLoadAudience,
  materialize: (orgId, userIds) =>
    runStateMaterializeOnce({ orgId }, { listActiveUsers: async () => userIds }),
}

export async function handleApprovalCreatedMaterialize(
  ctx: DurableEventContext,
  deps: ApprovalMaterializeDeps = defaultDeps,
): Promise<void> {
  const event = ctx.event
  if (event.entity !== "approval_request" || event.action !== "create") return
  if (!event.orgId || !event.entityId) return
  try {
    const users = await deps.loadAudience(event.orgId, event.entityId)
    if (users.length === 0) return
    await deps.materialize(event.orgId, users)
  } catch (err) {
    // Never rethrow: the minute job still pushes it; the outbox row is not
    // held hostage for a faster push.
    log.warn({ err, approvalId: event.entityId }, "prompt approval materialize failed")
  }
}

export function registerApprovalMaterializeConsumer(): void {
  registerDurableEventConsumer(APPROVAL_MATERIALIZE_CONSUMER, (ctx) =>
    handleApprovalCreatedMaterialize(ctx),
  )
}
