// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T04: the roster is a STABLE system part sitting immediately after the
// charter, in both runtimes.
//
// Placement matters twice. Before the user identity line and every skill block,
// because everything after the first per turn byte is uncacheable. And through
// ONE renderer, because the in app turn, the definition route and the desktop
// local session must carry byte identical text (S14, I6).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { AGENT_ROSTER_OPEN_TAG, AGENT_ROSTER_TOKEN_CAP } from "~/modules/agent/context/agent-roster"
import { estimateTokens } from "~/modules/agent/context/compaction"
import {
  AGENT_CHARTER_OPEN_TAG,
  assembleContext,
  composeAgentDefinition,
  resetSystemPromptCache,
  systemPartsToText,
} from "~/modules/agent/context/context"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const SELF = crypto.randomUUID()
const COMMERCE = crypto.randomUUID()
const LOGISTICS = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

/** The roster block alone, tag to tag, out of a rendered system prompt. */
function rosterBlock(text: string): string {
  const open = text.indexOf(AGENT_ROSTER_OPEN_TAG)
  if (open < 0) return ""
  const close = text.indexOf("</agent-roster>", open)
  return text.slice(open, close < 0 ? undefined : close + "</agent-roster>".length)
}

beforeAll(async () => {
  await acquireTestLock()
  resetSystemPromptCache()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Roster Org', ${`p3b-t04-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-t04-${tag}@test.com`}, 'Roster User')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${SELF}, ${ORG}, 'role', '@support', 'Support', 'You answer customer questions.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${COMMERCE}, ${ORG}, 'role', '@commerce', 'Commerce', 'You own invoices and orders.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${LOGISTICS}, ${ORG}, 'role', '@logistics', 'Logistics', 'You own shipments and carriers.')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p3b-t04-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("the roster in the stable prefix", () => {
  it("assembleContext places the roster immediately after the charter", async () => {
    const result = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })
    const charterAt = result.system.findIndex((p) => p.content.includes(AGENT_CHARTER_OPEN_TAG))
    const rosterAt = result.system.findIndex((p) => p.content.includes(AGENT_ROSTER_OPEN_TAG))
    expect(charterAt).toBeGreaterThan(-1)
    expect(rosterAt).toBe(charterAt + 1)
  })

  it("assembleContext renders no roster part when no agent id is given", async () => {
    const result = await assembleContext({ threadId: THREAD, orgId: ORG, actor })
    expect(systemPartsToText(result.system)).not.toContain(AGENT_ROSTER_OPEN_TAG)
  })

  it("composeAgentDefinition and assembleContext render the identical roster text", async () => {
    const turn = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })
    const definition = await composeAgentDefinition({
      agentId: SELF,
      requestingActor: actor,
      orgId: ORG,
    })
    const fromTurn = rosterBlock(systemPartsToText(turn.system))
    const fromDefinition = rosterBlock(definition.systemPrompt)
    expect(fromTurn.length).toBeGreaterThan(0)
    expect(fromDefinition).toBe(fromTurn)
  })

  it("the stable parts are byte identical across two assembleContext calls with a new message in between", async () => {
    const a = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${THREAD}, ${ORG}, ${USER}, 'user', 'a new message between two assemblies', '{}'::text[])`
    const b = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })
    expect(systemPartsToText(b.system)).toBe(systemPartsToText(a.system))
  })

  it("the stable prefix changes when the roster changes and not otherwise", async () => {
    const first = systemPartsToText(
      (await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })).system,
    )
    const second = systemPartsToText(
      (await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })).system,
    )
    expect(second).toBe(first)
    await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${LOGISTICS}`
    const afterChange = systemPartsToText(
      (await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })).system,
    )
    expect(afterChange).not.toBe(second)
    const afterNoChange = systemPartsToText(
      (await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })).system,
    )
    expect(afterNoChange).toBe(afterChange)
    await sql`UPDATE kernel.agents SET archived_at = NULL WHERE id = ${LOGISTICS}`
  })

  it("assembleContext issues no extra agent query for the roster", async () => {
    // The roster read is FOLDED into the charter's privileged agent read: the
    // assembly selects from kernel.agents ONCE and picks the acting agent out
    // of the org's live rows. A turn therefore still costs one agent read, and
    // a second privileged roster query (loadRosterRows, the definition route's
    // own read) reaching this path fails here.
    const source = await Bun.file(new URL("./context.ts", import.meta.url)).text()
    const from = source.indexOf("export async function assembleContext(")
    const to = source.indexOf("export function systemPartsToText(")
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const assembly = source.slice(from, to)
    expect(assembly.split(".from(agents)").length - 1).toBe(1)
    expect(assembly).toContain("renderAgentRoster(")
    expect(assembly).not.toContain("loadRosterRows(")
  })

  it("the roster tells the asker to relay and the asked agent to answer the question", async () => {
    // The relay half is model driven: nothing downstream can check that a
    // sentence a model writes only contains facts from the answer it was
    // handed. The prod defect (a count of 22 relayed out of an answer about a
    // different ticket, and the asked agent answering that other ticket) is
    // therefore carried as an obligation in the prompt, and what is asserted
    // here is that the obligation is IN the prompt every agent receives.
    const result = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })
    const roster = rosterBlock(systemPartsToText(result.system))
    expect(roster).toContain("An answer that came back is not proof the question was")
    expect(roster).toContain("relay only what the colleague's answer actually says")
    expect(roster).toContain("rather than supplying the missing figure yourself")
    expect(roster).toContain("Answer the question you were just asked, not what this conversation")
    expect(roster).toContain("your own pending work is not the question")
  })

  it("the budget line reports rosterTokens under the roster cap", async () => {
    const result = await assembleContext({ threadId: THREAD, orgId: ORG, actor, agentId: SELF })
    const rosterPart = result.system.find((p) => p.content.includes(AGENT_ROSTER_OPEN_TAG))
    expect(rosterPart).toBeDefined()
    const rosterTokens = estimateTokens(rosterPart?.content ?? "")
    expect(rosterTokens).toBeGreaterThan(0)
    expect(rosterTokens).toBeLessThan(AGENT_ROSTER_TOKEN_CAP)
  })
})
