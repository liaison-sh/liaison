// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Report access settings (UI-only tools, the Settings block `DatabaseReportAccess`)
// and the app's provisioning (`liaison config apply` `apps[].provision`).

import type { AppContext, ProvisionParams, ProvisionResult } from "@liaison/app-sdk"
import {
  ACCESS_COLLECTION,
  ACCESS_DOC,
  type DomainAccess,
  domainAccessSchema,
  loadAccess,
  resolveRule,
  type Tier,
} from "./access"
import { isSqlError, MAIN } from "./tools"

type Ctx = Pick<AppContext, "sql" | "store" | "kernel">

function fail(code: string, message: string) {
  return { error: { code, message } }
}

/** Every role and person a rule names must belong to the org. */
async function unknownReference(ctx: Ctx, access: DomainAccess): Promise<string | null> {
  const roleIds = new Set((await ctx.kernel.roles()).map((r) => r.id))
  const userIds = [...new Set(Object.values(access).flatMap((r) => r.users ?? []))]
  const known = new Set<string>()
  for (let i = 0; i < userIds.length; i += 200) {
    for (const u of await ctx.kernel.findByIds("users", userIds.slice(i, i + 200))) {
      known.add(String(u.id))
    }
  }
  for (const [domain, rule] of Object.entries(access)) {
    for (const id of rule.roles ?? []) {
      if (!roleIds.has(id)) return `domainAccess.${domain}.roles: no role ${id} in this organization`
    }
    for (const id of rule.users ?? []) {
      if (!known.has(id)) return `domainAccess.${domain}.users: no person ${id} in this organization`
    }
  }
  return null
}

/** The Report access view: each catalog domain with its reads, tiers and rule. */
export async function reportAccessGet(_params: unknown, ctx: Ctx) {
  const { access } = await loadAccess(ctx)
  const catalog = await ctx.sql.reads(MAIN)
  const reads = isSqlError(catalog) ? {} : catalog.reads
  const tiers = (isSqlError(catalog) ? {} : catalog.domains) as Record<string, { tier: Tier }>
  const byDomain = new Map<string, Array<{ name: string; description: string }>>()
  for (const [name, read] of Object.entries(reads)) {
    const domain = read.domain ?? ""
    const list = byDomain.get(domain) ?? []
    list.push({ name, description: read.description ?? "" })
    byDomain.set(domain, list)
  }
  const domains = [...byDomain.keys()].sort().map((domain) => ({
    domain,
    reads: byDomain.get(domain) ?? [],
    catalogTier: tiers[domain]?.tier ?? null,
    rule: Object.hasOwn(access, domain) ? (access[domain] ?? null) : null,
    effectiveTier: resolveRule(domain, tiers, access).tier,
  }))
  const named = [...new Set(Object.values(access).flatMap((r) => r.users ?? []))].slice(0, 200)
  const people = named.length ? await ctx.kernel.findByIds("users", named) : []
  return {
    adapter: isSqlError(catalog) ? null : catalog.adapter,
    ...(isSqlError(catalog) ? { catalogError: catalog.error } : {}),
    domains,
    domainAccess: access,
    roles: await ctx.kernel.roles(),
    /** The people the rules name (the picker adds others by email). */
    members: people.map((p) => ({
      id: String(p.id),
      name: String(p.name ?? p.email),
      email: String(p.email),
    })),
  }
}

/** Resolve emails to the org's people, for the picker's "add by email". */
export async function reportAccessFindPeople(params: { emails?: unknown }, ctx: Ctx) {
  const emails = Array.isArray(params?.emails)
    ? params.emails.filter((e): e is string => typeof e === "string").slice(0, 50)
    : []
  const rows = await ctx.kernel.findUsersByEmail(emails)
  return {
    members: rows.map((p) => ({
      id: String(p.id),
      name: String(p.name ?? p.email),
      email: String(p.email),
    })),
  }
}

/** Replace the stored map (the whole map, as the Settings block saves it). */
export async function reportAccessSet(params: { domainAccess?: unknown }, ctx: Ctx) {
  const parsed = domainAccessSchema.safeParse(params?.domainAccess)
  if (!parsed.success) {
    return fail("invalid_params", parsed.error.issues.map((i) => i.message).join("; "))
  }
  const problem = await unknownReference(ctx, parsed.data)
  if (problem) return fail("invalid_params", problem)
  await ctx.store.set(ACCESS_COLLECTION, ACCESS_DOC, { value: parsed.data })
  return reportAccessGet({}, ctx)
}

interface ProvisionConfig {
  domainAccess?: Record<string, { tier: Tier; roles?: string[]; users?: string[] }>
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  )

/**
 * `apps[].provision` for the database app: `domainAccess` names roles by name and
 * people by email; they are resolved to the org's ids, and an unknown one fails
 * the apply. The block replaces the stored map; without it, nothing changes.
 */
export async function provisionDatabase(
  params: ProvisionParams<ProvisionConfig>,
  ctx: Ctx,
): Promise<ProvisionResult> {
  const wanted = params.config?.domainAccess
  if (!wanted) return { changed: [] }
  const roles = new Map((await ctx.kernel.roles()).map((r) => [r.name, r.id] as const))
  const emails = [
    ...new Set(Object.values(wanted).flatMap((r) => (r.users ?? []).map((e) => e.toLowerCase()))),
  ]
  const people = new Map<string, string>()
  for (let i = 0; i < emails.length; i += 200) {
    for (const p of await ctx.kernel.findUsersByEmail(emails.slice(i, i + 200))) {
      people.set(String(p.email).toLowerCase(), String(p.id))
    }
  }
  const resolved: DomainAccess = {}
  for (const [domain, rule] of Object.entries(wanted)) {
    const out: DomainAccess[string] = { tier: rule.tier }
    if (rule.roles) {
      out.roles = rule.roles.map((name) => {
        const id = roles.get(name)
        if (!id) throw new Error(`domainAccess.${domain}.roles: unknown role '${name}'`)
        return id
      })
    }
    if (rule.users) {
      out.users = rule.users.map((email) => {
        const id = people.get(email.toLowerCase())
        if (!id) throw new Error(`domainAccess.${domain}.users: no person '${email}'`)
        return id
      })
    }
    resolved[domain] = out
  }
  const checked = domainAccessSchema.safeParse(resolved)
  if (!checked.success) {
    throw new Error(`domainAccess: ${checked.error.issues.map((i) => i.message).join("; ")}`)
  }
  const { access } = await loadAccess(ctx)
  if (canonical(access) === canonical(checked.data)) return { changed: [] }
  const changed = [`domainAccess: ${Object.keys(checked.data).sort().join(", ") || "(none)"}`]
  if (!params.dryRun) {
    await ctx.store.set(ACCESS_COLLECTION, ACCESS_DOC, { value: checked.data })
  }
  return { changed }
}
