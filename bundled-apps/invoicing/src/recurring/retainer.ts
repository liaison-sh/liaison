// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Retainers: a recurring schedule with a monthly timebox of included hours and an overage rate.
// A retainer month is never drafted by the month-end run: a person reconciles the month on its
// planned vs done card and presses Create invoice there, and that one draft carries the fee and
// any overage. This file holds the one predicate every drafting path asks, and the month's
// arithmetic (pure: minutes and minor units in, lines out).

/** The fields that make a schedule a retainer. */
export interface RetainerFacts {
  retainer_project_id?: unknown
  retainer_minutes?: unknown
}

/**
 * A schedule with included minutes is a retainer, or was one (it may be off since, and its earlier
 * months are still its own). Whether a month is one: `isRetainerMonth`; whether it is on:
 * `isRetainerOn`.
 */
export function isRetainerSchedule(s: RetainerFacts | null | undefined): boolean {
  if (!s) return false
  const minutes = Number(s.retainer_minutes)
  return s.retainer_minutes !== null && s.retainer_minutes !== undefined && minutes > 0
}

/**
 * True when the schedule's month `YYYY-MM` is a retainer month: the schedule is a retainer, the
 * month is on or after the one it became a retainer from (a schedule made a retainer during a
 * month keeps that month on the month-end run), and the retainer was not off that month.
 */
export function isRetainerMonth(
  s: (RetainerFacts & DatedTermsRow & { retainer_from?: unknown }) | null | undefined,
  month: string,
): boolean {
  if (!isRetainerSchedule(s)) return false
  const from = typeof s?.retainer_from === "string" ? s.retainer_from : null
  return (from === null || month >= from) && termsInForce(s, month)?.off !== true
}

/** A retainer that was not turned off: its months to come are retainer months. */
export function isRetainerOn(s: (RetainerFacts & DatedTermsRow) | null | undefined): boolean {
  return isRetainerSchedule(s) && retainerTermsOf(s).at(-1)?.off !== true
}

/** The month the month-end run bills a turned-off retainer from, or null when it is on. */
export function retainerOffFrom(
  s: (RetainerFacts & DatedTermsRow) | null | undefined,
): string | null {
  if (!isRetainerSchedule(s)) return null
  const entries = retainerTermsOf(s)
  let from: string | null = null
  for (let i = entries.length - 1; i >= 0 && entries[i]?.off; i--) from = entries[i]?.from ?? from
  return from
}

/** The last month a turned-off retainer is billed from its card; null when it has none, or is on. */
export function lastRetainerMonth(
  s: (RetainerFacts & DatedTermsRow & { retainer_from?: unknown }) | null | undefined,
): string | null {
  const off = retainerOffFrom(s)
  if (off === null) return null
  const last = previousMonth(off)
  return isRetainerMonth(s, last) ? last : null
}

/** The key a retainer month's draft carries: one draft per schedule and month. */
export function retainerDocumentRef(scheduleId: string, month: string): string {
  return `retainer:${scheduleId}:${month}`
}

/** The key the month-end run gives the same schedule's month: a month billed by one or the other. */
export function runDocumentRef(scheduleId: string, month: string): string {
  return `recurring:${scheduleId}:${month}`
}

