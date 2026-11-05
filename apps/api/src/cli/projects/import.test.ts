// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for `projects import` — the generic NDJSON bulk task importer
 * (mirror of cli/tickets/import.test.ts conventions):
 *
 * - canonical create: one record → project ensured by name (5 default statuses)
 *   + task in the default (first-order) status; createdTasks:1.
 * - project ensure-by-name is idempotent: two records, same project name → ONE
 *   project row; a project that already exists is reused, never duplicated.
 * - externalRef re-import → skipped:1, count of tasks with that ref == 1
 *   (pre-SELECT dedup against the 0009 partial unique index).
 * - status ensure: an unknown status label is created ONCE via addStatus and
 *   reused; matching against existing labels is case-insensitive; statusTerminal
 *   only applies at creation time.
 * - createdAt backdating: tasks.created_at == the supplied historical timestamp;
 *   updated_at is NOT backdated (deliberate — see import.ts header).
 * - subtasks: parentExternalRef resolves against already-imported tasks (earlier
 *   line or previous run); a missing parent fails the record loudly.
 * - assigneeEmail: active org user resolves; unknown email → task imports
 *   UNASSIGNED + a loud per-record line in assigneesUnresolved[].
 * - comments[] by an unresolvable author (no email, bot, unknown email) fold
 *   into the description block (attributed + dated); a resolvable author's
 *   comment is a backdated thread message, with no live event (see import.ts
 *   header).
 * - people: reporterEmail → created_by, completedAt → completed_at (terminal
 *   only), --placeholder-unknown-users → one deactivated user per email.
 * - --dry-run validates (incl. parent ordering) and writes NOTHING.
 * - malformed line → failed[] with line number, stream continues.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { runProjectsImport } from "~/cli/projects/import"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { sendMessage } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function writeNdjson(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-proj-import-"))
  tmpDirs.push(dir)
  const file = join(dir, "tasks.ndjson")
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)
  return file
}

function writeRaw(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-proj-import-raw-"))
  tmpDirs.push(dir)
  const file = join(dir, "tasks.ndjson")
  writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-proj-import-${crypto.randomUUID().slice(0, 12)}`,
    name: "ProjImportTestOrg",
  })
  await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-import-1!",
    role: "admin",
  })
  return orgId
}

async function orgSlug(orgId: string): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(
      drizzleSql`SELECT slug FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid`,
    ),
  )
  return extractRows<{ slug: string }>(rows)[0]!.slug
}

interface TaskRow {
  id: string
  project_id: string
  parent_task_id: string | null
  title: string
  description: string | null
  assignee_id: string | null
  priority: string
  due_date: string | Date | null
  start_date: string | Date | null
  blocked: boolean
  created_at: string | Date
  updated_at: string | Date
  created_by: string
  completed_at: string | Date | null
  thread_id: string
  status_label: string
  status_terminal: boolean
  project_name: string
}

async function taskByExternalRef(orgId: string, externalRef: string): Promise<TaskRow[]> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT t.id, t.project_id, t.parent_task_id, t.title, t.description, t.assignee_id,
             t.priority, t.due_date, t.start_date, t.blocked, t.created_at, t.updated_at,
             t.created_by, t.completed_at, t.thread_id,
             s.label AS status_label, s.terminal AS status_terminal, p.name AS project_name
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id
      WHERE t.org_id = ${orgId}::uuid AND t.external_ref = ${externalRef}
    `),
  )
  return extractRows<TaskRow>(rows)
}

async function countProjectsByName(orgId: string, name: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("projects")}
      WHERE org_id = ${orgId}::uuid AND name = ${name}
    `),
  )
  return extractRows(rows).length
}

async function statusLabels(orgId: string, projectName: string): Promise<string[]> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT s.label FROM ${projectsRel("project_statuses")} s
      JOIN ${projectsRel("projects")} p ON p.id = s.project_id
      WHERE s.org_id = ${orgId}::uuid AND p.name = ${projectName}
      ORDER BY s."order" ASC
    `),
  )
  return extractRows<{ label: string }>(rows).map((r) => r.label)
}

interface OrgUser {
  id: string
  email: string
  name: string
  status: string
}

async function orgUsers(orgId: string): Promise<OrgUser[]> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, email, name, status FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid ORDER BY created_at ASC
    `),
  )
  return extractRows<OrgUser>(rows)
}

/** The org's import actor: its first active user (see resolveActorUserId). */
async function firstUserId(orgId: string): Promise<string> {
  return (await orgUsers(orgId))[0]!.id
}

async function addUser(
  orgId: string,
  email: string,
  name: string,
  status: "active" | "deactivated" = "active",
): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("users")} (id, org_id, email, name, status)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${email}, ${name}, ${status})
      RETURNING id
    `),
  )
  return extractRows<{ id: string }>(rows)[0]!.id
}

