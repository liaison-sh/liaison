// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Changing a reconcile card after it was drawn, through the real tool path: by talk (the agent's
// call) and by the card's inline field (the call the card's edit sends), reading it again, what a
// coding agent's terminal reads, and what the card says about sources the asker cannot read.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { CardTemplate } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { markSupersededWithinTurn } from "~/modules/agent/runtime/tool-card-store"
import { effectiveScopeDm } from "~/modules/agent/scopes/effective-scope"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { resolveToolCard } from "~/modules/apps/result-card"
import { seedContext } from "~/seed/context"
import { seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { NOT_YOURS_TO_READ } from "./reconcile"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

let orgId = ""
let owner: minimal.Session
let other: minimal.Session
let dmThread = ""
let projectId = ""
const t: Record<string, string> = {}
const HPD = 420
const day = (d: number) => Math.round(d * HPD)
const template = (
  projectsAppManifest as unknown as { tools: Record<string, { resultCard: CardTemplate }> }
).tools.reconcile_propose?.resultCard as CardTemplate

type Card = Record<string, any>

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function tool(
  name: string,
  params: Record<string, unknown>,
  opts: { userId?: string; scopes?: string[]; origin?: "in-app-agent" | "human-ui" | "mcp" } = {},
): Promise<Card> {
  const origin = opts.origin ?? "in-app-agent"
  const run = () =>
    executeToolCore({
      toolName: `projects:${name}`,
      orgId,
      actor: actorOf(opts.userId ?? owner.userId, opts.scopes),
      params,
      origin,
      ...(origin === "in-app-agent" ? { threadId: dmThread } : {}),
    } as never) as Promise<Card>
  const runId = crypto.randomUUID()
  const frame = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
    ...(origin === "mcp"
      ? { mcpGateway: true }
      : origin === "in-app-agent"
        ? { humanTurn: true }
        : {}),
  }
  const out = (await runContextStore.run(frame as never, run)) as Card
  await awaitTimeRowWrites()
  return (out.data ?? out) as Card
}

const proposal = () => ({
  project: "ATLAS",
  month: "2026-10",
  lines: [
    {
      name: "Data export",
      kind: "planned",
      taskIds: [t.e1, t.e2],
      proofs: [{ kind: "pull_request", ref: "212", label: "PR #212" }],
    },
    { name: "Monitoring", kind: "planned", taskIds: [t.m1, t.m2], proofs: [] },
  ],
})

/** The lines as stored, without the ids that differ between two cards. */
const sameLines = (card: Card) => (card.lines as Card[]).map(({ lineId: _id, ...l }) => l)

