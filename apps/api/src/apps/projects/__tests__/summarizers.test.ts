// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  summarizeDeleteTask,
  summarizeMergeTasks,
  summarizeRemoveChecklistItem,
} from "../summarizers"

/**
 * Minimal ctx whose `execute` resolves rows by which task id the query targets.
 * The summarizers issue one SELECT per task id (delete: one; merge: two), so we
 * key the canned rows by id and read it back from the drizzle sql param chunks.
 */
/**
 * Drizzle inlines a `${value}` bound chunk as a boxed primitive (a `String`
 * object) rather than a `StringChunk` (which carries a `.value` string[] of raw
 * SQL). So a bound id appears as a chunk whose `.value` is undefined but which
 * `String()`-ifies to the id. Collect those.
 */
function extractBoundStrings(q: unknown): string[] {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? []
  const out: string[] = []
  for (const c of chunks) {
    const isStringChunk = Array.isArray((c as { value?: unknown })?.value)
    if (isStringChunk || c == null) continue
    out.push(String(c))
  }
  return out
}

function ctxByTaskId(rowsById: Record<string, Record<string, unknown>>) {
  return {
    tx: {
      execute: async (q: unknown) => {
        const id = extractBoundStrings(q).find((v) => v in rowsById)
        const row = id ? rowsById[id] : undefined
        return { rows: row ? [row] : [] } as never
      },
    } as never,
    orgId: "org-1",
    userId: "u-1",
  }
}

// Ids are UUID-shaped: loadTaskSummary short-circuits non-UUID ids to null at
// gate time (see summarizers.ts) so a mock keyed on "task-1" would never be hit.
const TASK_1 = "00000000-0000-4000-8000-000000000001"
const SRC_1 = "00000000-0000-4000-8000-000000000002"
const TGT_1 = "00000000-0000-4000-8000-000000000003"

describe("summarizeDeleteTask", () => {
  it("names the task TITLE (not the opaque uuid), its project, and subtask count", async () => {
    const ctx = ctxByTaskId({
      [TASK_1]: {
        id: TASK_1,
        title: "Safety track routing: per-channel limiter mapping",
        description: "Each input should write its own safety track for an independent limiter.",
        project_id: "proj-1",
        project_name: "Product Roadmap",
        subtask_count: 2,
      },
    })
    const r = await summarizeDeleteTask({ taskId: TASK_1 }, ctx)
    expect(r.kind).toBe("projects.delete")
    // The title must surface the human-readable task name, NOT the uuid.
    expect(r.title).toContain("Safety track routing")
    expect(r.title).not.toContain(TASK_1)
    expect(r.subtitle).toContain("Product Roadmap")
    expect(r.lines.join(" ")).toContain("independent limiter")
    expect(r.lines.join(" ")).toContain("2 subtasks")
    const link = r.links?.[0]
    expect(link && "entityId" in link ? link.entityId : null).toBe(TASK_1)
  })

  it("falls back gracefully when the task is missing (id only, never blank)", async () => {
    const ctx = ctxByTaskId({})
    const r = await summarizeDeleteTask({ taskId: "00000000-0000-4000-8000-00000000dead" }, ctx)
    expect(r.kind).toBe("projects.delete")
    expect(r.lines.join(" ")).toContain("00000000-0000-4000-8000-00000000dead")
  })
})

describe("summarizeRemoveChecklistItem", () => {
  const ITEM = "00000000-0000-4000-8000-0000000000c1"
  it("names the item TITLE and its task, never the bare uuid", async () => {
    const ctx = ctxByTaskId({
      [ITEM]: {
        id: ITEM,
        title: "Pedal sustain survives preset change",
        details: "Load preset B while holding the pedal.",
        task_id: TASK_1,
        task_title: "Sustain pedal fix",
        project_name: "Tessera bugs",
      },
    })
    const r = await summarizeRemoveChecklistItem({ itemId: ITEM }, ctx)
    expect(r.kind).toBe("projects.checklist_remove_item")
    expect(r.title).toContain("Pedal sustain survives preset change")
    expect(r.title).not.toContain(ITEM)
    expect(r.subtitle).toContain("Tessera bugs")
    expect(r.lines.join(" ")).toContain("Sustain pedal fix")
    const link = r.links?.[0]
    expect(link && "entityId" in link ? link.entityId : null).toBe(TASK_1)
  })

  it("falls back to the id when the item is gone", async () => {
    const r = await summarizeRemoveChecklistItem({ itemId: ITEM }, ctxByTaskId({}))
    expect(r.lines.join(" ")).toContain(ITEM)
  })
})

describe("summarizeMergeTasks", () => {
  it("names BOTH titles — which is archived and which is kept", async () => {
    const ctx = ctxByTaskId({
      [SRC_1]: {
        id: SRC_1,
        title: "Safety track routing (duplicate intake)",
        description: null,
        project_id: "proj-1",
        project_name: "Product Roadmap",
        subtask_count: 1,
      },
      [TGT_1]: {
        id: TGT_1,
        title: "Safety track routing: per-channel limiter mapping (canonical)",
        description: "detailed",
        project_id: "proj-1",
        project_name: "Product Roadmap",
        subtask_count: 0,
      },
    })
    const r = await summarizeMergeTasks({ sourceId: SRC_1, targetId: TGT_1 }, ctx)
    expect(r.kind).toBe("projects.merge")
    expect(r.title).toContain("Safety track routing (duplicate intake)")
    expect(r.title).toContain("canonical")
    const body = r.lines.join(" ")
    expect(body).toContain("Archives")
    expect(body).toContain("Safety track routing (duplicate intake)")
    expect(body).toContain("Keeps")
    expect(body).toContain("canonical")
    expect(body).toContain("1 subtask")
    expect(r.subtitle).toContain("Product Roadmap")
  })
})

describe("task summary display key", () => {
  let orgId: string
  let userId: string
  let actor: UserContext

  beforeAll(async () => {
    await acquireTestLock()
    const slug = `summarizers-task-key-${Date.now()}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Summarizers Task Key Org', ${slug}) RETURNING id
      `),
    )
    orgId = org!.id
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`summarizers-task-key-${Date.now()}@t.co`}, 'Task Key User', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    userId = u!.id
    actor = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["projects:projects:read", "projects:projects:write", "projects:tasks:write"],
      dimensionGrants: {},
    }
  })

  afterAll(releaseTestLock)

  it("task summary carries the display key", async () => {
    const project = await withRlsContext(actor, (tx) =>
      createProject({
        tx,
        orgId,
        actor,
        input: { name: `SummarizerKeyProj-${Date.now()}`, key: "ERB" },
      }),
    )
    const status = project.statuses.find((s) => !s.terminal)!.id
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: status, title: "key-carrying task" },
      }),
    )
    expect(task.number).toBe(1)
    expect(task.key).toBe(`ERB-${task.number}`)
  })

  it("carries the literal ERB-12 display key for a project's 12th task", async () => {
    const project = await withRlsContext(actor, (tx) =>
      createProject({
        tx,
        orgId,
        actor,
        input: { name: `TwelfthTaskProj-${Date.now()}`, key: "ERC" },
      }),
    )
    const status = project.statuses.find((s) => !s.terminal)!.id
    let last: Awaited<ReturnType<typeof createTask>> | undefined
    for (let i = 0; i < 12; i++) {
      last = await withRlsContext(actor, (tx) =>
        createTask({
          tx,
          orgId,
          actor,
          input: { projectId: project.id, statusId: status, title: `task ${i + 1}` },
        }),
      )
    }
    expect(last?.number).toBe(12)
    expect(last?.key).toBe("ERC-12")
  })
})
