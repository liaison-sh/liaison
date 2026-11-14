// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client activity report that goes with an invoice made from a planned vs done card: the work
// delivered, its proof labels and the billed time, signed by the project lead. A pure builder over
// a typed input that has NO field for real time, a time-spent note, an estimate, a member or an
// unplanned line: what is not in the input cannot leak into the report, the invoice or a mail.

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
  /** The project lead's name, the report's signature. */
  lead: string | null
}

export interface ActivityReportContent {
  kind: "activity_report"
  project: { id: string; name: string }
  period: { from: string; to: string }
  lines: Array<{ wording: string; billed: string; unit: BilledUnit; proofLabels: string[] }>
  signedBy: string | null
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
    signedBy: input.lead ? clean(input.lead) : null,
  }
}

/** The report as plain text, one line per billed line, the way its PDF prints it. */
export function activityReportText(c: ActivityReportContent, lang: "fr" | "en" = "fr"): string {
  const unitWord = (u: BilledUnit, q: string) =>
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
  const qty = (q: string) => (lang === "fr" ? q.replace(".", ",") : q)
  const head =
    lang === "fr"
      ? `Rapport d'activité, ${c.project.name}, du ${c.period.from} au ${c.period.to}`
      : `Activity report, ${c.project.name}, ${c.period.from} to ${c.period.to}`
  const rows = c.lines.map((l) => {
    const proofs = l.proofLabels.length > 0 ? ` (${l.proofLabels.join(", ")})` : ""
    return `${l.wording}: ${qty(l.billed)} ${unitWord(l.unit, l.billed)}${proofs}`
  })
  const sign = c.signedBy ? [lang === "fr" ? `Signé : ${c.signedBy}` : `Signed: ${c.signedBy}`] : []
  return [head, ...rows, ...sign].join("\n")
}
