// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TURN CREDENTIAL OF A DESKTOP LOCAL TURN (S59, D36a, D37, A34).
//
// The personal agent in the desktop's computer mode runs a local Claude turn
// that reaches Liaison through the MCP gateway with the agent's own connection
// token. That token proves which agent is calling, never that a person is
// behind the call, so the gateway refuses the tools that act only on a
// person's request (their computer sessions). The local claim already ties a
// turn to one person's message: the desktop re-reads that message from the
// server before running it (`GET …/local-claims/:threadId/messages/:id`). That
// read mints this credential, and the turn's gateway calls present it
// (`NODE_TURN_CREDENTIAL_HEADER`).
//
// What makes it narrow:
// - minted only for an unanswered message the caller wrote, to the holder of
//   the live claim on that conversation; at most one live per (message, holder);
// - stored hashed (the raw value exists only in the answer and on the
//   desktop), never logged;
// - valid 30 minutes from minting, checked in code as well as by the TTL;
// - valid only on that person's own desktop agent connection for that agent,
//   never on another connection of the same agent nor a node session's;
// - revoked when the turn's reply is persisted, when another holder takes
//   the claim over, when the claim is released or swept, and at its first
//   presentation once the claim has lapsed;
// - it makes a call a GATEWAY TURN (`RunContext.gatewayTurn`), never a
//   human-typed one: send, answer and an autonomy change still park.

import { createHash, randomBytes } from "node:crypto"
import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { agentLocalClaims, mcpConnections } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { DESKTOP_CONNECTION_LABEL } from "~/modules/mcp/desktop-connection-routes"
import { DESKTOP_DEVICE_CLIENT_ID } from "~/modules/mcp/device-client-policy"
import { connectionRunsNodeSessions } from "~/modules/mcp/node-session-connection"

/** How long a minted credential is honoured. */
export const TURN_CREDENTIAL_TTL_MS = 30 * 60 * 1000

/** The wire shape: 32 random bytes, base64url, no padding. */
export const TURN_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The clock the age check reads. Replaced by tests only. */
export const turnCredentialClock = { now: (): number => Date.now() }

/** What the server keeps about one credential, under its hash. */
export interface TurnCredentialRecord {
  orgId: string
  userId: string
  agentId: string
  threadId: string
  messageId: string
  /** The reply thread the message was asked in; null in the channel. */
  replyRootId: string | null
  holderKey: string
  mintedAt: number
  /** The minting session was a restricted (device-flow) sign-in. */
  restricted: boolean
}

/** The turn a valid credential proves, as the gateway frame carries it. */
export interface GatewayTurn {
  threadId: string
  messageId: string
  replyRootId: string | null
  restricted: boolean
}

const TTL_SECONDS = Math.ceil(TURN_CREDENTIAL_TTL_MS / 1000)

function digest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

const recordKey = (hash: string) => `turncred:${hash}`
const liveKey = (r: {
  orgId: string
  agentId: string
  threadId: string
  messageId: string
  holderKey: string
}) => `turncred:live:${r.orgId}:${r.agentId}:${r.threadId}:${r.messageId}:${r.holderKey}`
const holderKey = (r: { orgId: string; agentId: string; threadId: string; holderKey: string }) =>
  `turncred:holder:${r.orgId}:${r.agentId}:${r.threadId}:${r.holderKey}`

/**
 * Mint one credential for this (message, holder). A previous live one for the
 * same pair (a retried fetch) is deleted first, so at most one is ever live.
 */
export async function mintTurnCredential(
  input: Omit<TurnCredentialRecord, "mintedAt">,
): Promise<string> {
  const raw = randomBytes(32).toString("base64url")
  const hash = digest(raw)
  const record: TurnCredentialRecord = { ...input, mintedAt: turnCredentialClock.now() }
  const live = liveKey(input)
  const holder = holderKey(input)
  const previous = await redis.get(live)
  const tx = redis.multi()
  if (previous) {
    tx.del(recordKey(previous))
    tx.srem(holder, previous)
  }
  tx.set(recordKey(hash), JSON.stringify(record), "EX", TTL_SECONDS)
  tx.set(live, hash, "EX", TTL_SECONDS)
  tx.sadd(holder, hash)
  tx.expire(holder, TTL_SECONDS)
  await tx.exec()
  return raw
}

