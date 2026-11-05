// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH ORG USERS ARE IMPORT PLACEHOLDERS, not people.
//
// An import (the Slack importer, apps/api/src/cli/slack/import.ts) keeps the
// exact author of every historical message by creating a DEACTIVATED user for
// each author who is not a member of the org: leavers, bots, the importer
// itself. Those rows have no password and an address on the reserved
// `.invalid` TLD (RFC 2606), so they can never sign in or receive mail. They
// are history authors, not people: people lists hide them, and reactivating
// one only creates a confusing second "person" with a real colleague's name.
//
// kernel.users carries no marker column, so the email domain IS the marker.
// This module is the one place that knows it: the importer builds addresses
// with it, the API filters and guards with it, the web labels with it.
//
// Not covered: the projects importer (cli/projects/import.ts) creates its
// deactivated users with the person's REAL email, on purpose, so that an admin
// can later reactivate that account to onboard them. Those are people.

/** The reserved domain of every import placeholder address. */
export const IMPORT_PLACEHOLDER_EMAIL_DOMAIN = "import.invalid"

/**
 * The SQL `LIKE` pattern matching a placeholder address. Compare it against
 * `lower(email)`; `_` and `%` do not occur in the domain, so it needs no escape.
 */
export const IMPORT_PLACEHOLDER_EMAIL_LIKE = `%@${IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`

/** The placeholder address for an importer (`slack-import`) and a stable key. */
export function importPlaceholderEmail(source: string, key: string): string {
  const local = key.toLowerCase().replace(/[^a-z0-9._-]/g, "-")
  return `${source}+${local}@${IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`
}

/** True when this address belongs to an import placeholder, not a person. */
export function isImportPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return email.trim().toLowerCase().endsWith(`@${IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`)
}
