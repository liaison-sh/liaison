// SPDX-License-Identifier: FSL-1.1-ALv2
//
// billing-steps-sweep (hourly): a milestone whose task is done but which has no invoice yet raises
// one Home line to the people who issue invoices, "<task> is done and has no invoice yet", once per
// step, so a lost status event or a routine turned off never loses an invoice. It drafts nothing:
// a person drafts it (milestone_draft_create). It reads each step's task through projects' own
// milestone read (done or not, no assignee, time or activity), and settles the stored state of the
// steps and advance deductions whose documents were issued since.

import type { CrossAppExecuteTool } from "./cross-app"
import { stepState } from "./mutations/billing-plan"

type Row = Record<string, unknown>

export interface BillingStepsSweepCtx {
  db: {
    findMany(table: string, q: { where?: Row; limit?: number }): Promise<unknown>
    update(table: string, id: string, data: Row): Promise<unknown>
  }
  executeTool: CrossAppExecuteTool
  emit(e: { entity: string; action: string; entityId: string; data: Row }): Promise<unknown>
  time: { civil(o: { timezone: string }): Promise<{ date: string }> }
}

export interface BillingStepsSweepResult {
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
  let resolved = 0
  let settled = 0

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
      // The step has its invoice now: the Home line goes.
      await ctx.emit({
        entity: "billing_step",
        action: "milestone_no_invoice",
        entityId: String(s.id),
        data: { step_id: String(s.id), resolved: true },
      })
      await ctx.db.update("billing_steps", String(s.id), { no_invoice_noticed_on: null })
      resolved += 1
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

  // A done milestone with no document: one line, once per step.
  const open = steps.filter(
    (s) =>
      typeof s.task_id === "string" &&
      typeof s.document_id !== "string" &&
      s.state === "planned" &&
      !s.no_invoice_noticed_on,
  )
  const byProject = new Map<string, Row[]>()
  for (const s of open) {
    const p = String(s.billing_project_id)
    byProject.set(p, [...(byProject.get(p) ?? []), s])
  }
  for (const [projectId, list] of byProject) {
    let read: {
      tasks?: Array<{ id: string; title: string; terminal: boolean; isMilestone: boolean }>
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
    for (const s of list) {
      const task = (read.tasks ?? []).find((t) => t.id === s.task_id)
      if (!task || !task.terminal || !task.isMilestone) continue
      await ctx.emit({
        entity: "billing_step",
        action: "milestone_no_invoice",
        entityId: String(s.id),
        data: {
          step_id: String(s.id),
          project_id: projectId,
          task_id: String(s.task_id),
          task_title: task.title,
          step_label: String(s.label),
          resolved: false,
        },
      })
      await ctx.db.update("billing_steps", String(s.id), { no_invoice_noticed_on: today })
      raised += 1
    }
  }
  return { raised, resolved, settled }
}

/** Manifest `jobs.billing-steps-sweep` handler: the kernel calls job handlers as `(payload, ctx)`. */
export async function billingStepsSweepJobHandler(
  _payload: unknown,
  ctx: BillingStepsSweepCtx,
): Promise<BillingStepsSweepResult> {
  return billingStepsSweep(ctx)
}
