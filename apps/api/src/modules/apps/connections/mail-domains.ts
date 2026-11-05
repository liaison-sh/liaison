// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which mailboxes an organisation lets its members connect.
//
// `organizations.settings.allowedMailDomains` lists the address domains a
// mailbox (a Gmail or IMAP connection, for Mail or Tickets) may belong to,
// e.g. ["acme.example"]. Connecting any other address is refused, with a
// message that names the allowed domains. An empty or absent list means no
// restriction. Matching is exact on the domain: "acme.example" does not admit
// "mail.acme.example" or "acme.example.evil.example"; list each domain.
//
// Set it as an org admin: PATCH /api/org {"settings":{"allowedMailDomains":
// ["acme.example"]}} (or `[]` to lift the restriction). It applies to new
// connections and re-connections; mailboxes already connected keep syncing.

import { sql } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { extractRows, type RlsClient } from "~/db"
import { privilegedFrom, withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

/** Connection names that are mailboxes, whichever app declares them. */
export const MAILBOX_CONNECTIONS: ReadonlySet<string> = new Set(["gmail", "imap"])

/** A 403 wherever it surfaces: the connect form shows its message as is. */
export class MailDomainNotAllowedError extends HTTPException {
  readonly code = "mail_domain_not_allowed"
  constructor(
    readonly address: string,
    readonly allowed: string[],
  ) {
    super(403, {
      message:
        `This organisation only connects mailboxes on ${allowed.map((d) => `@${d}`).join(", ")}. ` +
        `${address || "This mailbox"} is not one of them: connect a mailbox from an allowed domain, ` +
        "or ask an admin to add its domain.",
    })
  }
}

export function normalizeMailDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter((d) => d.length > 0),
    ),
  ]
}

/** The domain of an address, or null when it is not an address. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@")
  if (at <= 0 || at === address.length - 1) return null
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
}

export function isMailDomainAllowed(address: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  const domain = addressDomain(address)
  return domain !== null && allowed.includes(domain)
}

/**
 * The org's allowed mail domains. `on`: read on the caller's transaction
 * (privilegedFrom) instead of a new privileged one, so a caller holding a
 * privileged slot never asks the pool for a second.
 */
export async function loadAllowedMailDomains(
  orgId: string,
  on?: Pick<RlsClient, "execute">,
): Promise<string[]> {
  const read = async (tx: Pick<RlsClient, "execute">) => {
    const [row] = extractRows<{ domains: unknown }>(
      await tx.execute(sql`
        SELECT settings -> 'allowedMailDomains' AS domains
          FROM ${sql.raw(quoteIdent(schemaRef("kernel")))}.organizations
         WHERE id = ${orgId}::uuid`),
    )
    return normalizeMailDomains(row?.domains)
  }
  return on
    ? privilegedFrom(on, orgId, "mail-domain-policy", read)
    : withPrivilegedDb(orgId, "mail-domain-policy", read)
}

/**
 * Refuse connecting a mailbox outside the org's allowed domains. A no-op for
 * connections that are not mailboxes and for orgs with no restriction.
 */
export async function assertMailboxAllowed(
  orgId: string,
  connectionName: string,
  address: string,
  /** The IMAP login, when there is one: it is what actually authenticates. */
  username?: string | null,
  /** The caller's transaction, read on instead of a new one (loadAllowedMailDomains). */
  on?: Pick<RlsClient, "execute">,
): Promise<void> {
  if (!MAILBOX_CONNECTIONS.has(connectionName)) return
  const allowed = await loadAllowedMailDomains(orgId, on)
  if (!isMailDomainAllowed(address, allowed)) {
    throw new MailDomainNotAllowedError(address, allowed)
  }
  if (allowed.length === 0 || !username) return
  // An allowed display address with a login on another domain (or another
  // account) would connect a mailbox the policy refuses.
  const login = username.trim().toLowerCase()
  const ok = login.includes("@")
    ? isMailDomainAllowed(login, allowed)
    : login === address.trim().toLowerCase().split("@")[0]
  if (!ok) throw new MailDomainNotAllowedError(username, allowed)
}

/** The org's connected mailboxes outside its allowed domains (none if unrestricted). */
export function mailboxOutsideAllowedDomains(
  row: { connectionName: string; identifier: string; status: string },
  allowed: string[],
): boolean {
  return (
    allowed.length > 0 &&
    row.status === "active" &&
    MAILBOX_CONNECTIONS.has(row.connectionName) &&
    !isMailDomainAllowed(row.identifier, allowed)
  )
}
