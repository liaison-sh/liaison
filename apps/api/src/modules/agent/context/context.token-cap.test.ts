// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T16, rewritten for the composition that no longer ships bodies. The old
// case forced an overflow of five large skill bodies and pinned WHICH TWO the
// budget dropped. There is nothing to drop any more: a definition carries an
// INDEX of every skill the agent may use, and dropping an index line would hide
// a skill rather than defer its body. So the property this seeding now pins is
// the one that matters: the same five large skills that used to blow the budget
// compose to a definition well under it, with every skill still named and no
// body anywhere in the payload.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  AGENT_DEFINITION_TOKEN_CAP,
  composeAgentDefinition,
  estimateAgentDefinitionTokens,
} from "~/modules/agent/context/context"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cf0021"
const USER_ID = "00000000-0000-0000-0000-000000cf0022"
const AGENT_ID = "00000000-0000-0000-0000-000000cf0023"

// Four auto-surfaced bodies and one app-anchored block, each ~2,000 tokens.
const SKILLS: Array<{ name: string; chars: number; apps: string[] | null }> = [
  { name: "cap-auto-a", chars: 8000, apps: null },
  { name: "cap-auto-b", chars: 7996, apps: null },
  { name: "cap-auto-c", chars: 7992, apps: null },
  { name: "cap-auto-d", chars: 7988, apps: null },
  { name: "cap-anchored", chars: 8000, apps: ["tickets"] },
]
const bodyOf = (name: string, chars: number) => `${name}-BODY-`.padEnd(chars, "x").slice(0, chars)

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}

describe("composeAgentDefinition - five large skills fit the definition budget", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CapOrg', 'cap-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'cap@test.com', 'Cap User') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', '@cap', 'Cap Agent', '["*"]'::jsonb, 'CAP_AGENT_PROMPT') ON CONFLICT DO NOTHING`
    for (const s of SKILLS) {
      const autoAttach = s.apps ? JSON.stringify({ apps: s.apps }) : null
      await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, auto_attach, created_by_actor_type)
        VALUES (${ORG_ID}, ${AGENT_ID}, ${s.name}, ${`${s.name} description`}, ${bodyOf(s.name, s.chars)}, ${autoAttach}::jsonb, 'user')
        ON CONFLICT DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("names all five skills, ships none of their bodies, and stays under the cap", async () => {
    const def = await composeAgentDefinition({
      agentId: AGENT_ID,
      requestingActor: actor,
      orgId: ORG_ID,
    })

    expect(def.skillIndex.map((s) => s.name).sort()).toEqual(SKILLS.map((s) => s.name).sort())
    // 39,976 characters of bodies were composed before; none of it rides now.
    const payload = JSON.stringify(def)
    for (const s of SKILLS) expect(payload).not.toContain(`${s.name}-BODY-`)

    expect(estimateAgentDefinitionTokens(def)).toBeLessThanOrEqual(AGENT_DEFINITION_TOKEN_CAP)
  })
})
