// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recurring schedule tools: save a schedule, change it, pause it, list them. The kernel gates
// the writes (create and update park an approval for an agent and run for a person's click; a
// pause parks after outside text); this module decides what is valid and what is written.
//
// Every date a schedule takes is the issuer's civil date (`civilDateOf`), never a UTC date, and a
// schedule that is paused or ended is never due.
import { civilDateOf, type TimeSurface } from "../issue-date"
import { billsOtherOf, checkIssuerGuard } from "../issuer-guard"
import type { ErrorEnvelope, MutationsCtx } from "../mutations/shared"
import {
  type Cadence,
  datesFrom,
  isCivilDate,
  isDueForDraft,
  resumeOn,
  type Repeats,
  type ScheduleError,
  validateSchedule,
} from "./schedule"

export type RecurringCtx = Pick<MutationsCtx, "getUserId" | "db"> & {
  time: TimeSurface["time"]
  approval?: MutationsCtx["approval"] | null
  executeTool?: MutationsCtx["executeTool"]
  turn?: { get(): Promise<unknown> }
}

const ENTITY = "recurring_schedules"

export interface ScheduleLineInput {
  description: string
  qty: number
  unit_price_minor: number
  vat_bp: number
  product_ref?: string
  line_kind?: "goods" | "software" | "shipping" | "service"
}

export interface ScheduleFields {
  company_id?: string | null
  contact_id: string
  repeats: Repeats
  billing_day: string
  ends_on?: string | null
  covers?: "period_ended" | "period_ahead"
  issue_mode?: "review" | "auto"
  paid_by?: "transfer" | "card_link"
  card_link_url?: string | null
  due_rule?: "days_30" | "on_issue" | "days_n"
  due_days?: number | null
  language?: string
  lines: ScheduleLineInput[]
  notes?: string | null
  /** What the schedule bills when the customer also pays a live Stripe subscription (a person's statement). */
  billsOtherThanStripe?: string | null
}

export interface ScheduleCreateInput extends ScheduleFields {
  issuer_profile_id: string
  /** Start the schedule now (the default) or keep it as a draft until someone starts it. */
  status?: "draft" | "active"
}

export type ScheduleUpdateInput = Partial<ScheduleFields> & {
  id: string
  /** `active` resumes a paused or draft schedule from today, `ended` stops it for good. */
  status?: "active" | "ended"
}

export interface ScheduleRow extends Cadence {
  id: string
  issuer_profile_id: string
  company_id?: string | null
  contact_id: string
  status: string
  ends_on?: string | null
  covers?: string
  issue_mode: string
  auto_enabled_by?: string | null
  auto_enabled_at?: string | null
  paid_by?: string
  card_link_url?: string | null
  due_rule?: string
  due_days?: number | null
  language?: string
  lines: ScheduleLineInput[]
  notes?: string | null
  paused_until?: string | null
  next_issue_on?: string | null
  next_draft_on?: string | null
  version: number
  last_document_id?: string | null
  bills_other_than_stripe?: string | null
  created_by?: string
}

type Fail = ErrorEnvelope

function fail(code: string, message: string): Fail {
  return { status: "error", error: { code, message } }
}

/** A day column read back: a plain `YYYY-MM-DD`, whether the store hands it as text or as a Date. */
function dayOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function normalize(raw: unknown): ScheduleRow {
  const row = raw as Record<string, unknown>
  const lines = typeof row.lines === "string" ? (JSON.parse(row.lines) as ScheduleLineInput[]) : (row.lines as ScheduleLineInput[])
  return {
    ...(row as unknown as ScheduleRow),
    lines: lines ?? [],
    ends_on: dayOf(row.ends_on),
    paused_until: dayOf(row.paused_until),
    next_issue_on: dayOf(row.next_issue_on),
    next_draft_on: dayOf(row.next_draft_on),
    auto_enabled_at: dayOf(row.auto_enabled_at),
    version: Number(row.version ?? 1),
  }
}

async function load(ctx: RecurringCtx, id: string): Promise<ScheduleRow | Fail> {
  const raw = await ctx.db.findOne(ENTITY, id)
  if (!raw) {
    return fail("schedule_not_found", `No recurring schedule ${id}. List them with recurring_list to find the right one.`)
  }
  return normalize(raw)
}

function invalid(errors: ScheduleError[]): Fail {
  return fail(
    "invalid_schedule",
    `The schedule was not saved: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}.`,
  )
}

