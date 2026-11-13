// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Recently involved" (listRecentlyInvolvedTasks + the `search` tool's
 * `involvedWithinDays`): real DB, real RLS, real audit rows (the task events
 * go through the outbox and the durable audit consumer, as in production).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import {
  INVOLVED_MAX_DAYS,
  listRecentlyInvolvedTasks,
  normalizeInvolvedDays,
} from "~/apps/projects/service/recently-involved"
import { postTaskComment } from "~/apps/projects/service/task-comment"
import { createTask, deleteTask, updateTask } from "~/apps/projects/service/tasks"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { auditLog } from "~/db/schema/kernel"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedContext } from "~/seed/context"
import { seedAttentionEvents } from "~/seed/factories/attention/events"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

let orgId: string
let otherOrgId: string
let me: string
let mate: string
let projectId: string
let otherProjectId: string
let openStatusId: string
let doneStatusId: string
let doneLabel: string

function ctx(uid: string, scopes: string[] = SCOPES, org = orgId): UserContext {
  return { actorType: "user", userId: uid, orgId: org, scopes, dimensionGrants: { "*": ["*"] } }
}

async function makeUser(org: string, name: string): Promise<string> {
  return (await minimal.person(org, { name })).id
}

async function makeTask(
  by: string,
  title: string,
  opts: { assigneeId?: string; project?: string } = {},
): Promise<{ id: string; threadId: string }> {
  return withRlsContext(ctx(by), async (tx) => {
    const t = await createTask({
      tx,
      orgId,
      actor: ctx(by),
      input: {
        projectId: opts.project ?? projectId,
        ...(opts.project ? {} : { statusId: openStatusId }),
        title,
        assigneeId: opts.assigneeId ?? null,
      },
    })
    return { id: t.id, threadId: t.threadId }
  })
}

async function comment(by: string, taskId: string, body: string): Promise<string> {
  const posted = await withRlsContext(ctx(by), (tx) =>
    postTaskComment(tx, { orgId, userId: by, taskId, body, requiredScopes: [] }),
  )
  return posted.messageId!
}

async function mention(threadId: string, by: string): Promise<void> {
  await seedAttentionEvents(seedContext({ orgId, now: new Date() }), [
    {
      key: `mention-${threadId}`,
      userId: me,
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      kind: "mention",
      urgency: 60,
      summary: "mentioned you",
      actorId: by,
      actorType: "user",
      occurredAt: new Date(),
      readAt: null,
    },
  ])
}

async function update(by: string, taskId: string, input: Record<string, unknown>): Promise<void> {
  await withRlsContext(ctx(by), (tx) => updateTask({ tx, orgId, actor: ctx(by), taskId, input }))
}

async function involved(opts: { days?: number; projectId?: string; as?: UserContext } = {}) {
  return withRlsContext(opts.as ?? ctx(me), (tx) =>
    listRecentlyInvolvedTasks({
      tx,
      orgId,
      userId: me,
      days: opts.days,
      projectId: opts.projectId,
      limit: 200,
    }),
  )
}

/** Move every trace of a task's activity `days` days into the past. */
async function age(taskId: string, threadId: string, days: number): Promise<void> {
  const shift = drizzleSql.raw(`now() - interval '${days} days'`)
  await db.execute(
    drizzleSql`UPDATE ${projectsRel("tasks")} SET created_at = ${shift}, updated_at = ${shift} WHERE id = ${taskId}::uuid`,
  )
  await db.execute(
    drizzleSql`UPDATE kernel.messages SET created_at = ${shift} WHERE thread_id = ${threadId}::uuid`,
  )
  await db.execute(
    drizzleSql`UPDATE kernel.attention_events SET occurred_at = ${shift} WHERE entity_id = ${threadId}`,
  )
  await db.execute(
    drizzleSql`UPDATE kernel.audit_log SET timestamp = ${shift} WHERE entity_id = ${taskId}`,
  )
}

