// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed proposal or statement of work starts its project, once. After the
// seal, agreements calls projects' declared `createProject` with the agreement as
// the step that makes it (`externalRef`), so a replayed event, the seal retry or
// two deliveries at once find the same project. Every call runs as the person who
// approved the send (the kernel finds them on its signed version; the sender when
// nobody's approval is recorded), never as a wider system identity: the approved
// send is that person's act. A proposal with a timebox asks for time and budgets
// and then sets the project's plan to that timebox; projects decides by its own
// rules, and when it keeps time and budgets off (a send no person approved) the
// project starts without them. The agreement records what the
// project uses (`project_time_budgets`) and the timebox it was given
// (`project_timebox_minutes`), which a later change request reads. Nothing else
// happens on signing here: no invoice, no task, no mail. A restricted agreement's project is
// named by its number alone, with no client.

import { type AgreementsCtx, bridgeAnswer } from "./ctx"

/** The kinds whose signature starts a project. A framework, an NDA or a DPA starts none. */
const STARTS_A_PROJECT = new Set(["proposal", "sow", "retainer", "tm"])
const TARGET_TYPE = "agreement_version"
/** projects' answers for a project that does not use time and budgets. */
const NO_TIME_PLAN = new Set(["planning_off", "feature_off"])
/** projects' answer when time and budgets are asked for from a place it does not take them. */
const HUMAN_TURN_ONLY = "human_turn_only"

interface SignedAgreement {
  id: string
  number: string
  title: string
  kind?: string | null
  company_id?: string | null
  project_id?: string | null
  hours_minutes?: number | null
  org_access?: string | null
}

export type ProjectStart =
  | {
      status: "started"
      project_id: string
      existing: boolean
      /** The project uses time and budgets. */
      time_budgets: boolean
      /** The timebox the project's plan was set to, or null. */
      timebox: string | null
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }

/** The proposal's timebox as projects reads a plan's size, or null when it has none. */
export function timeboxOf(hoursMinutes: number | null | undefined): string | null {
  if (typeof hoursMinutes !== "number" || !(hoursMinutes > 0)) return null
  const hours = Math.round((hoursMinutes / 60) * 100) / 100
  return `${hours} hours`
}

type Answer =
  | { status: "completed"; result?: unknown }
  | { status: "pending_approval"; approval_id?: string | null }
  | { status: "error"; error: { code: string; message: string } }

function objectOf(r: unknown): Record<string, unknown> | null {
  const parsed = typeof r === "string" ? (JSON.parse(r) as unknown) : r
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
}

const why = (a: Answer): string =>
  a.status === "error" ? `${a.error.code}: ${a.error.message}` : "waiting on a person"

/** Starts the signed agreement's project, unless it has one or its kind starts none. */
export async function startProjectAfterSigning(
  ctx: Pick<AgreementsCtx, "db" | "client_actions_call_as_sender">,
  agreementId: string,
): Promise<ProjectStart> {
  const a = (await ctx.db.findOne("agreements", agreementId)) as SignedAgreement | null
  if (!a) return { status: "skipped", reason: "no such agreement" }
  if (a.project_id) return { status: "skipped", reason: "the agreement already names its project" }
  if (!STARTS_A_PROJECT.has(String(a.kind ?? "")))
    return { status: "skipped", reason: `a ${a.kind ?? "plain"} agreement starts no project` }
  const callAsSender = ctx.client_actions_call_as_sender
  if (!callAsSender)
    return { status: "failed", reason: "projects cannot be reached as the sender on this run" }
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: a.id, status: "signed" },
    limit: 50,
  })) as Array<{ id: string; number?: number | null }>
  const version = versions.sort((x, y) => Number(y.number ?? 0) - Number(x.number ?? 0))[0]
  if (!version) return { status: "failed", reason: "the agreement has no signed version yet" }
  const call = async (tool: string, params: Record<string, unknown>, ref: string) =>
    bridgeAnswer<Answer>(
      await callAsSender({
        target_type: TARGET_TYPE,
        target_id: version.id,
        tool,
        params,
        idempotency_key: ref,
      }),
    )

  const timebox = timeboxOf(a.hours_minutes)
  // projects has no list of its own: a restricted agreement's project carries nothing of it but
  // its number (no title, no client), so a member off the list learns nothing from it.
  const restricted = a.org_access === "none"
  const base = {
    name: restricted ? `Agreement ${a.number}` : a.title || a.number,
    ...(a.company_id && !restricted ? { companyId: a.company_id } : {}),
    externalRef: `agreement:${a.id}`,
  }
  let made = await call(
    "projects:createProject",
    timebox ? { ...base, timeBudgets: true } : base,
    `agreement:${a.id}:project`,
  )
  // projects keeps time and budgets to a person's own act; a send no person approved is not
  // one, and the project starts without them.
  if (timebox && made.status === "error" && made.error.code === HUMAN_TURN_ONLY)
    made = await call("projects:createProject", base, `agreement:${a.id}:project:plain`)
  const project = made.status === "completed" ? objectOf(made.result) : null
  const projectId = typeof project?.id === "string" ? project.id : null
  if (!projectId) return { status: "failed", reason: why(made) }

  let timeOn = project?.timeBudgets === true
  let planned: string | null = null
  if (timeOn && timebox) {
    const set = await call(
      "projects:time_plan_set",
      { projectId, timebox },
      `agreement:${a.id}:time_plan`,
    )
    if (set.status === "completed") planned = timebox
    else if (set.status === "error" && NO_TIME_PLAN.has(set.error.code)) timeOn = false
  }
  await ctx.db.update("agreements", a.id, {
    project_id: projectId,
    project_time_budgets: timeOn,
    project_timebox_minutes: planned ? (a.hours_minutes ?? null) : null,
  })
  return {
    status: "started",
    project_id: projectId,
    existing: project?.existing === true,
    time_budgets: timeOn,
    timebox: planned,
  }
}
