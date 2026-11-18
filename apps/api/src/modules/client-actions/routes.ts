// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Member routes. `POST /:id/my-link` is a staff signer's "Read and sign": the
// member whose id the action names, in a session that is not restricted, gets a
// fresh token once, for this browser. REST only: no tool reaches it, so no agent
// can fetch a signing link. `GET /signing` says whether this server can ask for a
// signature at all, so the screens say it before anyone prepares a document.

import { sql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rotateClientActionToken } from "./mint"
import { signingState } from "./signing-state"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const clientActionRoutes = new Hono<AppEnv>()
  .get("/signing", (c) => c.json({ data: signingState() }))
  .post("/:id/my-link", async (c) => {
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    const id = c.req.param("id")
    c.header("Cache-Control", "no-store")
    if (c.get("sessionRestricted")) {
      return c.json(
        { error: { code: "session_restricted", message: "Sign in on this device to sign" } },
        403,
      )
    }
    if (!UUID.test(id)) return c.json({ error: { code: "not_found", message: "Not found" } }, 404)
    const out = await withPrivilegedDb(orgId, "client-action-my-link", async (tx) => {
      const [row] = extractRows<{ id: string; waiting: boolean; answered: boolean }>(
        await tx.execute(sql`
        SELECT id, (token_hash IS NULL AND decided_at IS NULL AND revoked_at IS NULL) AS waiting,
               (decided_at IS NOT NULL) AS answered
          FROM ${sql.raw(schemaRef("kernel"))}.client_actions
         WHERE id = ${id} AND org_id = ${orgId} AND signer_user_id = ${userId}
         FOR UPDATE
      `),
      )
      if (!row) return null
      // A turn not yet opened (one after the other) opens only after the signer before; Read and
      // sign never opens it early.
      if (row.waiting) return "waiting" as const
      // An answered request opens nothing again: the signer is told it is done, not that it is
      // someone else's.
      if (row.answered) return "answered" as const
      return rotateClientActionToken(tx, orgId, id)
    })
    if (out === "waiting")
      return c.json(
        {
          error: {
            code: "not_your_turn",
            message: "This document waits for the signer before you; you can sign after them",
          },
        },
        409,
      )
    if (out === "answered")
      return c.json(
        { error: { code: "answered", message: "You have already answered this request" } },
        409,
      )
    if (!out) return c.json({ error: { code: "not_found", message: "Not found" } }, 404)
    return c.json({ data: { token: out } })
  })
