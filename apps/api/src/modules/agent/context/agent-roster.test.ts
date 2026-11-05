// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T03: the roster block an agent reads to know the other agents in its org.
//
// It is a STABLE system part: it interpolates nothing per turn, so it rides in
// the cached prefix and costs no cache miss (invariant I2). These cases pin
// exactly that, plus the fail closed membership rules (no @base, no self, no
// archived agent).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  AGENT_ROSTER_TOKEN_CAP,
  loadRosterRows,
  type RosterRow,
  renderAgentRoster,
} from "~/modules/agent/context/agent-roster"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { resetSystemPromptCache } from "~/modules/agent/context/context"

const ORG = crypto.randomUUID()
const SELF = crypto.randomUUID()
const BASE = crypto.randomUUID()
const COMMERCE = crypto.randomUUID()
const LOGISTICS = crypto.randomUUID()
const ARCHIVED = crypto.randomUUID()
const DATA = crypto.randomUUID()
const PERSONAL = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const SOLO_ORG = crypto.randomUUID()
const SOLO_AGENT = crypto.randomUUID()
const tag = ORG.slice(0, 8)

async function render(orgId: string, selfAgentId: string): Promise<string> {
  return renderAgentRoster({
    orgId,
    selfAgentId,
    rows: await loadRosterRows(orgId, selfAgentId),
  })
}

beforeAll(async () => {
  resetSystemPromptCache()
  for (const [id, name] of [
    [ORG, `p3b-t03-${tag}`],
    [SOLO_ORG, `p3b-t03-solo-${tag}`],
  ]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, 'P3b T03', ${name})`
  }
  // Seeded out of handle order on purpose: the rendered order must come from
  // the query, never from insertion order.
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${SELF}, ${ORG}, 'role', '@support', 'Support', 'You answer customer questions.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${LOGISTICS}, ${ORG}, 'role', '@logistics', 'Logistics', 'You own shipments and carriers.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${COMMERCE}, ${ORG}, 'role', '@commerce', 'Commerce', 'You own invoices and orders.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${BASE}, ${ORG}, 'system', '@base', 'Liaison', 'The built in system agent.')`
  // A role agent as migrate-agents writes it: the purpose column set, the
  // system prompt empty. Its roster line comes from the column alone.
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt, purpose)
    VALUES (${DATA}, ${ORG}, 'role', '@data', 'Data', '', 'Owns the KPI registry and its figures.')`
  // A colleague's personal agent: it acts for one person and owns no area.
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${OWNER}, ${ORG}, ${`p3b-t03-${tag}@t.com`}, 'Tobias Braun')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt, owner_user_id)
    VALUES (${PERSONAL}, ${ORG}, 'personal', '@tobias', 'Personal agent', '', ${OWNER})`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt, archived_at)
    VALUES (${ARCHIVED}, ${ORG}, 'role', '@retired', 'Retired', 'You used to own returns.', now())`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, system_prompt)
    VALUES (${SOLO_AGENT}, ${SOLO_ORG}, 'role', '@only', 'Only', 'You are the one agent here.')`
})

afterAll(async () => {
  for (const id of [ORG, SOLO_ORG]) {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
  }
})

