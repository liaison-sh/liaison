// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one thing an audit row must not do is fail because of who it names.
//
// `audit_log.agent_id` carries a composite `(agent_id, org_id)` foreign key
// (0070). An agent that has since been DELETED therefore aborts the INSERT,
// and inside an already-open transaction nothing can retry it: postgres has
// aborted the transaction on its first failed statement. Callers that write a
// REQUIRED audit row (a disclosure, a shown withheld card) would take their own
// operation down with it.
//
// So the id is resolved BEFORE the insert: an agent of this org is named, and
// anything else records no agent at all. A deleted agent costs the row its
// agent name, never the row, which is where every other audit path in the
// product already landed.

import { and, eq } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { agents } from "~/db/schema/kernel/agents"

export async function resolveAuditAgentId(
  db: RlsClient | PrivilegedDb,
  orgId: string,
  agentId: string | null | undefined,
): Promise<string | null> {
  if (!agentId) return null
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1)
  return row?.id ?? null
}
