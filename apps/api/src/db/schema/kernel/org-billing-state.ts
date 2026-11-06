// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The billing state the control plane pushes to a managed cell (migration
// 0263, `modules/cloud/billing.ts`): one row per org, applied only when its
// `version` is newer than the stored one. `GET /api/billing/state` serves it.
// Readable by the row's org under RLS; written through the privileged pool only.

import type { CloudAutoTopUp } from "@liaison/control-plane-contract"
import { bigint, jsonb, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/** Bytes per part; `search` is null when the index could not be measured. */
export interface StorageEstimate {
  bytes: number
  parts: {
    files: number
    thumbnails: number
    mail: number
    tickets: number
    conversations: number
    knowledge: number
    search: number | null
  }
  measuredAt: string
  /** A part could not be measured: the total is a floor. */
  partial: boolean
  /** Above the plan's storage cap at the last measure: admins and Control were told. */
  overCap: boolean
}

export const orgBillingState = kernel.table("org_billing_state", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** The control plane's monotonic per-org sequence. */
  version: bigint("version", { mode: "number" }).notNull(),
  plan: text("plan").notNull(),
  status: text("status").notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  includedCredits: numeric("included_credits", { precision: 20, scale: 8 }).notNull(),
  caps: jsonb("caps").$type<Record<string, number | null>>().notNull().default({}),
  /** The plan above and its caps, for the refusal copy; null on the largest (migration 0271). */
  nextPlan: jsonb("next_plan").$type<{ id: string; caps: Record<string, number | null> }>(),
  previewEndsAt: timestamp("preview_ends_at", { withTimezone: true }),
  autoTopUp: jsonb("auto_top_up").$type<CloudAutoTopUp>().notNull(),
  /** While suspended: until when admins keep export and Billing (migration 0265). */
  accessUntil: timestamp("access_until", { withTimezone: true }),
  /** When the control plane closed the org; the deletion fence reads it (migration 0265). */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  /** The address the suspended page shows (migration 0265). */
  billingContact: text("billing_contact"),
  /** The nightly storage estimate (migration 0272, modules/cloud/storage-estimate.ts); never pushed. */
  storageEstimate: jsonb("storage_estimate").$type<StorageEstimate>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type OrgBillingStateRow = typeof orgBillingState.$inferSelect
