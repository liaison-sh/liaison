// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * AN APP, A SEARCH RESULT TYPE AND A SEEDED ROLE NAME, AS THE READER SAYS THEM.
 *
 * App ids ("invoicing", "monitoring"), search entity types ("document", "task") and the
 * system-managed "Full Member" role are identifiers the server hands over in English. They
 * were printed raw in the French admin, search and attention-rules screens (third QA walk).
 * Each is looked up in the catalog and falls back to the value as written, so an app or a
 * type the catalog does not know yet still reads, and a name someone chose stays theirs.
 */
import { appDisplayNames } from "~/lib/capability-copy"
import {
  catalogHasKey,
  currentLocale,
  seededCopy,
  type Translate,
} from "~/modules/i18n/i18n-context"

/** The app's name: the catalog's in a translated locale, else the manifest's, else the id. */
export function appLabel(app: string, t: Translate, displayName?: string | null): string {
  const key = `kernel.capabilities.apps.${app}`
  const known = catalogHasKey(key)
  if (known && currentLocale() !== "en") return t(key)
  if (displayName) return displayName
  return known ? t(key) : app
}

/** Words an identifier spells that are read as initials: "imap" is IMAP, never "Imap". */
const INITIALISMS = new Set([
  "api",
  "imap",
  "smtp",
  "pop3",
  "mcp",
  "sso",
  "url",
  "vat",
  "crm",
  "erp",
  "sms",
  "ftp",
  "sftp",
])

/** An identifier in words: "api_token" reads "API token", "imap" reads "IMAP". */
export function humanizeId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim()
  if (!words) return id
  const spelled = words
    .split(" ")
    .map((w) => (INITIALISMS.has(w.toLowerCase()) ? w.toUpperCase() : w))
    .join(" ")
  return spelled.charAt(0).toUpperCase() + spelled.slice(1)
}

/**
 * A connection's name as the reader says it: what the manifest declares it
 * connects (`purpose`, else its description); the app's own name for a
 * connection named after the app ("gitlab" reads "GitLab"); else the id in
 * words. Never the raw id.
 */
export function connectionLabel(
  app: string,
  conn: { name: string; purpose?: string; description?: string },
  t: Translate,
  appDisplayName?: string | null,
): string {
  if (conn.purpose) return conn.purpose
  if (conn.description) return conn.description
  if (conn.name === app) {
    const name = appLabel(app, t, appDisplayName)
    if (name !== app) return name
  }
  return humanizeId(conn.name)
}

/** A search result's type ("tâche"), or the type as written when the catalog lacks it. */
export function entityTypeLabel(type: string, t: Translate): string {
  const key = `kernel.searchUi.entityTypes.${type}`
  return catalogHasKey(key) ? t(key) : type
}

/**
 * A role's name as the reader says it. An app's own role (`<app>.<tier>`, the
 * roles an app's manifest declares) reads as the app's name and the tier
 * ("API connector · Admin"); the seeded "Full Member" in the reader's
 * language; any other name as written. A dotted name whose prefix is no app
 * this client knows is someone's chosen name and stays theirs.
 */
export function roleDisplayName(
  name: string,
  t: Translate,
  displayNames: Record<string, string> = appDisplayNames(),
): string {
  const dot = name.indexOf(".")
  if (dot > 0) {
    const app = name.slice(0, dot)
    const tier = name.slice(dot + 1)
    const knownApp = Boolean(displayNames[app]) || catalogHasKey(`kernel.capabilities.apps.${app}`)
    if (knownApp && tier && !tier.includes(".")) {
      const tierKey = `kernel.roleNames.tiers.${tier}`
      return t("kernel.roleNames.appTier", {
        app: appLabel(app, t, displayNames[app]),
        tier: catalogHasKey(tierKey) ? t(tierKey) : humanizeId(tier),
      })
    }
  }
  return seededCopy(name, "kernel.roleNames.fullMember", t)
}
