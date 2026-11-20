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
import { formatMoneyMinor } from "../money"
import type { ErrorEnvelope, MutationsCtx } from "../mutations/shared"
import {
  billsDeliveredPeriod,
  KEPT_AFTER_STOP,
  SCHEDULE_ENDED,
  SCHEDULE_PAUSED,
} from "./end-schedule"
import { type EditCtx, logRunEdit, stageRunCardAfterRemoval } from "./restage"
import {
  hoursText,
  isRetainerSchedule,
  monthOf,
  nextMonth,
  PREPAID_WARNING,
  type RetainerRenewal,
  renewalOf,
  termsForMonth,
} from "./retainer"
import {
  type Cadence,
  datesFrom,
  isCivilDate,
  isDueForDraft,
  type Repeats,
  resumeOn,
  type ScheduleError,
  validateSchedule,
} from "./schedule"

export type RecurringCtx = Pick<MutationsCtx, "getUserId" | "db"> & {
  time: TimeSurface["time"]
  /** Announces a change, so open views of the record read it again. Absent on bare test contexts. */
  emit?: (event: {
    entity: string
    action: string
    entityId: string
    data: Record<string, unknown>
  }) => Promise<void>
  approval?: MutationsCtx["approval"] | null
  executeTool?: MutationsCtx["executeTool"]
  /** The caller's own scopes (never a widened cross-app actor): a retainer needs projects money. */
  hasScope?(scope: string): Promise<boolean>
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
  /** A retainer: the project its month is reconciled on, its included minutes, its overage rate. */
  retainer_project_id?: string | null
  retainer_minutes?: number | null
  retainer_overage_rate_minor?: number | null
  retainer_rollover?: "none" | "next"
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
  /** The version the change was made from: a schedule saved since then refuses it. */
  expected_version?: number
}

export interface ScheduleRow extends Cadence {
  id: string
  issuer_profile_id: string
  company_id?: string | null
  /** Null once the schedule has ended and its person was deleted. */
  contact_id: string | null
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
  retainer_project_id?: string | null
  retainer_minutes?: number | null
  retainer_overage_rate_minor?: number | string | null
  retainer_rollover?: string
  retainer_from?: string | null
  retainer_renewal?: unknown
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
  const lines =
    typeof row.lines === "string"
      ? (JSON.parse(row.lines) as ScheduleLineInput[])
      : (row.lines as ScheduleLineInput[])
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
    return fail(
      "schedule_not_found",
      `No recurring schedule ${id}. List them with recurring_list to find the right one.`,
    )
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
function extraErrors(s: {
  ends_on?: string | null
  due_rule?: string
  due_days?: number | null
}): ScheduleError[] {
  const errors: ScheduleError[] = []
  if (s.ends_on && !isCivilDate(s.ends_on))
    errors.push({ field: "billing_day", message: "ends_on must be a date, YYYY-MM-DD" })
  if (s.due_rule === "days_n" && !(Number.isInteger(s.due_days) && (s.due_days as number) > 0)) {
    errors.push({
      field: "billing_day",
      message: "due_rule days_n needs due_days, a whole number of days above zero",
    })
  }
  return errors
}

interface IssuerFacts {
  timezone?: string | null
  default_language?: string | null
  /** The issuer the schedule names, when the caller's role cannot read it: its zone still decides. */
  zoneOf?: string
}

/**
 * The issuer, read under the caller's own scopes: its time zone decides every date saved here.
 * A person whose role cannot read issuer profiles may still change a schedule their scope lets
 * them change: its dates then follow the issuer's zone, which the host reads for them and which
 * is all they learn of the issuer.
 */
async function issuerOf(ctx: RecurringCtx, id: string): Promise<IssuerFacts> {
  const issuer = (await ctx.db.findOne("issuer_profiles", id)) as IssuerFacts | null
  return issuer ?? { zoneOf: id }
}

async function today(
  ctx: RecurringCtx,
  issuer: IssuerFacts,
): Promise<{ ok: true; date: string } | { ok: false; error: Fail }> {
  if (issuer.zoneOf !== undefined) {
    try {
      const civil = await ctx.time.civil({
        timezoneOf: { table: "issuer_profiles", id: issuer.zoneOf },
      })
      return { ok: true, date: civil.date }
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== "not_found") throw err
      return {
        ok: false,
        error: fail(
          "issuer_not_found",
          `No issuer profile ${issuer.zoneOf}: the schedule names one that does not exist. Nothing was saved.`,
        ),
      }
    }
  }
  const when = await civilDateOf(ctx, issuer)
  return when.ok ? when : { ok: false, error: when.error }
}

