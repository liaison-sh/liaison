// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Client activity report PDF template (kind: invoicing:activity_report_v1).
//
// The report that goes with an invoice made from a planned vs done card: the work delivered, the
// billed quantity and its proof labels, signed by the project lead. Its input is strings only,
// built by `activityReportPdfData` (src/activity-report.ts) from the stored report content, which
// has no field for real time, a note, an estimate or a member: the template prints what it gets.
//
// Authored against the sandboxed PDF DSL: exports `renderTemplate(data) => DrawCommand[]`. The
// templates bundle is isolated from src/, so the input type is restated here.

import { type DrawCommand, PdfBuilder, type PdfPage, rgb } from "@liaison/app-sdk"
import { sanitizeForPdfText, textWidth, wrapText } from "./shared"

export interface ActivityReportRenderInput {
  kind?: "activity_report"
  title?: string
  project?: string
  period?: string
  invoice?: string | null
  issuer?: string
  customer?: string | null
  columns?: { work?: string; billed?: string; proofs?: string }
  rows?: Array<{ wording?: string; billed?: string; proofs?: string | null }>
  signature?: string | null
}

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_X = 50
const MARGIN_TOP = 50
const MARGIN_BOTTOM = 70
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
const COL_BILLED_RIGHT = MARGIN_X + 330
const COL_PROOFS_X = MARGIN_X + 345
const WORK_WIDTH = 250
const PROOFS_WIDTH = MARGIN_X + CONTENT_WIDTH - COL_PROOFS_X
const SIZE = 9.5
const LEADING = 13
const DARK = rgb(0.13, 0.13, 0.13)
const LABEL = rgb(0.45, 0.45, 0.45)
const RULE = rgb(0.85, 0.85, 0.85)

interface State {
  pdf: PdfBuilder
  font: string
  bold: string
  page: PdfPage
  pages: PdfPage[]
  y: number
}

function text(
  s: State,
  value: string,
  x: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {},
): void {
  s.page.drawText(sanitizeForPdfText(value), {
    x,
    y: s.y,
    size: opts.size ?? SIZE,
    font: opts.bold ? s.bold : s.font,
    color: opts.color ?? DARK,
  })
}

function ensureSpace(s: State, need: number): void {
  if (s.y - need >= MARGIN_BOTTOM) return
  s.page = s.pdf.addPage(PAGE_WIDTH, PAGE_HEIGHT)
  s.pages.push(s.page)
  s.y = PAGE_HEIGHT - MARGIN_TOP
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

export function renderTemplate(data: ActivityReportRenderInput): DrawCommand[] {
  const d = data ?? {}
  const title = str(d.title) || "Activity report"
  const pdf = new PdfBuilder()
  pdf.setMetadata({ title, producer: "Liaison Invoicing", creator: "Liaison Invoicing" })
  const font = pdf.embedFont("Helvetica")
  const bold = pdf.embedFont("HelveticaBold")
  const first = pdf.addPage(PAGE_WIDTH, PAGE_HEIGHT)
  const s: State = { pdf, font, bold, page: first, pages: [first], y: PAGE_HEIGHT - MARGIN_TOP }

  text(s, title, MARGIN_X, { size: 18, bold: true })
  s.y -= 26
  for (const line of wrapText(str(d.project), CONTENT_WIDTH, 12, true)) {
    text(s, line, MARGIN_X, { size: 12, bold: true })
    s.y -= 16
  }
  for (const head of [str(d.period), str(d.invoice)]) {
    if (!head) continue
    text(s, head, MARGIN_X, { color: LABEL })
    s.y -= LEADING
  }
  const parties = [str(d.issuer), str(d.customer)].filter((p) => p !== "")
  if (parties.length > 0) {
    text(s, parties.join("  >  "), MARGIN_X, { color: LABEL })
    s.y -= LEADING
  }
  s.y -= 14

  const cols = d.columns ?? {}
  const header = (): void => {
    text(s, str(cols.work) || "Work delivered", MARGIN_X, { bold: true })
    const billed = str(cols.billed) || "Billed"
    text(s, billed, COL_BILLED_RIGHT - textWidth(billed, SIZE, true), { bold: true })
    text(s, str(cols.proofs) || "Proof", COL_PROOFS_X, { bold: true })
    s.y -= 6
    s.page.drawLine({
      start: { x: MARGIN_X, y: s.y },
      end: { x: MARGIN_X + CONTENT_WIDTH, y: s.y },
      thickness: 0.5,
      color: RULE,
    })
    s.y -= LEADING
  }
  header()
  for (const row of Array.isArray(d.rows) ? d.rows : []) {
    const work = wrapText(str(row?.wording), WORK_WIDTH, SIZE)
    const proofs = wrapText(str(row?.proofs), PROOFS_WIDTH, SIZE)
    const height = Math.max(work.length, proofs.length, 1) * LEADING
    const before = s.pages.length
    ensureSpace(s, height)
    if (s.pages.length !== before) header()
    const top = s.y
    for (const [i, line] of work.entries()) {
      s.y = top - i * LEADING
      text(s, line, MARGIN_X)
    }
    s.y = top
    const billed = str(row?.billed)
    text(s, billed, COL_BILLED_RIGHT - textWidth(billed, SIZE))
    for (const [i, line] of proofs.entries()) {
      s.y = top - i * LEADING
      text(s, line, COL_PROOFS_X, { color: LABEL })
    }
    s.y = top - height
  }

  const signature = str(d.signature)
  if (signature) {
    ensureSpace(s, 40)
    s.y -= 24
    text(s, signature, MARGIN_X)
  }

  const total = s.pages.length
  for (const [i, page] of s.pages.entries()) {
    const label = `${i + 1} / ${total}`
    page.drawText(label, {
      x: MARGIN_X + CONTENT_WIDTH - textWidth(label, 7.5),
      y: 40,
      size: 7.5,
      font,
      color: LABEL,
    })
  }
  return pdf.build()
}
