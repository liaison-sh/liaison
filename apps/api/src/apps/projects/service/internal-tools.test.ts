// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The internal reads the invoicing app calls: every key and value of their answers is walked, so
// real time, a time-spent note, a trace estimate, an assignee or a person can never ride along to
// an invoice. They are internal tools: never visible to an agent and outside the feature switch.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { seedReconciliationLine } from "~/seed/factories/projects/reconcile"
import {
  asPerson,
  type ClaimsWorld,
  claimsWorld,
  forgetClaimsWorld,
  storedReconciliation,
} from "~/tests/helpers/projects-claims"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { milestoneStatusRead, reconcileLinesRead } from "./claims"

let w: ClaimsWorld
let ownerName = ""
let ownerEmail = ""

beforeAll(async () => {
  await acquireTestLock()
  w = await claimsWorld("INTL", 4)
  const me = extractRows<{ name: string | null; email: string }>(
    await db.execute(
      drizzleSql`SELECT name, email FROM kernel.users WHERE id = ${w.owner.userId}::uuid`,
    ),
  )[0]
  ownerName = me?.name ?? ""
  ownerEmail = me?.email ?? ""
  // The task is someone's: an assignee that must not reach the read.
  await db.execute(drizzleSql`
    UPDATE app_projects.tasks SET assignee_id = ${w.owner.userId}::uuid
     WHERE org_id = ${w.orgId}::uuid AND project_id = ${w.projectId}::uuid`)
}, 120_000)

afterAll(async () => {
  forgetClaimsWorld(w)
  await releaseTestLock()
})

/** Every key path and every leaf value of an answer. */
function walk(v: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`))
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      walk(x, path ? `${path}.${k}` : k),
    )
  }
  return [{ path, value: v }]
}

const PERSONAL_KEY =
  /real|note|estimate|trace|assignee|person|user|member|createdBy|created_by|drafted|activity|time_?spent/i

function expectNothingPersonal(answer: unknown, figures: number[]) {
  for (const { path, value } of walk(answer)) {
    expect(path).not.toMatch(PERSONAL_KEY)
    if (typeof value === "number") expect(figures).not.toContain(value)
    if (typeof value === "string") {
      expect(value).not.toContain(w.owner.userId)
      if (ownerName) expect(value).not.toContain(ownerName)
      if (ownerEmail) expect(value).not.toContain(ownerEmail)
      for (const f of figures) {
        const h = f / 60
        for (const shown of [String(f), String(h), String(h).replace(".", ",")]) {
          expect(value).not.toContain(` ${shown} `)
        }
      }
    }
  }
}

describe("the internal reads for invoicing", () => {
  it("the billed lines read carries no real time, note, estimate or person", async () => {
    const r = await storedReconciliation(w, { month: "2026-09", state: "drafted", lines: [] })
    await seedReconciliationLine(w.orgId, {
      reconciliationId: r.id,
      position: 0,
      name: "Search tuning",
      taskIds: [w.tasks["INTL-1"]!],
      billMinutes: 420,
      realMinutes: 517,
      realNoteMinutes: 503,
      traceEstimateMinutes: 489,
      proofs: [{ kind: "commit", ref: "abc1234", label: "Search fix" }],
    })
    await seedReconciliationLine(w.orgId, {
      reconciliationId: r.id,
      position: 1,
      name: "Left off",
      taskIds: [w.tasks["INTL-2"]!],
      billMinutes: 0,
      realMinutes: 211,
    })
    const out = await asPerson(w, (tx) =>
      reconcileLinesRead({ tx, orgId: w.orgId, input: { reconciliationId: r.id } }),
    )
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toEqual(
      expect.objectContaining({
        wording: "Search tuning",
        billMinutes: 420,
        proofLabels: ["Search fix"],
        lineKind: "service",
      }),
    )
    expect(out.state).toBe("drafted")
    expect(out.claimsReserved).toBe(false)
    expectNothingPersonal(out, [517, 503, 489, 211])
  })

  it("the milestone status read carries no assignee, time or activity", async () => {
    const out = await asPerson(w, (tx) =>
      milestoneStatusRead({
        tx,
        orgId: w.orgId,
        input: { projectId: w.projectId, taskIds: [w.tasks["INTL-1"]!, w.tasks["INTL-3"]!] },
      }),
    )
    expect(out.tasks).toHaveLength(2)
    const milestone = out.tasks.find((t) => t.id === w.tasks["INTL-1"])
    expect(milestone).toEqual(
      expect.objectContaining({ title: "Work item 1", terminal: true, isMilestone: true }),
    )
    expect(milestone?.completedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const t of out.tasks) {
      expect(Object.keys(t).sort()).toEqual([
        "completedOn",
        "id",
        "isMilestone",
        "terminal",
        "title",
      ])
    }
    expect(Object.keys(out).sort()).toEqual(["basis", "tasks"])
    expectNothingPersonal(out, [])
  })

  it("the internal reads and the mark are never visible to an agent and work with the feature off", () => {
    const tools = (projectsManifest as { tools: Record<string, Record<string, unknown>> }).tools
    for (const name of ["reconcile_lines_read", "reconcile_mark", "milestone_status_read"]) {
      const tool = tools[name]!
      expect(tool.agentVisible).toBe(false)
      expect(tool.trustBoundary).toBe("internal")
      expect(tool.feature).toBeUndefined()
    }
    expect(Object.keys(tools)).not.toContain("task_time_summary")
  })
})
