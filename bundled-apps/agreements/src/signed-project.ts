// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed proposal or statement of work starts its project, once. After the
// seal, agreements calls projects' declared `createProject` with the agreement as
// the step that makes it (`externalRef`), so a replayed event, the seal retry or
// two deliveries at once find the same project; time and budgets are on when the
// proposal has a timebox and off when it has none, and the timebox becomes the
// project's plan. The agreement then names its project. Nothing else happens on
// signing: no invoice, no task, no mail.

import type { CrossAppEnvelope } from "@liaison/app-sdk"
import type { AgreementsCtx } from "./ctx"

/** The kinds whose signature starts a project. A framework, an NDA or a DPA starts none. */
const STARTS_A_PROJECT = new Set(["proposal", "sow", "retainer", "tm"])

interface SignedAgreement {
  id: string
  number: string
  title: string
  kind?: string | null
  company_id?: string | null
  project_id?: string | null
  hours_minutes?: number | null
}

export type ProjectStart =
  | { status: "started"; project_id: string; existing: boolean; time_budgets: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }

/** The proposal's timebox as projects reads a plan's size, or null when it has none. */
export function timeboxOf(hoursMinutes: number | null | undefined): string | null {
  if (typeof hoursMinutes !== "number" || !(hoursMinutes > 0)) return null
  const hours = Math.round((hoursMinutes / 60) * 100) / 100
  return `${hours} hours`
}

function resultOf(out: CrossAppEnvelope | undefined): Record<string, unknown> | null {
  if (out?.status !== "completed") return null
  const r = out.result
  const parsed = typeof r === "string" ? (JSON.parse(r) as unknown) : r
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
}

/** Starts the signed agreement's project, unless it has one or its kind starts none. */
export async function startProjectAfterSigning(
  ctx: Pick<AgreementsCtx, "db" | "executeTool">,
  agreementId: string,
): Promise<ProjectStart> {
  const a = (await ctx.db.findOne("agreements", agreementId)) as SignedAgreement | null
  if (!a) return { status: "skipped", reason: "no such agreement" }
  if (a.project_id) return { status: "skipped", reason: "the agreement already names its project" }
  if (!STARTS_A_PROJECT.has(String(a.kind ?? "")))
    return { status: "skipped", reason: `a ${a.kind ?? "plain"} agreement starts no project` }
  if (!ctx.executeTool)
    return { status: "failed", reason: "projects cannot be reached on this run" }
  const timebox = timeboxOf(a.hours_minutes)
  const made = await ctx.executeTool("projects:createProject", {
    name: a.title || a.number,
    ...(a.company_id ? { companyId: a.company_id } : {}),
    timeBudgets: timebox !== null,
    externalRef: `agreement:${a.id}`,
  })
  const project = resultOf(made)
  const projectId = typeof project?.id === "string" ? project.id : null
  if (!projectId)
    return {
      status: "failed",
      reason:
        made?.status === "error"
          ? `${made.error.code}: ${made.error.message}`
          : `projects answered ${made?.status ?? "nothing"}`,
    }
  // The plan's size. Setting it again is harmless, so a run that stopped after the project was
  // made and before this step finishes it on the next pass.
  if (timebox) {
    const planned = await ctx.executeTool("projects:time_plan_set", { projectId, timebox })
    if (planned?.status !== "completed")
      return {
        status: "failed",
        reason: `the project was made but its plan was not set: ${
          planned?.status === "error" ? planned.error.message : (planned?.status ?? "no answer")
        }`,
      }
  }
  await ctx.db.update("agreements", a.id, {
    project_id: projectId,
    project_time_budgets: timebox !== null,
  })
  return {
    status: "started",
    project_id: projectId,
    existing: project?.existing === true,
    time_budgets: timebox !== null,
  }
}