describe("projects import", () => {
  test("canonical create: project ensured with default statuses + task in first-order status", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "ProductBoard" },
        title: "Idea one",
        description: "An imported idea",
      },
    ])

    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.createdTasks).toBe(1)
    expect(report.createdProjects).toBe(1)
    expect(report.skipped).toBe(0)
    expect(report.failed.length).toBe(0)

    const tasks = await taskByExternalRef(orgId, extRef)
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.title).toBe("Idea one")
    expect(tasks[0]?.description).toBe("An imported idea")
    expect(tasks[0]?.project_name).toBe("ProductBoard")
    // No status supplied → the default (first-order) status, i.e. 'backlog'.
    expect(tasks[0]?.status_label).toBe("backlog")
    // The ensured project carries the 5 default status seeds.
    expect(await statusLabels(orgId, "ProductBoard")).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "done",
      "cancelled",
    ])
  })

  test("project ensure-by-name: two records, one project; re-run reuses it", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const name = `Proj-${crypto.randomUUID().slice(0, 6)}`
    const file = writeNdjson([
      {
        externalRef: `PJ-${crypto.randomUUID().slice(0, 8)}`,
        project: { name },
        title: "First",
      },
      {
        externalRef: `PJ-${crypto.randomUUID().slice(0, 8)}`,
        project: { name },
        title: "Second",
      },
    ])

    const r1 = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(r1.report.createdTasks).toBe(2)
    expect(r1.report.createdProjects).toBe(1)
    expect(await countProjectsByName(orgId, name)).toBe(1)

    // Re-run: tasks skipped, project untouched.
    const r2 = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(r2.exitCode).toBe(0)
    expect(r2.report.createdTasks).toBe(0)
    expect(r2.report.createdProjects).toBe(0)
    expect(r2.report.skipped).toBe(2)
    expect(await countProjectsByName(orgId, name)).toBe(1)
  })

  test("externalRef re-import → skipped, task count stays 1", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([{ externalRef: extRef, project: { name: "Dedup" }, title: "Once" }])

    const r1 = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(r1.report.createdTasks).toBe(1)
    const r2 = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(r2.report.createdTasks).toBe(0)
    expect(r2.report.skipped).toBe(1)
    expect((await taskByExternalRef(orgId, extRef)).length).toBe(1)
  })

  test("status ensure: unknown label created once via addStatus; case-insensitive reuse; terminal flag", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const name = "Commercialisation"
    const ref1 = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const ref2 = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const ref3 = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const ref4 = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      // Custom status — must be CREATED (non-terminal by default).
      { externalRef: ref1, project: { name }, title: "A", status: "Ready for Launch" },
      // Same custom status again — must be REUSED, not re-created.
      { externalRef: ref2, project: { name }, title: "B", status: "Ready for Launch" },
      // Existing default label, different case — reused case-insensitively.
      { externalRef: ref3, project: { name }, title: "C", status: "In_Progress" },
      // Custom TERMINAL status.
      {
        externalRef: ref4,
        project: { name },
        title: "D",
        status: "Launched-Archived",
        statusTerminal: true,
      },
    ])

    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.createdTasks).toBe(4)
    expect(report.createdStatuses).toBe(2) // Ready for Launch + Launched-Archived, each once

    const labels = await statusLabels(orgId, name)
    expect(labels.filter((l) => l === "Ready for Launch").length).toBe(1)
    expect(labels.filter((l) => l === "Launched-Archived").length).toBe(1)

    const t1 = (await taskByExternalRef(orgId, ref1))[0]!
    expect(t1.status_label).toBe("Ready for Launch")
    expect(t1.status_terminal).toBe(false)
    const t3 = (await taskByExternalRef(orgId, ref3))[0]!
    expect(t3.status_label).toBe("in_progress")
    const t4 = (await taskByExternalRef(orgId, ref4))[0]!
    expect(t4.status_label).toBe("Launched-Archived")
    expect(t4.status_terminal).toBe(true)
  })

  test("createdAt backdating: created_at == historical; updated_at NOT backdated", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const historical = "2024-02-03T10:20:30.000Z"
    const before = Date.now()
    const file = writeNdjson([
      { externalRef: extRef, project: { name: "Backdate" }, title: "Old", createdAt: historical },
    ])

    const { report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.createdTasks).toBe(1)
    const after = Date.now()

    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(new Date(task.created_at).getTime()).toBe(new Date(historical).getTime())
    // updated_at deliberately NOT backdated.
    const updatedAt = new Date(task.updated_at).getTime()
    expect(updatedAt).toBeGreaterThanOrEqual(before - 60_000)
    expect(updatedAt).toBeLessThanOrEqual(after + 60_000)
  })

  test("invalid createdAt → record fails loudly, nothing written", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      { externalRef: extRef, project: { name: "BadDate" }, title: "X", createdAt: "not-a-date" },
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(1)
    expect(report.failed.length).toBe(1)
    expect((await taskByExternalRef(orgId, extRef)).length).toBe(0)
  })

  test("subtask: parentExternalRef earlier in the file resolves; cross-run parents resolve too", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const parentRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const childRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      { externalRef: parentRef, project: { name: "Tree" }, title: "Parent" },
      {
        externalRef: childRef,
        project: { name: "Tree" },
        title: "Child",
        parentExternalRef: parentRef,
      },
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.createdTasks).toBe(2)

    const parent = (await taskByExternalRef(orgId, parentRef))[0]!
    const child = (await taskByExternalRef(orgId, childRef))[0]!
    expect(child.parent_task_id).toBe(parent.id)

    // A later run can attach further children to an ALREADY-imported parent.
    const child2Ref = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file2 = writeNdjson([
      {
        externalRef: child2Ref,
        project: { name: "Tree" },
        title: "Child 2",
        parentExternalRef: parentRef,
      },
    ])
    const r2 = await runProjectsImport({ file: file2, orgSlug: slug, dryRun: false })
    expect(r2.exitCode).toBe(0)
    const child2 = (await taskByExternalRef(orgId, child2Ref))[0]!
    expect(child2.parent_task_id).toBe(parent.id)
  })

  test("missing parentExternalRef → record fails loudly, other records continue", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const orphanRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const okRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        externalRef: orphanRef,
        project: { name: "Orphans" },
        title: "Orphan",
        parentExternalRef: `PJ-missing-${crypto.randomUUID().slice(0, 8)}`,
      },
      { externalRef: okRef, project: { name: "Orphans" }, title: "Fine" },
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(1)
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.error).toContain("parentExternalRef")
    expect(report.createdTasks).toBe(1)
    expect((await taskByExternalRef(orgId, orphanRef)).length).toBe(0)
    expect((await taskByExternalRef(orgId, okRef)).length).toBe(1)
  })

  test("assigneeEmail: active user resolves; unknown → unassigned + loud report line", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const agentEmail = `agent-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await ensureUser({
      orgId,
      email: agentEmail,
      name: "Agent Smith",
      password: "pw-import-1!",
      role: "admin",
    })

    const knownRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const ghostRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        externalRef: knownRef,
        project: { name: "Assign" },
        title: "Known",
        assigneeEmail: agentEmail,
      },
      {
        externalRef: ghostRef,
        project: { name: "Assign" },
        title: "Ghost",
        assigneeEmail: "ghost@nowhere.example",
      },
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    // Unresolved assignee is NOT a record failure — imports unassigned + loud line.
    expect(exitCode).toBe(0)
    expect(report.createdTasks).toBe(2)
    expect(report.assigneesUnresolved.length).toBe(1)
    expect(report.assigneesUnresolved[0]?.externalRef).toBe(ghostRef)
    expect(report.assigneesUnresolved[0]?.email).toBe("ghost@nowhere.example")

    const known = (await taskByExternalRef(orgId, knownRef))[0]!
    expect(known.assignee_id).not.toBeNull()
    const ghost = (await taskByExternalRef(orgId, ghostRef))[0]!
    expect(ghost.assignee_id).toBeNull()
  })

  test("metadata fields land: priority, dueDate, startDate, blocked", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Fields" },
        title: "Full",
        priority: "urgent",
        dueDate: "2026-09-30",
        startDate: "2026-09-01",
        blocked: true,
      },
    ])
    const { report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.createdTasks).toBe(1)
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.priority).toBe("urgent")
    expect(String(task.due_date)).toContain("2026-09-30")
    expect(String(task.start_date)).toContain("2026-09-01")
    expect(task.blocked).toBe(true)
  })

  test("comments[] fold into the description block, attributed and dated", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "Discussed",
        description: "Body text.",
        comments: [
          {
            authorName: "Jane Doe",
            createdAt: "2025-05-01T08:00:00.000Z",
            body: "First remark.",
          },
          { body: "Anonymous afterthought." },
        ],
      },
    ])
    const { report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.createdTasks).toBe(1)
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    const desc = task.description ?? ""
    expect(desc).toContain("Body text.")
    expect(desc).toContain("Imported comments")
    expect(desc).toContain("Jane Doe")
    expect(desc).toContain("2025-05-01")
    expect(desc).toContain("First remark.")
    expect(desc).toContain("Anonymous afterthought.")
    // Comments come AFTER the original body.
    expect(desc.indexOf("Body text.")).toBeLessThan(desc.indexOf("Imported comments"))
  })

  test("--dry-run validates (incl. unknown parent) and writes nothing", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const orphanRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const projName = `Dry-${crypto.randomUUID().slice(0, 6)}`
    const file = writeNdjson([
      { externalRef: extRef, project: { name: projName }, title: "Would create" },
      {
        externalRef: orphanRef,
        project: { name: projName },
        title: "Orphan",
        parentExternalRef: `PJ-nope-${crypto.randomUUID().slice(0, 6)}`,
      },
      {
        // In-file parent ordering: parent earlier in THIS file is valid in dry-run.
        externalRef: `PJ-${crypto.randomUUID().slice(0, 8)}`,
        project: { name: projName },
        title: "Child of first",
        parentExternalRef: extRef,
      },
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: true })
    expect(exitCode).toBe(1) // the orphan is reported
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.error).toContain("parentExternalRef")
    expect(report.createdTasks).toBe(0)
    // Nothing written — not even the project.
    expect(await countProjectsByName(orgId, projName)).toBe(0)
    expect((await taskByExternalRef(orgId, extRef)).length).toBe(0)
  })

  test("malformed line → failed[] with line number, stream continues", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const goodRef = `PJ-${crypto.randomUUID().slice(0, 8)}`
    const file = writeRaw([
      "{ not json",
      JSON.stringify({ externalRef: goodRef, project: { name: "Robust" }, title: "OK" }),
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(report.failed.length).toBe(1)
    expect(report.failed[0]?.line).toBe(1)
    expect(report.createdTasks).toBe(1)
    expect(exitCode).toBe(1)
    expect((await taskByExternalRef(orgId, goodRef)).length).toBe(1)
  })

  test("unknown orgSlug → clean exit-2", async () => {
    const file = writeNdjson([{ externalRef: "x", project: { name: "x" }, title: "x" }])
    const { exitCode } = await runProjectsImport({
      file,
      orgSlug: `does-not-exist-${crypto.randomUUID()}`,
      dryRun: false,
    })
    expect(exitCode).toBe(2)
  })
})

describe("projects import — people resolution + --placeholder-unknown-users", () => {
  const ref = () => `PJ-${crypto.randomUUID().slice(0, 8)}`
  const email = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`

  test("reporterEmail of an active user → tasks.created_by is that user", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const reporterEmail = email("reporter")
    const reporterId = await addUser(orgId, reporterEmail, "Rita Reporter")
    const extRef = ref()
    const file = writeNdjson([
      // Upper-case in the file: matching is case-insensitive.
      {
        externalRef: extRef,
        project: { name: "People" },
        title: "T",
        reporterEmail: reporterEmail.toUpperCase(),
      },
    ])
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.reportersUnresolved).toEqual([])
    expect((await taskByExternalRef(orgId, extRef))[0]!.created_by).toBe(reporterId)
  })

  test("unknown reporter without the flag → actor is the creator + loud reportersUnresolved line", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "People" },
        title: "T",
        reporterEmail: "ghost@nowhere.example",
      },
    ])
    const usersBefore = (await orgUsers(orgId)).length
    const { exitCode, report } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    expect(report.reportersUnresolved).toEqual([
      { line: 1, externalRef: extRef, email: "ghost@nowhere.example" },
    ])
    expect(report.placeholdersCreated).toEqual([])
    expect((await taskByExternalRef(orgId, extRef))[0]!.created_by).toBe(await firstUserId(orgId))
    expect((await orgUsers(orgId)).length).toBe(usersBefore)
  })

  test("flag on: one person as reporter + assignee across records → ONE deactivated placeholder", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const ref1 = ref()
    const ref2 = ref()
    const file = writeNdjson([
      {
        externalRef: ref1,
        project: { name: "People" },
        title: "A",
        reporterEmail: "Former.Dev@Contoso.example",
        reporterName: "Former Dev",
        assigneeEmail: "former.dev@contoso.example",
      },
      {
        externalRef: ref2,
        project: { name: "People" },
        title: "B",
        assigneeEmail: "FORMER.DEV@contoso.example",
        assigneeName: "Former Dev",
      },
    ])
    const usersBefore = (await orgUsers(orgId)).length
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
    })
    expect(exitCode).toBe(0)
    expect(report.placeholdersCreated).toEqual([{ email: "former.dev@contoso.example" }])
    expect(report.reportersUnresolved).toEqual([])
    expect(report.assigneesUnresolved).toEqual([])

    const users = await orgUsers(orgId)
    expect(users.length).toBe(usersBefore + 1)
    const placeholder = users.find((u) => u.email === "former.dev@contoso.example")!
    // The login gate: a deactivated account cannot authenticate.
    expect(placeholder.status).toBe("deactivated")
    expect(placeholder.name).toBe("Former Dev")

    const a = (await taskByExternalRef(orgId, ref1))[0]!
    const b = (await taskByExternalRef(orgId, ref2))[0]!
    expect(a.created_by).toBe(placeholder.id)
    expect(a.assignee_id).toBe(placeholder.id)
    expect(b.assignee_id).toBe(placeholder.id)
    expect(b.created_by).toBe(await firstUserId(orgId))

    // Re-run: every record skipped, no user added.
    const r2 = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
    })
    expect(r2.report.createdTasks).toBe(0)
    expect(r2.report.skipped).toBe(2)
    expect(r2.report.placeholdersCreated).toEqual([])
    expect((await orgUsers(orgId)).length).toBe(usersBefore + 1)
  })

  test("flag on: an existing user differing only by case, or a deactivated one, is reused", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const activeEmail = email("active")
    const activeId = await addUser(orgId, activeEmail, "Ada Active")
    const leftEmail = email("left")
    const leftId = await addUser(orgId, leftEmail, "Lee Left", "deactivated")
    const ref1 = ref()
    const ref2 = ref()
    const file = writeNdjson([
      {
        externalRef: ref1,
        project: { name: "People" },
        title: "A",
        reporterEmail: activeEmail.toUpperCase(),
      },
      {
        externalRef: ref2,
        project: { name: "People" },
        title: "B",
        reporterEmail: leftEmail,
        assigneeEmail: leftEmail,
      },
    ])
    const usersBefore = (await orgUsers(orgId)).length
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
    })
    expect(exitCode).toBe(0)
    expect(report.placeholdersCreated).toEqual([])
    expect((await orgUsers(orgId)).length).toBe(usersBefore)
    expect((await taskByExternalRef(orgId, ref1))[0]!.created_by).toBe(activeId)
    const b = (await taskByExternalRef(orgId, ref2))[0]!
    expect(b.created_by).toBe(leftId)
    expect(b.assignee_id).toBe(leftId)
  })

  test("completedAt on a terminal status lands as completed_at; non-terminal ignores it", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const doneRef = ref()
    const openRef = ref()
    const resolvedAt = "2025-06-07T08:09:10.000Z"
    const file = writeNdjson([
      {
        externalRef: doneRef,
        project: { name: "Dates" },
        title: "Done",
        status: "done",
        completedAt: resolvedAt,
      },
      {
        externalRef: openRef,
        project: { name: "Dates" },
        title: "Open",
        status: "todo",
        completedAt: resolvedAt,
      },
    ])
    const { exitCode } = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(exitCode).toBe(0)
    const done = (await taskByExternalRef(orgId, doneRef))[0]!
    expect(new Date(done.completed_at!).getTime()).toBe(new Date(resolvedAt).getTime())
    expect((await taskByExternalRef(orgId, openRef))[0]!.completed_at).toBeNull()
  })

  test("invalid completedAt fails the record (real run) and the line (dry-run); nothing written", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "BadDone" },
        title: "X",
        status: "done",
        completedAt: "soon",
      },
    ])
    const dry = await runProjectsImport({ file, orgSlug: slug, dryRun: true })
    expect(dry.exitCode).toBe(1)
    expect(dry.report.failed).toEqual([
      { line: 1, error: 'completedAt is not a valid ISO-8601 timestamp: "soon"' },
    ])
    const real = await runProjectsImport({ file, orgSlug: slug, dryRun: false })
    expect(real.exitCode).toBe(1)
    expect(real.report.failed[0]?.error).toContain("invalid_completed_at")
    expect((await taskByExternalRef(orgId, extRef)).length).toBe(0)
    expect(await countProjectsByName(orgId, "BadDone")).toBe(0)
  })

  test("dry-run with the flag creates no user", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const file = writeNdjson([
      {
        externalRef: ref(),
        project: { name: "DryPeople" },
        title: "X",
        reporterEmail: "nobody@contoso.example",
        assigneeEmail: "nobody2@contoso.example",
        comments: [{ authorEmail: "nobody3@contoso.example", body: "hi" }],
      },
    ])
    const usersBefore = (await orgUsers(orgId)).length
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: true,
      placeholderUnknownUsers: true,
    })
    expect(exitCode).toBe(0)
    expect(report.placeholdersCreated).toEqual([])
    expect((await orgUsers(orgId)).length).toBe(usersBefore)
    expect(await countProjectsByName(orgId, "DryPeople")).toBe(0)
  })
})

