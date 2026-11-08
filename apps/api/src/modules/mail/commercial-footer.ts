// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a commercial mail carries at the moment it leaves, added after the send
 * check so nothing here reaches an approver's payload: the organization's legal
 * name and postal address, an opt-out link, "or reply stop", and the
 * `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058) built from
 * the same link.
 *
 * The identity lives in `organizations.settings.commercialIdentity`, written by
 * `config apply` (`email.commercialIdentity`) or the organization settings page.
 * Without a legal name and a postal address no commercial mail stages or sends.
 *
 * One link per send: `mintOptOutLink` stores the sha256 of a 32 byte random
 * token beside the fingerprint of the recipient's address (never the address),
 * and the org comes from that row when the link is opened. Links older than
 * three years are pruned daily.
 */
import { createHash, randomBytes } from "node:crypto"
import { type CommercialIdentity, commercialIdentitySchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { escapeHtml } from "~/lib/html-page"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { hashEmail } from "~/modules/mail/suppressions"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** Where a person sets the identity, as the refusal names it. */
export const COMMERCIAL_IDENTITY_SETTING =
  "Settings > Organization > Commercial identity (or config_email, key commercialIdentity)"

/** The country policy when the org has set none: France allows professional interest, elsewhere consent. */
export const DEFAULT_COUNTRY_POLICY: Record<string, "optout" | "consent"> = {
  FR: "optout",
  default: "consent",
}

/** How long an opt-out link keeps working. */
export const OPT_OUT_LINK_RETENTION_DAYS = 3 * 365

export interface CommercialFooter {
  body: string
  headers: Record<string, string>
}

export interface OptOutLink {
  url: string
}

/** The org's commercial identity, or null when it is unset or no longer valid. */
export async function readCommercialIdentity(
  orgId: string,
  db?: PrivilegedDb,
): Promise<CommercialIdentity | null> {
  const read = async (tx: PrivilegedDb) =>
    extractRows<{ v: unknown }>(
      await tx.execute(drizzleSql`
        SELECT settings -> 'commercialIdentity' AS v FROM ${K()}.organizations
         WHERE id = ${orgId}::uuid`),
    )
  const rows = db ? await read(db) : await withPrivilegedDb(orgId, "commercial-identity", read)
  const parsed = commercialIdentitySchema.safeParse(rows[0]?.v)
  if (!parsed.success) return null
  return {
    ...parsed.data,
    countryPolicy: parsed.data.countryPolicy ?? DEFAULT_COUNTRY_POLICY,
  }
}

/** True when the org lacks what a commercial mail must state. */
export async function commercialIdentityMissing(orgId: string): Promise<boolean> {
  return (await readCommercialIdentity(orgId)) === null
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** A well-formed link token: 32 bytes, base64url. Anything else is never looked up. */
export function isOptOutToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

/** A new opt-out link for one recipient of one send. */
export async function mintOptOutLink(orgId: string, recipient: string): Promise<OptOutLink> {
  const token = randomBytes(32).toString("base64url")
  await withPrivilegedDb(orgId, "opt-out-link-mint", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${K()}.suppression_links (token_hash, org_id, email_hash)
      VALUES (${tokenHash(token)}, ${orgId}::uuid, ${hashEmail(orgId, recipient)})`),
  )
  const base = (await orgPublicBaseUrl(orgId)).replace(/\/$/, "")
  return { url: `${base}/public/opt-out/${token}` }
}

/** The org and address fingerprint a link was made for; null for an unknown token. */
export async function resolveOptOutToken(
  token: string,
): Promise<{ orgId: string; emailHash: string } | null> {
  if (!isOptOutToken(token)) return null
  const rows = await withSystemDb("opt-out-link-resolve", async (tx) =>
    extractRows<{ org_id: string; email_hash: string }>(
      await tx.execute(drizzleSql`
        SELECT org_id::text AS org_id, email_hash FROM ${K()}.suppression_links
         WHERE token_hash = ${tokenHash(token)}`),
    ),
  )
  const row = rows[0]
  return row ? { orgId: row.org_id, emailHash: row.email_hash } : null
}

/** Deletes links older than the retention; returns how many went. */
export async function pruneOptOutLinks(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OPT_OUT_LINK_RETENTION_DAYS * 86_400_000)
  const rows = await withSystemDb("opt-out-link-prune", async (tx) =>
    extractRows<{ token_hash: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${K()}.suppression_links WHERE created_at < ${cutoff.toISOString()}::timestamptz
        RETURNING token_hash`),
    ),
  )
  return rows.length
}

/** The headers a mail client's unsubscribe button uses, from the mail's one link. */
export function optOutHeaders(link: OptOutLink): Record<string, string> {
  return {
    "List-Unsubscribe": `<${link.url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }
}

function footerLines(identity: CommercialIdentity, link: OptOutLink, notice?: string): string[] {
  return [
    `${identity.legalName}, ${identity.postalAddress}`,
    ...(notice ? [notice] : []),
    `To stop commercial messages from ${identity.legalName}: ${link.url} or reply stop.`,
  ]
}

/**
 * The body with the commercial footer: plain lines after a text body, an
 * escaped block before `</body>` of an HTML body (or at its end). `notice` is
 * an extra line (where the recipient's address came from) when one applies.
 * Throws when the identity is unset: a commercial mail never leaves without it.
 */
export async function applyCommercialFooter(
  orgId: string,
  body: string,
  opts: { kind: "text" | "html"; link: OptOutLink; notice?: string },
  identity?: CommercialIdentity,
): Promise<CommercialFooter> {
  const id = identity ?? (await readCommercialIdentity(orgId))
  if (!id) throw new Error("commercial_identity_missing")
  const lines = footerLines(id, opts.link, opts.notice)
  const headers = optOutHeaders(opts.link)
  if (opts.kind === "text") {
    return { body: `${body.replace(/\s+$/, "")}\n\n--\n${lines.join("\n")}\n`, headers }
  }
  const block =
    `<div style="margin-top:24px;font-size:12px;color:#666">` +
    lines
      .map((line) => {
        const escaped = escapeHtml(line)
        const href = escapeHtml(opts.link.url)
        return `<p style="margin:4px 0">${escaped.replace(href, `<a href="${href}">${href}</a>`)}</p>`
      })
      .join("") +
    `</div>`
  const at = body.search(/<\/body\s*>/i)
  return {
    body: at >= 0 ? `${body.slice(0, at)}${block}${body.slice(at)}` : `${body}${block}`,
    headers,
  }
}
