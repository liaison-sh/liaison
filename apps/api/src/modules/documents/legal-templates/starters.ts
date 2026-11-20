// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The starter agreement templates in the classic legal layout: seven services
// contracts and three corporate acts, each in English and French. They reach an
// organisation as `kernel.document_templates` rows (kind rich_text, record type
// agreements:agreement) through `seedLegalStarterTemplates`, which adds the
// missing ones and never touches a row an organisation already has (renamed,
// edited or archived ones included). The three corporate acts are added only
// while the agreements app's `corporateTemplates` feature is on.
//
// Every name ends with "starting point, review with a lawyer": these are
// drafts a firm adapts, never finished contracts.

import { and, eq, inArray } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { documentTemplates } from "~/db/schema/kernel"
import { contractBody, type StarterLang } from "./common"
import { CORPORATE_STARTERS, type CorporateStarterKey } from "./corporate"
import { SERVICES_STARTER_KIND, SERVICES_STARTERS, type ServicesStarterKey } from "./services"

/** The record type the starters print from: an agreement's filled source. */
export const STARTER_RECORD_TYPE = "agreements:agreement"

export const STARTER_REVIEW_NOTE: Record<StarterLang, string> = {
  en: "starting point, review with a lawyer",
  fr: "point de départ, à relire avec un avocat",
}

export interface LegalStarterTemplate {
  /** Stable key: `<starter>.<lang>`. */
  key: string
  starter: ServicesStarterKey | CorporateStarterKey
  lang: StarterLang
  /** The agreement kind the starter is for ("other" for a corporate act). */
  kind: string
  corporate: boolean
  name: string
  body: Record<string, unknown>
}

const LANGS: StarterLang[] = ["en", "fr"]

function starterName(title: string, lang: StarterLang): string {
  return `${title} (${lang.toUpperCase()}, ${STARTER_REVIEW_NOTE[lang]})`
}

/** Every starter, corporate ones included, in a fixed order. */
export function allLegalStarterTemplates(): LegalStarterTemplate[] {
  const out: LegalStarterTemplate[] = []
  for (const starter of Object.keys(SERVICES_STARTERS) as ServicesStarterKey[]) {
    for (const lang of LANGS) {
      const content = SERVICES_STARTERS[starter][lang]
      out.push({
        key: `${starter}.${lang}`,
        starter,
        lang,
        kind: SERVICES_STARTER_KIND[starter],
        corporate: false,
        name: starterName(content.title, lang),
        body: contractBody(lang, content),
      })
    }
  }
  for (const starter of Object.keys(CORPORATE_STARTERS) as CorporateStarterKey[]) {
    for (const lang of LANGS) {
      const c = CORPORATE_STARTERS[starter]
      out.push({
        key: `${starter}.${lang}`,
        starter,
        lang,
        kind: "other",
        corporate: true,
        name: starterName(c.title[lang], lang),
        body: c.body(lang),
      })
    }
  }
  return out
}

/** The starters an organisation is offered: the corporate ones only with the feature on. */
export function legalStarterTemplates(opts: {
  corporateTemplates: boolean
}): LegalStarterTemplate[] {
  return allLegalStarterTemplates().filter((t) => opts.corporateTemplates || !t.corporate)
}

/**
 * Add the starters an organisation lacks to `kernel.document_templates`, inside the caller's
 * transaction (org-scoped). A starter counts as present when a template of that name and record
 * type exists, archived or not: an organisation that archived or edited one keeps its choice.
 * Returns the names added.
 */
export async function seedLegalStarterTemplates(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  opts: { corporateTemplates: boolean },
): Promise<string[]> {
  const wanted = legalStarterTemplates(opts)
  if (wanted.length === 0) return []
  const existing = await tx
    .select({ name: documentTemplates.name })
    .from(documentTemplates)
    .where(
      and(
        eq(documentTemplates.orgId, orgId),
        eq(documentTemplates.recordType, STARTER_RECORD_TYPE),
        inArray(
          documentTemplates.name,
          wanted.map((t) => t.name),
        ),
      ),
    )
  const have = new Set(existing.map((r) => r.name))
  const missing = wanted.filter((t) => !have.has(t.name))
  if (missing.length === 0) return []
  await tx.insert(documentTemplates).values(
    missing.map((t) => ({
      orgId,
      name: t.name,
      kind: "rich_text" as const,
      recordType: STARTER_RECORD_TYPE,
      body: t.body,
      enabled: true,
    })),
  )
  return missing.map((t) => t.name)
}
