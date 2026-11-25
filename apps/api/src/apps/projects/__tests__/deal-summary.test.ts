// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card of a deal change says which deal, the client and the amount the change sets: the person
// deciding must know which deal they are closing. Its records are named to who may read them. The
// deal's stored amount is not on it (it has a scope of its own), nor a client shared by name.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ApprovalSummary, truncateApprovalSummary } from "@liaison/shared"
import {
  type DealWorld,
  makeDealWorld,
  makePipeline,
  makeTask,
} from "~/apps/projects/service/__tests__/deal-world"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { entityRegistry } from "~/modules/apps/app-registries"
import { asStoredSummary, withViewerNames } from "~/modules/apps/approval-record-names"
import { insertSql } from "~/seed/factories/org/test-rows"
import { createTestCompany } from "~/tests/helpers/company"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { summarizeDealsUpdate } from "../summarizers"

let w: DealWorld
let deal = ""
let key = ""

const stored = async (params: Record<string, unknown>) => {
  const made = await withRlsContext(w.actor, (tx) =>
    summarizeDealsUpdate(params, { tx, orgId: w.orgId, userId: w.userId }),
  )
  return asStoredSummary(made, truncateApprovalSummary)
}

/** The card as a person holding `scopes` reads it. */
const card = async (
  params: Record<string, unknown>,
  scopes = ["projects:projects:read", "kernel:companies:read", "kernel:contacts:read"],
) => {
  const summary = await stored(params)
  const [row] = await withRlsContext({ ...w.actor, scopes }, (tx) =>
    withViewerNames(tx, w.orgId, [{ summary }]),
  )
  return row?.summary as ApprovalSummary
}

describe("the card of a deal change", () => {
  beforeAll(async () => {
    await acquireTestLock()
    w = await makeDealWorld("deal-card")
    for (const [kind, labelField, tableName] of [
      ["task", "title", "tasks"],
      ["project", "name", "projects"],
    ] as const) {
      entityRegistry.set([w.orgId, "projects", kind], {
        labelField,
        handlePrefix: "x",
        tableName,
        readScope: "projects:projects:read",
      } as never)
    }
    const pipeline = await makePipeline(w, "Sales 2027")
    deal = await makeTask(w, pipeline.projectId, "Supplier portal")
    const client = await createTestCompany(w.orgId, "Northwind Cooperative")
    await sql`UPDATE app_projects.deals SET company_id = ${client} WHERE task_id = ${deal}`
    await sql`DELETE FROM app_projects.deal_values WHERE task_id = ${deal}`
    await sql.unsafe(
      insertSql("app_projects.deal_values", {
        task_id: deal,
        org_id: w.orgId,
        amount_minor: 987654300,
        currency: "EUR",
      }),
    )
    const [row] = await sql<{ key: string }[]>`
      SELECT p.key || '-' || t.number AS key FROM app_projects.tasks t
        JOIN app_projects.projects p ON p.id = t.project_id WHERE t.id = ${deal}`
    key = row?.key ?? ""
  }, 120_000)

  afterAll(async () => {
    entityRegistry.deleteByPrefix([w.orgId])
    await releaseTestLock()
  })

  it("names the deal, its client and its pipeline, and links to it", async () => {
    const c = await card({ taskId: deal, outcome: "won" })
    expect(c.title).toBe("Mark the deal won: Supplier portal")
    expect(c.subtitle).toBe("Northwind Cooperative, Sales 2027")
    expect(c.ref).toBe(key)
    expect(c.lines).toEqual(["Outcome: won"])
    expect(c.links).toEqual([
      { label: "Open deal", app: "projects", entityType: "task", entityId: deal },
    ])
    expect(JSON.stringify({ ...c, links: [] })).not.toContain(deal)
  })

  it("holds no name, and a decider who may not read the deal reads none", async () => {
    const kept = await stored({ taskId: deal, outcome: "won" })
    expect(kept.title).toBe("Mark the deal won")
    expect(kept.subtitle).toBe("Pending approval")
    for (const c of [kept, await card({ taskId: deal, outcome: "won" }, ["projects:approve"])]) {
      expect(JSON.stringify(c)).not.toContain("Supplier portal")
      expect(JSON.stringify(c)).not.toContain("Northwind")
      expect(JSON.stringify(c)).not.toContain("Sales 2027")
    }
  })

  it("reads a deal named by its key the same", async () => {
    expect((await card({ taskId: key, outcome: "open" })).title).toBe(
      "Reopen the deal: Supplier portal",
    )
  })

  it("says each change in words, an amount with its currency and period", async () => {
    const contactless = await createTestCompany(w.orgId, "Second Client")
    const c = await card({
      taskId: deal,
      companyId: contactless,
      amountMinor: 1_250_050,
      currency: "EUR",
      amountPeriod: "month",
      probability: 60,
      nextStep: "Send the proposal",
    })
    expect(c.title).toBe("Change the deal: Supplier portal")
    expect(c.lines).toEqual([
      "Client: Second Client",
      "Amount: 12500.50 EUR per month",
      "Probability: 60%",
      "Next step: Send the proposal",
    ])
    const cleared = await card({ taskId: deal, amountMinor: null, nextStep: null })
    expect(cleared.lines).toEqual(["Amount: cleared", "Next step: cleared"])
    const lost = await card({ taskId: deal, outcome: "lost", reason: "Price" })
    expect(lost.title).toBe("Mark the deal lost: Supplier portal")
    expect(lost.lines).toEqual(["Outcome: lost", "Reason: Price"])
    const yen = await card({ taskId: deal, amountMinor: 5000, currency: "JPY" })
    expect(yen.lines).toEqual(["Amount: 5000 JPY"])
  })

  it("keeps the stored amount and a client shared by name off the card", async () => {
    expect(JSON.stringify(await card({ taskId: deal, outcome: "won" }))).not.toContain("9876543")
    const quiet = await createTestCompany(w.orgId, "Quiet Holdings")
    await sql`UPDATE kernel.companies SET org_access = 'none', created_by = ${w.userId}
               WHERE id = ${quiet}`
    const set = await card({ taskId: deal, companyId: quiet })
    expect(set.lines).toEqual(["Client: a company"])
    const person = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.contacts", {
        id: person,
        org_id: w.orgId,
        name: "Quiet Person",
        email: "quiet@example.com",
        handle: `c-${person.slice(0, 8)}`,
        org_access: "none",
        created_by: w.userId,
        owner_user_id: w.userId,
      }),
    )
    expect((await card({ taskId: deal, contactId: person })).lines).toEqual(["Contact: a contact"])
    await sql`UPDATE app_projects.deals SET company_id = ${quiet} WHERE task_id = ${deal}`
    const c = await card({ taskId: deal, outcome: "won" })
    expect(c.subtitle).toBe("a company, Sales 2027")
  })

  it("says so when the deal cannot be seen, with no raw id", async () => {
    const c = await card({ taskId: crypto.randomUUID(), outcome: "won" })
    expect(c.title).toBe("Mark a deal won")
    expect(c.subtitle).toBe("The deal is not visible to the person who asked")
    expect(c.lines).toEqual(["Outcome: won"])
  })

  it("is the card the manifest names", () => {
    const m = JSON.parse(readFileSync(join(import.meta.dir, "../app.manifest.json"), "utf8")) as {
      tools: Record<string, { summarizer?: string }>
    }
    expect(m.tools.deals_update?.summarizer).toBe("summarizeDealsUpdate")
  })
})
