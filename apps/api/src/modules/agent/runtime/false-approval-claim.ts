// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Does an agent's answer say that something awaits the person's approval?
 *
 * Measured failure (a weak model on a shipping request): the agent loaded the
 * gated create-shipment tool, fetched carrier quotes, then ended the turn with
 * "Order #1097 is booked for its label, pending your approval. Staged, one
 * approval." It never called the gated tool, so no approval existed. Prompt
 * prose forbidding exactly that claim did not stop it, so the runtime checks
 * the answer against what the turn did (`false-approval-guard.ts`).
 *
 * This module is the text half: a sentence-level pattern set for the claim in
 * English, French, German and Spanish, and the approval handles (`request-N`)
 * an answer cites. A sentence that asks, offers, negates or speaks of the
 * future ("shall I stage it for your approval?", "nothing is pending your
 * approval", "it will be pending your approval") is not a claim.
 */

/** Lower-cased, diacritics stripped, typographic apostrophes folded. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’ʼ]/g, "'").toLowerCase()
}

// Patterns run on folded text (no accents, lower case).
const CLAIM_PATTERNS: readonly RegExp[] = [
  // English
  /\bpending (?:(?:your|my|the|an?|final|human) )?(?:approval|review|sign-?off|validation)\b/,
  /\b(?:awaiting|awaits|waiting (?:for|on)) (?:(?:your|the|an?|final) )?(?:approval|review|sign-?off|validation)\b/,
  /\b(?:staged|queued|submitted|lined up|prepared|ready|set up|booked|filed|created)\b[^.!?\n]{0,80}\bfor (?:your|my) (?:approval|review|sign-?off|validation)\b/,
  /\bready for your (?:approval|review|sign-?off)\b/,
  /\bfor you to (?:approve|review|sign off|validate)\b/,
  /\b(?:one|1|a single) approval (?:for you|waiting|to review|on your side)\b/,
  // French
  /\ben attente de (?:(?:votre|ta|ton|la|l'|une) ?)?(?:validation|approbation|accord|relecture|signature)\b/,
  /\battend (?:votre|ta|ton) (?:validation|approbation|accord|relecture)\b/,
  /\b(?:soumise?s?|preparee?s?|prete?s?|mise?s? en file|programmee?s?|enregistree?s?|creee?s?)\b[^.!?\n]{0,80}\b(?:a|pour) (?:votre|ta|ton) (?:validation|approbation|accord|relecture)\b/,
  /\bpour que (?:vous|tu) (?:l'|le |la |les )?(?:validiez|approuviez|relisiez|valides|approuves|relises)\b/,
  /\bune (?:seule )?(?:approbation|validation) pour (?:vous|toi)\b/,
  // German
  /\b(?:wartet|warten) auf (?:ihre|deine|eure|die) (?:freigabe|genehmigung|zustimmung|prufung)\b/,
  /\b(?:freigabe|genehmigung|zustimmung|prufung) (?:ist |steht )?ausstehend\b/,
  /\bausstehende?n? (?:freigabe|genehmigung|zustimmung)\b/,
  /\b(?:steht|stehen|liegt|liegen|ist|sind)\b[^.!?\n]{0,60}\bzur (?:freigabe|genehmigung|prufung)\b/,
  /\b(?:bereit|vorbereitet|eingereicht|vorgelegt|vorgemerkt|angelegt)\b[^.!?\n]{0,60}\b(?:zur|fur ihre|fur deine) (?:freigabe|genehmigung|prufung)\b/,
  /\bzur (?:freigabe|genehmigung|prufung) (?:bereit|vorbereitet|eingereicht|vorgelegt)\b/,
  /\bdamit (?:sie|du) (?:es |ihn |sie )?(?:freigeben|genehmigen|prufen|freigibst|genehmigst|prufst)\b/,
  /\beine (?:einzige )?freigabe fur (?:sie|dich)\b/,
  // Spanish
  /\bpendientes? de (?:(?:tu|su|la) )?(?:aprobacion|revision|autorizacion|validacion)\b/,
  /\b(?:esperando|espera|a la espera de) (?:tu|su) (?:aprobacion|revision|autorizacion|validacion)\b/,
  /\b(?:preparad[oa]s?|list[oa]s?|enviad[oa]s?|en cola|registrad[oa]s?|cread[oa]s?)\b[^.!?\n]{0,80}\bpara (?:tu|su) (?:aprobacion|revision|autorizacion|validacion)\b/,
  /\bpara que (?:lo |la |los |las )?(?:apruebes|revises|apruebe|revise|autorices|autorice)\b/,
  /\buna (?:sola )?aprobacion para (?:ti|usted)\b/,
]

/** A sentence that opens as a question, an offer or a condition. */
const OFFER_OPENING =
  /^(?:[-*>#\s]*)(?:if|once|when|after|shall|should|would|want|do you|can i|could i|i can|i could|let me know|si|une fois|quand|lorsque|apres|voulez|veux|souhaitez|dois-je|je peux|je pourrais|wenn|sobald|falls|nachdem|soll ich|mochten|willst|ich kann|ich konnte|cuando|una vez|quieres|desea|puedo|podria)\b/

/** Negation or future wording shortly before the matched phrase. */
const NEGATED_OR_FUTURE =
  /\b(?:not|no|nothing|never|none|n't|will|'ll|would|won't|going to|pas|rien|aucune?|jamais|sera|seront|serait|va etre|nicht|kein\w*|nichts|nie|wird|werden|nada|nunca|ningun\w*|estara|estaran|quedara|seria|va a)\b|n't\b/

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * True when some sentence of `text` states that an action is staged or awaits
 * the person's approval or review.
 */
export function claimsPendingApproval(text: string): boolean {
  for (const raw of sentences(fold(text))) {
    if (raw.endsWith("?") || raw.startsWith("¿")) continue
    if (OFFER_OPENING.test(raw)) continue
    for (const pattern of CLAIM_PATTERNS) {
      const m = pattern.exec(raw)
      if (!m) continue
      const before = raw.slice(Math.max(0, m.index - 50), m.index)
      if (NEGATED_OR_FUTURE.test(before)) continue
      return true
    }
  }
  return false
}

/** The approval handles (`request-N`) `text` cites, lower-cased and deduplicated. */
export function approvalHandlesIn(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/\brequest-\d+\b/gi)) found.add(m[0].toLowerCase())
  return [...found]
}

export const FALSE_APPROVAL_NOTE =
  '<runtime-context note="injected by the Liaison platform, not written by the user">\n' +
  "You said something is staged or pending approval, but no action was submitted for approval in this turn " +
  "(or you cited an approval handle no tool returned). If you meant to stage it, call the gated tool now. " +
  "Otherwise correct your answer: say plainly what you did and did not do. " +
  "Your reply replaces your previous message, so write the complete answer.\n" +
  "</runtime-context>"
