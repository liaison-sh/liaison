// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H3 — test-only scope-grant route.
//
// Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES for
// the qa/ harness on `bun run dev`). Mounted at
// `/api/_test/grants/set-user-scopes`. Lets a Playwright worker seed
// per-user scopes via HTTP (the SDK-side `setUserScopes` is only
// reachable from inside a sandboxed app's bridge — not from the
// Playwright process — so a test-only route is needed).
//
// The route seeds grants AS the org admin (see the handler note) — tests own the dataset.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { setUserScopes } from "~/modules/permissions/app-grants"

export const grantScopesTestRoutes = new Hono<AppEnv>()

const bodySchema = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
  callingApp: z.string().min(1),
  scopes: z.array(z.string()),
})

grantScopesTestRoutes.post("/set-user-scopes", zValidator("json", bodySchema), async (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  const body = c.req.valid("json")

  // Seed the grant AS an org admin, not a bare system actor. setUserScopes bumps
  // the target's permission_version — a kernel.users UPDATE that only
  // `users_update_admin_rls` permits (it needs `kernel.session_is_admin()`) — and
  // `user_scope_grants` gates PRIVILEGED scopes (e.g. kernel:users:admin) behind
  // `session_is_admin()` in its WITH CHECK. A system actor has an empty
  // `app.current_user_id` (so `users_update_rls`'s `id = ''::uuid` cast throws) AND
  // no `*` scope (so it fails the privileged-scope gate) — which is why seeding a
  // privileged kernel scope used to 500. Acting as the org's `*`-scoped admin mirrors
  // how the product itself issues these grants and keeps RLS fully enforced (no bypass).
  // Test-only route (qaSeedRoutesEnabled); the admin lookup is a privileged read.
  const [admin] = await sql<{ id: string }[]>`
    SELECT u.id FROM kernel.users u
    WHERE u.org_id = ${body.orgId} AND u.status <> 'deactivated' AND (
      EXISTS (SELECT 1 FROM kernel.user_scope_grants g
              WHERE g.user_id = u.id AND g.org_id = ${body.orgId} AND g.scope = '*')
      OR EXISTS (SELECT 1 FROM kernel.user_roles ur
                 JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
                 WHERE ur.user_id = u.id AND rsg.scope = '*')
    )
    ORDER BY u.created_at ASC
    LIMIT 1`
  if (!admin) {
    throw new HTTPException(500, {
      message: `set-user-scopes: no '*'-scoped admin in org ${body.orgId} to seed grants as`,
    })
  }

  await withRlsContext(
    {
      actorType: "user",
      userId: admin.id,
      orgId: body.orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    },
    async (tx) => {
      await setUserScopes(tx, {
        userId: body.userId,
        orgId: body.orgId,
        callingApp: body.callingApp,
        scopes: body.scopes,
      })
    },
  )
  return c.json({ ok: true })
})
