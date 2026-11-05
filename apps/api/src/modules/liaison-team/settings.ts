// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The instance-wide "share with the Liaison team" switches
// (`kernel.instance_settings` key `liaison_team.sharing`): register this server
// (a random id, the version, the edition and the active user count), allow
// forwarding bug reports (needs registration), and send bug reports ONLY to the
// Liaison team, with no local ticket (`bugReportsTeamOnly`, needs forwarding;
// it applies to the operator org's reporters only, docs/self-hosting/liaison-team.md).
// All start off; an admin of the operator org turns them on. `setSharing`
// applies every transition:
//
//   on, no identity         -> mint id + nonce, state pending, queue `register`
//   on, retiring            -> deregister still queued: cancel it, back to
//                              registered with the same id; deregister being
//                              sent: 409 RETIRING (try again in a minute)
//   off, registered         -> cancel every waiting row, queue `deregister`,
//                              forwarding off, state retiring (the identity is
//                              deleted once the deregister ends)
//   off, pending            -> delete the identity and cancel every row (nothing
//                              can be signed, so no deregister)
//   forwardBugReports on while register is off -> 400 REGISTRATION_REQUIRED
//   bugReportsTeamOnly on while forwarding is off -> 400 FORWARDING_REQUIRED
//   register or forwardBugReports off           -> bugReportsTeamOnly off too
//
// One privileged transaction under the advisory lock (`lockLiaisonTeam`), which
// the outbox also takes before it applies a reply, so two admins (or an admin
// and the outbox) never interleave.

import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { instanceSettings } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { writeAuditLog } from "~/modules/audit/service"
import {
  deleteIdentity,
  type IdentityState,
  lockLiaisonTeam,
  mintIdentity,
  readIdentity,
  writeIdentity,
} from "./identity"
import { cancelPending, enqueue, liaisonTeamEndpoint, outboxCounts } from "./outbox"
import { countActiveUsers, deregisterData, registerData } from "./payloads"

/** The `kernel.instance_settings` key of the two switches. */
export const SHARING_SETTING = "liaison_team.sharing"

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

export interface LiaisonTeamSharing {
  register: boolean
  forwardBugReports: boolean
  /** Bug reports go only to the Liaison team (no local ticket). Implies forwardBugReports. */
  bugReportsTeamOnly: boolean
  decidedAt: string | null
  decidedBy: string | null
}

/** A refused change, answered by the error handler with its status and code. */
export class LiaisonTeamError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly code:
      | "REGISTRATION_REQUIRED"
      | "FORWARDING_REQUIRED"
      | "RETIRING"
      | "LIAISON_TEAM_UNAVAILABLE",
  ) {
    super(message)
    this.name = "LiaisonTeamError"
  }
}

type Db = Pick<PrivilegedDb, "execute" | "select" | "insert" | "delete">

const OFF: LiaisonTeamSharing = {
  register: false,
  forwardBugReports: false,
  bugReportsTeamOnly: false,
  decidedAt: null,
  decidedBy: null,
}

export async function readSharing(db: Db): Promise<LiaisonTeamSharing> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SHARING_SETTING))
  const v = (row?.value ?? {}) as Record<string, unknown>
  const forwardBugReports = v.register === true && v.forwardBugReports === true
  return {
    register: v.register === true,
    forwardBugReports,
    bugReportsTeamOnly: forwardBugReports && v.bugReportsTeamOnly === true,
    decidedAt: typeof v.decidedAt === "string" ? v.decidedAt : null,
    decidedBy: typeof v.decidedBy === "string" ? v.decidedBy : null,
  }
}

/** The switches as stored, for callers outside this module (config, setup state). */
export async function loadSharing(): Promise<LiaisonTeamSharing> {
  return withSystemDb("liaison-team:read-sharing", (tx) => readSharing(tx))
}

async function writeSharing(db: Db, sharing: LiaisonTeamSharing): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: SHARING_SETTING, value: sharing, decidedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: sharing, decidedAt: new Date() },
    })
}

/** The newest `deregister` row still in play, if any. */
async function liveDeregister(db: Db): Promise<{ id: string; status: string } | null> {
  const [row] = extractRows<{ id: string; status: string }>(
    await db.execute(drizzleSql`
      SELECT id, status FROM ${K()}.control_plane_outbox
       WHERE type = 'deregister' AND status IN ('pending', 'sending')
       ORDER BY created_at DESC LIMIT 1`),
  )
  return row ?? null
}

/**
 * Change the switches. `actor` is recorded as `decidedBy` (a user id); with an
 * `orgId` the change also goes on that org's audit timeline, in the same
 * transaction. Returns the switches as stored.
 */
