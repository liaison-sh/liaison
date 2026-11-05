// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The node credential (A25): an opaque token the desktop app holds for its
 * node, stored hashed on the node row. Enabling (again) rotates it; DELETE
 * revokes it. Every node-to-server job call presents it next to the owner's
 * session, and both must name the same person.
 *
 * A simulated node (a demo org's recorded laptop, `nodes.simulated`) never
 * holds a credential (0193 CHECK), and every lookup here leaves it out on top
 * of that: no node-auth path (job claim and batches, command pull, WS hello,
 * folders, permission prompts) can ever speak for it.
 */
import { createHash, randomBytes } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { nodes } from "~/db/schema/kernel"

/** Prefix of a node credential: recognisable in a log, never a session token. */
export const NODE_CREDENTIAL_PREFIX = "lnn_"
/** The header a node presents its credential in (the session keeps Authorization). */
export const NODE_CREDENTIAL_HEADER = "X-Node-Credential"

export function hashNodeCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** A fresh credential and the hash the row stores. */
export function mintNodeCredential(): { token: string; hash: string } {
  const token = `${NODE_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`
  return { token, hash: hashNodeCredential(token) }
}

export type NodeRow = typeof nodes.$inferSelect

/** The live node a credential speaks for, or null (unknown, rotated, revoked, simulated). */
export async function verifyNodeCredential(token: string): Promise<NodeRow | null> {
  if (!token.startsWith(NODE_CREDENTIAL_PREFIX) || token.length > 200) return null
  const [row] = await withSystemDb("nodes:credential-verify", (db) =>
    db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.credentialHash, hashNodeCredential(token)),
          isNull(nodes.revokedAt),
          eq(nodes.simulated, false),
        ),
      )
      .limit(1),
  )
  return row && !isSimulatedNode(row) ? row : null
}

/** Whether a node row is a simulated (recorded, machine-less) demo node. */
export function isSimulatedNode(node: Pick<NodeRow, "simulated">): boolean {
  return node.simulated === true
}

/**
 * The node this request's credential speaks for, checked against the session:
 * 401 without a valid credential, 403 when it belongs to someone else (another
 * user's session presenting it, or another org).
 */
export async function requireNodeCredential(c: Context<AppEnv>): Promise<NodeRow> {
  const token = c.req.header(NODE_CREDENTIAL_HEADER)
  const node = token ? await verifyNodeCredential(token) : null
  if (!node) throw new HTTPException(401, { message: "a valid node credential is required" })
  if (node.ownerUserId !== c.get("userId") || node.orgId !== c.get("orgId")) {
    throw new HTTPException(403, { message: "this node credential is not yours" })
  }
  return node
}
