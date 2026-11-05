// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE QUESTION THE LAPTOP TOOK WITH IT (A32).
//
// While a machine holds a conversation the server does not answer in it: the
// desktop learned about the message and is running the turn. If that machine
// then dies (a lid closed, a window killed, a network gone), the lease lapses
// and the NEXT message is answered normally, but the one posted during the
// lease is answered by nobody, ever, with nothing in the room to say so. Every
// other skip in the dispatch guard posts a line precisely because a question
// that went nowhere looks exactly like an agent ignoring somebody.
//
// So a lapsed claim is swept: the message the guard skipped for that agent is
// dispatched once, as a server turn, audited as having followed a lapse. Once,
// because the sweep DELETES the lapsed row it acted on, and a claim row is the
// only thing that can be swept.
//
// It is deliberately narrow. A lapsed claim whose skipped message has already
// been answered (the machine posted before it died, or a later message was
// answered normally) is not re-dispatched: the row is simply removed.
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { writeAuditLog } from "~/modules/audit/service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  DISPATCH_SKIPPED_FOR_LOCAL,
  dispatchAgentMention,
} from "~/modules/threads/agent-dispatch-guard"
import { revokeTurnCredentials } from "./turn-credential"

/** The dispatch that answers a question the machine left behind. */
export const DISPATCH_AFTER_LOCAL_LAPSE = "agent.dispatch.after_local_lapse"

/**
 * How far back a lapsed claim is worth sweeping. A row older than this belongs
 * to a conversation that has moved on: the question is stale, and posting an
 * answer to it an hour later is worse than not posting one.
 */
export const LAPSE_SWEEP_WINDOW_MS = 15 * 60 * 1000

/**
 * A test seam: runs between the scan and the deletes, where a holder's
 * renewal can land. Null in production.
 */
export const lapseSweepSeam: { afterScan: (() => Promise<void>) | null } = { afterScan: null }

interface LapsedClaim {
  id: string
  org_id: string
  thread_id: string
  agent_id: string
  holder_key: string
  /** The expiry the scan read, exactly as stored (compared on delete). */
  expires_at: string
}

interface SkippedMessage {
  message_id: string
  author_id: string
  content: string
  /** The message came from a restricted (device-flow) session. */
  session_restricted: boolean
}

export interface LapseSweepResult {
  /** Claim rows removed, answered or not. */
  swept: number
  /** Turns started for a question the machine never answered. */
  dispatched: number
}

/**
 * One pass. Safe to run on every node: each claim row is deleted by the pass
 * that acts on it, so two nodes racing produce one dispatch, not two.
 */
