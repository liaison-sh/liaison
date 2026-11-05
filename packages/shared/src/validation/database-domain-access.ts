// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-domain access to the database connector's curated reads
// (`organizations.settings.database.domainAccess`). Every read in a catalog
// names a `domain`; this setting says who may run the reads of each domain:
//
//   internal      every member holding database:reads:read (the default)
//   confidential  members holding one of `roles`
//   restricted    only the listed `users`
//
// Org admins and holders of database:query:read always pass. A domain with no
// entry here falls back to the catalog's own default tier (`domains.<name>.tier`),
// else internal: with neither, every read behaves exactly as before.

import { z } from "zod"

export const DATABASE_DOMAIN_TIERS = ["internal", "confidential", "restricted"] as const
export type DatabaseDomainTier = (typeof DATABASE_DOMAIN_TIERS)[number]

export const databaseDomainTierSchema = z.enum(DATABASE_DOMAIN_TIERS)

/** One domain's rule. `roles` and `users` are ids. */
export const databaseDomainRuleSchema = z.strictObject({
  tier: databaseDomainTierSchema,
  roles: z.array(z.string().uuid()).max(200).optional(),
  users: z.array(z.string().uuid()).max(500).optional(),
})
export type DatabaseDomainRule = z.infer<typeof databaseDomainRuleSchema>

/** A catalog domain name: the same free string a read's `domain` carries. */
export const databaseDomainNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\s.]+$/, "a domain name without spaces or dots")

export const databaseDomainAccessSchema = z
  .record(databaseDomainNameSchema, databaseDomainRuleSchema)
  .refine((v) => Object.keys(v).length <= 200, { message: "at most 200 domains" })
export type DatabaseDomainAccess = z.infer<typeof databaseDomainAccessSchema>

/** PUT body of /api/database/domain-access: the whole map, replacing the stored one. */
export const databaseDomainAccessPutSchema = z.strictObject({
  domainAccess: databaseDomainAccessSchema,
})

/** One domain of the connected catalog, as the settings section lists it. */
export interface DatabaseDomainAccessEntry {
  domain: string
  reads: { name: string; description: string }[]
  /** The catalog's declared default, null when it declares none (internal). */
  catalogTier: DatabaseDomainTier | null
  /** The org's own rule for this domain, null when it has none. */
  rule: DatabaseDomainRule | null
  /** What applies: the org rule, else the catalog default, else internal. */
  effectiveTier: DatabaseDomainTier
}

/** GET response of /api/database/domain-access. */
export interface DatabaseDomainAccessView {
  /** The connected catalog's adapter, null when no catalog resolves. */
  adapter: string | null
  domains: DatabaseDomainAccessEntry[]
  /** The stored map as is, including domains the catalog no longer has. */
  domainAccess: DatabaseDomainAccess
  roles: { id: string; name: string }[]
  members: { id: string; name: string; email: string }[]
}
