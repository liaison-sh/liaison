// SPDX-License-Identifier: FSL-1.1-ALv2
// Projects import kinds beyond tasks and projects: `projects.template` (a task
// tree stored as a project template), a task's checklist, and task
// dependencies, linked at record time when the target exists and after the
// kind's last batch (afterKind) when it arrives later in the run.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { taskImportHandler } from "~/apps/projects/import-kind"
import { instantiateTemplate } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { liveActor } from "~/modules/imports/authority"
import { insertLedgerRows } from "~/modules/imports/ledger"
import { runImport } from "~/modules/imports/runner"
import { createImportRun } from "~/modules/imports/runs"
import { importServiceClient } from "~/modules/imports/service-client"
import type { SourceItem } from "~/modules/imports/source"
import type { HostImportContext } from "~/modules/imports/types"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { documentId } from "~/modules/search/document-id"
import { LiveIndexTestAccess, resolveLiveIndexItems } from "~/modules/search/live-index-queue"
import { messageSearchDocIds } from "~/modules/search/message-indexer"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
const tag = () => crypto.randomUUID().slice(0, 8)

function operator(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

function importTasks(records: Array<Record<string, unknown>>, label: string, batchSize = 200) {
  return runImport({
    orgId,
    actor: operator(),
    kinds: ["projects.task"],
    source: recordsOf(records),
    sourceLabel: label,
    mode: "cli",
    batchSize,
  })
}

async function taskId(label: string, ref: string): Promise<string> {
  const [row] = await sql`
    SELECT id FROM app_projects.tasks WHERE org_id = ${orgId} AND external_ref = ${`${label}:${ref}`}`
  return String(row!.id)
}

async function dependencies(ids: string[]) {
  return sql`
    SELECT task_id, depends_on_task_id, type FROM app_projects.task_dependencies
    WHERE org_id = ${orgId} AND task_id = ANY(${ids})
    ORDER BY task_id, depends_on_task_id`
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-proj-${tag()}`, name: "Projects Kinds Import" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
}, 120_000)
afterAll(releaseTestLock)

describe("projects.template", () => {
  const structure = [
    {
      title: "Plan",
      description: "Scope the release",
      children: [{ title: "Write brief" }, { title: "Review brief" }],
    },
    { title: "Ship" },
  ]

  it("stores the tree, instantiates it, skips an existing name and is undone", async () => {
    const name = `Launch ${tag()}`
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.template"],
      source: recordsOf([
        { name, structure },
        { name, structure: [{ title: "Other" }] },
      ]),
      sourceLabel: "tpl",
      mode: "cli",
    })
    expect(run.counts["projects.template"]).toEqual({ created: 1, skipped: 1, failed: 0 })
    const [tpl] = await sql`
      SELECT id, structure, created_by FROM app_projects.project_templates
      WHERE org_id = ${orgId} AND name = ${name}`
    expect(tpl!.structure).toEqual(structure)
    expect(tpl!.created_by).toBe(adminId)

    const projectName = `From template ${tag()}`
    const { projectId } = await withPrivilegedDb(
      orgId,
      "t",
      (tx) =>
        instantiateTemplate({
          tx: importServiceClient(tx),
          orgId,
          actor: operator(),
          templateId: String(tpl!.id),
          projectName,
        }),
      { actor: operator() },
    )
    const tasks = await sql`
      SELECT t.title, p.title AS parent FROM app_projects.tasks t
      LEFT JOIN app_projects.tasks p ON p.id = t.parent_task_id
      WHERE t.org_id = ${orgId} AND t.project_id = ${projectId} ORDER BY t.title`
    expect(tasks.map((t) => [t.title, t.parent])).toEqual([
      ["Plan", null],
      ["Review brief", "Plan"],
      ["Ship", null],
      ["Write brief", "Plan"],
    ])

    expect(await undoImportRun(orgId, run.runId, { userId: adminId })).toEqual({
      deleted: 1,
      refused: [],
    })
  })

  it("refuses a tree deeper than a task tree may be, or a node without a title", async () => {
    let deep: Record<string, unknown> = { title: "leaf" }
    for (let i = 0; i < 9; i++) deep = { title: `level ${i}`, children: [deep] }
    const run = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.template"],
      source: recordsOf([
        { name: `Deep ${tag()}`, structure: [deep] },
        { name: `Untitled ${tag()}`, structure: [{ title: "ok", children: [{ title: "" }] }] },
      ]),
      sourceLabel: "tpl",
      mode: "cli",
    })
    expect(run.counts["projects.template"]).toEqual({ created: 0, skipped: 0, failed: 2 })
    expect(String(run.errors[0]?.error)).toMatch(/template_too_deep/)
  })
})

describe("projects.task: undo and search", () => {
  it("undo takes the task and its imported comments out of search", async () => {
    const label = `sx${tag()}`
    const [me] = await sql`SELECT email FROM kernel.users WHERE id = ${adminId}`
    const run = await importTasks(
      [
        {
          externalRef: "S-1",
          project: { name: `Search ${label}` },
          title: "Searchable",
          comments: [{ authorEmail: String(me!.email), body: "Imported comment" }],
        },
      ],
      label,
    )
    expect(run.counts["projects.task"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const id = await taskId(label, "S-1")
    const [msg] = await sql`
      SELECT m.id, m.thread_id FROM kernel.messages m
      JOIN app_projects.tasks t ON t.thread_id = m.thread_id WHERE t.id = ${id}`
    await LiveIndexTestAccess.clear()
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toEqual([])
    const pending = await LiveIndexTestAccess.pendingItems()
    const taskDoc = documentId(orgId, "projects", "task", id)
    expect(pending.find((p) => p.key === taskDoc)?.payload.action).toBe("delete")
    const resolved = await resolveLiveIndexItems(pending)
    expect(resolved.deleteIds).toContain(taskDoc)
    expect(resolved.deleteIds).toContain(
      messageSearchDocIds(orgId, String(msg!.thread_id), String(msg!.id), [])[0],
    )
  })
})

describe("projects.task: checklist and dependencies", () => {
  it("imports a task's checklist with its checked items, and undo removes it", async () => {
    const label = `cl${tag()}`
    const run = await importTasks(
      [
        {
          externalRef: "T-1",
          project: { name: `Checklists ${label}` },
          title: "Prepare unit",
          checklist: [
            { title: "Unbox" },
            { title: "Flash firmware", details: "v2.1", checked: true },
          ],
        },
      ],
      label,
    )
    expect(run.counts["projects.task"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const id = await taskId(label, "T-1")
    const items = await sql`
      SELECT title, details, checked FROM app_projects.task_checklist_items
      WHERE org_id = ${orgId} AND task_id = ${id} ORDER BY position`
    expect(items.map((i) => [i.title, i.details, i.checked])).toEqual([
      ["Unbox", null, false],
      ["Flash firmware", "v2.1", true],
    ])
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toEqual([])
    expect(
      (await sql`SELECT 1 FROM app_projects.task_checklist_items WHERE task_id = ${id}`).length,
    ).toBe(0)
  })

  it("links a dependency on a task of an earlier record now, and one of a later batch after the kind", async () => {
    const label = `dp${tag()}`
    const project = { name: `Deps ${label}` }
    const run = await importTasks(
      [
        // A depends on B, which arrives in a later batch.
        { externalRef: "A", project, title: "A", dependsOn: [{ externalRef: "B" }] },
        { externalRef: "B", project, title: "B" },
        // C depends on A, already imported: linked at record time.
        {
          externalRef: "C",
          project,
          title: "C",
          dependsOn: [{ externalRef: "A", type: "relates" }],
        },
        // D depends on a task no source has.
        { externalRef: "D", project, title: "D", dependsOn: [{ externalRef: "NOPE" }] },
      ],
      label,
      1,
    )
    expect(run.counts["projects.task"]).toEqual({ created: 4, skipped: 0, failed: 0 })
    expect(run.report.dependenciesLinked).toBe(2)
    expect(run.report.dependenciesUnresolved).toBe(1)
    const [a, b, c, d] = await Promise.all(["A", "B", "C", "D"].map((r) => taskId(label, r)))
    const deps = await dependencies([a!, b!, c!, d!])
    expect(
      deps
        .map((r) => [r.task_id, r.depends_on_task_id, r.type])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual(
      [
        [a, b, "blocks"],
        [c, a, "relates"],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    )
    const [blocked] = await sql`SELECT blocked FROM app_projects.tasks WHERE id = ${a!}`
    expect(blocked!.blocked).toBe(true)

    // Every row is the run's own: undo removes them all, nothing refused.
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toEqual([])
    expect((await dependencies([a!, b!, c!, d!])).length).toBe(0)
    expect(
      (await sql`SELECT 1 FROM app_projects.tasks WHERE id = ANY(${[a!, b!, c!, d!]})`).length,
    ).toBe(0)
  })

  it("links only to tasks of the run or tasks the importer can read, never another task", async () => {
    const label = `dv${tag()}`
    const project = { name: `Deps vis ${label}` }
    // A task imported earlier, by another run.
    const earlier = await importTasks([{ externalRef: "EXT", project, title: "Existing" }], label)
    expect(earlier.counts["projects.task"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const ext = await taskId(label, "EXT")

    // The handler, as a run of a person whose RLS shows them no task.
    const blind: UserContext = {
      actorType: "user",
      userId: adminId,
      orgId,
      scopes: ["kernel:threads:read"],
      dimensionGrants: {},
    }
    const run = await createImportRun({
      orgId,
      kinds: ["projects.task"],
      sourceLabel: label,
      source: { records: true },
      mode: "cli",
      dryRun: false,
      placeholders: false,
      startedBy: adminId,
      status: "running",
    })
    const ctx: HostImportContext = {
      orgId,
      runId: run.id,
      kind: "projects.task",
      sourceLabel: label,
      actorUserId: adminId,
      actorScopes: blind.scopes,
      actorDimensionGrants: {},
      placeholders: false,
      mode: "cli",
      cache: new Map(),
      options: {},
      resolveFile: () => Promise.reject(new Error("no files")),
      withActorRls: (fn) => withRlsContext(blind, fn),
      checkDimension: () => true,
    }
    const importOne = (record: Record<string, unknown>) =>
      withPrivilegedDb(
        orgId,
        "t",
        async (tx) => {
          const o = await taskImportHandler.importRecord(
            tx,
            ctx,
            record,
            `${label}:${String(record.externalRef)}`,
          )
          await insertLedgerRows(tx, {
            orgId,
            runId: run.id,
            kind: "projects.task",
            recordKey: String(record.externalRef),
            rows: o.rows,
          })
          return o
          // The runner's batch writes as the importer (its write scope); the
          // reads above stay under the blind person's RLS (ctx.withActorRls).
        },
        { actor: { userId: adminId, scopes: ["projects:tasks:write"] } },
      )
    // EXT is invisible to this person: never linked, left for afterKind, unresolved.
    const mine = await importOne({
      externalRef: "MINE",
      project,
      title: "Mine",
      dependsOn: [{ externalRef: "EXT" }],
    })
    expect(mine.report?.dependenciesLinked).toBe(0)
    // A task of the run itself is found through the run's ledger.
    const mine2 = await importOne({
      externalRef: "MINE2",
      project,
      title: "Mine 2",
      dependsOn: [{ externalRef: "MINE" }],
    })
    expect(mine2.report?.dependenciesLinked).toBe(1)
    const after = await withPrivilegedDb(orgId, "t", (tx) => taskImportHandler.afterKind!(tx, ctx))
    expect(after.report).toEqual({ dependenciesUnresolved: 1 })
    const [m, m2] = await Promise.all(["MINE", "MINE2"].map((r) => taskId(label, r)))
    const deps = await dependencies([m!, m2!])
    expect(deps.map((r) => [r.task_id, r.depends_on_task_id])).toEqual([[m2, m]])
    expect(deps.map((r) => r.depends_on_task_id)).not.toContain(ext)

    // A person who can read it links the same task.
    const reader = await importTasks(
      [{ externalRef: "R", project, title: "Reader", dependsOn: [{ externalRef: "EXT" }] }],
      label,
    )
    expect(reader.report.dependenciesLinked).toBe(1)
  })

  it("keeps a task that gained a dependency after the import", async () => {
    const label = `dk${tag()}`
    const project = { name: `Deps kept ${label}` }
    const run = await importTasks(
      [
        { externalRef: "X", project, title: "X" },
        { externalRef: "Y", project, title: "Y" },
      ],
      label,
    )
    const [x, y] = await Promise.all(["X", "Y"].map((r) => taskId(label, r)))
    // Someone links them by hand afterwards.
    await sql`
      INSERT INTO app_projects.task_dependencies (org_id, task_id, depends_on_task_id)
      VALUES (${orgId}, ${x!}, ${y!})`
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused.map((r) => r.reason).sort()).toEqual([
      "has_new_children",
      "has_new_children",
    ])
  })
})

describe("projects.task attachments", () => {
  /** A file the operator uploaded to a thread only they take part in. */
  async function uploaded(name: string, body: Uint8Array): Promise<string> {
    const fileId = crypto.randomUUID()
    const key = `orgs/${orgId}/task-attach-test/${fileId}/${name}`
    await putObject({ key, body: Buffer.from(body), contentType: "application/pdf" })
    await withPrivilegedDb(orgId, "t", async (tx) => {
      const threadId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
        VALUES (${threadId}::uuid, ${orgId}::uuid, ${`ta-${threadId.slice(0, 8)}`}, 'upload', ${adminId}::uuid)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${threadId}::uuid, ${adminId}::uuid, ${orgId}::uuid, 'owner')`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                  size_bytes, storage_key, uploaded_by)
        VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', 'thread', ${threadId}, ${name},
                'application/pdf', ${body.byteLength}, ${key}, ${adminId}::uuid)`)
    })
    return fileId
  }

  it("stores each attachment as a task file under its author and date; undo removes them", async () => {
    await rebuildFilesSelectPolicy()
    const label = `ta${tag()}`
    const bytes = new TextEncoder().encode(`%PDF spec for ${label}`)
    const fileId = await uploaded("spec.pdf", bytes)
    const run = await importTasks(
      [
        {
          externalRef: "A-1",
          project: { name: `Attach ${label}` },
          title: "With a spec",
          attachments: [
            {
              filename: "spec.pdf",
              mimeType: "application/pdf",
              fileId,
              createdAt: "2024-03-05T10:00:00Z",
            },
          ],
        },
      ],
      label,
    )
    expect(run.counts["projects.task"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const id = await taskId(label, "A-1")
    const files = await sql`
      SELECT filename, size_bytes, storage_key, uploaded_by, created_at FROM kernel.files
      WHERE org_id = ${orgId} AND app = 'projects' AND entity_type = 'task' AND entity_id = ${id}`
    expect(files).toHaveLength(1)
    expect(files[0]!.filename).toBe("spec.pdf")
    expect(Number(files[0]!.size_bytes)).toBe(bytes.byteLength)
    expect(new Date(files[0]!.created_at as string).toISOString()).toBe("2024-03-05T10:00:00.000Z")
    expect(new Uint8Array(await getObjectBuffer(String(files[0]!.storage_key)))).toEqual(bytes)
    expect(run.report.attachmentsStored).toBe(1)

    await undoImportRun(orgId, run.runId, { userId: adminId })
    const after = await sql`
      SELECT id FROM kernel.files WHERE org_id = ${orgId} AND entity_id = ${id}`
    expect(after).toHaveLength(0)
  })
  it("imports as the importer on a pooled connection an earlier transaction left its scopes on", async () => {
    // The walk's failure: every task with attachments refused with
    // `insufficient_scope: projects:tasks:write`. The batch's privileged
    // transaction never set app.current_scopes, so the definer check read the
    // connection's leftover: '' once an RLS transaction had run on it (one
    // login for every pool, or the jobs pool), which refuses. Every connection
    // of the jobs pools is primed that way first.
    await rebuildFilesSelectPolicy()
    const person = await liveActor(orgId, adminId)
    expect(person).not.toBeNull()
    expect(person!.scopes.some((s) => s === "*" || s.startsWith("projects:"))).toBe(true)
    await Promise.all(
      Array.from({ length: 40 }, () =>
        Promise.all([
          withRlsContext(person!, (tx) => tx.execute(drizzleSql`SELECT pg_sleep(0.02)`), {
            pool: "jobs",
          }),
          withPrivilegedDb(
            orgId,
            "test-prime",
            (tx) =>
              tx.execute(
                drizzleSql`SELECT set_config('app.current_scopes', '', true), pg_sleep(0.02)`,
              ),
            { pool: "jobs" },
          ),
        ]),
      ),
    )
    const label = `tp${tag()}`
    const bytes = new TextEncoder().encode(`%PDF log for ${label}`)
    const fileId = await uploaded("log.pdf", bytes)
    const run = await runImport({
      orgId,
      actor: person!,
      kinds: ["projects.task"],
      source: recordsOf([
        {
          externalRef: "P-1",
          project: { name: `Pooled ${label}` },
          title: "With a log",
          attachments: [{ filename: "log.pdf", mimeType: "application/pdf", fileId }],
        },
        { externalRef: "P-2", project: { name: `Pooled ${label}` }, title: "Without" },
      ]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["projects.task"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    const id = await taskId(label, "P-1")
    const files = await sql`
      SELECT filename FROM kernel.files
      WHERE org_id = ${orgId} AND app = 'projects' AND entity_type = 'task' AND entity_id = ${id}`
    expect(files.map((f) => f.filename)).toEqual(["log.pdf"])

    await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(
      await sql`SELECT id FROM kernel.files WHERE org_id = ${orgId} AND entity_id = ${id}`,
    ).toHaveLength(0)
    expect(
      await sql`SELECT id FROM app_projects.tasks WHERE org_id = ${orgId} AND id = ${id}`,
    ).toHaveLength(0)
  })
})
