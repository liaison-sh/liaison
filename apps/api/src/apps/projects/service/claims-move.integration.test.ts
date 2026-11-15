// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A task on a live billing claim stays where its invoice bills it: a move to another project or a
// merge refuses with `already_on`, naming the invoice or the draft, for any person moving it. A
// left-off or released claim holds nothing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { seedBillingClaim } from "~/seed/factories/projects/reconcile"
import * as minimal from "~/seed/tiers/minimal"
import {
  actorOf,
  asPerson,
  type ClaimsWorld,
  claimsWorld,
  forgetClaimsWorld,
  storedReconciliation,
} from "~/tests/helpers/projects-claims"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createProject } from "./create-project"
import { moveTask } from "./move-task"
import { ProjectsServiceError } from "./statuses"
import { mergeTasks } from "./tasks"

let w: ClaimsWorld
let other = ""

beforeAll(async () => {
  await acquireTestLock()
  w = await claimsWorld("HOLD", 8)
  const made = await asPerson(w, (tx) =>
    createProject({
      tx,
      orgId: w.orgId,
      actor: actorOf(w),
      input: { name: "Maison Autre hold", key: "HOLDB" } as never,
    }),
  )
  other = made.id
}, 120_000)

afterAll(async () => {
  forgetClaimsWorld(w)
  await releaseTestLock()
})

async function claim(
  taskKey: string,
  state: "reserved" | "billed" | "left_off" | "released",
  reconciliationId: string,
  number?: string,
): Promise<string> {
  const id = await seedBillingClaim(w.orgId, {
    now: new Date(),
    projectId: w.projectId,
    sourceRef: w.tasks[taskKey]!,
    periodKey: "all",
    state,
    ageMinutes: 5,
    reconciliationId,
  })
  if (number) {
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET document_number = ${number} WHERE id = ${id}::uuid`)
  }
  return id
}

const projectOf = async (taskKey: string) =>
  extractRows<{ project_id: string; archived: boolean }>(
    await db.execute(drizzleSql`
      SELECT project_id::text AS project_id, archived_at IS NOT NULL AS archived
        FROM app_projects.tasks WHERE id = ${w.tasks[taskKey]!}::uuid`),
  )[0]

const move = (taskKey: string, scopes?: string[], userId?: string) =>
  asPerson(
    w,
    (tx) =>
      moveTask({
        tx,
        orgId: w.orgId,
        actor: actorOf(w, scopes, userId),
        taskId: w.tasks[taskKey]!,
        targetProjectId: other,
      }),
    { ...(scopes ? { scopes } : {}), ...(userId ? { userId } : {}) },
  ).catch((e) => e as ProjectsServiceError)

const merge = (source: string, target: string) =>
  asPerson(w, (tx) =>
    mergeTasks({
      tx,
      orgId: w.orgId,
      actor: actorOf(w),
      sourceId: w.tasks[source]!,
      targetId: w.tasks[target]!,
    }),
  ).catch((e) => e as ProjectsServiceError)

describe("a task on a billing claim", () => {
  it("a task on a live claim cannot move or merge, and the refusal names the document", async () => {
    const drafted = await storedReconciliation(w, { month: "2026-10", lines: [], state: "drafted" })
    await claim("HOLD-2", "reserved", drafted.id)
    const invoiced = await storedReconciliation(w, {
      month: "2026-09",
      lines: [],
      state: "invoiced",
    })
    await claim("HOLD-3", "billed", invoiced.id, "F-2026-0412")

    const onDraft = await move("HOLD-2")
    expect(onDraft).toBeInstanceOf(ProjectsServiceError)
    expect((onDraft as ProjectsServiceError).code).toBe("already_on")
    expect((onDraft as ProjectsServiceError).message).toContain(
      "the draft invoice for Maison Delorme hold",
    )
    expect((await projectOf("HOLD-2"))?.project_id).toBe(w.projectId)

    const onInvoice = await move("HOLD-3")
    expect((onInvoice as ProjectsServiceError).code).toBe("already_on")
    expect((onInvoice as ProjectsServiceError).message).toContain("invoice F-2026-0412")
    expect((onInvoice as ProjectsServiceError).details).toEqual(
      expect.objectContaining({ documentNumber: "F-2026-0412" }),
    )

    // A member who cannot read claims is refused the same.
    const member = await minimal.session(w.orgId)
    const byMember = await move(
      "HOLD-3",
      ["projects:projects:*", "projects:tasks:*"],
      member.userId,
    )
    expect((byMember as ProjectsServiceError).code).toBe("already_on")
    expect((await projectOf("HOLD-3"))?.project_id).toBe(w.projectId)

    const merged = await merge("HOLD-3", "HOLD-4")
    expect((merged as ProjectsServiceError).code).toBe("already_on")
    expect((merged as ProjectsServiceError).message).toContain("invoice F-2026-0412")
    expect((await projectOf("HOLD-3"))?.archived).toBe(false)
  })

  it("a task left off the bill moves", async () => {
    const r = await storedReconciliation(w, { month: "2026-08", lines: [], state: "drafted" })
    await claim("HOLD-5", "left_off", r.id)
    await claim("HOLD-6", "released", r.id)
    const left = await move("HOLD-5")
    expect(left).not.toBeInstanceOf(ProjectsServiceError)
    expect((await projectOf("HOLD-5"))?.project_id).toBe(other)
    const released = await merge("HOLD-6", "HOLD-7")
    expect(released).not.toBeInstanceOf(ProjectsServiceError)
    expect((await projectOf("HOLD-6"))?.archived).toBe(true)
  })
})