export async function sweepLapsedLocalClaims(now: Date = new Date()): Promise<LapseSweepResult> {
  const log = rootLogger.child({ module: "local-claim-lapse" })
  const k = drizzleSql.raw(schemaRef("kernel"))
  const floor = new Date(now.getTime() - LAPSE_SWEEP_WINDOW_MS)

  const lapsed = await withSystemDb("local-claim-lapse-scan", async (db) =>
    extractRows<LapsedClaim>(
      await db.execute(drizzleSql`
        SELECT id::text AS id, org_id::text AS org_id, thread_id::text AS thread_id,
               agent_id::text AS agent_id, holder_key, expires_at::text AS expires_at
          FROM ${k}.agent_local_claims
         WHERE expires_at <= ${now.toISOString()}::timestamptz
           AND expires_at > ${floor.toISOString()}::timestamptz
         ORDER BY expires_at ASC
         LIMIT 100`),
    ),
  )

  if (lapseSweepSeam.afterScan) await lapseSweepSeam.afterScan()
  const result: LapseSweepResult = { swept: 0, dispatched: 0 }
  for (const claim of lapsed) {
    // THE ROW GOES FIRST. Whatever happens next, this claim is never swept
    // twice: a dispatch that throws must not leave a row that dispatches again
    // on the next tick. Only the row as the scan read it (batch-2 F9): a
    // renewal or a takeover since rewrote it on the same id, and that live
    // claim and its turn credential stay.
    const removed = await withSystemDb("local-claim-lapse-remove", async (db) =>
      extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          DELETE FROM ${k}.agent_local_claims
           WHERE id = ${claim.id}::uuid
             AND holder_key = ${claim.holder_key}
             AND expires_at = ${claim.expires_at}::timestamptz
             AND expires_at <= ${now.toISOString()}::timestamptz
          RETURNING id::text AS id`),
      ),
    )
    if (removed.length === 0) continue
    result.swept += 1
    // S59 (D43 F6): the turn that holder was running loses its credential with
    // the claim, never later.
    try {
      await revokeTurnCredentials({
        orgId: claim.org_id,
        agentId: claim.agent_id,
        threadId: claim.thread_id,
        holderKey: claim.holder_key,
      })
    } catch (err) {
      log.warn(
        { err, threadId: claim.thread_id },
        "Revoking a lapsed claim's turn credential failed",
      )
    }

    try {
      if (await dispatchSkippedMessage(claim, log)) result.dispatched += 1
    } catch (err) {
      log.warn({ err, threadId: claim.thread_id }, "Dispatching after a lapsed claim failed")
    }
  }
  return result
}

/** The message that was held back for this agent, if it is still unanswered. */
async function loadUnansweredSkip(claim: LapsedClaim): Promise<SkippedMessage | null> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("local-claim-lapse-skip", async (db) =>
    extractRows<SkippedMessage>(
      await db.execute(drizzleSql`
        SELECT m.id::text AS message_id, m.author_id::text AS author_id, m.content AS content,
               coalesce((a.metadata ->> 'sessionRestricted')::boolean, false) AS session_restricted
          FROM ${k}.audit_log a
          JOIN ${k}.messages m ON m.id = a.entity_id::uuid
         WHERE a.org_id = ${claim.org_id}::uuid
           AND a.agent_id = ${claim.agent_id}::uuid
           AND a.action = ${DISPATCH_SKIPPED_FOR_LOCAL}
           AND a.metadata ->> 'threadId' = ${claim.thread_id}
           AND m.thread_id = ${claim.thread_id}::uuid
           AND m.author_type = 'user'
           AND m.deleted_at IS NULL
           -- Still unanswered: nothing at all has been said in the room since.
           AND NOT EXISTS (
             SELECT 1 FROM ${k}.messages later
              WHERE later.thread_id = m.thread_id
                AND later.deleted_at IS NULL
                AND later.created_at > m.created_at
           )
         ORDER BY a.timestamp DESC
         LIMIT 1`),
    ),
  )
  return rows[0] ?? null
}

/** Just the two lines this module writes, so the pino type never leaks here. */
interface SweepLog {
  info: (fields: Record<string, unknown>, message: string) => void
  warn: (fields: Record<string, unknown>, message: string) => void
}

async function dispatchSkippedMessage(claim: LapsedClaim, log: SweepLog): Promise<boolean> {
  const skipped = await loadUnansweredSkip(claim)
  if (!skipped) return false

  const perms = await withPrivilegedDb(claim.org_id, "local-claim-lapse-perms", (db) =>
    loadEffectivePermissions(db, skipped.author_id, claim.org_id),
  )
  const outcome = await dispatchAgentMention(
    (fn) => withPrivilegedDb(claim.org_id, "local-claim-lapse-dispatch", fn as never) as never,
    {
      orgId: claim.org_id,
      threadId: claim.thread_id,
      calleeAgentId: claim.agent_id,
      callerAgentId: null,
      parentMessageId: null,
      triggerMessageId: skipped.message_id,
      questionText: skipped.content,
      actor: {
        userId: skipped.author_id,
        orgId: claim.org_id,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      },
      adderName: PERSONAL_AGENT_DISPLAY_NAME,
      // A message posted from a restricted (device-flow) session keeps that
      // mark when it is answered after the lapse (agent-dispatch-guard.ts).
      ...(skipped.session_restricted ? { turnContext: { sessionRestricted: true } } : {}),
    },
  )
  if (!outcome.allowed) {
    log.info(
      { threadId: claim.thread_id, agentId: claim.agent_id, reason: outcome.reason },
      "A lapsed claim's question was not re-dispatched",
    )
    return false
  }
  // The turn runs on its own; a failure there is the turn's to report, and an
  // unhandled rejection here would take the sweep down with it.
  outcome.turn?.catch((err: unknown) => {
    log.warn({ err, threadId: claim.thread_id }, "The turn after a lapsed claim failed")
  })

  await withPrivilegedDb(claim.org_id, "local-claim-lapse-audit", (db) =>
    writeAuditLog(db, {
      orgId: claim.org_id,
      actorId: skipped.author_id,
      actorType: "agent",
      app: "kernel",
      entityType: "message",
      entityId: skipped.message_id,
      action: DISPATCH_AFTER_LOCAL_LAPSE,
      agentId: claim.agent_id,
      metadata: { threadId: claim.thread_id, runLocation: "local" },
    }),
  )
  return true
}
