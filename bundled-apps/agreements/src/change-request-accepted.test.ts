// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What follows an accepted change request, over the in-memory db and the seal doubles, with
// projects answered by a double of the kernel's call made as the change request's sender: the
// milestone task first, then the whole-project timebox (420 h to 480 h), from a claim on the
// change request's row; a project that does not use time and budgets gets a task with no size;
// no project, or a decline, gets nothing; a run that dies between steps is resumed by the job
// without a second task.

import { describe, expect, it } from "bun:test"
import {
  CLAIM_STALE_MS,
  changeRequestEffectsJob,
  runChangeRequestEffects,
} from "./change-request-effects"
import type { AgreementsCtx } from "./ctx"
import type { Row } from "./memory-db.testutil"
import { FROZEN, signedWorld } from "./seal.testutil"
import { onClientActionDecided } from "./send"

const ACTION = "cccccccc-0000-4000-8000-00000000000c"
const PROJECT = "dddddddd-0000-4000-8000-00000000000d"

interface Call {
  tool: string
  params: Record<string, unknown>
  key?: string
  target_id: string
}

type Projects = {
  usesTime: boolean
  timeboxMinutes: number | null
  /** Throws once on this tool: a run that dies there. */
  dieOn?: string
}

async function acceptedWorld(
  opts: {
    projectId?: string | null
    recorded?: { usesTime: boolean | null; timeboxMinutes: number | null }
    projects?: Projects
  } = {},
) {
  const world = await signedWorld()
  const { db } = world
  const recorded = opts.recorded ?? { usesTime: true, timeboxMinutes: 420 * 60 }
  const parent = await db.insert("agreements", {
    number: "AG-2026-014",
    kind: "sow",
    title: "Website",
    status: "signed",
    price_minor: "4200000",
    project_id: opts.projectId === undefined ? PROJECT : opts.projectId,
    project_time_budgets: recorded.usesTime,
    project_timebox_minutes: recorded.timeboxMinutes,
  })
  await db.update("agreements", world.agreementId, {
    kind: "change_request",
    number: "CR-1",
    title: "Booking page",
    status: "sent",
    parent_agreement_id: parent.id,
    hours_minutes: 60 * 60,
    rate_minor: "10000",
    price_minor: "600000",
    currency: "EUR",
  })
  await db.update("agreement_versions", world.versionId, { status: "frozen" })
  world.db.tables.set("signature_events", [])
  const projects: Projects = opts.projects ?? { usesTime: true, timeboxMinutes: 420 * 60 }
  const calls: Call[] = []
  const tasks = new Map<string, string>()
  let died = false
  const callAsSender = async (p: {
    target_type: string
    target_id: string
    tool: string
    params: Record<string, unknown>
    idempotency_key?: string
  }) => {
    calls.push({ tool: p.tool, params: p.params, key: p.idempotency_key, target_id: p.target_id })
    if (projects.dieOn === p.tool && !died) {
      died = true
      throw new Error("the worker stopped")
    }
    if (p.tool === "projects:create") {
      // The kernel's idempotency key: a second call with it answers the first.
      const key = p.idempotency_key ?? crypto.randomUUID()
      const id = tasks.get(key) ?? crypto.randomUUID()
      tasks.set(key, id)
      return { status: "completed", result: { id, title: p.params.title } }
    }
    if (p.tool === "projects:time_plan_set") {
      if (!projects.usesTime)
        return {
          status: "error",
          error: { code: "planning_off", message: "This project does not use time and budgets." },
        }
      const t = p.params.timebox
      if (typeof t === "string") projects.timeboxMinutes = Number.parseFloat(t) * 60
      return { status: "completed", result: { timeboxMinutes: projects.timeboxMinutes } }
    }
    return { status: "error", error: { code: "CALL_NOT_DECLARED", message: p.tool } }
  }
  const record = (decision: string) => ({
    id: ACTION,
    decision,
    decided_at: "2026-11-12 10:00:00+00",
    invited_email: "client@maison-a.example",
    invited_name: "Client A",
    invited_by: "lea@studio.example",
    sign_order: null,
    contact_id: null,
    signer_user_id: null,
    typed_name: "Client A",
    capacity: "",
    words_shown: 'By entering my name and the code, I approve "CR-1".',
    words_lang: "en",
    required_phrase: null,
    typed_phrase: null,
    code_verified_at: "2026-11-12 09:59:00+00",
    document_shown_at: "2026-11-12 09:58:00+00",
    reached_end_at: null,
    ip: "198.51.100.7",
    user_agent: "UA",
    target_sha256: FROZEN,
    group: [{ id: ACTION, sign_order: null, decision, open: false }],
  })
  let current = record("approved")
  const ctx = {
    ...world.ctx,
    client_actions_record: async () => ({ status: "ok", record: current }),
    client_actions_call_as_sender: callAsSender,
  } as unknown as AgreementsCtx
  const decide = (decision: string) => {
    current = record(decision)
    return onClientActionDecided(ctx, {
      data: {
        id: ACTION,
        decision,
        target: { app: "agreements", type: "agreement_version", id: world.versionId },
      },
    }) as Promise<{ status: string; effects?: string }>
  }
  const row = (id: string) => world.db.tables.get("agreements")?.find((r) => r.id === id) as Row
  return { world, ctx, parentId: parent.id, crId: world.agreementId, decide, row, calls, projects }
}

