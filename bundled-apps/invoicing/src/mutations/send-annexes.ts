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
