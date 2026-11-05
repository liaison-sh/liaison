// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  check,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

// Named agents: a role agent (owned by nobody, shared org-wide), a personal
// agent (owned by exactly one user), or a system agent (built in). One row
// per (orgId, handle). RLS policies land in T02; this task only shapes the
// table.
export const agentKindEnum = kernel.enum("agent_kind", ["role", "personal", "system"])

export const agents = kernel.table(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: agentKindEnum("kind").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    // CASCADE, not SET NULL (0054): a `kind='personal'` row's
    // agents_owner_user_id_personal_chk requires owner_user_id IS NOT NULL
    // whenever kind='personal', so a SET NULL cascade from a hard-deleted
    // owner (the only real-world path: deleting an org deletes its users
    // first, per users_org_fk being RESTRICT) violated that check immediately
    // on every org deletion once T17 started auto-creating a personal agent
    // at bootstrap. Role/system agents have ownerUserId always NULL and are
    // unaffected either way.
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    // spec-agents.md's data-model table labels this "jsonb (scope map)", but the
    // value stored is a flat array of scope strings, matching
    // subAgentDefinitions.scopeCeiling's semantics (sub-agent-definitions.ts:26,
    // a plain text[]) and the shape resolveScopes() already consumes as
    // string[] (rls.ts:24-44). jsonb is used here only because the spec calls
    // for jsonb storage; the string-array semantics are unchanged.
    scopeCeiling: jsonb("scope_ceiling").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // An administrator's deliberate narrowing of a PERSONAL agent (0218). The
    // ceiling is re-derived from the owner's grants on every grant change, as
    // owner's scopes ∩ this restriction; null means the owner's scopes.
    ceilingRestriction: jsonb("ceiling_restriction").$type<string[] | null>(),
    systemPrompt: text("system_prompt").notNull().default(""),
    // THE ONE SENTENCE THE DIRECTORY AND THE PAGE HEADER SHOW (0096). Until
    // this column existed the sentence was derived from the prompt's first
    // line, which made it uneditable on its own; `deriveAgentPurpose` prefers
    // this value and still falls back to that line when it is null.
    purpose: text("purpose"),
    // The picture every participant surface already renders a slot for.
    avatarUrl: text("avatar_url"),
    // Which of the eight agent avatar gradients the disc wears (0221), 0-7.
    // Every create path gives a new agent the colour its org uses least
    // (`pickAgentAvatarColor`), so agents in one org differ; a person may pick
    // another. Null only on a row nothing assigned: the web falls back to a
    // hash of the id.
    avatarColor: smallint("avatar_color"),
    // Which model this agent's turns ask for, null meaning Auto. A preference,
    // never a permission: what the org may actually call is decided server
    // side by the provider keys and the plan, as it is for a human's pick.
    modelPreference: text("model_preference"),
    toolAllowlist: text("tool_allowlist").array(),
    toolDenylist: text("tool_denylist").array(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_org_handle_idx").on(t.orgId, t.handle),
    index("agents_org_kind_idx").on(t.orgId, t.kind),
    check(
      "agents_owner_user_id_personal_chk",
      sql`(${t.kind} = 'personal') = (${t.ownerUserId} IS NOT NULL)`,
    ),
    check(
      "agents_avatar_color_range_chk",
      sql`${t.avatarColor} IS NULL OR (${t.avatarColor} BETWEEN 0 AND 7)`,
    ),
  ],
)

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
export type AgentKind = "role" | "personal" | "system"
