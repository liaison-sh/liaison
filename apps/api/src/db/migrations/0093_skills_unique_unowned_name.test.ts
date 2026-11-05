// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0046 moved kernel.skills' uniqueness from
// (org_id, COALESCE(author_user_id, zero), name) to (owner_agent_id, name),
// on a column it added NULLABLE, against a backfill that never landed. A NULL
// never conflicts with another NULL, so every skill left unowned had no
// uniqueness at all and an ON CONFLICT DO NOTHING insert duplicated instead of
// doing nothing. 0093 restores the original key for exactly those rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

const ORG = crypto.randomUUID()
const AUTHOR = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const AGENT_B = crypto.randomUUID()
const tag = ORG.slice(0, 8)

async function insertSkill(opts: {
  name: string
  authorUserId: string | null
  ownerAgentId: string | null
}): Promise<void> {
  await sql`
    INSERT INTO kernel.skills
      (org_id, author_user_id, owner_agent_id, name, description, body,
       created_by_actor_type)
    VALUES (${ORG}, ${opts.authorUserId}, ${opts.ownerAgentId}, ${opts.name},
            'fx6 skill', 'body', 'user')`
}

/** The ON CONFLICT DO NOTHING shape every seeder and importer uses. */
async function seedSkill(name: string): Promise<void> {
  await sql`
    INSERT INTO kernel.skills
      (org_id, author_user_id, owner_agent_id, name, description, body,
       created_by_actor_type)
    VALUES (${ORG}, NULL, NULL, ${name}, 'fx6 skill', 'body', 'user')
    ON CONFLICT DO NOTHING`
}

async function countNamed(name: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM kernel.skills
     WHERE org_id = ${ORG} AND name = ${name}`
  return Number(rows[0]?.n ?? "0")
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'FX6 skills', ${`fx6-skills-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${AUTHOR}, ${ORG}, ${`fx6-skills-${tag}@test.com`}, 'FX6', 'active', 'hash')`
  for (const [id, handle] of [
    [AGENT_A, `@fx6-a-${tag}`],
    [AGENT_B, `@fx6-b-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, 'FX6 Role', '["*"]'::jsonb)`
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("0093 kernel.skills uniqueness for unowned rows", () => {
  it("refuses a second org-shared skill of the same name in one org", async () => {
    await insertSkill({ name: "fx6-org-shared", authorUserId: null, ownerAgentId: null })
    await expect(
      insertSkill({ name: "fx6-org-shared", authorUserId: null, ownerAgentId: null }),
    ).rejects.toThrow(/skills_unique_unowned_author_name_idx|duplicate key/i)
  })

  it("an ON CONFLICT DO NOTHING re-seed is a no-op, not a duplicate", async () => {
    await seedSkill("fx6-seeded")
    await seedSkill("fx6-seeded")
    await seedSkill("fx6-seeded")
    expect(await countNamed("fx6-seeded")).toBe(1)
  })

  it("refuses a second unowned skill of the same name for one author", async () => {
    await insertSkill({ name: "fx6-personal", authorUserId: AUTHOR, ownerAgentId: null })
    await expect(
      insertSkill({ name: "fx6-personal", authorUserId: AUTHOR, ownerAgentId: null }),
    ).rejects.toThrow(/skills_unique_unowned_author_name_idx|duplicate key/i)
  })

  it("an unowned row and an OWNED row of the same name still coexist (the keys are disjoint)", async () => {
    await insertSkill({ name: "fx6-disjoint", authorUserId: null, ownerAgentId: null })
    await insertSkill({ name: "fx6-disjoint", authorUserId: null, ownerAgentId: AGENT_A })
    await insertSkill({ name: "fx6-disjoint", authorUserId: null, ownerAgentId: AGENT_B })
    expect(await countNamed("fx6-disjoint")).toBe(3)
  })

  it("the owner key still refuses two skills of one name under one owner agent", async () => {
    await insertSkill({ name: "fx6-owned", authorUserId: null, ownerAgentId: AGENT_A })
    await expect(
      insertSkill({ name: "fx6-owned", authorUserId: null, ownerAgentId: AGENT_A }),
    ).rejects.toThrow(/skills_unique_owner_agent_name_idx|duplicate key/i)
  })
})
