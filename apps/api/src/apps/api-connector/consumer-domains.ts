// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Consumer mail domains: an address there says nothing about the company its
 * owner works for, so the customer resolver never falls back from such an
 * address to a domain lookup (every gmail.com sender would otherwise match
 * whichever CRM record carries gmail.com). Families with a country domain per
 * market (yahoo.*, gmx.*, yandex.*) match by their first label.
 */

const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "web.de",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "wanadoo.fr",
  "sfr.fr",
  "aol.com",
  "mail.ru",
  "qq.com",
  "163.com",
])

/** `yahoo.fr`, `yahoo.co.uk`, `gmx.de`, `yandex.ru`: the family label, then a public suffix. */
const CONSUMER_MAIL_FAMILIES = ["yahoo", "gmx", "yandex"] as const

export function isConsumerMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase()
  if (CONSUMER_MAIL_DOMAINS.has(d)) return true
  const [first, ...rest] = d.split(".")
  if (!first || rest.length === 0 || rest.length > 2) return false
  return (
    (CONSUMER_MAIL_FAMILIES as readonly string[]).includes(first) &&
    rest.every((label) => /^[a-z]{2,3}$/.test(label))
  )
}
