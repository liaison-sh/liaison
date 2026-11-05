// SPDX-License-Identifier: FSL-1.1-ALv2
import type {
  AgentMailAccessInput,
  HomeCardLayoutInput,
  ShippedLocale,
  ThemePreference,
  UserPreferencesInput,
} from "@liaison/shared"
import { resolveLocale, toShippedLocale } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"

// Schema-prefix-aware identifier — required for worker-test isolation
// (`SCHEMA_PREFIX=w<id>_` → `w<id>_kernel`). Raw `kernel.` literals would write
// to the unprefixed kernel schema and violate the FK to `kernel.users`.
const K = sql.raw(schemaRef("kernel"))

export class PreferencesServiceError extends Error {
  constructor(
    public readonly code: "INVALID_TIMEZONE" | "INVALID_WORK_DAYS",
    message: string,
  ) {
    super(message)
    this.name = "PreferencesServiceError"
  }
}

export interface PreferencesRow {
  userId: string
  digestCadence: "off" | "immediate" | "hourly" | "daily"
  workHoursStart: string
  workHoursEnd: string
  workDays: number[]
  timezone: string
  /** The user's EXPLICIT language choice; null when they never picked one. */
  language: ShippedLocale | null
  /** The org default locale, narrowed to a shipped locale (null when unshipped). */
  orgDefaultLocale: ShippedLocale | null
  /** Explicit choice > org default > "en". The web client slots the browser
   *  language in before "en" (the api has no browser). */
  effectiveLanguage: ShippedLocale
  theme: ThemePreference
  magicWandInstructions: string | null
  /** "Clean up dictation automatically" (0173), default true. */
  dictationAutoClean: boolean
  lastDailySentAt: Date | null
  homeCardLayout: HomeCardLayoutInput | null
  /** Reaction picker favourites, in row order; null = never customised. */
  favoriteEmoji: string[] | null
  /** The relayed assistant-mail switch (0115); null = never synced. */
  agentMailAccess: AgentMailAccessInput | null
}

interface DbPrefsRow {
  user_id: string
  digest_cadence: string
  work_hours_start: string
  work_hours_end: string
  work_days: number[]
  timezone: string
  language: string | null
  org_default_locale?: string | null
  theme: string | null
  magic_wand_instructions: string | null
  dictation_auto_clean: boolean | null
  last_daily_sent_at: Date | null
  home_card_layout: HomeCardLayoutInput | null
  favorite_emoji: unknown
  agent_mail_access: unknown
}

// A NULL language means the user never chose one. It used to default to "en"
// in the column, which silently beat the org default locale and the browser
// language for every user who never opened the picker. An unshipped persisted
// value reads as "no choice" too, so the fallback chain decides.

// Defensive read clamp: an unknown or null persisted theme resolves to
// "system" so a corrupted/leftover value never leaks to the client.
function clampTheme(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

// Postgres TIME columns serialize as "HH:MM:SS" but the UI uses "HH:MM" input
// values. Normalize to HH:MM so the client-side dirty-check (string equality)
// converges after a save round-trip.
function normalizeTime(value: string): string {
  return value.slice(0, 5)
}

// The column is CHECKed to be an array; anything else in it (a hand edit)
// reads as "never customised" rather than reaching the picker.
function readFavoriteEmoji(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((e): e is string => typeof e === "string")
}

// The column is CHECKed for its shape; anything else reads as "never synced".
function readAgentMailAccess(value: unknown): AgentMailAccessInput | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.enabled !== "boolean" || typeof v.at !== "number") return null
  return {
    enabled: v.enabled,
    at: v.at,
    ...(typeof v.mac === "string" ? { mac: v.mac } : {}),
  }
}

function mapRow(row: DbPrefsRow): PreferencesRow {
  return {
    userId: row.user_id,
    digestCadence: row.digest_cadence as PreferencesRow["digestCadence"],
    workHoursStart: normalizeTime(row.work_hours_start),
    workHoursEnd: normalizeTime(row.work_hours_end),
    workDays: [...row.work_days].sort((a, b) => a - b),
    timezone: row.timezone,
    language: toShippedLocale(row.language),
    orgDefaultLocale: toShippedLocale(row.org_default_locale),
    effectiveLanguage: resolveLocale(row.language, row.org_default_locale),
    theme: clampTheme(row.theme),
    magicWandInstructions: row.magic_wand_instructions ?? null,
    dictationAutoClean: row.dictation_auto_clean !== false,
    lastDailySentAt: row.last_daily_sent_at,
    homeCardLayout: row.home_card_layout ?? null,
    favoriteEmoji: readFavoriteEmoji(row.favorite_emoji),
    agentMailAccess: readAgentMailAccess(row.agent_mail_access),
  }
}

