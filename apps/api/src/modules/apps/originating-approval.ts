// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { UUID_RE } from "~/lib/uuid"

const K = drizzleSql.raw(schemaRef("kernel"))

/** Internal tools that skip their own approval card because the calling app already gated the
 *  action, and name that approval in `originating_approval_id`. */
export const ORIGINATING_APPROVAL_TOOLS: ReadonlySet<string> = new Set(["mail:composeForApp"])

/**
 * Check the `originating_approval_id` a cross-app caller hands an internal send tool.
 *
 * An absent id is the app's own automatic flow (for example invoicing's auto-email, switched on
 * by a setting that is itself a gated change): the capability the operator granted at install
 * authorises it. A PRESENT id must name a real approval of THIS org, for a tool of the CALLING
 * app, that a human has approved and that is executing or executed. Anything else (a made-up id,
 * another org's id, an approval of a different app, a pending or denied one) is refused, so a
 * caller cannot dress an unapproved send up as an approved one.
 */
/** How long after its decision an approval may still be named as the origin of a send. */
const ORIGINATING_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000

function addressList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []
  return list
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
}

/** The approval row an `originating_approval_id` names, as read for the check. */
export interface OriginatingApprovalRow {
  tool_name: string
  status: string
  decided_at?: Date | string | null
  approving_started_at?: Date | string | null
  current_payload?: unknown
  tool_params?: unknown
}

type Verdict = { ok: true } | { ok: false; message: string }

export async function verifyOriginatingApproval(args: {
  orgId: string
  callerApp: string
  approvalId: unknown
  /** The send's own params: its to / cc / bcc are bounded by the approval when it named any. */
  sendParams?: unknown
}): Promise<Verdict> {
  const id = args.approvalId
  if (id === undefined || id === null || id === "") return { ok: true }
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return { ok: false, message: "originating_approval_id is not a valid approval id" }
  }
  const rows = await withPrivilegedDb(args.orgId, "verify-originating-approval", async (tx) =>
    extractRows<OriginatingApprovalRow>(
      await tx.execute(
        drizzleSql`SELECT tool_name, status, decided_at, approving_started_at, current_payload, tool_params
                   FROM ${K}.approval_requests WHERE id = ${id} AND org_id = ${args.orgId} LIMIT 1`,
      ),
    ),
  )
  return judgeOriginatingApproval(rows[0], args)
}

/**
 * The decision on the approval row `verifyOriginatingApproval` read (undefined when the id names
 * no approval of the org): approved or executing, of the calling app, recent, and covering every
 * recipient of the send when it named any.
 */
export function judgeOriginatingApproval(
  row: OriginatingApprovalRow | undefined,
  args: { callerApp: string; sendParams?: unknown },
  now: number = Date.now(),
): Verdict {
  if (!row)
    return { ok: false, message: "originating_approval_id names no approval of this organisation" }
  if (row.status !== "approved" && row.status !== "approving") {
    return { ok: false, message: `originating approval is ${row.status}, not approved` }
  }
  if (!row.tool_name.startsWith(`${args.callerApp}:`)) {
    return { ok: false, message: "originating approval belongs to a different app than the caller" }
  }
  const decided = row.decided_at ?? row.approving_started_at
  if (decided && now - new Date(decided).getTime() > ORIGINATING_APPROVAL_MAX_AGE_MS) {
    return { ok: false, message: "originating approval is too old to authorise a new send" }
  }
  // When the approved action named its recipients, the send may only go to them.
  const payload = (row.current_payload ?? row.tool_params) as Record<string, unknown> | null
  const approvedTo = addressList(payload && typeof payload === "object" ? payload.to : undefined)
  if (approvedTo.length > 0) {
    const p = (args.sendParams ?? {}) as Record<string, unknown>
    const recipients = [...addressList(p.to), ...addressList(p.cc), ...addressList(p.bcc)]
    const outside = recipients.filter((r) => !approvedTo.includes(r))
    if (outside.length > 0) {
      return {
        ok: false,
        message: "the send goes to an address the originating approval did not name",
      }
    }
  }
  return { ok: true }
}
