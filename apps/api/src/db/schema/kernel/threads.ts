// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const threads = kernel.table(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    handle: text("handle").notNull(),
    title: text("title"),
    isPinned: boolean("is_pinned").notNull().default(false),
    type: text("type").notNull().default("thread"),
    // When true, the thread is hidden from the global thread list (sidebar,
    // search). Used for task-bound threads (and any other entity-embedded
    // thread). Users can "promote" by flipping to false.
    hiddenFromList: boolean("hidden_from_list").notNull().default(false),
    // A channel: org-wide listable and joinable by any member (spec-home.md
    // "One channel type"). Orthogonal to `type`, which gains no new value, and
    // parallel to hiddenFromList above. False for every pre-existing row:
    // nothing becomes a public channel without an explicit action.
    discoverable: boolean("discoverable").notNull().default(false),
    // The Slack/Buzz pair on a channel. `topic` is the one line that travels
    // with the NAME (header beside the title, unjoined discoverable row): what
    // the room is on about right now, capped at 250 characters by the column's
    // own CHECK. `description` is the standing "what is this channel", a few
    // sentences shown in the channel details and capped at 2000. Both nullable
    // and both null on every pre-existing row: a channel that has said nothing
    // about itself renders nothing, which an empty string could not express.
    topic: text("topic"),
    description: text("description"),
    createdFrom: jsonb("created_from").$type<{
      app: string
      entityType: string
      entityId: string
      actorId?: string
    } | null>(),
    // Phase 4 placeholder: marks threads created from untrusted external entities
    tainted: boolean("tainted").notNull().default(false),
    // When a person last cleared the outside-text mark (kernel:outside_text_clear): the creation
    // time of the card they approved. History written at or before it no longer marks a turn that
    // replays it. Null: never cleared.
    taintClearedAt: timestamp("taint_cleared_at", { withTimezone: true }),
    // When the mark was last set (database clock; a replayed mark carries its newest source row's
    // time). A clear keeps a mark set after its approval card was created.
    taintedAt: timestamp("tainted_at", { withTimezone: true }),
    // Where the outside text that set the mark came from: the namespace of each MCP server whose
    // result marked it (`mcp:<slug>`). Null: unknown (another kind of source, or a mark set before
    // migration 0199), which keeps every hold (scope-taint.ts, rule 6h).
    taintedSources: text("tainted_sources").array(),
    agentModelId: text("agent_model_id"),
    // Per-model reasoning level map ({ [modelId]: "off"|"low"|"medium"|"high" }) for
    // shared-thread agents. Shared-row setting, thread-admin gated like agent_model_id.
    agentReasoningLevels: jsonb("agent_reasoning_levels")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // Deferred-tool discovery persistence: SDK names of app tools the agent has
    // unlocked via tool_search in this thread, so follow-up turns keep them
    // loaded without re-searching (app tools are deferred by default).
    agentDiscoveredTools: jsonb("agent_discovered_tools").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("threads_org_updated_idx").on(table.orgId, table.updatedAt),
    uniqueIndex("threads_org_handle_idx").on(table.orgId, table.handle),
    index("threads_org_type_updated_idx").on(table.orgId, table.type, table.updatedAt),
  ],
)

