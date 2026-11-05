// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * FIXED SENTENCES AN AUTOMATION WROTE INTO A TICKET, IN THE READER'S LANGUAGE.
 *
 * Tickets imported from Jira Service Management carry the notes its automation posted, in
 * English, as note bodies: "Reopened automatically — customer replied after the request was
 * resolved." A French agent read it as written in the ticket's stream (third QA walk). It is
 * no person's words, so the exact sentence is shown from the catalog; everything else in a
 * note, and every note written by a person, is shown as written.
 */
import type { Translate } from "~/modules/i18n/i18n-context"

const KNOWN: Array<[RegExp, string]> = [
  [
    /Reopened automatically\s*[\u2014\u2013-]+\s*customer replied after the request was resolved\./g,
    "tickets.knownNotes.reopenedAutomatically",
  ],
]

export function localizeKnownTicketNotes(body: string, t: Translate): string {
  if (!body) return body
  let out = body
  for (const [re, key] of KNOWN) out = out.replace(re, () => t(key))
  return out
}
