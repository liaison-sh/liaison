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
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { getOrgKernelSettings } from "~/lib/settings"

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
