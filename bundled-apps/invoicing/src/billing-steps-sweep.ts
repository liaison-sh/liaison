// SPDX-License-Identifier: FSL-1.1-ALv2
//
// billing-steps-sweep (hourly): a milestone whose task is done but which has no invoice yet is
// drafted, as the status event would have drafted it (milestone-done.ts), so a lost event never
// loses an invoice; the draft parks for a person's issue approval and nothing is issued. A step
// it cannot draft (its plan needs a person) raises one Home line per project to the people who
// bill the project, naming it. A draft of the project whose issue approval is pending holds the
// line (that approval is the project's one money item). It reads each step's task through
// projects' own milestone read (done or not, no assignee, time or activity), and settles the
// stored state of the steps and advance deductions whose documents were issued since.

import type { CrossAppExecuteTool } from "./cross-app"
import { milestoneDraftCreate, stepState } from "./mutations/billing-plan"

type Row = Record<string, unknown>

export interface BillingStepsSweepCtx {
  db: {
    findMany(table: string, q: { where?: Row; limit?: number }): Promise<unknown>
    update(table: string, id: string, data: Row): Promise<unknown>
  }
  executeTool: CrossAppExecuteTool
  /** The app's own pending approvals: a draft holds the line only while its request is pending. */
  approvals?: { pendingFor(key: string, tools?: string[]): Promise<unknown> }
  emit(e: { entity: string; action: string; entityId: string; data: Row }): Promise<unknown>
  time: { civil(o: { timezone: string }): Promise<{ date: string }> }
}

export interface BillingStepsSweepResult {
  /** Done steps drafted by this pass. */
  drafted: number
  raised: number
  resolved: number
  settled: number
}

const ISSUED = new Set(["issued", "paid", "overdue", "refunded"])

