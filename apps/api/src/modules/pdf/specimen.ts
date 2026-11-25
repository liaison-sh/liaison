// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Specimen mark of a document rendered in a demo workspace. A sample
// invoice in a public sandbox has a real number shape and real VAT layout, so
// it must not pass for a real one: the host hands every template a reserved
// `specimen` value (the footer line, in each shipped language) when the org is
// a demo, and the template draws it with its own text. Outside a demo the key
// is absent, whatever the app passed, so a real document's drawing is the same
// as before the mark existed. The host decides; no app can set or clear it.
//
// The same text goes into an embedded structured invoice (a CII XML attachment
// of a PDF/A-3) as an included note, so software reading the attachment sees
// the specimen too, and into the standalone copy of that XML an app stores as
// its own file. In a demo the app's own record of that copy (its fingerprint)
// describes the data it built, before the host's note.
import { SHIPPED_LOCALES, type ShippedLocale } from "@liaison/shared"
import { isDemoOrgId } from "~/modules/demo/demo-org"
import { serverT } from "~/modules/i18n/server-i18n"
import type { PdfAAttachment } from "./pdfa/finalize"

/** The reserved data key a template reads the mark from. */
export const SPECIMEN_DATA_KEY = "specimen"

/** The footer line in each shipped language. */
export function specimenTexts(): Record<ShippedLocale, string> {
  const out = {} as Record<ShippedLocale, string>
  for (const locale of SHIPPED_LOCALES) out[locale] = serverT(locale, "kernel.demo.specimenFooter")
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/**
 * The template data as the host hands it over: an app's own `specimen` is
 * dropped, and in a demo org the host's is set. Data that is not an object is
 * passed through untouched (no template of that shape draws a footer).
 */
export function withSpecimen(data: unknown, demo: boolean): unknown {
  if (!isPlainObject(data)) return data
  const { [SPECIMEN_DATA_KEY]: _ignored, ...rest } = data
  return demo ? { ...rest, [SPECIMEN_DATA_KEY]: specimenTexts() } : rest
}

/** One line holding every shipped language's text, for a note read by software. */
export function specimenNoteText(): string {
  return [...new Set(Object.values(specimenTexts()))].join(" / ")
}

const CII_ROOT = /<rsm:CrossIndustryInvoice[\s>]/
const EXCHANGED_DOCUMENT_END = "</rsm:ExchangedDocument>"

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * A CII invoice with the specimen note added to its document header, as its
 * last included note (the schema's order: ID, TypeCode, IssueDateTime, then
 * IncludedNote). Any other XML is returned unchanged.
 */
export function ciiWithSpecimenNote(xml: string, text: string): string {
  if (!CII_ROOT.test(xml)) return xml
  const at = xml.indexOf(EXCHANGED_DOCUMENT_END)
  if (at < 0) return xml
  const note = `<ram:IncludedNote><ram:Content>${xmlEscape(text)}</ram:Content><ram:SubjectCode>AAI</ram:SubjectCode></ram:IncludedNote>`
  return `${xml.slice(0, at)}${note}${xml.slice(at)}`
}

/** The attachments of a demo document, each embedded CII invoice carrying the specimen note. */
export function attachmentsWithSpecimen(attachments: PdfAAttachment[]): PdfAAttachment[] {
  const text = specimenNoteText()
  return attachments.map((a) => {
    if (!/xml/i.test(a.mime)) return a
    const xml = new TextDecoder().decode(a.bytes)
    const stamped = ciiWithSpecimenNote(xml, text)
    return stamped === xml ? a : { ...a, bytes: new TextEncoder().encode(stamped) }
  })
}

/**
 * The bytes an app stores as a file of its own (`files_importAttachment`). In a
 * demo workspace a CII invoice the app made carries the specimen note, so the
 * standalone copy of an invoice's data says specimen as the copy embedded in its
 * PDF does (the two stay the same bytes). Everywhere else, and for any other
 * file or one fetched from a provider, the bytes are the app's own, unchanged.
 * The host decides from the org alone: the app has nothing to pass for it.
 */
export async function storedBytesWithSpecimen(
  orgId: string,
  file: { mimeType: string; bytes: Uint8Array; fromNetwork: boolean },
): Promise<Uint8Array> {
  if (file.fromNetwork || !/xml/i.test(file.mimeType)) return file.bytes
  const xml = new TextDecoder().decode(file.bytes)
  if (!CII_ROOT.test(xml)) return file.bytes
  if (!(await renderIsDemo(orgId))) return file.bytes
  const stamped = ciiWithSpecimenNote(xml, specimenNoteText())
  return stamped === xml ? file.bytes : new TextEncoder().encode(stamped)
}

const pendingDemoLookups = new Map<string, Promise<boolean>>()

/**
 * Is `orgId` a demo workspace, for a render? Concurrent renders of one org share
 * one lookup, so a burst reaches the render pool together, as it did before the
 * mark existed (the per-org cap still sees it as a burst).
 */
export function renderIsDemo(orgId: string): Promise<boolean> {
  const pending = pendingDemoLookups.get(orgId)
  if (pending) return pending
  const lookup = isDemoOrgId(orgId).finally(() => pendingDemoLookups.delete(orgId))
  pendingDemoLookups.set(orgId, lookup)
  return lookup
}
