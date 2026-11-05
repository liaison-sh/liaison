// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `checkArchiveBlockers` runs privileged (withSystemDb), so nothing but its own
// predicates keeps it inside the caller's org. `agent_skill_index.skill_id`
// carries a plain foreign key, not the composite (id, org_id) one the agent
// side uses, so ANOTHER org's index row can name this org's skill: without the
// org predicate on the join, that foreign row reads as "a second agent
// references this skill" and blocks an archive nothing is actually blocking.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { checkArchiveBlockers } from "~/modules/agent/directory/archive"

const ORG_A = crypto.randomUUID()
const ORG_B = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const AGENT_B = crypto.randomUUID()
const SKILL_ID = crypto.randomUUID()
const tag = ORG_A.slice(0, 8)

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, `archive-org-a-${tag}`],
    [ORG_B, `archive-org-b-${tag}`],
  ] as const) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, 'ArchiveScope', ${slug})`
  }
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${AGENT_A}, ${ORG_A}, 'role', ${`@archive-a-${tag}`}, 'A', '[]'::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${AGENT_B}, ${ORG_B}, 'role', ${`@archive-b-${tag}`}, 'B', '[]'::jsonb)`
  await sql`INSERT INTO kernel.skills
      (id, org_id, name, description, body, created_by_actor_type, owner_agent_id)
    VALUES (${SKILL_ID}, ${ORG_A}, ${`skill-${tag}`}, 'd', 'b', 'user', ${AGENT_A})`
  // Another org's index row naming this org's skill, for an agent that is not
  // the one being archived: the shape the missing org predicate mistook for a
  // blocking cross-agent reference.
  await sql`INSERT INTO kernel.agent_skill_index (org_id, agent_id, skill_name, skill_id)
    VALUES (${ORG_B}, ${AGENT_B}, ${`skill-${tag}`}, ${SKILL_ID})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_skill_index WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

describe("checkArchiveBlockers: the skill index join is org scoped", () => {
  it("another org's index row naming this skill does not block the archive", async () => {
    const result = await checkArchiveBlockers(AGENT_A, ORG_A)
    expect(result.skills).toEqual([])
    expect(result.blocked).toBe(false)
  })

  it("an index row in THIS org for another agent still blocks it", async () => {
    const other = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${other}, ${ORG_A}, 'role', ${`@archive-a2-${tag}`}, 'A2', '[]'::jsonb)`
    await sql`INSERT INTO kernel.agent_skill_index (org_id, agent_id, skill_name, skill_id)
      VALUES (${ORG_A}, ${other}, ${`skill-${tag}`}, ${SKILL_ID})`
    try {
      const result = await checkArchiveBlockers(AGENT_A, ORG_A)
      expect(result.skills.map((s) => s.id)).toEqual([SKILL_ID])
      expect(result.blocked).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.agent_skill_index WHERE agent_id = ${other}`
      await sql`DELETE FROM kernel.agents WHERE id = ${other}`
    }
  })
})
