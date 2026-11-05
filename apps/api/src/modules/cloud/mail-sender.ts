// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `PUT /api/cloud/orgs/:id/mail-sender` (A44): the org's own verified sending
// domain, From address and domain-restricted sending key, pushed by Control.
//
// Stored in the org's settings under its OWN key, `cloudSender {domain,
// fromAddress, version, keyCiphertext}` (the key encrypted like every other
// org settings secret), never in `email.from`: sign-in mail reads that one
// and must keep the system sender (P3R-7). Only the org-scoped sends read
// `cloudSender`, through `getOrgSenderTransport` (modules/org/email-from.ts).
// `sender: null` removes the sender and the key and keeps the version, so a
// late older push cannot bring them back. Applied only when `version` is newer
// than the one held (the same reply as the billing push).

import {
  CLOUD_ERROR_CODES,
  type CloudMailSenderReply,
  type CloudMailSenderRequest,
} from "@liaison/control-plane-contract"
import { eq, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "cloud-mail-sender" })

export type MailSenderResult =
  | { status: 200; reply: CloudMailSenderReply }
  | { status: 404; reply: { ok: false; code: typeof CLOUD_ERROR_CODES.notFound } }

export async function applyMailSender(req: CloudMailSenderRequest): Promise<MailSenderResult> {
  const [org] = await withSystemDb("cloud-mail-sender-org", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, req.orgId))
      .limit(1),
  )
  if (!org) return { status: 404, reply: { ok: false, code: CLOUD_ERROR_CODES.notFound } }

  return withPrivilegedDb(req.orgId, "cloud-mail-sender-push", async (tx) => {
    // Locked: two pushes in flight apply in version order, never interleaved.
    const [row] = await tx
      .select({ held: sql<unknown>`${organizations.settings}->'cloudSender'->'version'` })
      .from(organizations)
      .where(eq(organizations.id, req.orgId))
      .for("update")
    const held = typeof row?.held === "number" ? row.held : Number(row?.held ?? 0) || 0
    if (held >= req.version) {
      return { status: 200 as const, reply: { ok: true as const, applied: false, version: held } }
    }
    const value = req.sender
      ? {
          version: req.version,
          domain: req.sender.domain,
          fromAddress: req.sender.fromAddress,
          keyCiphertext: encryptSecret(
            req.sender.key,
            env.ENCRYPTION_KEY,
            CryptoContext.orgSettingsSecret,
          ),
        }
      : { version: req.version }
    await tx
      .update(organizations)
      .set({
        settings: sql`jsonb_set(COALESCE(${organizations.settings}, '{}'::jsonb), '{cloudSender}', ${JSON.stringify(value)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, req.orgId))
    // The domain is not secret; the key never reaches a log line.
    log.info(
      { orgId: req.orgId, version: req.version, domain: req.sender?.domain ?? null },
      "org sender applied",
    )
    return {
      status: 200 as const,
      reply: { ok: true as const, applied: true, version: req.version },
    }
  })
}
