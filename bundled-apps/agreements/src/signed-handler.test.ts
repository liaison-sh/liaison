// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed proposal starts its project once: time and budgets follow its
// timebox, a replayed signature or the seal retry makes nothing more, a kind that
// starts no project makes none, and a pass that stopped before the plan finishes
// it on the next one.

import { describe, expect, it } from "bun:test"
import type { CrossAppEnvelope } from "@liaison/app-sdk"
import { sealRetry, sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"
import { startProjectAfterSigning, timeboxOf } from "./signed-project"

const COMPANY = "cccccccc-0000-4000-8000-00000000000c"

/** A projects app that keeps one project per step, as createProject's externalRef does. */
function fakeProjects() {
  const byRef = new Map<string, string>()
  const calls: Array<{ name: string; params: Record<string, unknown> }> = []
  let planFails = false
  const executeTool = async (
    name: string,
    params: Record<string, unknown>,
  ): Promise<CrossAppEnvelope> => {
    calls.push({ name, params })
    if (name === "projects:createProject") {
      const ref = String(params.externalRef)
      const existing = byRef.get(ref)
      if (existing) return { status: "completed", result: { id: existing, existing: true } }
      const id = `project-${byRef.size + 1}`
      byRef.set(ref, id)
      return { status: "completed", result: { id, name: params.name } }
    }
    if (name === "projects:time_plan_set") {
      if (planFails) return { status: "error", error: { code: "down", message: "unavailable" } }
      return { status: "completed", result: { projectId: params.projectId } }
    }
    return { status: "error", error: { code: "NOT_DECLARED", message: name } }
  }
  return {
    executeTool,
    calls,
    byRef,
    failPlan: (v: boolean) => {
      planFails = v
    },
  }
}

async function world(values: Record<string, unknown>) {
  const w = await signedWorld()
  await w.db.update("agreements", w.agreementId, {
    kind: "proposal",
    company_id: COMPANY,
    ...values,
  })
  const projects = fakeProjects()
  w.ctx.executeTool = projects.executeTool
  return { ...w, projects }
}

const created = (calls: Array<{ name: string }>) =>
  calls.filter((c) => c.name === "projects:createProject").length

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
    expect(w.projects.calls[0]?.params).toMatchObject({
      companyId: COMPANY,
      externalRef: `agreement:${w.agreementId}`,
    })
  })

  it("time and budgets on when the proposal has a timebox, off when it has none", async () => {
    const boxed = await world({ hours_minutes: 40 * 60 })
    await sealVersion(boxed.ctx, boxed.versionId)
    expect(boxed.projects.calls[0]?.params.timeBudgets).toBe(true)
    expect(boxed.projects.calls[1]).toEqual({
      name: "projects:time_plan_set",
      params: { projectId: "project-1", timebox: "40 hours" },
    })
    expect(
      ((await boxed.db.findOne("agreements", boxed.agreementId)) as Record<string, unknown>)
        .project_time_budgets,
    ).toBe(true)

    const open = await world({ hours_minutes: null })
    await sealVersion(open.ctx, open.versionId)
    expect(open.projects.calls.map((c) => c.name)).toEqual(["projects:createProject"])
    expect(open.projects.calls[0]?.params.timeBudgets).toBe(false)
  })

  it("an agreement that starts no project, a change request included, calls nothing", async () => {
    for (const kind of ["nda", "msa", "change_request"]) {
      const w = await world({ kind })
      await sealVersion(w.ctx, w.versionId)
      expect(w.projects.calls).toHaveLength(0)
    }
  })

  it("a pass that stopped before the plan finishes it on the next one, without a second project", async () => {
    const w = await world({ hours_minutes: 90 })
    w.projects.failPlan(true)
    await sealVersion(w.ctx, w.versionId)
    expect(
      ((await w.db.findOne("agreements", w.agreementId)) as { project_id?: string }).project_id,
    ).toBeFalsy()
    w.projects.failPlan(false)
    await sealRetry(w.ctx)
    expect(w.projects.byRef.size).toBe(1)
    expect(
      ((await w.db.findOne("agreements", w.agreementId)) as { project_id: string }).project_id,
    ).toBe("project-1")
    expect(w.projects.calls.filter((c) => c.name === "projects:time_plan_set")).toHaveLength(2)
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
