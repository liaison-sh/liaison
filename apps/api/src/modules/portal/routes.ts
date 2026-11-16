// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's data routes, behind portalAuthMiddleware. Every read runs
// under withPortalContext on the portal's own login, so what a client sees is
// what the views of schema `portal` give the portal role, never a filter a route
// remembers. A route of PORTAL_ROUTES whose part is not built yet answers 404.
import { sql as drizzleSql } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import {
  PortalContextRefusedError,
  PortalUnavailableError,
  withPortalContext,
} from "~/db/portal-rls"
import { success } from "~/lib/response"
import { PORTAL_ROUTES, routerPath } from "~/modules/portal/routes-list"

/** The caller's portal context, set by portalAuthMiddleware. */
function portalOf(c: Context<AppEnv>) {
  const ctx = c.get("portal")
  if (!ctx) throw new PortalContextRefusedError()
  return ctx
}

/** Runs a portal read; a refused context is the 401, an absent portal login the 503. */
export async function portalRead<T>(
  c: Context<AppEnv>,
  fn: Parameters<typeof withPortalContext<T>>[1],
): Promise<T | Response> {
  try {
    return await withPortalContext(portalOf(c), fn)
  } catch (err) {
    if (err instanceof PortalContextRefusedError) {
      return c.json({ error: { message: "Unauthorized" } }, 401)
    }
    if (err instanceof PortalUnavailableError) {
      return c.json({ error: { message: "The client portal is not available" } }, 503)
    }
    throw err
  }
}

const BUILT = new Set(["GET /me"])

export const portalRoutes = new Hono<AppEnv>().get("/me", async (c) => {
  const me = await portalRead(c, async (tx) =>
    extractRows<{
      id: string
      name: string
      email: string
      locale: string | null
      timezone: string | null
    }>(await tx.execute(drizzleSql`SELECT id, name, email, locale, timezone FROM portal.me`)),
  )
  if (me instanceof Response) return me
  const [row] = me
  if (!row) return c.json({ error: { message: "Unauthorized" } }, 401)
  return success(c, row)
})

// The rest of the list exists from now on, so the route table under the prefix is
// exactly PORTAL_ROUTES; each answers 404 until its part lands.
for (const route of PORTAL_ROUTES) {
  if (route.access !== "token" || BUILT.has(`${route.method} ${routerPath(route)}`)) continue
  const notYet = (c: Context<AppEnv>) => c.json({ error: { message: "Not found" } }, 404)
  if (route.method === "GET") portalRoutes.get(routerPath(route), notYet)
  else portalRoutes.post(routerPath(route), notYet)
}
