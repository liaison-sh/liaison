// SPDX-License-Identifier: FSL-1.1-ALv2
// The settings-held input of a document's dated legal mention (the CIBS switch date).

import {
  DEFAULT_CIBS_SWITCH_DATE,
  type LegalMentionOptions,
  type MentionLanguage,
  resolveLegalMention,
  type TaxTreatment,
} from "../tax"

interface SettingsReader {
  findMany(table: "einvoicing_settings", opts: { limit: number }): Promise<unknown[]>
}

/** The org's CIBS switch date (YYYY-MM-DD): the settings row's value, else 2027-01-01. */
export async function readCibsSwitchDate(db: SettingsReader): Promise<string> {
  const rows = (await db.findMany("einvoicing_settings", { limit: 1 })) as Array<
    Record<string, unknown>
  >
  const raw = rows[0]?.cibs_switch_date
  const text = raw instanceof Date ? raw.toISOString() : typeof raw === "string" ? raw : ""
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : DEFAULT_CIBS_SWITCH_DATE
}

/** A document's legal mention from its treatment, operation category and issue date, with the org's switch date. */
export async function documentLegalMention(
  db: SettingsReader,
  treatment: TaxTreatment,
  language: MentionLanguage,
  opts: Omit<LegalMentionOptions, "cibsSwitchDate">,
): Promise<string> {
  return resolveLegalMention(treatment, language, {
    ...opts,
    cibsSwitchDate: await readCibsSwitchDate(db),
  })
}
