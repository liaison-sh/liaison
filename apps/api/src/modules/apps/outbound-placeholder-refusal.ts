// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The one refusal for outbound text carrying an unfilled placeholder, shared by every path an
 * agent's text reaches a person through: a tool call (executeToolCore, before any gate) and an
 * agent's edit of a pending approval's payload (approvals/edit.ts).
 */
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { appsLogger as log } from "~/lib/logger"
import {
  findOutboundPlaceholders,
  outboundPlaceholderMessage,
  todayInTimezone,
} from "~/modules/apps/outbound-placeholders"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The acting person's timezone (their own row), UTC when unset or unreadable. */
async function personTimezone(orgId: string, userId: string): Promise<string> {
  try {
    const [row] = await withPrivilegedDb(orgId, "outbound-placeholder-tz", (tx) =>
      tx.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)),
    )
    return row?.tz || "UTC"
  } catch (err) {
    log.warn({ err, orgId, userId }, "outbound placeholder refusal: timezone lookup failed")
    return "UTC"
  }
}

/**
 * The model-facing refusal when `params` carries a placeholder in one of the tool's declared
 * `outboundTextParams`, else null. Today's date is given in the acting person's timezone.
 */
export async function outboundPlaceholderRefusal(args: {
  orgId: string
  userId: string | null | undefined
  params: unknown
  outboundTextParams: readonly string[] | undefined
}): Promise<string | null> {
  const hits = findOutboundPlaceholders(args.params, args.outboundTextParams)
  if (hits.length === 0) return null
  const timezone =
    args.userId && UUID.test(args.userId) ? await personTimezone(args.orgId, args.userId) : "UTC"
  return outboundPlaceholderMessage(hits, todayInTimezone(timezone))
}