/** A price read back from a document is a string of digits: lines take it as a whole number. */
function withCoercedLines<T extends { lines?: ScheduleLineInput[] }>(input: T): T {
  if (!Array.isArray(input.lines)) return input
  const lines = input.lines.map((l) => {
    const price = l.unit_price_minor as unknown
    return typeof price === "string" && /^-?\d+$/.test(price)
      ? { ...l, unit_price_minor: Number(price) }
      : l
  })
  return { ...input, lines }
}

/** Stage-time check of a save: everything that can be refused without writing. */
export function checkScheduleInput(raw: ScheduleFields & { issue_mode?: string }): Fail | null {
  const input = withCoercedLines(raw)
  const retainer = retainerErrors(input)
  if (retainer) return retainer
  if (input.issue_mode === "auto") {
    return fail(
      "auto_needs_update",
      "A new schedule cannot issue by itself. Save it with review, then turn it on with recurring_schedule_update, which a person approves.",
    )
  }
  const errors = [...validateSchedule(input), ...extraErrors(input)]
  return errors.length > 0 ? invalid(errors) : null
}

/** What a retainer's terms must hold, and the one thing a retainer can never do: issue by itself. */
function retainerErrors(s: {
  retainer_project_id?: unknown
  retainer_minutes?: unknown
  retainer_overage_rate_minor?: unknown
  retainer_rollover?: unknown
  issue_mode?: unknown
  repeats?: unknown
}): Fail | null {
  const any =
    (s.retainer_minutes !== undefined && s.retainer_minutes !== null) ||
    (s.retainer_project_id !== undefined && s.retainer_project_id !== null)
  if (!any) return null
  const errors: string[] = []
  if (!(Number.isInteger(s.retainer_minutes) && (s.retainer_minutes as number) > 0))
    errors.push("retainer_minutes: the included hours, in minutes above zero")
  const rate = s.retainer_overage_rate_minor
  if (!(Number.isInteger(Number(rate)) && Number(rate) >= 0 && rate !== null && rate !== undefined))
    errors.push("retainer_overage_rate_minor: the overage rate in minor units, zero or more")
  if (typeof s.retainer_project_id !== "string" || s.retainer_project_id === "")
    errors.push("retainer_project_id: the project the month is reconciled on")
  // A retainer bills one month at a time from its card: a longer period would bill its whole fee
  // each month.
  if (s.repeats !== undefined && s.repeats !== "month")
    errors.push(
      `repeats: a retainer repeats every month, since each month is invoiced from the project's planned vs done card (this schedule repeats every ${String(s.repeats)})`,
    )
  if (errors.length > 0)
    return fail("invalid_schedule", `The retainer was not saved: ${errors.join("; ")}.`)
  if (s.issue_mode === "auto") {
    return fail(
      "retainer_needs_reconcile",
      "A retainer cannot issue by itself: its month is invoiced from the project's planned vs done card, which a person reconciles. Nothing was saved; keep issue_mode review.",
    )
  }
  return null
}

/** Retainer terms are money on a project: they need the person's own projects money scope. */
async function retainerScopeRefusal(
  ctx: RecurringCtx,
  patch: {
    retainer_minutes?: unknown
    retainer_project_id?: unknown
    retainer_overage_rate_minor?: unknown
    retainer_rollover?: unknown
  },
): Promise<Fail | null> {
  const touches =
    patch.retainer_minutes !== undefined ||
    patch.retainer_project_id !== undefined ||
    patch.retainer_overage_rate_minor !== undefined ||
    patch.retainer_rollover !== undefined
  if (!touches) return null
  const own = ctx.hasScope ? await ctx.hasScope("projects:money:write") : false
  if (own) return null
  return fail(
    "retainer_needs_project_money",
    "Setting a project's retainer needs the projects money scope (a project lead or finance in projects). Nothing was saved.",
  )
}

/**
 * The retainer's months on its project: this month (on a new retainer) and the next, with the
 * included hours, written through projects' own timebox tool. Best effort: the daily roll adds a
 * missing month. Returns what it wrote.
 */
