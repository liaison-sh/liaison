// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing's subscriber on `projects/task:status_changed`: a milestone task moved to a done
// status drafts its billing step's invoice (milestone_draft_create's own rules: the task is done
// and a milestone, the amount comes from the step). The draft parks for a person's issue approval;
// nothing is issued and nothing is sent. A move to a status that is not done, a task that bills no
// step, or a step that already has its document does nothing, so a replay finds the draft. The
// hourly billing-steps sweep drafts a step whose event was lost.

import { milestoneDraftCreate } from "./mutations/billing-plan"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StatusChangedEvent {
  data?: { id?: string | null; terminal?: boolean | null }
}

type Ctx = Parameters<typeof milestoneDraftCreate>[0]

export async function onMilestoneTaskDone(ctx: Ctx, event: StatusChangedEvent) {
  const d = event?.data
  const taskId = typeof d?.id === "string" ? d.id : ""
  if (d?.terminal !== true || !UUID.test(taskId)) return { status: "ignored" as const }
  const steps = (await ctx.db.findMany("billing_steps", {
    where: { task_id: taskId },
    limit: 1,
  })) as Array<{ id: string; document_id?: string | null; state?: string }>
  const step = steps[0]
  if (!step || typeof step.document_id === "string" || step.state !== "planned")
    return { status: "ignored" as const }
  const out = (await milestoneDraftCreate(ctx, { taskId })) as {
    status?: string
    draftId?: string
    error?: { code?: string }
  }
  return out?.status === "completed"
    ? { status: "drafted" as const, draftId: out.draftId }
    : { status: "not_drafted" as const, code: out?.error?.code ?? null }
}
