// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed proposal starts its project once: a replayed signature or the seal
// retry makes nothing more, a kind that starts no project makes none, a pass
// where projects could not be reached starts it on the retry, and time and
// budgets stay a person's act (the agreement keeps the timebox for them).

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
    return { status: "error", error: { code: "NOT_DECLARED", message: name } }
  }
  return {
    executeTool,
    calls,
    byRef,
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
    // The signed event names the project, so invoicing can draft its advance.
    const signedEvents = w.ctx.calls.emitted.filter((e) => e.action === "signed")
    expect(signedEvents).toHaveLength(1)
    expect(signedEvents[0]?.data).toMatchObject({ project_id: "project-1", kind: "proposal" })
    expect(w.projects.calls[0]?.params).toMatchObject({
      companyId: COMPANY,
      externalRef: `agreement:${w.agreementId}`,
    })
  })

  it("time and budgets stay a person's act: the project starts with them off, the agreement keeps the timebox for them", async () => {
    const boxed = await world({ hours_minutes: 40 * 60 })
    await sealVersion(boxed.ctx, boxed.versionId)
    expect(boxed.projects.calls.map((c) => c.name)).toEqual(["projects:createProject"])
    expect(boxed.projects.calls[0]?.params).not.toHaveProperty("timeBudgets")
    expect(
      ((await boxed.db.findOne("agreements", boxed.agreementId)) as Record<string, unknown>)
        .project_time_budgets,
    ).toBe(true)
    expect(await startProjectAfterSigning(boxed.ctx, boxed.agreementId)).toMatchObject({
      status: "skipped",
    })

    const open = await world({ hours_minutes: null })
    const out = await startProjectAfterSigning(open.ctx, open.agreementId)
    expect(out).toMatchObject({ status: "started", time_budgets: false, timebox: null })
    expect(
      ((await open.db.findOne("agreements", open.agreementId)) as Record<string, unknown>)
        .project_time_budgets,
    ).toBe(false)
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
    const real = w.ctx.executeTool
    w.ctx.executeTool = async () => ({
      status: "error",
      error: { code: "down", message: "unavailable" },
    })
    await sealVersion(w.ctx, w.versionId)
    expect(
      ((await w.db.findOne("agreements", w.agreementId)) as { project_id?: string }).project_id,
    ).toBeFalsy()
    w.ctx.executeTool = real
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
