// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Does an agent's answer tell the person a card is waiting for them NOW?
 *
 * Measured failures (a weak model, walk of agent-driven configuration):
 *   - right after an approval, with no tool call: "Please enter them in the
 *     secure card that just appeared". No card existed: only a call to
 *     request_secret opens one, and none was made;
 *   - "Please provide your HubSpot credentials using the secure request card",
 *     again with none in the conversation;
 *   - "Please approve the approval card above to complete the undo", when the
 *     conversation held no approval for it.
 * The person looks for a card that is not there. The runtime checks such a
 * claim against the conversation (`false-approval-guard.ts`): a secure-card
 * claim stands when a secure card exists there, in any status; an approval-card
 * claim stands only on an approval still waiting there, or one this turn
 * parked. A decided approval is no card to act on: with one approval decided
 * earlier in the conversation, "Please approve the pending approval card" over
 * a call that changed nothing (no approval made) passed as backed (live check,
 * 2026-10-27).
 *
 * This module is the text half. A sentence claims a card only when it names a
 * CARD ("card", "carte"; a form, a "formulaire", is not one of ours) and says it
 * is there for the person now:
 *   - it just appeared ("the secure card that just appeared");
 *   - the agent says it opened one ("I've opened a card for the token");
 *   - it asks the person to act on it ("Please enter the token in the card",
 *     "Approve the card above", "Saisissez la clé dans la carte");
 *   - it says one is waiting ("a card is waiting for you", "the card above is
 *     open").
 * Never a claim: the past ("You approved the card above", "the card above has
 * been used"), a question, an offer, a condition, the future or a negation.
 */

/** What kind of card a sentence claims. */
export type CardKind = "secret" | "approval"

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’ʼ]/g, "'").toLowerCase()
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Up to four words between the article and the noun ("the secure request card"). */
const WORDS = "(?:[\\w'-]+\\s+){0,4}"
const CARD_EN = `(?:the|this|that|a|an|your)\\s+${WORDS}card\\b`
const CARD_FR = `(?:la|cette|une|votre)\\s+${WORDS}carte\\b`

/** Where a sentence may start before its verb: bullets, "please", "now", "so". */
const LEAD_EN = "^(?:[-*>#\\s]*)(?:(?:please|just|simply|now|so|then|next|and)\\s*,?\\s+)*"
const LEAD_FR = "^(?:[-*>#\\s]*)(?:(?:merci de|veuillez|maintenant|ensuite|alors|donc)\\s+)*"

// Patterns run on folded text (no accents, lower case).
const CARD_CLAIM_PATTERNS: readonly RegExp[] = [
  // It just appeared: "the secure card that just appeared", "a card has just opened".
  new RegExp(
    `\\b${CARD_EN}\\s+(?:(?:that|which)\\s+)?(?:has\\s+)?just\\s+(?:appeared|popped up|showed up|opened)\\b`,
  ),
  // The agent opened it: "I've opened a card", "I have sent you the secure card".
  new RegExp(
    `\\bi(?:'ve| have)?\\s+(?:just\\s+|now\\s+)*(?:opened|sent|put up|posted|added|created|displayed)\\s+(?:you\\s+)?${CARD_EN}`,
  ),
  // It asks the person to act on it, now: "Please enter the token in the card".
  new RegExp(
    `${LEAD_EN}(?:enter|type|paste|fill(?: in| out)?|provide|submit|use|save|approve|accept|decide on|open|check)\\b[^.!?\\n]{0,80}?${CARD_EN}`,
  ),
  // It says one waits: "a card is waiting for you", "the card above is open".
  new RegExp(
    `\\b${CARD_EN}(?:\\s+[\\w'-]+){0,3}?\\s+(?:is|are)\\s+(?:now\\s+)?(?:waiting|open|ready|pending)\\b|\\b${CARD_EN}(?:\\s+[\\w'-]+){0,3}?\\s+(?:awaits|waits)\\b`,
  ),
  // French: "la carte qui vient d'apparaitre".
  new RegExp(
    `\\b${CARD_FR}\\s+(?:securisee\\s+)?qui vient d'(?:apparaitre|s'afficher|s'ouvrir)\\b`,
  ),
  // "j'ai ouvert une carte".
  new RegExp(
    `\\bj'ai\\s+(?:deja\\s+)?(?:ouvert|envoye|affiche|cree|ajoute|publie)\\s+(?:pour vous\\s+)?${CARD_FR}`,
  ),
  // "Saisissez la cle dans la carte", "Approuvez la carte ci-dessus".
  new RegExp(
    `${LEAD_FR}(?:saisissez|entrez|renseignez|collez|remplissez|utilisez|approuvez|validez|acceptez|ouvrez)\\b[^.!?\\n]{0,80}?${CARD_FR}`,
  ),
  // "une carte vous attend", "la carte ci-dessus est ouverte".
  new RegExp(
    `\\b${CARD_FR}(?:\\s+[\\w'-]+){0,3}?\\s+(?:vous attend|attend votre|est (?:ouverte|en attente|prete))\\b`,
  ),
]

