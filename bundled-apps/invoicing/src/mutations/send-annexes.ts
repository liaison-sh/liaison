// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The annexes an invoice goes out with: its current activity report (rendered to PDF here the
// first time the invoice is sent) and every file filed on it (a timesheet, a report filed by
// hand). One mail carries them all, so a retry of the send tries every one again. A report that
// cannot be made into a PDF blocks the send with a retry and never touches the issued invoice.

import { activityReportPdfData, storedActivityReport } from "../activity-report"
import type { MutationsCtx } from "./shared"

type Row = Record<string, unknown>

export interface SendAnnex {
  file_id: string
  kind: "activity_report" | "timesheet"
  partial: boolean
}

export type SendAnnexes =
  | { ok: true; annexes: SendAnnex[] }
  | { ok: false; error: { code: string; message: string; retryable: true } }

export const ACTIVITY_REPORT_TEMPLATE = "invoicing:activity_report_v1"

const rowsOf = async (ctx: MutationsCtx, table: string, documentId: string): Promise<Row[]> =>
  (await ctx.db.findMany(table, { where: { document_id: documentId }, limit: 200 })) as Row[]

/** The files to attach beside the invoice's own PDF, in the order the mail lists them. */
export async function sendAnnexes(
  ctx: MutationsCtx,
  doc: { id: string; number?: string | null; counterparty_name?: string | null },
  issuer: { legal_name?: string | null; default_language?: string | null } | null,
): Promise<SendAnnexes> {
  const reports = await rowsOf(ctx, "activity_reports", doc.id)
  const filed = await rowsOf(ctx, "document_attachments", doc.id)
  const label = doc.number ? `invoice ${doc.number}` : `draft ${doc.id}`
  // The files a report's renders were stored under: those rows are the report, not a filed annex.
  const reportFiles = new Set(
    reports.map((r) => r.file_id).filter((f): f is string => typeof f === "string" && f !== ""),
  )
  const annexes: SendAnnex[] = []
  const current = [...reports].sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0]
  if (current) {
    let fileId = typeof current.file_id === "string" && current.file_id ? current.file_id : null
    if (!fileId) {
      const content = storedActivityReport(current.content)
      const failed = (why: string): SendAnnexes => ({
        ok: false,
        error: {
          code: "activity_report_pdf_failed",
          message: `The activity report of ${label} could not be made into a PDF (${why}), so nothing was sent. The invoice stands as issued. Send it again to retry the report with it.`,
          retryable: true,
        },
      })
      if (!content) return failed("its content is not a report")
      let rendered: { file_id?: string } | { error: { message?: string } }
      try {
        rendered = (await ctx.pdf.render({
          template_kind: ACTIVITY_REPORT_TEMPLATE,
          ...(doc.number
            ? { filename: `activity-report-${doc.number}-v${Number(current.version ?? 1)}.pdf` }
            : {}),
          data: activityReportPdfData(content, {
            lang: issuer?.default_language ?? null,
            issuer: issuer?.legal_name ?? "",
            customer: doc.counterparty_name ?? null,
            invoiceNumber: doc.number ?? null,
          }),
          // The file is filed on the invoice as its report annex and the report row names it, both
          // committed with the file, so the mail app reads it in this same call.
          parent: {
            entityType: "document_attachment",
            commitRow: {
              values: { document_id: doc.id, kind: "activity_report", partial: false },
              fileIdColumn: "file_id",
            },
          },
          link: { table: "activity_reports", column: "file_id", row_id: String(current.id) },
        })) as typeof rendered
      } catch (err) {
        rendered = { error: { message: (err as { message?: string }).message } }
      }
      if ("error" in rendered || !rendered.file_id)
        return failed(("error" in rendered && rendered.error.message) || "the render failed")
      fileId = rendered.file_id
      reportFiles.add(fileId)
      await ctx.db.update("activity_reports", String(current.id), { file_id: fileId })
    }
    annexes.push({ file_id: fileId, kind: "activity_report", partial: false })
  }
  for (const a of filed) {
    const fileId = typeof a.file_id === "string" ? a.file_id : ""
    if (!fileId || reportFiles.has(fileId) || annexes.some((x) => x.file_id === fileId)) continue
    annexes.push({
      file_id: fileId,
      kind: a.kind === "timesheet" ? "timesheet" : "activity_report",
      partial: a.partial === true,
    })
  }
  return { ok: true, annexes }
}

