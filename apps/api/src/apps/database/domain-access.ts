// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-domain access to the database connector's curated reads.
 *
 * Every catalog read names a `domain`. Who may run a domain's reads:
 *
 *   internal      every caller the tool scope (database:reads:read) let in
 *   confidential  a person holding one of the rule's `roles`
 *   restricted    a person listed in the rule's `users`
 *
 * The rule of a domain is the org's (`settings.database.domainAccess.<domain>`),
 * else the catalog's default (`domains.<domain>.tier`, no role or person named),
 * else internal. Org admins (kernel:org:admin) and holders of
 * database:query:read always pass, and so does a system actor (a job or a host
 * path, never a person). With no org rule and no catalog tier, every domain is
 * internal and nothing is looked up: the reads behave exactly as before.
 *
 * The caller is the PERSON the call acts for (`ctx.userId`: the human behind an
 * agent turn, including a turn another agent asked inline), judged on their own
 * role memberships and grants, loaded once per tool call.
 */

import type { ReadCatalog } from "@liaison/db-core"
import {
  type DatabaseDomainAccess,
  type DatabaseDomainTier,
  databaseDomainRuleSchema,
} from "@liaison/shared"
import { rootLogger } from "~/lib/logger"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "database-domain-access" })

/** Org admins pass every tier. */
export const DOMAIN_ACCESS_ADMIN_SCOPE = "kernel:org:admin"
/** The database admin role's scope (raw SQL) passes every tier. */
export const DOMAIN_ACCESS_QUERY_SCOPE = "database:query:read"
/** Who may read and change the setting (an org settings section's admin scope). */
export const DOMAIN_ACCESS_MANAGE_SCOPE = "kernel:apps:admin"

export type DomainAccessCaller =
  | { kind: "system" }
  | { kind: "person"; userId: string; roleIds: readonly string[]; scopes: readonly string[] }

export interface ResolvedDomainRule {
  tier: DatabaseDomainTier
  roles: readonly string[]
  users: readonly string[]
  source: "org" | "catalog" | "default"
}

/** A bridge actor id that is no person: a job or host path ("system", "system:<app>:<job>"). */
export function isSystemActorId(userId: string): boolean {
  return userId === "system" || userId.startsWith("system:")
}

/**
 * The stored map, parsed entry by entry. A malformed entry (only a hand-edited
 * database can hold one: every write path validates) FAILS CLOSED: its domain
 * becomes restricted with nobody listed, so only admins pass, and the fault is
 * logged. Absent or not an object: no rules.
 */
export function parseStoredDomainAccess(raw: unknown, orgId?: string): DatabaseDomainAccess {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object" || Array.isArray(raw)) {
    log.error({ orgId }, "database domain access: stored setting is not an object; ignored")
    return {}
  }
  const out: DatabaseDomainAccess = {}
  for (const [domain, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = databaseDomainRuleSchema.safeParse(value)
    if (parsed.success) {
      out[domain] = parsed.data
    } else {
      log.error(
        { orgId, domain, issues: parsed.error.issues.map((i) => i.message) },
        "database domain access: malformed rule; the domain is restricted to admins until it is fixed",
      )
      out[domain] = { tier: "restricted", users: [] }
    }
  }
  return out
}

export function resolveDomainRule(
  domain: string,
  catalog: Pick<ReadCatalog, "domains">,
  orgRules: DatabaseDomainAccess,
): ResolvedDomainRule {
  const own = Object.hasOwn(orgRules, domain) ? orgRules[domain] : undefined
  if (own) {
    return { tier: own.tier, roles: own.roles ?? [], users: own.users ?? [], source: "org" }
  }
  const declared = catalog.domains?.[domain]
  if (declared) return { tier: declared.tier, roles: [], users: [], source: "catalog" }
  return { tier: "internal", roles: [], users: [], source: "default" }
}

/** True when some read of the catalog sits in a non-internal domain. */
export function catalogHasGatedDomain(
  catalog: Pick<ReadCatalog, "reads" | "domains">,
  orgRules: DatabaseDomainAccess,
): boolean {
  const domains = new Set(Object.values(catalog.reads).map((r) => r.domain))
  for (const domain of domains) {
    if (resolveDomainRule(domain, catalog, orgRules).tier !== "internal") return true
  }
  return false
}

export function callerMayRunDomain(
  caller: DomainAccessCaller,
  rule: Pick<ResolvedDomainRule, "tier" | "roles" | "users">,
): boolean {
  if (rule.tier === "internal") return true
  if (caller.kind === "system") return true
  const scopes = [...caller.scopes]
  if (hasScope(DOMAIN_ACCESS_ADMIN_SCOPE, scopes) || hasScope(DOMAIN_ACCESS_QUERY_SCOPE, scopes)) {
    return true
  }
  if (rule.tier === "confidential") return caller.roleIds.some((id) => rule.roles.includes(id))
  return rule.users.includes(caller.userId)
}