export const threadParticipants = kernel.table(
  "thread_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // Nullable since 0075: a participant row is EITHER a human or an agent,
    // never both and never neither (the CHECK below). An agent row carries
    // user_id NULL.
    userId: uuid("user_id").references(() => users.id),
    orgId: uuid("org_id").notNull(),
    // "user" | "agent", and nothing else (the vocabulary CHECK below, 0079).
    // Plain text, matching threads.type and messages.authorType in this same
    // file, not a Postgres enum.
    participantType: text("participant_type").notNull().default("user"),
    // The composite (agent_id, org_id) foreign key lives in the table config
    // below (0075), the class 0072 closed: a single-column key checks existence
    // only, so an org-A thread could seat an org-B agent.
    agentId: uuid("agent_id"),
    role: text("role").notNull().default("member"),
    // How an AGENT seat came to be (0137, D23a): "mention" when an @mention
    // seated it, NULL when it was added on purpose (or for a person's seat).
    // A mention seat does not turn the DM between two people into a group
    // (seatMakesGroupOfDm in @liaison/shared).
    seatOrigin: text("seat_origin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Two PARTIAL unique indexes, not one index over both columns: Postgres
    // does not treat two NULLs as equal, so a single (thread_id, user_id,
    // agent_id) unique index would happily admit the same agent twice (both
    // rows have user_id NULL).
    uniqueIndex("thread_participants_thread_user_idx")
      .on(table.threadId, table.userId)
      .where(sql`user_id IS NOT NULL`),
    uniqueIndex("thread_participants_thread_agent_idx")
      .on(table.threadId, table.agentId)
      .where(sql`agent_id IS NOT NULL`),
    index("thread_participants_user_idx").on(table.userId),
    index("thread_participants_org_idx").on(table.orgId),
    // ON DELETE CASCADE, a BINDING row (0073's reading), not history: a
    // hard-deleted agent leaves no membership behind, and the CHECK below
    // makes SET NULL impossible here anyway (a row with neither id set).
    foreignKey({
      columns: [table.agentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "thread_participants_agent_org_fk",
    }).onDelete("cascade"),
    check(
      "thread_participants_one_of_user_or_agent",
      sql`(${table.userId} IS NOT NULL) <> (${table.agentId} IS NOT NULL)`,
    ),
    // 0079: the discriminator is a closed vocabulary. The equivalence below
    // only pins the 'user' end, so on an agent row any third value passed it
    // and was invisible to every read (they all filter participant_type =
    // 'agent'). Named to sort BEFORE the check below and after the one above,
    // which is the order the suites pin.
    check(
      "thread_participants_participant_type_vocabulary",
      sql`${table.participantType} IN ('user', 'agent')`,
    ),
    // 0137: the only seat origin recorded is the @mention one.
    check(
      "thread_participants_seat_origin_vocabulary",
      sql`${table.seatOrigin} IS NULL OR ${table.seatOrigin} = 'mention'`,
    ),
    // 0078: the discriminator has to agree with the id columns it describes.
    // Without this, a row carrying agent_id at the DEFAULT 'user' is an
    // invisible agent seat (every read filters on participant_type), and a
    // human row can claim 'agent'. Named to sort after the check above:
    // Postgres evaluates CHECK constraints in constraint-name order and a row
    // violating both must still report the exactly-one rule.
    check(
      "thread_participants_type_matches_ids",
      sql`(${table.participantType} = 'user') = (${table.userId} IS NOT NULL)`,
    ),
  ],
)

export const messages = kernel.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    authorId: uuid("author_id").notNull(),
    authorType: text("author_type").notNull().default("user"),
    content: text("content").notNull(),
    mentions:
      jsonb("mentions").$type<
        Array<
          | { type: "user"; id: string }
          | { type: "thread"; id: string }
          | { type: "entity"; app: string; entityType: string; id: string }
          | { type: "agent" }
        >
      >(),
    metadata: jsonb("metadata"),
    // Read-time visibility: a member sees the message only when they hold every
    // scope listed here, or appear in disclosureList (null means no disclosure).
    // No default (0066): every writer states what the row may quote. Omitting
    // it is a type error here and a 23502 in the database, never a silent
    // publish to the whole room.
    requiredScopes: text("required_scopes").array().notNull(),
    disclosureList: uuid("disclosure_list").array(),
    // The speaking agent (A8). Nullable at the column level; an INSERT with
    // author_type = 'agent' and no agent named is refused by the database
    // (0076's trigger), and the front end resolves the name and avatar from
    // this row instead of a client-side sentinel. Null on an agent row means
    // one thing only: the agent was hard-deleted (its owner's erasure) and the
    // composite key's ON DELETE SET NULL cleared the attribution. The composite
    // (author_agent_id, org_id) foreign key lives in the table config below.
    authorAgentId: uuid("author_agent_id"),
    // The message this one is nested under (P3b). Null is the audience
    // asymmetry: a human facing turn is flattened to the thread root, an agent
    // only turn nests under the message that triggered it. The parent chain is
    // also what every dispatch guard reads: hop depth is the chain's agent
    // authored link count, the root turn is the chain's root, the per root cap
    // counts agent authored descendants of that root, and the dedupe is a
    // sibling scan. A PLAIN self foreign key, not the composite
    // (parent_message_id, org_id) the rule demands for keys into
    // kernel.agents: that composite exists because agents is an org scoped
    // PRINCIPAL table reachable from another org's row. A self key inside
    // messages cannot cross orgs, because thread_id already pins the org.
    parentMessageId: uuid("parent_message_id"),
    // The ROOT of the reply thread this message belongs to (0112), or null for
    // a channel message. A reply is never a root. Orthogonal to
    // parentMessageId, which stays the agent chain the dispatch guards walk.
    // The composite (reply_root_id, thread_id) key below keeps a reply in its
    // root's own thread.
    replyRootId: uuid("reply_root_id"),
    // "Also send to channel": a reply that ALSO shows in the channel list.
    // Only a reply may carry it (messages_also_in_channel_needs_root).
    alsoInChannel: boolean("also_in_channel").notNull().default(false),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Import dedup key `<source>:<key>` (0208, modules/imports), unique per
    // thread. Null for every message written by the product itself.
    externalRef: text("external_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_thread_created_idx").on(table.threadId, table.createdAt),
    uniqueIndex("uniq_kernel_messages_thread_external_ref")
      .on(table.orgId, table.threadId, table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
    index("messages_org_idx").on(table.orgId),
    // A person's own messages over a window (0251).
    index("messages_author_created_idx").on(table.authorId, table.createdAt),
    // An approval's last payload edit (0156): the approvals list reads the
    // newest one per approval thread, and those threads hold thousands of
    // messages. Partial, so the lookup reaches only the edit rows and the
    // messages RLS policy runs on those, not on the whole thread.
    index("messages_payload_edit_idx")
      .on(table.threadId, table.createdAt)
      .where(sql`author_type = 'system' AND (metadata ->> 'type') = 'payload-edit'`),
    // Composite, the class 0072 closed. ON DELETE SET NULL (author_agent_id) is
    // declared in 0076's SQL, not here: a HISTORY row must survive its agent's
    // deletion (0070's audit_log reading), and Drizzle cannot express Postgres
    // 15's SET NULL column list, which is what keeps the cascade from nulling
    // the NOT NULL org_id half of the key.
    foreignKey({
      columns: [table.authorAgentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "messages_author_agent_org_fk",
    }),
    index("messages_author_agent_idx")
      .on(table.authorAgentId)
      .where(sql`author_agent_id IS NOT NULL`),
    foreignKey({
      columns: [table.parentMessageId],
      foreignColumns: [table.id],
      name: "messages_parent_message_fk",
    }).onDelete("cascade"),
    index("messages_parent_idx")
      .on(table.parentMessageId)
      .where(sql`parent_message_id IS NOT NULL`),
    // 0112: the target of every composite key into a message of a given thread.
    unique("messages_id_thread_uk").on(table.id, table.threadId),
    foreignKey({
      columns: [table.replyRootId, table.threadId],
      foreignColumns: [table.id, table.threadId],
      name: "messages_reply_root_fk",
    }).onDelete("cascade"),
    index("messages_thread_reply_root_created_idx")
      .on(table.threadId, table.replyRootId, table.createdAt)
      .where(sql`reply_root_id IS NOT NULL`),
    check("messages_reply_root_not_self", sql`reply_root_id IS NULL OR reply_root_id <> id`),
    check(
      "messages_also_in_channel_needs_root",
      sql`NOT also_in_channel OR reply_root_id IS NOT NULL`,
    ),
  ],
)

/**
 * Who follows a reply thread (0112): the root's author, every replier, and
 * every member mentioned in a reply. `lastReadAt` is how far this follower has
 * read the thread; null means never opened. FORCE RLS: a row is created only by
 * a member of the root's thread, and only for another member of it.
 */
export const replyThreadFollowers = kernel.table(
  "reply_thread_followers",
  {
    rootMessageId: uuid("root_message_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.rootMessageId, table.userId] }),
    foreignKey({
      columns: [table.rootMessageId, table.threadId],
      foreignColumns: [messages.id, messages.threadId],
      name: "reply_thread_followers_root_fk",
    }).onDelete("cascade"),
    index("reply_thread_followers_org_user_idx").on(table.orgId, table.userId),
  ],
)

export const messageReactions = kernel.table(
  "message_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    orgId: uuid("org_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_reactions_msg_user_emoji_idx").on(
      table.messageId,
      table.userId,
      table.emoji,
    ),
    index("message_reactions_org_idx").on(table.orgId),
  ],
)

export const threadReferences = kernel.table(
  "thread_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    app: text("app").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    addedBy: uuid("added_by").notNull(),
    lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("thread_references_unique_idx").on(
      table.threadId,
      table.app,
      table.entityType,
      table.entityId,
    ),
    index("thread_references_entity_idx").on(table.app, table.entityType, table.entityId),
    index("thread_references_thread_recent_idx").on(table.threadId, table.lastVisitedAt),
  ],
)

export const userThreadState = kernel.table(
  "user_thread_state",
  {
    userId: uuid("user_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    isArchived: boolean("is_archived").notNull().default(false),
    isMuted: boolean("is_muted").notNull().default(false),
    isPinned: boolean("is_pinned").notNull().default(false),
    /** The member's opt-in to be interrupted by every post of this channel (0259). */
    notifyAllPosts: boolean("notify_all_posts").notNull().default(false),
    lastReadMessageId: uuid("last_read_message_id"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.threadId] }),
    index("user_thread_state_thread_id_idx").on(table.threadId),
  ],
)
