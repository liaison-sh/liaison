// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Notification settings storage (S8 API, S9): the grid, work hours and digest
 * cadence, read and written as one contract shape.
 *
 * The grid lives in `kernel.user_preferences.notification_channels` (0108) as
 * `{ grid: <only cells that differ from DEFAULT_GRID>, workHoursExplicit }`.
 * Every write is a targeted UPDATE of the columns it changes, never the
 * full-replace `updatePreferences`, so saving work hours keeps the grid and
 * saving the grid keeps work hours.
 *
 * Digest cadence `off` and "every email cell off" are one state: `off` reads as
 * every email cell off; switching every email cell off stores `off`; switching
 * one on while `off` stores `daily`.
 *
 * Muting a kind (rule 7): `mutedGroups` lists the groups set to off. Each kind
 * is shown as one of three modes: `interrupt` (computer or phone on),
 * `inbox` (in-app only) or `off` (muted).
 *
 * Quiet hours (rule 8): until the person saves their own hours, the view shows
 * the default window (quiet-window.ts) in the resolved time zone, and says
 * where that zone came from (`timezoneSource`).
 *
 * The approval reminder frequency (modules/approvals/reminders.ts) sits in the
 * same column as `approvalReminder`, stored only when it differs from the
 * default (daily), so everyone who never chose is reminded daily.
 */
import {
  APPROVAL_REMINDER_FREQUENCIES,
  type ApprovalReminderFrequency,
  DEFAULT_APPROVAL_REMINDER,
  DEFAULT_GRID,
  effectiveGrid,
  gridOverrides,
  isNotificationChannel,
  isNotificationGroupId,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_GROUP_IDS,
  NOTIFICATION_GROUP_SECTIONS,
  NOTIFICATION_GROUPS,
  type NotificationChannel,
  type NotificationGrid,
  type NotificationGroupId,
  readApprovalReminder,
} from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { NotificationChannelsStored } from "~/db/schema/kernel/user-preferences"
import { schemaRef } from "~/db/schema-ref"
import { getOrCreatePreferences, isValidIanaTimezone } from "~/modules/users/preferences-service"
import {
  DEFAULT_QUIET_WORK_WINDOW,
  defaultQuietHoursOn,
  effectiveQuietWindow,
  hasOwnWorkHours,
  type QuietTimezoneSource,
  resolveQuietTimezone,
} from "./quiet-window"

const K = sql.raw(schemaRef("kernel"))

export const DIGEST_CADENCES = ["immediate", "hourly", "daily", "off"] as const
export type DigestCadence = (typeof DIGEST_CADENCES)[number]

export class NotificationSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotificationSettingsError"
  }
}

/** The stored column, parsed: unknown keys and invalid cells are ignored. */
export interface NotificationChannelsState {
  grid: NotificationGrid
  workHoursExplicit: boolean
  approvalReminder: ApprovalReminderFrequency
  /** Groups set to off (mute the kind). */
  mutedGroups: NotificationGroupId[]
  /** The person set `user_preferences.timezone` (or their browser reported it). */
  timezoneSet: boolean
}

function readMutedGroups(raw: unknown): NotificationGroupId[] {
  if (!Array.isArray(raw)) return []
  return NOTIFICATION_GROUP_IDS.filter((g) => raw.includes(g))
}

export function readNotificationChannels(stored: unknown): NotificationChannelsState {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return {
      grid: effectiveGrid(null),
      workHoursExplicit: false,
      approvalReminder: DEFAULT_APPROVAL_REMINDER,
      mutedGroups: [],
      timezoneSet: false,
    }
  }
  const obj = stored as Record<string, unknown>
  return {
    grid: effectiveGrid(obj.grid),
    workHoursExplicit: obj.workHoursExplicit === true,
    approvalReminder: readApprovalReminder(obj.approvalReminder),
    mutedGroups: readMutedGroups(obj.mutedGroups),
    timezoneSet: obj.timezoneSet === true,
  }
}

