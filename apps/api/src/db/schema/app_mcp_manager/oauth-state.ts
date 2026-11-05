// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { organizations, users } from "~/db/schema/kernel"
import { appMcpManager, mcpConnections } from "./connections"

export const mcpOAuthState = appMcpManager.table("mcp_oauth_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => mcpConnections.id, { onDelete: "cascade" }),
  pkceVerifier: text("pkce_verifier").notNull(),
  state: text("state").notNull(),
  // Bound at /oauth/start so the callback can reject session mismatches
  // (review B5). Nullable to tolerate any pre-fix rows already on disk;
  // verification handler treats null as "any session ok" + emits a warning.
  initiatorUserId: uuid("initiator_user_id").references(() => users.id, { onDelete: "cascade" }),
  initiatorOrgId: uuid("initiator_org_id").references(() => organizations.id, {
    onDelete: "cascade",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // What the authorization request was bound to (migration 0187). `issuer` is
  // the AS metadata issuer the callback's RFC 9207 `iss` must equal (null for
  // operator-typed endpoints); `issSupported` makes a missing `iss` a refusal;
  // `resource` (RFC 8707) rides the code exchange verbatim.
  issuer: text("issuer"),
  resource: text("resource"),
  scope: text("scope"),
  issSupported: boolean("iss_supported").notNull().default(false),
  // The authorization plan this sign-in was started with (migration 0188):
  // applied to the connection only when THIS state's callback succeeds.
  // `pendingMetadata` is non-secret; the client secret rides encrypted.
  pendingMetadata: jsonb("pending_metadata").$type<Record<string, unknown>>(),
  pendingSecretsEncrypted: text("pending_secrets_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