export async function writeRetainerTimeboxes(
  ctx: RecurringCtx,
  s: { id: string; retainer_project_id?: string | null; retainer_minutes?: number | null },
  months: string[],
  minutes: number | null,
): Promise<string[]> {
  if (!ctx.executeTool || !s.retainer_project_id) return []
  const done: string[] = []
  for (const month of months) {
    const timebox =
      minutes === null
        ? null
        : minutes % 60 === 0
          ? `${minutes / 60}h`
          : `${Math.floor(minutes / 60)}h ${minutes % 60}`
    try {
      const env = await ctx.executeTool("projects:period_timebox_set", {
        projectId: s.retainer_project_id,
        month,
        timebox,
        sourceRef: s.id,
      })
      if (env?.status === "completed") done.push(month)
    } catch {
      // The daily roll writes it.
    }
  }
  return done
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
  const guard = await checkIssuerGuard(ctx, {
    contactId: who.contact_id ?? null,
    companyId: who.company_id ?? null,
    billsOtherThanStripe: billsOther,
    stage,
  })
  return guard.ok ? null : (guard.error as Fail)
}

/** Stage-time check of a new schedule: its fields, then the issuer guard. */
export async function checkScheduleCreate(
  ctx: RecurringCtx,
  raw: ScheduleFields & { issue_mode?: string },
): Promise<Fail | null> {
  return (
    checkScheduleInput(raw) ??
    (await retainerScopeRefusal(ctx, raw)) ??
    (await scheduleGuard(ctx, raw, raw.billsOtherThanStripe, "preflight"))
  )
}

export async function recurringScheduleCreate(
  ctx: RecurringCtx,
  raw: ScheduleCreateInput,
): Promise<
  | {
      status: "completed"
      id: string
      scheduleStatus: string
      nextIssueOn: string | null
      nextDraftOn: string | null
      timeboxMonths?: string[]
      warning?: string
      message: string
    }
  | Fail
> {
  const input = withCoercedLines(raw)
  const refused =
    checkScheduleInput(input) ??
    (await retainerScopeRefusal(ctx, input)) ??
    (await scheduleGuard(ctx, input, input.billsOtherThanStripe, "handler"))
  if (refused) return refused
  const issuer = await issuerOf(ctx, input.issuer_profile_id)
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
    ...(isRetainerSchedule(input)
      ? {
          retainer_project_id: input.retainer_project_id,
          retainer_minutes: input.retainer_minutes,
          retainer_overage_rate_minor: input.retainer_overage_rate_minor ?? 0,
          retainer_rollover: input.retainer_rollover ?? "none",
          retainer_from: monthOf(now.date),
        }
      : {}),
    ...(billsOtherOf(input.billsOtherThanStripe)
      ? {
          bills_other_than_stripe: billsOtherOf(input.billsOtherThanStripe),
          bills_other_by: ctx.approval?.approvalDeciderId ?? userId,
        }
      : {}),
    next_issue_on: dates?.next_issue_on ?? null,
    next_draft_on: dates?.next_draft_on ?? null,
    version: 1,
    created_by: userId,
  }
  const created = (await ctx.db.insert(ENTITY, row)) as { id: string }
  if (isRetainerSchedule(input)) {
    const month = monthOf(now.date)
    const months =
      status === "active"
        ? await writeRetainerTimeboxes(
            ctx,
            { id: created.id, retainer_project_id: input.retainer_project_id ?? null },
            [month, nextMonth(month)],
            Number(input.retainer_minutes),
          )
        : []
    return {
      status: "completed",
      id: created.id,
      scheduleStatus: status,
      nextIssueOn: null,
      nextDraftOn: null,
      timeboxMonths: months,
      ...(input.covers === "period_ahead" ? { warning: PREPAID_WARNING } : {}),
      message:
        `Retainer ${created.id} saved${status === "active" ? " and active" : " as a draft"}. The month-end run never drafts it: each month is invoiced from the project's planned vs done card once a person reconciles it. ` +
        (months.length > 0
          ? `Included hours are set on the project for ${months.join(" and ")}.`
          : status === "active"
            ? "The project's monthly timeboxes were not written yet; the daily roll adds them."
            : "Start it with recurring_schedule_update status active.") +
        (input.covers === "period_ahead" ? ` ${PREPAID_WARNING}` : ""),
    }
  }
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
    return fail(
      "schedule_ended",
      `Schedule ${current.id} has ended and cannot be changed. Save a new schedule instead.`,
    )
  }
  const stale = staleVersion(current, input.expected_version)
  if (stale) return stale
  const {
    id: _id,
    status: _status,
    expected_version: _expected,
    billsOtherThanStripe,
    ...patch
  } = input
  const next = merged(current, patch)
  const errors = [...validateSchedule(next), ...extraErrors(next)]
  if (errors.length > 0) return invalid(errors)
  const retainer =
    retainerErrors({
      ...next,
      retainer_overage_rate_minor: next.retainer_overage_rate_minor ?? 0,
    }) ?? (await retainerScopeRefusal(ctx, patch))
  if (retainer) return retainer
  // Ending a schedule bills nothing more, so it never meets the guard.
  if (raw.status === "ended") return null
  return scheduleGuard(ctx, next, billsOtherThanStripe ?? current.bills_other_than_stripe, stage)
}