export async function billingStepsSweep(
  ctx: BillingStepsSweepCtx,
): Promise<BillingStepsSweepResult> {
  const today = (await ctx.time.civil({ timezone: "UTC" })).date
  const steps = (await ctx.db.findMany("billing_steps", { limit: 2000 })) as Row[]
  let raised = 0
  let drafted = 0
  let resolved = 0
  let settled = 0
  // The projects whose line is up: a step noticed and not yet taken down.
  const lineUp = new Set(
    steps.filter((s) => s.no_invoice_noticed_on).map((s) => String(s.billing_project_id)),
  )

  // Settle the stored state of steps whose document moved on (issued, paid).
  for (const s of steps) {
    if (typeof s.document_id !== "string") continue
    const doc =
      (
        (await ctx.db.findMany("documents", { where: { id: s.document_id }, limit: 1 })) as Row[]
      )[0] ?? null
    const state = stepState(s, doc)
    if (state !== s.state && state !== "planned") {
      await ctx.db.update("billing_steps", String(s.id), { state })
      settled += 1
    }
    if (s.no_invoice_noticed_on) {
      // The step has its document now: it is off the project's line.
      await ctx.db.update("billing_steps", String(s.id), { no_invoice_noticed_on: null })
      s.no_invoice_noticed_on = null
    }
    if (doc && ISSUED.has(String(doc.status))) {
      const deductions = (await ctx.db.findMany("advance_deductions", {
        where: { final_document_id: String(doc.id), state: "reserved" },
        limit: 50,
      })) as Row[]
      for (const d of deductions) {
        await ctx.db.update("advance_deductions", String(d.id), { state: "issued" })
        settled += 1
      }
    }
  }

  // Done milestones with no document: one line per project (the Home bar: one money item per
  // project and month), held while a draft of the project waits, since its issue approval is the
  // project's item then.
  const byProject = new Map<string, Row[]>()
  for (const s of steps) {
    if (typeof s.task_id !== "string" || typeof s.document_id === "string") continue
    if (s.state !== "planned") continue
    const p = String(s.billing_project_id)
    byProject.set(p, [...(byProject.get(p) ?? []), s])
  }
  const takeDown = async (projectId: string, list: Row[]) => {
    await ctx.emit({
      entity: "billing_step",
      action: "milestone_no_invoice",
      entityId: projectId,
      data: { project_id: projectId, resolved: true },
    })
    for (const s of list.filter((x) => x.no_invoice_noticed_on)) {
      await ctx.db.update("billing_steps", String(s.id), { no_invoice_noticed_on: null })
    }
    resolved += 1
  }
  let pending: Set<string> | null = null
  for (const projectId of new Set([...byProject.keys(), ...lineUp])) {
    const list = byProject.get(projectId) ?? []
    // A draft of the project whose issue approval is pending is the project's item. One whose
    // request was turned down or ran out is on no list, so it holds nothing; a step with its own
    // draft is already off the line.
    const drafts = (await ctx.db.findMany("documents", {
      where: { billing_project_id: projectId, status: "draft" },
      limit: 50,
    })) as Row[]
    if (drafts.length > 0) pending ??= await pendingIssueDrafts(ctx)
    const waiting = drafts.some((d) => pending?.has(String(d.id)))
    if (waiting || list.length === 0) {
      if (lineUp.has(projectId)) await takeDown(projectId, list)
      continue
    }
    let read: {
      tasks?: Array<{ id: string; terminal: boolean; isMilestone: boolean }>
    }
    try {
      const env = await ctx.executeTool("projects:milestone_status_read", {
        projectId,
        taskIds: list.map((s) => String(s.task_id)),
      })
      if (env?.status !== "completed") continue
      read = (env.result ?? {}) as typeof read
    } catch {
      continue
    }
    const doneTasks = list.filter((s) => {
      const task = (read.tasks ?? []).find((t) => t.id === s.task_id)
      return Boolean(task?.terminal && task.isMilestone)
    })
    // Each done step is drafted; only the ones that cannot be stay on the project's line.
    const doneSteps: Row[] = []
    for (const s of doneTasks) {
      const out = (await milestoneDraftCreate(ctx as never, { taskId: String(s.task_id) })) as {
        status?: string
        error?: { code?: string }
      }
      if (out?.status === "completed") drafted += 1
      else if (out?.error?.code !== "already_drafted") doneSteps.push(s)
    }
    if (doneSteps.length < doneTasks.length) {
      // A draft now waits with its issue approval: that is the project's item.
      if (lineUp.has(projectId)) await takeDown(projectId, list)
      continue
    }
    if (doneSteps.length === 0) {
      if (lineUp.has(projectId)) await takeDown(projectId, list)
      continue
    }
    // Raised once: again only when a step joins the line.
    if (doneSteps.every((s) => s.no_invoice_noticed_on)) continue
    await ctx.emit({
      entity: "billing_step",
      action: "milestone_no_invoice",
      entityId: projectId,
      data: {
        project_id: projectId,
        step_ids: doneSteps.map((s) => String(s.id)),
        step_label: doneSteps.map((s) => String(s.label)).join(", "),
        resolved: false,
      },
    })
    for (const s of doneSteps.filter((x) => !x.no_invoice_noticed_on)) {
      await ctx.db.update("billing_steps", String(s.id), { no_invoice_noticed_on: today })
    }
    raised += 1
  }
  return { drafted, raised, resolved, settled }
}

/** The drafts whose issue approval is pending. */
async function pendingIssueDrafts(ctx: BillingStepsSweepCtx): Promise<Set<string>> {
  if (!ctx.approvals?.pendingFor) return new Set()
  let raw: unknown = await ctx.approvals.pendingFor("draft_id", ["invoicing:invoice_issue"])
  if (typeof raw === "string") raw = JSON.parse(raw)
  const rows = (Array.isArray(raw) ? raw : []) as Array<{ target_id?: unknown }>
  return new Set(rows.map((r) => r.target_id).filter((id): id is string => typeof id === "string"))
}

/** Manifest `jobs.billing-steps-sweep` handler: the kernel calls job handlers as `(payload, ctx)`. */
export async function billingStepsSweepJobHandler(
  _payload: unknown,
  ctx: BillingStepsSweepCtx,
): Promise<BillingStepsSweepResult> {
  return billingStepsSweep(ctx)
}
