// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const skills = kernel.table(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    // Desired end state (Migration sequencing design call): every skill is owned by a named
    // agent. The migration adds this column nullable and unenforced; a later backfill task
    // populates it and adds NOT NULL. authorUserId stays untouched as provenance (A15).
    // Kept nullable here to match the shipped migration (0046): every create path in this
    // slice (handleCreateSkill) resolves and writes a real owner, so in practice the column
    // is never left NULL going forward, but the Drizzle type must not require a field the SQL
    // does not yet enforce — 1b's backfill+NOT NULL migration is the point this becomes
    // `.notNull()` here too.
    // The composite (owner_agent_id, org_id) foreign key lives in the table
    // config below (0072): the owner must be an agent of the SKILL'S OWN ORG.
    ownerAgentId: uuid("owner_agent_id"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    // Optional routing domain (e.g. "shipping", "finance"). Slug-format. When set,
    // skill-mutation approvals become decidable only by holders of the
    // kernel:skills:approve scope whose kernel:skills_domain dimension grant covers
    // this value (see migration 0029). Null = "general" for routing purposes.
    domain: text("domain"),
    requiredScopes: text("required_scopes").array().notNull().default(sql`'{}'::text[]`),
    forkedFrom: text("forked_from"),
    enabled: boolean("enabled").notNull().default(true),
    autoAttach: jsonb("auto_attach").$type<Record<string, unknown> | null>(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The owner agent must belong to the ROW'S OWN ORG (0072). The owner also
    // keys agent_skill_index, so a cross-org owner propagated reach as well as
    // attribution. ON DELETE is unchanged (NO ACTION): erase-user.ts NULLs
    // owner_agent_id before deleting a personal agent precisely because this
    // key would otherwise refuse the delete.
    foreignKey({
      columns: [t.ownerAgentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "skills_agent_org_fk",
    }),
    uniqueIndex("skills_unique_owner_agent_name_idx").on(t.ownerAgentId, t.name),
    // 0046 dropped 0000's (org_id, COALESCE(author_user_id, zero), name) key for the one above,
    // on a NULLABLE column, against a backfill that never landed. A NULL never conflicts with a
    // NULL, so every unowned row lost its uniqueness and an ON CONFLICT DO NOTHING insert against
    // it duplicated silently. 0093 restores the original key as a PARTIAL index over exactly the
    // rows the owner key cannot cover; the two are disjoint.
    uniqueIndex("skills_unique_unowned_author_name_idx")
      .on(
        t.orgId,
        sql`COALESCE(${t.authorUserId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.name,
      )
      .where(sql`${t.ownerAgentId} IS NULL`),
    index("skills_org_author_idx").on(t.orgId, t.authorUserId),
    check("skills_description_len_chk", sql`length(${t.description}) <= 100`),
    check("skills_body_min_chk", sql`length(${t.body}) >= 1`),
    check(
      "skills_created_by_actor_type_chk",
      sql`${t.createdByActorType} IN ('user','agent','mcp')`,
    ),
  ],
)

export type Skill = typeof skills.$inferSelect
export type NewSkill = typeof skills.$inferInsert
