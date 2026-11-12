// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Report access: who may run the curated reads of each domain of the connected
// catalog. The org's rules live in the app's store (`settings` / `domain_access`,
// data `{ value: { <domain>: rule } }`); a domain without a rule takes the
// catalog's declared tier, else internal.
//
//   internal      every caller of the read tools
//   confidential  the roles the rule names
//   restricted    the people the rule names
//
// An org admin, a holder of database:query:read (who can read the same tables
// with db_query anyway) and the system (a job) pass every tier. A rule that
// does not parse restricts its domain to them until it is fixed (fails closed).

import type { AppContext, KernelCaller } from "@liaison/app-sdk"
import { z } from "zod"

export const ACCESS_COLLECTION = "settings"
export const ACCESS_DOC = "domain_access"
export const ORG_ADMIN_SCOPE = "kernel:org:admin"
export const QUERY_SCOPE = "database:query:read"

export const TIERS = ["internal", "confidential", "restricted"] as const
export type Tier = (typeof TIERS)[number]

export const ruleSchema = z
  .object({
    tier: z.enum(TIERS),
    roles: z.array(z.string().uuid()).max(200).optional(),
    users: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict()

export type DomainRule = z.infer<typeof ruleSchema>
export type DomainAccess = Record<string, DomainRule>

export const domainNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\s.]+$/, "a domain name without spaces or dots")

export const domainAccessSchema = z
  .record(domainNameSchema, ruleSchema)
  .refine((v) => Object.keys(v).length <= 200, { message: "at most 200 domains" })

export interface ResolvedRule {
  tier: Tier
  roles: readonly string[]
  users: readonly string[]
  source: "org" | "catalog" | "default"
}

/** The stored map, each malformed entry restricted to admins (fails closed). */
export function parseStoredAccess(raw: unknown): DomainAccess {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: DomainAccess = {}
  for (const [domain, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = ruleSchema.safeParse(value)
    out[domain] = parsed.success ? parsed.data : { tier: "restricted", users: [] }
  }
  return out
}

export async function loadAccess(ctx: Pick<AppContext, "store">): Promise<{
  access: DomainAccess
  version: number
}> {
  const doc = await ctx.store.get<{ value?: unknown }>(ACCESS_COLLECTION, ACCESS_DOC)
  return { access: parseStoredAccess(doc?.data.value), version: doc?.version ?? 0 }
}

export function resolveRule(
  domain: string,
  catalogTiers: Readonly<Record<string, { tier: Tier }>>,
  access: DomainAccess,
): ResolvedRule {
  const own = Object.hasOwn(access, domain) ? access[domain] : undefined
  if (own) return { tier: own.tier, roles: own.roles ?? [], users: own.users ?? [], source: "org" }
  const declared = catalogTiers[domain]
  if (declared) return { tier: declared.tier, roles: [], users: [], source: "catalog" }
  return { tier: "internal", roles: [], users: [], source: "default" }
}

export function callerMayRun(
  caller: KernelCaller,
  rule: Pick<ResolvedRule, "tier" | "roles" | "users">,
): boolean {
  if (rule.tier === "internal") return true
  if (caller.kind === "system") return true
  if (caller.holds[ORG_ADMIN_SCOPE] || caller.holds[QUERY_SCOPE]) return true
  if (rule.tier === "confidential") return caller.roleIds.some((id) => rule.roles.includes(id))
  return rule.users.includes(caller.userId)
}

/**
 * Which domains the caller may run, decided once per call. With no rule and no
 * catalog tier every domain is internal and nobody is looked up.
 */
export async function domainVisibility(
  ctx: Pick<AppContext, "store" | "kernel">,
  domains: Iterable<string>,
  catalogTiers: Readonly<Record<string, { tier: Tier }>>,
): Promise<(domain: string) => boolean> {
  const { access } = await loadAccess(ctx)
  const gated = [...new Set(domains)].some(
    (d) => resolveRule(d, catalogTiers, access).tier !== "internal",
  )
  if (!gated) return () => true
  const caller = await ctx.kernel.caller([ORG_ADMIN_SCOPE, QUERY_SCOPE])
  const decided = new Map<string, boolean>()
  return (domain) => {
    let allowed = decided.get(domain)
    if (allowed === undefined) {
      allowed = callerMayRun(caller, resolveRule(domain, catalogTiers, access))
      decided.set(domain, allowed)
    }
    return allowed
  }
}