describe("renderAgentRoster", () => {
  it("renderAgentRoster is byte stable across two calls for the same roster", async () => {
    const first = await render(ORG, SELF)
    const second = await render(ORG, SELF)
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(0)
  })

  it("renderAgentRoster excludes the base agent and the asking agent", async () => {
    const block = await render(ORG, SELF)
    expect(block).not.toContain("@base")
    expect(block).not.toContain("@support")
    expect(block).toContain("@commerce")
    expect(block).toContain("@logistics")
  })

  it("renderAgentRoster names a role agent's purpose column when its system prompt is empty", async () => {
    // loadRosterRows did not select `purpose`, so every roster agent created by
    // migrate-agents (purpose set, system prompt empty) rendered as a bare
    // `- @data (role):` and agents routed by guessing from handles.
    const block = await render(ORG, SELF)
    expect(block).toContain("- @data (role): Owns the KPI registry and its figures.")
  })

  it("renderAgentRoster excludes archived agents", async () => {
    const block = await render(ORG, SELF)
    expect(block).not.toContain("@retired")
  })

  it("renderAgentRoster lists no personal agent", async () => {
    // Listed as "- @tobias (personal):", a colleague's personal agent read as
    // the colleague: asked to "answer tobias", an agent asked @tobias instead
    // of answering the person. A personal agent owns no area to delegate to.
    const block = await render(ORG, SELF)
    expect(block).not.toContain("@tobias")
    expect(block).not.toContain("(personal)")
    // The same rule holds for a caller that hands over unfiltered rows.
    const rows = await loadRosterRows(ORG, SELF)
    const withPersonal: RosterRow[] = [
      ...rows,
      {
        id: PERSONAL,
        handle: "@tobias",
        kind: "personal",
        displayName: "Personal agent",
        systemPrompt: "",
        purpose: null,
      },
    ]
    const unfiltered = await renderAgentRoster({
      orgId: ORG,
      selfAgentId: SELF,
      rows: withPersonal,
    })
    expect(unfiltered).not.toContain("@tobias")
  })

  it("renderAgentRoster orders lines by handle", async () => {
    const block = await render(ORG, SELF)
    expect(block.indexOf("@commerce")).toBeLessThan(block.indexOf("@logistics"))
  })

  it("renderAgentRoster returns an empty string for a roster of one", async () => {
    expect(await render(SOLO_ORG, SOLO_AGENT)).toBe("")
  })

  it("renderAgentRoster cuts a large roster at the cap and says how many it left out", async () => {
    // A big org: the roster is a budget, not a dump. It is rendered in handle
    // order and cut at the cap, with a last line naming the remainder so an
    // agent knows the list is partial and how to reach the rest.
    const rows: RosterRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: crypto.randomUUID(),
      handle: `@agent-${String(i).padStart(2, "0")}`,
      kind: "role",
      displayName: `Agent ${i}`,
      systemPrompt: `You own the ${i} area of this business and answer questions about it.`,
    })) as RosterRow[]
    const block = await renderAgentRoster({ orgId: ORG, selfAgentId: SELF, rows })
    expect(estimateTokens(block)).toBeLessThanOrEqual(AGENT_ROSTER_TOKEN_CAP)
    const rendered = (block.match(/^- @agent-/gm) ?? []).length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(40)
    expect(block).toContain(
      `and ${40 - rendered} more agents: ask any of them by handle with kernel__agents_ask`,
    )
    // Cut from the END of the handle order, never from the middle.
    expect(block).toContain("@agent-00")
    expect(block).not.toContain(`@agent-${String(39).padStart(2, "0")}`)
  })

  it("the roster tells an agent not to answer for a colleague addressed beside it", async () => {
    // The roster's delegation rule ("when something belongs to another agent,
    // ask that agent") is what a co-addressed agent read as a reason to ask the
    // colleague already answering, and then to post that colleague's answer in
    // its own reply. The exception belongs HERE and not only in the per turn
    // line, so it also holds in a DM and wherever the fan out is implicit.
    const block = await render(ORG, SELF)
    expect(block).toContain(
      "An agent addressed in the same message as you is already answering: do not ask it and do not\nanswer for it.",
    )
  })

  it("the roster forbids asking yourself", async () => {
    // Seen in production: a personal agent answering its owner's question
    // called agents_ask with its own handle. The roster lists everyone BUT the
    // agent, so nothing in it said the missing handle was the agent's own.
    const block = await render(ORG, SELF)
    expect(block).toContain("never call kernel__agents_ask with your own handle")
    expect(block).toContain("is yours to answer with your own tools")
  })

  it("the roster tells an agent to answer here, never to mention the asker back", async () => {
    // An agent authored reply dispatches NOTHING (pinned by the threads_reply
    // case in mention-dispatch-guard.test.ts), so "mention that agent when you
    // are done" was an instruction that could not work: the answer travels back
    // through agents_ask and the mention only burns tokens.
    const block = await render(ORG, SELF)
    expect(block).not.toContain("mention that agent")
    expect(block).toContain("receives your answer through kernel__agents_ask")
  })

  it("the roster tells an agent to report an unanswered ask and never fill the figure in", async () => {
    // Measured, not assumed: a flash-lite agent whose ask was withheld or cut
    // returned a fabricated invoice total to the person in about half of the
    // live runs. Nothing in the roster said what to do with a failed ask.
    // The rule wraps across two source lines, so it is read as the model reads
    // it: one sentence, whatever the line breaks are.
    const block = (await render(ORG, SELF)).replace(/\s+/g, " ")
    expect(block).toContain("If an ask is refused, withheld or unanswered")
    expect(block).toContain("never fill in a figure or a fact you did not receive")
    // And where the person can go instead: the entry agent that could not get
    // an answer names the colleague to address directly.
    expect(block).toContain("tell them which agent to address directly")
    // The machine name half of the same rule: a tool identifier written into
    // one agent's prompt came back out of it and reached a person.
    expect(block).toContain("Never name a tool identifier to a person")
  })

  it("renderAgentRoster interpolates no per turn field", async () => {
    const block = await render(ORG, SELF)
    expect(block).not.toMatch(/\b(19|20)\d{2}\b/)
    expect(block).not.toContain(new Date().toISOString().slice(0, 10))
  })
})
