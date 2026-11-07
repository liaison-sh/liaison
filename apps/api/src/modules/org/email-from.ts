// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-org transactional email identity resolvers (Task 7).
 *
 * Transactional sends (invitations, password resets) thread a per-org `from`
 * and `replyTo` so a deployment can brand its outbound mail without changing the
 * global SMTP/Resend transport. The values live in the passthrough kernel
 * settings (`settings.email.{from,replyTo}`), written by the email provisioner.
 *
 * Resolution:
 * - `getOrgEmailConfig(orgId)` → `{ from, replyTo }` in one DB read (use at
 *   send sites that need both headers).
 * - `getOrgEmailFrom(orgId)` → `settings.email.from` if set, else `env.EMAIL_FROM`
 *   (the deployment-wide default; always a non-empty string).
 * - `getOrgEmailReplyTo(orgId)` → `settings.email.replyTo` if set, else `undefined`
 *   (no global reply-to default — an absent override means "don't set Reply-To").
 *
 * Handle: `withPrivilegedDb` (org-scoped read of kernel settings).
 */
import { orgKernelSettingsSchema } from "@liaison/shared"
import { eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { type EmailProvider, orgSenderProvider } from "~/infra/email"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

/**
 * Resolve both per-org email headers in a SINGLE DB read. Use this at send
 * sites that need both `from` and `replyTo` to avoid two sequential round-trips.
 */
export async function getOrgEmailConfig(
  orgId: string,
): Promise<{ from: string; replyTo: string | undefined }> {
  const settings = await withPrivilegedDb(orgId, "email-config-resolve", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const from = settings.email?.from
  const replyTo = settings.email?.replyTo
  return {
    from: from && from.length > 0 ? from : env.EMAIL_FROM,
    replyTo: replyTo && replyTo.length > 0 ? replyTo : undefined,
  }
}

/**
 * Resolve the per-org `From` header. Returns `settings.email.from` when set,
 * otherwise the deployment default `env.EMAIL_FROM` (always non-empty — the env
 * schema defaults it). Never throws for a missing setting; a non-existent org
 * resolves to the env default too.
 */
export async function getOrgEmailFrom(orgId: string): Promise<string> {
  return (await getOrgEmailConfig(orgId)).from
}

/**
 * Resolve the per-org `Reply-To` header. Returns `settings.email.replyTo` when
 * set, otherwise `undefined` (no global reply-to — leave the header unset).
 */
export async function getOrgEmailReplyTo(orgId: string): Promise<string | undefined> {
  return (await getOrgEmailConfig(orgId)).replyTo
}

// ── The org's own sender in the managed edition (S29) ──
//
// ORG-SCOPED mail only (invitations, connect links, attention digests, the
// CSAT survey): sign-in codes, magic links, resets and handoffs keep
// `getOrgEmailConfig` on the global transport, so a broken org domain can
// never lock anyone out. Outside the managed edition this answers null and
// every send site keeps its self-hosted path unchanged.

/** The org-scoped sender: `provider` null means the send site's own global channel. */
export interface OrgSender {
  from: string
  provider: EmailProvider | null
}

/** The host part of an address (`Name <a@host>` or `a@host`), lowercased; "" when none. */
export function cellMailDomain(address: string): string {
  const match = /@([^>\s]+)\s*>?\s*$/.exec(address.trim())
  return match?.[1]?.toLowerCase() ?? ""
}

/** The org's display name for mail copy, read with the kernel handle (`organizations` is deny-all to the app role). */
export async function getOrgDisplayName(orgId: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "org-display-name", (tx) =>
    tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return row?.name?.replace(/[\r\n\t]/g, " ").trim() || "Liaison"
}

/** An RFC 5322 quoted display name: no line breaks, `"` and `\` escaped. */
function quotedName(name: string): string {
  const clean = name.replace(/[\r\n\t]+/g, " ").trim()
  return `"${clean.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`
}

interface StoredCloudSender {
  domain?: unknown
  fromAddress?: unknown
  keyCiphertext?: unknown
}

export async function getOrgSenderTransport(orgId: string): Promise<OrgSender | null> {
  if (!isManagedEdition()) return null
  const [row] = await withPrivilegedDb(orgId, "org-sender-resolve", (tx) =>
    tx
      .select({
        name: organizations.name,
        sender: sql<unknown>`${organizations.settings}->'cloudSender'`,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  const orgName = row?.name?.trim() || "Liaison"
  const raw = typeof row?.sender === "string" ? JSON.parse(row.sender) : row?.sender
  const stored = (raw && typeof raw === "object" ? raw : {}) as StoredCloudSender
  // A demo box refuses every send on the global channels; an org key must not
  // become a way around that.
  if (
    !isDemoModeEnabled() &&
    typeof stored.fromAddress === "string" &&
    stored.fromAddress.length > 0 &&
    typeof stored.keyCiphertext === "string" &&
    stored.keyCiphertext.length > 0
  ) {
    try {
      const apiKey = decryptSecret(
        stored.keyCiphertext,
        env.ENCRYPTION_KEY,
        CryptoContext.orgSettingsSecret,
      )
      const from = `${quotedName(orgName)} <${stored.fromAddress}>`
      return { from, provider: orgSenderProvider({ apiKey, from }) }
    } catch (err) {
      // Never the key or its ciphertext in the log line.
      log.error({ err, orgId }, "org sender key unreadable; using the fallback sender")
    }
  }
  const domain = cellMailDomain(env.EMAIL_FROM)
  if (!domain) return { from: env.EMAIL_FROM, provider: null }
  return {
    from: `${quotedName(`${orgName} via Liaison`)} <notifications@${domain}>`,
    provider: null,
  }
}
