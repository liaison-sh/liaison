// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Who is on call (notification etiquette rule 9). Incidents and critical
 * alerts interrupt only these people; everyone else who can read them gets
 * them in the inbox only.
 *
 * Stored as `organizations.settings.notificationsOnCall`: a list of member ids.
 * Absent or empty means the org's admins (holders of `kernel:org:admin`), so an
 * org that never set it behaves sensibly. An org with neither (no list, no
 * admin) puts everyone who can read incidents on call, as before on-call
 * existed, and logs a warning once per org and process. Only an admin edits it
 * (`PUT /api/notifications/on-call`).
 */
import { sql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { scopeHoldersInTx } from "~/modules/permissions/scope-holders"

const K = sql.raw(schemaRef("kernel"))
const log = rootLogger.child({ module: "notifications-on-call" })
const warnedNobody = new Set<string>()

export const ON_CALL_SETTINGS_KEY = "notificationsOnCall"
export const ON_CALL_DEFAULT_SCOPE = "kernel:org:admin"

/** The stored list, parsed: anything but an array of strings reads as unset. */
export function readOnCallList(settings: unknown): string[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return []
  const raw = (settings as Record<string, unknown>)[ON_CALL_SETTINGS_KEY]
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0))]
}

export interface OnCallView {
  /** The people on call now. */
  userIds: string[]
  /**
   * `list`: the org set its own; `admins`: none set, the admins are on call;
   * `nobody`: no list and no admin, so everyone who can read incidents is.
   */
  source: "list" | "admins" | "nobody"
}

async function readOrgRow(
  tx: PrivilegedDb | RlsClient,
  orgId: string,
): Promise<{ timezone: string | null; timezoneSet: boolean; settings: unknown }> {
  const rows = (await tx.execute(
    sql`SELECT timezone, settings FROM ${K}.organizations WHERE id = ${orgId} LIMIT 1`,
  )) as unknown as Array<{ timezone: string | null; settings: unknown }>
  const row = rows[0]
  const settings = typeof row?.settings === "string" ? JSON.parse(row.settings) : row?.settings
  const timezoneSet =
    !!settings &&
    typeof settings === "object" &&
    (settings as Record<string, unknown>).timezoneSet === true
  return { timezone: row?.timezone ?? null, timezoneSet, settings }
}

/** The on-call people of an org, inside a privileged transaction. */
export async function loadOnCall(tx: PrivilegedDb, orgId: string): Promise<OnCallView> {
  const { settings } = await readOrgRow(tx, orgId)
  return onCallFromSettings(tx, orgId, settings)
}

async function onCallFromSettings(
  tx: PrivilegedDb,
  orgId: string,
  settings: unknown,
): Promise<OnCallView> {
  const list = readOnCallList(settings)
  if (list.length > 0) {
    // Only active members of this org count: a removed member drops out.
    const idList = sql.join(
      list.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = (await tx.execute(
      sql`SELECT id FROM ${K}.users
           WHERE org_id = ${orgId} AND status = 'active' AND id::text IN (${idList})`,
    )) as unknown as Array<{ id: string }>
    if (rows.length > 0) return { userIds: rows.map((r) => r.id), source: "list" }
  }
  const admins = await scopeHoldersInTx(tx, orgId, ON_CALL_DEFAULT_SCOPE)
  if (admins.length > 0) return { userIds: admins, source: "admins" }
  if (!warnedNobody.has(orgId)) {
    warnedNobody.add(orgId)
    log.warn(
      { orgId },
      "no on-call list and no admin: incidents interrupt everyone who can read them",
    )
  }
  return { userIds: [], source: "nobody" }
}

/**
 * What the router needs from the org: its time zone (the quiet-hours fallback)
 * and, for an incident, whether `onCallFor` is on call.
 */
export async function orgNotificationFacts(
  tx: PrivilegedDb,
  orgId: string,
  opts: { onCallFor: string | null },
): Promise<{ timezone: string | null; timezoneSet: boolean; onCall?: boolean }> {
  const row = await readOrgRow(tx, orgId)
  const base = { timezone: row.timezone, timezoneSet: row.timezoneSet }
  if (!opts.onCallFor) return base
  const view = await onCallFromSettings(tx, orgId, row.settings)
  return {
    ...base,
    onCall: view.source === "nobody" || view.userIds.includes(opts.onCallFor),
  }
}