const tasks: Record<string, { id: string; threadId: string }> = {}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  // The real durable audit consumer; every WS fan-out method is a no-op.
  const wsStub = new Proxy({}, { get: () => async () => {} })
  registerEventSubscribers(wsStub as never)

  orgId = (await createTestOrg()).id
  otherOrgId = (await minimal.secondOrg({ name: "Elsewhere org" })).orgId
  me = await makeUser(orgId, "Morgan")
  mate = await makeUser(orgId, "Riley")
  const p = await withRlsContext(ctx(mate), (tx) =>
    createProject({
      tx,
      orgId,
      actor: ctx(mate),
      input: {
        name: "Involved board",
        key: "INV",
        fields: [{ key: "serial", label: "Serial", type: "text" }],
      },
    }),
  )
  projectId = p.id
  openStatusId = p.statuses.find((s) => !s.terminal)!.id
  const done = p.statuses.find((s) => s.terminal)!
  doneStatusId = done.id
  doneLabel = done.label
  const p2 = await withRlsContext(ctx(mate), (tx) =>
    createProject({ tx, orgId, actor: ctx(mate), input: { name: "Elsewhere" } }),
  )
  otherProjectId = p2.id

  // One task per kind of involvement; the teammate creates all but one.
  tasks.commented = await makeTask(mate, "I commented here")
  await comment(me, tasks.commented.id, "My finding")
  tasks.mentioned = await makeTask(mate, "I was mentioned here")
  await mention(tasks.mentioned.threadId, mate)
  tasks.status = await makeTask(mate, "I moved this to done")
  await update(me, tasks.status.id, { statusId: doneStatusId })
  tasks.assignedOther = await makeTask(mate, "I handed this to Riley")
  await update(me, tasks.assignedOther.id, { assigneeId: mate })
  tasks.edited = await makeTask(mate, "I edited this")
  await update(me, tasks.edited.id, { title: "I edited this (renamed)" })
  tasks.fieldSet = await makeTask(mate, "I set a field")
  await update(me, tasks.fieldSet.id, { fields: { serial: "S-1" }, title: "I set a field" })
  tasks.created = await makeTask(me, "I created this")
  tasks.assignedBy = await makeTask(mate, "Riley gave me this", { assigneeId: me })
  tasks.elsewhere = await makeTask(mate, "Comment in another project", {
    project: otherProjectId,
  })
  await comment(me, tasks.elsewhere.id, "Over here too")
  // Not mine at all: the teammate's own task, commented by the teammate.
  tasks.unrelated = await makeTask(mate, "Not mine")
  await comment(mate, tasks.unrelated.id, "Riley talking to herself")
  // Old: the same kinds of activity, 20 days ago.
  tasks.old = await makeTask(mate, "Old comment")
  await comment(me, tasks.old.id, "Long ago")
  // Binned after I commented: it must never appear.
  tasks.binned = await makeTask(mate, "Binned later")
  await comment(me, tasks.binned.id, "Before the bin")
  await withRlsContext(ctx(mate), (tx) =>
    deleteTask({ tx, orgId, actor: ctx(mate), taskId: tasks.binned!.id }),
  )

  await drainOutbox()
  await age(tasks.old.id, tasks.old.threadId, 20)

  // A forged audit row in my org naming another org's task id: the join to
  // the tasks (org + RLS) drops it.
  const foreignUser = await makeUser(otherOrgId, "Foreign")
  const foreign = await withRlsContext(ctx(foreignUser, SCOPES, otherOrgId), async (tx) => {
    const fp = await createProject({
      tx,
      orgId: otherOrgId,
      actor: ctx(foreignUser, SCOPES, otherOrgId),
      input: { name: "Foreign" },
    })
    return createTask({
      tx,
      orgId: otherOrgId,
      actor: ctx(foreignUser, SCOPES, otherOrgId),
      input: { projectId: fp.id, title: "Foreign task" },
    })
  })
  tasks.foreign = { id: foreign.id, threadId: foreign.threadId }
  await db.insert(auditLog).values({
    orgId,
    actorId: me,
    actorType: "user",
    app: "projects",
    entityType: "task",
    entityId: foreign.id,
    action: "task.updated",
    changes: { changedFields: ["title"] },
  })
}, 60_000)

afterAll(async () => {
  resetEventBus()
  await releaseTestLock()
})