/** The record behind a presented value, or null (malformed, unknown, revoked, too old). */
export async function lookupTurnCredential(
  raw: string | null | undefined,
): Promise<TurnCredentialRecord | null> {
  if (typeof raw !== "string" || !TURN_CREDENTIAL_PATTERN.test(raw)) return null
  const stored = await redis.get(recordKey(digest(raw)))
  if (!stored) return null
  let record: TurnCredentialRecord
  try {
    record = JSON.parse(stored) as TurnCredentialRecord
  } catch {
    return null
  }
  if (typeof record.mintedAt !== "number") return null
  const age = turnCredentialClock.now() - record.mintedAt
  if (age < 0 || age > TURN_CREDENTIAL_TTL_MS) return null
  return record
}

/**
 * Revoke every credential minted for this holder on this (conversation,
 * agent): the turn's reply was persisted, or another holder took the claim.
 */
export async function revokeTurnCredentials(r: {
  orgId: string
  agentId: string
  threadId: string
  holderKey: string
}): Promise<void> {
  const holder = holderKey(r)
  const hashes = await redis.smembers(holder)
  const tx = redis.multi()
  for (const hash of hashes) {
    const stored = await redis.get(recordKey(hash))
    tx.del(recordKey(hash))
    if (stored) {
      try {
        const rec = JSON.parse(stored) as TurnCredentialRecord
        const live = liveKey(rec)
        // Only the pointer that still names this hash: a newer mint is not ours.
        if ((await redis.get(live)) === hash) tx.del(live)
      } catch {
        // A record that does not parse is deleted above; nothing else to find.
      }
    }
  }
  tx.del(holder)
  await tx.exec()
}

/** Is this connection the person's own desktop agent connection for this agent? */
async function isDesktopAgentConnection(
  orgId: string,
  userId: string,
  agentId: string,
  connectionId: string,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return false
  const rows = await withSystemDb("turn-credential-connection", (db) =>
    db
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.id, connectionId),
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.userId, userId),
          eq(mcpConnections.agentId, agentId),
          // The two marks only the desktop connection route writes (a device
          // grant stores its client id under the `mcp:` prefix, and an OAuth
          // client a random one): `desktop-connection-routes.ts`.
          eq(mcpConnections.clientId, DESKTOP_DEVICE_CLIENT_ID),
          eq(mcpConnections.label, DESKTOP_CONNECTION_LABEL),
          isNull(mcpConnections.revokedAt),
        ),
      )
      .limit(1),
  )
  return rows.length > 0
}

/** Does this holder still hold the live claim the credential was minted under? */
async function holdsLiveClaim(record: TurnCredentialRecord): Promise<boolean> {
  const rows = await withSystemDb("turn-credential-claim", (db) =>
    db
      .select({ id: agentLocalClaims.id })
      .from(agentLocalClaims)
      .where(
        and(
          eq(agentLocalClaims.orgId, record.orgId),
          eq(agentLocalClaims.threadId, record.threadId),
          eq(agentLocalClaims.agentId, record.agentId),
          eq(agentLocalClaims.userId, record.userId),
          eq(agentLocalClaims.holderKey, record.holderKey),
          gt(agentLocalClaims.expiresAt, sql`now()`),
        ),
      )
      .limit(1),
  )
  return rows.length > 0
}

/**
 * The gateway turn a presented credential proves for THIS call, or null.
 * Anything short of every check is the same null as no credential at all:
 * never an error, never a reason on the wire.
 */
export async function resolveGatewayTurn(input: {
  raw: string | null | undefined
  orgId: string
  userId: string
  agentId: string | undefined
  connectionId: string
}): Promise<GatewayTurn | null> {
  if (!input.raw || !input.agentId) return null
  const record = await lookupTurnCredential(input.raw)
  if (!record) return null
  if (
    record.orgId !== input.orgId ||
    record.userId !== input.userId ||
    record.agentId !== input.agentId
  ) {
    return null
  }
  // Batch-2 F11: a lapsed claim's credential dies now, not at the next sweep.
  if (!(await holdsLiveClaim(record))) {
    await revokeTurnCredentials(record)
    return null
  }
  if (
    !(await isDesktopAgentConnection(input.orgId, input.userId, input.agentId, input.connectionId))
  )
    return null
  if (await connectionRunsNodeSessions(input.orgId, input.connectionId)) return null
  return {
    threadId: record.threadId,
    messageId: record.messageId,
    replyRootId: record.replyRootId ?? null,
    restricted: record.restricted === true,
  }
}
