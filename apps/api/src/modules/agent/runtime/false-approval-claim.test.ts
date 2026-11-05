// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { approvalHandlesIn, claimsPendingApproval } from "./false-approval-claim"

const CLAIMS: Array<[string, string]> = [
  // English
  ["en", "Order #1097 is booked for its label, pending your approval. Staged, one approval."],
  ["en", "The shipment is staged for your approval."],
  ["en", "I've queued the reply for your review."],
  ["en", "The refund is awaiting your approval."],
  ["en", "Everything is ready for your sign-off."],
  ["en", "Done: the label is now waiting for your approval in the approvals tab."],
  ["en", "I prepared the invoice for you to approve."],
  ["en", "That leaves one approval for you."],
  ["en", "The credit note is pending approval (request-12)."],
  // French
  ["fr", "L'expédition est en attente de votre validation."],
  ["fr", "La réponse attend votre approbation."],
  ["fr", "J'ai préparé l'étiquette pour votre validation."],
  ["fr", "L'envoi est soumis à votre approbation."],
  ["fr", "Tout est prêt pour que vous le validiez."],
  ["fr", "Il reste une seule approbation pour vous."],
  // German
  ["de", "Die Sendung wartet auf Ihre Freigabe."],
  ["de", "Das Etikett liegt jetzt zur Freigabe bereit."],
  ["de", "Ich habe die Rechnung zur Prüfung vorbereitet."],
  ["de", "Die Freigabe ist ausstehend."],
  ["de", "Die Antwort ist vorbereitet, damit du sie freigibst."],
  ["de", "Es gibt eine Freigabe für Sie."],
  // Spanish
  ["es", "El envío está pendiente de tu aprobación."],
  ["es", "La factura espera su aprobación."],
  ["es", "He preparado la etiqueta para tu revisión."],
  ["es", "Lo dejé listo para que lo apruebes."],
  ["es", "Queda una sola aprobación para ti."],
]

const NOT_CLAIMS: Array<[string, string]> = [
  // English: offers, questions, negations, future, plain reports
  ["en", "Shall I stage the shipment for your approval?"],
  ["en", "If you want, I can submit it for your review."],
  ["en", "Want me to queue it for you to approve"],
  ["en", "Nothing is pending your approval yet: I only fetched the quotes."],
  ["en", "I have not staged anything for your review."],
  ["en", "Once I create it, it will be pending your approval."],
  ["en", "Here are three carrier quotes. The cheapest is Colissimo at 12.40 EUR."],
  ["en", "The label was approved and created yesterday."],
  // French
  ["fr", "Voulez-vous que je la soumette à votre validation ?"],
  ["fr", "Rien n'est en attente de votre validation."],
  ["fr", "Une fois créée, elle sera en attente de votre validation."],
  ["fr", "Voici les tarifs des transporteurs."],
  // German
  ["de", "Soll ich die Sendung zur Freigabe vorbereiten?"],
  ["de", "Es wartet nichts auf Ihre Freigabe."],
  ["de", "Danach wird sie auf Ihre Freigabe warten."],
  ["de", "Hier sind die Angebote der Versanddienstleister."],
  // Spanish
  ["es", "¿Quieres que lo deje pendiente de tu aprobación?"],
  ["es", "No hay nada pendiente de tu aprobación."],
  ["es", "Cuando lo cree, estará pendiente de tu aprobación."],
  ["es", "Estas son las tarifas de los transportistas."],
]

describe("claimsPendingApproval", () => {
  for (const [lang, text] of CLAIMS) {
    it(`claims (${lang}): ${text}`, () => {
      expect(claimsPendingApproval(text)).toBe(true)
    })
  }
  for (const [lang, text] of NOT_CLAIMS) {
    it(`no claim (${lang}): ${text}`, () => {
      expect(claimsPendingApproval(text)).toBe(false)
    })
  }
})

describe("approvalHandlesIn", () => {
  it("finds every request-N handle once, lower-cased", () => {
    expect(approvalHandlesIn("See request-12 and Request-7, and request-12 again.")).toEqual([
      "request-12",
      "request-7",
    ])
  })
  it("ignores look-alikes", () => {
    expect(approvalHandlesIn("a request for review, pull-request-x, request-")).toEqual([])
  })
})
