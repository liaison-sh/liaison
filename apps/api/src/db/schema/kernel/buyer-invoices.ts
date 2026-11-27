// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The buyer invoices API's server keys and download links (migration 0358,
// modules/buyer-invoices/store.ts). A key belongs to one org and one invoicing
// issuer profile and is kept as its SHA-256 and 8-character prefix only; a link
// keeps the SHA-256 of its token. Privileged pool only (RLS forced, no policy).

import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export const buyerInvoiceKeys = kernel.table(
  "buyer_invoice_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    issuerProfileId: uuid("issuer_profile_id").notNull(),
    label: text("label").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    unique("buyer_invoice_keys_hash_uq").on(t.keyHash),
    index("buyer_invoice_keys_prefix_idx").on(t.keyPrefix),
    index("buyer_invoice_keys_profile_idx").on(t.orgId, t.issuerProfileId),
  ],
)

export const buyerInvoiceLinks = kernel.table(
  "buyer_invoice_links",
  {
    tokenHash: text("token_hash").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => buyerInvoiceKeys.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("buyer_invoice_links_expiry_idx").on(t.expiresAt)],
)
