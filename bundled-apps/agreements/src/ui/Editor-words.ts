// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The editor's checks in the reader's words, by the check's code (translated where drawn).

/** Each check in the reader's words: [when it passes, when it does not]. */
export const CHECK_WORDS: Record<string, [string, string]> = {
  SIGNATURE_DOES_NOT_FIT: [
    "This kind of document fits a simple electronic signature.",
    "A simple electronic signature does not fit this kind of document.",
  ],
  WHAT_IT_IS_REQUIRED: ["A person said what it is.", "Say what this document is."],
  PERSONAL_GUARANTEE: [
    "No sign of a personal guarantee.",
    "This looks like a personal guarantee or another act this signature does not fit.",
  ],
  CHECK_WITH_LAWYER: [
    "Check with your lawyer first: some of these acts can need a higher signature level, which Liaison does not offer.",
    "Check with your lawyer first: some of these acts can need a higher signature level, which Liaison does not offer.",
  ],
  PRICE_NOT_SET: ["A person set the price.", "No price yet: set it above."],
  AGENT_TEXT_UNREAD: [
    "Every clause was read by a person.",
    "A person must read and clear the clauses an agent wrote.",
  ],
  DOCUMENT_EMPTY: ["The document has text.", "The document has no text yet."],
}

export const CHECK_WORDS_FOR_TEST: string[][] = Object.values(CHECK_WORDS)
