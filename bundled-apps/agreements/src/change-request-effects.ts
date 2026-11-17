// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What follows an accepted change request in the work. The approval itself starts nothing; once
// it is recorded, agreements adds the change to the project its parent agreement created:
//
//   1. the task: one milestone task in the parent's project, sized by the change request's
//      hours when the project uses time and budgets, with no size otherwise;
//   2. the time plan: when the project has a whole-project timebox, that timebox grows by the
//      change request's hours;
//   3. the billing step: when the project has a billing plan, one milestone for the change
//      request's price, billed when the task is done (invoicing's `billing_step_add`, once per
//      change request).
//
// Never anything else: no switch is turned on, no invoice is made, nothing is marked started.
//
// The steps run from a claim on the change request's own row, never from the event alone: a
// run reserves `effects_claim` (compare and set on the value it read), records each step's
// result on the row before the next one starts, and stops when another run holds a fresh
// claim. A run that died leaves its claim; once it is older than CLAIM_STALE_MS the next run
// (the decided handler again, or the `change-request-effects` job) takes it over and resumes at
// the first step not recorded. Each call carries its own reference
// (`change_request:<id>:<step>`) as its idempotency key, and the time plan is set to an absolute
// total recorded before the call, so a resumed step never doubles.
//
// Each call runs as the person who sent the change request (the kernel finds them on the
// approval link and uses their live permissions), never as a wider system identity.
//
// What the parent's project uses is read from the parent agreement (recorded when it created the
// project). When it was not recorded, the time plan call asks projects with no change, and
// projects answers by its own state: a project without time and budgets refuses with
// `planning_off`, read here as "no time plan".

import { CHANGE_REQUEST, changeRequestPrice } from "./change-requests"
import { type AgreementsCtx, bridgeAnswer } from "./ctx"

const TARGET_TYPE = "agreement_version"
/** A claim older than this belongs to a run that died: the next run takes it over. */
export const CLAIM_STALE_MS = 15 * 60 * 1000
/** Answers of the time plan call that mean the project has no time plan. */
const NO_TIME_PLAN = new Set(["planning_off", "feature_off"])
/** Answers of the billing step call that mean the project is not billed by a plan. */
const NO_BILLING_STEP = new Set([
  "no_billing_plan",
  "plan_on_rate_project",
  "tool_not_found",
  "app_disabled",
])

interface CrRow {
  id: string
  number: string
  title?: string | null
  kind: string
  status: string
  parent_agreement_id?: string | null
  hours_minutes?: number | null
  effects_claim?: string | null
  effects_claimed_at?: string | null
  effects_task_id?: string | null
  effects_timebox_minutes?: number | null
  effects_time_plan?: string | null
  effects_billing?: string | null
  effects_done_at?: string | null
  price_minor?: string | number | null
  rate_minor?: string | number | null
  currency?: string | null
}

interface ParentRow {
  id: string
  number: string
  project_id?: string | null
  project_time_budgets?: boolean | null
  project_timebox_minutes?: number | null
}

interface VersionRow {
  id: string
  status: string
  number?: number
}

export interface EffectsOutcome {
  status: "done" | "held" | "not_accepted" | "stopped"
  change_request: string
  task_id?: string | null
  time_plan?: string | null
  billing?: string | null
  message: string
}

type CallAnswer =
  | { status: "completed"; result?: unknown }
  | { status: "pending_approval"; approval_id?: string | null }
  | { status: "error"; error: { code: string; message: string } }

const hoursText = (minutes: number) => {
  const h = minutes / 60
  return `${Number.isInteger(h) ? h : h.toFixed(2)} hours`
}

/** The bulk filter that names exactly this change request (the host refuses `id` in one). */
const crWhere = (cr: CrRow) => ({
  parent_agreement_id: cr.parent_agreement_id ?? null,
  number: cr.number,
  kind: CHANGE_REQUEST,
})

async function callAsSender(
  ctx: AgreementsCtx,
  versionId: string,
  tool: string,
  params: Record<string, unknown>,
  ref: string,
): Promise<CallAnswer> {
  if (!ctx.client_actions_call_as_sender)
    return {
      status: "error",
      error: { code: "UNAVAILABLE", message: "This host cannot call as the sender." },
    }
  return bridgeAnswer<CallAnswer>(
    await ctx.client_actions_call_as_sender({
      target_type: TARGET_TYPE,
      target_id: versionId,
      tool,
      params,
      idempotency_key: ref,
    }),
  )
}

/**
 * Take the claim on one change request: compare and set on the claim value read, so of two
 * runs only one holds it. Answers the claim, or null when another live run holds it.
 */
