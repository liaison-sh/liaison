// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared visual derivations for ContactList + ContactDetail.
// Keeping these out of the components avoids duplication and lets the
// store-level data (Contact) drive consistent identity across the module.

import { compactAge } from "~/lib/relative-time"
import { currentLocale, tNow } from "~/modules/i18n/i18n-context"

export function contactDisplayName(contact: {
  name?: string | null
  email?: string | null
}): string {
  const name = contact.name?.trim()
  if (name) return name
  const email = contact.email?.trim()
  if (email) return email
  return tNow("contacts.unnamedContact")
}

export function contactInitials(contact: { name?: string | null; email?: string | null }): string {
  const name = contact.name?.trim()
  if (name) {
    const parts = name.split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
  }
  const email = contact.email?.trim()
  if (email) return email.slice(0, 2).toUpperCase()
  return "?"
}

// Stable per-id slot in the app wide avatar palette. Using id (UUID) keeps the
// color stable across renames and refetches.
export { avatarColors } from "~/ui/avatar-palette"

// Relative age for dense lists, in the reader's language ("5m" / "5 min",
// "yesterday" / "hier"). It used to be hand-built English under every locale.
export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const age = compactAge(iso, currentLocale())
  return age === "" ? null : age
}

// Absolute timestamp for tooltips (full date + local time).
export function formatAbsoluteTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(currentLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
