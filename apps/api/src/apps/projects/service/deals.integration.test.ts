// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deals in Projects: the outcome a deal takes from its stage, the deal rows a
// pipeline task gets, and what moves, merges, deletes and stage edits do to
// them. Real database, real liaison_rls role.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  armAfterDealOutcomeFailpoint,
  listDeals,
  setDealOutcome,
} from "~/apps/projects/service/deals"
import { moveTask } from "~/apps/projects/service/move-task"
import { deleteStatus, updateStatus } from "~/apps/projects/service/statuses"
import { deriveProjectKey } from "~/apps/projects/service/task-key"
import { deleteTask, mergeTasks, restoreTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type DealWorld,
  dealEvents,
  dealState,
  makeDealWorld,
  makePipeline,
  makeTask,
  makeWorkProject,
  taskStatus,
} from "./__tests__/deal-world"

let w: DealWorld

beforeAll(async () => {
  await acquireTestLock()
  w = await makeDealWorld("deals")
})

afterAll(releaseTestLock)

const run = <T>(fn: (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => Promise<T>) =>
  withRlsContext(w.actor, fn)

const move = (taskId: string, statusId: string, lostReason?: string) =>
  run((tx) => moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, statusId, lostReason }))

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p
  } catch (err) {
    return err as { code?: string; message?: string }
  }
  throw new Error("expected a refusal")
}

async function setCompanyAndAmount(taskId: string, companyId: string | null, amount?: number) {
  await db.execute(drizzleSql`
    UPDATE app_projects.deals SET company_id = ${companyId}::uuid WHERE task_id = ${taskId}::uuid`)
  if (amount !== undefined) {
    await db.execute(drizzleSql`
      UPDATE app_projects.deal_values SET amount_minor = ${amount}, currency = 'EUR'
      WHERE task_id = ${taskId}::uuid`)
  }
}

describe("closing and reopening", () => {
  it("a move to a closing stage sets outcome, closed at and closed by with the move, and a failure leaves all unchanged", async () => {
    const p = await makePipeline(w, "Close by move")
    const taskId = await makeTask(w, p.projectId, "Verrerie Nord", { statusId: p.stage.Demo })

    const disarm = armAfterDealOutcomeFailpoint(() => {
      throw new Error("fault after the outcome write")
    })
    try {
      const err = await errorOf(move(taskId, p.stage.Won!))
      expect(err.message).toBe("fault after the outcome write")
    } finally {
      disarm()
    }
    expect(await taskStatus(taskId)).toBe(p.stage.Demo!)
    expect(await dealState(taskId)).toMatchObject({
      outcome: "open",
      closed_at: null,
      closed_by: null,
    })
    expect(await dealEvents(w, taskId)).toEqual([])

    await move(taskId, p.stage.Won!)
    const state = await dealState(taskId)
    expect(state).toMatchObject({ outcome: "won", closed_by: w.userId, status_id: p.stage.Won })
    expect(state?.closed_at).not.toBeNull()
    expect(await dealEvents(w, taskId)).toEqual(["closed:won"])
  })

  it("moving back to an open stage clears the outcome and the reason and emits reopened", async () => {
    const p = await makePipeline(w, "Reopen by move")
    const taskId = await makeTask(w, p.projectId, "Basalt", { statusId: p.stage.Proposal })
    await move(taskId, p.stage.Lost!, "Went with a cheaper offer")
    expect(await dealState(taskId)).toMatchObject({
      outcome: "lost",
      lost_reason: "Went with a cheaper offer",
    })
    await move(taskId, p.stage.Qualified!)
    expect(await dealState(taskId)).toMatchObject({
      outcome: "open",
      closed_at: null,
      closed_by: null,
      lost_reason: null,
    })
    expect(await dealEvents(w, taskId)).toEqual(["closed:lost", "reopened"])
  })

  it("a second mark won is a no-op with no second event", async () => {
    const p = await makePipeline(w, "Double click")
    const taskId = await makeTask(w, p.projectId, "Lumen", { statusId: p.stage.Proposal })
    const first = await run((tx) =>
      setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "won" }),
    )
    const closedAt = (await dealState(taskId))?.closed_at
    const second = await run((tx) =>
      setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "won" }),
    )
    expect(first).toMatchObject({ outcome: "won", statusId: p.stage.Won, changed: true })
    expect(second).toMatchObject({ outcome: "won", statusId: p.stage.Won, changed: false })
    expect((await dealState(taskId))?.closed_at).toBe(closedAt!)
    expect(await dealEvents(w, taskId)).toEqual(["closed:won"])

    // Reopening goes back to the stage the deal was closed from.
    const reopened = await run((tx) =>
      setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "open" }),
    )
    expect(reopened).toMatchObject({ outcome: "open", statusId: p.stage.Proposal })
  })

  it("won then lost emits closed, reopened and closed", async () => {
    const p = await makePipeline(w, "Won then lost")
    const taskId = await makeTask(w, p.projectId, "Quartz", { statusId: p.stage.Demo })
    await move(taskId, p.stage.Won!)
    await move(taskId, p.stage.Lost!)
    expect((await dealState(taskId))?.outcome).toBe("lost")
    expect(await dealEvents(w, taskId)).toEqual(["closed:won", "reopened", "closed:lost"])
  })
})