/** Fields the shared validation does not cover: the end date, the due terms, the card link. */
function extraErrors(s: { ends_on?: string | null; due_rule?: string; due_days?: number | null }): ScheduleError[] {
  const errors: ScheduleError[] = []
  if (s.ends_on && !isCivilDate(s.ends_on)) errors.push({ field: "billing_day", message: "ends_on must be a date, YYYY-MM-DD" })
  if (s.due_rule === "days_n" && !(Number.isInteger(s.due_days) && (s.due_days as number) > 0)) {
    errors.push({ field: "billing_day", message: "due_rule days_n needs due_days, a whole number of days above zero" })
  }
  return errors
}

interface IssuerFacts {
  timezone?: string | null
  default_language?: string | null
}

/** The issuer, read under the caller's own scopes: its time zone decides every date saved here. */
async function issuerOf(ctx: RecurringCtx, id: string): Promise<IssuerFacts | Fail> {
  const issuer = (await ctx.db.findOne("issuer_profiles", id)) as IssuerFacts | null
  if (issuer) return issuer
  return fail(
    "issuer_not_found",
    `No issuer profile ${id} that you can read. List them with settings_issuer_profile_list; reading one needs the invoicing settings read scope.`,
  )
}

const isFail = (v: unknown): v is Fail => (v as Fail | null)?.status === "error"

async function today(ctx: RecurringCtx, issuer: { timezone?: string | null }): Promise<{ ok: true; date: string } | { ok: false; error: Fail }> {
  const when = await civilDateOf(ctx, issuer)
  return when.ok ? when : { ok: false, error: when.error }
}

/** A price read back from a document is a string of digits: lines take it as a whole number. */
function withCoercedLines<T extends { lines?: ScheduleLineInput[] }>(input: T): T {
  if (!Array.isArray(input.lines)) return input
  const lines = input.lines.map((l) => {
    const price = l.unit_price_minor as unknown
    return typeof price === "string" && /^-?\d+$/.test(price) ? { ...l, unit_price_minor: Number(price) } : l
  })
  return { ...input, lines }
}

/** Stage-time check of a save: everything that can be refused without writing. */
export function checkScheduleInput(raw: ScheduleFields & { issue_mode?: string }): Fail | null {
  const input = withCoercedLines(raw)
  if (input.issue_mode === "auto") {
    return fail(
      "auto_needs_update",
      "A new schedule cannot issue by itself. Save it with review, then turn it on with recurring_schedule_update, which a person approves.",
    )
  }
  const errors = [...validateSchedule(input), ...extraErrors(input)]
  return errors.length > 0 ? invalid(errors) : null
}

/**
 * One customer, one issuer (issuer-guard.ts): a schedule for a customer a live Stripe subscription
 * bills is refused unless a person says what else it bills. Checked at the card and again when it
 * runs.
 */
async function scheduleGuard(
  ctx: RecurringCtx,
  who: { contact_id?: string | null; company_id?: string | null },
  billsOther: unknown,
  stage: "preflight" | "handler",
): Promise<Fail | null> {
  const guard = await checkIssuerGuard(ctx, { contactId: who.contact_id ?? null, companyId: who.company_id ?? null, billsOtherThanStripe: billsOther, stage })
  return guard.ok ? null : (guard.error as Fail)
}

/** Stage-time check of a new schedule: its fields, then the issuer guard. */
export async function checkScheduleCreate(ctx: RecurringCtx, raw: ScheduleFields & { issue_mode?: string }): Promise<Fail | null> {
  return checkScheduleInput(raw) ?? (await scheduleGuard(ctx, raw, raw.billsOtherThanStripe, "preflight"))
}

export async function recurringScheduleCreate(
  ctx: RecurringCtx,
  raw: ScheduleCreateInput,
): Promise<
  { status: "completed"; id: string; scheduleStatus: string; nextIssueOn: string | null; nextDraftOn: string | null; message: string } | Fail
