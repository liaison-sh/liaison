// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One mailbox, one identity: the address rules of the demo door.
//
// A visitor's budget is keyed on the address they confirm, so the address has
// to be reduced to the MAILBOX it reaches before it is used as a key. Otherwise
// `jane+1@gmail.com`, `j.ane@googlemail.com` and `JANE@gmail.com` are three
// budgets for one inbox. `normalizeDemoEmail` does that reduction, and it is the
// only form stored as `email_normalized` on the lead.
//
// Three lists, all committed snapshots so the rules are reviewable and never
// depend on a lookup at signup time:
//
//   disposable-domains.txt  throwaway-inbox providers (CC0 list). Refused.
//   relay-domains.txt       alias relays (Hide My Email, duck.com, ...). One
//                           person mints unlimited addresses there, so each
//                           relay is capped like a small domain even when its
//                           parent is a major provider.
//   public-suffix.dat       the Public Suffix List (ICANN section), so a cap on
//                           "a domain" is a cap on its REGISTRABLE domain:
//                           `a.evil.example` and `b.evil.example` share one.
//
// Major mailbox providers (gmail.com, outlook.com, ...) are not capped per
// domain: millions of unrelated people share them, and the per-email budget,
// the per-network caps and the box caps already bound one person there.
import { readFileSync } from "node:fs"
import path from "node:path"
import { domainToASCII } from "node:url"

function readList(file: string): string[] {
  return readFileSync(path.join(import.meta.dir, file), "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("//"))
}

let disposable: Set<string> | null = null
let relays: Set<string> | null = null

interface SuffixRules {
  exact: Set<string>
  wildcard: Set<string>
  exception: Set<string>
}
let suffixRules: SuffixRules | null = null

function asciiDomain(domain: string): string {
  const ascii = domainToASCII(domain.trim().toLowerCase().replace(/\.$/, ""))
  return ascii === "" ? domain.trim().toLowerCase() : ascii
}

function loadSuffixRules(): SuffixRules {
  if (suffixRules) return suffixRules
  const rules: SuffixRules = { exact: new Set(), wildcard: new Set(), exception: new Set() }
  for (const raw of readList("public-suffix.dat")) {
    if (raw.startsWith("!")) rules.exception.add(asciiDomain(raw.slice(1)))
    else if (raw.startsWith("*.")) rules.wildcard.add(asciiDomain(raw.slice(2)))
    else rules.exact.add(asciiDomain(raw))
  }
  suffixRules = rules
  return rules
}

/** Mailbox providers whose domain is shared by unrelated people: no per-domain cap. */
const MAJOR_PROVIDERS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "aol.com",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "mail.com",
  "qq.com",
  "163.com",
])

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"])
const PROTON_DOMAINS = new Set(["proton.me", "protonmail.com", "protonmail.ch", "pm.me"])
/** Yahoo's mail domains: `base-keyword@` is a disposable address of `base@` (Yahoo names never hold `-`). */
const YAHOO_DOMAIN = /^(?:yahoo\.[a-z]{2,3}(?:\.[a-z]{2})?|ymail\.com|rocketmail\.com)$/
/** Fastmail's subdomain addressing: `anything@user.fastmail.com` reaches `user@fastmail.com`. */
const FASTMAIL_DOMAINS = ["fastmail.com", "fastmail.fm"]

/** The part after the last `@`, punycoded. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@")
  return asciiDomain(at === -1 ? "" : email.slice(at + 1))
}

/**
 * The mailbox an address reaches: lowercased, the domain punycoded, `+tag`
 * dropped on every domain, dots dropped for Gmail (and googlemail.com read as
 * gmail.com), the Proton family read as proton.me, Yahoo's `base-keyword`
 * disposable addresses read as `base`, and Fastmail's `anything@user.<host>`
 * read as `user@<host>`.
 */
export function normalizeDemoEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0) return trimmed
  let local = trimmed.slice(0, at)
  let domain = asciiDomain(trimmed.slice(at + 1))
  const plus = local.indexOf("+")
  if (plus > 0) local = local.slice(0, plus)
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com"
    local = local.replace(/\./g, "")
  } else if (PROTON_DOMAINS.has(domain)) {
    domain = "proton.me"
  } else if (YAHOO_DOMAIN.test(domain)) {
    const dash = local.indexOf("-")
    if (dash > 0) local = local.slice(0, dash)
  } else {
    const host = FASTMAIL_DOMAINS.find((h) => domain.endsWith(`.${h}`))
    if (host) {
      const user =
        domain
          .slice(0, -(host.length + 1))
          .split(".")
          .pop() ?? ""
      if (user !== "") {
        local = user
        domain = host
      }
    }
  }
  return `${local}@${domain}`
}

/**
 * The registrable domain (public suffix plus one label) of a domain, per the
 * committed Public Suffix List. A bare suffix, or anything unparseable, is
 * returned as is.
 */
export function registrableDomain(domain: string): string {
  const ascii = asciiDomain(domain)
  const labels = ascii.split(".").filter((l) => l !== "")
  if (labels.length < 2) return ascii
  const rules = loadSuffixRules()
  // Longest matching suffix, per the PSL algorithm (default rule "*").
  let suffixLength = 1
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".")
    if (rules.exception.has(candidate)) {
      suffixLength = labels.length - i - 1
      break
    }
    if (rules.exact.has(candidate)) {
      suffixLength = Math.max(suffixLength, labels.length - i)
      break
    }
    const parent = labels.slice(i + 1).join(".")
    if (parent !== "" && rules.wildcard.has(parent)) {
      suffixLength = Math.max(suffixLength, labels.length - i)
      break
    }
  }
  if (suffixLength >= labels.length) return ascii
  return labels.slice(labels.length - suffixLength - 1).join(".")
}

/** Is this domain (or any parent of it) a disposable-inbox provider? */
export function isDisposableDomain(domain: string): boolean {
  if (!disposable) disposable = new Set(readList("disposable-domains.txt"))
  const labels = asciiDomain(domain).split(".")
  for (let i = 0; i < labels.length - 1; i++) {
    if (disposable.has(labels.slice(i).join("."))) return true
  }
  return false
}

/** Is this domain (or a parent of it) an alias relay? */
export function isRelayDomain(domain: string): boolean {
  if (!relays) relays = new Set(readList("relay-domains.txt"))
  const labels = asciiDomain(domain).split(".")
  for (let i = 0; i < labels.length - 1; i++) {
    if (relays.has(labels.slice(i).join("."))) return true
  }
  return false
}

/**
 * The key the per-domain verification cap counts on, or null when the domain
 * is a major provider (uncapped). Relays are capped on the relay host itself,
 * even under a major parent; every other domain on its registrable domain.
 */
export function demoDomainCapKey(normalizedEmail: string): string | null {
  const domain = emailDomain(normalizedEmail)
  if (isRelayDomain(domain)) {
    if (!relays) relays = new Set(readList("relay-domains.txt"))
    const labels = domain.split(".")
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".")
      if (relays.has(candidate)) return candidate
    }
  }
  const registrable = registrableDomain(domain)
  if (MAJOR_PROVIDERS.has(registrable)) return null
  return registrable
}

/** `jane@example.com` → `j•••@example.com`: enough to recognise, not to harvest. */
export function maskDemoEmail(email: string): string {
  const at = email.lastIndexOf("@")
  if (at <= 0) return "•••"
  return `${email.slice(0, 1)}•••${email.slice(at)}`
}
