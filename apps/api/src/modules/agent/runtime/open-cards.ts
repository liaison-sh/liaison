// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether a conversation holds a secure card (a secret request), in any status,
// and whether a "connected" claim has anything connected behind it.
// Read by the agent runtime's card-claim check (false-approval-guard.ts): an
// answer that points the person at a secure card needs one in the conversation.
import { and, eq, or } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { secretRequests } from "~/db/schema/kernel/secret-requests"

/** A secret request in `threadId`, whatever its status (pending, saved, expired). */
export async function threadHasSecretRequest(orgId: string, threadId: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "secret-request-thread-any", (tx) =>
    tx
      .select({ id: secretRequests.id })
      .from(secretRequests)
      .where(and(eq(secretRequests.orgId, orgId), eq(secretRequests.threadId, threadId)))
      .limit(1),
  )
  return rows.length > 0
}

/** What a "connected" claim is checked against (card-claim.ts, claimsConnectedNow). */
export type ConnectedClaimVerdict = "not_judged" | "backed" | "false"

/** The app a card is about, as a claim names it (card-claim.ts, appsNamedInClaim). */
function cardApp(kind: string, target: Record<string, unknown>): string | null {
  if (kind === "google_integration_client") return "google"
  const app = typeof target.app === "string" ? target.app : null
  if (app === "google-calendar" || app === "calendar") return "calendar"
  return app
}

/**
 * Whether a "connected" claim stands:
 *   - not judged when this conversation holds no card and the turn filed none:
 *     the claim is then about something else;
 *   - false while a card of this conversation for what it names (any, when it
 *     names nothing known) is still waiting, whatever else the org holds;
 *   - backed when a card here was completed, or the organization or this
 *     person holds an active connected account; false otherwise.
 */
export async function connectionClaimVerdict(args: {
  orgId: string
  threadId: string
  userId: string
  namedApps: ReadonlySet<string>
  turnFiledCard: boolean
  now?: Date
}): Promise<ConnectedClaimVerdict> {
  const { orgId, threadId, userId } = args
  const now = args.now ?? new Date()
  return withPrivilegedDb(orgId, "connection-claim-verdict", async (tx) => {
    const cards = await tx
      .select({
        kind: secretRequests.kind,
        target: secretRequests.target,
        status: secretRequests.status,
        expiresAt: secretRequests.expiresAt,
      })
      .from(secretRequests)
      .where(and(eq(secretRequests.orgId, orgId), eq(secretRequests.threadId, threadId)))
    if (cards.length === 0 && !args.turnFiledCard) return "not_judged"
    const waiting = cards.filter(
      (c) =>
        c.status === "pending" &&
        c.expiresAt.getTime() > now.getTime() &&
        (args.namedApps.size === 0 || args.namedApps.has(cardApp(c.kind, c.target) ?? "")),
    )
    if (waiting.length > 0) return "false"
    if (cards.some((c) => c.status === "saved")) return "backed"
    const [account] = await tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.status, "active"),
          or(
            eq(connectedAccounts.ownerType, "org"),
            and(eq(connectedAccounts.ownerType, "user"), eq(connectedAccounts.ownerId, userId)),
          ),
        ),
      )
      .limit(1)
    return account ? "backed" : "false"
  })
}