/** Tell open views of the schedule that it changed (they read it again). */
async function announceScheduleChange(
  ctx: RecurringCtx,
  id: string,
  version: number,
): Promise<void> {
  if (!ctx.emit) return
  await ctx.emit({
    entity: "recurring_schedule",
    action: "updated",
    entityId: id,
    data: { schedule_id: id, version },
  })
}

/** A change made from an older version than the schedule now holds: refused, never written over. */
function staleVersion(current: ScheduleRow, expected: number | undefined): Fail | null {
  if (expected === undefined || expected === current.version) return null
  return fail(
    "schedule_changed",
    `Schedule ${current.id} was changed by someone else: it is now at version ${current.version}, and this change was made from version ${expected}. Nothing was saved. Read it again with recurring_list, then make the change on what it holds now.`,
  )
}

export async function recurringScheduleUpdate(
  ctx: RecurringCtx,
  raw: ScheduleUpdateInput,
): Promise<
  | {
      status: "completed"
      id: string
      version: number
      issueMode: string
      scheduleStatus: string
      nextIssueOn: string | null
      warning?: string
      message: string
    }
  | Fail
> {
  const input = withCoercedLines(raw)
  const refused = await checkScheduleUpdate(ctx, input)
  if (refused) return refused
  const current = (await load(ctx, input.id)) as ScheduleRow
  const issuer = await issuerOf(ctx, current.issuer_profile_id)
  const now = await today(ctx, issuer)
  if (!now.ok) return now.error

  const {
    id: _id,
    status: wanted,
    expected_version: _expected,
    billsOtherThanStripe,
    ...patch
  } = input
  const next = merged(current, patch)
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) data[k] = v
  const statement = billsOtherOf(billsOtherThanStripe)
  if (statement) {
    data.bills_other_than_stripe = statement
    data.bills_other_by = ctx.approval?.approvalDeciderId ?? (await ctx.getUserId())
  }
  if (patch.lines)
    data.lines = patch.lines.map((l) => ({ ...l, line_kind: l.line_kind ?? "service" }))
  // A schedule made a retainer during a month keeps that month on the run: the retainer bills
  // from the next month. Ending the retainer (no included hours) clears it.
  const becomes = merged(current, patch)
  if (isRetainerSchedule(becomes) && !isRetainerSchedule(current))
    data.retainer_from = nextMonth(monthOf(now.date))
  else if (!isRetainerSchedule(becomes) && isRetainerSchedule(current)) data.retainer_from = null
  // New terms apply from the next month. When a signed renewal already governs that month, they
  // are written into the renewal's terms: the later act wins from its first month, so the daily
  // roll and the month's invoice read the change instead of the earlier renewal. A renewal that
  // starts after the next month is kept and applies from its own start; the months before it take
  // the schedule's own terms.
  const renewal = renewalOf(current)
  if (renewal && isRetainerSchedule(becomes) && renewal.from <= nextMonth(monthOf(now.date))) {
    const terms = ["retainer_minutes", "retainer_overage_rate_minor", "lines"] as const
    if (terms.some((k) => data[k] !== undefined)) {
      const renewed: RetainerRenewal = { ...renewal }
      if (data.retainer_minutes !== undefined)
        renewed.retainer_minutes = Number(data.retainer_minutes)
      if (data.retainer_overage_rate_minor !== undefined)
        renewed.retainer_overage_rate_minor =
          data.retainer_overage_rate_minor === null
            ? null
            : String(data.retainer_overage_rate_minor)
      if (data.lines !== undefined) renewed.lines = data.lines as unknown[]
      for (const k of terms) delete data[k]
      data.retainer_renewal = renewed
    }
  }

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
  } else if (
    current.status === "active" &&
    (patch.billing_day !== undefined || patch.repeats !== undefined)
  ) {
    Object.assign(data, datesFrom(next, now.date))
  }
  data.status = status
  data.version = current.version + 1
  await ctx.db.update(ENTITY, current.id, data)
  await announceScheduleChange(ctx, current.id, current.version + 1)
  // A retainer's terms changed mid-month apply from the next month: this month keeps its
  // timebox. Ending it removes its months to come (the derived rows are the signal projects reads).
  let retainerNote = ""
  const after = merged(current, patch)
  if (isRetainerSchedule(after) || isRetainerSchedule(current)) {
    const nextM = nextMonth(monthOf(now.date))
    const target = {
      id: current.id,
      retainer_project_id: after.retainer_project_id ?? current.retainer_project_id ?? null,
    }
    if (status === "ended" || !isRetainerSchedule(after)) {
      await writeRetainerTimeboxes(ctx, target, [nextM], null)
      retainerNote = ` Its months after this one are taken off the project.`
    } else if (
      patch.retainer_minutes !== undefined ||
      patch.retainer_project_id !== undefined ||
      wanted === "active"
    ) {
      const wrote = await writeRetainerTimeboxes(
        ctx,
        target,
        [nextM],
        Number(
          termsForMonth({ ...current, ...data } as Record<string, unknown>, nextM).retainer_minutes,
        ),
      )
      retainerNote =
        wrote.length > 0
          ? ` New retainer terms apply from ${nextM}; this month keeps what it had.`
          : ` New retainer terms apply from ${nextM}; the project's timebox for it is added by the daily roll.`
    }
    if (status !== "ended" && isRetainerSchedule(after) && after.covers === "period_ahead")
      retainerNote += ` ${PREPAID_WARNING}`
  }
  // Ending reaches the month-end run already drafted as a pause does: its rows not issued yet are
  // left out, so approving the run issues nothing more for it. A row billing a period whose work
  // was already delivered (billsDeliveredPeriod) stays in the run: ending stops what comes next.
  const ending =
    status === "ended"
      ? await leaveOutOpenRows(ctx, current.id, SCHEDULE_ENDED, {
          keep: (item) =>
            billsDeliveredPeriod(current as unknown as Record<string, unknown>, item, now.date),
        })
      : { leftOut: 0, kept: 0 }
  const leftOut = ending.leftOut
  const issueMode = String(data.issue_mode ?? current.issue_mode)
  const nextIssueOn =
    (data.next_issue_on as string | null | undefined) ??
    (status === "ended" ? null : (current.next_issue_on ?? null))
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
        ? "It has ended and bills nothing more." +
          (ending.kept > 0
            ? ` Its row in the open month-end run bills a period already under way, so it stays in the run and issues with it; take it out with drafts_discard if it should not.`
            : "") +
          (leftOut > 0
            ? ` Its row in the open month-end run is left out (note "${SCHEDULE_ENDED}"), so approving the run does not issue it; drafts_update with put_back puts it back, and it then issues with the run.`
            : "")
        : `Its next invoice issues on ${nextIssueOn ?? "no date"}; drafts already made keep their amounts.`) +
      retainerNote,
    ...(status !== "ended" && isRetainerSchedule(after) && after.covers === "period_ahead"
      ? { warning: PREPAID_WARNING }
      : {}),
  }
}

