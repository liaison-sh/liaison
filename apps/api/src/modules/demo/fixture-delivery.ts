// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fixture delivery: how a reply "reaches" a fictional customer in a demo org.
//
// A demo org may never put mail on the wire (demo-egress.ts). Its scenarios
// still need a reply to a customer to complete, and every customer, prospect
// and dealer the demo world invents lives on a reserved domain (RFC 2606 /
// RFC 6761: `.example`, `.invalid`, `.test`, `example.com|net|org`), which no
// real mailbox can own. So in a demo org a send whose EVERY recipient (to, cc,
// bcc and reply-to) is on such a domain is recorded as sent without leaving
// the process: no network, no provider, and never delivered to any inbox on
// this box (the visitor's own `visitor.demo.invalid` login included). One
// recipient anywhere else and the whole send keeps the existing refusal.
import { randomUUID } from "node:crypto"
import { isDemoOrgId } from "~/modules/demo/demo-org"

/** Top-level names reserved by RFC 2606 / RFC 6761 that never resolve to a real mailbox. */
const RESERVED_TLDS = new Set(["example", "invalid", "test", "localhost"])
/** Second-level names reserved by RFC 2606. */
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"])

/** The domain of an address, lowercased; null when it is not an address. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@")
  if (at <= 0 || at === address.length - 1) return null
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/>$/, "")
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null
}

/** The address is on a reserved, never-deliverable domain. */
export function isReservedAddress(address: string): boolean {
  const domain = domainOf(address)
  if (!domain) return false
  const labels = domain.split(".")
  const tld = labels[labels.length - 1] ?? ""
  if (RESERVED_TLDS.has(tld)) return true
  return RESERVED_DOMAINS.has(labels.slice(-2).join("."))
}

/** An address as the senders pass it: a bare string or `{email}`. */
export type FixtureAddress = string | { email: string; name?: string | null }

function emailOf(address: FixtureAddress): string {
  return typeof address === "string" ? address : address.email
}

/**
 * True when `orgId` is a demo org and every recipient of the send is on a
 * reserved domain (and there is at least one). False otherwise: the caller
 * keeps its refusal.
 */
export async function isDemoFixtureDelivery(
  orgId: string,
  recipients: readonly (FixtureAddress | null | undefined)[],
): Promise<boolean> {
  const addresses = recipients.flatMap((r) => (r ? [emailOf(r)] : []))
  if (addresses.length === 0) return false
  if (!addresses.every(isReservedAddress)) return false
  return isDemoOrgId(orgId)
}

/** The message id a fixture delivery records (never an id a provider issued). */
export function demoFixtureMessageId(domain = "demo.invalid"): string {
  return `<demo-fixture-${randomUUID()}@${domain}>`
}

/** What the scenario says about a fixture delivery (shown with the message). */
export const DEMO_FIXTURE_DELIVERY_LABEL = "Delivered to a fictional customer (demo)"
