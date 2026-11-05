// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Database connector settings routes, mounted at /api/database (a kernel
 * module, outside /api/apps so the generic app routes never shadow it).
 *
 *   GET /domain-access   the connected catalog's domains, their reads, the
 *                        catalog default, the org's rules, and the roles and
 *                        people a rule may name                kernel:apps:admin
 *   PUT /domain-access   replace the org's rules               kernel:apps:admin
 *
 * Rules: apps/api/src/apps/database/domain-access.ts.
 */
import {
  type DatabaseDomainAccessEntry,
  type DatabaseDomainAccessView,
  databaseDomainAccessPutSchema,
} from "@liaison/shared"
import { and, asc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { resolveOrgDatabaseCatalog } from "~/apps/database/bridge"
import { DOMAIN_ACCESS_MANAGE_SCOPE, resolveDomainRule } from "~/apps/database/domain-access"
import {
  assertDomainAccessReferences,
  DomainAccessReferenceError,
  readOrgDomainAccess,
  writeOrgDomainAccess,
} from "~/apps/database/domain-access-store"
import { withPrivilegedDb } from "~/db/privileged"
import { roles, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { writeAuditLog } from "~/modules/audit/service"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "database-routes" })

export const databaseRoutes = new Hono<AppEnv>()

function requireManage(scopes: string[] | undefined): void {
  if (!hasScope(DOMAIN_ACCESS_MANAGE_SCOPE, scopes ?? [])) {
    throw new HTTPException(403, { message: `Missing scope: ${DOMAIN_ACCESS_MANAGE_SCOPE}` })
  }
}

async function buildView(orgId: string): Promise<DatabaseDomainAccessView> {
  let catalog: Awaited<ReturnType<typeof resolveOrgDatabaseCatalog>> | null = null
  try {
    catalog = await resolveOrgDatabaseCatalog(orgId)
  } catch (err) {
    // No catalog (a misconfigured adapter): the stored rules still show.
    log.warn({ err, orgId }, "database domain access: catalog did not resolve")
  }
  return withPrivilegedDb(orgId, "database-domain-access-view", async (tx) => {
    const domainAccess = await readOrgDomainAccess(tx, orgId)
    const byDomain = new Map<string, DatabaseDomainAccessEntry["reads"]>()
    for (const [name, read] of Object.entries(catalog?.reads ?? {})) {
      const list = byDomain.get(read.domain) ?? []
      list.push({ name, description: read.description })
      byDomain.set(read.domain, list)
    }
    const domains: DatabaseDomainAccessEntry[] = [...byDomain.keys()].sort().map((domain) => ({
      domain,
      reads: byDomain.get(domain) ?? [],
      catalogTier: catalog?.domains?.[domain]?.tier ?? null,
      rule: Object.hasOwn(domainAccess, domain) ? (domainAccess[domain] ?? null) : null,
      effectiveTier: resolveDomainRule(domain, catalog ?? {}, domainAccess).tier,
    }))
    const roleRows = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .orderBy(asc(roles.name))
    const memberRows = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.status, "active")))
      .orderBy(asc(users.name))
    return {
      adapter: catalog?.adapter ?? null,
      domains,
      domainAccess,
      roles: roleRows,
      members: memberRows.map((m) => ({ id: m.id, name: m.name ?? m.email, email: m.email })),
    }
  })
}

databaseRoutes
  .get("/domain-access", async (c) => {
    requireManage(c.get("scopes"))
    return success(c, await buildView(c.get("orgId")))
  })
  .put("/domain-access", zValidator("json", databaseDomainAccessPutSchema), async (c) => {
    requireManage(c.get("scopes"))
    const orgId = c.get("orgId")
    const { domainAccess } = c.req.valid("json")
    try {
      await withPrivilegedDb(orgId, "database-domain-access-write", async (tx) => {
        await assertDomainAccessReferences(tx, orgId, domainAccess)
        await writeOrgDomainAccess(tx, orgId, domainAccess)
        await writeAuditLog(tx, {
          orgId,
          actorId: c.get("userId"),
          actorType: "user",
          app: "database",
          action: "database.domain_access.update",
          metadata: { domainAccess },
        })
      })
    } catch (err) {
      if (err instanceof DomainAccessReferenceError) {
        throw new HTTPException(400, { message: err.message })
      }
      throw err
    }
    log.info({ orgId, domains: Object.keys(domainAccess) }, "database domain access updated")
    return success(c, await buildView(orgId))
  })
