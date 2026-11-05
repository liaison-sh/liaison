// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one definition of the no dash punctuation rule for desktop copy, so the
// release notes template test and the manifest publish gate apply the SAME
// rule. The template being clean is worth little if the notes actually shipped
// are pasted in at release time and never linted.

/** An em dash, an en dash, a literal double hyphen, or a SPACED hyphen, which
 *  is the same punctuation typed by somebody whose keyboard has no em dash and
 *  reads to a customer exactly like one.
 *
 *  A plain hyphen inside a compound ("single-build") or a range (1-8) is fine
 *  and is not matched, and neither is a markdown list marker: the spaced
 *  hyphen only counts when a word precedes it, which is what makes it
 *  punctuation rather than a bullet. */
export const DASH_PUNCTUATION = /[–—]|--|\S - /

export interface DashOffence {
  line: number
  text: string
}

export function findDashPunctuation(text: string): DashOffence[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((entry) => DASH_PUNCTUATION.test(entry.text))
}

/** Throws naming every offending line. Used by the gate: release notes reach a
 *  customer inside the update prompt, so they are customer copy. */
export function assertNoDashPunctuation(text: string, label: string): void {
  const offences = findDashPunctuation(text)
  if (offences.length === 0) return
  throw new Error(
    `${label} carries dash punctuation (use a colon, a comma, parentheses, or two sentences):\n` +
      offences.map((entry) => `  line ${entry.line}: ${entry.text}`).join("\n"),
  )
}
