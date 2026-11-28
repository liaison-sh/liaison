// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approval cards for the calendar's writes (a trusted, in-tree app: the host resolves these by
// export name from the manifest's `summarizer` field). Without them a card read "Calendar: a
// record" and "Event: a record" (calendar records are never named by the generic card: a
// decider may not see the requester's own calendar), and a delete did not say which event.
// These name the event the way the calendar's own handler gate already does: its title, its
// time and its calendar, read with the requester's own access. A lookup that fails (a weak
// agent's id naming nothing) leaves its line out and never fails the call.
import { sql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"

interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

interface SummaryCtx {
  tx: RlsClient
  orgId: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEXT_MAX = 120

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.replace(/\s+/g, " ").trim()
  if (t === "") return null
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t
}

/** A point (an ISO string or Google's `{dateTime}` / `{date}`) as text. */
function pointText(point: unknown): string | null {
  if (typeof point === "string") return str(point)
  if (isRec(point)) return str(point.dateTime) ?? str(point.date)
  return null
}

function whenText(start: unknown, end: unknown): string | null {
  const s = pointText(start)
  if (!s) return null
  const e = pointText(end)
  return e ? `${s} to ${e}` : s
}

/** One row read in its own savepoint, so a failed lookup never costs the caller its transaction. */
async function readOne<T>(ctx: SummaryCtx, query: ReturnType<typeof sql>): Promise<T | null> {
  try {
    return await ctx.tx.transaction(async (sp) => {
      const rows = extractRows<T>(await (sp as unknown as RlsClient).execute(query))
      return rows[0] ?? null
    })
  } catch {
    return null
  }
}

interface EventRow {
  title: string | null
  start: unknown
  end: unknown
  calendar_id: string
}

/** The event an id names: a local id, or a recurring series' Google id (what list_events gives). */
async function eventOf(ctx: SummaryCtx, eventId: unknown): Promise<EventRow | null> {
  if (typeof eventId !== "string" || eventId.trim() === "") return null
  const events = sql.raw(`${schemaRef("app_calendar")}.events`)
  const match = UUID_RE.test(eventId)
    ? sql`id = ${eventId}::uuid`
    : sql`google_event_id = ${eventId} AND recurring_event_id IS NULL`
  return readOne<EventRow>(
    ctx,
    sql`SELECT title, start, "end", calendar_id FROM ${events}
        WHERE org_id = ${ctx.orgId}::uuid AND ${match} LIMIT 1`,
  )
}

async function calendarName(ctx: SummaryCtx, calendarId: unknown): Promise<string | null> {
  if (typeof calendarId !== "string" || !UUID_RE.test(calendarId)) return null
  const calendars = sql.raw(`${schemaRef("app_calendar")}.calendars`)
  const row = await readOne<{ name: string | null }>(
    ctx,
    sql`SELECT name FROM ${calendars} WHERE org_id = ${ctx.orgId}::uuid AND id = ${calendarId}::uuid LIMIT 1`,
  )
  return str(row?.name)
}

function guestLines(p: Record<string, unknown>): string[] {
  if (!Array.isArray(p.attendees)) return []
  const guests = p.attendees.filter((g): g is string => typeof g === "string" && g.trim() !== "")
  if (guests.length === 0) return ["Guests: none"]
  const shown = guests.slice(0, 6).join(", ")
  return [`Guests: ${shown}${guests.length > 6 ? ` and ${guests.length - 6} more` : ""}`]
}

function emailLine(p: Record<string, unknown>, cancel = false): string {
  if (p.sendUpdates === "all") {
    return cancel
      ? "Google emails every guest that it is cancelled."
      : "Google emails every guest once approved."
  }
  if (p.sendUpdates === "externalOnly") return "Google emails the guests outside the organization."
  return "Nobody is emailed."
}

/** Which occurrences a recurring write names (`occurrence`, `following`, `series`), else null. */
function seriesPart(p: Record<string, unknown>): string | null {
  return typeof p.scope === "string" ? p.scope : null
}

function scopeLine(p: Record<string, unknown>): string[] {
  const which = seriesPart(p)
  if (which === "occurrence") {
    const at = pointText(p.occurrenceStart)
    return [at ? `Only the occurrence of ${at}` : "Only one occurrence"]
  }
  if (which === "following") {
    const at = pointText(p.occurrenceStart)
    return [at ? `The occurrence of ${at} and every later one` : "This and every later occurrence"]
  }
  if (which === "series") return ["Every occurrence of the series"]
  return []
}

export async function summarizeCreateEvent(
  params: unknown,
  ctx: SummaryCtx,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const title = str(p.title)
  const when = whenText(p.start, p.end)
  const calendar = await calendarName(ctx, p.calendarId)
  return {
    kind: "calendar_create_event",
    title: `Create ${title ? `"${title}"` : "an event"}`,
    lines: [
      ...(when ? [`When: ${when}`] : []),
      ...(calendar ? [`Calendar: ${calendar}`] : []),
      ...(str(p.location) ? [`Location: ${str(p.location)}`] : []),
      ...(p.conference === "google_meet" ? ["With a Google Meet link"] : []),
      ...guestLines(p),
      emailLine(p),
    ],
  }
}

export async function summarizeUpdateEvent(
  params: unknown,
  ctx: SummaryCtx,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const event = await eventOf(ctx, p.eventId)
  const current = str(event?.title)
  const calendar = await calendarName(ctx, p.calendarId ?? event?.calendar_id)
  const newTitle = str(p.title)
  const newWhen = whenText(p.start, p.end)
  return {
    kind: "calendar_update_event",
    title: `Update ${current ? `"${current}"` : newTitle ? `"${newTitle}"` : "an event"}`,
    lines: [
      ...(event && whenText(event.start, event.end) && !scopeLine(p).length
        ? [`Now: ${whenText(event.start, event.end)}`]
        : []),
      ...scopeLine(p),
      ...(calendar ? [`Calendar: ${calendar}`] : []),
      ...(newTitle && newTitle !== current ? [`New title: ${newTitle}`] : []),
      ...(newWhen ? [`New time: ${newWhen}`] : []),
      ...(str(p.location) ? [`Location: ${str(p.location)}`] : []),
      ...(p.description !== undefined ? ["Description changed"] : []),
      ...(p.conference === "google_meet"
        ? ["Adds a Google Meet link"]
        : p.conference === "none"
          ? ["Removes the video link"]
          : []),
      ...guestLines(p),
      emailLine(p),
    ],
  }
}

export async function summarizeDeleteEvent(
  params: unknown,
  ctx: SummaryCtx,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const event = await eventOf(ctx, p.eventId)
  const title = str(event?.title)
  const calendar = await calendarName(ctx, event?.calendar_id)
  const when = event ? whenText(event.start, event.end) : null
  return {
    kind: "calendar_delete_event",
    title: `Delete ${title ? `"${title}"` : "a calendar event"}`,
    lines: [
      ...(when && seriesPart(p) !== "occurrence" ? [`When: ${when}`] : []),
      ...scopeLine(p),
      ...(calendar ? [`Calendar: ${calendar}`] : []),
      emailLine(p, true),
    ],
  }
}