describe("recently involved", () => {
  it("lists each kind of involvement with its reason", async () => {
    const out = await involved()
    const byId = new Map(out.items.map((t) => [t.id, t]))
    const reason = (key: string) => byId.get(tasks[key]!.id)?.involvement

    expect(reason("commented")?.kind).toBe("commented")
    expect(reason("commented")?.summary).toBe("you commented")

    expect(reason("mentioned")?.kind).toBe("mentioned")
    expect(reason("mentioned")?.actorName).toBe("Riley")
    expect(reason("mentioned")?.summary).toBe("Riley mentioned you")

    expect(reason("status")?.kind).toBe("status_changed")
    expect(reason("status")?.statusLabel).toBe(doneLabel)
    expect(reason("status")?.summary).toBe(`you moved it to ${doneLabel}`)

    expect(reason("assignedOther")?.kind).toBe("assigned_other")
    expect(reason("assignedOther")?.assigneeName).toBe("Riley")

    expect(reason("edited")?.kind).toBe("edited")
    expect(reason("edited")?.fields).toEqual(["title"])
    // changedFields is what differs: a field value as fields.<key>, an unchanged title not.
    expect(reason("fieldSet")?.kind).toBe("edited")
    expect(reason("fieldSet")?.fields).toEqual(["fields.serial"])

    expect(reason("created")?.kind).toBe("created")
    expect(reason("created")?.summary).toBe("you created it")

    expect(reason("assignedBy")?.kind).toBe("assigned_by")
    expect(reason("assignedBy")?.actorName).toBe("Riley")
    expect(byId.get(tasks.assignedBy!.id)?.involvementKinds).toContain("assignee")

    expect(byId.get(tasks.commented!.id)?.key).toMatch(/^INV-\d+$/)
    expect(byId.get(tasks.commented!.id)?.projectName).toBe("Involved board")
    expect(out.totalCount).toBe(out.items.length)
  })

  it("leaves out tasks I never touched", async () => {
    const ids = (await involved()).items.map((t) => t.id)
    expect(ids).not.toContain(tasks.unrelated!.id)
  })

  it("leaves out involvement older than the window, and finds it with a wider one", async () => {
    expect((await involved()).items.map((t) => t.id)).not.toContain(tasks.old!.id)
    expect((await involved({ days: 30 })).items.map((t) => t.id)).toContain(tasks.old!.id)
  })

  it("never lists a task the caller cannot see", async () => {
    const ids = (await involved({ days: 90 })).items.map((t) => t.id)
    // Binned after the comment.
    expect(ids).not.toContain(tasks.binned!.id)
    // Another org's task named by an activity row in this org.
    expect(ids).not.toContain(tasks.foreign!.id)
    // A caller whose RLS context cannot read projects sees nothing, whatever
    // the activity rows say.
    const blind = await involved({ as: ctx(me, ["kernel:threads:read"]) })
    expect(blind.items).toEqual([])
  })

  it("orders by most recent involvement first", async () => {
    // Pin three comments at distinct times, oldest written first.
    const at = async (key: string, hoursAgo: number) => {
      await db.execute(drizzleSql`
        UPDATE kernel.messages SET created_at = now() - make_interval(hours => ${hoursAgo}::int)
        WHERE thread_id = ${tasks[key]!.threadId}::uuid
      `)
    }
    await at("commented", 3)
    await at("elsewhere", 1)
    const ids = (await involved()).items.map((t) => t.id)
    const pos = (key: string) => ids.indexOf(tasks[key]!.id)
    expect(pos("elsewhere")).toBeLessThan(pos("commented"))
    // Everything that happened today (status change, creation...) is newer
    // than a comment pinned three hours back.
    expect(pos("created")).toBeLessThan(pos("commented"))
    const times = (await involved()).items.map((t) => t.involvement.at)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it("scopes to one project", async () => {
    const out = await involved({ projectId: otherProjectId })
    expect(out.items.map((t) => t.id)).toEqual([tasks.elsewhere!.id])
  })

  it("caps the window at 90 days", () => {
    expect(normalizeInvolvedDays(undefined)).toBe(14)
    expect(normalizeInvolvedDays(365)).toBe(INVOLVED_MAX_DAYS)
    expect(normalizeInvolvedDays(0)).toBe(14)
    expect(normalizeInvolvedDays("7")).toBe(7)
  })

  it("the search tool answers involvedWithinDays with my involved tasks, reasons included", async () => {
    const out = await withRlsContext(ctx(me), async (tx) => {
      const bridge = createRpcBridge("projects", me, orgId, tx, { name: "projects" }, SCOPES)
      return JSON.parse(
        await bridge.projects_search(JSON.stringify({ involvedWithinDays: 14, query: "edited" })),
      ) as {
        items: Array<{ type: string; id: string; involvement: { kind: string; summary: string } }>
        totalCount: number
      }
    })
    expect(out.items.map((i) => i.id)).toEqual([tasks.edited!.id])
    expect(out.items[0]!.type).toBe("task")
    expect(out.items[0]!.involvement.kind).toBe("edited")
    expect(out.items[0]!.involvement.summary).toBe("you changed title")
  })
})
