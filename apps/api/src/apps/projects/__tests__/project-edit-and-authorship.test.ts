// SPDX-License-Identifier: FSL-1.1-ALv2
// Editing a project (the REST PATCH and the agent's `update_project` share
// service/update-project.ts), the task's author line, and who may remove a
// task attachment.
//  - name, icon, colour and description change; the key changes only while
//    the project holds no task (a trashed one counts), else project_key_locked;
//    the project detail says so with `keyLocked`.
//  - a task carries its creator's name, and the agent's label when an agent
//    created it (never the person alone).
//  - a task file is removed by its uploader or a holder of projects:settings:admin
//    (the manifest's fileParent deleteScope); another member is refused.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject, loadProjectDetail } from "~/apps/projects/service/create-project"
import { createTask, deleteTask, getTask, listTasks } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { files } from "~/db/schema/kernel"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { deleteFile, FileServiceError } from "~/modules/files/service"
import { person, secondOrg } from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MEMBER_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:read",
  "kernel:threads:write",
]
const ADMIN_SCOPES = [...MEMBER_SCOPES, "projects:settings:admin"]

let orgId: string
let ownerId: string
let otherId: string
let owner: UserContext
let other: UserContext

function actorFor(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

function bridgeAs<T>(
  actor: UserContext,
  origin: "human-ui" | "in-app-agent",
  fn: (bridge: ReturnType<typeof createRpcBridge>) => Promise<T>,
): Promise<T> {
  return withRlsContext(actor, async (tx) =>
    fn(
      createRpcBridge(
        "projects",
        actor.userId,
        orgId,
        tx,
        { name: "projects" },
        actor.scopes,
        "user",
        undefined,
        { origin },
      ),
    ),
  )
}

async function updateViaTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return bridgeAs(owner, "in-app-agent", async (bridge) =>
    JSON.parse(await bridge.projects_updateProject(JSON.stringify(params))),
  )
}

async function newProject(name: string, key?: string) {
  return withRlsContext(owner, (tx) =>
    createProject({
      tx,
      orgId,
      actor: owner,
      input: { name: `${name}-${Math.random()}`, ...(key ? { key } : {}) },
    }),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  ;({ orgId } = await secondOrg({ name: "Project Edit Org" }))
  ownerId = (await person(orgId, { name: "Nora Owner" })).id
  otherId = (await person(orgId, { name: "Theo Member" })).id
  owner = actorFor(ownerId, MEMBER_SCOPES)
  other = actorFor(otherId, MEMBER_SCOPES)
  await ensureAppsForOrg(orgId)
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("projects.update_project", () => {
  it("edits name, icon, colour and description, and changes the key while there is no task", async () => {
    const project = await newProject("Edit me", `ED${Math.floor(Math.random() * 9000 + 1000)}`)
    const key = `NK${Math.floor(Math.random() * 9000 + 1000)}`
    const result = await updateViaTool({
      projectId: project.id,
      name: "Edited name",
      icon: "Flag",
      color: "var(--avatar-3-bg)",
      description: "New description",
      key: key.toLowerCase(),
    })
    expect(result.error).toBeUndefined()
    expect(result.name).toBe("Edited name")
    expect(result.icon).toBe("Flag")
    expect(result.color).toBe("var(--avatar-3-bg)")
    expect(result.description).toBe("New description")
    expect(result.key).toBe(key)
    expect(result.keyLocked).toBe(false)
  })

  it("refuses a key change once the project holds a task, even a trashed one", async () => {
    const project = await newProject("Locked key", `LK${Math.floor(Math.random() * 9000 + 1000)}`)
    const task = await withRlsContext(owner, (tx) =>
      createTask({ tx, orgId, actor: owner, input: { projectId: project.id, title: "first" } }),
    )
    await withRlsContext(owner, (tx) => deleteTask({ tx, orgId, taskId: task.id, actor: owner }))
    const detail = await withRlsContext(owner, (tx) => loadProjectDetail(tx, orgId, project.id))
    expect(detail.taskCount).toBe(0)
    expect(detail.keyLocked).toBe(true)

    const refused = (await updateViaTool({ projectId: project.id, key: "ZZNEW" })) as {
      error?: { code: string }
    }
    expect(refused.error?.code).toBe("project_key_locked")

    // The same key, and every other field, still go through.
    const renamed = await updateViaTool({
      projectId: project.id,
      key: project.key,
      name: "Renamed with tasks",
    })
    expect(renamed.error).toBeUndefined()
    expect(renamed.name).toBe("Renamed with tasks")
    expect(renamed.key).toBe(project.key)
  })
})

describe("projects.task-author", () => {
  it("a task a person created carries the person's name and no agent label", async () => {
    const project = await newProject("Author human")
    const task = await bridgeAs(owner, "human-ui", async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(JSON.stringify({ projectId: project.id, title: "human" })),
      ),
    )
    const read = await withRlsContext(owner, (tx) => getTask({ tx, orgId, taskId: task.id }))
    expect(read.createdBy).toBe(ownerId)
    expect(read.createdByName).toBe("Nora Owner")
    expect(read.createdByAgentLabel).toBeNull()
  })

  it("a task an agent created carries the agent's attribution", async () => {
    const project = await newProject("Author agent")
    const task = await bridgeAs(owner, "in-app-agent", async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(JSON.stringify({ projectId: project.id, title: "agent" })),
      ),
    )
    const read = await withRlsContext(owner, (tx) => getTask({ tx, orgId, taskId: task.id }))
    expect(read.createdByName).toBe("Nora Owner")
    expect(read.createdByAgentLabel).toBe("Nora Owner's agent")
  })

  it("the project task list carries the creator's name and agent label like the detail read", async () => {
    const project = await newProject("Author list")
    const human = await bridgeAs(owner, "human-ui", async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(JSON.stringify({ projectId: project.id, title: "human" })),
      ),
    )
    const agent = await bridgeAs(owner, "in-app-agent", async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(JSON.stringify({ projectId: project.id, title: "agent" })),
      ),
    )
    const { items } = await withRlsContext(owner, (tx) =>
      listTasks({ tx, orgId, projectId: project.id }),
    )
    const humanRow = items.find((t) => t.id === human.id)
    const agentRow = items.find((t) => t.id === agent.id)
    expect(humanRow?.createdByName).toBe("Nora Owner")
    expect(humanRow?.createdByAgentLabel).toBeNull()
    expect(agentRow?.createdByName).toBe("Nora Owner")
    expect(agentRow?.createdByAgentLabel).toBe("Nora Owner's agent")
  })

  it("an app cannot set the agent label itself", async () => {
    const project = await newProject("Author forged")
    const task = await bridgeAs(owner, "human-ui", async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({ projectId: project.id, title: "forged", createdByAgentLabel: "Bot" }),
        ),
      ),
    )
    const read = await withRlsContext(owner, (tx) => getTask({ tx, orgId, taskId: task.id }))
    expect(read.createdByAgentLabel).toBeNull()
  })
})

