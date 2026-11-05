// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

const orgSettingsSchema = z.strictObject({
  fileSizeLimitMb: z.number().int().min(1).max(1000).optional(),
  // Import uploads (multipart, browser to object storage): default 5120 (5 GB).
  importFileSizeLimitMb: z.number().int().min(1).max(51200).optional(),
  // No storageQuotaGb: the storage quota is an operator cap (orgCapsSchema,
  // `organizations.caps.storageGb`), which an org admin cannot change.
  auditRetentionDays: z.number().int().min(1).max(3650).optional(),
  // Nullable so an admin can CLEAR a configured limit — null deletes the
  // Redis override and returns the org to the global default.
  rateLimitPerMinute: z.number().int().min(10).max(10000).nullable().optional(),
  // providerKeys is intentionally absent: BYOK provider keys are write-only
  // through the dedicated BYOK endpoint and must never be accepted through the
  // generic org-settings PATCH path.
  resetDate: z.string().datetime().optional(),
  enterpriseAllowance: z.string().optional(),
  // Anti-prompt-injection posture. "standard" (default): after a turn read
  // outside text (an inbound mail, a web page), an ungated outward tool becomes
  // an approval request. "hardened" extends that to every trust-boundary tool.
  // "off" is the admin's explicit opt-out: nothing waits for a person because
  // the turn read outside text. Kept in the strict object so the JSONB merge
  // accepts it.
  webContentProtection: z.enum(["off", "standard", "hardened"]).optional(),
  // Administrators must use two-step verification: an admin without it gets a
  // session that can only set it up. Default off.
  requireAdminSecondFactor: z.boolean().optional(),
  webFetchAllowlist: z.array(z.string()).max(200).optional(),
  webFetchBlocklist: z.array(z.string()).max(200).optional(),
  // Mailboxes (Gmail / IMAP, for Mail or Tickets) may only be connected on
  // these address domains, e.g. ["acme.example"]. Empty = no restriction.
  // Enforced by apps/api modules/apps/connections/mail-domains.ts.
  allowedMailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/, "a domain such as example.com"),
    )
    .max(50)
    .optional(),
})

export const updateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  defaultLocale: z.string().min(1).optional(),
  businessHours: z
    .object({
      start: z.string(),
      end: z.string(),
      days: z.array(z.number().min(0).max(6)).max(7),
    })
    .optional(),
  settings: orgSettingsSchema.optional(),
  updateChecksEnabled: z.boolean().optional(),
  // Caps are the operator's (`liaison org caps`): named here only so a PATCH
  // carrying them is refused (400) instead of silently dropped.
  caps: z.never().optional(),
})

/** The cap kinds, in the order the usage block lists them. */
export const ORG_CAP_KINDS = ["seats", "mailboxes", "storageGb", "jobsPerHour"] as const
export type OrgCapKind = (typeof ORG_CAP_KINDS)[number]

/**
 * Per-org caps (`organizations.caps`). A missing (or null) key is unlimited.
 * Set only by the operator: `liaison org caps` or the `limits` section of
 * `liaison config apply`. Every cap is a whole number of at least 1:
 * 0 is refused, here and by the column's check (migration 0237).
 */
export const orgCapsSchema = z.strictObject({
  seats: z.number().int().min(1).max(1_000_000).nullable().optional(),
  mailboxes: z.number().int().min(1).max(1_000_000).nullable().optional(),
  storageGb: z.number().int().min(1).max(1_000_000).nullable().optional(),
  jobsPerHour: z.number().int().min(1).max(100_000_000).nullable().optional(),
})
export type OrgCaps = z.infer<typeof orgCapsSchema>

/** One cap as `GET /api/org/usage` reports it: `limit` null = unlimited. */
export interface OrgUsageEntry {
  used: number
  limit: number | null
}

/**
 * `GET /api/org/usage`. Storage `used` is in GB rounded up to two decimals
 * (12.5 GB); its `limit` is whole GB like every cap.
 */
export interface OrgUsage {
  seats: OrgUsageEntry
  mailboxes: OrgUsageEntry
  storageGb: OrgUsageEntry
  jobsThisHour: OrgUsageEntry
}
