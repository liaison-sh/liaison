// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Does an agent's answer end by announcing an action it is about to take?
 *
 * Measured failure (a weak model on a shipping request): the turn ended with
 * "I'll book the shipment now." and no tool call, so nothing happened and the
 * person waited for an action that never came. The runtime gives such a turn
 * one corrective continuation (`false-approval-guard.ts` carries the
 * plumbing; `agent-service.ts` picks the note).
 *
 * This module is the text half: the LAST two sentences of the answer are read
 * for a first-person announcement of an imminent action in English or French
 * ("I'll create the invoice now", "Let me set that up", "Je vais créer la
 * facture", "Je m'en occupe"). There the verb must be an action verb, so "I'll
 * be glad to help" never matches. The FINAL sentence counts whatever its verb
 * when it opens on the agent's own next step ("Let's do the scope lookup
 * first."), unless the words address or wait on the person ("Let me know",
 * "I'll wait for your go-ahead"). Not an announcement:
 *   - a final sentence that asks or offers ("Shall I book it?", "Want me
 *     to…?", "Voulez-vous que je…");
 *   - an announcement tied to the person or to later ("I'll book it once you
 *     confirm", "dès que vous validez", "tomorrow", "plus tard");
 *   - an offer that waits on the person's input, asked for first ("Give me the
 *     hosts and I'll update the mailbox", "Envoyez-moi le fichier et je
 *     l'importe"): nothing can be done before they answer;
 *   - a report in the past tense ("I booked it", "J'ai créé la facture").
 */

/** Lower-cased, diacritics stripped, typographic apostrophes folded. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’ʼ]/g, "'").toLowerCase()
}

const EN_VERBS =
  "book|create|send|set (?:(?:that|this|it|everything|them) )?up|setup|schedule|draft|update|add|file|submit|stage|cancel|delete|remove|issue|" +
  "generate|prepare|look (?:up|into|at|for)|check|search|fetch|pull|open|assign|reply|respond|email|post|" +
  "process|run|start|launch|move|change|edit|modify|log|record|contact|refund|ship|order|find|write|" +
  "configure|connect|archive|close|tag|label|invoice|apply|mark|forward|upload|import|export|sync|" +
  "retrieve|grab|go ahead|proceed|handle|take care of|arrange|register|enter|reschedule|notify|message|" +
  "compose|make|build|calculate|compute|review|verify|confirm|get (?:started|that|this|it|the|you)|" +
  // The verbs of a tool call: a plan that ends "Let me call routine_tool_scopes." or
  // "Let's call it." announces a call the turn never made.
  "call|invoke|use|query"

const EN_ING =
  "booking|creating|sending|setting up|scheduling|drafting|updating|adding|filing|submitting|staging|" +
  "cancel+ing|deleting|removing|issuing|generating|preparing|looking (?:up|into)|checking|searching|" +
  "fetching|pulling|processing|running|starting|moving|changing|refunding|shipping|ordering|writing|" +
  "configuring|connecting|archiving|closing|applying|forwarding|uploading|importing|syncing|retrieving|" +
  "handling|arranging|registering|proceeding"

const FR_VERBS =
  "creer|envoyer|reserver|preparer|programmer|planifier|mettre|ajouter|generer|rediger|verifier|" +
  "chercher|rechercher|regarder|lancer|faire|emettre|annuler|supprimer|enregistrer|contacter|repondre|" +
  "ouvrir|configurer|transmettre|transferer|recuperer|consulter|editer|modifier|publier|soumettre|" +
  "commander|expedier|rembourser|facturer|etablir|saisir|importer|exporter|synchroniser|traiter|" +
  "m'occuper|m'en occuper|proceder|passer|organiser|relancer|notifier|ecrire|calculer|construire|" +
  "booker|caler|fixer|valider|cloturer|fermer|archiver|deplacer|changer|mettre a jour|appeler|utiliser|interroger"

const OBJ_FR = "(?:(?:vous|te|lui|leur|l'|le|la|les|en|y|me|m'|t'|ca|cela)\\s*)*"
const ADV_EN = "(?:(?:now|right now|just|quickly|go ahead and|then|first|also|immediately)\\s+)*"
const ADV_FR =
  "(?:(?:maintenant|tout de suite|donc|immediatement|alors|d'abord|aussi|des maintenant|de ce pas)\\s+)*"

// Patterns run on folded text (no accents, lower case).
const ANNOUNCEMENT_PATTERNS: readonly RegExp[] = [
  // English: "I'll …", "I will …", "I'm going to …", "let me …", "now I'll …"
  new RegExp(
    `\\b(?:i'll|i will|i'm going to|i am going to|i'm about to|i am about to|let me|let's)\\s+${ADV_EN}(?:${EN_VERBS})\\b`,
  ),
  // English, progressive: "I'm booking the shipment now", "I'm now creating …"
  new RegExp(`\\bi(?:'m| am)\\s+(?:now\\s+|going ahead and\\s+)?(?:${EN_ING})\\b`),
  // French: "je vais (vous) créer …", "laissez-moi vérifier …", "je m'en occupe"
  new RegExp(`\\bje vais\\s+${ADV_FR}${OBJ_FR}(?:${FR_VERBS})\\b`),
  new RegExp(`\\b(?:laissez|laisse)-moi\\s+${ADV_FR}${OBJ_FR}(?:${FR_VERBS})\\b`),
  /\bje m'(?:en )?occupe\b/,
  /\bje (?:lance|procede a|prepare|cree|reserve|envoie|programme)\b[^.!?\n]{0,60}\b(?:maintenant|tout de suite|immediatement|de ce pas)\b/,
]

/**
 * The final sentence opens on a first-person announcement of the agent's own
 * next step, whatever the verb: "Let's do the scope lookup first.", "Now let
 * me think about the prompt.", "Je vais m'atteler à la consigne." A turn that
 * stops there stops on a step it never takes. Group 1 is the word after it.
 */
const NEXT_STEP_OPENING = new RegExp(
  "^(?:[-*>#\\s]*)(?:(?:ok|okay|alright|all right|right|so|now|next|first|then|good|great|perfect|sure|" +
    "bon|alors|d'accord|parfait|maintenant|ensuite|d'abord|tres bien)[,\\s]+)*" +
    `(?:let me|let's|let us|i'll|i will|i'm going to|i am going to|i'm about to|i am about to|` +
    `je vais|je m'en vais|on va|nous allons|laisse-moi|laissez-moi)\\s+${ADV_EN}${ADV_FR}` +
    "(?:(?:vous|te|lui|leur|le|la|les|en|y|me|se|nous)\\s+|[lmts]'\\s*)*([a-z][a-z'-]*)",
)

/**
 * Words after such an opening that address the person or wait on them, not a
 * step the agent takes: "let me know", "let us know", "laissez-moi savoir",
 * "I'll wait for your go-ahead", "I'll be here", "let's talk".
 */
const NOT_A_STEP =
  /^(?:know|hear|be|wait|await|stay|remain|keep|hope|leave|stop|thank|talk|discuss|chat|meet|need|say|note|mention|remind|savoir|attendre|patienter|rester|etre|tenir|esperer|laisser)$/

function announcesNextStep(sentence: string): boolean {
  const m = NEXT_STEP_OPENING.exec(sentence)
  return m !== null && !NOT_A_STEP.test(m[1] ?? "")
}

/** A sentence that asks, offers or makes the action wait for the person. */
const OFFER_OPENING =
  /^(?:[-*>#\s]*)(?:shall|should|would|want|do you|can i|could i|i can|i could|may i|if you|si vous|si tu|voulez|veux|souhaitez|dois-je|je peux|je pourrais|puis-je)\b/

/** Wording that ties the action to the person or to later. */
const DEFERRED =
  /\b(?:if (?:you|that's|that is|it's ok|needed|necessary)|once|when|whenever|as soon as|after you|after your|unless|until|tomorrow|later|next (?:week|month|time)|your (?:confirmation|go-ahead|approval|ok|okay|answer|reply)|si (?:vous|tu|c'est|besoin|necessaire)|des que|une fois|quand|lorsque|apres (?:votre|ta|ton)|a condition|demain|plus tard|la semaine prochaine|votre (?:confirmation|feu vert|accord|validation|reponse|retour))\b/

/**
 * The sentence first asks the person for something, then says what the agent
 * does with it: "Give me the hosts and I'll update the mailbox", "Tell me which
 * one, and I will book it", "Envoyez-moi le fichier et je l'importe".
 */
const ASKS_PERSON_FIRST =
  /^(?:[-*>#\s]*)(?:(?:just|please|simply|then|so)\s+)*(?:give|tell|send|share|paste|provide|forward|show|enter|type|confirm)\s+(?:me|us)\b[^.!?]*?,?\s+and\s+(?:then\s+)?(?:i'll|i will|i can)\b|^(?:[-*>#\s]*)(?:donnez|dites|envoyez|indiquez|transmettez|communiquez|precisez|confirmez|montrez|collez|donne|dis|envoie|indique)-(?:moi|nous)\b[^.!?]*?,?\s+et\s+(?:ensuite\s+)?je\b/

/** "I'll call it \"Monday digest\"": naming something, not a tool call. */
const NAMING = /\bcall (?:it|this|that|them|the \w+)\s+["'\u201c\u00ab]/

/** Negation shortly before the announcement ("I won't", "je ne vais pas"). */
const NEGATED = /\b(?:not|never|won't|can't|cannot|pas|jamais|ne|n')\b/

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…;:])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s))
}

/**
 * True when one of the last two sentences of `text` announces a first-person
 * action the agent is about to take now, and the answer does not end on a
 * question or an offer.
 */
export function announcesImminentAction(text: string): boolean {
  const all = sentences(fold(text))
  if (all.length === 0) return false
  const last = all[all.length - 1]
  if (last.endsWith("?") || OFFER_OPENING.test(last)) return false
  if (
    !ASKS_PERSON_FIRST.test(last) &&
    announcesNextStep(last) &&
    !DEFERRED.test(last) &&
    !NAMING.test(last) &&
    !NEGATED.test(last.slice(0, 40))
  ) {
    return true
  }
  for (const raw of all.slice(-2)) {
    if (raw.endsWith("?") || OFFER_OPENING.test(raw) || ASKS_PERSON_FIRST.test(raw)) continue
    for (const pattern of ANNOUNCEMENT_PATTERNS) {
      const m = pattern.exec(raw)
      if (!m) continue
      if (DEFERRED.test(raw) || NAMING.test(raw)) continue
      const before = raw.slice(Math.max(0, m.index - 20), m.index + m[0].length)
      if (NEGATED.test(before)) continue
      return true
    }
  }
  return false
}

// No "read" or "asked": "I read your message", "as I asked above" report
// nothing done on the person's behalf.
const CLAIM_VERBS_EN =
  "checked|verified|confirmed|looked|searched|updated|created|sent|booked|fetched|pulled|ran|tested|" +
  "refreshed|synced|retried|tried|reviewed|opened|changed|set up|configured|connected|saved|added|" +
  "deleted|removed|scheduled|imported|submitted|issued|reconnected|restarted|triggered|queried|" +
  "fixed|applied|started|launched|pinged|called|took (?:another|a second|a fresh|a) look"

const CLAIM_VERBS_FR =
  "verifie|cree|envoye|mis a jour|controle|consulte|relance|teste|lance|regarde|recupere|" +
  "synchronise|configure|connecte|enregistre|ajoute|supprime|importe|programme|corrige|applique|" +
  "interroge|actualise|rafraichi|reessaye|essaye"

const ADV_DONE_FR = "(?:(?:juste|deja|bien|aussi|egalement|a nouveau|de nouveau)\\s+)*"

/** First-person reports of an action done ("I just re-checked", "I've updated", "j'ai vérifié"). */
const FRESH_ACTION_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\bi(?:'ve| have)?\\s+(?:(?:just|now|already|also|quickly|then)\\s+)*(?:re-?|double-)?(?:${CLAIM_VERBS_EN})\\b`,
  ),
  /\bi(?:'ve| have)? just\s+(?:re-?)?[a-z]+ed\b/,
  // "j'ai vérifié", "je l'ai vérifié", "nous avons vérifié", "on l'a vérifié"
  new RegExp(
    `(?:\\bj'ai|\\bje (?:l'|les |y |en |lui |leur )ai|\\bnous (?:l'|les |y |en )?avons|\\bon (?:l'|les |y |en )?a)\\s+${ADV_DONE_FR}(?:re)?(?:${CLAIM_VERBS_FR})\\b`,
  ),
  /\bje viens d(?:e |')/,
  // "Done: …", "All done.", "C'est fait".
  /^(?:[-*>#\s]*)(?:all )?done\b\s*[:.!,]/,
  /\bc'est fait\b/,
]

/** A sentence about an earlier step: "I booked it earlier", "comme je l'ai dit plus haut". */
const EARLIER =
  /\b(?:earlier|previously|before that|above|in my (?:last|previous) (?:message|reply)|plus tot|plus haut|precedemment|tout a l'heure|auparavant|ci-dessus)\b/

/**
 * True when `text` reports, in the first person, an action as done. Read on a
 * corrective continuation that called no tool: there, any such report is
 * about something that did not happen in it. A sentence that places the
 * action earlier is a report of a previous step, not a fresh claim.
 */
export function claimsFreshAction(text: string): boolean {
  return sentences(fold(text)).some(
    (sentence) => !EARLIER.test(sentence) && FRESH_ACTION_PATTERNS.some((p) => p.test(sentence)),
  )
}

export const ANNOUNCED_ACTION_NOTE =
  '<runtime-context note="injected by the Liaison platform, not written by the user">\n' +
  "You said you would do something now, but your turn ended without calling any tool, so nothing was done. " +
  "If you can do it, call the tool now (find it with kernel__tool_search if you do not have it). " +
  "If it waits on something from the person, ask them for it. If you cannot do it, tell the person plainly what you cannot do and why. " +
  "No tool has run since your previous message: never say you did, checked, re-checked or verified anything unless a tool you call in this reply does it. " +
  "Your reply replaces your previous message, so write the complete answer.\n" +
  "</runtime-context>"