describe("projects.task-attachment-remove", () => {
  async function taskFile(uploadedBy: string): Promise<string> {
    const project = await newProject("Files")
    const task = await withRlsContext(owner, (tx) =>
      createTask({ tx, orgId, actor: owner, input: { projectId: project.id, title: "files" } }),
    )
    const fileId = randomUUID()
    await db.insert(files).values({
      id: fileId,
      orgId,
      app: "projects",
      entityType: "task",
      entityId: task.id,
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `orgs/${orgId}/projects/task/${task.id}/${fileId}/spec.pdf`,
      uploadedBy,
    })
    return fileId
  }

  function deleteAs(actor: UserContext, fileId: string): Promise<void> {
    return withRlsContext(actor, (rlsTx) =>
      deleteFile(fileId, {
        orgId,
        userId: actor.userId,
        scopes: actor.scopes,
        rlsTx,
        privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
      }),
    )
  }

  async function fileExists(fileId: string): Promise<boolean> {
    const rows = extractRows<{ id: string }>(
      await db.execute(drizzleSql`SELECT id FROM kernel.files WHERE id = ${fileId}::uuid`),
    )
    return rows.length > 0
  }

  it("the uploader removes their own file", async () => {
    const fileId = await taskFile(ownerId)
    await deleteAs(owner, fileId)
    expect(await fileExists(fileId)).toBe(false)
  })

  it("another member with write access is refused", async () => {
    const fileId = await taskFile(ownerId)
    let caught: unknown
    try {
      await deleteAs(other, fileId)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(FileServiceError)
    expect((caught as FileServiceError).code).toBe("FORBIDDEN")
    expect(await fileExists(fileId)).toBe(true)
  })

  it("a projects administrator removes anyone's file", async () => {
    const fileId = await taskFile(ownerId)
    await deleteAs(actorFor(otherId, ADMIN_SCOPES), fileId)
    expect(await fileExists(fileId)).toBe(false)
  })
})