/** `2026-10` for any day of October 2026. */
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** The month before `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
}

/** The month after `YYYY-MM`. */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
}

export type Rollover = "none" | "next"

/**
 * The hours a month passes to the next: its own included hours it did not use, at most the
 * month's timebox. Hours rolled in are not passed on again, so they never reach the month after.
 */
export function rolloverOut(rollover: Rollover, includedMinutes: number, usedMinutes: number) {
  if (rollover !== "next") return 0
  return Math.min(includedMinutes, Math.max(0, includedMinutes - Math.max(0, usedMinutes)))
}

export interface RetainerMonthInput {
  includedMinutes: number
  /** What the card bills for the month: its billed total. */
  usedMinutes: number
  /** Hours rolled in from the month before, counted before any overage. */
  rolloverInMinutes: number
  waived: boolean
}

export interface RetainerMonth {
  includedMinutes: number
  usedMinutes: number
  rolloverInMinutes: number
  /** Hours above the included and rolled-in hours; 0 under the timebox or when waived. */
  overageMinutes: number
  /** What the overage would have been, kept when it is waived. */
  waivedMinutes: number
}

/** overage = max(0, used - included - rolled in), or nothing when the month's overage is waived. */
export function retainerMonth(input: RetainerMonthInput): RetainerMonth {
  const included = Math.max(0, Math.round(input.includedMinutes))
  const used = Math.max(0, Math.round(input.usedMinutes))
  const rolledIn = Math.min(included, Math.max(0, Math.round(input.rolloverInMinutes)))
  const over = Math.max(0, used - included - rolledIn)
  return {
    includedMinutes: included,
    usedMinutes: used,
    rolloverInMinutes: rolledIn,
    overageMinutes: input.waived ? 0 : over,
    waivedMinutes: input.waived ? over : 0,
  }
}

/** The figures a retainer draft keeps in its `external_refs`, read again by the next month. */
export interface RetainerRefs {
  schedule_id: string
  month: string
  included_minutes: number
  used_minutes: number
  rollover_in_minutes: number
  overage_minutes: number
  waived_minutes: number
  /** Hours of earlier months worked after their invoices, billed here with the part above them. */
  late?: Array<{ month: string; minutes: number; overage_minutes: number }>
}

/** The retainer figures of a document, when it is a retainer month's. */
export function retainerRefsOf(doc: { external_refs?: unknown } | null): RetainerRefs | null {
  if (!doc) return null
  let refs = doc.external_refs as unknown
  if (typeof refs === "string") {
    try {
      refs = JSON.parse(refs)
    } catch {
      return null
    }
  }
  const r = (refs as { retainer?: RetainerRefs } | null)?.retainer
  return r && typeof r.month === "string" ? r : null
}

/** "6 h", "6 h 30": minutes as the draft's lines and messages say them. */
export function hoursText(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`
}

/** The warning a prepaid retainer carries: billed before the month, settled after it. */
export const PREPAID_WARNING =
  "Prepaid: each month's fee is invoiced ahead as an advance, and the month-end invoice deducts it and adds any overage, so it can total zero; check this way of billing with your accountant."

/**
 * A schedule's terms from a month on, as one entry of its dated terms (`retainer_terms`): a change
 * of terms or a signed renewal adds one. The schedule's own columns are the terms of the months
 * before the first entry.
 */
export interface RetainerTerms {
  /** The first month (`YYYY-MM`) these terms apply to. */
  from: string
  retainer_minutes: number
  /** The schedule's own rate when null. */
  retainer_overage_rate_minor: string | null
  retainer_rollover?: Rollover
  /** The schedule's own lines when empty. */
  lines: unknown[]
  /** The signed renewal that set these terms, when one did. */
  agreement_id?: string
  agreement_number?: string
  /** The retainer is off from this month: the month-end run bills `lines`. */
  off?: boolean
  /** With `off`: whether the retainer's months before it were prepaid (`covers`). */
  covers?: string
  /** With `off`: the signed terms of months from it on, for a retainer taken up again. */
  dropped?: RetainerTerms[]
  /** With an agreement: a person's terms that keep the lines it signed. */
  carried?: boolean
}

export interface DatedTermsRow {
  retainer_terms?: unknown
  /** One signed renewal, as rows written before the dated terms hold it: read, never written. */
  retainer_renewal?: unknown
}

