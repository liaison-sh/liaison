// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What kind of mailbox an address is, so the agent, `liaison guide` and
 * `liaison connect` pick the same connect path (googleConnectPath):
 *
 * - gmail.com / googlemail.com: a personal Google account, no lookup.
 * - Other public providers (PUBLIC_EMAIL_PROVIDERS): Microsoft's consumer
 *   domains are `microsoft`, the rest `other` (with the IMAP provider when known).
 * - A company domain: its MX records. Google's mail servers mean Google
 *   Workspace, Microsoft's mean Microsoft 365, iCloud's and Fastmail's name
 *   that provider; anything else is `other`.
 * - The lookup fails or times out: `unknown`. Never a guess: the caller asks
 *   the person who hosts the mailbox.
 */
import { resolveMx } from "node:dns/promises"
import { type ImapProvider, isPublicEmailProvider, type MailAccountType } from "@liaison/shared"
import { boundedBy } from "~/lib/bounded"

export interface MailAccountTypeResult {
  accountType: MailAccountType
  /** The IMAP provider of IMAP_PROVIDERS this mailbox is on, when known. */
  imapProvider?: ImapProvider
  domain: string | null
}

/** Resolves a domain's MX hosts (node's resolveMx in production; tests inject one). */
export type MxResolver = (domain: string) => Promise<Array<{ exchange: string }>>

const MX_TIMEOUT_MS = 3000

const GOOGLE_CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"])
const MICROSOFT_CONSUMER_DOMAINS = new Set([
  "outlook.com",
  "hotmail.com",
  "hotmail.fr",
  "live.com",
  "live.fr",
  "msn.com",
])
const ICLOUD_DOMAINS = new Set(["icloud.com", "me.com", "mac.com"])
const FASTMAIL_DOMAINS = new Set(["fastmail.com", "fastmail.fm"])

/** True when `host` is `suffix` or a subdomain of it. */
function hostIs(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

function fromDomain(domain: string): Omit<MailAccountTypeResult, "domain"> | null {
  if (GOOGLE_CONSUMER_DOMAINS.has(domain)) {
    return { accountType: "google_consumer", imapProvider: "gmail" }
  }
  if (MICROSOFT_CONSUMER_DOMAINS.has(domain)) {
    return { accountType: "microsoft", imapProvider: "outlook" }
  }
  if (ICLOUD_DOMAINS.has(domain)) return { accountType: "other", imapProvider: "icloud" }
  if (FASTMAIL_DOMAINS.has(domain)) return { accountType: "other", imapProvider: "fastmail" }
  if (isPublicEmailProvider(domain)) return { accountType: "other" }
  return null
}

function fromMx(hosts: string[]): Omit<MailAccountTypeResult, "domain"> {
  const any = (suffixes: string[]) => hosts.some((h) => suffixes.some((s) => hostIs(h, s)))
  if (any(["google.com", "googlemail.com"])) {
    return { accountType: "google_workspace", imapProvider: "gmail" }
  }
  if (any(["outlook.com", "protection.outlook.com"])) {
    return { accountType: "microsoft", imapProvider: "outlook" }
  }
  if (any(["icloud.com"])) return { accountType: "other", imapProvider: "icloud" }
  if (any(["messagingengine.com", "fastmail.com"])) {
    return { accountType: "other", imapProvider: "fastmail" }
  }
  return { accountType: "other" }
}

/** The domain of an address, lower-cased, or null when it is not one. */
function domainOf(email: string): string | null {
  const at = email.trim().lastIndexOf("@")
  if (at < 1) return null
  const domain = email
    .trim()
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "")
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null
}

export async function detectMailAccountType(
  email: string,
  options: { resolver?: MxResolver; timeoutMs?: number } = {},
): Promise<MailAccountTypeResult> {
  const domain = domainOf(email)
  if (!domain) return { accountType: "unknown", domain: null }
  const known = fromDomain(domain)
  if (known) return { ...known, domain }
  const resolver = options.resolver ?? resolveMx
  try {
    const records = await boundedBy(
      resolver(domain),
      options.timeoutMs ?? MX_TIMEOUT_MS,
      () => new Error("mx lookup timed out"),
    )
    const hosts = records.map((r) => r.exchange.toLowerCase().replace(/\.$/, "")).filter(Boolean)
    if (hosts.length === 0) return { accountType: "unknown", domain }
    return { ...fromMx(hosts), domain }
  } catch {
    return { accountType: "unknown", domain }
  }
}
