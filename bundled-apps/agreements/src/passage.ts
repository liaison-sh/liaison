// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The quote source. A passage is cut from the version's own frozen text (`source_text`), never
// from its Knowledge copy and never from what a model remembers: a section is found by its
// number at the start of a line and runs to the next heading of the same or a higher level.
// No readable text, or no such section, answers so and quotes nothing. An imported agreement has
// no version: its passage is cut from the text read from its PDF (`imported_text`), which nobody
// verified. That answer says so, and names its source as an uploaded file, so the read taints the
// turn like any other outside text.

import { type AgreementsCtx, type ErrorEnvelope, refusal } from "./ctx"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECTION = /^\d+(?:\.\d+)*$/
/** A heading line: optional "Section"/"Article", a dotted number, then a space, a dot or the end. */
const HEADING = /^\s*(?:(?:section|article)\s+)?(\d+(?:\.\d+)*)\.?(?:\s|$)/i

interface PassageVersion {
  id: string
  agreement_id: string
  number: number
  status: string
  sha256?: string | null
  source_text?: string | null
  source_kind?: string | null
}

/** The sections a text holds, by number, in order. */
export function sectionsOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const m = HEADING.exec(line)
    if (m?.[1] && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** The text of one section, its heading line included, or null when the text has no such section. */
export function cutSection(text: string, section: string): string | null {
  const lines = text.split("\n")
  const depth = section.split(".").length
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i] ?? "")
    if (m?.[1] === section) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING.exec(lines[i] ?? "")
    if (m?.[1] && m[1].split(".").length <= depth) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join("\n").trim()
}

/** The section of an imported agreement's unverified text, read from its PDF. */
async function importedPassage(
  ctx: AgreementsCtx,
  agreementId: string,
  section: string,
): Promise<Record<string, unknown> | ErrorEnvelope> {
  const agreement = (
    UUID.test(agreementId) ? await ctx.db.findOne("agreements", agreementId) : null
  ) as {
    id: string
    number: string
    status: string
    imported_text?: string | null
  } | null
  if (agreement?.status !== "imported")
    return refusal(
      "NOT_FOUND",
      `No imported agreement ${agreementId} you can see. A signed or sent agreement is quoted by its version_id (agreement_get lists them).`,
    )
  const ref = {
    agreement: { id: agreement.id, number: agreement.number, status: "imported" },
    version: null,
    source_kind: "uploaded",
    unverified: true,
  }
  const text = agreement.imported_text ?? ""
  if (text.trim() === "")
    return {
      status: "error",
      error: {
        code: "NOT_READABLE",
        message: `${agreement.number} was imported with no text read from its PDF, so nothing can be quoted from it. Say that you could not read it; never quote it from memory.`,
      },
      ...ref,
    }
  const cut = cutSection(text, section)
  if (cut === null) {
    const known = sectionsOf(text)
    return {
      status: "error",
      error: {
        code: "SECTION_NOT_FOUND",
        message: `The text read from ${agreement.number}'s PDF has no section ${section}. Its sections: ${known.length > 0 ? known.join(", ") : "none numbered"}. Nothing was quoted.`,
      },
      ...ref,
    }
  }
  return {
    status: "ok",
    ...ref,
    passage: { section, text: cut },
    note: `Unverified: read from the PDF of ${agreement.number}, imported and signed outside Liaison, section ${section}. Quote it only as unverified.`,
  }
}

export async function agreementPassageGet(
  ctx: AgreementsCtx,
  p: { version_id?: string; agreement_id?: string; section?: string },
): Promise<Record<string, unknown> | ErrorEnvelope> {
  if (p?.version_id === undefined && typeof p?.agreement_id === "string") {
    const section = typeof p.section === "string" ? p.section.trim().replace(/\.$/, "") : ""
    if (!SECTION.test(section))
      return refusal(
        "INVALID_SECTION",
        "section is a section number such as 8 or 8.2. Nothing was read.",
      )
    return importedPassage(ctx, p.agreement_id, section)
  }
  const versionId = p?.version_id
  if (typeof versionId !== "string" || !UUID.test(versionId))
    return refusal(
      "NOT_FOUND",
      "No agreement version with this id. Read the agreement with agreement_get for its versions.",
    )
  const section = typeof p.section === "string" ? p.section.trim().replace(/\.$/, "") : ""
  if (!SECTION.test(section))
    return refusal(
      "INVALID_SECTION",
      "section is a section number such as 8 or 8.2. Nothing was read.",
    )
  const version = (await ctx.db.findOne("agreement_versions", versionId)) as PassageVersion | null
  if (!version)
    return refusal(
      "NOT_FOUND",
      `No agreement version ${versionId} you can see. Read the agreement with agreement_get for its versions.`,
    )
  const agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as {
    id: string
    number: string
  } | null
  if (!agreement)
    return refusal("NOT_FOUND", "No agreement you can see holds this version. Nothing was read.")
  const ref = {
    agreement: { id: agreement.id, number: agreement.number },
    version: {
      id: version.id,
      number: version.number,
      status: version.status,
      sha256: version.sha256 ?? null,
      source_kind: version.source_kind ?? null,
    },
  }
  const text = version.source_text ?? ""
  if (text.trim() === "")
    return {
      status: "error",
      error: {
        code: "NOT_READABLE",
        message: `${agreement.number} version ${version.number} has no readable text, so nothing can be quoted from it. Say that you could not read it; never quote it from memory.`,
      },
      ...ref,
    }
  const cut = cutSection(text, section)
  if (cut === null) {
    const known = sectionsOf(text)
    return {
      status: "error",
      error: {
        code: "SECTION_NOT_FOUND",
        message: `${agreement.number} version ${version.number} has no section ${section}. Its sections: ${known.length > 0 ? known.join(", ") : "none numbered"}. Nothing was quoted.`,
      },
      ...ref,
    }
  }
  return {
    status: "ok",
    ...ref,
    passage: { section, text: cut },
    note: `Quoted from the signed text of ${agreement.number} version ${version.number}, section ${section}.`,
  }
}
