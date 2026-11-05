// SPDX-License-Identifier: FSL-1.1-ALv2
// Agent-facing status ergonomics (field bug: agent passed the label "TO DISCUSS"
// as `statusId` and got a raw postgres "Failed query ... ::uuid" back):
//  1. statusLabel resolution on create/update (+ non-UUID statusId tolerated as a label)
//  2. clean status_not_found / status_ambiguous errors carrying the project's
//     status candidates instead of a leaked SQL cast failure
//  3. agent tools to add / update / delete a project's status columns (only the
//     delete is gated since 2026-09-28)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { createProject } from "~/apps/projects/service/create-project"
import { resolveStatusRef } from "~/apps/projects/service/resolve"
import { ProjectsServiceError } from "~/apps/projects/service/statuses"
import { createTask, getTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

type ProjectWithStatuses = Awaited<ReturnType<typeof createProject>>

async function makeProject(name: string): Promise<ProjectWithStatuses> {
  return withRlsContext(actor, async (tx) =>
    createProject({ tx, orgId, actor, input: { name: `${name}-${Date.now()}-${Math.random()}` } }),
  )
}

function bridgeIn<T>(fn: (bridge: ReturnType<typeof createRpcBridge>) => Promise<T>): Promise<T> {
  return withRlsContext(actor, async (tx) =>
    fn(createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)),
  )
}

async function createProjectViaBridge(
  input: Record<string, unknown>,
): Promise<ProjectWithStatuses> {
  return bridgeIn(async (bridge) =>
    JSON.parse(await bridge.projects_createProject(JSON.stringify(input))),
  )
}

