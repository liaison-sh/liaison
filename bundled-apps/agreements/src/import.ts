// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `agreement_import`: a contract signed before Liaison, filed from its PDF. It is
// `imported`, never signed here: no version is frozen, nobody signs, no evidence
// exists and no level is claimed, and every surface says "Imported, signed
// outside Liaison". Text read from the PDF (by `analyze_media`, say) is kept as
// unverified, and is always quoted as such.

import { agreementCreate } from "./agreements"
import { type AgreementsCtx, refusal } from "./ctx"

export const IMPORTED_LABEL = "Imported, signed outside Liaison"

const DAY = /^\d{4}-\d{2}-\d{2}$/
const IMPORT_KINDS = ["proposal", "sow", "msa", "nda", "retainer", "tm", "dpa", "other"]

export interface ImportParams {
  kind: string
  title: string
  file_id: string
  company_id?: string
  contact_id?: string
  language?: "en" | "fr"
  /** The day the parties signed it, as the document says. */
  signed_on?: string
  starts_on?: string
  ends_on?: string
  renews_on?: string
  notice_days?: number
  /** Text read from the PDF: kept as unverified, never as the signed text. */
  unverified_text?: string
  what_it_is?: string
}

export async function agreementImport(ctx: AgreementsCtx, p: ImportParams) {
  if (!IMPORT_KINDS.includes(p.kind))
    return refusal(
      "INVALID_KIND",
      `Kind ${p.kind} is not one of ${IMPORT_KINDS.join(", ")}. Nothing was imported.`,
    )
  if (typeof p.file_id !== "string" || p.file_id === "")
    return refusal(
      "FILE_REQUIRED",
      "An imported agreement is filed from its PDF: pass the file_id files_upload_confirm returned. Nothing was imported.",
    )
  for (const [k, v] of [
    ["signed_on", p.signed_on],
    ["starts_on", p.starts_on],
    ["ends_on", p.ends_on],
    ["renews_on", p.renews_on],
  ] as const) {
    if (v !== undefined && !DAY.test(v))
      return refusal("INVALID_DATE", `${k} is a day (YYYY-MM-DD). Nothing was imported.`)
  }
  const made = (await agreementCreate(ctx, {
    kind: p.kind,
    title: p.title,
    file_id: p.file_id,
    ...(p.company_id ? { company_id: p.company_id } : {}),
    ...(p.contact_id ? { contact_id: p.contact_id } : {}),
    ...(p.language ? { language: p.language } : {}),
    ...(p.what_it_is ? { what_it_is: p.what_it_is } : {}),
  })) as
    | { status: "ok"; agreement: { id: string; number: string; file_id: string | null } }
    | { status: "error"; error: { code: string; message: string } }
  if (made.status !== "ok") return made
  const { id, number, file_id: keptFileId } = made.agreement
  if (!keptFileId) {
    // The file could not be read by the caller: nothing is left half-imported.
    await ctx.db.update("agreements", id, { status: "withdrawn" })
    return refusal(
      "FILE_NOT_READABLE",
      `The file ${p.file_id} could not be read by you, so ${number} was not imported (it is withdrawn). Upload the PDF again and import it.`,
    )
  }
  const text = typeof p.unverified_text === "string" ? p.unverified_text.trim() : ""
  await ctx.db.update("agreements", id, {
    status: "imported",
    signed_at: p.signed_on ?? null,
    starts_on: p.starts_on ?? null,
    ends_on: p.ends_on ?? null,
    renews_on: p.renews_on ?? null,
    notice_days: typeof p.notice_days === "number" ? p.notice_days : null,
    imported_text: text || null,
  })
  await ctx.emit?.({
    entity: "agreement",
    action: "imported",
    entityId: id,
    data: { number, kind: p.kind },
  })
  return {
    status: "ok",
    agreement: {
      id,
      number,
      kind: p.kind,
      status: "imported",
      status_note: IMPORTED_LABEL,
      file_id: keptFileId,
      level: null,
      evidence: null,
      text: text ? "unverified" : null,
    },
    message: `${number} "${p.title.trim()}" is filed: ${IMPORTED_LABEL}. It has no Liaison evidence and no signature level${
      text ? "; the text read from the PDF is kept as unverified and is quoted only as such" : ""
    }. Nothing was sent.${p.ends_on || p.renews_on ? " Its dates count for renewals." : ""}`,
  }
}
