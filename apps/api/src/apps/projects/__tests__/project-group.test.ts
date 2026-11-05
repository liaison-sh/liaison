// SPDX-License-Identifier: FSL-1.1-ALv2
// A project's `group`: free text that files the project under a heading in the
// projects sidebar. The REST PATCH and the agent's `update_project` share
// service/update-project.ts; `createProject` takes it too.
//  - trimmed; empty (or only spaces) and null clear it; more than 60 chars is
//    refused with invalid_group and nothing is written;
//  - the list and the detail carry it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  createProject,
  listProjects,
  loadProjectDetail,
  MAX_PROJECT_GROUP_LENGTH,
} from "~/apps/projects/service/create-project"
import { ProjectsServiceError } from "~/apps/projects/service/statuses"
import { updateProject } from "~/apps/projects/service/update-project"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { person, secondOrg } from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

let orgId: string
let owner: UserContext

function viaTool(
  method: "projects_updateProject" | "projects_createProject",
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withRlsContext(owner, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      owner.userId,
      orgId,
      tx,
      { name: "projects" },
      owner.scopes,
      "user",
      undefined,
      { origin: "in-app-agent" },
    )
    return JSON.parse(await bridge[method](JSON.stringify(params)))
  })
}

function patch(projectId: string, group: string | null) {
  return withRlsContext(owner, (tx) =>
    updateProject({ tx, orgId, projectId, actor: owner, patch: { group } }),
  )
}

async function newProject(group?: string) {
  return withRlsContext(owner, (tx) =>
    createProject({
      tx,
      orgId,
      actor: owner,
      input: { name: `Grouped ${Math.random()}`, ...(group !== undefined ? { group } : {}) },
    }),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  ;({ orgId } = await secondOrg({ name: "Project Group Org" }))
  const ownerId = (await person(orgId, { name: "Gail Grouper" })).id
  owner = {
    actorType: "user",
    userId: ownerId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
  await ensureAppsForOrg(orgId)
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("project group (PATCH service)", () => {
  it("a new project has no group", async () => {
    const project = await newProject()
    expect(project.group).toBeNull()
  })

  it("sets a trimmed group, and the list and detail carry it", async () => {
    const project = await newProject()
    const updated = await patch(project.id, "  Product  ")
    expect(updated.group).toBe("Product")
    const detail = await withRlsContext(owner, (tx) => loadProjectDetail(tx, orgId, project.id))
    expect(detail.group).toBe("Product")
    const list = await withRlsContext(owner, (tx) => listProjects({ tx, orgId, limit: 100 }))
    expect(list.items.find((p) => p.id === project.id)?.group).toBe("Product")
  })

  it("an empty or blank group and null clear it", async () => {
    const project = await newProject("Legal")
    expect(project.group).toBe("Legal")
    expect((await patch(project.id, "   ")).group).toBeNull()
    await patch(project.id, "Legal")
    expect((await patch(project.id, null)).group).toBeNull()
  })

  it("refuses a group longer than the limit and keeps the old one", async () => {
    const project = await newProject("Tech")
    let caught: unknown
    try {
      await patch(project.id, "x".repeat(MAX_PROJECT_GROUP_LENGTH + 1))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProjectsServiceError)
    expect((caught as ProjectsServiceError).code).toBe("invalid_group")
    expect((caught as ProjectsServiceError).status).toBe(400)
    const detail = await withRlsContext(owner, (tx) => loadProjectDetail(tx, orgId, project.id))
    expect(detail.group).toBe("Tech")
    // Exactly the limit (after trimming) is fine.
    const atLimit = await patch(project.id, ` ${"y".repeat(MAX_PROJECT_GROUP_LENGTH)} `)
    expect(atLimit.group).toBe("y".repeat(MAX_PROJECT_GROUP_LENGTH))
  })

  it("createProject refuses a group longer than the limit", async () => {
    await expect(newProject("z".repeat(MAX_PROJECT_GROUP_LENGTH + 1))).rejects.toThrow(
      /invalid_group/,
    )
  })
})

describe("project group (agent tools)", () => {
  it("update_project sets and clears the group", async () => {
    const project = await newProject()
    const set = await viaTool("projects_updateProject", { projectId: project.id, group: " Ops " })
    expect(set.error).toBeUndefined()
    expect(set.group).toBe("Ops")
    const cleared = await viaTool("projects_updateProject", { projectId: project.id, group: null })
    expect(cleared.group).toBeNull()
  })

  it("update_project refuses a too-long group with invalid_group", async () => {
    const project = await newProject()
    const refused = (await viaTool("projects_updateProject", {
      projectId: project.id,
      group: "g".repeat(MAX_PROJECT_GROUP_LENGTH + 1),
    })) as { error?: { code: string } }
    expect(refused.error?.code).toBe("invalid_group")
  })

  it("createProject files the new project under a group", async () => {
    const created = await viaTool("projects_createProject", {
      name: `Tool grouped ${Math.random()}`,
      group: "  Marketing ",
    })
    expect(created.group).toBe("Marketing")
  })
})
