// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client activity report that goes with an invoice made from a planned vs done card: the work
// delivered, its proof labels and the billed time, signed by the issuing company. A pure builder
// over a typed input that has NO field for real time, a time-spent note, an estimate, a person or
// an unplanned line: what is not in the input cannot leak into the report, the invoice or a mail.

import { type BilledUnit, lineQuantity } from "./line-amount"

export interface ActivityReportLine {
  /** The line's wording as billed. */
  wording: string
  /** Billed minutes (the card's bill figure, never real time). */
  billedMinutes: number
  unit: BilledUnit
  /** The card's proof labels at Create (a merged pull request, a delivered file). */
  proofLabels: string[]
}

export interface ActivityReportInput {
  project: { id: string; name: string }
  /** The service period, YYYY-MM-DD both ends. */
  period: { from: string; to: string }
  hoursPerDayMinutes: number
  lines: ActivityReportLine[]
}

export interface ActivityReportContent {
  kind: "activity_report"
  project: { id: string; name: string }
  period: { from: string; to: string }
  lines: Array<{ wording: string; billed: string; unit: BilledUnit; proofLabels: string[] }>
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim()

/** The report's content, stored as `activity_reports.content` version 1 at Create. */
export function buildActivityReport(input: ActivityReportInput): ActivityReportContent {
  return {
    kind: "activity_report",
    project: { id: input.project.id, name: clean(input.project.name) },
    period: { from: input.period.from, to: input.period.to },
    lines: input.lines.map((l) => ({
      wording: clean(l.wording),
      billed: lineQuantity(l.billedMinutes, l.unit, input.hoursPerDayMinutes),
      unit: l.unit,
      proofLabels: l.proofLabels.map(clean).filter((p) => p !== ""),
    })),
  }
}

type Lang = "fr" | "en"

const unitWord = (lang: Lang, u: BilledUnit, q: string): string =>
  lang === "fr"
    ? u === "day"
      ? q === "1"
        ? "jour"
        : "jours"
      : q === "1"
        ? "heure"
        : "heures"
    : u === "day"
      ? q === "1"
        ? "day"
        : "days"
      : q === "1"
        ? "hour"
        : "hours"

const qtyOf = (lang: Lang, q: string): string => (lang === "fr" ? q.replace(".", ",") : q)

/** A YYYY-MM-DD day as the report prints it: 01/10/2026 in French, the date as stored otherwise. */
const dayOf = (lang: Lang, d: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return lang === "fr" && m ? `${m[3]}/${m[2]}/${m[1]}` : d
}

/** One billed line as the report prints it: the quantity in its unit, then the proof labels. */
function rowOf(lang: Lang, l: ActivityReportContent["lines"][number]) {
  return {
    wording: l.wording,
    billed: `${qtyOf(lang, l.billed)} ${unitWord(lang, l.unit, l.billed)}`,
    proofs: l.proofLabels.length > 0 ? l.proofLabels.join(", ") : null,
  }
}

/** The report as plain text, one line per billed line, the way its PDF prints it. */
export function activityReportText(c: ActivityReportContent, lang: Lang = "fr"): string {
  const head =
    lang === "fr"
      ? `Rapport d'activité, ${c.project.name}, du ${c.period.from} au ${c.period.to}`
      : `Activity report, ${c.project.name}, ${c.period.from} to ${c.period.to}`
  const rows = c.lines.map((l) => {
    const r = rowOf(lang, l)
    return `${r.wording}: ${r.billed}${r.proofs ? ` (${r.proofs})` : ""}`
  })
  return [head, ...rows].join("\n")
}

/** What the activity report's PDF template prints: strings only, built from the stored content. */
export interface ActivityReportPdfData {
  kind: "activity_report"
  title: string
  project: string
  period: string
  /** The invoice the report goes with, by its number once issued. */
  invoice: string | null
  issuer: string
  customer: string | null
  columns: { work: string; billed: string; proofs: string }
  rows: Array<{ wording: string; billed: string; proofs: string | null }>
  signature: string | null
}

/** The PDF template's input for a stored report (`activity_reports.content`), in the issuer's
 *  language. Only the content's own fields reach it: nothing else of the project is read. */
export function activityReportPdfData(
  c: ActivityReportContent,
  meta: {
    lang?: string | null
    issuer: string
    customer?: string | null
    invoiceNumber?: string | null
  },
): ActivityReportPdfData {
  // French for a French-speaking issuer, English for every other one: no issuer is put through
  // the French wording because the report has no translation in its language.
  const lang: Lang = meta.lang === "fr" ? "fr" : "en"
  const fr = lang === "fr"
  return {
    kind: "activity_report",
    title: fr ? "Rapport d'activité" : "Activity report",
    project: c.project.name,
    period: fr
      ? `Du ${dayOf(lang, c.period.from)} au ${dayOf(lang, c.period.to)}`
      : `${dayOf(lang, c.period.from)} to ${dayOf(lang, c.period.to)}`,
    invoice: meta.invoiceNumber
      ? fr
        ? `Annexe à la facture ${meta.invoiceNumber}`
        : `Annex to invoice ${meta.invoiceNumber}`
      : null,
    issuer: clean(meta.issuer),
    customer: meta.customer ? clean(meta.customer) : null,
    columns: fr
      ? { work: "Travail livré", billed: "Facturé", proofs: "Preuves" }
      : { work: "Work delivered", billed: "Billed", proofs: "Proof" },
    rows: c.lines.map((l) => rowOf(lang, l)),
    // Signed by the issuing company, never a person: a stored report's older `signedBy` is ignored.
    signature: clean(meta.issuer)
      ? fr
        ? `Signé : ${clean(meta.issuer)}`
        : `Signed: ${clean(meta.issuer)}`
      : null,
  }
}

/** A stored report's content read back as the builder wrote it, or null when it is not one. */
export function storedActivityReport(v: unknown): ActivityReportContent | null {
  let o: unknown = v
  if (typeof v === "string") {
    try {
      o = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!o || typeof o !== "object" || (o as { kind?: unknown }).kind !== "activity_report")
    return null
  const c = o as ActivityReportContent
  if (!Array.isArray(c.lines) || !c.project || !c.period) return null
  return c
}
