// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kind `calendar.event` (modules/imports): the events of an iCalendar
 * file (source format `ics`, read host-side by modules/imports/parsers/ics.ts),
 * or canonical records of the same shape.
 *
 * Events land in a LOCAL calendar of the importing person's own "Imported"
 * account (owner_type user, never fanned out to the org), named by
 * the run option `calendarName` (default "Imported"):
 * - the account has `sync_status = 'imported'`, an address under
 *   `calendar.invalid` and a `connected_account_id` no connection holds, so
 *   no sync, watch, poll or push ever touches it (sync.ts skips imported
 *   accounts) and the disconnect reconciler has nothing to purge;
 * - its calendar is `local:<uuid>`, not selected for polling, and granted to
 *   the importing person (`calendar:calaccess`, the account id);
 * - both are created by the first record that needs them (on that record's
 *   ledger) and reused by later records and runs.
 * Events are `pending_push = 'none'` with no Google id, deduplicated by
 * `external_ref` per calendar (the ICS UID, `#RECURRENCE-ID` for an override).
 */
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  dedupMatchSql,
  type HostImportContext,
  type HostImportHandler,
  type ImportRowRef,
} from "~/modules/imports/types"

const cal = (t: string) => drizzleSql.raw(`${schemaRef("app_calendar")}.${t}`)
const kernel = (t: string) => drizzleSql.raw(`${schemaRef("kernel")}.${t}`)

const time = z
  .object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .strict()
  .refine((t) => (t.dateTime === undefined) !== (t.date === undefined), {
    message: "a time has exactly one of dateTime or date",
  })

export const calendarEventImportRecordSchema = z
  .object({
    externalRef: z.string().min(1).max(1000),
    title: z.string().max(1000).optional(),
    description: z.string().max(100_000).optional(),
    location: z.string().max(2000).optional(),
    start: time,
    end: time,
    allDay: z.boolean(),
    status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
    recurrence: z.array(z.string().max(2000)).max(100).optional(),
    attendees: z
      .array(
        z.object({ email: z.string().max(320), name: z.string().max(200).optional() }).strict(),
      )
      .max(500)
      .optional(),
    organizerEmail: z.string().max(320).optional(),
    originalStartTime: time.optional(),
  })
  .strict()

/** The calendar a run imports into: created once, then reused. */
async function importedCalendar(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  rows: ImportRowRef[],
): Promise<{ calendarId: string; accountId: string }> {
  const name =
    typeof ctx.options.calendarName === "string" && ctx.options.calendarName.trim()
      ? ctx.options.calendarName.trim().slice(0, 200)
      : "Imported"
  const cacheKey = `calendar:${name}`
  const hit = ctx.cache.get(cacheKey) as { calendarId: string; accountId: string } | undefined
  if (hit) return hit
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "imported"
  // One account per importing person: the address carries their id.
  const address = `imported+${ctx.actorUserId}-${slug}@calendar.invalid`

  let account = extractRows<{ id: string; sync_status: string }>(
    await tx.execute(drizzleSql`
      SELECT id, sync_status FROM ${cal("accounts")}
      WHERE org_id = ${ctx.orgId}::uuid AND email_address = ${address}
    `),
  )[0]
  if (account && account.sync_status !== "imported") {
    throw new Error(`the address ${address} belongs to an account that is not an imported calendar`)
  }
  if (!account) {
    const id = randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO ${cal("accounts")}
        (id, org_id, connected_account_id, owner_type, owner_id, email_address, display_name, sync_status)
      VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${randomUUID()}::uuid, 'user',
              ${ctx.actorUserId}::uuid, ${address}, ${name}, 'imported')
    `)
    rows.push({ table: "app_calendar.accounts", id })
    account = { id, sync_status: "imported" }
  }
  let calendar = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${cal("calendars")}
      WHERE org_id = ${ctx.orgId}::uuid AND account_id = ${account.id}::uuid
      ORDER BY created_at LIMIT 1
    `),
  )[0]
  if (!calendar) {
    const id = randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO ${cal("calendars")}
        (id, org_id, account_id, google_calendar_id, name, selected, calaccess)
      VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${account.id}::uuid, ${`local:${randomUUID()}`},
              ${name}, false, ${account.id})
    `)
    rows.push({ table: "app_calendar.calendars", id })
    calendar = { id }
  }
  // The importing person sees what they imported (a membership dimension
  // grant, merged into what they already hold). A grant row this import
  // creates is ledgered, so undo takes it back; a row they already held only
  // gains the value.
  const granted = extractRows<{ id: string; created: boolean }>(
    await tx.execute(drizzleSql`
    INSERT INTO ${kernel("user_dimension_grants")} (id, user_id, org_id, dimension_key, dimension_values)
    VALUES (gen_random_uuid(), ${ctx.actorUserId}::uuid, ${ctx.orgId}::uuid, 'calendar:calaccess',
            ${JSON.stringify([account.id])}::jsonb)
    ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE SET
      dimension_values = (
        SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(
          ${kernel("user_dimension_grants")}.dimension_values || ${JSON.stringify([account.id])}::jsonb
        ) AS v
      )
    WHERE NOT (${kernel("user_dimension_grants")}.dimension_values @> ${JSON.stringify([account.id])}::jsonb)
    RETURNING id::text AS id, (xmax = 0) AS created
  `),
  )
  for (const g of granted) {
    if (g.created) rows.push({ table: "kernel.user_dimension_grants", id: g.id })
  }
  const target = { calendarId: calendar.id, accountId: account.id }
  ctx.cache.set(cacheKey, target)
  return target
}

async function importEvent(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = calendarEventImportRecordSchema.parse(raw)
  const rows: ImportRowRef[] = []
  const target = await importedCalendar(tx, ctx, rows)
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${cal("events")}
      WHERE org_id = ${ctx.orgId}::uuid AND calendar_id = ${target.calendarId}::uuid
        AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, record.externalRef)}
      LIMIT 1
    `),
  )
  if (existing.length > 0) {
    // Skipped; whatever setup this record made (none in practice: a calendar
    // it just created holds no event yet) is still ledgered.
    return { status: "skipped" as const, rows }
  }
  const attendees = record.attendees?.map((a) =>
    a.name ? { email: a.email, displayName: a.name } : { email: a.email },
  )
  const id = randomUUID()
  await tx.execute(drizzleSql`
    INSERT INTO ${cal("events")}
      (id, org_id, calendar_id, title, description, location, start, "end", all_day, status,
       attendees, recurrence, original_start_time, extended_props, pending_push, calaccess,
       external_ref)
    VALUES (
      ${id}::uuid, ${ctx.orgId}::uuid, ${target.calendarId}::uuid, ${record.title ?? null},
      ${record.description ?? null}, ${record.location ?? null},
      ${JSON.stringify(record.start)}::jsonb, ${JSON.stringify(record.end)}::jsonb,
      ${record.allDay}, ${record.status ?? "confirmed"},
      ${attendees ? JSON.stringify(attendees) : null}::jsonb,
      ${record.recurrence ? JSON.stringify(record.recurrence) : null}::jsonb,
      ${record.originalStartTime ? JSON.stringify(record.originalStartTime) : null}::jsonb,
      ${record.organizerEmail ? JSON.stringify({ import: { organizerEmail: record.organizerEmail } }) : null}::jsonb,
      'none', ${target.accountId}, ${dedupValue}
    )
  `)
  rows.push({ table: "app_calendar.events", id })
  return { status: "created" as const, rows }
}

export const calendarEventImportHandler: HostImportHandler = {
  importRecord: importEvent,
}
