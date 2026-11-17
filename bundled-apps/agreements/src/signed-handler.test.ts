// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed proposal starts its project once: a replayed signature or the seal
// retry makes nothing more, a kind that starts no project makes none, a pass
// where projects could not be reached starts it on the retry. Every call runs as
// the agreement's sender, on its signed version: a proposal with a timebox starts
// its project with time and budgets on and that timebox as its plan, and the
// agreement records both for a later change request. Signing also adds the client
// to the Scope check's group when that routine is enabled.

import { describe, expect, it } from "bun:test"
import type { CrossAppEnvelope } from "@liaison/app-sdk"
import { sealRetry, sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"
import { startProjectAfterSigning, timeboxOf } from "./signed-project"

const COMPANY = "cccccccc-0000-4000-8000-00000000000c"

const GROUP = "99999999-0000-4000-8000-000000000009"

/**
 * A projects app that keeps one project per step, as createProject's externalRef does, reached
 * only through the kernel's call made as the sender. `refuseTime` answers time and budgets as
 * projects does from a place it does not take them.
 */
function fakeProjects(opts: { refuseTime?: boolean; group?: string | null } = {}) {
  const byRef = new Map<string, string>()
  const timeOn = new Set<string>()
  const calls: Array<{
    name: string
    params: Record<string, unknown>
    target_type?: string
    target_id?: string
  }> = []
  const answer = (tool: string, params: Record<string, unknown>): CrossAppEnvelope => {
    if (tool === "projects:createProject") {
      if (params.timeBudgets !== undefined && opts.refuseTime)
        return { status: "error", error: { code: "human_turn_only", message: "a person turns it" } }
      const ref = String(params.externalRef)
      const existing = byRef.get(ref)
      if (existing)
        return {
          status: "completed",
          result: { id: existing, existing: true, timeBudgets: timeOn.has(existing) },
        }
      const id = `project-${byRef.size + 1}`
      byRef.set(ref, id)
      if (params.timeBudgets === true) timeOn.add(id)
      return { status: "completed", result: { id, name: params.name, timeBudgets: timeOn.has(id) } }
    }
    if (tool === "projects:time_plan_set") {
      if (!timeOn.has(String(params.projectId)))
        return { status: "error", error: { code: "planning_off", message: "time is off" } }
      return { status: "completed", result: { projectId: params.projectId } }
    }
    if (tool === "kernel:contacts_group_add")
      return { status: "completed", result: { added: params.contactIds } }
    if (tool === "invoicing:retainer_terms_renew")
      return { status: "completed", result: { scheduleId: "schedule-1", from: "2026-12" } }
    return { status: "error", error: { code: "NOT_DECLARED", message: tool } }
  }
  const client_actions_call_as_sender = async (p: {
    target_type: string
    target_id: string
    tool: string
    params: Record<string, unknown>
  }) => {
    calls.push({
      name: p.tool,
      params: p.params,
      target_type: p.target_type,
      target_id: p.target_id,
    })
    return JSON.stringify(answer(p.tool, p.params))
  }
  const client_actions_own_group = async () =>
    JSON.stringify({ status: "ok", group_id: opts.group ?? null })
  return { client_actions_call_as_sender, client_actions_own_group, calls, byRef }
}

async function world(
  values: Record<string, unknown>,
  opts: { refuseTime?: boolean; group?: string | null } = {},
) {
  const w = await signedWorld()
  await w.db.update("agreements", w.agreementId, {
    kind: "proposal",
    company_id: COMPANY,
    ...values,
  })
  const projects = fakeProjects(opts)
  w.ctx.client_actions_call_as_sender = projects.client_actions_call_as_sender
  w.ctx.client_actions_own_group = projects.client_actions_own_group
  w.ctx.executeTool = async (name) => ({
    status: "error",
    error: { code: "NOT_AS_SENDER", message: `${name} was called as the app, not as the sender` },
  })
  return { ...w, projects }
}

const created = (calls: Array<{ name: string }>) =>
  calls.filter((c) => c.name === "projects:createProject").length

describe("a signed retainer renewal", () => {
  const RETAINER_PROJECT = "dccbd24c-0000-4000-8000-000000000001"

  it("rolls its hours, fee, rate and first month into the retainer it names, and starts no project", async () => {
    const w = await world({
      kind: "retainer",
      project_id: RETAINER_PROJECT,
      hours_minutes: 44 * 60,
      price_minor: "495000",
      rate_minor: "12500",
      currency: "EUR",
      starts_on: "2026-12-01",
    })
    await sealVersion(w.ctx, w.versionId)
    await sealRetry(w.ctx)
    expect(created(w.projects.calls)).toBe(0)
    const renew = w.projects.calls.filter((c) => c.name === "invoicing:retainer_terms_renew")
    expect(renew.length).toBeGreaterThanOrEqual(1)
    const a = (await w.db.findOne("agreements", w.agreementId)) as { number: string }
    expect(renew[0]).toMatchObject({ target_type: "agreement_version", target_id: w.versionId })
    expect(renew[0]?.params).toEqual({
      projectId: RETAINER_PROJECT,
      agreementId: w.agreementId,
      agreementNumber: a.number,
      startsOn: "2026-12-01",
      minutes: 44 * 60,
      feeMinor: "495000",
      overageRateMinor: "12500",
    })
    const row = (await w.db.findOne("agreements", w.agreementId)) as Record<string, unknown>
    expect(row.project_id).toBe(RETAINER_PROJECT)
  })

  it("a renewal with no hours or no price rolls nothing and starts no project", async () => {
    const w = await world({
      kind: "retainer",
      project_id: RETAINER_PROJECT,
      hours_minutes: null,
      price_minor: "495000",
      starts_on: "2026-12-01",
    })
    await sealVersion(w.ctx, w.versionId)
    expect(created(w.projects.calls)).toBe(0)
    expect(w.projects.calls.map((c) => c.name)).not.toContain("invoicing:retainer_terms_renew")
    expect(await startProjectAfterSigning(w.ctx, w.agreementId)).toMatchObject({
      status: "skipped",
    })
  })
})

describe("a signed agreement's project", () => {
  it("a replayed signed event creates nothing", async () => {
    const w = await world({ hours_minutes: 40 * 60 })
    await sealVersion(w.ctx, w.versionId)
    await sealVersion(w.ctx, w.versionId)
    await sealRetry(w.ctx)
    expect(w.projects.byRef.size).toBe(1)
    expect(created(w.projects.calls)).toBe(1)
    const a = (await w.db.findOne("agreements", w.agreementId)) as { project_id: string }
    expect(a.project_id).toBe("project-1")
    // The signed event names the project, so invoicing can draft its advance.
    const signedEvents = w.ctx.calls.emitted.filter((e) => e.action === "signed")
    expect(signedEvents).toHaveLength(1)
    expect(signedEvents[0]?.data).toMatchObject({ project_id: "project-1", kind: "proposal" })
    expect(w.projects.calls[0]?.params).toMatchObject({
      companyId: COMPANY,
      externalRef: `agreement:${w.agreementId}`,
    })
  })

  it("a restricted agreement's project is named by its number alone, with no client, and its client joins no group", async () => {
    const w = await world(
      { hours_minutes: null, org_access: "none", title: "Takeover due diligence, Maison Nord" },
      { group: GROUP },
    )
    await sealVersion(w.ctx, w.versionId)
    const create = w.projects.calls.find((c) => c.name === "projects:createProject")
    const a = (await w.db.findOne("agreements", w.agreementId)) as { number: string }
    expect(create?.params.name).toBe(`Agreement ${a.number}`)
    expect(create?.params).not.toHaveProperty("companyId")
    expect(JSON.stringify(w.projects.calls)).not.toContain("Maison Nord")
    expect(w.projects.calls.map((c) => c.name)).not.toContain("kernel:contacts_group_add")
  })

  it("a proposal with a timebox starts its project as the sender, with time and budgets on and that timebox as its plan", async () => {
    const boxed = await world({ hours_minutes: 40 * 60 })
    await sealVersion(boxed.ctx, boxed.versionId)
    const projectCalls = boxed.projects.calls.filter((c) => c.name.startsWith("projects:"))
    expect(projectCalls.map((c) => c.name)).toEqual([
      "projects:createProject",
      "projects:time_plan_set",
    ])
    for (const c of projectCalls) {
      expect(c.target_type).toBe("agreement_version")
      expect(c.target_id).toBe(boxed.versionId)
    }
    expect(projectCalls[0]?.params).toMatchObject({ timeBudgets: true })
    expect(projectCalls[1]?.params).toEqual({ projectId: "project-1", timebox: "40 hours" })
    const row = (await boxed.db.findOne("agreements", boxed.agreementId)) as Record<string, unknown>
    expect(row.project_time_budgets).toBe(true)
    expect(row.project_timebox_minutes).toBe(40 * 60)
    expect(await startProjectAfterSigning(boxed.ctx, boxed.agreementId)).toMatchObject({
      status: "skipped",
    })

    const open = await world({ hours_minutes: null })
    const out = await startProjectAfterSigning(open.ctx, open.agreementId)
    expect(out).toMatchObject({ status: "started", time_budgets: false, timebox: null })
    expect(open.projects.calls[0]?.params).not.toHaveProperty("timeBudgets")
    expect(open.projects.calls.map((c) => c.name)).toEqual(["projects:createProject"])
    const openRow = (await open.db.findOne("agreements", open.agreementId)) as Record<
      string,
      unknown
    >
    expect(openRow.project_time_budgets).toBe(false)
    expect(openRow.project_timebox_minutes ?? null).toBeNull()
  })

  it("where projects keeps time and budgets off, the project still starts, and the agreement records that it uses none", async () => {
    const w = await world({ hours_minutes: 40 * 60 }, { refuseTime: true })
    const out = await startProjectAfterSigning(w.ctx, w.agreementId)
    expect(out).toMatchObject({ status: "started", time_budgets: false, timebox: null })
    expect(w.projects.byRef.size).toBe(1)
    expect(w.projects.calls.map((c) => c.name)).toEqual([
      "projects:createProject",
      "projects:createProject",
    ])
    const row = (await w.db.findOne("agreements", w.agreementId)) as Record<string, unknown>
    expect(row.project_time_budgets).toBe(false)
    expect(row.project_timebox_minutes ?? null).toBeNull()
  })

  it("signing adds the client to the Scope check's group as the sender, and nothing when the routine is not enabled", async () => {
    const on = await world({ contact_id: "contact-a" }, { group: GROUP })
    await sealVersion(on.ctx, on.versionId)
    const adds = on.projects.calls.filter((c) => c.name === "kernel:contacts_group_add")
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({
      target_type: "agreement_version",
      target_id: on.versionId,
      params: { groupId: GROUP, contactIds: ["contact-a"] },
    })

    const off = await world({ contact_id: "contact-a" }, { group: null })
    await sealVersion(off.ctx, off.versionId)
    expect(off.projects.calls.filter((c) => c.name === "kernel:contacts_group_add")).toHaveLength(0)
  })

  it("an agreement that starts no project, a change request included, calls nothing", async () => {
    for (const kind of ["nda", "msa", "change_request"]) {
      const w = await world({ kind })
      await sealVersion(w.ctx, w.versionId)
      expect(w.projects.calls).toHaveLength(0)
    }
  })

  it("a pass where projects could not be reached starts the project on the seal retry, once", async () => {
    const w = await world({ hours_minutes: 90 })
    const real = w.ctx.client_actions_call_as_sender
    w.ctx.client_actions_call_as_sender = async () =>
      JSON.stringify({ status: "error", error: { code: "down", message: "unavailable" } })
    await sealVersion(w.ctx, w.versionId)
    expect(
      ((await w.db.findOne("agreements", w.agreementId)) as { project_id?: string }).project_id,
    ).toBeFalsy()
    w.ctx.client_actions_call_as_sender = real
    await sealRetry(w.ctx)
    await sealRetry(w.ctx)
    expect(w.projects.byRef.size).toBe(1)
    expect(
      ((await w.db.findOne("agreements", w.agreementId)) as { project_id: string }).project_id,
    ).toBe("project-1")
  })

  it("two deliveries at once name the same project", async () => {
    const w = await world({ hours_minutes: null })
    const [a, b] = await Promise.all([
      startProjectAfterSigning(w.ctx, w.agreementId),
      startProjectAfterSigning(w.ctx, w.agreementId),
    ])
    expect(a).toMatchObject({ status: "started", project_id: "project-1" })
    expect(b).toMatchObject({ project_id: "project-1" })
    expect(w.projects.byRef.size).toBe(1)
  })

  it("a timebox reads as hours", () => {
    expect(timeboxOf(90)).toBe("1.5 hours")
    expect(timeboxOf(null)).toBeNull()
    expect(timeboxOf(0)).toBeNull()
  })
})
