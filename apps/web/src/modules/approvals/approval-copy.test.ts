// SPDX-License-Identifier: FSL-1.1-ALv2
// S23/A9: ticket approval subtitles are now the action + the customer, with
// the ticket id moved to `ref` ("Reply to Jean Dupont", "Close"). A French
// reviewer reads them in French; the old stored forms (with "on ticket-N")
// keep translating, and English readers keep the server's words.
import { describe, expect, it } from "vitest"
import { formatDateTime } from "~/lib/relative-time"
import { translatorFor } from "~/modules/i18n/i18n-context"
import {
  approvalKindLabel,
  approvalScopeLabel,
  localizeApprovalText,
  localizeRefPhrases,
} from "./approval-copy"

const fr = { t: translatorFor("fr"), locale: "fr" }
const en = { t: translatorFor("en"), locale: "en" }

describe("ticket approval subtitles in the reader's language", () => {
  it("translates the new action + customer forms", () => {
    expect(localizeApprovalText("Reply to Jean Dupont", fr)).toBe("Réponse à Jean Dupont")
    expect(localizeApprovalText("Nudge Jean Dupont", fr)).toBe("Relance à Jean Dupont")
    expect(localizeApprovalText("Close", fr)).toBe("Clôture")
    expect(localizeApprovalText("Add internal note", fr)).toBe("Ajout d'une note interne")
    expect(localizeApprovalText("Edit internal note", fr)).toBe("Modification d'une note interne")
    expect(localizeApprovalText("Delete internal note", fr)).toBe("Suppression d'une note interne")
  })

  it("keeps the older stored forms and the mail forms", () => {
    expect(localizeApprovalText("Reply to Fabien on ticket-10013", fr)).toBe(
      "Répondre à Fabien sur ticket-10013",
    )
    expect(localizeApprovalText("Reply to Fabien via support@acme.test", fr)).toBe(
      "Répondre à Fabien depuis support@acme.test",
    )
  })

  it("English readers keep the server's words", () => {
    expect(localizeApprovalText("Reply to Jean Dupont", en)).toBe("Reply to Jean Dupont")
    expect(localizeApprovalText("Close", en)).toBe("Close")
  })
})

// D10 (APR-01): the ticket summary line, link label and the card's kind label.
describe("ticket approval card words in the reader's language", () => {
  it("translates the Last message line and the Open ticket link", () => {
    expect(localizeApprovalText("Last message: 2026-09-28 22:03", fr)).toBe(
      `Dernier message : ${formatDateTime("2026-09-28T22:03:00Z", "fr")}`,
    )
    expect(localizeApprovalText("Open ticket", fr)).toBe("Ouvrir le ticket")
  })

  // The summarizer writes the time in UTC; the rest of the UI shows the
  // viewer's local time, so the card and the Home row read it the same way.
  it("shows the Last message time in the reader's own time zone, English included", () => {
    const utc = Date.UTC(2026, 8, 28, 22, 3)
    const local = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
      utc,
    )
    expect(localizeApprovalText("Last message: 2026-09-28 22:03", en)).toBe(
      `Last message: ${local}`,
    )
    expect(localizeApprovalText("Last message: 2026-09-28 22:03", en)).not.toContain("22:03")
    // Anything that is not the server's date stays as written.
    expect(localizeApprovalText("Last message: yesterday", en)).toBe("Last message: yesterday")
  })

  it("names the kind from the tool, never the raw summary kind", () => {
    expect(approvalKindLabel("tickets:reply", "tickets.reply", fr)).toBe("Tickets : répondre")
    expect(approvalKindLabel("tickets:reply", "tickets.reply", en)).toBe("Tickets: reply")
    expect(approvalKindLabel("acme:do_thing", "acme.do", en)).toBe("Acme: do thing")
    expect(approvalKindLabel(undefined, "mail.reply", en)).toBe("mail.reply")
  })
})

// The deciding scope chip read "needs invoicing:approve": a raw scope string. It names the app.
describe("approval scope chip in the reader's language", () => {
  it("names the app's approval, never the raw scope", () => {
    expect(approvalScopeLabel("invoicing:approve", en)).toBe("needs Invoicing approval")
    expect(approvalScopeLabel("invoicing:approve", fr)).toBe("requiert l'approbation Facturation")
    expect(approvalScopeLabel("kernel:skills:approve", en)).toBe("needs Workspace approval")
    expect(approvalScopeLabel("tickets:replies:send", en)).toBe("needs Tickets permission")
    expect(approvalScopeLabel("tickets:replies:send", fr)).toBe("requiert une autorisation Tickets")
  })
})

// iPhone walk 2026-10-19: "Starts: 2026-10-22T12:44:50.603Z" on a discount card.
describe("a time a summary line carries", () => {
  it("reads in the reader's own zone and language, not as an ISO string", () => {
    const iso = "2026-10-22T12:44:50.603Z"
    expect(localizeApprovalText(`Starts: ${iso}`, en)).toBe(`Starts: ${formatDateTime(iso, "en")}`)
    expect(localizeApprovalText(`Basic code discount, ends at: ${iso}`, fr)).toBe(
      `Basic code discount, ends at: ${formatDateTime(iso, "fr")}`,
    )
    // A bare date is a date, not an instant: it stays as written.
    expect(localizeApprovalText("Due: 2026-10-22", en)).toBe("Due: 2026-10-22")
  })
})

describe("a sequenced step's earlier-step phrases in the reader's language", () => {
  it("names the output and the step in French, inside a sentence and as a whole value", () => {
    expect(localizeRefPhrases("Customer ref: [CRM record from step 1]", fr)).toBe(
      "Customer ref: [la fiche de l'étape 1]",
    )
    expect(localizeRefPhrases("the quote PDF from step 2", fr)).toBe("le PDF de l'étape 2")
    expect(
      localizeApprovalText("📎 [quote PDF from step 2] (attached once that step has run)", fr),
    ).toBe("📎 [le PDF de l'étape 2] (joint une fois cette étape exécutée)")
  })

  it("quotes an output the catalog does not name, and leaves English as written", () => {
    expect(localizeRefPhrases("[shipment tracking code from step 3]", fr)).toBe(
      "[« shipment tracking code » de l'étape 3]",
    )
    expect(localizeRefPhrases("the quote PDF from step 2", en)).toBe("the quote PDF from step 2")
  })
})
