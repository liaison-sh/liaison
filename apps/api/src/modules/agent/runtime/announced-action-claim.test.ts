// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { announcesImminentAction, claimsFreshAction } from "./announced-action-claim"

const ANNOUNCEMENTS: Array<[string, string]> = [
  // "Let me …" is the agent acting, never a request to the person.
  ["en", "Let me look into it and I will fix the mailbox."],
  ["en", "Let me check the sync status now, and I'll report back."],
  // English
  ["en", "I'll book the shipment now."],
  ["en", "Got it. Colissimo is the cheapest at 12.40 EUR. I'll book the shipment now."],
  ["en", "Let me set that up…"],
  ["en", "Let me check the stock for that SKU:"],
  ["en", "Perfect, I will create the invoice for ACME right away."],
  ["en", "I'm going to send the reply to the customer."],
  ["en", "Now I'll go ahead and update the ticket. One moment."],
  ["en", "I'm booking the label now."],
  ["en", "Sure! I'll look into the failed payment."],
  // French
  ["fr", "Je vais créer la facture."],
  ["fr", "Parfait, je vais maintenant vous préparer le devis."],
  ["fr", "Très bien, je m'en occupe."],
  ["fr", "Laissez-moi vérifier le stock."],
  ["fr", "Je vais l'envoyer au client tout de suite."],
  ["fr", "Je lance la synchronisation maintenant."],
  ["fr", "D'accord. Je vais mettre à jour le ticket. Un instant."],
]

const NOT_ANNOUNCEMENTS: Array<[string, string]> = [
  // English: questions, offers, conditions, later, past tense, non-action
  ["en", "Shall I book the shipment?"],
  ["en", "Want me to create the invoice?"],
  ["en", "I can book it with Colissimo if you like."],
  ["en", "I'll book the shipment. Does that work for you?"],
  ["en", "I'll create the invoice once you confirm the amount."],
  ["en", "I'll send the report tomorrow."],
  ["en", "I booked the shipment and the label is attached."],
  ["en", "I've created the invoice INV-2026-0042."],
  ["en", "I won't send anything until you say so."],
  ["en", "Let me know if you need anything else."],
  ["en", "I'll be glad to help with anything else."],
  [
    "en",
    "I'll create the invoice now. Here is a summary of the lines. All totals include VAT. Thanks!",
  ],
  ["en", "Here are three carrier quotes. The cheapest is Colissimo at 12.40 EUR."],
  // French
  ["fr", "Voulez-vous que je crée la facture ?"],
  ["fr", "Je peux créer la facture si vous le souhaitez."],
  ["fr", "Je vais créer la facture dès que vous validez le montant."],
  ["fr", "J'ai créé la facture et l'ai envoyée au client."],
  ["fr", "Je ne vais pas envoyer la réponse sans votre accord."],
  ["fr", "Je vais vous envoyer le récapitulatif demain."],
  ["fr", "Voici les tarifs des transporteurs."],
  // An offer that waits on the person's input (walk 4, N18): not an action now.
  [
    "en",
    "It is not working: the host could not be resolved. Give me the correct IMAP and SMTP hosts and I'll update the mailbox.",
  ],
  ["en", "Tell me which carrier you prefer and I'll book the shipment."],
  ["en", "Send me the export file, and I will import it."],
  ["en", "Share the API token on the card and then I'll test the connection."],
  ["en", "Just paste the order number and I'll look it up."],
  ["fr", "Donnez-moi les bons serveurs IMAP et SMTP et je mets à jour la boîte."],
  ["en", "Give me the hosts and I'll update the mailbox now."],
  ["fr", "Donnez-moi les serveurs et je vais mettre à jour la boîte."],
  ["fr", "Envoyez-moi le fichier et je vais l'importer."],
  ["fr", "Dites-moi quel transporteur vous préférez, et je vais réserver l'envoi."],
]

describe("announcesImminentAction", () => {
  for (const [lang, text] of ANNOUNCEMENTS) {
    it(`announces (${lang}): ${text}`, () => {
      expect(announcesImminentAction(text)).toBe(true)
    })
  }
  for (const [lang, text] of NOT_ANNOUNCEMENTS) {
    it(`no announcement (${lang}): ${text}`, () => {
      expect(announcesImminentAction(text)).toBe(false)
    })
  }
})

describe("claimsFreshAction", () => {
  const CLAIMS: Array<[string, string]> = [
    ["en", "I just re-checked its status: the mailbox is still in error."],
    ["en", "I've updated the mailbox settings."],
    ["en", "I checked the sync status and it reads error."],
    ["en", "I have verified the connection."],
    ["en", "I re-ran the test: 200."],
    ["en", "I double-checked the hosts."],
    ["en", "I tried again and it still fails."],
    ["en", "I took another look at the mailbox."],
    ["en", "Done: the mailbox is updated."],
    ["fr", "J'ai vérifié le statut de la boîte."],
    ["fr", "Je viens de relancer la synchronisation."],
    ["fr", "Je l'ai vérifié, la boîte est en erreur."],
    ["fr", "Nous avons vérifié la connexion."],
    ["fr", "C'est fait, la boîte est à jour."],
  ]
  const NOT_CLAIMS: Array<[string, string]> = [
    ["en", "No, it is not working: sync status error, never synced."],
    ["en", "I cannot update the mailbox without the correct hosts."],
    ["en", "The last check showed getaddrinfo ENOTFOUND."],
    ["en", "Give me the hosts and I'll update the mailbox."],
    ["en", "I already booked it earlier, the label is in the thread."],
    ["en", "As I asked above, I need the IMAP host."],
    ["en", "I read your message: I need the SMTP port too."],
    ["fr", "Je ne peux pas mettre à jour la boîte sans les bons serveurs."],
    ["fr", "Je l'ai déjà vérifié plus tôt, le statut était en erreur."],
    ["fr", "Comme je l'ai demandé plus haut, il me faut le serveur IMAP."],
  ]
  for (const [lang, text] of CLAIMS) {
    it(`claims (${lang}): ${text}`, () => expect(claimsFreshAction(text)).toBe(true))
  }
  for (const [lang, text] of NOT_CLAIMS) {
    it(`no claim (${lang}): ${text}`, () => expect(claimsFreshAction(text)).toBe(false))
  }
})
