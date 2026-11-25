// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sending an invoice made from a planned vs done card: one mail carries the invoice, its activity
// report (rendered to PDF on the first send) and the files filed on it, a partial one said so in
// the text. A report that cannot render blocks the send with a retry and leaves the invoice
// issued; the retry sends everything together. Nothing a send carries holds real time, a note,
// an estimate or a member's name.

import { describe, expect, test } from "bun:test"
import { renderTemplate as activityReportTemplate } from "../templates/activity_report"
import {
  FORBIDDEN_KEYS,
  harness,
  issuedFromCard,
  MEMBER,
  NOTE,
  REAL_FORMS,
  type Row,
} from "./__tests__/from-reconcile-harness"
import { documentsSendToCustomer } from "./mutations"

describe("sending an invoice from planned vs done", () => {
  test("issuing sends the invoice, the report and the timesheet in one mail", async () => {
    const h = harness()
    const inv = await issuedFromCard(h)
    const sent = await documentsSendToCustomer(h.ctx, { document_id: inv.id })
    expect(sent).toMatchObject({ status: "completed" })
    expect(h.mails).toHaveLength(1)
    const mail = h.mails[0] as { attachments: string[]; textBody: string; to: string[] }
    expect(mail.to).toEqual(["billing@alpine.example"])
    const reportRender = h.renders.find((r) => r.template_kind === "invoicing:activity_report_v1")
    expect(reportRender).toBeTruthy()
    const report = h.db.__all("activity_reports").find((r) => r.document_id === inv.id) as Row
    expect(report.file_id).toBeTruthy()
    const invoicePdf = (h.db.__all("documents").find((d) => d.id === inv.id) as Row).pdf_file_id
    expect(mail.attachments).toEqual([String(invoicePdf), String(report.file_id), "timesheet-file"])
    expect(mail.textBody).toContain("the activity report and the timesheet")
    expect(mail.textBody).toContain("The timesheet is partial")
    // The report names the invoice it goes with, by its number.
    expect((reportRender?.data as Row | undefined)?.invoice).toBe(
      `Annexe à la facture ${inv.number}`,
    )
    // A second send reuses the rendered report.
    await documentsSendToCustomer(h.ctx, { document_id: inv.id })
    expect(
      h.renders.filter((r) => r.template_kind === "invoicing:activity_report_v1"),
    ).toHaveLength(1)
    expect((h.mails[1] as { attachments: string[] }).attachments).toEqual(mail.attachments)
  })

  test("a report that cannot render blocks the send with a retry and the invoice stays issued", async () => {
    const h = harness()
    const inv = await issuedFromCard(h)
    h.render.failReport = true
    const blocked = await documentsSendToCustomer(h.ctx, { document_id: inv.id })
    expect(blocked.status).toBe("error")
    if (blocked.status !== "error") throw new Error("sent")
    expect(blocked.error).toMatchObject({ code: "activity_report_pdf_failed", retryable: true })
    expect(blocked.error.message).toContain(`invoice ${inv.number}`)
    expect(blocked.error.message).toContain("nothing was sent")
    expect(h.mails).toHaveLength(0)
    const doc = h.db.__all("documents").find((d) => d.id === inv.id) as Row
    expect(doc).toMatchObject({ status: "issued", number: inv.number })
    // The retry renders the report and sends everything together.
    h.render.failReport = false
    expect(await documentsSendToCustomer(h.ctx, { document_id: inv.id })).toMatchObject({
      status: "completed",
    })
    expect((h.mails[0] as { attachments: string[] }).attachments).toHaveLength(3)
  })

  test("a failed mail sends the report and the timesheet again together on retry", async () => {
    const h = harness()
    const inv = await issuedFromCard(h)
    h.mail.fail = true
    expect((await documentsSendToCustomer(h.ctx, { document_id: inv.id })).status).toBe("error")
    h.mail.fail = false
    expect((await documentsSendToCustomer(h.ctx, { document_id: inv.id })).status).toBe("completed")
    expect(h.mails).toHaveLength(2)
    expect((h.mails[1] as { attachments: string[] }).attachments).toEqual(
      (h.mails[0] as { attachments: string[] }).attachments,
    )
    expect((h.mails[1] as { attachments: string[] }).attachments).toHaveLength(3)
  })

  test("no payload of the send holds real time, a note, an estimate or a member name", async () => {
    const h = harness()
    const inv = await issuedFromCard(h)
    await documentsSendToCustomer(h.ctx, { document_id: inv.id })
    const reportData = h.renders.find((r) => r.template_kind === "invoicing:activity_report_v1")
      ?.data as Row
    const lines = h.db.__all("document_lines").filter((l) => l.document_id === inv.id)
    const walk = (v: unknown, path: string) => {
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          expect(`${path}.${k}`).not.toMatch(FORBIDDEN_KEYS)
          walk(x, `${path}.${k}`)
        }
      }
    }
    walk(reportData, "report")
    walk(h.mails[0], "mail")
    const drawn = activityReportTemplate(reportData as never)
      .map((c) => ("text" in c ? String((c as { text: unknown }).text) : ""))
      .join("\n")
    const printed = [
      JSON.stringify(reportData),
      JSON.stringify(h.mails[0]),
      drawn,
      lines.map((l) => String(l.description)).join("\n"),
    ]
    for (const text of printed) {
      expect(text).not.toContain(MEMBER)
      expect(text).not.toContain(NOTE)
      expect(text).not.toContain("210")
      for (const f of REAL_FORMS) expect(text).not.toContain(f)
    }
    // The report prints the billed figures only, in the issuer's language.
    expect(drawn).toContain("Data export")
    expect(drawn).toContain("3 jours")
    // Signed by the issuing company, never by a person of the team.
    expect(drawn).toContain("Signé : Maison Studio SAS")
    expect(drawn).not.toContain("Claire Martin")
  })
})