// Every read and write answers the same shape, including the org default
// locale the client needs to resolve a user who never chose a language.
const RETURNED_COLUMNS =
  sql.raw(`user_id, digest_cadence, work_hours_start, work_hours_end, work_days,
  timezone, language, theme, magic_wand_instructions, dictation_auto_clean, last_daily_sent_at,
  home_card_layout,
  favorite_emoji, agent_mail_access,
  (SELECT o.default_locale FROM ${schemaRef("kernel")}.users u
     JOIN ${schemaRef("kernel")}.organizations o ON o.id = u.org_id
    WHERE u.id = user_preferences.user_id) AS org_default_locale`)

export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export interface PreferencesDeps {
  rlsTx: RlsClient
}

export async function getOrCreatePreferences(
  userId: string,
  orgId: string,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  const existing = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT ${RETURNED_COLUMNS} FROM ${K}.user_preferences WHERE user_id = ${userId} LIMIT 1`,
  )) as unknown as DbPrefsRow[]
  if (existing[0]) return mapRow(existing[0])

  const orgRows = (await deps.rlsTx.execute<{ timezone: string | null }>(
    sql`SELECT timezone FROM ${K}.organizations WHERE id = ${orgId} LIMIT 1`,
  )) as unknown as { timezone: string | null }[]
  const orgTz = orgRows[0]?.timezone ?? "UTC"

  const inserted = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`INSERT INTO ${K}.user_preferences (user_id, digest_cadence, timezone)
        VALUES (${userId}, 'daily', ${orgTz})
        ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(inserted[0])
}

/**
 * Language-only partial update (I4). The Settings language toggle changes only
 * the locale and does not hold the full preferences object, so it must not be
 * forced through the full-replace `updatePreferences` schema. Upserts the row
 * (seeding org-default timezone when absent, mirroring getOrCreatePreferences)
 * and writes just the language column.
 */
export async function updateLanguage(
  userId: string,
  orgId: string,
  // null clears the explicit choice: the org default (then the browser) decides again.
  language: ShippedLocale | null,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  // Ensure a row exists with sane defaults, then set language only.
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET language = ${language}, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}

/**
 * Theme-only partial update (Phase 14, light mode). Mirrors updateLanguage:
 * the Settings theme picker holds only the theme value, not the full prefs
 * object, so it must not be forced through the full-replace schema. Upserts
 * (via getOrCreatePreferences) and writes only the theme column.
 *
 * Note: updatePreferences (full-replace) does NOT touch theme — adding
 * `theme = excluded.theme` to its ON CONFLICT would overwrite a user's saved
 * theme with NULL whenever the full-replace endpoint fires without a theme
 * in the body. The RETURNING clause includes theme so the response carries
 * the unchanged value back.
 */
export async function updateTheme(
  userId: string,
  orgId: string,
  theme: ThemePreference,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET theme = ${theme}, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}

/**
 * Magic-wand-instructions-only partial update. Mirrors updateTheme: the
 * Settings field holds only the instruction string, not the full prefs object.
 * Blank → null is resolved by the route before calling here. Upserts (via
 * getOrCreatePreferences) and writes only the magic_wand_instructions column.
 */
export async function updateMagicWandInstructions(
  userId: string,
  orgId: string,
  instructions: string | null,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET magic_wand_instructions = ${instructions}, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}

/**
 * "Clean up dictation automatically"-only partial update (S11). Mirrors
 * updateMagicWandInstructions: the Settings toggle holds only this boolean.
 * Upserts (via getOrCreatePreferences) and writes only dictation_auto_clean.
 */
export async function updateDictationAutoClean(
  userId: string,
  orgId: string,
  autoClean: boolean,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET dictation_auto_clean = ${autoClean}, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}

/**
 * Home card order/collapse-only partial update (Task 7, liaison-messaging-
 * visibility). Mirrors updateTheme: Home's drag/collapse interactions hold
 * only the layout shape, not the full preferences object, so it must not be
 * forced through the full-replace `updatePreferences` schema — see that
 * function's ON CONFLICT list, which deliberately omits home_card_layout for
 * the exact reason documented on updateTheme (a full-replace save from
 * Settings → Attention would otherwise null the layout on every unrelated
 * preferences change). Upserts (via getOrCreatePreferences) and writes only
 * the home_card_layout column. `layout` is stored as-is (jsonb); unknown card
 * ids are accepted for forward compatibility.
 */