/** What the card's inline field sends: the card's own params, its row and one field. */
function inlineCall(card: Card, lineName: string, param: string, value: number) {
  const drawn = resolveToolCard(template, card)
  if (!drawn?.edit) throw new Error("the card offers no edit")
  const row = (drawn.groups ?? []).flatMap((g) => g.rows).find((r) => r.name === lineName)
  if (!row?.edit) throw new Error(`no editable row ${lineName}`)
  return { ...drawn.edit.params, [drawn.edit.rowParam]: row.id, [param]: value }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'Europe/Paris' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  other = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  dmThread = crypto.randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${dmThread}::uuid, ${orgId}::uuid, ${`reconcile-edit-${dmThread.slice(0, 8)}`},
            'agent_chat', ${owner.userId}::uuid)`)
  for (const u of [owner.userId, other.userId]) {
    await db.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${dmThread}::uuid, ${u}::uuid, ${orgId}::uuid, 'admin')`)
  }
  const made = await tool(
    "createProject",
    { name: "Maison Delorme platform", key: "ATLAS", timeBudgets: true },
    { origin: "human-ui" },
  )
  projectId = made.id
  // A second project keeps the org using time and budgets when this one is turned off.
  await tool(
    "createProject",
    { name: "Studio internal", key: "HOUSE", timeBudgets: true },
    { origin: "human-ui" },
  )
  await awaitTimeFeatureSync(orgId)
  await tool("time_plan_set", { projectId, basis: "daily" }, { origin: "human-ui" })
  await tool("billing_terms_set", { projectId, rate: 930, currency: "EUR" }, { origin: "human-ui" })
  const spec: Array<[string, string, number]> = [
    ["e1", "1.5 days", 2],
    ["e2", "1.5 days", 1.5],
    ["m1", "2 days", 2],
    ["m2", "2 days", 2],
  ]
  for (const [k, box, spent] of spec) {
    const task = await tool(
      "create",
      { projectId, title: `Task ${k}`, statusLabel: "done", timebox: box },
      { origin: "human-ui" },
    )
    t[k] = task.id
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET completed_at = '2026-10-20T10:00:00Z' WHERE id = ${task.id}::uuid`)
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId), [
      { taskId: task.id, projectId, workDate: "2026-10-12", minutes: day(spent) },
    ])
  }
}, 300_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("changing a line of the card", () => {
  it("a change by talk and by the inline field store identical lines", async () => {
    // Two people, the same October: one tells the agent, the other types in the card.
    const talk = await tool("reconcile_propose", proposal())
    const inline = await tool("reconcile_propose", proposal(), { userId: other.userId })
    expect(talk.error).toBeUndefined()
    expect(inline.error).toBeUndefined()
    expect(talk.totals.amountExclVat).toBe(6510)

    const exportLine = (c: Card) => (c.lines as Card[]).find((l) => l.name === "Data export")
    const talked = await tool("reconcile_line_update", {
      reconciliationId: talk.reconciliationId,
      revision: talk.revision,
      lineId: exportLine(talk)?.lineId,
      bill: "3.5 days",
    })
    const typed = await tool(
      "reconcile_line_update",
      inlineCall(inline, "Data export", "bill", 3.5),
      { userId: other.userId, origin: "human-ui" },
    )
    expect([talked.totals.bill, talked.totals.amountExclVat]).toEqual(["7.5 d", 6975])
    expect(sameLines(typed)).toEqual(sameLines(talked))

    const talked2 = await tool("reconcile_line_update", {
      reconciliationId: talk.reconciliationId,
      revision: talked.revision,
      lineId: exportLine(talked)?.lineId,
      bill: 4,
    })
    const typed2 = await tool(
      "reconcile_line_update",
      inlineCall(typed, "Data export", "bill", 4),
      { userId: other.userId, origin: "human-ui" },
    )
    expect([talked2.totals.bill, talked2.totals.amountExclVat]).toEqual(["8 d", 7440])
    expect(sameLines(typed2)).toEqual(sameLines(talked2))
    expect(talked2.message).toContain('"Data export" now bills 4 d')
  })

  it("each inline change is one update with the revision, a second card from talk leaves the first as First version", async () => {
    const first = await tool("reconcile_get", {
      reconciliationId: (await tool("reconcile_propose", proposal())).reconciliationId,
    })
    const before = first.revision as number
    const changed = await tool(
      "reconcile_line_update",
      inlineCall(first, "Monitoring", "realNote", 4.5),
      { origin: "human-ui" },
    )
    expect(changed.revision).toBe(before + 1)
    expect((changed.lines as Card[]).find((l) => l.name === "Monitoring")?.real).toBe("4.5 d")
    // The bill and the time entered on the tasks did not move.
    expect(changed.totals.bill).toBe(first.totals.bill)

    // A click from the card as it was before is refused with the latest card.
    const stale = (await executeToolCore({
      toolName: "projects:reconcile_line_update",
      orgId,
      actor: actorOf(owner.userId),
      params: inlineCall(first, "Monitoring", "bill", 5),
      origin: "human-ui",
    } as never)) as Card
    expect(stale.error?.code).toBe("card_changed")
    const reread = await tool("reconcile_get", { reconciliationId: first.reconciliationId })
    expect(reread.revision).toBe(before + 1)

    // A second card from talk: the same key, so the first reads as First version.
    const a = resolveToolCard(template, first)
    const b = resolveToolCard(template, changed)
    expect(a?.latestKey).toBe(b?.latestKey)
    const calls = markSupersededWithinTurn([
      { toolCallId: "c1", toolName: "projects__reconcile_get", card: a } as never,
      { toolCallId: "c2", toolName: "projects__reconcile_line_update", card: b } as never,
    ]) as Array<{ cardSuperseded?: boolean }>
    expect(calls.map((c) => c.cardSuperseded === true)).toEqual([true, false])
    expect(template.supersededLabel?.label).toBe("First version")
  })

  it("wording that names a member is refused on a line change too", async () => {
    const card = await tool("reconcile_get", {
      reconciliationId: (await tool("reconcile_propose", proposal())).reconciliationId,
    })
    const name = await memberName(owner.userId)
    const out = (await executeToolCore({
      toolName: "projects:reconcile_line_update",
      orgId,
      actor: actorOf(owner.userId),
      params: {
        reconciliationId: card.reconciliationId,
        revision: card.revision,
        lineId: (card.lines as Card[])[0]?.lineId,
        wording: `Export by ${name}`,
      },
      origin: "human-ui",
    } as never)) as Card
    expect(out.error?.code).toBe("names_a_person")
  })
})

async function memberName(userId: string): Promise<string> {
  const rows = (await db.execute(
    drizzleSql`SELECT name, email FROM kernel.users WHERE id = ${userId}::uuid`,
  )) as unknown as Array<{ name: string | null; email: string }>
  const row = [...rows][0]
  // A full name, or the address when the seeded name is one word.
  return row?.name && /\s/.test(row.name) ? row.name : (row?.email ?? "")
}

describe("what a coding agent's terminal reads", () => {
  it("the MCP result carries the card as text that never says it was approved or issued", async () => {
    const viaMcp = await tool("reconcile_propose", proposal(), { origin: "mcp" })
    const viaChat = await tool("reconcile_propose", proposal())
    expect(sameLines(viaMcp)).toEqual(sameLines(viaChat))
    expect(viaChat.text).toBeUndefined()
    const text = viaMcp.text as string
    expect(text.split("\n")[0]).toBe(viaMcp.title)
    for (const l of viaMcp.lines as Card[]) expect(text).toContain(`- ${l.name}:`)
    expect(text).toContain(`To bill: ${viaMcp.totals.bill}`)
    expect(text).toContain("creating and issuing the invoice is a click there, by you")
    expect(text).not.toMatch(/approved for you|issued for you|has been issued/i)
  })
})

describe("what the asker cannot read is named on the card", () => {
  it("each trace source the asker lacks is listed as not seen, and one they hold is not", async () => {
    const all = [
      "projects:*",
      "github:repo:read",
      "gitlab:repo:read",
      "calendar:events:read",
      "knowledge:documents:read",
    ]
    for (const missing of all.slice(1)) {
      const scopes = all.filter((s) => s !== missing)
      const card = await tool("reconcile_propose", proposal(), { userId: other.userId, scopes })
      expect(card.error).toBeUndefined()
      const sources = (card.notSeen as Card[]).map((n) => [n.source.toLowerCase(), n.why])
      expect(sources).toEqual([[missing.split(":")[0], NOT_YOURS_TO_READ]])
    }
  })

  it("a role agent without repository scope leaves the repository in not seen", async () => {
    // The asker holds GitHub; the agent they talk to in a DM does not.
    const asker = [
      "projects:*",
      "github:repo:read",
      "calendar:events:read",
      "knowledge:documents:read",
      "gitlab:repo:read",
    ]
    const ceiling = [
      "projects:*",
      "calendar:events:read",
      "knowledge:documents:read",
      "gitlab:repo:read",
    ]
    const card = await tool("reconcile_propose", proposal(), {
      userId: other.userId,
      scopes: effectiveScopeDm(ceiling, asker),
    })
    expect((card.notSeen as Card[]).map((n) => n.source)).toEqual(["GitHub"])
    const drawn = resolveToolCard(template, card)
    expect(drawn?.notice?.title).toBe("GitHub was not seen")
    expect(drawn?.actions?.map((a) => a.label.label)).toEqual(["Connect GitHub"])
  })
})

describe("reading a card again", () => {
  it("a stored card reads back as drawn; off, a proposal is refused and an invoiced card shows billed lines only", async () => {
    const card = await tool("reconcile_propose", proposal())
    const again = await tool("reconcile_get", { reconciliationId: card.reconciliationId })
    expect(sameLines(again)).toEqual(sameLines(card))
    expect(again.state).toBe("proposed")

    await tool("update_project", { projectId, timeBudgets: false }, { origin: "human-ui" })
    try {
      const refused = await tool("reconcile_get", { reconciliationId: card.reconciliationId })
      expect(refused.error?.code).toBe("planning_off")
      const noEdit = await tool("reconcile_line_update", {
        reconciliationId: card.reconciliationId,
        revision: card.revision,
        lineId: (card.lines as Card[])[0]?.lineId,
        bill: 9,
      })
      expect(noEdit.error?.code).toBe("planning_off")

      await db.execute(drizzleSql`
        UPDATE app_projects.reconciliations SET state = 'invoiced'
         WHERE id = ${card.reconciliationId}::uuid`)
      const billed = await tool("reconcile_get", { reconciliationId: card.reconciliationId })
      expect(billed.billedOnly).toBe(true)
      expect(billed.lines).toEqual([
        { name: "Data export", bill: "3 d" },
        { name: "Monitoring", bill: "4 d" },
      ])
      for (const l of billed.lines as Card[])
        expect(Object.keys(l).sort()).toEqual(["bill", "name"])
    } finally {
      await tool("update_project", { projectId, timeBudgets: true }, { origin: "human-ui" })
      await awaitTimeFeatureSync(orgId)
    }
  })
})
