// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared pieces of the small self-contained HTML pages the server renders
// itself (sign-in handoffs, connect popups, maintenance): escaping, the
// visitor's language when there is no session to read, and the hash a
// Content-Security-Policy pins an inline style or script by.

import { createHash } from "node:crypto"
import { resolveLocale, type ShippedLocale } from "@liaison/shared"

/** Escape a value for HTML text or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** The visitor's language, from an Accept-Language header, in the header's order. */
export function localeFromAcceptLanguage(header: string | undefined): ShippedLocale {
  const candidates = (header ?? "")
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter((part): part is string => !!part)
  return resolveLocale(...candidates)
}

/** The base64 sha256 of an inline style or script, as a CSP `'sha256-...'` source takes it. */
export function cspHash(value: string): string {
  return createHash("sha256").update(value).digest("base64")
}

/**
 * The policy of a page that loads nothing: its one inline stylesheet is
 * allowed by hash, `extraDirectives` (an inline script's hash, say) follow
 * it, and nothing else loads, frames the page or is submitted from it.
 */
export function hashedStyleCsp(style: string, extraDirectives: readonly string[] = []): string {
  return [
    "default-src 'none'",
    `style-src 'sha256-${cspHash(style)}'`,
    ...extraDirectives,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}
