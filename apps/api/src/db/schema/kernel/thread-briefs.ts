// SPDX-License-Identifier: FSL-1.1-ALv2
// P4c-T49: the brief as ROWS, keyed by thread.
//
// `kernel.thread_briefs` holds one row per LINE of a thread's brief: a
// decision, an open loop, an identifier, a procedure, a contradiction. The row
// carries the key it is about and the value that key currently has, so "what is
// current" is a lookup rather than a paragraph a reader has to adjudicate. A
// line whose value changes does not overwrite the old row: the old one becomes
// `superseded` and points at its replacement, and the history stays on disk.
//
// KEYED BY THREAD, NOT BY AGENT, because a decision taken in a conversation is
// a fact of the conversation. `kernel.thread_brief_marks` says how far
// extraction has run on a thread, so a region is extracted once however many
// agents sit in it; each agent then RENDERS its own core from the same rows,
// filtered by its own join point.
//
// `kernel.thread_episodes` is the fetched half: a short body per closed stretch
// that nothing folds into a prompt until an agent asks for it by id.
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"

/** The five kinds of line a brief row can be. */
export const BRIEF_ROW_KINDS = [
  "decision",
  "open_loop",
  "identifier",
  "procedure",
  "contradiction",
] as const
export type BriefRowKind = (typeof BRIEF_ROW_KINDS)[number]

/** A brief row is current, replaced by a later value, or closed. */
export const BRIEF_ROW_STATUSES = ["current", "superseded", "closed"] as const
export type BriefRowStatus = (typeof BRIEF_ROW_STATUSES)[number]

export const threadBriefs = kernel.table(
  "thread_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** One of BRIEF_ROW_KINDS; the CHECK constraint lives in 0094. */
    kind: text("kind").$type<BriefRowKind>().notNull(),
    /** What the line is about. The stable half: supersession is keyed on it. */
    key: text("key").notNull(),
    /** What the line says. The half a later message supersedes. */
    value: text("value").notNull(),
    status: text("status").$type<BriefRowStatus>().notNull().default("current"),
    /** The row that replaced this one; null on a current row. */
    supersededBy: uuid("superseded_by"),
    messageIds: uuid("message_ids").array().notNull().default([]),
    /**
     * The EARLIEST message this line was drawn from. The ordering key of the
     * whole table: which of two values is newer is decided by where its first
     * message sits in the thread, never by a model's judgement.
     */
    firstMessageId: uuid("first_message_id").notNull(),
    regionStartMessageId: uuid("region_start_message_id"),
    regionEndMessageId: uuid("region_end_message_id"),
    writtenByAgentId: uuid("written_by_agent_id"),
    /** Set on an open loop once its closure appears in the conversation. */
    closingMessageId: uuid("closing_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("thread_briefs_thread_kind_key_first_idx").on(
      table.threadId,
      table.kind,
      table.key,
      table.firstMessageId,
    ),
    index("thread_briefs_thread_status_idx").on(table.threadId, table.status),
    index("thread_briefs_thread_kind_key_idx").on(table.threadId, table.kind, table.key),
  ],
)

export type ThreadBrief = typeof threadBriefs.$inferSelect
export type NewThreadBrief = typeof threadBriefs.$inferInsert

export const threadEpisodes = kernel.table(
  "thread_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    spanStartMessageId: uuid("span_start_message_id"),
    spanEndMessageId: uuid("span_end_message_id"),
    /** Capped by the writer at BRIEF_EPISODE_TOKEN_BUDGET, not by the column. */
    body: text("body").notNull(),
    messageIds: uuid("message_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("thread_episodes_thread_created_idx").on(table.threadId, table.createdAt),
    uniqueIndex("thread_episodes_thread_span_idx").on(
      table.threadId,
      table.spanStartMessageId,
      table.spanEndMessageId,
    ),
  ],
)

export type ThreadEpisode = typeof threadEpisodes.$inferSelect
export type NewThreadEpisode = typeof threadEpisodes.$inferInsert

/**
 * How far row extraction has run on one thread. PRIMARY KEY on the thread, not
 * on (thread, agent): the mark is what makes a region extracted ONCE however
 * many agents advance over it.
 */
export const threadBriefMarks = kernel.table("thread_brief_marks", {
  threadId: uuid("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  extractedUptoMessageId: uuid("extracted_upto_message_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type ThreadBriefMark = typeof threadBriefMarks.$inferSelect
export type NewThreadBriefMark = typeof threadBriefMarks.$inferInsert
