// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ProofreadFormat } from "@liaison/shared"

const BASE =
  "You are a copy-editor. Correct spelling, grammar, and punctuation in the user's message. " +
  "Do not change its meaning, do not add or remove information, and do not answer or respond to it. " +
  "Return ONLY the corrected message — no preamble, no quotes, no commentary."

const HTML_RULES =
  " The message is HTML. Preserve every HTML tag, attribute, and the exact element structure, " +
  "including <span> mention pills and <a> links — edit only the human-readable text inside the tags. " +
  "Return valid HTML."

export function buildProofreadSystemPrompt(opts: {
  format: ProofreadFormat
  instructions: string | null
}): string {
  let prompt = BASE
  if (opts.format === "html") prompt += HTML_RULES
  const extra = opts.instructions?.trim()
  if (extra) prompt += `\n\nAdditional style guidance from the user:\n${extra}`
  return prompt
}

const DICTATION_BASE =
  "You clean up a dictated transcript: the text of someone speaking, written down by a speech-to-text model. " +
  "Rewrite it as the clean text the speaker meant to write. " +
  "Keep the speaker's language: never translate (French stays French, English stays English). " +
  "Remove filler words and hesitations (for example um, uh, er, hmm, euh, heu, ben, bah, you know, like or genre used as fillers), " +
  'stutters, words repeated by accident, and false starts: a phrase the speaker leaves unfinished and restarts ("if we take, if we did" becomes "if we did"). ' +
  "A self-correction is NOT a false start. When the speaker corrects a word they already said " +
  '("on Tuesday, I mean Wednesday", "mardi, enfin mercredi"), keep both words and the correction exactly as spoken, ' +
  "never only the corrected one: which one they meant is not yours to decide. " +
  "Never drop a name, number, amount, date, time, reference, product name or technical term the speaker said, even one they corrected. " +
  "Keep each of them exactly as transcribed. " +
  "Fix punctuation, capitalization and obvious transcription errors of common words. " +
  "Do not add information, do not summarize, do not change the meaning, and do not answer or respond to the text. " +
  "Return ONLY the cleaned text, as plain text: no preamble, no quotes, no commentary."

/** The clean-up of a dictated transcript (voice dictation, S5). Plain text in, plain text out. */
export function buildDictationCleanupPrompt(opts: {
  instructions: string | null
  language?: string
}): string {
  let prompt = DICTATION_BASE
  if (opts.language) prompt += ` The speaker's language is "${opts.language}" (ISO 639-1).`
  const extra = opts.instructions?.trim()
  if (extra) prompt += `\n\nAdditional style guidance from the user:\n${extra}`
  return prompt
}