function toStored(state: NotificationChannelsState): NotificationChannelsStored | null {
  const grid = gridOverrides(state.grid)
  const out: NotificationChannelsStored = {}
  if (Object.keys(grid).length > 0) out.grid = grid as NotificationChannelsStored["grid"]
  if (state.workHoursExplicit) out.workHoursExplicit = true
  if (state.approvalReminder !== DEFAULT_APPROVAL_REMINDER) {
    out.approvalReminder = state.approvalReminder
  }
  if (state.mutedGroups.length > 0) out.mutedGroups = [...state.mutedGroups]
  if (state.timezoneSet) out.timezoneSet = true
  return Object.keys(out).length > 0 ? out : null
}

export interface WorkHoursView {
  start: string
  end: string
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[]
  timezone: string
  /** True once the user set work hours; until then the default window shows. */
  explicit: boolean
  /** Where `timezone` came from: the person's own, the org's, or UTC. */
  timezoneSource: QuietTimezoneSource
  /**
   * Phone and computer go quiet outside these hours. False only when the
   * server turned default quiet hours off and the person set none.
   */
  quiet: boolean
}

/** How a kind reaches the person (Settings > Notifications, rule 10). */
export type NotificationKindMode = "interrupt" | "inbox" | "off"

export function kindModeOf(
  grid: NotificationGrid,
  muted: readonly NotificationGroupId[],
  group: NotificationGroupId,
): NotificationKindMode {
  if (muted.includes(group)) return "off"
  return grid[group].desktop || grid[group].push ? "interrupt" : "inbox"
}

export interface NotificationSettings {
  channels: NotificationChannel[]
  groups: Array<{ id: NotificationGroupId; label: string; labelKey: string }>
  /** Headings of the grid and the groups under each; groups in none come first. */
  sections: Array<{ id: string; label: string; labelKey: string; groups: NotificationGroupId[] }>
  grid: NotificationGrid
  defaults: NotificationGrid
  workHours: WorkHoursView
  digestCadence: DigestCadence
  /** How often the person's agent reminds them of their requests still waiting for a decision. */
  approvalReminder: ApprovalReminderFrequency
  /** Groups set to off (muted kinds). */
  mutedGroups: NotificationGroupId[]
  /** Each group's mode: interrupt, inbox only or off. */
  kindModes: Record<NotificationGroupId, NotificationKindMode>
}

export interface NotificationSettingsPatch {
  grid?: Record<string, Record<string, boolean>>
  workHours?: {
    start?: string
    end?: string
    days?: number[]
    timezone?: string
    explicit?: boolean
  }
  digestCadence?: DigestCadence
  approvalReminder?: ApprovalReminderFrequency
  timezone?: string
  /**
   * The zone the person's browser (or app shell) runs in. Saved as their time
   * zone only while none is known (rule 8), never over one they chose.
   */
  detectedTimezone?: string
  /** Mute (true) or unmute (false) a kind, by group. */
  mutedGroups?: Record<string, boolean>
}

// Storage keeps ISO weekdays (1 = Mon ... 7 = Sun); the contract uses 0 = Sun.
const isoToContract = (d: number) => d % 7
const contractToIso = (d: number) => (d === 0 ? 7 : d)

function copyGrid(grid: NotificationGrid): NotificationGrid {
  return Object.fromEntries(
    NOTIFICATION_GROUP_IDS.map((g) => [g, { ...grid[g] }]),
  ) as NotificationGrid
}

/** The grid as shown: cadence `off` reads as every email cell off. */
function displayedGrid(grid: NotificationGrid, cadence: DigestCadence): NotificationGrid {
  const out = copyGrid(grid)
  if (cadence === "off") for (const g of NOTIFICATION_GROUP_IDS) out[g].email = false
  return out
}

interface Row {
  digest_cadence: string
  work_hours_start: string
  work_hours_end: string
  work_days: number[]
  timezone: string
  notification_channels: unknown
  profile_timezone: string | null
}

async function loadRow(userId: string, orgId: string, tx: RlsClient, lock: boolean): Promise<Row> {
  await getOrCreatePreferences(userId, orgId, { rlsTx: tx })
  const rows = (await tx.execute(
    sql`SELECT digest_cadence, work_hours_start, work_hours_end, work_days, timezone,
               notification_channels,
               (SELECT u.timezone FROM ${K}.users u WHERE u.id = ${userId}) AS profile_timezone
          FROM ${K}.user_preferences WHERE user_id = ${userId}
          ${lock ? sql`FOR UPDATE` : sql``}`,
  )) as unknown as Row[]
  return rows[0]!
}

