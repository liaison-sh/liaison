// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Projects declares `pick` on its project and task entities, so a dashboard table's link cell to
// a project or a task lists exactly that kind of record: the app's own `search`, run as the person
// with a fixed `kind`, never the mixed projects-and-tasks answer or the search index.
//   - a task picker lists tasks only (labelled by title), a project picker projects only;
//   - a person without the projects read scope is refused;
//   - the manifest check refuses a pick param the tool does not take, or one shadowing the query.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import projectsManifest from "~/apps/projects/app.manifest.json"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { pickDeclarationErrors, tableBackingDeclarationErrors } from "~/modules/apps/contract"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { searchLinkTargets } from "~/modules/dashboards/tables/link-search"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let viewer: UserContext
const word = `Zephyr${randomUUID().slice(0, 6)}`
let projectId: string
let taskId: string

beforeAll(async () => {
  await acquireTestLock()
  orgId = await seedOrgRow({ name: "Link Pick Org", slug: `link-pick-${randomUUID()}` })
  const userId = await seedUserRow({
    orgId,
    email: `picker-${randomUUID()}@test.com`,
    name: "Picker",
    status: "active",
    passwordHash: "hash",
    authVersion: 1,
    permissionVersion: 1,
  })
  viewer = {
    actorType: "user",
    userId,
    orgId,
    scopes: [
      "projects:projects:read",
      "projects:projects:write",
      "projects:tasks:read",
      "projects:tasks:write",
    ],
    dimensionGrants: { "*": ["*"] },
  }
  await ensureAppsForOrg(orgId, {})
  const { createProject } = await import("~/apps/projects/service/create-project")
  const { createTask } = await import("~/apps/projects/service/tasks")
  await withRlsContext(viewer, async (tx) => {
    const p = await createProject({ tx, orgId, actor: viewer, input: { name: `${word} board` } })
    projectId = p.id
    const t = await createTask({
      tx,
      orgId,
      actor: viewer,
      input: { projectId: p.id, title: `${word} amplifier hum` },
    })
    taskId = t.id
  })
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("projects link pickers", () => {
  it("a task link lists the matching task only, by its title", async () => {
    const out = await searchLinkTargets(
      viewer,
      { app: "projects", entityType: "task", q: word },
      { origin: "human-ui" },
    )
    expect(out).toEqual([
      { id: taskId, label: `${word} amplifier hum`, app: "projects", entityType: "task" },
    ])
  })

  it("a project link lists the matching project only, by its name", async () => {
    const out = await searchLinkTargets(
      viewer,
      { app: "projects", entityType: "project", q: word },
      { origin: "human-ui" },
    )
    expect(out).toEqual([
      { id: projectId, label: `${word} board`, app: "projects", entityType: "project" },
    ])
  })

  it("a link to any projects record lists both kinds, each with its type", async () => {
    const out = await searchLinkTargets(
      viewer,
      { app: "projects", q: word },
      { origin: "human-ui" },
    )
    expect(out.map((t) => [t.entityType, t.id]).sort()).toEqual(
      [
        ["project", projectId],
        ["task", taskId],
      ].sort(),
    )
  })

  it("a person without the projects read scope is refused", async () => {
    const outsider = { ...viewer, scopes: ["kernel:dashboards:read"] }
    await expect(
      searchLinkTargets(
        outsider,
        { app: "projects", entityType: "task", q: word },
        { origin: "human-ui" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" })
  })
})

describe("pick declarations", () => {
  it("the projects manifest's pick declarations pass the check", () => {
    expect(pickDeclarationErrors(projectsManifest)).toEqual([])
  })

  it("refuses a pick param the tool does not take, or one that is the query parameter", () => {
    const app = {
      tools: {
        find: { readOnly: true, params: { type: "object", properties: { q: {}, kind: {} } } },
      },
      entities: {
        a: {
          pick: {
            tool: "find",
            queryParam: "q",
            params: { nope: 1 },
            idField: "id",
            labelField: "n",
          },
        },
        b: {
          pick: {
            tool: "find",
            queryParam: "q",
            params: { q: "x" },
            idField: "id",
            labelField: "n",
          },
        },
        c: {
          pick: {
            tool: "find",
            queryParam: "q",
            params: { kind: "y" },
            idField: "id",
            labelField: "n",
          },
        },
      },
    }
    expect(pickDeclarationErrors(app)).toEqual([
      'pick_tool_invalid: entities.a.pick.params: tool "find" takes no parameter "nope"',
      'pick_tool_invalid: entities.b.pick.params: "q" is the query parameter',
    ])
  })
})

describe("table backing declarations", () => {
  it("the projects manifest's task backing names its parent entity", () => {
    expect(tableBackingDeclarationErrors(projectsManifest)).toEqual([])
  })

  it("refuses a parent that is not another entity of the app", () => {
    const app = {
      entities: {
        item: { tableBacking: { parent: "nope", provider: "p" } },
        self: { tableBacking: { parent: "self", provider: "p" } },
      },
    }
    expect(tableBackingDeclarationErrors(app)).toEqual([
      'table_backing_invalid: entities.item.tableBacking.parent: "nope" is not another entity of this app',
      'table_backing_invalid: entities.self.tableBacking.parent: "self" is not another entity of this app',
    ])
  })
})
