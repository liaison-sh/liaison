// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { approvalHandleCounters, approvalRequests } from "~/db/schema/kernel"

const SEQ_NAME_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i

type SqlClient = RlsClient | RlsTx | PrivilegedDb

export async function nextHandle(
  tx: SqlClient,
  sequenceName: string,
  prefix: string,
): Promise<string> {
  if (!SEQ_NAME_RE.test(sequenceName)) {
    throw new Error(`Invalid sequence name: ${sequenceName}`)
  }
  const result = await tx.execute(
    drizzleSql`SELECT nextval(${drizzleSql.raw(`'${sequenceName}'`)}::regclass)`,
  )
  const row = extractRows<{ nextval: bigint | number | string }>(result)[0]
  if (!row) throw new Error(`nextval returned no rows for ${sequenceName}`)
  return `${prefix}-${row.nextval}`
}

/**
 * The next approval handle (`request-N`) of one organisation, from its own
 * counter (migration 0215): numbers count only that organisation's approvals.
 * The first one of an organisation with no counter yet is `request-1`. A number
 * the organisation already holds (drawn from the old instance-wide sequence
 * while a deploy rolled over) is skipped, so the insert never meets it.
 */
export async function nextApprovalHandle(tx: SqlClient, orgId: string): Promise<string> {
  for (;;) {
    const [row] = await tx
      .insert(approvalHandleCounters)
      .values({ orgId, lastValue: 1 })
      .onConflictDoUpdate({
        target: approvalHandleCounters.orgId,
        set: { lastValue: drizzleSql`${approvalHandleCounters.lastValue} + 1` },
      })
      .returning({ lastValue: approvalHandleCounters.lastValue })
    if (!row) throw new Error(`approval handle counter returned no row for org ${orgId}`)
    const handle = `request-${row.lastValue}`
    const [taken] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.handle, handle)))
      .limit(1)
    if (!taken) return handle
  }
}