> {
  const input = withCoercedLines(raw)
  const refused = checkScheduleInput(input) ?? (await scheduleGuard(ctx, input, input.billsOtherThanStripe, "handler"))
  if (refused) return refused
  const issuer = await issuerOf(ctx, input.issuer_profile_id)
  if (isFail(issuer)) return issuer
  const now = await today(ctx, issuer)
  if (!now.ok) return now.error
  const status = input.status ?? "active"
  const dates = status === "active" ? datesFrom(input, now.date) : null
  const userId = await ctx.getUserId()
  const row = {
    issuer_profile_id: input.issuer_profile_id,
    company_id: input.company_id ?? null,
    contact_id: input.contact_id,
    status,
    repeats: input.repeats,
    billing_day: input.billing_day,
    ends_on: input.ends_on ?? null,
    covers: input.covers ?? "period_ended",
    issue_mode: "review",
    paid_by: input.paid_by ?? "transfer",
    card_link_url: input.card_link_url ?? null,
    due_rule: input.due_rule ?? "days_30",
    due_days: input.due_days ?? null,
    language: input.language ?? issuer.default_language ?? "en",
    lines: input.lines.map((l) => ({ ...l, line_kind: l.line_kind ?? "service" })),
    notes: input.notes ?? null,
    ...(billsOtherOf(input.billsOtherThanStripe)
      ? { bills_other_than_stripe: billsOtherOf(input.billsOtherThanStripe), bills_other_by: ctx.approval?.approvalDeciderId ?? userId }
      : {}),
    next_issue_on: dates?.next_issue_on ?? null,
    next_draft_on: dates?.next_draft_on ?? null,
    version: 1,
    created_by: userId,
  }
  const created = (await ctx.db.insert(ENTITY, row)) as { id: string }
  return {
    status: "completed",
    id: created.id,
    scheduleStatus: status,
    nextIssueOn: dates?.next_issue_on ?? null,
    nextDraftOn: dates?.next_draft_on ?? null,
    message: dates
      ? `Schedule ${created.id} saved and active. Its next invoice issues on ${dates.next_issue_on}; the draft is made on ${dates.next_draft_on} for review.`
      : `Schedule ${created.id} saved as a draft and bills nothing. Start it with recurring_schedule_update status active.`,
  }
}

function merged(row: ScheduleRow, patch: Partial<ScheduleFields>): ScheduleRow {
  const next = { ...row } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v
  return next as unknown as ScheduleRow
}

/** Stage-time check of an update, against the schedule as it stands. */
export async function checkScheduleUpdate(
  ctx: RecurringCtx,
  raw: ScheduleUpdateInput,
  stage: "preflight" | "handler" = "handler",
): Promise<Fail | null> {
  const input = withCoercedLines(raw)
  const row = await load(ctx, input.id)
  if ("status" in row && row.status === "error") return row as Fail
  const current = row as ScheduleRow
  if (current.status === "ended") {
    return fail("schedule_ended", `Schedule ${current.id} has ended and cannot be changed. Save a new schedule instead.`)
  }
  const { id: _id, status: _status, billsOtherThanStripe, ...patch } = input
  const next = merged(current, patch)
  const errors = [...validateSchedule(next), ...extraErrors(next)]
  if (errors.length > 0) return invalid(errors)
  // Ending a schedule bills nothing more, so it never meets the guard.
  if (raw.status === "ended") return null
  return scheduleGuard(ctx, next, billsOtherThanStripe ?? current.bills_other_than_stripe, stage)
}

export async function recurringScheduleUpdate(
  ctx: RecurringCtx,
  raw: ScheduleUpdateInput,
): Promise<
  { status: "completed"; id: string; version: number; issueMode: string; scheduleStatus: string; nextIssueOn: string | null; message: string } | Fail
> {
  const input = withCoercedLines(raw)
  const refused = await checkScheduleUpdate(ctx, input)
  if (refused) return refused
  const current = (await load(ctx, input.id)) as ScheduleRow
  const issuer = await issuerOf(ctx, current.issuer_profile_id)
  if (isFail(issuer)) return issuer
  const now = await today(ctx, issuer)
  if (!now.ok) return now.error

  const { id: _id, status: wanted, billsOtherThanStripe, ...patch } = input
  const next = merged(current, patch)
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) data[k] = v
  const statement = billsOtherOf(billsOtherThanStripe)
  if (statement) {
    data.bills_other_than_stripe = statement
    data.bills_other_by = ctx.approval?.approvalDeciderId ?? (await ctx.getUserId())
  }
  if (patch.lines) data.lines = patch.lines.map((l) => ({ ...l, line_kind: l.line_kind ?? "service" }))

  // Who turned automatic issuing on is the person who decided it: the approver of an agent's
  // request, or the person who clicked.
  if (patch.issue_mode && patch.issue_mode !== current.issue_mode) {
    if (patch.issue_mode === "auto") {
      data.auto_enabled_by = ctx.approval?.approvalDeciderId ?? (await ctx.getUserId())
      data.auto_enabled_at = now.date
    } else {
      data.auto_enabled_by = null
      data.auto_enabled_at = null
    }
  }

  let status = current.status
  if (wanted === "ended") {
    status = "ended"
    data.next_issue_on = null
    data.next_draft_on = null
  } else if (wanted === "active" && current.status !== "active") {
    status = "active"
    data.paused_until = null
    Object.assign(data, resumeOn(next, now.date))
  } else if (current.status === "active" && (patch.billing_day !== undefined || patch.repeats !== undefined)) {
    Object.assign(data, datesFrom(next, now.date))
  }
  data.status = status
  data.version = current.version + 1
  await ctx.db.update(ENTITY, current.id, data)
  const issueMode = String(data.issue_mode ?? current.issue_mode)
  const nextIssueOn = (data.next_issue_on as string | null | undefined) ?? (status === "ended" ? null : (current.next_issue_on ?? null))
  return {
    status: "completed",
    id: current.id,
    version: current.version + 1,
    issueMode,
    scheduleStatus: status,
    nextIssueOn,
    message:
      `Schedule ${current.id} changed to version ${current.version + 1}. ` +
      (status === "ended"
        ? "It has ended and bills nothing more."
        : `Its next invoice issues on ${nextIssueOn ?? "no date"}; drafts already made keep their amounts.`),
  }
}