// retainer_terms_renew

export interface RetainerTermsRenewInput {
  projectId: string
  agreementId: string
  agreementNumber: string
  /** The renewal's first day (`YYYY-MM-DD`): its terms apply from that month, at the earliest the next. */
  startsOn: string
  /** Included minutes a month. */
  minutes: number
  /** The monthly fee excl. VAT, in minor units, as a decimal string. */
  feeMinor: string | number
  /** The hourly rate above the included hours, in minor units; the schedule's own when absent. */
  overageRateMinor?: string | number | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MINOR = /^\d{1,15}$/

/** The old fee line with its new price; an hours figure in its wording follows the new hours. */
function renewedLine(
  line: ScheduleLineInput,
  feeMinor: number,
  minutes: number,
): ScheduleLineInput {
  const hours = Math.round((minutes / 60) * 100) / 100
  const description = String(line.description).replace(
    /\b\d+(?:[.,]\d+)?(\s*(?:h|hours?|heures?)\b)/i,
    `${hours}$1`,
  )
  return { ...line, description, qty: 1, unit_price_minor: feeMinor }
}

/**
 * A retainer renewed by a signed agreement (agreements' call, as the person who approved its
 * send): the new included hours, fee and overage rate are kept on the project's retainer schedule
 * as its renewal, which every month from the renewal's first one is billed on (`termsForMonth`);
 * the months before keep the schedule's own terms, so no month is billed twice or on two sets of
 * terms. The first renewed month's timebox is written now when it is the next month; later ones
 * come with the daily roll. The same agreement again changes nothing.
 */
export async function retainerTermsRenew(ctx: RecurringCtx, input: RetainerTermsRenewInput) {
  const fee = String(input.feeMinor ?? "")
  const rate =
    input.overageRateMinor === undefined || input.overageRateMinor === null
      ? null
      : String(input.overageRateMinor)
  if (
    !UUID.test(String(input.projectId)) ||
    !UUID.test(String(input.agreementId)) ||
    !DAY.test(String(input.startsOn)) ||
    !(Number.isInteger(input.minutes) && input.minutes > 0) ||
    !MINOR.test(fee) ||
    Number(fee) <= 0 ||
    (rate !== null && !MINOR.test(rate))
  )
    return fail(
      "invalid_input",
      "A renewal takes the project, the agreement, its first day (YYYY-MM-DD), the included minutes a month above zero and the monthly fee in minor units. Nothing was changed.",
    )
  const refused = await retainerScopeRefusal(ctx, { retainer_minutes: input.minutes })
  if (refused) return refused
  const rows = (
    (await ctx.db.findMany(ENTITY, {
      where: { retainer_project_id: input.projectId },
      limit: 20,
    })) as unknown[]
  )
    .map(normalize)
    .filter((r) => r.status !== "ended" && isRetainerSchedule(r))
  const current = rows[0]
  if (!current || rows.length > 1)
    return fail(
      "no_retainer_schedule",
      current
        ? `Project ${input.projectId} has ${rows.length} retainer schedules, so ${input.agreementNumber} renewed none of them. Nothing was changed; set the new terms on the right schedule with recurring_schedule_update.`
        : `Project ${input.projectId} has no retainer schedule, so ${input.agreementNumber} has no retainer to renew. Nothing was changed.`,
    )
  const issuer = await issuerOf(ctx, current.issuer_profile_id)
  const now = await today(ctx, issuer)
  if (!now.ok) return now.error
  const next = nextMonth(monthOf(now.date))
  const asked = monthOf(input.startsOn)
  const from = asked > next ? asked : next
  const pending = renewalOf(current)
  if (pending?.agreement_id === input.agreementId)
    return {
      status: "completed" as const,
      scheduleId: current.id,
      from: pending.from,
      unchanged: true,
      message: `${input.agreementNumber} already renewed retainer schedule ${current.id} from ${pending.from}. Nothing changed.`,
    }

  // A renewal already in force is the schedule's own terms now: the new one follows it.
  const data: Record<string, unknown> = {}
  let base: ScheduleRow = current
  if (pending && pending.from <= monthOf(now.date)) {
    base = {
      ...current,
      lines: (pending.lines as ScheduleLineInput[]) ?? current.lines,
      retainer_minutes: pending.retainer_minutes,
      retainer_overage_rate_minor:
        pending.retainer_overage_rate_minor ?? current.retainer_overage_rate_minor ?? null,
    }
    data.lines = base.lines
    data.retainer_minutes = base.retainer_minutes
    data.retainer_overage_rate_minor = base.retainer_overage_rate_minor
  }
  if (base.lines.length !== 1)
    return fail(
      "fee_lines_ambiguous",
      `Retainer schedule ${current.id} bills ${base.lines.length} fee lines, so ${input.agreementNumber}'s fee cannot replace one of them. Nothing was changed; set the new terms with recurring_schedule_update.`,
    )
  const line = renewedLine(base.lines[0] as ScheduleLineInput, Number(fee), input.minutes)
  const renewal: RetainerRenewal = {
    from,
    agreement_id: input.agreementId,
    agreement_number: input.agreementNumber,
    retainer_minutes: input.minutes,
    retainer_overage_rate_minor: rate ?? String(base.retainer_overage_rate_minor ?? 0),
    lines: [line],
  }
  data.retainer_renewal = renewal
  data.version = current.version + 1
  await ctx.db.update(ENTITY, current.id, data)
  await announceScheduleChange(ctx, current.id, current.version + 1)
  const wrote =
    from === next
      ? await writeRetainerTimeboxes(
          ctx,
          { id: current.id, retainer_project_id: current.retainer_project_id ?? null },
          [from],
          input.minutes,
        )
      : []
  const currency = String((issuer as { default_currency?: string }).default_currency ?? "EUR")
  const oldFee = Number((base.lines[0] as ScheduleLineInput).unit_price_minor)
  return {
    status: "completed" as const,
    scheduleId: current.id,
    from,
    version: current.version + 1,
    message:
      `${input.agreementNumber} renewed retainer schedule ${current.id}: from ${from}, ${hoursText(input.minutes)} included and ${formatMoneyMinor(fee, currency)} a month` +
      `${rate !== null ? `, ${formatMoneyMinor(rate, currency)} an hour above them` : ""}. ` +
      `The months before keep ${hoursText(Number(base.retainer_minutes))} and ${formatMoneyMinor(oldFee, currency)}. ` +
      (wrote.length > 0
        ? `The project's ${from} timebox is ${hoursText(input.minutes)}.`
        : `The project's timebox for ${from} is written by the daily roll.`),
  }
}

export async function recurringSchedulePause(
  ctx: RecurringCtx,
  input: { id: string; until?: string | null },
  checkOnly = false,
): Promise<
  | {
      status: "completed"
      id: string
      scheduleStatus: "paused"
      until: string | null
      unchanged?: true
      message: string
    }
  | Fail
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
    return fail(
      "schedule_not_started",
      `Schedule ${current.id} is a draft and bills nothing yet, so there is nothing to pause.`,
    )
  }
  if (input.until) {
    const issuer = await issuerOf(ctx, current.issuer_profile_id)
    const now = await today(ctx, issuer)
    if (!now.ok) return now.error
    if (!isCivilDate(input.until) || input.until <= now.date) {
      return fail(
        "invalid_until",
        `until must be a date after today (${now.date}), written YYYY-MM-DD. Nothing was paused.`,
      )
    }
  }
  if (checkOnly) {
    return {
      status: "completed",
      id: current.id,
      scheduleStatus: "paused",
      until: input.until ?? null,
      message: "Checked; nothing was written.",
    }
  }
  await ctx.db.update(ENTITY, current.id, {
    status: "paused",
    paused_until: input.until ?? null,
    version: current.version + 1,
  })
  await announceScheduleChange(ctx, current.id, current.version + 1)
  // A paused retainer takes its months to come off the project; resuming writes them again.
  if (isRetainerSchedule(current) && !checkOnly) {
    const issuer = await issuerOf(ctx, current.issuer_profile_id)
    const now = await today(ctx, issuer)
    if (now?.ok) await writeRetainerTimeboxes(ctx, current, [nextMonth(monthOf(now.date))], null)
  }
  const { leftOut } = await leaveOutOpenRows(ctx, current.id, SCHEDULE_PAUSED)
  const runNote =
    leftOut > 0
      ? ` Its row in the open month-end run is left out (note "${SCHEDULE_PAUSED}"), so approving the run does not issue it; resuming does not put it back (drafts_update with put_back does, and the row then issues with the run even while the schedule is paused).`
      : ""
  return {
    status: "completed",
    id: current.id,
    scheduleStatus: "paused",
    until: input.until ?? null,
    message:
      (input.until
        ? `Schedule ${current.id} is paused until ${input.until}. No draft is made while it is paused, and the days inside the pause are not billed afterwards.`
        : `Schedule ${current.id} is paused and bills nothing until someone resumes it with recurring_schedule_update status active.`) +
      runNote,
  }
}

