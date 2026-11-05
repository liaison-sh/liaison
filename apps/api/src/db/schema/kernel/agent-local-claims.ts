// SPDX-License-Identifier: FSL-1.1-ALv2
import { foreignKey, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"
import { users } from "./users"

/**
 * A32: while a desktop holds this, the SERVER does not run that agent's turn in
 * that conversation.
 *
 * It is a LEASE. `expiresAt` is short and only the holding window pushes it
 * forward, so a laptop that sleeps or a window that is closed releases it by
 * doing nothing, and the thread goes back to being answered by the server. A
 * boolean would leave the conversation permanently unanswered by a machine that
 * is gone.
 *
 * One row per (thread, agent): two machines cannot both be the local runtime for
 * one agent in one conversation. A CLAIM BELONGS TO ITS HOLDER, which is the
 * user AND the window that registered it (`holderKey`): only that window's
 * heartbeat pushes the lease, only its session may reply, only it may release.
 * A second window is refused rather than silently inheriting the conversation,
 * and takes over only by saying so.
 */
export const agentLocalClaims = kernel.table(
  "agent_local_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // The composite (agent_id, org_id) foreign key lives in the table config
    // below (0092); ON DELETE CASCADE is preserved there.
    agentId: uuid("agent_id").notNull(),
    /** Whose machine is holding it. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * WHICH machine, opaque to the server: one window mints it once and
     * presents it on every heartbeat, reply and release. Two windows of the
     * same user are two holders, which is the case `userId` alone could not
     * tell apart.
     */
    holderKey: text("holder_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The claimed agent must belong to the ROW'S OWN ORG (0092). A claim tells
    // the server to stand down for that agent in that conversation, so a
    // single-column key (existence only) would let one org's row hand another
    // org's agent to a machine. ON DELETE CASCADE is unchanged from 0090.
    foreignKey({
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "agent_local_claims_agent_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_local_claims_thread_agent_idx").on(t.threadId, t.agentId),
    index("agent_local_claims_thread_expiry_idx").on(t.threadId, t.expiresAt),
    index("agent_local_claims_agent_org_idx").on(t.agentId, t.orgId),
  ],
)

export type AgentLocalClaim = typeof agentLocalClaims.$inferSelect
export type NewAgentLocalClaim = typeof agentLocalClaims.$inferInsert
