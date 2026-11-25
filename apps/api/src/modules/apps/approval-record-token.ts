// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A RECORD IN A CARD'S TEXT. A summarizer that says which record a call acts on writes the record
// (`recordToken`), never its name: each reader of the card reads the name they may
// (approval-record-names.ts), and everyone else reads what kind of record it is.

/** A record a call names by id. */
export interface RecordRef {
  app: string
  entityType: string
  id: string
}

/** Private-use marks around a record in a text: nothing a person types, and dropped if they do. */
const OPEN = "\uE000"
const CLOSE = "\uE001"
export const RECORD_TOKEN = new RegExp(`${OPEN}([\\w-]+):([\\w-]+):([0-9a-fA-F-]{36})${CLOSE}`, "g")
const MARKS = new RegExp(`[${OPEN}${CLOSE}]`, "g")

/** A record as it stands in a card's text until a reader's own access names it. */
export function recordToken({ app, entityType, id }: RecordRef): string {
  return `${OPEN}${app}:${entityType}:${id}${CLOSE}`
}

/** A caller's own words, with nothing in them that reads as a record of the card. */
export function withoutMarks(text: string): string {
  return text.replace(MARKS, "")
}
