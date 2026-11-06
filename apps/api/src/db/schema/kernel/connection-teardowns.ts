// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a removed OAuth connection still has to do at its provider (migration
// 0274, `modules/apps/connections/revoke.ts`). No org column: a row outlives its
// org's purge. The request role may only INSERT its own org's row; the privileged
// pool reads and works them off.

import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const connectionTeardowns = kernel.table("connection_teardowns", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceOrgId: uuid("source_org_id").notNull(),
  /** The `connected_accounts` row it came from; that row may be gone. */
  connectionId: uuid("connection_id").notNull(),
  appName: text("app_name").notNull(),
  connectionName: text("connection_name").notNull(),
  /** The provider account, to find other connections that still use it. */
  identifier: text("identifier").notNull(),
  oauthClientSource: text("oauth_client_source"),
  oauthClientId: text("oauth_client_id"),
  /** Moved unchanged from the connection, under the same encryption context. */
  accessTokenEncrypted: text("access_token_encrypted"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  /** The app's declared endpoints, when its manifest was loaded in the disconnecting process. */
  revocationUrl: text("revocation_url"),
  watchStopUrl: text("watch_stop_url"),
  tokenUrl: text("token_url"),
  attempts: integer("attempts").notNull().default(0),
  /** When a process may take it; a claim pushes this forward, so it doubles as the lease. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type ConnectionTeardownRow = typeof connectionTeardowns.$inferSelect
