// SPDX-License-Identifier: FSL-1.1-ALv2
// Which org may change the instance-wide app installs.
//
// An app installation is shared by every org on the instance. On a multi-tenant
// instance (demo mode, where every visitor is the admin of their own org, and the
// managed edition) an install, upgrade, uninstall or interface approval would let
// one tenant change the code every other tenant runs, while `kernel:apps:admin` is
// an org-level scope any tenant's admin holds. There these actions belong to ONE
// org, the instance operator's:
//
//   - `LIAISON_OPERATOR_ORG_ID` when the operator set it;
//   - otherwise the instance's first org (the one created at bootstrap), except
//     in the managed edition, where only the setting names it (no org is the
//     operator without it; the server refuses to boot without it anyway).
//
// A demo visitor's org is never the operator, whatever the configuration says
// short of naming it explicitly.
//
// A single-org self-host is not restricted: any admin holding `kernel:apps:admin`
// manages apps, as always. In the managed edition an org admin may also install
// a custom app for their own org only (install-routes.ts `/custom/install`,
// app-org-scope.ts); everything instance-wide stays behind this gate.
import { asc } from "drizzle-orm"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"

const TTL_MS = 60_000
let cached: { at: number; orgId: string | null } | null = null

export function resetOperatorOrgCache(): void {
  cached = null
}

/** The instance operator's org id, or null on an instance with no org yet. `fresh` skips the
 *  cache, for a caller that writes rows under the org: a cached first org may since have been
 *  deleted. */
export async function resolveOperatorOrgId(opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (env.LIAISON_OPERATOR_ORG_ID) return env.LIAISON_OPERATOR_ORG_ID
  if (isManagedEdition()) return null
  if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.orgId
  const [first] = await withSystemDb("operator-org", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .orderBy(asc(organizations.createdAt), asc(organizations.id))
      .limit(1),
  )
  cached = { at: Date.now(), orgId: first?.id ?? null }
  return cached.orgId
}

export async function isInstanceOperatorOrg(orgId: string | undefined): Promise<boolean> {
  if (!orgId) return false
  const operator = await resolveOperatorOrgId()
  if (operator === null || operator !== orgId) return false
  if (env.LIAISON_OPERATOR_ORG_ID === orgId) return true
  const { isDemoModeEnabled } = await import("~/modules/demo/demo-mode")
  if (!isDemoModeEnabled()) return true
  const { isDemoOrgId } = await import("~/modules/demo/demo-org")
  return !(await isDemoOrgId(orgId))
}

/** True on an instance whose orgs are separate tenants: demo mode or the managed edition. */
export async function isMultiTenantInstance(): Promise<boolean> {
  if (isManagedEdition()) return true
  const { isDemoModeEnabled } = await import("~/modules/demo/demo-mode")
  return isDemoModeEnabled()
}

/** True when this org may install, upgrade and remove apps: any org on a single-org self-host,
 *  only the instance operator's on a multi-tenant instance. The one rule the gate below and the
 *  Apps settings page both read. */
export async function canManageInstanceApps(orgId: string | undefined): Promise<boolean> {
  return !(await isMultiTenantInstance()) || (await isInstanceOperatorOrg(orgId))
}

/** On a multi-tenant instance, refuses a request from any org but the instance
 *  operator's; a single-org self-host passes through. Mount per route, after the
 *  `kernel:apps:admin` scope check. */
export const requireInstanceOperator = createMiddleware<AppEnv>(async (c, next) => {
  await assertCanManageInstanceApps(c.get("orgId"))
  await next()
})

/** The rule above as a call, for a caller that is not a route (kernel:enable_app). */
export async function assertCanManageInstanceApps(orgId: string | undefined): Promise<void> {
  if (!(await canManageInstanceApps(orgId))) {
    throw new HTTPException(403, {
      message:
        "Installing, upgrading and removing apps affects every organization on this instance and is reserved to the instance operator's organization (LIAISON_OPERATOR_ORG_ID)",
    })
  }
}
