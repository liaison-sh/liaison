// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

/**
 * One row per public demo signup (migration 0164; verification, needs and the
 * signup network in 0179). Instance-level, reached only
 * through the privileged connection. `demoOrgId` has no foreign key on purpose:
 * the lead outlives the throwaway org it was created with.
 */
export const demoLeads = kernel.table(
  "demo_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    noticeVersion: text("notice_version").notNull(),
    demoOrgId: uuid("demo_org_id"),
    optOutToken: text("opt_out_token").notNull(),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The mailbox the address reaches (demo-email.ts `normalizeDemoEmail`). */
    emailNormalized: text("email_normalized"),
    /** What the per-domain verification cap counts on; null = major provider. */
    emailCapKey: text("email_cap_key"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** The one news consent: the signup checkbox or the later click. */
    notifyManagedAt: timestamp("notify_managed_at", { withTimezone: true }),
    /** The needs picked on the door, in pick order. */
    needs: text("needs").array().notNull().default([]),
    /** Client network at Start (IPv4 /24, IPv6 /48); never changed after. */
    signupNetwork: text("signup_network"),
    /** When the name and address were emptied (migration 0262); the row is anonymous. */
    identityErasedAt: timestamp("identity_erased_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("demo_leads_opt_out_token_idx").on(table.optOutToken),
    index("demo_leads_created_at_idx").on(table.createdAt),
    index("demo_leads_email_idx").on(table.email),
    index("demo_leads_email_normalized_idx").on(table.emailNormalized),
    index("demo_leads_demo_org_id_idx").on(table.demoOrgId),
  ],
)