describe("deal rows", () => {
  it("a root task created in a pipeline gets both deal rows and a subtask gets none", async () => {
    const p = await makePipeline(w, "Rows on create")
    const deal = await makeTask(w, p.projectId, "Root deal")
    const sub = await makeTask(w, p.projectId, "Send the quote", { parentTaskId: deal })
    const work = await makeWorkProject(w, "Plain work")
    const chore = await makeTask(w, work.projectId, "A chore")
    expect(await dealState(deal)).toMatchObject({
      outcome: "open",
      has_value: true,
      amount_minor: null,
      status_id: p.stage.Lead,
    })
    expect(await dealState(sub)).toBeNull()
    expect(await dealState(chore)).toBeNull()
  })

  it("a task moved into a pipeline gets empty deal rows", async () => {
    const work = await makeWorkProject(w, "Leads inbox")
    const p = await makePipeline(w, "Into a pipeline")
    const taskId = await makeTask(w, work.projectId, "Lead from a fair")
    await run((tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, targetProjectId: p.projectId }),
    )
    expect(await dealState(taskId)).toMatchObject({
      outcome: "open",
      has_value: true,
      amount_minor: null,
      status_id: p.stage.Lead,
    })
  })

  it("a subtask moved to the root of a pipeline gets deal rows", async () => {
    const p = await makePipeline(w, "Promote a subtask")
    const parent = await makeTask(w, p.projectId, "Parent deal")
    const sub = await makeTask(w, p.projectId, "Second site", { parentTaskId: parent })
    expect(await dealState(sub)).toBeNull()
    await run((tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId: sub, parentTaskId: null }),
    )
    expect(await dealState(sub)).toMatchObject({ outcome: "open", has_value: true })
  })

  it("a deal cannot move into a work project", async () => {
    const p = await makePipeline(w, "Stays a deal")
    const work = await makeWorkProject(w, "Work board")
    const taskId = await makeTask(w, p.projectId, "Deal to keep", { statusId: p.stage.Demo })
    const err = await errorOf(
      run((tx) =>
        moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, targetProjectId: work.projectId }),
      ),
    )
    expect(err).toMatchObject({ code: "deal_needs_pipeline", status: 409 })
    expect(await taskStatus(taskId)).toBe(p.stage.Demo!)
    expect(await dealState(taskId)).toMatchObject({ outcome: "open" })
  })

  it("into another pipeline it keeps its rows", async () => {
    const from = await makePipeline(w, "From pipeline")
    const to = await makePipeline(w, "To pipeline")
    const won = await makeTask(w, from.projectId, "Won deal", { statusId: from.stage.Demo })
    const open = await makeTask(w, from.projectId, "Open deal", { statusId: from.stage.Proposal })
    const company = crypto.randomUUID()
    await setCompanyAndAmount(won, company, 480_000)
    await move(won, from.stage.Won!)
    for (const taskId of [won, open]) {
      await run((tx) =>
        moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, targetProjectId: to.projectId }),
      )
    }
    expect(await dealState(won)).toMatchObject({
      outcome: "won",
      company_id: company,
      amount_minor: "480000",
      currency: "EUR",
      status_id: to.stage.Won,
    })
    expect(await dealState(open)).toMatchObject({ outcome: "open", status_id: to.stage.Lead })
    expect(await dealEvents(w, won)).toEqual(["closed:won"])
  })

  it("merging two deals keeps the survivor's rows, removes the source's, and refuses two companies", async () => {
    const p = await makePipeline(w, "Merge deals")
    const target = await makeTask(w, p.projectId, "Survivor")
    const source = await makeTask(w, p.projectId, "Duplicate")
    const rival = await makeTask(w, p.projectId, "Other company")
    const company = crypto.randomUUID()
    await setCompanyAndAmount(target, company, 900_000)
    await setCompanyAndAmount(source, company, 100)
    await setCompanyAndAmount(rival, crypto.randomUUID(), 5)

    const err = await errorOf(
      run((tx) =>
        mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: rival, targetId: target }),
      ),
    )
    expect(err).toMatchObject({ code: "deals_different_company", status: 409 })
    expect(await dealState(rival)).toMatchObject({ amount_minor: "5" })

    await run((tx) =>
      mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: source, targetId: target }),
    )
    expect(await dealState(source)).toBeNull()
    const survivors = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::int AS n FROM app_projects.deal_values WHERE task_id = ${source}::uuid`),
    )
    expect(survivors[0]?.n).toBe(0)
    expect(await dealState(target)).toMatchObject({
      company_id: company,
      amount_minor: "900000",
      outcome: "open",
    })
  })

  it("a deleted deal leaves the deal reads, and a restore brings back its amount, company and outcome", async () => {
    const p = await makePipeline(w, "Bin and back")
    const taskId = await makeTask(w, p.projectId, "Binned deal", { statusId: p.stage.Proposal })
    const company = crypto.randomUUID()
    await setCompanyAndAmount(taskId, company, 1_740_000)
    await move(taskId, p.stage.Lost!, "Budget frozen")

    const read = () =>
      run((tx) => listDeals(tx, w.orgId, { projectId: p.projectId })).then((rows) =>
        rows.filter((r) => r.taskId === taskId),
      )
    const byCompany = () =>
      run((tx) => listDeals(tx, w.orgId, { companyId: company })).then((rows) => rows.length)
    expect(await read()).toHaveLength(1)

    await run((tx) => deleteTask({ tx, orgId: w.orgId, actor: w.actor, taskId }))
    expect(await read()).toEqual([])
    expect(await byCompany()).toBe(0)
    expect(await run((tx) => listDeals(tx, w.orgId, { taskId }))).toEqual([])

    await run((tx) => restoreTask({ tx, orgId: w.orgId, actor: w.actor, taskId }))
    const [back] = await read()
    expect(back).toMatchObject({
      taskId,
      companyId: company,
      outcome: "lost",
      lostReason: "Budget frozen",
      statusId: p.stage.Lost,
      value: { amountMinor: 1_740_000, currency: "EUR" },
    })
    expect(back?.closedAt).not.toBeNull()
    expect(await byCompany()).toBe(1)
  })
})

describe("pipelines and their stages", () => {
  it("a new pipeline has six stages with one won and one lost", async () => {
    const p = await makePipeline(w, "Northwind sales")
    const rows = extractRows<{
      label: string
      terminal: boolean
      deal_outcome: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT label, terminal, deal_outcome FROM app_projects.project_statuses
        WHERE project_id = ${p.projectId}::uuid ORDER BY "order"`),
    )
    expect(rows).toEqual([
      { label: "Lead", terminal: false, deal_outcome: null },
      { label: "Qualified", terminal: false, deal_outcome: null },
      { label: "Demo", terminal: false, deal_outcome: null },
      { label: "Proposal", terminal: false, deal_outcome: null },
      { label: "Won", terminal: true, deal_outcome: "won" },
      { label: "Lost", terminal: true, deal_outcome: "lost" },
    ])
    const [project] = extractRows<{ kind: string; key: string }>(
      await db.execute(drizzleSql`
        SELECT kind, key FROM app_projects.projects WHERE id = ${p.projectId}::uuid`),
    )
    expect(project).toEqual({ kind: "pipeline", key: deriveProjectKey("Northwind sales") })
  })

  it("the last won stage cannot be deleted", async () => {
    const p = await makePipeline(w, "Keep closing stages")
    const del = (statusId: string) =>
      run((tx) =>
        deleteStatus({ tx, orgId: w.orgId, actor: w.actor, projectId: p.projectId, statusId }),
      )
    const won = await errorOf(del(p.stage.Won!))
    expect(won).toMatchObject({ code: "last_closing_stage", status: 409 })
    const lost = await errorOf(del(p.stage.Lost!))
    expect(lost).toMatchObject({ code: "last_closing_stage" })
    // Nor can it stop closing deals by losing its terminal flag.
    const flip = await errorOf(
      run((tx) =>
        updateStatus({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          projectId: p.projectId,
          statusId: p.stage.Won!,
          patch: { terminal: false },
        }),
      ),
    )
    expect(flip).toMatchObject({ code: "last_closing_stage" })
    // An open stage still deletes as before.
    await del(p.stage.Demo!)
  })

  it("a stage that stops being terminal stops closing deals and its deals reopen", async () => {
    const p = await makePipeline(w, "Second won stage")
    // A second won stage, so the first may stop closing.
    await db.execute(
      drizzleSql.raw(
        insertSql("app_projects.project_statuses", {
          org_id: w.orgId,
          project_id: p.projectId,
          label: "Won (renewal)",
          // A reserved word, quoted as a column name.
          '"order"': 9,
          terminal: true,
          deal_outcome: "won",
        }),
      ),
    )
    const taskId = await makeTask(w, p.projectId, "Renewal", { statusId: p.stage.Demo })
    await move(taskId, p.stage.Won!)
    await run((tx) =>
      updateStatus({
        tx,
        orgId: w.orgId,
        actor: w.actor,
        projectId: p.projectId,
        statusId: p.stage.Won!,
        patch: { terminal: false },
      }),
    )
    const [stage] = extractRows<{ deal_outcome: string | null }>(
      await db.execute(drizzleSql`
        SELECT deal_outcome FROM app_projects.project_statuses WHERE id = ${p.stage.Won!}::uuid`),
    )
    expect(stage?.deal_outcome).toBeNull()
    expect((await dealState(taskId))?.outcome).toBe("open")
    expect(await dealEvents(w, taskId)).toEqual(["closed:won", "reopened"])
  })
})