/** Row states of a month-end run that can still become an invoice. */
const OPEN_ROW_STATES = new Set(["ready", "needs_fix", "approved", "waiting_reapproval"])

/**
 * A pause or an end reaches the month-end run already drafted: the schedule's rows that are not
 * issued yet are left out with `note` (their drafts kept, so a person can put one back), and each
 * run's card follows. A row `keep` answers true for stays in the run. Returns how many rows were
 * left out and how many kept.
 */
async function leaveOutOpenRows(
  ctx: RecurringCtx,
  scheduleId: string,
  note: string,
  opts: { keep?: (item: Record<string, unknown>) => boolean } = {},
): Promise<{ leftOut: number; kept: number }> {
  const items = (await ctx.db.findMany("recurring_run_items", {
    where: { schedule_id: scheduleId },
    limit: 500,
  })) as Array<Record<string, unknown>>
  const runs = new Set<string>()
  let leftOut = 0
  let kept = 0
  for (const item of items) {
    if (!OPEN_ROW_STATES.has(String(item.state))) continue
    const draft = (await ctx.db.findOne("documents", String(item.document_id))) as Record<
      string,
      unknown
    > | null
    if (draft && draft.status !== "draft") continue
    if (opts.keep?.(item)) {
      kept += 1
      continue
    }
    // A new pause or end is a new decision: a row put back after an earlier one is taken out too.
    const notes = (typeof item.note === "string" && item.note ? item.note.split(" · ") : []).filter(
      (n) => n !== KEPT_AFTER_STOP,
    )
    if (!notes.includes(note)) notes.push(note)
    await ctx.db.update("recurring_run_items", String(item.id), {
      state: "left_out",
      approved_hash: null,
      send_grant: null,
      note: notes.join(" · "),
    })
    if (draft) {
      await logRunEdit(ctx as EditCtx, String(draft.id), {
        kind: "take_out",
        fields: [{ field: "state", from: item.state, to: "left_out" }],
        applies: "this_month",
      })
    }
    runs.add(String(item.run_id))
    leftOut += 1
  }
  // The card waiting on each run drops the row; without the approval surface (a bare ctx) the
  // run's next job restages it.
  if ("requestApproval" in ctx && typeof (ctx as Partial<EditCtx>).requestApproval === "function") {
    for (const runId of runs) await stageRunCardAfterRemoval(ctx as EditCtx, runId)
  }
  return { leftOut, kept }
}