export async function recurringSchedulePause(
  ctx: RecurringCtx,
  input: { id: string; until?: string | null },
  checkOnly = false,
): Promise<
  { status: "completed"; id: string; scheduleStatus: "paused"; until: string | null; unchanged?: true; message: string } | Fail
> {
  const row = await load(ctx, input.id)
  if ("status" in row && row.status === "error") return row as Fail
  const current = row as ScheduleRow
  if (current.status === "ended") {
    return fail("schedule_ended", `Schedule ${current.id} has ended, so there is nothing to pause.`)
  }
  if (current.status === "paused") {
    return {
      status: "completed",
      id: current.id,
      scheduleStatus: "paused",
      until: current.paused_until ?? null,
      unchanged: true,
      message:
        `Schedule ${current.id} was already paused${current.paused_until ? ` until ${current.paused_until}` : ""}; nothing was changed. ` +
        "To change the date, resume it with recurring_schedule_update status active and pause it again.",
    }
  }
  if (current.status !== "active") {
    return fail("schedule_not_started", `Schedule ${current.id} is a draft and bills nothing yet, so there is nothing to pause.`)
  }
  if (input.until) {
    const issuer = await issuerOf(ctx, current.issuer_profile_id)
    if (isFail(issuer)) return issuer
    const now = await today(ctx, issuer)
    if (!now.ok) return now.error
    if (!isCivilDate(input.until) || input.until <= now.date) {
      return fail("invalid_until", `until must be a date after today (${now.date}), written YYYY-MM-DD. Nothing was paused.`)
    }
  }
  if (checkOnly) {
    return { status: "completed", id: current.id, scheduleStatus: "paused", until: input.until ?? null, message: "Checked; nothing was written." }
  }
  await ctx.db.update(ENTITY, current.id, {
    status: "paused",
    paused_until: input.until ?? null,
    version: current.version + 1,
  })
  return {
    status: "completed",
    id: current.id,
    scheduleStatus: "paused",
    until: input.until ?? null,
    message: input.until
      ? `Schedule ${current.id} is paused until ${input.until}. No draft is made while it is paused, and the days inside the pause are not billed afterwards.`
      : `Schedule ${current.id} is paused and bills nothing until someone resumes it with recurring_schedule_update status active.`,
  }
}

/**
 * The schedules that get a draft on `today`. A paused schedule whose `until` has come is resumed
 * first, from today: every billing day inside the pause is skipped, so nothing is back-billed.
 */
export async function draftCandidates(ctx: RecurringCtx, todayDate: string): Promise<ScheduleRow[]> {
  const paused = ((await ctx.db.findMany(ENTITY, { where: { status: "paused" } })) as unknown[]).map(normalize)
  for (const s of paused) {
    if (!s.paused_until || s.paused_until > todayDate) continue
    await ctx.db.update(ENTITY, s.id, { status: "active", paused_until: null, version: s.version + 1, ...resumeOn(s, todayDate) })
  }
  const active = ((await ctx.db.findMany(ENTITY, { where: { status: "active" } })) as unknown[]).map(normalize)
  return active.filter((s) => isDueForDraft(s, todayDate))
}

export async function recurringList(
  ctx: RecurringCtx,
  input: { status?: string; limit?: number; cursor?: string },
): Promise<{ rows: ScheduleRow[]; nextCursor: string | null; nextRun: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200)
  const offset = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0
  const found = (await ctx.db.findMany(ENTITY, {
    where: input.status ? { status: input.status } : {},
    orderBy: { next_issue_on: "asc" },
    limit: limit + 1,
    offset,
  })) as unknown[]
  // The free-text `notes` stay out of the list: a row names its schedule, dates and amounts only.
  const rows = found.slice(0, limit).map((r) => {
    const { notes: _notes, ...row } = normalize(r)
    return row as ScheduleRow
  })
  const first = (await ctx.db.findMany(ENTITY, { where: { status: "active" }, orderBy: { next_issue_on: "asc" }, limit: 1 })) as unknown[]
  return {
    rows,
    nextCursor: found.length > limit ? String(offset + limit) : null,
    nextRun: first[0] ? normalize(first[0]).next_issue_on ?? null : null,
  }
}