export async function setSharing(
  change: { register?: boolean; forwardBugReports?: boolean; bugReportsTeamOnly?: boolean },
  actor: { userId: string | null; orgId?: string },
  now: Date = new Date(),
): Promise<LiaisonTeamSharing> {
  return withSystemDb("liaison-team:set-sharing", async (tx) => {
    await lockLiaisonTeam(tx)
    const before = await readSharing(tx)
    const register = change.register ?? before.register
    const forwardBugReports = register
      ? (change.forwardBugReports ?? before.forwardBugReports)
      : false
    if (change.forwardBugReports === true && !register) {
      throw new LiaisonTeamError(
        "Turn on registration with the Liaison team before allowing bug report forwarding",
        400,
        "REGISTRATION_REQUIRED",
      )
    }
    const bugReportsTeamOnly = forwardBugReports
      ? (change.bugReportsTeamOnly ?? before.bugReportsTeamOnly)
      : false
    if (change.bugReportsTeamOnly === true && !forwardBugReports) {
      throw new LiaisonTeamError(
        "Allow bug report forwarding to the Liaison team before sending bug reports only to the Liaison team",
        400,
        "FORWARDING_REQUIRED",
      )
    }
    if (register && !before.register && !liaisonTeamEndpoint()) {
      throw new LiaisonTeamError(
        "Sharing with the Liaison team is not available on this server (LIAISON_TEAM_ENDPOINT is empty)",
        400,
        "LIAISON_TEAM_UNAVAILABLE",
      )
    }

    const identity = await readIdentity(tx)
    if (register) {
      if (!identity) {
        // A new identity starts with an empty queue: a row left over from an
        // earlier one (a deregister) must never go out signed with the new key.
        await cancelPending(tx, "new_identity", now)
        await writeIdentity(tx, mintIdentity())
        await enqueue(tx, "register", registerData(await countActiveUsers(tx)), { now })
      } else if (identity.state === "retiring") {
        const dereg = await liveDeregister(tx)
        if (dereg?.status === "sending") {
          throw new LiaisonTeamError(
            "This server is leaving the Liaison team right now. Try again in a minute.",
            409,
            "RETIRING",
          )
        }
        if (dereg) {
          await tx.execute(drizzleSql`
            UPDATE ${K()}.control_plane_outbox
               SET status = 'cancelled', last_error = 'register_turned_on_again',
                   updated_at = ${now.toISOString()}::timestamptz
             WHERE id = ${dereg.id}::uuid`)
          await writeIdentity(tx, { ...identity, state: "registered" })
        } else {
          // The deregister already ended: start over under a new id.
          await deleteIdentity(tx)
          await cancelPending(tx, "new_identity", now)
          await writeIdentity(tx, mintIdentity())
          await enqueue(tx, "register", registerData(await countActiveUsers(tx)), { now })
        }
      }
    } else if (identity) {
      if (identity.state === "registered") {
        await cancelPending(tx, "register_turned_off", now)
        await enqueue(tx, "deregister", deregisterData(), { now })
        await writeIdentity(tx, { ...identity, state: "retiring" })
      } else if (identity.state === "pending") {
        await cancelPending(tx, "register_turned_off", now)
        await deleteIdentity(tx)
      }
    }

    const sharing: LiaisonTeamSharing = {
      register,
      forwardBugReports,
      bugReportsTeamOnly,
      decidedAt: now.toISOString(),
      decidedBy: actor.userId,
    }
    await writeSharing(tx, sharing)
    if (actor.orgId) {
      await writeAuditLog(tx, {
        orgId: actor.orgId,
        actorId: actor.userId,
        actorType: "user",
        entityType: "liaison_team",
        action: "liaison_team.updated",
        metadata: { register, forwardBugReports, bugReportsTeamOnly },
      })
    }
    if (
      register !== before.register ||
      forwardBugReports !== before.forwardBugReports ||
      bugReportsTeamOnly !== before.bugReportsTeamOnly
    ) {
      log.info({ register, forwardBugReports, bugReportsTeamOnly }, "Liaison team sharing changed")
    }
    return sharing
  })
}

export type RegistrationState = "off" | IdentityState | "error"

export interface LiaisonTeamStatus {
  available: boolean
  sharing: LiaisonTeamSharing
  state: RegistrationState
  lastError: string | null
  instanceId: string | null
  registeredAt: string | null
  outbox: Awaited<ReturnType<typeof outboxCounts>>
}

/**
 * What Settings shows. `state` is `error` when the registration was refused or
 * signatures have been failing, with `lastError`. Callers decide who may see
 * `instanceId` and `outbox` (the operator only).
 */
export async function readStatus(): Promise<LiaisonTeamStatus> {
  return withSystemDb("liaison-team:status", async (tx) => {
    const sharing = (await readSharing(tx)) ?? OFF
    const identity = await readIdentity(tx)
    const outbox = await outboxCounts(tx)
    let state: RegistrationState = sharing.register && identity ? identity.state : "off"
    let lastError: string | null = null
    if (identity?.state === "pending") {
      const [reg] = extractRows<{ status: string; last_error: string | null }>(
        await tx.execute(drizzleSql`
          SELECT status, last_error FROM ${K()}.control_plane_outbox
           WHERE type = 'register' ORDER BY created_at DESC LIMIT 1`),
      )
      // Refused, or never delivered within 7 days: nothing is left to send
      // until an admin turns registration off and on again.
      if (reg?.status === "refused" || reg?.status === "expired") {
        state = "error"
        lastError = reg.status === "expired" ? "registration expired" : reg.last_error
      }
    }
    if (identity?.authFailingSince) {
      state = "error"
      lastError = outbox.lastError ?? "signature refused"
    }
    return {
      available: liaisonTeamEndpoint() !== null,
      sharing,
      state,
      lastError,
      instanceId: identity?.instanceId ?? null,
      registeredAt: identity?.registeredAt ?? null,
      outbox,
    }
  })
}