interface OrgClock {
  timezone: string | null
  timezoneSet: boolean
}

/**
 * The org's time zone, the fallback clock of quiet hours. `kernel.organizations`
 * is closed to the request role, so it is read privileged, for the caller's org.
 */
async function loadOrgClock(orgId: string): Promise<OrgClock> {
  return withPrivilegedDb(orgId, "notifications:settings-org-timezone", async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT timezone, (settings->>'timezoneSet')::boolean AS timezone_set
            FROM ${K}.organizations WHERE id = ${orgId} LIMIT 1`,
    )) as unknown as Array<{ timezone: string | null; timezone_set: boolean | null }>
    return { timezone: rows[0]?.timezone ?? null, timezoneSet: rows[0]?.timezone_set === true }
  })
}

function storedHours(row: Row) {
  return {
    workHoursStart: row.work_hours_start.slice(0, 5),
    workHoursEnd: row.work_hours_end.slice(0, 5),
    workDays: row.work_days,
    timezone: row.timezone,
  }
}

function clockOf(row: Row, org: OrgClock, state: NotificationChannelsState) {
  return {
    prefsTimezoneSet: state.timezoneSet,
    profileTimezone: row.profile_timezone,
    orgTimezone: org.timezone,
    orgTimezoneSet: org.timezoneSet,
  }
}

function view(row: Row, org: OrgClock): NotificationSettings {
  const cadence = (DIGEST_CADENCES as readonly string[]).includes(row.digest_cadence)
    ? (row.digest_cadence as DigestCadence)
    : "daily"
  const state = readNotificationChannels(row.notification_channels)
  const stored = storedHours(row)
  const defaultOn = defaultQuietHoursOn()
  const window = effectiveQuietWindow({
    stored,
    explicit: state.workHoursExplicit,
    clock: clockOf(row, org, state),
    defaultOn,
  })
  // Without own hours the screen shows the default window, even while the
  // time zone is unknown and it is not applied yet (`quiet: false`).
  const own = hasOwnWorkHours(stored, state.workHoursExplicit)
  const shown =
    !own && defaultOn
      ? {
          workHoursStart: DEFAULT_QUIET_WORK_WINDOW.workHoursStart,
          workHoursEnd: DEFAULT_QUIET_WORK_WINDOW.workHoursEnd,
          workDays: [...DEFAULT_QUIET_WORK_WINDOW.workDays],
        }
      : window
  const grid = displayedGrid(state.grid, cadence)
  return {
    channels: [...NOTIFICATION_CHANNELS],
    groups: NOTIFICATION_GROUPS.map((g) => ({ id: g.id, label: g.label, labelKey: g.labelKey })),
    sections: NOTIFICATION_GROUP_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      labelKey: s.labelKey,
      groups: [...s.groups],
    })),
    grid,
    defaults: copyGrid(DEFAULT_GRID as NotificationGrid),
    workHours: {
      start: shown.workHoursStart,
      end: shown.workHoursEnd,
      days: [...new Set(shown.workDays.map(isoToContract))].sort((a, b) => a - b),
      timezone: window.timezone,
      explicit: state.workHoursExplicit,
      timezoneSource: window.timezoneSource,
      quiet: window.quietLive,
    },
    digestCadence: cadence,
    approvalReminder: state.approvalReminder,
    mutedGroups: [...state.mutedGroups],
    kindModes: Object.fromEntries(
      NOTIFICATION_GROUP_IDS.map((g) => [g, kindModeOf(grid, state.mutedGroups, g)]),
    ) as Record<NotificationGroupId, NotificationKindMode>,
  }
}

export async function getNotificationSettings(
  userId: string,
  orgId: string,
  tx: RlsClient,
): Promise<NotificationSettings> {
  const [row, org] = await Promise.all([loadRow(userId, orgId, tx, false), loadOrgClock(orgId)])
  return view(row, org)
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Validate a patch; throws NotificationSettingsError (a 400) on anything unknown. */
export function validatePatch(patch: NotificationSettingsPatch): void {
  for (const [group, cells] of Object.entries(patch.grid ?? {})) {
    if (!isNotificationGroupId(group))
      throw new NotificationSettingsError(`Unknown group: ${group}`)
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) {
      throw new NotificationSettingsError(`Invalid cells for group: ${group}`)
    }
    for (const [channel, value] of Object.entries(cells)) {
      if (!isNotificationChannel(channel)) {
        throw new NotificationSettingsError(`Unknown channel: ${channel}`)
      }
      if (typeof value !== "boolean") {
        throw new NotificationSettingsError(`Cell ${group}.${channel} must be a boolean`)
      }
      if (channel === "in_app" && value === false) {
        throw new NotificationSettingsError("The in-app channel cannot be switched off")
      }
    }
  }
  const wh = patch.workHours
  if (wh) {
    if (wh.start !== undefined && !HHMM.test(wh.start)) {
      throw new NotificationSettingsError("start must be HH:MM")
    }
    if (wh.end !== undefined && !HHMM.test(wh.end)) {
      throw new NotificationSettingsError("end must be HH:MM")
    }
    if (wh.days !== undefined) {
      if (wh.days.length === 0) throw new NotificationSettingsError("Pick at least one work day")
      if (new Set(wh.days).size !== wh.days.length) {
        throw new NotificationSettingsError("Duplicate work day entries")
      }
      if (wh.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new NotificationSettingsError("Work days must be 0-6 (0 = Sunday)")
      }
    }
  }
  if (
    patch.approvalReminder !== undefined &&
    !(APPROVAL_REMINDER_FREQUENCIES as readonly string[]).includes(patch.approvalReminder)
  ) {
    throw new NotificationSettingsError(`Unknown approval reminder: ${patch.approvalReminder}`)
  }
  for (const [group, value] of Object.entries(patch.mutedGroups ?? {})) {
    if (!isNotificationGroupId(group))
      throw new NotificationSettingsError(`Unknown group: ${group}`)
    if (typeof value !== "boolean") {
      throw new NotificationSettingsError(`mutedGroups.${group} must be a boolean`)
    }
  }
  for (const tz of [patch.timezone, wh?.timezone, patch.detectedTimezone]) {
    if (tz !== undefined && !isValidIanaTimezone(tz)) {
      throw new NotificationSettingsError(`Unknown timezone: ${tz}`)
    }
  }
}

function emailColumnAllOff(grid: NotificationGrid): boolean {
  return NOTIFICATION_GROUP_IDS.every((g) => !grid[g].email)
}

/**
 * Apply a patch with targeted writes: only the columns the patch touches are
 * updated. Returns the settings as GET shows them.
 */
export async function updateNotificationSettings(
  userId: string,
  orgId: string,
  patch: NotificationSettingsPatch,
  tx: RlsClient,
): Promise<NotificationSettings> {
  validatePatch(patch)
  const row = await loadRow(userId, orgId, tx, true)
  const current = readNotificationChannels(row.notification_channels)
  const currentCadence = view(row, { timezone: null, timezoneSet: false }).digestCadence
  const state: NotificationChannelsState = {
    grid: copyGrid(current.grid),
    workHoursExplicit: current.workHoursExplicit,
    approvalReminder: current.approvalReminder,
    mutedGroups: [...current.mutedGroups],
    timezoneSet: current.timezoneSet,
  }
  let cadence: DigestCadence = currentCadence
  let channelsTouched = false
  let cadenceTouched = false

  if (patch.grid) {
    const cells = Object.entries(patch.grid).flatMap(([g, c]) =>
      Object.entries(c).map(
        ([ch, v]) => [g as NotificationGroupId, ch as NotificationChannel, v] as const,
      ),
    )
    const turnsEmailOn = cells.some(([, ch, v]) => ch === "email" && v)
    if (currentCadence === "off" && turnsEmailOn) {
      // The screen shows every email cell off: keep it that way for the cells
      // the user did not touch, so exactly the toggled cell comes on.
      for (const g of NOTIFICATION_GROUP_IDS) state.grid[g].email = false
    }
    for (const [g, ch, v] of cells) if (ch !== "in_app") state.grid[g][ch] = v
    channelsTouched = true
    // Only a change to an email cell can move the cadence. A phone or computer
    // change leaves it alone: with cadence off the stored email cells are the
    // defaults (on), and re-deriving from them turned a digest the user had
    // switched off back on to daily (2026-09-28, live).
    if (cells.some(([, ch]) => ch === "email")) {
      if (emailColumnAllOff(state.grid)) {
        if (cadence !== "off") cadenceTouched = true
        cadence = "off"
      } else if (cadence === "off") {
        cadence = "daily"
        cadenceTouched = true
      }
    }
  }

  if (patch.digestCadence !== undefined) {
    cadence = patch.digestCadence
    cadenceTouched = true
    if (cadence !== "off" && emailColumnAllOff(state.grid)) {
      // Back on from "every email cell off": the email column returns to its defaults.
      for (const g of NOTIFICATION_GROUP_IDS) state.grid[g].email = DEFAULT_GRID[g].email
      channelsTouched = true
    }
  }

  if (patch.approvalReminder !== undefined && patch.approvalReminder !== state.approvalReminder) {
    state.approvalReminder = patch.approvalReminder
    channelsTouched = true
  }

  if (patch.mutedGroups) {
    const muted = new Set(state.mutedGroups)
    for (const [g, on] of Object.entries(patch.mutedGroups)) {
      if (on) muted.add(g as NotificationGroupId)
      else muted.delete(g as NotificationGroupId)
    }
    const next = NOTIFICATION_GROUP_IDS.filter((g) => muted.has(g))
    if (next.join() !== state.mutedGroups.join()) {
      state.mutedGroups = next
      channelsTouched = true
    }
  }

  const sets = []
  if (cadenceTouched) sets.push(sql`digest_cadence = ${cadence}`)

  const wh = patch.workHours
  if (wh) {
    if (wh.start !== undefined) sets.push(sql`work_hours_start = ${wh.start}`)
    if (wh.end !== undefined) sets.push(sql`work_hours_end = ${wh.end}`)
    if (wh.days !== undefined) {
      const iso = [...new Set(wh.days.map(contractToIso))].sort((a, b) => a - b)
      const arr = sql.join(
        iso.map((d) => sql`${d}::smallint`),
        sql`, `,
      )
      sets.push(sql`work_days = ARRAY[${arr}]::smallint[]`)
    }
    const setsHours = wh.start !== undefined || wh.end !== undefined || wh.days !== undefined
    // Only hours or days make the hours the person's own; a time zone alone
    // keeps the default window, read in that zone.
    const explicit = wh.explicit ?? (setsHours ? true : undefined)
    if (explicit !== undefined && explicit !== state.workHoursExplicit) {
      state.workHoursExplicit = explicit
      channelsTouched = true
    }
  }
  let timezone = wh?.timezone ?? patch.timezone
  if (timezone === undefined && patch.detectedTimezone !== undefined) {
    // The browser's zone fills in only a person's zone never set (rule 8);
    // the org's zone does not count here: it is the person's that is missing.
    const known = resolveQuietTimezone({
      prefsTimezone: row.timezone,
      ...clockOf(row, { timezone: null, timezoneSet: false }, current),
    })
    if (known.source === "unknown") timezone = patch.detectedTimezone
  }
  if (timezone !== undefined) {
    sets.push(sql`timezone = ${timezone}`)
    if (!state.timezoneSet) {
      state.timezoneSet = true
      channelsTouched = true
    }
  }

  if (channelsTouched) {
    const stored = toStored(state)
    sets.push(
      stored === null
        ? sql`notification_channels = NULL`
        : sql`notification_channels = ${JSON.stringify(stored)}::jsonb`,
    )
  }

  if (sets.length > 0) {
    sets.push(sql`updated_at = now()`)
    await tx.execute(
      sql`UPDATE ${K}.user_preferences SET ${sql.join(sets, sql`, `)} WHERE user_id = ${userId}`,
    )
  }
  return getNotificationSettings(userId, orgId, tx)
}