const tools = (calls: Call[]) => calls.map((c) => c.tool)

describe("an accepted change request's work", () => {
  it("adds one milestone task sized by its hours, then grows the project's timebox from 420 h to 480 h", async () => {
    const w = await acceptedWorld()
    const out = await w.decide("approved")
    expect(out.status).toBe("accepted")
    expect(out.effects).toBe("done")
    expect(tools(w.calls)).toEqual(["projects:create", "projects:time_plan_set"])
    const [task, plan] = w.calls
    expect(task?.params).toMatchObject({
      projectId: PROJECT,
      title: "CR-1: Booking page",
      isMilestone: true,
      timebox: "60 hours",
    })
    expect(task?.key).toBe(`change_request:${w.crId}:task`)
    // Every call is made on the approved version, whose sender the kernel finds.
    expect(new Set(w.calls.map((c) => c.target_id))).toEqual(new Set([w.world.versionId]))
    expect(plan?.params).toEqual({ projectId: PROJECT, timebox: "480 hours" })
    expect(w.projects.timeboxMinutes).toBe(480 * 60)
    const cr = w.row(w.crId)
    expect(cr.effects_task_id).toBeTruthy()
    expect(cr.effects_time_plan).toBe("set")
    expect(cr.effects_done_at).toBeTruthy()
    expect(w.row(w.parentId).project_timebox_minutes).toBe(480 * 60)
    // No invoice, nothing turned on: no other app is called.
    expect(w.calls.some((c) => !c.tool.startsWith("projects:"))).toBe(false)
  })

  it("on a project that does not use time and budgets, adds the task with no size and leaves the plan alone", async () => {
    const w = await acceptedWorld({
      recorded: { usesTime: false, timeboxMinutes: null },
      projects: { usesTime: false, timeboxMinutes: null },
    })
    expect((await w.decide("approved")).effects).toBe("done")
    expect(tools(w.calls)).toEqual(["projects:create"])
    expect(w.calls[0]?.params.timebox).toBeUndefined()
    expect(w.row(w.crId).effects_time_plan).toBe("none")
  })

  it("when the parent did not record what its project uses, projects answers by its own state and the task has no size", async () => {
    const w = await acceptedWorld({
      recorded: { usesTime: null, timeboxMinutes: null },
      projects: { usesTime: false, timeboxMinutes: null },
    })
    expect((await w.decide("approved")).effects).toBe("done")
    expect(tools(w.calls)).toEqual(["projects:time_plan_set", "projects:create"])
    expect(w.calls[0]?.params).toEqual({ projectId: PROJECT })
    expect(w.calls[1]?.params.timebox).toBeUndefined()
    expect(w.row(w.crId).effects_time_plan).toBe("none")
  })

  it("with no project on its parent, adds nothing and is done", async () => {
    const w = await acceptedWorld({ projectId: null })
    expect((await w.decide("approved")).effects).toBe("done")
    expect(w.calls).toHaveLength(0)
    expect(w.row(w.crId).effects_done_at).toBeTruthy()
  })

  it("declined, calls nothing and records no work", async () => {
    const w = await acceptedWorld()
    expect((await w.decide("declined")).status).toBe("declined")
    expect(w.calls).toHaveLength(0)
    expect(w.row(w.crId).effects_claim ?? null).toBeNull()
    expect(w.projects.timeboxMinutes).toBe(420 * 60)
  })

  it("a crash after the task and before the time plan resumes without a second task", async () => {
    const w = await acceptedWorld({
      projects: { usesTime: true, timeboxMinutes: 420 * 60, dieOn: "projects:time_plan_set" },
    })
    const out = await w.decide("approved")
    expect(out.status).toBe("accepted")
    expect(out.effects).toBe("stopped")
    const after = w.row(w.crId)
    expect(after.effects_task_id).toBeTruthy()
    expect(after.effects_timebox_minutes).toBe(480 * 60)
    expect(after.effects_done_at ?? null).toBeNull()
    // While the dead run's claim is fresh, the job leaves it.
    const held = await changeRequestEffectsJob(w.ctx)
    expect(held.results).toEqual([{ change_request: "CR-1", status: "held" }])
    // Once it is stale, the job takes it over and resumes at the time plan.
    await w.world.db.update("agreements", w.crId, {
      effects_claimed_at: new Date(Date.now() - CLAIM_STALE_MS - 60_000).toISOString(),
    })
    const resumed = await changeRequestEffectsJob(w.ctx)
    expect(resumed.resumed).toBe(1)
    expect(tools(w.calls).filter((t) => t === "projects:create")).toHaveLength(1)
    expect(w.projects.timeboxMinutes).toBe(480 * 60)
    expect(w.row(w.crId).effects_task_id).toBe(after.effects_task_id)
    expect(w.row(w.crId).effects_done_at).toBeTruthy()
    // Done is done: a later job calls nothing.
    const n = w.calls.length
    await changeRequestEffectsJob(w.ctx)
    expect(w.calls).toHaveLength(n)
  })

  it("a crash after projects made the task but before it was recorded makes no second task", async () => {
    const w = await acceptedWorld()
    // The task call goes through, its answer is lost: the run dies before recording it.
    const inner = (w.ctx as { client_actions_call_as_sender: (p: unknown) => Promise<unknown> })
      .client_actions_call_as_sender
    let lost = false
    ;(
      w.ctx as { client_actions_call_as_sender: (p: unknown) => Promise<unknown> }
    ).client_actions_call_as_sender = async (p) => {
      const out = await inner(p)
      if ((p as { tool: string }).tool === "projects:create" && !lost) {
        lost = true
        throw new Error("the worker stopped")
      }
      return out
    }
    expect((await w.decide("approved")).effects).toBe("stopped")
    expect(w.row(w.crId).effects_task_id ?? null).toBeNull()
    await w.world.db.update("agreements", w.crId, {
      effects_claimed_at: new Date(Date.now() - CLAIM_STALE_MS - 60_000).toISOString(),
    })
    await changeRequestEffectsJob(w.ctx)
    const creates = w.calls.filter((c) => c.tool === "projects:create")
    expect(creates).toHaveLength(2)
    // Both carry the same reference, so the kernel answers the second with the first task.
    expect(new Set(creates.map((c) => c.key)).size).toBe(1)
    expect(w.row(w.crId).effects_done_at).toBeTruthy()
    expect(w.projects.timeboxMinutes).toBe(480 * 60)
  })

  it("two runs at once add the work once", async () => {
    const w = await acceptedWorld()
    // Accepted by hand (no decided handler run): two resumers race for the claim.
    await w.world.db.update("agreements", w.crId, { status: "accepted" })
    await w.world.db.update("agreement_versions", w.world.versionId, { status: "signed" })
    const outs = await Promise.all([
      runChangeRequestEffects(w.ctx, w.crId),
      runChangeRequestEffects(w.ctx, w.crId),
    ])
    expect(outs.map((o) => o.status).sort()).toEqual(["done", "held"])
    expect(tools(w.calls).filter((t) => t === "projects:create")).toHaveLength(1)
    expect(tools(w.calls).filter((t) => t === "projects:time_plan_set")).toHaveLength(1)
  })
})
