// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Website access keys of the buyer invoices API, from Invoicing > Settings > Website access.
// A person's click only: a signed-in session holding the issuer admin scope. An agent or MCP
// session never reaches these routes (they are not tools), and a restricted device session
// mints no credential. The plaintext key is returned once, at creation.
//
//   GET  /api/invoicing/buyer-keys?issuerProfileId=<uuid>
//   POST /api/invoicing/buyer-keys            {issuerProfileId, label}
//   POST /api/invoicing/buyer-keys/:id/revoke

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { zValidator } from "~/lib/validate"
import { writeAuditLog } from "~/modules/audit/service"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { hasScope } from "~/modules/permissions/permissions"
import {
  createBuyerKey,
  issuerProfileExists,
  KeyLimitError,
  listBuyerKeys,
  revokeBuyerKey,
} from "./store"

const log = rootLogger.child({ module: "buyer-invoices-admin" })

/** Who may create, list and revoke keys: the issuer admin scope (bank and control fields). */
export const BUYER_KEYS_SCOPE = "invoicing:issuer:admin"
/** What a key may do: read one issuer profile's buyer documents, through these routes only. */
export const BUYER_KEY_GRANT = "invoicing:buyer_documents:read"

const UUID = z.string().uuid()

function denied(c: Context<AppEnv>) {
  return c.json(
    { error: { code: "forbidden", message: `Website access keys need ${BUYER_KEYS_SCOPE}.` } },
    403,
  )
}

function allowed(c: Context<AppEnv>): boolean {
  return hasScope(BUYER_KEYS_SCOPE, c.get("scopes") ?? [])
}

async function audit(
  c: Context<AppEnv>,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  const orgId = c.get("orgId")
  await withPrivilegedDb(orgId, "buyer-invoices-admin-audit", (tx) =>
    writeAuditLog(tx, {
      orgId,
      actorId: c.get("userId"),
      actorType: "user",
      app: "invoicing",
      entityType: "buyer_invoice_key",
      entityId,
      action,
      metadata,
    }),
  )
}

export const buyerKeyAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    if (!allowed(c)) return denied(c)
    const profile = UUID.safeParse(c.req.query("issuerProfileId"))
    if (!profile.success) {
      return c.json({ error: { code: "invalid_params", message: "issuerProfileId required" } }, 400)
    }
    const keys = await listBuyerKeys(c.get("orgId"), profile.data)
    c.header("Cache-Control", "no-store")
    return c.json({ data: keys })
  })
  .post(
    "/",
    zValidator(
      "json",
      z.object({ issuerProfileId: UUID, label: z.string().trim().min(1).max(80) }).strict(),
    ),
    async (c) => {
      if (!allowed(c)) return denied(c)
      assertUnrestrictedSession(c, "create a website access key")
      const { issuerProfileId, label } = c.req.valid("json")
      const orgId = c.get("orgId")
      if (!(await issuerProfileExists(orgId, issuerProfileId))) {
        return c.json({ error: { code: "not_found", message: "No such issuer profile." } }, 404)
      }
      try {
        const created = await createBuyerKey({
          orgId,
          issuerProfileId,
          label,
          createdBy: c.get("userId"),
        })
        await audit(c, "buyer_key.created", created.id, {
          issuer_profile_id: issuerProfileId,
          label,
          key_prefix: created.prefix,
          grant: BUYER_KEY_GRANT,
        })
        c.header("Cache-Control", "no-store")
        return c.json(
          { data: { id: created.id, key: created.key, prefix: created.prefix, label } },
          201,
        )
      } catch (err) {
        if (err instanceof KeyLimitError) {
          return c.json({ error: { code: "key_limit", message: err.message } }, 409)
        }
        log.error({ err, orgId, issuerProfileId }, "buyer key create failed")
        throw err
      }
    },
  )
  .post("/:id/revoke", async (c) => {
    if (!allowed(c)) return denied(c)
    const id = UUID.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: { code: "not_found", message: "No such key." } }, 404)
    const revoked = await revokeBuyerKey(c.get("orgId"), id.data, c.get("userId"))
    if (!revoked) return c.json({ error: { code: "not_found", message: "No such key." } }, 404)
    await audit(c, "buyer_key.revoked", id.data, { issuer_profile_id: revoked.issuerProfileId })
    return c.json({ data: { id: id.data, revoked: true } })
  })