/** An annex as the send's approval card lists it: its file name and where it came from. */
export interface AnnexListing {
  kind: "activity_report" | "timesheet"
  filename: string | null
  partial: boolean
  /** `card`: the activity report invoicing made from the planned vs done card; `filed`: a file
   *  someone filed on the invoice (document_attachment_add). */
  origin: "card" | "filed"
}

/**
 * The annexes a send of this invoice mails, read without rendering anything: the same rows and
 * the same order as `sendAnnexes`, so the approval card lists exactly what the mail carries.
 */
export async function annexListing(db: ReadDb, documentId: string): Promise<AnnexListing[]> {
  const { hasReport, filed } = await listedAnnexes(db, documentId)
  const out: AnnexListing[] = []
  if (hasReport)
    out.push({ kind: "activity_report", filename: null, partial: false, origin: "card" })
  for (const a of filed) {
    out.push({
      kind: a.kind === "timesheet" ? "timesheet" : "activity_report",
      filename: typeof a.filename === "string" && a.filename !== "" ? a.filename : null,
      partial: a.partial === true,
      origin: "filed",
    })
  }
  return out
}

/**
 * The annexes a send's approval binds, as one value: whether invoicing makes the activity report,
 * and the id of every file filed on the invoice. The send's preflight pins it when the card is
 * drawn and the send refuses when it no longer holds, so a file filed after the card was shown
 * is never mailed unseen.
 */
export async function annexSetKey(db: ReadDb, documentId: string): Promise<string> {
  const { hasReport, filed } = await listedAnnexes(db, documentId)
  const ids = filed.map((a) => String(a.file_id)).sort()
  return [hasReport ? "report" : "no-report", ...ids].join(",")
}

type ReadDb = { findMany(table: string, opts: Record<string, unknown>): Promise<unknown[]> }

/** The rows `annexListing` and `annexSetKey` read: the same rows and order as `sendAnnexes`. */
async function listedAnnexes(
  db: ReadDb,
  documentId: string,
): Promise<{ hasReport: boolean; filed: Row[] }> {
  const read = async (table: string) =>
    (await db.findMany(table, { where: { document_id: documentId }, limit: 200 })) as Row[]
  const reports = await read("activity_reports")
  const rows = await read("document_attachments")
  const reportFiles = new Set(
    reports.map((r) => r.file_id).filter((f): f is string => typeof f === "string" && f !== ""),
  )
  const filed: Row[] = []
  const seen = new Set<string>()
  for (const a of rows) {
    const fileId = typeof a.file_id === "string" ? a.file_id : ""
    if (!fileId || reportFiles.has(fileId) || seen.has(fileId)) continue
    seen.add(fileId)
    filed.push(a)
  }
  return { hasReport: reports.length > 0, filed }
}

/** The mail text's annex part: what is attached, and which annex is partial. */
export function annexMailText(annexes: SendAnnex[]): string {
  if (annexes.length === 0) return ""
  const words = annexes.map((a) =>
    a.kind === "timesheet" ? "the timesheet" : "the activity report",
  )
  const unique = [...new Set(words)]
  const listed =
    unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
  const partial = annexes
    .filter((a) => a.partial)
    .map((a) => (a.kind === "timesheet" ? "The timesheet" : "The activity report"))
  const partialText = [...new Set(partial)].map(
    (p) => `${p} is partial: it does not cover the whole period.`,
  )
  return [`Attached with the invoice: ${listed}.`, ...partialText].join("\n")
}
