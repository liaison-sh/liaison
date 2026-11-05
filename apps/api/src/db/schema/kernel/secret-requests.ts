// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { check, foreignKey, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"
import { users } from "./users"

export const SECRET_REQUEST_KINDS = [
  "byok",
  "connection_credentials",
  "oauth_client",
  "google_integration_client",
  "oauth_connect",
  "api_connector_credentials",
  "api_key",
] as const
export type SecretRequestKind = (typeof SECRET_REQUEST_KINDS)[number]

export const SECRET_REQUEST_STATUSES = ["pending", "saved", "cancelled", "expired"] as const
export type SecretRequestStatus = (typeof SECRET_REQUEST_STATUSES)[number]

/**
 * kernel.secret_requests (migrations 0206, 0214): a secret an agent asked a person to
 * enter through a form card. The row never holds the secret, only what is asked
 * for, the fingerprints of what was stored when it was asked (`baseline`), and
 * the non-secret hint once the server has seen the new secret stored.
 */
export const secretRequests = kernel.table(
  "secret_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** The agent that asked. The composite (agent_id, org_id) key is below. */
    agentId: uuid("agent_id"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SecretRequestKind>().notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull().default({}),
    targetKey: text("target_key").notNull(),
    baseline: text("baseline").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").$type<SecretRequestStatus>().notNull().default("pending"),
    hint: text("hint"),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    turnClaimedAt: timestamp("turn_claimed_at", { withTimezone: true }),
    /**
     * The scopes of the turn that filed it (migration 0220): a reader must hold
     * every one to see the row, since its target holds text the agent chose.
     */
    requiredScopes: text("required_scopes").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    check(
      "secret_requests_kind_chk",
      sql`${t.kind} IN ('byok','connection_credentials','oauth_client','google_integration_client','oauth_connect','api_connector_credentials','api_key')`,
    ),
    check(
      "secret_requests_status_chk",
      sql`${t.status} IN ('pending','saved','cancelled','expired')`,
    ),
    index("secret_requests_thread_idx").on(t.orgId, t.threadId),
    foreignKey({
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "secret_requests_agent_org_fk",
    }),
  ],
)

export type SecretRequest = typeof secretRequests.$inferSelect
