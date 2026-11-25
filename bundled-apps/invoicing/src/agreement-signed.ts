// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing's subscriber on `agreements/agreement:signed`: when the project the
// signed agreement belongs to has a billing plan with an advance step still
// planned, its advance is drafted. A draft parks for a person; nothing is issued
// and nothing is sent. A change request's approval, an agreement without a
// project, or a plan without a planned advance step does nothing, and a replay
// finds the step already drafted.

import { advanceDraftCreate } from "./mutations/advances"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SignedEvent {
  data?: { kind?: string | null; project_id?: string | null; number?: string }
}

type Ctx = Parameters<typeof advanceDraftCreate>[0]

export async function onAgreementSignedAdvance(ctx: Ctx, event: SignedEvent) {
  const d = event?.data
  if (!d || d.kind === "change_request") return { status: "ignored" }
  const projectId = typeof d.project_id === "string" ? d.project_id : ""
  if (!UUID.test(projectId)) return { status: "ignored" }
  const steps = (await ctx.db.findMany("billing_steps", {
    where: { billing_project_id: projectId, kind: "advance", state: "planned" },
    limit: 10,
  })) as Array<{ id: string }>
  const drafted: string[] = []
  for (const step of steps) {
    const out = (await advanceDraftCreate(ctx, { projectId, stepId: step.id })) as {
      status?: string
    }
    if (out?.status !== "error") drafted.push(step.id)
  }
  return drafted.length > 0 ? { status: "drafted", steps: drafted } : { status: "ignored" }
}