async function claim(ctx: AgreementsCtx, cr: CrRow, now: Date): Promise<string | null> {
  const held = cr.effects_claim ?? null
  if (held !== null) {
    const at = cr.effects_claimed_at ? Date.parse(String(cr.effects_claimed_at)) : Number.NaN
    if (Number.isFinite(at) && now.getTime() - at < CLAIM_STALE_MS) return null
  }
  const mine = crypto.randomUUID()
  const out = await ctx.db.updateMany("agreements", {
    where: { ...crWhere(cr), status: "accepted", effects_done_at: null, effects_claim: held },
    data: { effects_claim: mine, effects_claimed_at: now.toISOString() },
  })
  return out.count === 1 ? mine : null
}

/** Record one step's result on the change request, still under this run's claim. */
async function record(
  ctx: AgreementsCtx,
  cr: CrRow,
  mine: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const out = await ctx.db.updateMany("agreements", {
    where: { ...crWhere(cr), effects_claim: mine },
    data: { ...data, effects_claimed_at: new Date().toISOString() },
  })
  return out.count === 1
}

/**
 * Run (or resume) the effects of one accepted change request. Safe to call any number of
 * times: a finished one answers `done`, a held one `held`.
 */
export async function runChangeRequestEffects(
  ctx: AgreementsCtx,
  crId: string,
  now: Date = new Date(),
): Promise<EffectsOutcome> {
  const found = (await ctx.db.findOne("agreements", crId)) as CrRow | null
  if (!found || found.kind !== CHANGE_REQUEST || found.status !== "accepted")
    return {
      status: "not_accepted",
      change_request: found?.number ?? crId,
      message: `${found?.number ?? crId} is not an accepted change request: nothing follows.`,
    }
  const cr = found
  if (cr.effects_done_at)
    return {
      status: "done",
      change_request: cr.number,
      task_id: cr.effects_task_id ?? null,
      time_plan: cr.effects_time_plan ?? null,
      billing: cr.effects_billing ?? null,
      message: `${cr.number}'s work was already added.`,
    }
  const mine = await claim(ctx, cr, now)
  if (!mine)
    return {
      status: "held",
      change_request: cr.number,
      message: `Another run is adding ${cr.number}'s work; nothing was done twice.`,
    }

  const parent = cr.parent_agreement_id
    ? ((await ctx.db.findOne("agreements", cr.parent_agreement_id)) as ParentRow | null)
    : null
  const projectId = parent?.project_id ?? null
  const finish = async (note: string, extra: Record<string, unknown> = {}) => {
    await record(ctx, cr, mine, {
      ...extra,
      effects_done_at: new Date().toISOString(),
      effects_note: note,
    })
    return {
      status: "done" as const,
      change_request: cr.number,
      task_id: (extra.effects_task_id as string | undefined) ?? cr.effects_task_id ?? null,
      time_plan: (extra.effects_time_plan as string | undefined) ?? cr.effects_time_plan ?? null,
      billing: (extra.effects_billing as string | undefined) ?? cr.effects_billing ?? null,
      message: note,
    }
  }
  const stop = async (note: string): Promise<EffectsOutcome> => {
    await record(ctx, cr, mine, { effects_note: note })
    return { status: "stopped", change_request: cr.number, message: note }
  }
  if (!projectId)
    return finish(
      `${cr.number} is accepted; ${parent?.number ?? "its parent"} has no project, so no task or time plan was added.`,
    )

  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: cr.id, status: "signed" },
    limit: 5,
  })) as VersionRow[]
  const version = versions.sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0))[0]
  if (!version) return stop(`${cr.number} has no approved version yet; tried again later.`)

  const minutes = Math.max(0, Math.trunc(cr.hours_minutes ?? 0))
  let usesTime: boolean | null =
    parent?.project_time_budgets === true || parent?.project_time_budgets === false
      ? parent.project_time_budgets
      : null
  let timePlan = cr.effects_time_plan ?? null
  let target = cr.effects_timebox_minutes ?? null

  // What the project uses, when the parent did not record it: projects answers by its own
  // state, with no change.
  if (usesTime === null && timePlan === null) {
    const probe = await callAsSender(
      ctx,
      version.id,
      "projects:time_plan_set",
      { projectId },
      `change_request:${cr.id}:time_plan_probe`,
    )
    if (probe.status === "error" && NO_TIME_PLAN.has(probe.error.code)) usesTime = false
    else if (probe.status === "completed") {
      usesTime = true
      const base = (probe.result as { timeboxMinutes?: unknown } | undefined)?.timeboxMinutes
      if (typeof base === "number" && base > 0 && minutes > 0 && target === null)
        target = base + minutes
      if (typeof base !== "number" || base <= 0) timePlan = "none"
    } else
      return stop(
        `${cr.number}: projects could not say whether ${parent?.number ?? "the project"} uses time and budgets (${probe.status === "error" ? probe.error.code : "waiting on a person"}); tried again later.`,
      )
  }
  if (usesTime === true && timePlan === null && target === null) {
    const base = parent?.project_timebox_minutes ?? null
    if (typeof base === "number" && base > 0 && minutes > 0) target = base + minutes
    else timePlan = "none"
  }
  if (usesTime === false) timePlan = "none"

  // 1. The task.
  let taskId = cr.effects_task_id ?? null
  if (!taskId) {
    const made = await callAsSender(
      ctx,
      version.id,
      "projects:create",
      {
        projectId,
        title: `${cr.number}: ${cr.title ?? "change request"}`,
        description: `Work added by change request ${cr.number}, approved by the client under ${parent?.number ?? "its agreement"}.`,
        isMilestone: true,
        ...(usesTime === true && minutes > 0 ? { timebox: hoursText(minutes) } : {}),
      },
      `change_request:${cr.id}:task`,
    )
    const id =
      made.status === "completed" ? (made.result as { id?: unknown } | undefined)?.id : undefined
    if (typeof id !== "string")
      return stop(
        `${cr.number}: the task was not added (${made.status === "error" ? `${made.error.code}: ${made.error.message}` : "waiting on a person"}); tried again later.`,
      )
    taskId = id
    // The plan's absolute total is recorded with the task, before the time plan call.
    if (
      !(await record(ctx, cr, mine, {
        effects_task_id: taskId,
        effects_timebox_minutes: target,
        ...(timePlan === "none" ? { effects_time_plan: "none" } : {}),
      }))
    )
      return {
        status: "held",
        change_request: cr.number,
        message: `Another run took over ${cr.number}; it resumes from the task.`,
      }
  } else if (target !== null && cr.effects_timebox_minutes == null) {
    await record(ctx, cr, mine, { effects_timebox_minutes: target })
  }

  // 2. The whole-project time plan, set to the total recorded above (a resumed call sets the
  //    same total again, never adds twice).
  if (timePlan === null && target !== null) {
    const set = await callAsSender(
      ctx,
      version.id,
      "projects:time_plan_set",
      { projectId, timebox: hoursText(target) },
      `change_request:${cr.id}:time_plan`,
    )
    if (set.status === "error" && NO_TIME_PLAN.has(set.error.code)) timePlan = "none"
    else if (set.status !== "completed")
      return stop(
        `${cr.number}: the task was added, the time plan was not (${set.status === "error" ? set.error.code : "waiting on a person"}); tried again later.`,
      )
    else {
      timePlan = "set"
      if (parent) await ctx.db.update("agreements", parent.id, { project_timebox_minutes: target })
    }
  }
  if (timePlan === null) timePlan = "none"
  if (timePlan !== cr.effects_time_plan)
    await record(ctx, cr, mine, { effects_time_plan: timePlan })

  // 3. The billing step, once the task exists: invoicing adds it once per change request (a
  //    resumed call answers the step the first one added).
  let billing = cr.effects_billing ?? null
  if (billing === null) {
    const price = changeRequestPrice(cr as never)
    if (price <= 0n) billing = "none"
    else {
      const step = await callAsSender(
        ctx,
        version.id,
        "invoicing:billing_step_add",
        {
          projectId,
          changeRequestId: cr.id,
          label: `${cr.number}: ${cr.title ?? "change request"}`,
          amountMinor: price.toString(),
          ...(cr.currency ? { currency: cr.currency } : {}),
          taskId,
        },
        `change_request:${cr.id}:billing_step`,
      )
      if (step.status === "completed") billing = "added"
      else if (step.status === "error" && NO_BILLING_STEP.has(step.error.code)) billing = "none"
      else
        return stop(
          `${cr.number}: the task was added, its billing step was not (${step.status === "error" ? `${step.error.code}: ${step.error.message}` : "waiting on a person"}); tried again later.`,
        )
    }
  }

  const billed =
    billing === "added"
      ? " Its billing plan has one more milestone for it, invoiced when the task is done; no invoice was made."
      : " No invoice was made."
  return finish(
    timePlan === "set" && target !== null
      ? `${cr.number}'s milestone task was added to the project and its timebox is now ${hoursText(target)}. Nothing was turned on.${billed}`
      : `${cr.number}'s milestone task was added to the project${usesTime === true ? "" : " with no size (the project does not use time and budgets)"}. Nothing was turned on.${billed}`,
    { effects_task_id: taskId, effects_time_plan: timePlan, effects_billing: billing },
  )
}

/** Every accepted change request whose work is not added yet, resumed (job `change-request-effects`). */
export async function changeRequestEffectsJob(ctx: AgreementsCtx, now: Date = new Date()) {
  const rows = (await ctx.db.findMany("agreements", {
    where: { kind: CHANGE_REQUEST, status: "accepted", effects_done_at: null },
    limit: 50,
  })) as CrRow[]
  const out: EffectsOutcome[] = []
  for (const r of rows) out.push(await runChangeRequestEffects(ctx, r.id, now))
  return {
    status: "ok",
    resumed: out.filter((o) => o.status === "done").length,
    results: out.map((o) => ({ change_request: o.change_request, status: o.status })),
  }
}