function parsed(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** The schedule's dated terms, earliest first. Of two entries for a month, the last one counts. */
export function retainerTermsOf(s: DatedTermsRow | null | undefined): RetainerTerms[] {
  const list = parsed(s?.retainer_terms)
  return [parsed(s?.retainer_renewal), ...(Array.isArray(list) ? list : [])]
    .filter((t): t is RetainerTerms => {
      const v = t as Partial<RetainerTerms> | null
      return !!v && typeof v.from === "string" && (v.off === true || Number(v.retainer_minutes) > 0)
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

/** The dated terms that apply to a month; null before the first of them. */
export function termsInForce(
  s: DatedTermsRow | null | undefined,
  month: string,
): RetainerTerms | null {
  return (
    retainerTermsOf(s)
      .filter((t) => t.from <= month)
      .at(-1) ?? null
  )
}

/**
 * The first month from `month` on that is the retainer's: a change of its terms applies from it. A
 * month the run holds between two times as a retainer, or before its first month, is not one.
 */
export function firstRetainerMonth(
  s: RetainerFacts & DatedTermsRow & { retainer_from?: unknown },
  month: string,
): string {
  const start = typeof s.retainer_from === "string" ? s.retainer_from : month
  const first = start > month ? start : month
  if (termsInForce(s, first)?.off !== true) return first
  return retainerTermsOf(s).find((t) => t.from > first && !t.off)?.from ?? first
}

/** The fields a month's terms hold. */
export const TERM_FIELDS = [
  "retainer_minutes",
  "retainer_overage_rate_minor",
  "retainer_rollover",
  "lines",
] as const

/**
 * The schedule as it bills `month` (`YYYY-MM`): its hours, overage rate, rollover and fee lines as
 * the dated terms in force that month say, its own before the first of them. A month the retainer
 * is off is a plain schedule's. Every reader of a month's terms asks this.
 */
export function termsForMonth<T extends object>(s: T, month: string): T {
  const own = s as T & Record<string, unknown>
  const t = termsInForce(own as DatedTermsRow, month)
  if (!t) return s
  if (t.off)
    return {
      ...own,
      retainer_project_id: null,
      retainer_minutes: null,
      retainer_overage_rate_minor: null,
      retainer_rollover: "none",
      lines: Array.isArray(t.lines) && t.lines.length > 0 ? t.lines : own.lines,
    }
  return {
    ...own,
    retainer_minutes: t.retainer_minutes,
    retainer_overage_rate_minor: t.retainer_overage_rate_minor ?? own.retainer_overage_rate_minor,
    ...(t.retainer_rollover ? { retainer_rollover: t.retainer_rollover } : {}),
    lines: Array.isArray(t.lines) && t.lines.length > 0 ? t.lines : own.lines,
  }
}

/** One canonical string per month's terms, so two months compare by value. */
export function termsSignature(s: object): string {
  const t = s as Record<string, unknown>
  return JSON.stringify([
    Number(t.retainer_minutes ?? 0),
    String(t.retainer_overage_rate_minor ?? 0),
    t.retainer_rollover === "next" ? "next" : "none",
    linesSignature(t.lines),
  ])
}

/** One canonical string per set of lines, so two sets compare by value. */
export function linesSignature(raw: unknown): string {
  const lines = parsed(raw)
  return JSON.stringify(
    (Array.isArray(lines) ? (lines as Array<Record<string, unknown>>) : []).map((l) => [
      String(l.description ?? ""),
      Number(l.qty),
      Number(l.unit_price_minor),
      Number(l.vat_bp),
      l.product_ref ?? null,
      l.line_kind ?? "service",
    ]),
  )
}

/**
 * The columns that make `after` the schedule's terms from month `from` on, leaving every earlier
 * month as it was. Later entries (a renewal that starts later) keep their own first month; a
 * rollover set here goes on into them, since no agreement sets one. An entry of a renewal that
 * starts the same month keeps naming its agreement, and so do terms that keep the lines of the
 * signed ones they follow (`signed`, the terms in force that month unless given).
 */
export function withTermsFrom(
  s: DatedTermsRow,
  from: string,
  after: object,
  signed: RetainerTerms | null = termsInForce(s, from),
): { retainer_terms: RetainerTerms[]; retainer_renewal: null } {
  const a = after as Record<string, unknown>
  const entries = retainerTermsOf(s)
  const same = entries.filter((t) => t.from === from).at(-1)
  const rollover: Rollover = a.retainer_rollover === "next" ? "next" : "none"
  const keeps =
    !same?.agreement_id &&
    signed?.agreement_id &&
    linesSignature(signed.lines) === linesSignature(a.lines)
  return {
    retainer_terms: [
      ...entries.filter((t) => t.from < from),
      {
        from,
        retainer_minutes: Number(a.retainer_minutes),
        retainer_overage_rate_minor: String(a.retainer_overage_rate_minor ?? 0),
        retainer_rollover: rollover,
        lines: (parsed(a.lines) as unknown[]) ?? [],
        ...(same?.agreement_id
          ? {
              agreement_id: same.agreement_id,
              agreement_number: same.agreement_number,
              ...(same.carried ? { carried: true } : {}),
            }
          : keeps
            ? {
                agreement_id: signed.agreement_id,
                agreement_number: signed.agreement_number,
                carried: true,
              }
            : {}),
      },
      ...entries
        .filter((t) => t.from > from)
        .map((t) => (t.off ? t : { ...t, retainer_rollover: rollover })),
    ],
    retainer_renewal: null,
  }
}

/** A month the retainer is off, as one entry: the run bills `lines` from it on. */
function offTerms(
  from: string,
  lines: unknown,
  covers: unknown,
  dropped: RetainerTerms[],
): RetainerTerms {
  return {
    from,
    off: true,
    retainer_minutes: 0,
    retainer_overage_rate_minor: null,
    lines: (parsed(lines) as unknown[]) ?? [],
    covers: covers === "period_ahead" ? "period_ahead" : "period_ended",
    ...(dropped.length > 0 ? { dropped } : {}),
  }
}

/** The signed terms these entries hold, those an earlier turn-off dropped included. */
function signedTerms(entries: RetainerTerms[]): RetainerTerms[] {
  return entries.flatMap((t) =>
    t.off ? (t.dropped ?? []) : t.agreement_id && !t.carried ? [t] : [],
  )
}

/** The signed terms a turn-off still in force dropped, earliest first. */
export function droppedTermsOf(s: RetainerFacts & DatedTermsRow): RetainerTerms[] {
  const off = retainerOffFrom(s)
  if (off === null) return []
  return signedTerms(retainerTermsOf(s).filter((t) => t.off && t.from >= off)).sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  )
}

type DatedTerms = { retainer_terms: RetainerTerms[]; retainer_renewal: null }

/** The columns that turn the retainer off from month `from`: the months before keep their terms. */
export function withRetainerOff(
  s: DatedTermsRow & { covers?: unknown },
  from: string,
  lines: unknown,
): DatedTerms {
  const entries = retainerTermsOf(s)
  return {
    retainer_terms: [
      ...entries.filter((t) => t.from < from),
      offTerms(from, lines, s.covers, signedTerms(entries.filter((t) => t.from >= from))),
    ],
    retainer_renewal: null,
  }
}

/** The columns that change what the run bills from month `from`, on a retainer that is off then. */
export function withOffLinesFrom(s: DatedTermsRow, from: string, lines: unknown): DatedTerms {
  const entries = retainerTermsOf(s)
  return {
    retainer_terms: [
      ...entries.filter((t) => t.from < from),
      offTerms(
        from,
        lines,
        termsInForce(s, from)?.covers,
        signedTerms(entries.filter((t) => t.from === from)),
      ),
      ...entries.filter((t) => t.from > from),
    ],
    retainer_renewal: null,
  }
}

/**
 * The columns that change a turned-off retainer's lines at once, as a plain schedule's change: every
 * run month from `thisMonth` on bills them, and no retainer month moves.
 */
export function withPlainLines(
  s: RetainerFacts & DatedTermsRow & { retainer_from?: unknown; lines?: unknown },
  thisMonth: string,
  lines: unknown,
): DatedTerms & { lines?: unknown } {
  const entries = retainerTermsOf(s)
  const off = retainerOffFrom(s) ?? thisMonth
  const from = off > thisMonth ? off : thisMonth
  const dated = [
    ...entries.filter((t) => t.from < from),
    offTerms(
      from,
      lines,
      termsInForce(s, off)?.covers,
      signedTerms(entries.filter((t) => t.from >= from)),
    ),
  ]
  // A month still on the run before the retainer began: the schedule's own lines are its own.
  const own = termsInForce(s, thisMonth) === null && !isRetainerMonth(s, thisMonth)
  const start = typeof s.retainer_from === "string" ? s.retainer_from : null
  if (!own || start === null) return { retainer_terms: dated, retainer_renewal: null }
  return {
    retainer_terms: [
      // The retainer's first months kept the schedule's lines until now: they keep them.
      ...(start < from && !entries.some((t) => t.from <= start)
        ? withTermsFrom({}, start, s).retainer_terms
        : []),
      ...dated,
    ],
    retainer_renewal: null,
    lines,
  }
}

/** Whether a month's fee was invoiced ahead: as its retainer was billed then, when it is off since. */
export function isPrepaidMonth(s: DatedTermsRow & { covers?: unknown }, month: string): boolean {
  const off = retainerTermsOf(s).find((t) => t.off && t.from > month)
  return (off?.covers ?? s.covers) === "period_ahead"
}

/** A signed renewal a schedule took, whether or not its terms are still in force. */
export interface AppliedRenewal {
  agreement_id: string
  agreement_number: string
  from: string
}

/** Every signed renewal the schedule ever took: the ones replaced since are kept in their own list. */
export function appliedRenewalsOf(
  s: (DatedTermsRow & { retainer_agreements?: unknown }) | null | undefined,
): AppliedRenewal[] {
  const list = parsed(s?.retainer_agreements)
  const out = new Map<string, AppliedRenewal>()
  for (const a of [...(Array.isArray(list) ? list : []), ...retainerTermsOf(s)]) {
    const v = a as Partial<AppliedRenewal> | null
    if (!v || typeof v.agreement_id !== "string" || out.has(v.agreement_id)) continue
    out.set(v.agreement_id, {
      agreement_id: v.agreement_id,
      agreement_number: String(v.agreement_number ?? ""),
      from: String(v.from ?? ""),
    })
  }
  return [...out.values()]
}