export async function updateHomeCardLayout(
  userId: string,
  orgId: string,
  layout: HomeCardLayoutInput,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET home_card_layout = ${JSON.stringify(layout)}::jsonb, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}

/**
 * Reaction picker favourites-only partial update (S16). Same targeted pattern
 * as updateHomeCardLayout: the picker holds only this list, and the
 * full-replace `updatePreferences` never names the column, so a Settings save
 * cannot null it. The list is validated by the route (favoriteEmojiSchema:
 * each an emoji, at most 24, no duplicates) and stored in order.
 */
export async function updateFavoriteEmoji(
  userId: string,
  orgId: string,
  favoriteEmoji: string[],
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET favorite_emoji = ${JSON.stringify(favoriteEmoji)}::jsonb, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}

/**
 * Relay the holder's assistant-mail switch (0115). Last writer wins BY THE
 * CHANGE'S OWN TIME: a record is stored only when it is newer than the stored
 * one, so a device replaying a stale change cannot undo a newer one. Returns
 * the stored record and whether this write moved it. The server never
 * interprets `mac`; the devices verify it (web mailbox/agent-mail-access.ts).
 */
export async function updateAgentMailAccess(
  userId: string,
  orgId: string,
  record: AgentMailAccessInput,
  deps: PreferencesDeps,
): Promise<{ stored: AgentMailAccessInput | null; changed: boolean }> {
  await getOrCreatePreferences(userId, orgId, deps)
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`UPDATE ${K}.user_preferences
        SET agent_mail_access = ${JSON.stringify(record)}::jsonb, updated_at = now()
        WHERE user_id = ${userId}
          AND (agent_mail_access IS NULL
               OR (agent_mail_access->>'at')::numeric < ${record.at})
        RETURNING agent_mail_access`,
  )) as unknown as Array<{ agent_mail_access: unknown }>
  if (rows[0]) return { stored: readAgentMailAccess(rows[0].agent_mail_access), changed: true }
  const current = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT agent_mail_access FROM ${K}.user_preferences WHERE user_id = ${userId}`,
  )) as unknown as Array<{ agent_mail_access: unknown }>
  return { stored: readAgentMailAccess(current[0]?.agent_mail_access), changed: false }
}

export async function updatePreferences(
  userId: string,
  input: UserPreferencesInput,
  deps: PreferencesDeps,
): Promise<PreferencesRow> {
  if (!isValidIanaTimezone(input.timezone)) {
    throw new PreferencesServiceError("INVALID_TIMEZONE", `Unknown timezone: ${input.timezone}`)
  }
  if (input.workDays.length === 0) {
    throw new PreferencesServiceError("INVALID_WORK_DAYS", "Pick at least one work day")
  }
  if (new Set(input.workDays).size !== input.workDays.length) {
    throw new PreferencesServiceError("INVALID_WORK_DAYS", "Duplicate work day entries")
  }
  if (input.workDays.some((d) => d < 1 || d > 7)) {
    throw new PreferencesServiceError("INVALID_WORK_DAYS", "Work days must be 1-7")
  }

  const sortedDays = [...input.workDays].sort((a, b) => a - b)
  const workDaysArray = sql.join(
    sortedDays.map((day) => sql`${day}::smallint`),
    sql`, `,
  )
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`INSERT INTO ${K}.user_preferences
          (user_id, digest_cadence, work_hours_start, work_hours_end, work_days, timezone, language, updated_at)
        VALUES (${userId}, ${input.digestCadence},
                ${input.workHoursStart}, ${input.workHoursEnd},
                ARRAY[${workDaysArray}]::smallint[], ${input.timezone},
                ${input.language ?? null}, now())
        ON CONFLICT (user_id) DO UPDATE SET
          digest_cadence = excluded.digest_cadence,
          work_hours_start = excluded.work_hours_start,
          work_hours_end = excluded.work_hours_end,
          work_days = excluded.work_days,
          timezone = excluded.timezone,
          -- A save that does not carry a language (Settings > Attention sends
          -- none) must keep the stored choice. It used to write "en" here,
          -- resetting a French user to English on every attention save.
          -- Clearing a choice is the /language route's job (it takes null).
          language = COALESCE(excluded.language, ${K}.user_preferences.language),
          updated_at = now()
        RETURNING ${RETURNED_COLUMNS}`,
  )) as unknown as DbPrefsRow[]
  return mapRow(rows[0])
}