async function addStatusViaBridge(
  projectId: string,
  label: string,
  opts?: { terminal?: boolean },
): Promise<{ id: string; label: string; terminal: boolean }> {
  return bridgeIn(async (bridge) =>
    JSON.parse(
      await bridge.projects_addStatus(
        JSON.stringify({ projectId, label, terminal: opts?.terminal }),
      ),
    ),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-status-tools-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Status Tools Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid,
              ${`status-owner-${Date.now()}@test.com`}, 'Owner',
              'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = u!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("projects.status-tools", () => {
  it("projects.status-tools.resolve-status-by-label-case-insensitive", async () => {
    const project = await makeProject("ResolveLabel")
    const done = project.statuses.find((s) => s.terminal) ?? project.statuses.at(-1)!
    const id = await withRlsContext(actor, async (tx) =>
      resolveStatusRef(tx, orgId, project.id, { statusLabel: done.label.toUpperCase() }),
    )
    expect(id).toBe(done.id)
  })

  it("projects.status-tools.label-not-found-lists-candidates", async () => {
    const project = await makeProject("ResolveMiss")
    try {
      await withRlsContext(actor, async (tx) =>
        resolveStatusRef(tx, orgId, project.id, { statusLabel: "TO DISCUSS" }),
      )
      throw new Error("expected status_not_found")
    } catch (err) {
      const e = err as ProjectsServiceError
      expect(e).toBeInstanceOf(ProjectsServiceError)
      expect(e.code).toBe("status_not_found")
      const candidates = (e.details as { candidates: Array<{ id: string; label: string }> })
        .candidates
      expect(candidates.map((c) => c.label).sort()).toEqual(
        project.statuses.map((s) => s.label).sort(),
      )
    }
  })

  it("projects.status-tools.non-uuid-statusId-treated-as-label-not-sql-error", async () => {
    // The field failure: the agent put the LABEL in statusId. Must resolve (or
    // fail with status_not_found), never leak a "Failed query ... ::uuid" error.
    const project = await makeProject("LabelInIdSlot")
    const done = project.statuses.find((s) => s.terminal) ?? project.statuses.at(-1)!
    const created = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({ projectId: project.id, title: "t", statusId: done.label }),
        ),
      ),
    )
    expect(created.statusId).toBe(done.id)

    // A refusal is a typed envelope (it must reach an agent through the sandbox
    // with its code), never a leaked SQL error.
    const refused = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({ projectId: project.id, title: "t2", statusId: "TO DISCUSS" }),
        ),
      ),
    )
    expect(refused.error?.code).toBe("status_not_found")
    expect(String(refused.error?.message)).not.toContain("Failed query")
  })

  it("projects.status-tools.create-and-update-accept-statusLabel", async () => {
    const project = await makeProject("StatusLabelParam")
    const done = project.statuses.find((s) => s.terminal) ?? project.statuses.at(-1)!
    const first = project.statuses[0]!
    const created = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({ projectId: project.id, title: "labelled", statusLabel: done.label }),
        ),
      ),
    )
    expect(created.statusId).toBe(done.id)

    const updated = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_updateTask(
          JSON.stringify({ taskId: created.id, statusLabel: first.label.toLowerCase() }),
        ),
      ),
    )
    expect(updated.statusId).toBe(first.id)
  })

  it("projects.status-tools.add-update-delete-status-via-bridge", async () => {
    const project = await makeProject("StatusCrud")
    const added = await addStatusViaBridge(project.id, "TO DISCUSS")
    expect(added.label).toBe("TO DISCUSS")
    expect(added.terminal).toBe(false)

    // A task can land in the new column by label right away.
    const created = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({ projectId: project.id, title: "discuss me", statusLabel: "to discuss" }),
        ),
      ),
    )
    expect(created.statusId).toBe(added.id)

    const renamed = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_updateStatus(
          JSON.stringify({ projectId: project.id, statusLabel: "TO DISCUSS", label: "Discussing" }),
        ),
      ),
    )
    expect(renamed.id).toBe(added.id)
    expect(renamed.label).toBe("Discussing")

    // Move the task out, then delete the (now empty) column by id.
    const first = project.statuses[0]!
    await bridgeIn(async (bridge) =>
      bridge.projects_updateTask(JSON.stringify({ taskId: created.id, statusId: first.id })),
    )
    const deleted = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_deleteStatus(
          JSON.stringify({ projectId: project.id, statusId: added.id }),
        ),
      ),
    )
    expect(deleted.deleted).toBe(true)
    const remaining = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id FROM app_projects.project_statuses
        WHERE project_id = ${project.id}::uuid AND id = ${added.id}::uuid
      `),
    )
    expect(remaining).toHaveLength(0)
  })

  it("projects.status-tools.addStatus-resolves-projectName", async () => {
    const project = await makeProject("StatusByProjectName")
    const added = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_addStatus(
          JSON.stringify({ projectName: project.name, label: "Waiting" }),
        ),
      ),
    )
    expect(added.projectId).toBe(project.id)
  })

  it("projects.status-tools.non-uuid-taskId-yields-invalid-id-not-sql-error", async () => {
    const refused = await bridgeIn(async (bridge) =>
      JSON.parse(
        await bridge.projects_updateTask(JSON.stringify({ taskId: "not-a-uuid", title: "x" })),
      ),
    )
    expect(refused.error?.code).toBe("invalid_id")
    expect(String(refused.error?.message)).not.toContain("Failed query")
  })

  it("projects.status-tools.manifest-declares-status-tools-only-delete-gated-and-statusLabel", () => {
    const tools = (
      projectsManifest as {
        tools: Record<
          string,
          {
            gated?: boolean
            summarizer?: string
            requiredScopes?: string[]
            params?: { properties?: Record<string, unknown> }
          }
        >
      }
    ).tools
    for (const name of ["status_add", "status_update", "status_delete"]) {
      expect(tools[name]?.requiredScopes).toEqual(["projects:projects:write"])
    }
    // Owner ruling 2026-09-28: adding or renaming a column applies at once;
    // deleting one still waits for a human.
    expect(tools.status_delete?.gated).toBe(true)
    expect(tools.status_delete?.summarizer).toBeTruthy()
    for (const name of ["status_add", "status_update"]) {
      expect(tools[name]?.gated, `${name}.gated`).toBeUndefined()
      expect(tools[name]?.summarizer, `${name}.summarizer`).toBeUndefined()
    }
    expect(tools.create?.params?.properties?.statusLabel).toBeTruthy()
    expect(tools.update?.params?.properties?.statusLabel).toBeTruthy()
    const guide = (projectsManifest as { agentInstructions: unknown }).agentInstructions
    expect(JSON.stringify(guide)).toContain("statusLabel")
  })

  it("projects.status-tools.task-create-status-still-defaults-to-first-column", async () => {
    const project = await makeProject("DefaultStatus")
    const task = await withRlsContext(actor, async (tx) =>
      createTask({ tx, orgId, actor, input: { projectId: project.id, title: "plain" } }),
    )
    const got = await withRlsContext(actor, async (tx) => getTask({ tx, orgId, taskId: task.id }))
    expect(got.statusId).toBe(project.statuses[0]!.id)
  })
})

describe("projects.createProject.statuses-via-bridge", () => {
  it("creates the board with the columns the agent passed, in order", async () => {
    const project = await createProjectViaBridge({
      name: `Roadmap-${Date.now()}`,
      statuses: [
        { label: "Idea" },
        { label: "In discussion" },
        { label: "Candidate" },
        { label: "Todo" },
        { label: "In progress" },
        { label: "Done" },
      ],
    })
    expect(project.statuses.map((s) => s.label)).toEqual([
      "Idea",
      "In discussion",
      "Candidate",
      "Todo",
      "In progress",
      "Done",
    ])
    // No column was flagged terminal, so the last one is the done column.
    expect(project.statuses.map((s) => s.terminal)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ])
  })

  it("rejects a bad column list with a readable error, not a SQL dump", async () => {
    await expect(
      createProjectViaBridge({ name: `Bad-${Date.now()}`, statuses: [{ label: " " }] }),
    ).rejects.toThrow(/invalid_statuses: column 1 has an empty label/)
  })
})
