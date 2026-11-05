// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The heartbeat to the Liaison team: one message a day for a registered
// server, at a minute of the (UTC) day derived from its instance id so servers
// do not all call at once, and one at boot when the server version changed.
// Nothing is sent unless registration is on and the identity is `registered`
// (not `pending`, not `retiring`). Both checks run under the same advisory
// lock as the switches and the outbox's reply handling (`lockLiaisonTeam`), so
// a switch-off cannot interleave with an enqueue.

import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { instanceSettings } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { lockLiaisonTeam, readIdentity } from "./identity"
import { enqueue, liaisonTeamEndpoint } from "./outbox"
import { countActiveUsers, heartbeatData } from "./payloads"
import { readSharing } from "./settings"

/** `kernel.instance_settings` key: the version and UTC day of the last queued heartbeat. */
export const LAST_HEARTBEAT_SETTING = "liaison_team.last_heartbeat"

interface LastHeartbeat {
  version: string | null
  /** UTC day, `YYYY-MM-DD`. */
  day: string | null
}

const MIN_MS = 60_000
const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * The minute of the UTC day this instance sends its daily heartbeat: a multiple
 * of 10 (0-1430), because the job ticks every 10 minutes and a minute between
 * two ticks late in the day would never be reached before the day rolls over.
 */
export function heartbeatMinuteOfDay(instanceId: string): number {
  const bytes = createHash("sha256").update(instanceId).digest()
  return (bytes.readUInt32BE(0) % 144) * 10
}

async function readLast(db: Parameters<typeof readSharing>[0]): Promise<LastHeartbeat> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, LAST_HEARTBEAT_SETTING))
  const v = (row?.value ?? {}) as Record<string, unknown>
  return {
    version: typeof v.version === "string" ? v.version : null,
    day: typeof v.day === "string" ? v.day : null,
  }
}

/**
 * Queue one heartbeat when `due` says so for the stored last heartbeat. Returns
 * whether a row was queued. A failure (database error) is logged and skipped:
 * the next tick tries again.
 */
async function enqueueIfDue(
  now: Date,
  due: (last: LastHeartbeat, instanceId: string) => boolean,
): Promise<boolean> {
  if (!liaisonTeamEndpoint()) return false
  try {
    // Cheap pre-check outside the lock: nothing to do for an unregistered server.
    const pre = await withSystemDb("liaison-team:heartbeat-check", async (tx) => ({
      sharing: await readSharing(tx),
      identity: await readIdentity(tx),
    }))
    if (!pre.sharing.register || pre.identity?.state !== "registered") return false
    const activeUsers = await withSystemDb("liaison-team:active-users", (tx) =>
      countActiveUsers(tx),
    )
    return await withSystemDb("liaison-team:heartbeat", async (tx) => {
      await lockLiaisonTeam(tx)
      const sharing = await readSharing(tx)
      const identity = await readIdentity(tx)
      if (!sharing.register || identity?.state !== "registered") return false
      const last = await readLast(tx)
      if (!due(last, identity.instanceId)) return false
      await enqueue(tx, "heartbeat", heartbeatData(activeUsers), { now })
      const value: LastHeartbeat = { version: env.LIAISON_VERSION, day: utcDay(now) }
      await tx
        .insert(instanceSettings)
        .values({ key: LAST_HEARTBEAT_SETTING, value, decidedAt: now })
        .onConflictDoUpdate({
          target: instanceSettings.key,
          set: { value, decidedAt: now },
        })
      return true
    })
  } catch (err) {
    log.warn({ err }, "Liaison team heartbeat skipped")
    return false
  }
}

/**
 * The scheduled tick (every few minutes): queue today's heartbeat once the
 * instance's minute of the UTC day has come, if none was queued today.
 */
export function heartbeatTick(now: Date = new Date()): Promise<boolean> {
  const minuteOfDay = Math.floor((now.getTime() % (1440 * MIN_MS)) / MIN_MS)
  return enqueueIfDue(
    now,
    (last, instanceId) =>
      minuteOfDay >= heartbeatMinuteOfDay(instanceId) && last.day !== utcDay(now),
  )
}

/** At boot: queue a heartbeat when the server version differs from the last queued one. */
export function heartbeatOnBoot(now: Date = new Date()): Promise<boolean> {
  return enqueueIfDue(now, (last) => last.version !== env.LIAISON_VERSION)
}
