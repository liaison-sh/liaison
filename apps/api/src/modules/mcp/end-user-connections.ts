// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A PASSWORD CHANGE OR RESET ENDS THE PERSON'S MCP CONNECTIONS.
//
// An MCP connection is a standing credential of the person: its refresh token
// keeps minting access tokens with the person's own scopes, and it is not a
// sign-in session, so ending every session does not touch it. A password change
// or reset is the step a person takes when they think someone else had their
// account; a connection consented during that time (the OAuth authorize page or
// the device grant) must not outlive it. So both end every connection of the
// person in the same transaction as their sessions, and the person reconnects
// the AI tools they own.
//
// Refusal is immediate: `resolveConnectionFromToken` re-reads the connection on
// every request, so an access token of a revoked connection is refused on its
// next call, and the refresh grant checks `revoked_at` before minting.

import { and, eq, isNull } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { mcpConnections } from "~/db/schema/kernel"

/**
 * Revokes every live MCP connection of `userId`. Run it inside the transaction
 * that ends the person's sessions. Answers how many connections it ended.
 */
export async function revokeAllMcpConnectionsForUser(
  tx: PrivilegedDb,
  userId: string,
): Promise<number> {
  const ended = await tx
    .update(mcpConnections)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpConnections.userId, userId), isNull(mcpConnections.revokedAt)))
    .returning({ id: mcpConnections.id })
  return ended.length
}
