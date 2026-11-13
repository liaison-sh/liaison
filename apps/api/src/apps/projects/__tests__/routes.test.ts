// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { setFields } from "~/apps/projects/service/fields"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "550e8400-e29b-41d4-a716-446655441100"
const USER = "550e8400-e29b-41d4-a716-446655441101"
const ROLE_ID = "550e8400-e29b-41d4-a716-446655441102"
const OTHER_ORG = "550e8400-e29b-41d4-a716-446655441103"
const OTHER_USER = "550e8400-e29b-41d4-a716-446655441104"
let token: string

describe("projects.http", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}::uuid, 'Projects HTTP Org', 'projects-http-org')
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${OTHER_ORG}::uuid, 'Projects Other Org', 'projects-other-org')
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${USER}::uuid, ${ORG}::uuid, 'projects-http@test.com', 'Projects HTTP User', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${OTHER_USER}::uuid, ${OTHER_ORG}::uuid, 'projects-http-other@test.com', 'Other Org User', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE_ID}::uuid, ${ORG}::uuid, 'projects-member', 'Projects HTTP test role')
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}::uuid, 'projects:projects:write')
      ON CONFLICT DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}::uuid, 'projects:projects:read')
      ON CONFLICT DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}::uuid, 'projects:tasks:write')
      ON CONFLICT DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}::uuid, 'projects:tasks:read')
      ON CONFLICT DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER}::uuid, ${ROLE_ID}::uuid, ${ORG}::uuid)
      ON CONFLICT DO NOTHING
    `)
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Projects HTTP User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: [
          "projects:projects:read",
          "projects:projects:write",
          "projects:tasks:read",
          "projects:tasks:write",
        ],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("projects.http.task-fields-and-transitions", async () => {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    const created = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Fields ${Date.now()}` }),
    })
    const project = (
      (await created.json()) as { data: { id: string; statuses: Array<{ id: string }> } }
    ).data
    const actor = {
      actorType: "user" as const,
      userId: USER,
      orgId: ORG,
      scopes: ["projects:projects:read", "projects:projects:write", "projects:tasks:write"],
      dimensionGrants: { "*": ["*"] },
    }
    await withRlsContext(actor, (tx) =>
      setFields({
        tx,
        orgId: ORG,
        actor,
        projectId: project.id,
        fields: [
          { key: "serial", label: "Serial", type: "text", required: true },
          { key: "kind", label: "Kind", type: "choice", choices: ["A", "B"] },
        ],
      }),
    )
    const base = `/api/projects/${project.id}/tasks`
    // A person's create: the required field applies.
    const missing = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "no serial" }),
    })
    expect(missing.status).toBe(422)
    const ok = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "with", fields: { serial: "S-1" } }),
    })
    expect(ok.status).toBe(200)
    const task = ((await ok.json()) as { data: { id: string; fields: Record<string, unknown> } })
      .data
    expect(task.fields).toEqual({ serial: "S-1" })
    const bad = await app.request(`${base}/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: { kind: "C" } }),
    })
    expect(bad.status).toBe(422)
    const patched = await app.request(`${base}/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: { kind: "B" }, statusId: project.statuses[1]!.id }),
    })
    expect(patched.status).toBe(200)
    const got = await app.request(`${base}/${task.id}`, { headers })
    const detail = (
      (await got.json()) as {
        data: {
          fields: Record<string, unknown>
          statusEnteredAt: string
          transitions: Array<{ fromStatusId: string | null; toStatusId: string }>
        }
      }
    ).data
    expect(detail.fields).toEqual({ serial: "S-1", kind: "B" })
    expect(typeof detail.statusEnteredAt).toBe("string")
    expect(detail.transitions.map((t) => t.toStatusId)).toEqual([
      project.statuses[1]!.id,
      project.statuses[0]!.id,
    ])
  })

  it("projects.http.fields-get-put", async () => {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    const created = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Fields REST ${Date.now()}` }),
    })
    const project = ((await created.json()) as { data: { id: string } }).data
    const url = `/api/projects/${project.id}/fields`
    const empty = await app.request(url, { headers })
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { data: { fields: unknown[] } }).data.fields).toEqual([])

    const put = (body: unknown) =>
      app.request(url, { method: "PUT", headers, body: JSON.stringify(body) })
    const kind = { key: "kind", label: "Kind", type: "choice", choices: ["A", "B"] }
    const saved = await put({ fields: [kind, { key: "count", label: "Count", type: "number" }] })
    expect(saved.status).toBe(200)
    const savedBody = (await saved.json()) as { data: { fields: Array<{ key: string }> } }
    expect(savedBody.data.fields.map((f) => f.key)).toEqual(["kind", "count"])

    // An invalid list: the service's typed 422.
    const invalid = await put({ fields: [{ key: "x", label: "X", type: "nope" }] })
    expect(invalid.status).toBe(422)
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_fields",
    )

    // A task uses "A": dropping it is refused, renaming it to a kept option rewrites the value.
    const task = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "uses A", fields: { kind: "A", count: 3 } }),
    })
    expect(task.status).toBe(200)
    const taskId = ((await task.json()) as { data: { id: string } }).data.id
    const inUse = await put({ fields: [{ ...kind, choices: ["B"] }] })
    expect(inUse.status).toBe(422)
    const inUseErr = (
      (await inUse.json()) as {
        error: { code: string; details: { field: string; options: string[] } }
      }
    ).error
    expect(inUseErr.code).toBe("choice_in_use")
    expect(inUseErr.details).toEqual({ field: "kind", options: ["A"] })

    const typeInUse = await put({
      fields: [kind, { key: "count", label: "Count", type: "date" }],
    })
    expect(typeInUse.status).toBe(422)
    expect(((await typeInUse.json()) as { error: { code: string } }).error.code).toBe(
      "field_type_in_use",
    )

    const renamed = await put({
      fields: [
        { ...kind, choices: ["Alpha", "B"] },
        { key: "count", label: "Count", type: "number" },
      ],
      renames: { kind: { A: "Alpha" } },
    })
    expect(renamed.status).toBe(200)
    const got = await app.request(`/api/projects/${project.id}/tasks/${taskId}`, { headers })
    const detail = ((await got.json()) as { data: { fields: Record<string, unknown> } }).data
    expect(detail.fields).toEqual({ kind: "Alpha", count: 3 })
    const after = await app.request(url, { headers })
    const afterFields = (
      (await after.json()) as { data: { fields: Array<{ choices?: string[] }> } }
    ).data.fields
    expect(afterFields[0]?.choices).toEqual(["Alpha", "B"])

    const missing = await app.request("/api/projects/550e8400-e29b-41d4-a716-4466554411ff/fields", {
      headers,
    })
    expect(missing.status).toBe(404)
  })

  it("projects.http.crud-and-archive", async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }

    // POST create
    const r1 = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "A" }),
    })
    expect(r1.status).toBe(200)
    const p = ((await r1.json()) as { data: { id: string; name: string; statuses: unknown[] } })
      .data
    expect(p.statuses).toHaveLength(5)
    expect(p.name).toBe("A")
    const projectId = p.id

    // POST archive
    const r2 = await app.request(`/api/projects/${projectId}/archive`, {
      method: "POST",
      headers,
    })
    expect(r2.status).toBe(200)
    const archived = ((await r2.json()) as { data: { archivedAt: string | null } }).data
    expect(archived.archivedAt).toBeTruthy()

    // PATCH on archived → 409
    const r3 = await app.request(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "B" }),
    })
    expect(r3.status).toBe(409)
    const r3body = (await r3.json()) as { error: { code: string } }
    expect(r3body.error.code).toBe("project_archived")

    // POST restore
    const r4 = await app.request(`/api/projects/${projectId}/restore`, {
      method: "POST",
      headers,
    })
    expect(r4.status).toBe(200)
    const restored = ((await r4.json()) as { data: { archivedAt: string | null } }).data
    expect(restored.archivedAt).toBeNull()

    // PATCH after restore should succeed
    const r5 = await app.request(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "B" }),
    })
    expect(r5.status).toBe(200)
    expect(((await r5.json()) as { data: { name: string } }).data.name).toBe("B")
  })

  it("projects.http.non-uuid-id-params-404-not-500", async () => {
    // Regression: GET /api/projects/tasks (a stale tab URL falling through the
    // /:projectId pattern) reached the DB as `'tasks'::uuid` and 500'd. Any
    // non-UUID id param must 404 like an unknown row.
    const headers = { Authorization: `Bearer ${token}` }
    for (const path of ["/api/projects/tasks", "/api/projects/not-a-uuid/tasks"]) {
      const res = await app.request(path, { headers })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("not_found")
    }
  })

  it("projects.http.task-delete", async () => {
    // The delete SERVICE shipped with the gated agent tool, but no HTTP route
    // ever exposed it, so the web UI could not delete a task at all: this
    // request 404'd (no route) before the route existed.
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Delete-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data

    const mkTask = async (title: string, parentTaskId?: string): Promise<{ id: string }> => {
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify(parentTaskId ? { title, parentTaskId } : { title }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: { id: string } }).data
    }
    const parent = await mkTask("parent to delete")
    const child = await mkTask("child goes with it", parent.id)
    const bystander = await mkTask("must survive")

    const del = await app.request(`/api/projects/${project.id}/tasks/${parent.id}`, {
      method: "DELETE",
      headers,
    })
    expect(del.status).toBe(200)

    // Soft-delete archives the whole subtree, so parent AND child leave the
    // board while everything else stays — and a binned task must read as GONE
    // by direct id too, not just fall out of the listing. getTask used to have
    // no archived_at filter, so a deleted task still resolved by id and its URL
    // rendered a live-looking, still-editable detail pane.
    for (const gone of [parent.id, child.id]) {
      const res = await app.request(`/api/projects/${project.id}/tasks/${gone}`, { headers })
      expect(res.status).toBe(404)
    }
    const alive = await app.request(`/api/projects/${project.id}/tasks/${bystander.id}`, {
      headers,
    })
    expect(alive.status).toBe(200)

    const listRes = await app.request(`/api/projects/${project.id}/tasks`, { headers })
    expect(listRes.status).toBe(200)
    const listed = ((await listRes.json()) as { data: { items?: Array<{ id: string }> } }).data
    const ids = (listed.items ?? []).map((t) => t.id)
    expect(ids).not.toContain(parent.id)
    expect(ids).not.toContain(child.id)
    expect(ids).toContain(bystander.id)

    // Idempotent: deleting it again is not an error.
    const again = await app.request(`/api/projects/${project.id}/tasks/${parent.id}`, {
      method: "DELETE",
      headers,
    })
    expect(again.status).toBe(200)
  })

  it("projects.http.task-trash-list-and-restore", async () => {
    // A soft delete that nothing can list or undo is not a bin, it is a
    // permanent delete with extra steps. The board must never show binned work,
    // ?archived=only must show exactly it, and restore must bring back the
    // subtree the delete took.
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Trash-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data
    const mkTask = async (title: string, parentTaskId?: string): Promise<{ id: string }> => {
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify(parentTaskId ? { title, parentTaskId } : { title }),
      })
      return ((await res.json()) as { data: { id: string } }).data
    }
    const parent = await mkTask("binned parent")
    const child = await mkTask("binned child", parent.id)
    const kept = await mkTask("stays on the board")

    const listIds = async (query: string): Promise<string[]> => {
      const res = await app.request(`/api/projects/${project.id}/tasks${query}`, { headers })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { items?: Array<{ id: string }> } }
      return (body.data.items ?? []).map((t) => t.id)
    }

    await app.request(`/api/projects/${project.id}/tasks/${parent.id}`, {
      method: "DELETE",
      headers,
    })

    // Board: binned work is gone.
    const board = await listIds("")
    expect(board).toEqual([kept.id])

    // Bin: exactly the binned subtree, and nothing that is still live.
    const bin = await listIds("?archived=only")
    expect(bin.sort()).toEqual([parent.id, child.id].sort())
    expect(bin).not.toContain(kept.id)

    // include = both halves.
    const both = await listIds("?archived=include")
    expect(both.sort()).toEqual([parent.id, child.id, kept.id].sort())

    // Binned rows are not reachable by direct id either...
    const binnedGet = await app.request(`/api/projects/${project.id}/tasks/${parent.id}`, {
      headers,
    })
    expect(binnedGet.status).toBe(404)

    // Restore brings the whole subtree back to the board...
    const restore = await app.request(`/api/projects/${project.id}/tasks/${parent.id}/restore`, {
      method: "POST",
      headers,
    })
    expect(restore.status).toBe(200)
    expect((await listIds("")).sort()).toEqual([parent.id, child.id, kept.id].sort())
    // ...and empties the bin, and makes them reachable by id again.
    expect(await listIds("?archived=only")).toEqual([])
    const backGet = await app.request(`/api/projects/${project.id}/tasks/${parent.id}`, {
      headers,
    })
    expect(backGet.status).toBe(200)

    // Idempotent: restoring a live task is not an error.
    const again = await app.request(`/api/projects/${project.id}/tasks/${parent.id}/restore`, {
      method: "POST",
      headers,
    })
    expect(again.status).toBe(200)
  })

  it("projects.http.task-delete-respects-project-boundary", async () => {
    // A task id from another project must not be deletable through this
    // project's URL, matching the GET/PATCH/move boundary above.
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const mkProject = async (name: string): Promise<{ id: string }> => {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })
      return ((await res.json()) as { data: { id: string } }).data
    }
    const a = await mkProject(`DelBoundA-${Date.now()}`)
    const b = await mkProject(`DelBoundB-${Date.now()}`)
    const taskRes = await app.request(`/api/projects/${b.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "lives in B" }),
    })
    const task = ((await taskRes.json()) as { data: { id: string } }).data

    const wrongDelete = await app.request(`/api/projects/${a.id}/tasks/${task.id}`, {
      method: "DELETE",
      headers,
    })
    expect(wrongDelete.status).toBe(404)

    // Still there, reachable through its OWN project.
    const stillThere = await app.request(`/api/projects/${b.id}/tasks/${task.id}`, { headers })
    expect(stillThere.status).toBe(200)
  })

  it("projects.http.task-project-boundary-and-assignee-org", async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const createProject = async (name: string): Promise<{ id: string }> => {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: { id: string } }).data
    }

    const projectA = await createProject("Boundary A")
    const projectB = await createProject("Boundary B")
    const createTaskRes = await app.request(`/api/projects/${projectB.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "belongs to B" }),
    })
    expect(createTaskRes.status).toBe(200)
    const task = ((await createTaskRes.json()) as { data: { id: string } }).data

    const wrongGet = await app.request(`/api/projects/${projectA.id}/tasks/${task.id}`, {
      headers,
    })
    expect(wrongGet.status).toBe(404)

    const wrongPatch = await app.request(`/api/projects/${projectA.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "should not update" }),
    })
    expect(wrongPatch.status).toBe(404)

    const wrongMove = await app.request(`/api/projects/${projectA.id}/tasks/${task.id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parentTaskId: null }),
    })
    expect(wrongMove.status).toBe(404)

    const wrongAssigneeCreate = await app.request(`/api/projects/${projectA.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "foreign assignee", assigneeId: OTHER_USER }),
    })
    expect(wrongAssigneeCreate.status).toBe(404)
    expect(((await wrongAssigneeCreate.json()) as { error: { code: string } }).error.code).toBe(
      "assignee_not_found",
    )

    const validTaskRes = await app.request(`/api/projects/${projectA.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "valid" }),
    })
    expect(validTaskRes.status).toBe(200)
    const validTask = ((await validTaskRes.json()) as { data: { id: string } }).data
    const wrongAssigneePatch = await app.request(
      `/api/projects/${projectA.id}/tasks/${validTask.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ assigneeId: OTHER_USER }),
      },
    )
    expect(wrongAssigneePatch.status).toBe(404)
    expect(((await wrongAssigneePatch.json()) as { error: { code: string } }).error.code).toBe(
      "assignee_not_found",
    )
  })

  it("projects.http.release-field-filter-and-releases-endpoint", async () => {
    // GET /api/projects/releases must not fall through to /:projectId (404 on
    // the non-uuid "releases"); the release field round-trips through REST and
    // the board list filters on it.
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Release-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data
    const release = `r-${Date.now()}`

    const created = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "released", release: ` ${release} ` }),
    })
    expect(created.status).toBe(200)
    const task = ((await created.json()) as { data: { id: string; release: string | null } }).data
    expect(task.release).toBe(release)
    const child = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "inherits", parentTaskId: task.id }),
    })
    expect(child.status).toBe(200)

    const releasesRes = await app.request("/api/projects/releases", { headers })
    expect(releasesRes.status).toBe(200)
    const releases = ((await releasesRes.json()) as { data: { value: string; count: number }[] })
      .data
    expect(releases.find((r) => r.value === release)?.count).toBe(2)

    const listRes = await app.request(
      `/api/projects/${project.id}/tasks?release=${encodeURIComponent(release.toUpperCase())}`,
      { headers },
    )
    expect(listRes.status).toBe(200)
    const listed = ((await listRes.json()) as { data: { items: { id: string }[] } }).data.items
    expect(listed).toHaveLength(2)

    const tooLong = await app.request(`/api/projects/${project.id}/tasks/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ release: "x".repeat(41) }),
    })
    expect(tooLong.status).toBe(400)
    expect(JSON.stringify(await tooLong.json())).toContain("release")
  })

  it("projects.http.involved-endpoint", async () => {
    // GET /api/projects/involved must not fall through to /:projectId; it
    // lists the caller's recently created task with its reason, newest
    // first, and refuses a bad projectId.
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Involved-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data
    const created = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "mine, just now" }),
    })
    const task = ((await created.json()) as { data: { id: string } }).data

    const res = await app.request(`/api/projects/involved?days=7&projectId=${project.id}`, {
      headers,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { days: number; items: { id: string; involvement: { kind: string } }[] }
    }
    expect(body.data.days).toBe(7)
    expect(body.data.items.map((i) => i.id)).toEqual([task.id])
    expect(body.data.items[0]!.involvement.kind).toBe("created")

    const bad = await app.request("/api/projects/involved?projectId=nope", { headers })
    expect(bad.status).toBe(400)
  })

  it("projects.http.task-labels-in-out-and-filter", async () => {
    // labels go in on POST/PATCH, come out on detail and list rows,
    // and the list takes a `labels` JSON query param (AND across groups,
    // effective value, __none__). Taxonomy seeded privileged, per-run names
    // (this org persists across runs of the namespace database).
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const stamp = `${Date.now()}`.slice(-8)
    const N = `Nature${stamp}`
    const D = `Domain${stamp}`
    const label = async (name: string, parentId: string | null, archived = false) => {
      const [row] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO app_projects.labels (org_id, name, parent_id, archived_at)
          VALUES (${ORG}::uuid, ${name}, ${parentId}::uuid, ${archived ? drizzleSql`now()` : drizzleSql`NULL`})
          RETURNING id
        `),
      )
      return row!.id
    }
    const nature = await label(N, null)
    const bug = await label("bug", nature)
    await label("evolution", nature)
    await label("chore", nature, true)
    const domain = await label(D, null)
    await label("security", domain)

    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Labels-${stamp}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data
    type Row = {
      id: string
      labels: Array<{ groupId: string; valueId: string; valueName: string }>
    }
    const post = async (title: string, labels?: Record<string, string>) => {
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, ...(labels ? { labels } : {}) }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: Row }).data
    }

    // 1. in and out, clear, archived refusal
    const created = await post("labelled", { [N]: "bug" })
    expect(created.labels.map((l) => l.valueId)).toEqual([bug])
    const detail = await app.request(`/api/projects/${project.id}/tasks/${created.id}`, { headers })
    expect(((await detail.json()) as { data: Row }).data.labels.map((l) => l.valueName)).toEqual([
      "bug",
    ])
    const cleared = await app.request(`/api/projects/${project.id}/tasks/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ labels: { [nature]: null } }),
    })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { data: Row }).data.labels).toEqual([])
    const archived = await app.request(`/api/projects/${project.id}/tasks/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "renamed", labels: { [N]: "chore" } }),
    })
    expect(archived.status).toBe(409)
    const archivedBody = (await archived.json()) as {
      error: { code: string; details?: { validValues: Array<{ name: string }> } }
    }
    expect(archivedBody.error.code).toBe("label_archived")
    expect(archivedBody.error.details?.validValues.map((v) => v.name)).toEqual(["bug", "evolution"])
    const after = await app.request(`/api/projects/${project.id}/tasks/${created.id}`, { headers })
    const afterRow = ((await after.json()) as { data: Row & { title: string } }).data
    expect(afterRow.title).toBe("labelled")
    expect(afterRow.labels).toEqual([])

    // 2. list filter
    const a = await post("A", { [N]: "bug", [D]: "security" })
    const b = await post("B", { [N]: "bug" })
    const list = async (filter: unknown) => {
      const q = typeof filter === "string" ? filter : JSON.stringify(filter)
      return app.request(`/api/projects/${project.id}/tasks?labels=${encodeURIComponent(q)}`, {
        headers,
      })
    }
    const both = await list({ [N]: "bug", [D]: "security" })
    expect(both.status).toBe(200)
    const bothItems = ((await both.json()) as { data: { items: Row[] } }).data.items
    expect(bothItems.map((t) => t.id)).toEqual([a.id])
    expect(bothItems[0]!.labels).toHaveLength(2)
    const bugOnly = ((await (await list({ [N]: "bug" })).json()) as { data: { items: Row[] } }).data
      .items
    expect(bugOnly.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    const none = ((await (await list({ [N]: "__none__" })).json()) as { data: { items: Row[] } })
      .data.items
    expect(none.map((t) => t.id)).toEqual([created.id])

    // 3. refusals
    for (const bad of ["not-json", "[1]", JSON.stringify({ [N]: 1 })]) {
      const res = await list(bad)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_params")
    }
    const unknown = await list({ [N]: "nope" })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "label_not_found",
    )
  })

  it("projects.http.checklist-items-validations-and-levels", async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Checklist-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data

    const levelsRes = await app.request(`/api/projects/${project.id}/validation-levels`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        levels: [{ name: "AI" }, { name: "Beta" }],
      }),
    })
    expect(levelsRes.status).toBe(200)
    const levels = (
      (await levelsRes.json()) as { data: { levels: { id: string; name: string }[] } }
    ).data.levels
    expect(levels.map((l) => l.name)).toEqual(["AI", "Beta"])

    const taskRes = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "with checklist" }),
    })
    const task = ((await taskRes.json()) as { data: { id: string } }).data
    const base = `/api/projects/${project.id}/tasks/${task.id}/checklist`

    const added = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ title: "first" }, { title: "second" }] }),
    })
    expect(added.status).toBe(200)
    const items = ((await added.json()) as { data: { items: { id: string }[] } }).data.items
    expect(items).toHaveLength(2)

    const tooMany = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: Array.from({ length: 51 }, (_, i) => ({ title: `x${i}` })) }),
    })
    expect(tooMany.status).toBe(400)
    expect(((await tooMany.json()) as { error: { code: string } }).error.code).toBe(
      "checklist_too_many_items",
    )

    const noNote = await app.request(`${base}/validations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ itemId: items[0]!.id, level: "ai", state: "fail" }),
    })
    expect(noNote.status).toBe(400)
    expect(((await noNote.json()) as { error: { code: string } }).error.code).toBe(
      "checklist_fail_note_required",
    )

    const batch = await app.request(`${base}/validations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        validations: [
          { itemId: items[0]!.id, level: "AI", state: "success" },
          { itemId: items[0]!.id, level: "Beta", state: "na" },
          { itemId: items[1]!.id, level: "Beta", state: "fail", note: "crackles" },
        ],
      }),
    })
    expect(batch.status).toBe(200)

    const renamed = await app.request(`${base}/${items[1]!.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "second, renamed" }),
    })
    expect(renamed.status).toBe(200)

    const got = await app.request(base, { headers })
    expect(got.status).toBe(200)
    const view = (
      (await got.json()) as {
        data: {
          levels: { name: string }[]
          items: { title: string }[]
          status: { total: number; complete: number; failing: number }
        }
      }
    ).data
    expect(view.levels.map((l) => l.name)).toEqual(["AI", "Beta"])
    expect(view.items.map((i) => i.title)).toEqual(["first", "second, renamed"])
    expect(view.status).toMatchObject({ total: 2, complete: 1, failing: 1 })

    const detail = await app.request(`/api/projects/${project.id}/tasks/${task.id}`, { headers })
    const detailBody = (
      (await detail.json()) as { data: { checklist: { total: number; failing: number } } }
    ).data
    expect(detailBody.checklist).toMatchObject({ total: 2, failing: 1 })

    const removed = await app.request(`${base}/${items[1]!.id}`, { method: "DELETE", headers })
    expect(removed.status).toBe(200)
    const after = await app.request(base, { headers })
    const afterView = ((await after.json()) as { data: { status: { total: number } } }).data
    expect(afterView.status.total).toBe(1)

    // An item id from another task is not reachable through this task's URL.
    const otherTask = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "other" }),
    })
    const other = ((await otherTask.json()) as { data: { id: string } }).data
    const cross = await app.request(
      `/api/projects/${project.id}/tasks/${other.id}/checklist/${items[0]!.id}`,
      { method: "DELETE", headers },
    )
    expect(cross.status).toBe(404)
  })

  it("projects.http.checklist-never-blocks-move-or-patch-to-terminal", async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `NoGuard-${Date.now()}` }),
    })
    const project = (
      (await projRes.json()) as {
        data: { id: string; statuses: { id: string; terminal: boolean }[] }
      }
    ).data
    const done = project.statuses.find((s) => s.terminal)!
    const taskRes = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "guarded" }),
    })
    const task = ((await taskRes.json()) as { data: { id: string; statusId: string } }).data
    const added = await app.request(`/api/projects/${project.id}/tasks/${task.id}/checklist`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ title: "flash the unit" }] }),
    })
    expect(added.status).toBe(200)
    // The kanban drag uses /move; the detail panel's status picker uses PATCH.
    const moved = await app.request(`/api/projects/${project.id}/tasks/${task.id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ statusId: done.id }),
    })
    expect(moved.status).toBe(200)
    const movedBody = (await moved.json()) as { data: Record<string, unknown> }
    expect(movedBody.data.statusId).toBe(done.id)
    // D14: the warning is for agents; the human REST answer carries nothing new.
    expect(movedBody.data.checklistWarning).toBeUndefined()

    const second = (
      (await (
        await app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "patched" }),
        })
      ).json()) as { data: { id: string } }
    ).data
    await app.request(`/api/projects/${project.id}/tasks/${second.id}/checklist`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ title: "pending" }] }),
    })
    const patched = await app.request(`/api/projects/${project.id}/tasks/${second.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ statusId: done.id }),
    })
    expect(patched.status).toBe(200)
    const after = await app.request(`/api/projects/${project.id}/tasks/${second.id}`, { headers })
    const detail = (
      (await after.json()) as {
        data: { statusId: string; checklist: { total: number; blocking: unknown[] } }
      }
    ).data
    expect(detail.statusId).toBe(done.id)
    expect(detail.checklist.total).toBe(1)
    expect(detail.checklist.blocking).toHaveLength(1)
  })

  it("projects.http.checklist-on-cards-defaults-true-and-toggles", async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Cards-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string; checklistOnCards: boolean } })
      .data
    expect(project.checklistOnCards).toBe(true)
    const readOption = async () =>
      (
        (await (await app.request(`/api/projects/${project.id}`, { headers })).json()) as {
          data: { checklistOnCards: boolean }
        }
      ).data.checklistOnCards
    expect(await readOption()).toBe(true)
    const off = await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ checklistOnCards: false }),
    })
    expect(off.status).toBe(200)
    expect(
      ((await off.json()) as { data: { checklistOnCards: boolean } }).data.checklistOnCards,
    ).toBe(false)
    expect(await readOption()).toBe(false)
    await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ checklistOnCards: true }),
    })
    expect(await readOption()).toBe(true)
    const createdOff = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `CardsOff-${Date.now()}`, checklistOnCards: false }),
    })
    expect(
      ((await createdOff.json()) as { data: { checklistOnCards: boolean } }).data.checklistOnCards,
    ).toBe(false)
  })

  it("projects.http.task-list-rows-carry-checklist-status-and-project-carries-levels", async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const projRes = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `Counters-${Date.now()}` }),
    })
    const project = ((await projRes.json()) as { data: { id: string } }).data
    const levelsRes = await app.request(`/api/projects/${project.id}/validation-levels`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        // A legacy client still sending agentAccess: the key is stripped.
        levels: [{ name: "AI", agentAccess: "direct" }, { name: "Dev" }],
      }),
    })
    expect(levelsRes.status).toBe(200)

    const mk = async (title: string) =>
      (
        (await (
          await app.request(`/api/projects/${project.id}/tasks`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title }),
          })
        ).json()) as { data: { id: string } }
      ).data.id
    const withItems = await mk("with items")
    const bare = await mk("bare")
    const added = await app.request(`/api/projects/${project.id}/tasks/${withItems}/checklist`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ title: "one" }, { title: "two" }] }),
    })
    const items = ((await added.json()) as { data: { items: { id: string }[] } }).data.items
    const validated = await app.request(
      `/api/projects/${project.id}/tasks/${withItems}/checklist/validations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ itemId: items[0]!.id, level: "AI", state: "success" }),
      },
    )
    expect(validated.status).toBe(200)

    type Row = {
      id: string
      checklist: {
        total: number
        complete: number
        failing: number
        perLevel: { name: string; applicable: number; success: number; fail: number }[]
      } | null
    }
    const list = await app.request(`/api/projects/${project.id}/tasks`, { headers })
    expect(list.status).toBe(200)
    const rows = ((await list.json()) as { data: { items: Row[] } }).data.items
    const row = rows.find((r) => r.id === withItems)!
    expect(row.checklist).toMatchObject({ total: 2, complete: 0, failing: 0 })
    expect(row.checklist!.perLevel.map((l) => [l.name, l.applicable, l.success])).toEqual([
      ["AI", 2, 1],
      ["Dev", 2, 0],
    ])
    // No checklist, no counter: a task without items carries null.
    expect(rows.find((r) => r.id === bare)!.checklist).toBeNull()

    const detail = await app.request(`/api/projects/${project.id}`, { headers })
    const body = (
      (await detail.json()) as {
        data: { validationLevels: Record<string, unknown>[] }
      }
    ).data
    expect(body.validationLevels.map((l) => Object.keys(l).sort())).toEqual([
      ["id", "name"],
      ["id", "name"],
    ])
    expect(body.validationLevels.map((l) => l.name)).toEqual(["AI", "Dev"])
  })
})
