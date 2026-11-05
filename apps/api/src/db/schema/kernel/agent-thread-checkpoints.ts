// SPDX-License-Identifier: FSL-1.1-ALv2
// kernel.agent_thread_checkpoints: one agent's rolling summary of one thread,
// versioned. A turn loads the current version's summary plus the raw messages
// after `uptoMessageId`, instead of the whole thread.
//
// The checkpoint is PER AGENT: two agents in one channel keep two checkpoints,
// each built only from the messages that agent may read. A version row is
// immutable once written (a database trigger guards the four columns that
// define it); the current version is the highest.
import {
  boolean,
  foreignKey,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"

export const agentThreadCheckpoints = kernel.table(
  "agent_thread_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** The last message the summary covers. The raw tail starts after it. */
    uptoMessageId: uuid("upto_message_id"),
    summary: text("summary").notNull(),
    // No default, matching agentMemory.requiredScopes: every writer supplies
    // the union of what it read explicitly, so an untagged row fails instead
    // of landing as the empty set every member satisfies.
    requiredScopes: text("required_scopes").array().notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    version: integer("version").notNull(),
    /**
     * Set when a message the summary covers is deleted, cleared when the
     * artefact is rebuilt without it. Deliberately mutable in BOTH directions:
     * the immutability trigger carves it out.
     */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    /**
     * When the memory flush ran for THIS advance (P4m-T17). One flush per
     * checkpoint version: the marker lives on the version row because the row
     * is the advance.
     */
    flushedAt: timestamp("flushed_at", { withTimezone: true }),
    /**
     * The summarised region (or the version it folds forward) carried outside
     * text, so a turn rendering this summary reads outside text (0172).
     */
    tainted: boolean("tainted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The named agent must belong to the ROW'S OWN ORG (the 0072 class): a
    // checkpoint is read back BY OWNING AGENT, so a cross-org agent id is a
    // cross-tenant read of summarized content.
    foreignKey({
      columns: [table.agentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "agent_thread_checkpoints_agent_org_fk",
    }),
    uniqueIndex("agent_thread_checkpoints_agent_thread_version_idx").on(
      table.agentId,
      table.threadId,
      table.version,
    ),
  ],
)

export type AgentThreadCheckpoint = typeof agentThreadCheckpoints.$inferSelect
export type NewAgentThreadCheckpoint = typeof agentThreadCheckpoints.$inferInsert