/** A sentence that asks, offers or makes the card conditional. */
const OFFER_OPENING =
  /^(?:[-*>#\s]*)(?:if|once|when|after|as soon as|shall|should|would|want|do you|can i|could i|i can|i could|let me know|si|une fois|quand|lorsque|apres|des que|voulez|veux|souhaitez|dois-je|je peux|je pourrais)\b/

/** Negation, condition or the future shortly before the claim, or inside it. */
const NOT_NOW =
  /\b(?:not|no|nothing|never|none|will|'ll|would|won't|going to|once|when|after|as soon as|until|if|pas|aucune?|jamais|sera|va|vais|allez|une fois|quand|des que|apres|si)\b|n't\b/

/** The past: the card was used, approved, saved or decided ("You approved the card above"). */
const PAST =
  /\b(?:has been|have been|had been|was|were|you (?:approved|accepted|rejected|saved|submitted|entered|filled|used|declined|decided)|(?:already|earlier|previously) (?:approved|saved|used|submitted|entered)|a ete|ont ete|etait|avez (?:approuve|valide|saisi|rempli|enregistre|utilise|refuse))\b/

/** A card that is not one of ours: a payment card, a gift card. */
const OTHER_CARD =
  /\b(?:credit|debit|gift|bank|business|loyalty|payment|membership|sim|ending|bancaire|cadeau|fidelite|visite|paiement)\b/

const APPROVAL_WORD = /\b(?:approv\w*|approuv\w*|accept\w*|decide|decision|valid\w*|approb\w*)\b/
const SECRET_WORD =
  /\b(?:secure|secret|credential\w*|password|token|key|login|sign-in|identifiant\w*|mot de passe|cle|jeton|securisee?)\b/

/**
 * The kinds of card `text` says are there for the person now: a secure card
 * for a secret, an approval card, or both. Empty when it claims none. A claim
 * that names neither ("enter it in the card") counts as either: it stands when
 * any card is in the conversation.
 */
export function claimedCards(text: string): Set<CardKind | "any"> {
  const out = new Set<CardKind | "any">()
  for (const raw of sentences(fold(text))) {
    if (raw.endsWith("?") || OFFER_OPENING.test(raw) || PAST.test(raw)) continue
    for (const re of CARD_CLAIM_PATTERNS) {
      const m = re.exec(raw)
      if (!m) continue
      if (OTHER_CARD.test(m[0])) continue
      const before = raw.slice(Math.max(0, m.index - 40), m.index)
      if (NOT_NOW.test(before) || NOT_NOW.test(m[0])) continue
      const approval = APPROVAL_WORD.test(raw)
      const secret = SECRET_WORD.test(raw)
      if (approval) out.add("approval")
      if (secret) out.add("secret")
      if (!approval && !secret) out.add("any")
      break
    }
  }
  return out
}

/** The cards this conversation holds that back a claim. */
export interface ThreadCards {
  /** A secure card, in any status (pending, saved, cancelled). */
  secret: boolean
  /** An approval still waiting for a decision. */
  approval: boolean
}

/** Whether every card `claims` names exists in the conversation. */
export function cardClaimsBacked(claims: Set<CardKind | "any">, cards: ThreadCards): boolean {
  if (claims.has("secret") && !cards.secret) return false
  if (claims.has("approval") && !cards.approval) return false
  if (claims.has("any") && !cards.secret && !cards.approval) return false
  return true
}

export const FALSE_CARD_NOTE =
  '<runtime-context note="injected by the Liaison platform, not written by the user">\n' +
  "You told the person a card is waiting for them, but this conversation holds no such card: " +
  "a secure card exists only once your kernel__request_secret call returns, and an approval card only once a gated call of yours returns as pending approval. " +
  "If the person has to enter a secret, call kernel__request_secret now; if an action needs their approval, call its tool now. " +
  "Otherwise say plainly what is done and what is not, and do not mention a card. " +
  "Your reply replaces your previous message, so write the complete answer.\n" +
  "</runtime-context>"

// ── "Connected" claims ──────────────────────────────────────────────────────
//
// Measured failure (a weak model, 2026-10-27): right after a parked Connect
// card was approved, "Your Google Workspace mail is now fully configured and
// connected", with no account connected and the card never completed. The
// runtime checks such a claim like a card claim (open-cards.ts,
// connectionClaimVerdict): only in a conversation that holds a card or a turn
// that filed one; false while a card here for what it names still waits,
// whatever else the organization holds; otherwise it stands on a completed
// card here or an active connected account.

/** It says something is connected or fully set up now. */
const CONNECTED_CLAIM_PATTERNS: readonly RegExp[] = [
  // "is now (fully) connected", "has been successfully connected", "are configured and connected".
  /\b(?:is|are|has been|have been|was|were)\s+(?:now\s+)?(?:all\s+)?(?:fully\s+|successfully\s+)?(?:(?:configured|set up)\s+and\s+)?connected\b/,
  // "successfully connected", "connected successfully".
  /\bsuccessfully\s+connected\b|\bconnected\s+successfully\b/,
  // "is now fully configured", "has been fully set up".
  /\b(?:is|are|has been|have been)\s+(?:now\s+)?(?:fully|successfully)\s+(?:configured|set up)\b/,
  // "est maintenant connecte(e)", "a ete connecte avec succes", "est entierement configure".
  /\b(?:est|sont|a ete|ont ete)\s+(?:maintenant\s+)?(?:bien\s+)?connectee?s?\b/,
  /\b(?:connectee?s?|configuree?s?)\s+avec succes\b/,
  /\b(?:est|sont)\s+(?:maintenant\s+)?(?:entierement|completement)\s+configuree?s?\b/,
]

/** Whether `text` tells the person something is connected or fully set up now. */
export function claimsConnectedNow(text: string): boolean {
  for (const raw of sentences(fold(text))) {
    if (raw.endsWith("?") || OFFER_OPENING.test(raw)) continue
    for (const re of CONNECTED_CLAIM_PATTERNS) {
      const m = re.exec(raw)
      if (!m) continue
      const before = raw.slice(Math.max(0, m.index - 40), m.index)
      if (NOT_NOW.test(before) || NOT_NOW.test(m[0]) || /\bnot yet\b|\bpas encore\b/.test(raw))
        continue
      return true
    }
  }
  return false
}

export const FALSE_CONNECTED_NOTE =
  '<runtime-context note="injected by the Liaison platform, not written by the user">\n' +
  "You told the person something is connected or fully set up, but nothing is: no account is connected, and no card in this conversation was completed. " +
  "A card you posted is a request: nothing is saved or connected until the person completes it, and a line in this conversation says when they do. " +
  "Say plainly what is done and what is still waiting (for example the card they still have to complete), and never call it connected or configured. " +
  "Your reply replaces your previous message, so write the complete answer.\n" +
  "</runtime-context>"

/**
 * The apps a connected claim names, as secret-request target apps ("mail",
 * "shopify", "calendar"), plus "google" for the Google client. Empty: the
 * claim names none, so any waiting card in the conversation is what it is about.
 */
export function appsNamedInClaim(text: string): Set<string> {
  const t = fold(text)
  const out = new Set<string>()
  if (/\b(?:gmail|mail|mailbox|inbox|e-?mail|boite)\b/.test(t)) out.add("mail")
  if (/\bshopify\b|\bstore\b|\bboutique\b/.test(t)) out.add("shopify")
  if (/\bcalendar\b|\bagenda\b|\bcalendrier\b/.test(t)) out.add("calendar")
  if (/\bgoogle\b|\bgmail\b|\bworkspace\b/.test(t)) out.add("google")
  return out
}