/**
 * The schedules that get a draft on `today`. A paused schedule whose `until` has come is resumed
 * first, from today: every billing day inside the pause is skipped, so nothing is back-billed.
 */
export async function draftCandidates(
  ctx: RecurringCtx,
  todayDate: string,
): Promise<ScheduleRow[]> {
  const paused = (
    (await ctx.db.findMany(ENTITY, { where: { status: "paused" } })) as unknown[]
  ).map(normalize)
  for (const s of paused) {
    if (!s.paused_until || s.paused_until > todayDate) continue
    await ctx.db.update(ENTITY, s.id, {
      status: "active",
      paused_until: null,
      version: s.version + 1,
      ...resumeOn(s, todayDate),
    })
  }
  const active = (
    (await ctx.db.findMany(ENTITY, { where: { status: "active" } })) as unknown[]
  ).map(normalize)
  return active.filter((s) => isDueForDraft(s, todayDate))
}

export async function recurringList(
  ctx: RecurringCtx,
  input: { status?: string; company_id?: string; limit?: number; cursor?: string },
): Promise<{ rows: ScheduleRow[]; nextCursor: string | null; nextRun: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200)
  const offset = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0
  const companyId = input.company_id?.trim()
  // A malformed company id matches nothing rather than failing the read on the uuid column.
  if (companyId && !UUID.test(companyId)) return { rows: [], nextCursor: null, nextRun: null }
  const found = (await ctx.db.findMany(ENTITY, {
    where: {
      ...(input.status ? { status: input.status } : {}),
      ...(companyId ? { company_id: companyId } : {}),
    },
    orderBy: { next_issue_on: "asc" },
    limit: limit + 1,
    offset,
  })) as unknown[]
  // The free-text `notes` stay out of the list: a row names its schedule, dates and amounts only.
  const rows = found.slice(0, limit).map((r) => {
    const { notes: _notes, ...row } = normalize(r)
    return row as ScheduleRow
  })
  const first = (await ctx.db.findMany(ENTITY, {
    where: { status: "active" },
    orderBy: { next_issue_on: "asc" },
    limit: 1,
  })) as unknown[]
  return {
    rows,
    nextCursor: found.length > limit ? String(offset + limit) : null,
    nextRun: first[0] ? (normalize(first[0]).next_issue_on ?? null) : null,
  }
}