interface MessageRow {
  id: string
  author_id: string
  content: string
  created_at: string | Date
  metadata: { import?: { source?: string; externalRef?: string; commentIndex?: number } } | null
  required_scopes: string[]
}

async function threadMessages(orgId: string, threadId: string): Promise<MessageRow[]> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, author_id, content, created_at, metadata, required_scopes
      FROM ${kernelRel("messages")}
      WHERE org_id = ${orgId}::uuid AND thread_id = ${threadId}::uuid
      ORDER BY created_at ASC, id ASC
    `),
  )
  return extractRows<MessageRow>(rows)
}

async function countOrgMessages(orgId: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${kernelRel("messages")} WHERE org_id = ${orgId}::uuid
    `),
  )
  return extractRows<{ n: number }>(rows)[0]!.n
}

/** message:* events in the outbox for the org (the live fan-out's entry point). */
async function countMessageEvents(orgId: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${kernelRel("pending_events")}
      WHERE org_id = ${orgId}::uuid
        AND payload->>'app' = 'kernel' AND payload->>'entity' = 'message'
    `),
  )
  return extractRows<{ n: number }>(rows)[0]!.n
}

async function threadPeople(
  orgId: string,
  threadId: string,
): Promise<{ participants: string[]; readState: Map<string, string | null> }> {
  const p = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT user_id FROM ${kernelRel("thread_participants")} WHERE thread_id = ${threadId}::uuid
    `),
  )
  const r = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT user_id, last_read_message_id FROM ${kernelRel("user_thread_state")}
      WHERE thread_id = ${threadId}::uuid
    `),
  )
  return {
    participants: extractRows<{ user_id: string }>(p).map((x) => x.user_id),
    readState: new Map(
      extractRows<{ user_id: string; last_read_message_id: string | null }>(r).map((x) => [
        x.user_id,
        x.last_read_message_id,
      ]),
    ),
  }
}

describe("projects import — real backdated comments", () => {
  const ref = () => `PJ-${crypto.randomUUID().slice(0, 8)}`
  const noIndex = async () => []

  test("a resolvable author's comment is a backdated thread message, not folded", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const authorEmail = `dev-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const authorId = await addUser(orgId, authorEmail, "Dana Dev")
    const extRef = ref()
    const body = "Deployed to staging.\n\n- step one\n- step two"
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "Real comment",
        comments: [
          { authorName: "Dana Dev", authorEmail, createdAt: "2025-01-02T03:04:05.000Z", body },
        ],
      },
    ])
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    expect(report.commentsImported).toBe(1)
    expect(report.commentsFolded).toBe(0)

    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.description ?? "").not.toContain("Imported comments")
    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.length).toBe(1)
    expect(msgs[0]!.author_id).toBe(authorId)
    expect(msgs[0]!.content).toBe(body)
    expect(new Date(msgs[0]!.created_at).getTime()).toBe(
      new Date("2025-01-02T03:04:05.000Z").getTime(),
    )
    expect(msgs[0]!.metadata?.import).toEqual({
      source: "projects-import",
      externalRef: extRef,
      commentIndex: 0,
    })
    expect(msgs[0]!.required_scopes).toEqual([])
  })

  test("mixed authors: unresolved fold in order, resolved become messages keeping their dates", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const devEmail = `dev-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await addUser(orgId, devEmail, "Dana Dev")
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "Mixed",
        description: "Body.",
        comments: [
          { authorName: "Gitlab", createdAt: "2025-01-01T00:00:00.000Z", body: "BOT-A merged" },
          { authorEmail: devEmail, createdAt: "2025-01-03T00:00:00.000Z", body: "HUMAN-B later" },
          {
            authorName: "Outsider",
            authorEmail: "outsider@contoso.example",
            createdAt: "2025-01-04T00:00:00.000Z",
            body: "GUEST-C remark",
          },
          { authorEmail: devEmail, createdAt: "2025-01-02T00:00:00.000Z", body: "HUMAN-D earlier" },
        ],
      },
    ])
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    expect(report.commentsImported).toBe(2)
    expect(report.commentsFolded).toBe(2)

    const task = (await taskByExternalRef(orgId, extRef))[0]!
    const desc = task.description ?? ""
    expect(desc).toContain("BOT-A merged")
    expect(desc).toContain("GUEST-C remark")
    expect(desc.indexOf("BOT-A merged")).toBeLessThan(desc.indexOf("GUEST-C remark"))
    expect(desc).not.toContain("HUMAN-B later")
    expect(desc).not.toContain("HUMAN-D earlier")

    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.map((m) => m.content)).toEqual(["HUMAN-D earlier", "HUMAN-B later"])
    expect(msgs.map((m) => m.metadata?.import?.commentIndex)).toEqual([3, 1])
  })

  test("no message event is queued; the record's people are participants read up to the newest, the import actor is not", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const actorId = await firstUserId(orgId)
    const reporterEmail = `rep-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const reporterId = await addUser(orgId, reporterEmail, "Rita Reporter")
    const assigneeEmail = `asg-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const assigneeId = await addUser(orgId, assigneeEmail, "Andy Assignee")
    const authorEmail = `aut-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const authorId = await addUser(orgId, authorEmail, "Alex Author")
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "People",
        reporterEmail,
        assigneeEmail,
        createdAt: "2024-12-01T00:00:00.000Z",
        comments: [
          { authorEmail, createdAt: "2025-02-02T00:00:00.000Z", body: "newest" },
          { authorEmail: reporterEmail, createdAt: "2025-02-01T00:00:00.000Z", body: "older" },
          // No createdAt → anchored to the record's createdAt (oldest).
          { authorEmail: assigneeEmail, body: "undated" },
        ],
      },
    ])
    const eventsBefore = await countMessageEvents(orgId)
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    expect(report.commentsImported).toBe(3)
    expect(await countMessageEvents(orgId)).toBe(eventsBefore)

    const task = (await taskByExternalRef(orgId, extRef))[0]!
    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.map((m) => m.content)).toEqual(["undated", "older", "newest"])
    // Anchor + the comment's input index (2) in ms, so undated comments keep input order.
    expect(new Date(msgs[0]!.created_at).getTime()).toBe(
      new Date("2024-12-01T00:00:00.000Z").getTime() + 2,
    )
    const newest = msgs[2]!.id
    const { participants, readState } = await threadPeople(orgId, task.thread_id)
    for (const id of [reporterId, assigneeId, authorId]) {
      expect(participants).toContain(id)
      expect(readState.get(id)).toBe(newest)
    }
    // The reporter is the task's creator, so the import actor took no part in
    // this history: a seat would send it a reply attention row (and digest
    // mail) for every later comment on every imported task.
    expect(participants).not.toContain(actorId)
    expect(readState.has(actorId)).toBe(false)

    // Re-run: skipped whole, no message inserted twice.
    const before = await countOrgMessages(orgId)
    const r2 = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: noIndex,
    })
    expect(r2.report.skipped).toBe(1)
    expect(r2.report.commentsImported).toBe(0)
    expect(await countOrgMessages(orgId)).toBe(before)
  })

  test("unparsable comment createdAt fails the record: no task, message or placeholder left", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "BadComment" },
        title: "X",
        reporterEmail: "new.person@contoso.example",
        comments: [
          {
            authorEmail: "new.person@contoso.example",
            createdAt: "2025-01-01T00:00:00Z",
            body: "ok",
          },
          { authorEmail: "new.person@contoso.example", createdAt: "yesterday", body: "bad" },
        ],
      },
    ])
    const usersBefore = (await orgUsers(orgId)).length
    const messagesBefore = await countOrgMessages(orgId)

    const dry = await runProjectsImport({ file, orgSlug: slug, dryRun: true })
    expect(dry.exitCode).toBe(1)
    expect(dry.report.failed).toEqual([
      { line: 1, error: 'comments[1].createdAt is not a valid ISO-8601 timestamp: "yesterday"' },
    ])

    const real = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(real.exitCode).toBe(1)
    expect(real.report.failed[0]?.error).toContain("comments[1].createdAt")
    expect(real.report.placeholdersCreated).toEqual([])
    expect((await taskByExternalRef(orgId, extRef)).length).toBe(0)
    expect(await countOrgMessages(orgId)).toBe(messagesBefore)
    expect((await orgUsers(orgId)).length).toBe(usersBefore)
  })

  test("indexing runs once after the run, in bulk, on exactly the inserted messages; a failure is reported, not fatal", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const authorEmail = `dev-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await addUser(orgId, authorEmail, "Dana Dev")
    const okRef = ref()
    const failRef = ref()
    const file = writeNdjson([
      {
        externalRef: okRef,
        project: { name: "Index" },
        title: "Indexed",
        comments: [
          { authorEmail, createdAt: "2025-01-01T00:00:00Z", body: "one" },
          { authorName: "Gitlab", body: "folded, never indexed" },
        ],
      },
    ])
    // Recorder: the rows must already be committed (visible to a fresh connection).
    const seen: Array<{ messageId: string; visible: boolean }> = []
    let calls = 0
    const r1 = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: async (org, ids) => {
        calls++
        expect(org).toBe(orgId)
        for (const id of ids) {
          const rows = await withPrivilegedDb(orgId, "t", (tx) =>
            tx.execute(drizzleSql`
              SELECT id FROM ${kernelRel("messages")} WHERE id = ${id}::uuid
            `),
          )
          seen.push({ messageId: id, visible: extractRows(rows).length === 1 })
        }
        return []
      },
    })
    expect(r1.exitCode).toBe(0)
    expect(calls).toBe(1)
    const okTask = (await taskByExternalRef(orgId, okRef))[0]!
    const okMsgs = await threadMessages(orgId, okTask.thread_id)
    expect(seen).toEqual(okMsgs.map((m) => ({ messageId: m.id, visible: true })))
    expect(r1.report.indexFailures).toEqual([])

    const file2 = writeNdjson([
      {
        externalRef: failRef,
        project: { name: "Index" },
        title: "Search down",
        comments: [
          { authorEmail, createdAt: "2025-01-01T00:00:00Z", body: "a" },
          { authorEmail, createdAt: "2025-01-02T00:00:00Z", body: "b" },
        ],
      },
    ])
    const r2 = await runProjectsImport({
      file: file2,
      orgSlug: slug,
      dryRun: false,
      indexMessages: async () => {
        throw new Error("meili unreachable")
      },
    })
    expect(r2.exitCode).toBe(0)
    expect(r2.report.createdTasks).toBe(1)
    expect(r2.report.commentsImported).toBe(2)
    const failTask = (await taskByExternalRef(orgId, failRef))[0]!
    const failMsgs = await threadMessages(orgId, failTask.thread_id)
    expect(failMsgs.length).toBe(2)
    expect(r2.report.indexFailures).toEqual(
      failMsgs.map((m) => ({ externalRef: failRef, messageId: m.id, error: "meili unreachable" })),
    )
  })

  test("the messages of every record go to ONE bulk index call; a per-message failure names its record", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const authorEmail = `dev-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await addUser(orgId, authorEmail, "Dana Dev")
    const refA = ref()
    const refB = ref()
    const file = writeNdjson([
      {
        externalRef: refA,
        project: { name: "Bulk" },
        title: "A",
        comments: [{ authorEmail, createdAt: "2025-01-01T00:00:00Z", body: "a1" }],
      },
      {
        externalRef: refB,
        project: { name: "Bulk" },
        title: "B",
        comments: [
          { authorEmail, createdAt: "2025-01-02T00:00:00Z", body: "b1" },
          { authorEmail, createdAt: "2025-01-03T00:00:00Z", body: "b2" },
        ],
      },
    ])
    const batches: string[][] = []
    const r = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: async (_org, ids) => {
        batches.push([...ids])
        return [{ messageId: ids[2]!, error: "search task 7 failed: bad document" }]
      },
    })
    expect(r.exitCode).toBe(0)
    const aMsgs = await threadMessages(orgId, (await taskByExternalRef(orgId, refA))[0]!.thread_id)
    const bMsgs = await threadMessages(orgId, (await taskByExternalRef(orgId, refB))[0]!.thread_id)
    expect(batches).toEqual([[...aMsgs, ...bMsgs].map((m) => m.id)])
    expect(r.report.indexFailures).toEqual([
      { externalRef: refB, messageId: bMsgs[1]!.id, error: "search task 7 failed: bad document" },
    ])
  })

  test("two undated comments keep input order (anchor + index ms, no created_at tie)", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const devEmail = `dev-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    await addUser(orgId, devEmail, "Dana Dev")
    const extRef = ref()
    const anchor = "2024-06-01T00:00:00.000Z"
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "Undated pair",
        createdAt: anchor,
        comments: [
          { authorEmail: devEmail, body: "FIRST undated" },
          { authorEmail: devEmail, body: "SECOND undated" },
        ],
      },
    ])
    const { exitCode } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.map((m) => m.content)).toEqual(["FIRST undated", "SECOND undated"])
    const times = msgs.map((m) => new Date(m.created_at).getTime())
    expect(times).toEqual([Date.parse(anchor), Date.parse(anchor) + 1])
    const { readState } = await threadPeople(orgId, task.thread_id)
    expect(readState.get(await firstUserId(orgId))).toBe(msgs[1]!.id)
  })

  test("assignee-only record: assignee and actor get participant + read-state rows", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const actorId = await firstUserId(orgId)
    const assigneeEmail = `asg-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const assigneeId = await addUser(orgId, assigneeEmail, "Andy Assignee")
    const extRef = ref()
    const file = writeNdjson([
      { externalRef: extRef, project: { name: "Comments" }, title: "Only assigned", assigneeEmail },
    ])
    const { exitCode } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.assignee_id).toBe(assigneeId)
    const { participants, readState } = await threadPeople(orgId, task.thread_id)
    for (const id of [actorId, assigneeId]) {
      expect(participants).toContain(id)
      expect(readState.has(id)).toBe(true)
      // No message was imported, so nothing to have read.
      expect(readState.get(id)).toBeNull()
    }
  })

  test("flag on: placeholders/deactivated people are authors only, never participants; a live reply does not target them", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const actorId = await firstUserId(orgId)
    const leaverEmail = `leaver-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const leaverId = await addUser(orgId, leaverEmail, "Lee Leaver", "deactivated")
    const liveEmail = `live-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const liveId = await addUser(orgId, liveEmail, "Liv Live")
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "Ghosts",
        reporterEmail: "ghost-reporter@contoso.example",
        assigneeEmail: leaverEmail,
        createdAt: "2025-01-01T00:00:00.000Z",
        comments: [
          {
            authorEmail: "ghost-author@contoso.example",
            authorName: "Ghost Author",
            createdAt: "2025-01-02T00:00:00.000Z",
            body: "ghost says",
          },
          { authorEmail: liveEmail, createdAt: "2025-01-03T00:00:00.000Z", body: "live says" },
        ],
      },
    ])
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    expect(report.placeholdersCreated.map((p) => p.email).sort()).toEqual([
      "ghost-author@contoso.example",
      "ghost-reporter@contoso.example",
    ])
    const users = await orgUsers(orgId)
    const ghostReporter = users.find((u) => u.email === "ghost-reporter@contoso.example")!
    const ghostAuthor = users.find((u) => u.email === "ghost-author@contoso.example")!
    const inactive = [ghostReporter.id, ghostAuthor.id, leaverId]

    // Authorship stays exact.
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.created_by).toBe(ghostReporter.id)
    expect(task.assignee_id).toBe(leaverId)
    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.map((m) => m.author_id)).toEqual([ghostAuthor.id, liveId])
    const thread = extractRows<{ created_by: string }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT created_by FROM ${kernelRel("threads")} WHERE id = ${task.thread_id}::uuid
        `),
      ),
    )[0]!
    expect(thread.created_by).toBe(ghostReporter.id)

    // But no inactive account is a participant or has read state.
    const { participants, readState } = await threadPeople(orgId, task.thread_id)
    for (const id of inactive) {
      expect(participants).not.toContain(id)
      expect(readState.has(id)).toBe(false)
    }
    expect(participants).toContain(liveId)
    expect(readState.get(liveId)).toBe(msgs[1]!.id)
    // A placeholder reporter is still the creator: the actor holds no seat.
    expect(participants).not.toContain(actorId)
    expect(readState.has(actorId)).toBe(false)

    // A live reply by the seated colleague: the queued message:create event's
    // participantIds (what the thread_reply attention translation fans out
    // to) must not name any inactive account.
    const sent = await withPrivilegedDb(orgId, "t", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: liveId,
        threadId: task.thread_id,
        content: "live reply after import",
        authorType: "user",
      }),
    )
    if (!sent) throw new Error("the live colleague could not post into the imported thread")
    const events = extractRows<{ participant_ids: string[] }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(drizzleSql`
          SELECT payload->'data'->'participantIds' AS participant_ids
          FROM ${kernelRel("pending_events")}
          WHERE org_id = ${orgId}::uuid
            AND payload->>'app' = 'kernel' AND payload->>'entity' = 'message'
            AND payload->'data'->>'id' = ${sent.id}
        `),
      ),
    )
    expect(events.length).toBe(1)
    const targeted = events[0]!.participant_ids
    expect(targeted).toContain(liveId)
    for (const id of inactive) expect(targeted).not.toContain(id)
  })

  test("flag on: an unknown comment author shares the reporter's placeholder", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "Comments" },
        title: "Placeholder author",
        reporterEmail: "gone@contoso.example",
        assigneeEmail: "Gone@Contoso.example",
        comments: [{ authorEmail: "GONE@contoso.example", body: "I wrote this" }],
      },
    ])
    const usersBefore = (await orgUsers(orgId)).length
    const { exitCode, report } = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(exitCode).toBe(0)
    expect(report.placeholdersCreated).toEqual([{ email: "gone@contoso.example" }])
    expect((await orgUsers(orgId)).length).toBe(usersBefore + 1)
    const placeholder = (await orgUsers(orgId)).find((u) => u.email === "gone@contoso.example")!
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.created_by).toBe(placeholder.id)
    expect(task.assignee_id).toBe(placeholder.id)
    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.map((m) => m.author_id)).toEqual([placeholder.id])
  })
})

describe("projects import — end to end on the Jira export shape", () => {
  test("done / backlog / cancelled records: people, dates, comments, report; re-run is a no-op", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const actorId = await firstUserId(orgId)
    const tag = crypto.randomUUID().slice(0, 6)
    const leadEmail = `lead-${tag}@fabrikam.example`
    const leadId = await addUser(orgId, leadEmail, "Lena Lead")
    const devEmail = `dev-${tag}@fabrikam.example`
    const devId = await addUser(orgId, devEmail, "Dario Dev")
    const refs = [`WEB-${tag}-1`, `API-${tag}-2`, `OPS-${tag}-3`]
    // Field set of a Jira-to-canonical transform's output.
    const file = writeNdjson([
      {
        externalRef: refs[0],
        project: { name: "Web App" },
        title: "Fix the cookie banner",
        description: "Banner buttons are invisible on light themes.",
        status: "done",
        priority: "high",
        dueDate: null,
        blocked: false,
        createdAt: "2025-04-01T09:00:00.000+0200",
        completedAt: "2025-04-10T17:30:00.000+0200",
        reporterEmail: leadEmail,
        reporterName: "Lena Lead",
        assigneeEmail: devEmail,
        assigneeName: "Dario Dev",
        comments: [
          {
            authorEmail: devEmail,
            authorName: "Dario Dev",
            createdAt: "2025-04-02T10:00:00.000+0200",
            body: "Reproduced on the staging environment.",
          },
          {
            authorEmail: null,
            authorName: "Gitlab",
            createdAt: "2025-04-09T12:00:00.000+0200",
            body: "MR !42 merged into develop.",
          },
          {
            authorEmail: leadEmail,
            authorName: "Lena Lead",
            createdAt: "2025-04-10T17:00:00.000+0200",
            body: "Verified in production.",
          },
        ],
      },
      {
        externalRef: refs[1],
        project: { name: "Platform" },
        title: "Rotate the signing key",
        description: null,
        status: "backlog",
        priority: "normal",
        dueDate: "2026-12-31",
        blocked: false,
        createdAt: "2025-05-05T08:00:00.000+0000",
        completedAt: null,
        reporterEmail: leadEmail,
        reporterName: "Lena Lead",
        assigneeEmail: `former.contractor-${tag}@contoso.example`,
        assigneeName: "Former Contractor",
        comments: [],
      },
      {
        externalRef: refs[2],
        project: { name: "Platform" },
        title: "Drop the legacy export",
        description: "No longer needed.",
        status: "cancelled",
        priority: "low",
        dueDate: null,
        blocked: false,
        createdAt: "2025-03-03T08:00:00.000+0000",
        completedAt: "2025-03-20T08:00:00.000+0000",
        reporterEmail: `former.contractor-${tag}@contoso.example`,
        reporterName: "Former Contractor",
        assigneeEmail: null,
        assigneeName: null,
        comments: [],
      },
    ])

    const indexed: string[] = []
    const run = () =>
      runProjectsImport({
        file,
        orgSlug: slug,
        dryRun: false,
        placeholderUnknownUsers: true,
        indexMessages: async (_org, ids) => {
          indexed.push(...ids)
          return []
        },
      })

    const r1 = await run()
    expect(r1.exitCode).toBe(0)
    expect(r1.report).toEqual({
      createdProjects: 2,
      createdStatuses: 0,
      createdTasks: 3,
      skipped: 0,
      failed: [],
      assigneesUnresolved: [],
      reportersUnresolved: [],
      placeholdersCreated: [{ email: `former.contractor-${tag}@contoso.example` }],
      commentsImported: 2,
      commentsFolded: 1,
      indexFailures: [],
    })

    const users = await orgUsers(orgId)
    const contractor = users.find((u) => u.email === `former.contractor-${tag}@contoso.example`)!
    expect(contractor.status).toBe("deactivated")
    expect(contractor.name).toBe("Former Contractor")

    const done = (await taskByExternalRef(orgId, refs[0]!))[0]!
    expect(done.status_label).toBe("done")
    expect(done.project_name).toBe("Web App")
    expect(new Date(done.created_at).getTime()).toBe(Date.parse("2025-04-01T07:00:00.000Z"))
    expect(new Date(done.completed_at!).getTime()).toBe(Date.parse("2025-04-10T15:30:00.000Z"))
    expect(done.created_by).toBe(leadId)
    expect(done.assignee_id).toBe(devId)
    expect(done.description).toContain("Banner buttons are invisible")
    expect(done.description).toContain("## Imported comments")
    expect(done.description).toContain("**Gitlab**")
    expect(done.description).toContain("MR !42 merged into develop.")
    expect(done.description).not.toContain("Reproduced on the staging environment.")
    const doneMsgs = await threadMessages(orgId, done.thread_id)
    expect(doneMsgs.map((m) => [m.author_id, m.content])).toEqual([
      [devId, "Reproduced on the staging environment."],
      [leadId, "Verified in production."],
    ])
    expect(indexed).toEqual(doneMsgs.map((m) => m.id))
    const people = await threadPeople(orgId, done.thread_id)
    for (const id of [leadId, devId]) {
      expect(people.readState.get(id)).toBe(doneMsgs[1]!.id)
    }
    expect(people.participants).not.toContain(actorId)

    const backlog = (await taskByExternalRef(orgId, refs[1]!))[0]!
    expect(backlog.status_label).toBe("backlog")
    expect(backlog.completed_at).toBeNull()
    expect(backlog.created_by).toBe(leadId)
    expect(backlog.assignee_id).toBe(contractor.id)
    expect(String(backlog.due_date)).toContain("2026-12-31")
    expect(backlog.description).toBeNull()

    const cancelled = (await taskByExternalRef(orgId, refs[2]!))[0]!
    expect(cancelled.status_label).toBe("cancelled")
    expect(new Date(cancelled.completed_at!).getTime()).toBe(Date.parse("2025-03-20T08:00:00.000Z"))
    expect(cancelled.created_by).toBe(contractor.id)
    expect(cancelled.assignee_id).toBeNull()
    expect(cancelled.description).toBe("No longer needed.")

    // Re-run: everything skipped, nothing added anywhere.
    const usersBefore = (await orgUsers(orgId)).length
    const messagesBefore = await countOrgMessages(orgId)
    const r2 = await run()
    expect(r2.exitCode).toBe(0)
    expect(r2.report.skipped).toBe(3)
    expect(r2.report.createdTasks).toBe(0)
    expect(r2.report.commentsImported).toBe(0)
    expect(r2.report.placeholdersCreated).toEqual([])
    expect((await orgUsers(orgId)).length).toBe(usersBefore)
    expect(await countOrgMessages(orgId)).toBe(messagesBefore)
    expect(indexed.length).toBe(2)
  })
})

describe("projects import — people resolve to the real account, never a placeholder of them", () => {
  const ref = () => `PJ-${crypto.randomUUID().slice(0, 8)}`
  const noIndex = async () => []

  test("a real user and a same-name Slack placeholder coexist: every role goes to the real user", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const tag = crypto.randomUUID().slice(0, 8)
    const realEmail = `jane.doe-${tag}@fabrikam.example`
    const realId = await addUser(orgId, realEmail, "Jane Doe")
    const slackPlaceholder = await addUser(
      orgId,
      `slack-import+jane.doe-${tag}@import.invalid`,
      "Jane Doe",
      "deactivated",
    )
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "People" },
        title: "Owned by Jane",
        reporterEmail: realEmail.toUpperCase(),
        reporterName: "Jane Doe",
        assigneeEmail: realEmail,
        assigneeName: "Jane Doe",
        comments: [{ authorEmail: realEmail, authorName: "Jane Doe", body: "on it" }],
      },
    ])
    const r = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(r.exitCode).toBe(0)
    expect(r.report.placeholdersCreated).toEqual([])
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.assignee_id).toBe(realId)
    expect(task.created_by).toBe(realId)
    const msgs = await threadMessages(orgId, task.thread_id)
    expect(msgs.map((m) => m.author_id)).toEqual([realId])
    expect([task.assignee_id, task.created_by, ...msgs.map((m) => m.author_id)]).not.toContain(
      slackPlaceholder,
    )
  })

  test("a placeholder address in the source never resolves to the placeholder it names", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const tag = crypto.randomUUID().slice(0, 8)
    const placeholderEmail = `slack-import+ghost-${tag}@import.invalid`
    const slackPlaceholder = await addUser(orgId, placeholderEmail, "Ghost", "deactivated")
    const usersBefore = (await orgUsers(orgId)).length
    const extRef = ref()
    const file = writeNdjson([
      {
        externalRef: extRef,
        project: { name: "People" },
        title: "Ghost task",
        assigneeEmail: placeholderEmail,
        comments: [{ authorEmail: placeholderEmail, authorName: "Ghost", body: "boo" }],
      },
    ])
    const r = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(r.exitCode).toBe(0)
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.assignee_id).not.toBe(slackPlaceholder)
    expect(task.assignee_id).toBeNull()
    expect(r.report.commentsFolded).toBe(1)
    expect((await orgUsers(orgId)).length).toBe(usersBefore)
  })

  test("case variants of one address: the account that had a login wins over an older placeholder", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const tag = crypto.randomUUID().slice(0, 8)
    const lower = `sam-${tag}@fabrikam.example`
    // An earlier import's placeholder (older), then the real account under a
    // case variant of the same address, deactivated since (a leaver).
    const placeholder = await addUser(orgId, lower, "Sam", "deactivated")
    const realId = await addUser(orgId, `Sam-${tag}@Fabrikam.example`, "Sam Real", "deactivated")
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${kernelRel("users")} SET password_hash = 'x' WHERE id = ${realId}::uuid
      `),
    )
    const extRef = ref()
    const file = writeNdjson([
      { externalRef: extRef, project: { name: "People" }, title: "Sam", assigneeEmail: lower },
    ])
    const r = await runProjectsImport({
      file,
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(r.exitCode).toBe(0)
    const task = (await taskByExternalRef(orgId, extRef))[0]!
    expect(task.assignee_id).toBe(realId)
    expect(task.assignee_id).not.toBe(placeholder)
  })

  test("an unknown email becomes ONE placeholder, reused across records and a re-run", async () => {
    const orgId = await freshOrg()
    const slug = await orgSlug(orgId)
    const tag = crypto.randomUUID().slice(0, 8)
    const unknown = `former-${tag}@contoso.example`
    const refs = [ref(), ref(), ref()]
    const rec = (externalRef: string, i: number) => ({
      externalRef,
      project: { name: "People" },
      title: `T${i}`,
      assigneeEmail: i === 1 ? unknown.toUpperCase() : unknown,
      assigneeName: "Former Colleague",
      comments: [{ authorEmail: unknown, authorName: "Former Colleague", body: `c${i}` }],
    })
    const first = await runProjectsImport({
      file: writeNdjson([rec(refs[0]!, 0), rec(refs[1]!, 1)]),
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(first.report.placeholdersCreated).toEqual([{ email: unknown }])
    const second = await runProjectsImport({
      file: writeNdjson([rec(refs[2]!, 2)]),
      orgSlug: slug,
      dryRun: false,
      placeholderUnknownUsers: true,
      indexMessages: noIndex,
    })
    expect(second.report.placeholdersCreated).toEqual([])
    const matching = (await orgUsers(orgId)).filter((u) => u.email.toLowerCase() === unknown)
    expect(matching.length).toBe(1)
    const placeholderId = matching[0]!.id
    for (const r of refs) {
      const task = (await taskByExternalRef(orgId, r))[0]!
      expect(task.assignee_id).toBe(placeholderId)
      const msgs = await threadMessages(orgId, task.thread_id)
      expect(msgs.map((m) => m.author_id)).toEqual([placeholderId])
    }
  })
})
