// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO IS ANSWERING THIS CONVERSATION FROM A MACHINE (A32).
//
// One read, in one place, used by the two callers that must agree about it: the
// dispatch guard, which does not start a server turn for a claimed agent, and
// the local reply route, which does not accept a reply for an unclaimed one. If
// those two ever disagreed the conversation would get two replies or none.
//
// It answers WHO holds the claim, not just that one is held: a claim belongs to
// its holder (the user AND the window that registered it), so the reply route
// can refuse a reply from anybody else in the room.
//
// EXPIRY IS READ, NEVER TRUSTED FROM A FLAG. The row outlives its lease (there
// is no sweeper keeping it honest): a claim past `expires_at` is dead, and a
// dead claim means the server answers again.
import { and, eq, gt, sql } from "drizzle-orm"
import { agentLocalClaims } from "~/db/schema/kernel"

/** One live claim: which agent, and whose machine is holding it. */
export interface LiveLocalClaim {
  agentId: string
  userId: string
  holderKey: string
  expiresAt: Date
}

/** Just enough of a client to run this one select. */
interface Selector {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => { where: (predicate: unknown) => Promise<LiveLocalClaim[]> }
  }
}

/**
 * Every claim on this thread that is live RIGHT NOW, by agent. Empty is the
 * ordinary case, so the caller's fast path is "nothing here, dispatch as
 * always".
 */
export async function liveLocalClaims(
  db: unknown,
  params: { orgId: string; threadId: string },
  now: Date = new Date(),
): Promise<Map<string, LiveLocalClaim>> {
  const rows = await (db as Selector)
    .select({
      agentId: agentLocalClaims.agentId,
      userId: agentLocalClaims.userId,
      holderKey: agentLocalClaims.holderKey,
      expiresAt: agentLocalClaims.expiresAt,
    })
    .from(agentLocalClaims)
    .where(
      and(
        eq(agentLocalClaims.orgId, params.orgId),
        eq(agentLocalClaims.threadId, params.threadId),
        gt(agentLocalClaims.expiresAt, sql`${now.toISOString()}::timestamptz`),
      ),
    )
  return new Map(rows.map((row) => [row.agentId, row]))
}

/**
 * The agents whose turns in this thread are being run on someone's machine
 * right now. The dispatch guard asks nothing else: who holds it does not change
 * whether the server answers.
 */
export async function liveLocalClaimHolders(
  db: unknown,
  params: { orgId: string; threadId: string },
  now: Date = new Date(),
): Promise<Set<string>> {
  return new Set((await liveLocalClaims(db, params, now)).keys())
}
