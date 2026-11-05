// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  appsNamedInClaim,
  cardClaimsBacked,
  claimedCards,
  claimsConnectedNow,
} from "~/modules/agent/runtime/card-claim"

const kinds = (text: string): string[] => [...claimedCards(text)].sort()

describe("claimedCards: a card said to be there for the person now", () => {
  const claims: Array<[string, string[]]> = [
    // The walk's false claims.
    ["Please enter them in the secure card that just appeared.", ["secret"]],
    ["Please provide your HubSpot credentials using the secure request card.", ["secret"]],
    ["I have opened the credential request card for HubSpot above.", ["secret"]],
    ["Please approve the approval card above to complete the undo.", ["approval"]],
    // Other present forms.
    ["Enter it in the card above.", ["any"]],
    ["A secure card is waiting for you below.", ["secret"]],
    ["Approve the card to start the import.", ["approval"]],
    // French.
    ["Saisissez la clé dans la carte sécurisée ci-dessus.", ["secret"]],
    ["Approuvez la carte ci-dessus.", ["approval"]],
    ["Veuillez saisir le jeton dans la carte qui vient d'apparaître.", ["secret"]],
    ["J'ai ouvert une carte sécurisée pour votre jeton.", ["secret"]],
    ["Une carte d'approbation vous attend.", ["approval"]],
  ]
  for (const [text, expected] of claims) {
    test(`claims: ${text}`, () => {
      expect(kinds(text)).toEqual(expected)
    })
  }
})

describe("claimedCards: never a claim", () => {
  const none = [
    // The past: a card that was there and was used or decided.
    "You approved the card above, so the import is running.",
    "The secure card above has been used.",
    "The token was saved through the card.",
    "Vous avez approuvé la carte ci-dessus, l'import tourne.",
    "La carte ci-dessus a été utilisée.",
    "Check the secure card above: your token has been saved.",
    "Use the card above, which you already approved.",
    // A form is not one of our cards.
    "Enter your new password in the reset form.",
    "Fill in the contact form below.",
    "Your manager must approve the expense form.",
    "Le formulaire ci-dessus est valide.",
    "Remplissez le formulaire de contact.",
    // Questions, offers, conditions, the future, negations.
    "Once approved, a secure card will appear for the token.",
    "Shall I open a secure card for the token?",
    "I will open a secure card for the token.",
    "No card is open yet: I need to save the adapter first.",
    "When the card appears, enter the token there.",
    "If you approve it, the import starts.",
    "Je vais ouvrir une carte sécurisée pour le jeton.",
    // Not our cards at all.
    "The customer paid with the credit card ending 4242.",
    "Use the gift card for the refund.",
    "The token was saved.",
  ]
  for (const text of none) {
    test(`no claim: ${text}`, () => {
      expect(kinds(text)).toEqual([])
    })
  }
})

describe("cardClaimsBacked: a card of that kind in the conversation, in any status", () => {
  test("a secret claim needs a secret request, an approval claim an approval", () => {
    const secret = claimedCards("Enter the token in the secure card.")
    expect(cardClaimsBacked(secret, { secret: false, approval: true })).toBe(false)
    expect(cardClaimsBacked(secret, { secret: true, approval: false })).toBe(true)
    const approval = claimedCards("Approve the card above.")
    expect(cardClaimsBacked(approval, { secret: true, approval: false })).toBe(false)
    expect(cardClaimsBacked(approval, { secret: false, approval: true })).toBe(true)
    const any = claimedCards("Enter it in the card above.")
    expect(cardClaimsBacked(any, { secret: false, approval: false })).toBe(false)
    expect(cardClaimsBacked(any, { secret: false, approval: true })).toBe(true)
  })
})

describe("claimsConnectedNow: something said to be connected or set up now (walk N41)", () => {
  const claims = [
    // The walk's false claim, after an approved Connect card that never rendered.
    "Your Google Workspace mail (support@example.test) is now fully configured and connected.",
    "Your Gmail account has been successfully connected.",
    "The Shopify store is connected.",
    "Gmail connected successfully!",
    "Everything is now fully set up.",
    "Votre boite Gmail est maintenant connectee.",
    "La boutique a ete connectee avec succes.",
  ]
  for (const text of claims)
    test(`claims: ${text}`, () => expect(claimsConnectedNow(text)).toBe(true))

  const notClaims = [
    "Once you complete the card, your Gmail will be connected.",
    "Nothing is connected yet: please complete the card above.",
    "Your mailbox is not connected yet.",
    "Is your Shopify store connected?",
    "When the card is saved, the store is connected and I will set up the webhooks.",
    "Your Gmail is not yet connected.",
    "Votre boutique n'est pas encore connectee.",
    "I posted the Connect card for your Gmail.",
    // Ordinary speech, not a connection claim (review): no "linked".
    "These two tickets are linked.",
    "The invoices are linked to the order.",
  ]
  for (const text of notClaims)
    test(`no claim: ${text}`, () => expect(claimsConnectedNow(text)).toBe(false))
})

test("appsNamedInClaim: what a connected claim is about", () => {
  expect([...appsNamedInClaim("Your Google Workspace mail is now connected.")].sort()).toEqual([
    "google",
    "mail",
  ])
  expect([...appsNamedInClaim("The store is connected.")]).toEqual(["shopify"])
  expect([...appsNamedInClaim("Everything is now fully set up.")]).toEqual([])
})
