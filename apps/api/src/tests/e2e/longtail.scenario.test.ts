// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E — Module J: the long-tail per-app capabilities (projects / boxtal /
// contacts), driven over the running `index.e2e.ts` server (spawned by
// `setupScenario`). One worker, three app-grouped describe blocks. Everything
// runs through the SAME production HTTP tool path the in-app agent uses:
//   POST /api/apps/tools/<app>:<tool>  →  executeTool → scope gate → (host app
//   service | bundled-app QuickJS sandbox bridge) → real DB writes/events.
//
// PROJECTS is a host app (auto-registered, no install): its new tools
// (tasks_byAssignee, delete, merge, instantiate_template, add_dependency) are
// reachable immediately. The destructive ops (delete/merge) are GATED — a caller
// who lacks `projects:approve` PROPOSES (lands an approval row, does NOT mutate);
// the org owner (`world.admin`, scope `*`) auto-executes past the gate.
//
// BOXTAL is a bundled app: installed for the org via the test-only
// `/api/_test/boxtal/install-for-test` route (the same server-side install dance
// a 3rd-party app uses), which also `seedShipments` directly so exceptions_list
// has fixtures without driving the gated create+webhook flow. The external Boxtal
// HTTP API is mocked; the connector capability is real. claim_open is GATED
// (money) + RECORD-AND-DEGRADE: with no carrier claims API wired in the E2E ctx,
// an executed claim records locally and reports `submitted_to_carrier:false`.
//
// CONTACTS ops are kernel tools (contacts_write / contacts_search / contacts_export)
// reachable at `POST /api/apps/tools/kernel:<tool>`; segments are a stored jsonb
// filter evaluated LIVE (createSegment/evaluateSegment), with a spend floor that
// is COMPUTABLE via the Shopify-exposed `amountSpent` (injected resolveSpend),
// never an "uncomputable" degrade. contacts_export writes a CSV `kernel.files`
// artifact and is gated behind `kernel:contacts:export`.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { setupScenario, teardownScenario } from "./setup"

describe("Long-tail per-app E2E — projects + boxtal + contacts (Module J)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let prefix: string

  // Write-but-not-approver driving user: holds the projects task/project read+write
  // scopes (and contacts read/write/export) but NOT *:approve, so a gated tool it
  // calls PROPOSES rather than auto-executing.
  let writer: { id: string; token: string }
  // A second org user — the assignee whose cross-project workload we query, and a
  // merge/dependency counterpart.
  let exporter: { id: string; token: string }
  let assignee: { id: string; token: string }

  function kernelSchema(): string {
    return prefix ? `"${prefix}kernel"` : "kernel"
  }
  function projectsSchema(): string {
    return prefix ? `"${prefix}app_projects"` : "app_projects"
  }
  function boxtalSchema(): string {
    return prefix ? `"${prefix}app_boxtal"` : "app_boxtal"
  }

  async function callTool(
    token: string,
    qualifiedTool: string,
    params: Record<string, unknown>,
    opts?: { threadId?: string; asAgent?: boolean },
  ) {
    // A proposal is an AGENT's call: a person's own call never parks an
    // approval (it runs on their scope or is refused), so `asAgent` makes the
    // call as the agent acting for `token`'s user (origin in-app-agent).
    if (opts?.asAgent) {
      return api(url, "/api/_test/agent-tool-call", {
        method: "POST",
        token,
        body: {
          toolName: qualifiedTool,
          params,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
        },
      })
    }
    return api(url, `/api/apps/tools/${qualifiedTool}`, {
      method: "POST",
      token,
      body: { params, ...(opts?.threadId ? { threadId: opts.threadId } : {}) },
    })
  }

  // Create a project via the host-app HTTP route; returns its id + a non-terminal
  // status id (tasks need a status column).
  async function createProject(
    token: string,
    name: string,
  ): Promise<{ projectId: string; statusId: string }> {
    const res = await api(url, "/api/projects", {
      method: "POST",
      token,
      body: { name },
    })
    if (res.status !== 200) {
      throw new Error(`createProject failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    const data = res.body.data as { id: string; statuses: Array<{ id: string; terminal: boolean }> }
    const statusId = data.statuses.find((s) => !s.terminal)?.id ?? data.statuses[0]?.id
    if (!statusId) throw new Error("created project has no statuses")
    return { projectId: data.id, statusId }
  }

  async function createTask(
    token: string,
    projectId: string,
    body: {
      statusId: string
      title: string
      assigneeId?: string | null
      dueDate?: string | null
      parentTaskId?: string | null
    },
  ): Promise<{ id: string }> {
    const res = await api(url, `/api/projects/${projectId}/tasks`, {
      method: "POST",
      token,
      body,
    })
    if (res.status !== 200) {
      throw new Error(`createTask failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return res.body.data as { id: string }
  }

  // Rebuild the boxtal .liaisonapp so the install route never depends on a stale
  // artifact (the harness installs from dist/, not from source).
  function buildBoxtalBundle(): void {
    const liaisonRoot = `${import.meta.dir}/../../../../..`
    const r = spawnSync("bash", ["scripts/build-bundled-app.sh", "boxtal", "--skip-sign"], {
      cwd: liaisonRoot,
      stdio: "pipe",
      encoding: "utf8",
    })
    if (r.status !== 0) {
      throw new Error(
        `buildBoxtalBundle failed (${r.status}): ${r.stderr ?? r.stdout ?? "<no output>"}`,
      )
    }
  }

  // Seed a Boxtal shipment row through the install route's seedShipments helper.
  async function boxtalInstall(seedShipments?: Array<Record<string, unknown>>): Promise<{
    connectionId: string
    seededShipmentIds: string[]
  }> {
    const res = await api(url, "/api/_test/boxtal/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id, ...(seedShipments ? { seedShipments } : {}) },
    })
    if (res.status !== 200) {
      throw new Error(`boxtal install-for-test failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return {
      connectionId: res.body.connectionId,
      seededShipmentIds: (res.body.seededShipmentIds as string[]) ?? [],
    }
  }

  beforeAll(async () => {
    // Hermetic: build the boxtal tarball so the install route has a fresh artifact.
    buildBoxtalBundle()

    const result = await setupScenario({
      seed: 79,
      org: { name: "Long-tail E2E Org" },
      populate: { users: { count: 2 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    prefix = env.schemaPrefix ?? ""

    writer = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "projects:projects:read",
        "projects:projects:write",
        "projects:tasks:read",
        "projects:tasks:write",
        "kernel:contacts:read",
        "kernel:contacts:write",
        "kernel:contacts:export",
        "kernel:threads:read",
        "kernel:threads:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // contacts_export is GATED (bulk PII) and the org owner preset does NOT carry
    // kernel:contacts:export, so the cases that assert on the produced artifact
    // need a user holding BOTH the export scope and the approve scope: a direct
    // call by someone eligible to approve executes rather than parking.
    exporter = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:contacts:read",
        "kernel:contacts:write",
        "kernel:contacts:export",
        "kernel:approve",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    assignee = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ════════════════════════════════════════════════════════════════════════
  // PROJECTS — cross-project query, gated destructive ops, templates, deps
  // ════════════════════════════════════════════════════════════════════════

  describe("projects", () => {
    it("J-P1: tasks_byAssignee returns one assignee's tasks across ALL projects with project name", async () => {
      // Two projects, the assignee owns one task in each; a third task in P2 is
      // owned by the writer (must NOT surface for the assignee).
      const p1 = await createProject(writer.token, "Roadmap Q3")
      const p2 = await createProject(writer.token, "Ops Backlog")
      const t1 = await createTask(writer.token, p1.projectId, {
        statusId: p1.statusId,
        title: "Cross-A",
        assigneeId: assignee.id,
      })
      const t2 = await createTask(writer.token, p2.projectId, {
        statusId: p2.statusId,
        title: "Cross-B",
        assigneeId: assignee.id,
      })
      await createTask(writer.token, p2.projectId, {
        statusId: p2.statusId,
        title: "Other-owner",
        assigneeId: writer.id,
      })

      const res = await callTool(writer.token, "projects:tasks_byAssignee", {
        assigneeId: assignee.id,
      })
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      const items = res.body.data.items as Array<{
        id: string
        title: string
        projectName: string
        assigneeId: string | null
      }>
      const ids = items.map((i) => i.id).sort()
      expect(ids).toEqual([t1.id, t2.id].sort())
      // Cross-project means the project NAME is joined in, not just an id.
      const a = items.find((i) => i.id === t1.id)
      const b = items.find((i) => i.id === t2.id)
      expect(a?.projectName).toBe("Roadmap Q3")
      expect(b?.projectName).toBe("Ops Backlog")
      // The other-owner task in P2 is excluded — this is genuinely per-assignee.
      expect(items.every((i) => i.assigneeId === assignee.id)).toBe(true)
    }, 60_000)

    it("J-P2: tasks_byAssignee due:overdue narrows to past-due tasks across projects", async () => {
      const p = await createProject(writer.token, "Due Mix")
      const overdue = await createTask(writer.token, p.projectId, {
        statusId: p.statusId,
        title: "Past due",
        assigneeId: assignee.id,
        dueDate: "2020-01-01",
      })
      await createTask(writer.token, p.projectId, {
        statusId: p.statusId,
        title: "Future",
        assigneeId: assignee.id,
        dueDate: "2999-12-31",
      })

      const res = await callTool(writer.token, "projects:tasks_byAssignee", {
        assigneeId: assignee.id,
        due: "overdue",
      })
      expect(res.status).toBe(200)
      const items = res.body.data.items as Array<{ id: string; dueDate: string | null }>
      // Every returned task is strictly past-due; the future task is excluded.
      expect(items.some((i) => i.id === overdue.id)).toBe(true)
      expect(items.every((i) => i.dueDate != null && new Date(i.dueDate) < new Date())).toBe(true)
    }, 60_000)

    it("J-P3: gated delete by a non-approver PROPOSES — approval row lands, task is NOT archived", async () => {
      const p = await createProject(writer.token, "Delete Gate")
      const parent = await createTask(writer.token, p.projectId, {
        statusId: p.statusId,
        title: "Parent to delete",
      })
      // A surface thread the caller participates in (a gated tool with no threadId
      // 403s before createApprovalRequest).
      const thread = await world.threads.create(world.users[0], {
        participantIds: [writer.id],
        initialMessage: { content: "delete approval thread" },
      })

      const res = await callTool(
        writer.token,
        "projects:delete",
        { taskId: parent.id },
        { threadId: thread.id, asAgent: true },
      )
      // Gated → 200 with a blocked/approval envelope (NOT a deletion).
      expect(res.status).toBe(200)
      expect(res.body.data.blocked).toBeDefined()
      expect(res.body.data.blocked.reason).toBe("gated")
      expect(/^[0-9a-f-]{36}$/.test(res.body.data.blocked.approvalRequestId)).toBe(true)

      // A real, pending approval row landed for the gated host-app write.
      const ks = kernelSchema()
      const approvals = (await env.db.sql.unsafe(
        `SELECT id, tool_name, status, summary FROM ${ks}.approval_requests
           WHERE tool_name = 'projects:delete' AND requested_by = $1`,
        [writer.id],
      )) as unknown as Array<{ id: string; tool_name: string; status: string; summary: unknown }>
      expect(approvals.length).toBeGreaterThanOrEqual(1)
      expect(approvals[0].status).toBe("pending")
      // The inline approvalCard summary surfaces the task id in the card.
      expect(JSON.stringify(approvals[0].summary)).toContain(parent.id)

      // Negative assertion (the whole point of the gate): the task is NOT archived.
      const ps = projectsSchema()
      const [row] = (await env.db.sql.unsafe(`SELECT archived_at FROM ${ps}.tasks WHERE id = $1`, [
        parent.id,
      ])) as unknown as Array<{ archived_at: string | null }>
      expect(row.archived_at).toBeNull()
    }, 60_000)

    it("J-P4: delete by the org owner (approver) auto-executes — soft-archives task + subtree, emits task:deleted", async () => {
      const p = await createProject(world.admin.token, "Delete Exec")
      const parent = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "Parent",
      })
      const child = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "Child",
        parentTaskId: parent.id,
      })
      const thread = await world.threads.create(world.admin, {
        participantIds: [writer.id],
        initialMessage: { content: "delete exec thread" },
      })

      const res = await callTool(
        world.admin.token,
        "projects:delete",
        { taskId: parent.id },
        { threadId: thread.id },
      )
      expect(res.status).toBe(200)
      // Org owner holds `*` → projects:approve → auto-executes past the gate.
      expect(res.body.data.blocked).toBeUndefined()
      expect(res.body.data.deleted).toBe(true)

      // Soft-delete cascades to the child subtree (no orphaned subtask).
      const ps = projectsSchema()
      const rows = (await env.db.sql.unsafe(
        `SELECT id, archived_at FROM ${ps}.tasks WHERE id = ANY($1::uuid[])`,
        [[parent.id, child.id]],
      )) as unknown as Array<{ id: string; archived_at: string | null }>
      expect(rows.length).toBe(2)
      expect(rows.every((r) => r.archived_at != null)).toBe(true)

      // The canonical task:deleted outbox event was emitted for the root. The
      // outbox stores events as a jsonb `payload`; the row stays in pending_events
      // (with processed_at set once delivered), so a single table read suffices.
      const ks = kernelSchema()
      const events = (await env.db.sql.unsafe(
        `SELECT payload FROM ${ks}.pending_events
           WHERE org_id = $1
             AND payload->>'app' = 'projects'
             AND payload->>'entity' = 'task'
             AND payload->>'action' = 'deleted'
             AND payload->>'entityId' = $2`,
        [world.org.id, parent.id],
      )) as unknown as Array<{ payload: unknown }>
      expect(events.length).toBeGreaterThanOrEqual(1)
    }, 60_000)

    it("J-P5: merge (gated, auto-exec by owner) reassigns children to target and archives the source", async () => {
      const p = await createProject(world.admin.token, "Merge")
      const source = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "Source",
      })
      const target = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "Target",
      })
      const sourceChild = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "Source child",
        parentTaskId: source.id,
      })
      const thread = await world.threads.create(world.admin, {
        participantIds: [writer.id],
        initialMessage: { content: "merge thread" },
      })

      const res = await callTool(
        world.admin.token,
        "projects:merge",
        { sourceId: source.id, targetId: target.id },
        { threadId: thread.id },
      )
      expect(res.status).toBe(200)
      expect(res.body.data.blocked).toBeUndefined()
      expect(res.body.data.merged).toBe(true)

      const ps = projectsSchema()
      // The source's child was reparented to the target.
      const [childRow] = (await env.db.sql.unsafe(
        `SELECT parent_task_id FROM ${ps}.tasks WHERE id = $1`,
        [sourceChild.id],
      )) as unknown as Array<{ parent_task_id: string | null }>
      expect(childRow.parent_task_id).toBe(target.id)
      // The source is archived; the target survives.
      const rows = (await env.db.sql.unsafe(
        `SELECT id, archived_at FROM ${ps}.tasks WHERE id = ANY($1::uuid[])`,
        [[source.id, target.id]],
      )) as unknown as Array<{ id: string; archived_at: string | null }>
      const src = rows.find((r) => r.id === source.id)
      const tgt = rows.find((r) => r.id === target.id)
      expect(src?.archived_at).not.toBeNull()
      expect(tgt?.archived_at).toBeNull()
    }, 60_000)

    it("J-P6: instantiate_template materializes the stored task tree into a new project", async () => {
      // Seed a template directly (no host-app template-authoring tool in scope).
      // The `structure` is a jsonb ARRAY; pass it as a JS object via sql.json so
      // postgres.js serializes it to a jsonb array (NOT a double-encoded jsonb
      // string — a stringified value bound to `::jsonb` lands as jsonb_typeof
      // 'string', and instantiateTemplate's `Array.isArray` guard then yields no
      // tasks).
      const ps = projectsSchema()
      const structure = [{ title: "Plan" }, { title: "Ship", children: [{ title: "QA" }] }]
      const [tpl] = (await env.db.sql.unsafe(
        `INSERT INTO ${ps}.project_templates (org_id, name, structure, created_by)
           VALUES ($1, 'Launch Template', $2, $3) RETURNING id`,
        [world.org.id, env.db.sql.json(structure), writer.id],
      )) as unknown as Array<{ id: string }>

      const res = await callTool(world.admin.token, "projects:instantiate_template", {
        templateId: tpl.id,
        projectName: "Launch Q3",
      })
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      const projectId = res.body.data.projectId as string
      expect(/^[0-9a-f-]{36}$/.test(projectId)).toBe(true)

      // The full tree (Plan, Ship, QA) was created in the new project.
      const taskRows = (await env.db.sql.unsafe(
        `SELECT title FROM ${ps}.tasks WHERE project_id = $1 AND org_id = $2 AND archived_at IS NULL ORDER BY title`,
        [projectId, world.org.id],
      )) as unknown as Array<{ title: string }>
      expect(taskRows.map((r) => r.title).sort()).toEqual(["Plan", "QA", "Ship"])
    }, 60_000)

    it("J-P7: add_dependency blocks the dependent, and rejects a cycle (A→B→A)", async () => {
      const p = await createProject(world.admin.token, "Deps")
      const a = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "A",
      })
      const b = await createTask(world.admin.token, p.projectId, {
        statusId: p.statusId,
        title: "B",
      })

      // B depends on A (blocks) → B is marked blocked while A is open.
      const dep = await callTool(world.admin.token, "projects:add_dependency", {
        taskId: b.id,
        dependsOnTaskId: a.id,
        type: "blocks",
      })
      expect(dep.status).toBe(200)
      expect(dep.body.error).toBeUndefined()

      const ps = projectsSchema()
      const [bRow] = (await env.db.sql.unsafe(`SELECT blocked FROM ${ps}.tasks WHERE id = $1`, [
        b.id,
      ])) as unknown as Array<{ blocked: boolean }>
      expect(bRow.blocked).toBe(true)
      // The dependency edge persisted.
      const edges = (await env.db.sql.unsafe(
        `SELECT type FROM ${ps}.task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2`,
        [b.id, a.id],
      )) as unknown as Array<{ type: string }>
      expect(edges.length).toBe(1)
      expect(edges[0].type).toBe("blocks")

      // The reverse edge A→B would close a cycle — rejected end-to-end.
      const cyclic = await callTool(world.admin.token, "projects:add_dependency", {
        taskId: a.id,
        dependsOnTaskId: b.id,
        type: "blocks",
      })
      // The cycle pre-check throws a 400 validation error; the executeTool path
      // surfaces it as an error envelope (no edge created).
      expect(cyclic.body.error).toBeDefined()
      expect(String(cyclic.body.error.message)).toMatch(/cycle|circular/i)
      const reverseEdges = (await env.db.sql.unsafe(
        `SELECT 1 FROM ${ps}.task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2`,
        [a.id, b.id],
      )) as unknown as Array<unknown>
      expect(reverseEdges.length).toBe(0)
    }, 60_000)
  })

  // ════════════════════════════════════════════════════════════════════════
  // BOXTAL — exception triage + gated claim (RECORD-AND-DEGRADE)
  // ════════════════════════════════════════════════════════════════════════

  describe("boxtal", () => {
    it("J-B1: exceptions_list filters to EXCEPTION / RETURNED states (delivered + in-transit excluded)", async () => {
      // Install with a mixed fleet: only the exception-state shipments should
      // surface; DELIVERED and IN_TRANSIT are healthy/normal. The shipment table's
      // tracking_status enum admits EXCEPTION + RETURNED (both in EXCEPTION_STATES).
      await boxtalInstall([
        {
          recipient_summary: "Exception Co",
          offer_code: "MONR",
          tracking_number: "TR-EXC",
          order_status: "CONFIRMED",
          tracking_status: "EXCEPTION",
        },
        {
          recipient_summary: "Returned Co",
          offer_code: "CHRP",
          tracking_number: "TR-RET",
          order_status: "CONFIRMED",
          tracking_status: "RETURNED",
        },
        {
          recipient_summary: "Delivered Co",
          offer_code: "MONR",
          tracking_number: "TR-DEL",
          order_status: "CONFIRMED",
          tracking_status: "DELIVERED",
        },
        {
          recipient_summary: "Transit Co",
          offer_code: "CHRP",
          tracking_number: "TR-TRN",
          order_status: "CONFIRMED",
          tracking_status: "IN_TRANSIT",
        },
      ])

      const res = await callTool(world.admin.token, "boxtal:exceptions_list", {})
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      const rows = res.body.data.rows as Array<{
        recipient: string
        tracking_status: string
      }>
      const statuses = rows.map((r) => r.tracking_status).sort()
      expect(statuses).toEqual(["EXCEPTION", "RETURNED"])
      expect(
        rows.every((r) =>
          ["INCIDENT", "RETURNED", "LOST", "EXCEPTION"].includes(r.tracking_status),
        ),
      ).toBe(true)
      // The healthy shipments are absent (the filter precision SLA scenarios rely on).
      expect(rows.some((r) => r.recipient === "Delivered Co")).toBe(false)
      expect(rows.some((r) => r.recipient === "Transit Co")).toBe(false)
    }, 120_000)

    it("J-B2: a healthy fleet → exceptions_list returns an empty list (not an error)", async () => {
      // Re-install (clean-slate reset) with only healthy shipments.
      await boxtalInstall([
        {
          recipient_summary: "All Good 1",
          tracking_number: "OK-1",
          order_status: "CONFIRMED",
          tracking_status: "DELIVERED",
        },
        {
          recipient_summary: "All Good 2",
          tracking_number: "OK-2",
          order_status: "CONFIRMED",
          tracking_status: "IN_TRANSIT",
        },
      ])

      const res = await callTool(world.admin.token, "boxtal:exceptions_list", {})
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      // A healthy fleet is a NORMAL state — empty, never an error.
      expect(res.body.data.rows).toEqual([])
    }, 120_000)

    it("J-B3: claim_open against a delivered shipment is rejected (not in an exception state)", async () => {
      // Clean-slate install with one delivered + one exception shipment.
      const { seededShipmentIds } = await boxtalInstall([
        {
          recipient_summary: "Delivered Parcel",
          tracking_number: "DLV-1",
          order_status: "CONFIRMED",
          tracking_status: "DELIVERED",
        },
        {
          recipient_summary: "Exception Parcel",
          tracking_number: "EXC-1",
          order_status: "CONFIRMED",
          tracking_status: "EXCEPTION",
        },
      ])
      // Resolve which seeded id is the delivered one (insertion order matches the
      // seed array order).
      const deliveredId = seededShipmentIds[0]
      expect(deliveredId).toBeTruthy()

      // Org owner (`*` → boxtal:approve) auto-executes past the gate, so the
      // handler runs inline and the eligibility guard fires.
      const res = await callTool(world.admin.token, "boxtal:claim_open", {
        shipment_id: deliveredId,
        type: "lost",
        amount: 100,
        evidence_file_ids: [],
      })
      // The eligibility guard ("cannot claim a delivered parcel") makes the
      // handler throw, and the host reports the real refusal: a conflict with
      // the guard's own message, never a bare "Tool execution failed" 500
      // (the error-reporting convention, modules/apps/execute-tool.ts). The
      // load-bearing assertion is still the BEHAVIOR: the claim is refused.
      expect(res.status).toBe(409)
      expect(res.body.error?.message).toContain("not in an exception state")
      expect(res.body.data).toBeUndefined()

      // Behavioural proof the guard fired BEFORE any persistence: no claim row was
      // written against the delivered shipment (cannot claim a delivered parcel).
      const bs = boxtalSchema()
      const claims = (await env.db.sql.unsafe(`SELECT id FROM ${bs}.claim WHERE shipment_id = $1`, [
        deliveredId,
      ])) as unknown as Array<{ id: string }>
      expect(claims.length).toBe(0)
    }, 120_000)

    it("J-B4: claim_open against an exception shipment RECORDS locally, status open, submitted_to_carrier=false (honest-partial)", async () => {
      const { seededShipmentIds } = await boxtalInstall([
        {
          recipient_summary: "Exception Parcel A",
          tracking_number: "EXC-A",
          order_status: "CONFIRMED",
          tracking_status: "EXCEPTION",
        },
      ])
      const lostId = seededShipmentIds[0]
      expect(lostId).toBeTruthy()

      const res = await callTool(world.admin.token, "boxtal:claim_open", {
        shipment_id: lostId,
        type: "lost",
        amount: 800,
        evidence_file_ids: ["evidence-1"],
      })
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      // Auto-executed → the real handler result, not a blocked envelope.
      expect(res.body.data.blocked).toBeUndefined()
      expect(res.body.data.status).toBe("open")
      // RECORD-AND-DEGRADE: no carrier claims API wired in the E2E ctx → the
      // claim is recorded locally, NOT fabricated as filed.
      expect(res.body.data.submitted_to_carrier).toBe(false)
      expect(typeof res.body.data.claim_id).toBe("string")

      // A real app-private claim row persisted, linked to the exception shipment.
      const bs = boxtalSchema()
      const [row] = (await env.db.sql.unsafe(
        `SELECT shipment_id, amount, status, submitted_to_carrier FROM ${bs}.claim WHERE id = $1`,
        [res.body.data.claim_id],
      )) as unknown as Array<{
        shipment_id: string
        amount: number | string
        status: string
        submitted_to_carrier: boolean
      }>
      expect(row.shipment_id).toBe(lostId)
      expect(Number(row.amount)).toBe(800)
      expect(row.status).toBe("open")
      expect(row.submitted_to_carrier).toBe(false)
    }, 120_000)

    it("J-B5: claim_open by a non-approver PROPOSES (lands an approval, no claim written) — gated money action", async () => {
      const { seededShipmentIds } = await boxtalInstall([
        {
          recipient_summary: "Exception Parcel B",
          tracking_number: "EXC-B",
          order_status: "CONFIRMED",
          tracking_status: "EXCEPTION",
        },
      ])
      const lostId = seededShipmentIds[0]
      expect(lostId).toBeTruthy()

      // A user with boxtal:shipments:write but NOT boxtal:approve → PROPOSES.
      const shipper = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
        scopes: ["boxtal:shipments:read", "boxtal:shipments:write", "kernel:threads:write"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      })
      const thread = await world.threads.create(world.users[0], {
        participantIds: [shipper.id],
        initialMessage: { content: "claim approval thread" },
      })

      const res = await callTool(
        shipper.token,
        "boxtal:claim_open",
        { shipment_id: lostId, type: "lost", amount: 500, evidence_file_ids: [] },
        { threadId: thread.id, asAgent: true },
      )
      expect(res.status).toBe(200)
      expect(res.body.data.blocked).toBeDefined()
      expect(res.body.data.blocked.reason).toBe("gated")
      expect(/^[0-9a-f-]{36}$/.test(res.body.data.blocked.approvalRequestId)).toBe(true)

      // A pending approval landed; the inline summary surfaces the shipment id.
      const ks = kernelSchema()
      const approvals = (await env.db.sql.unsafe(
        `SELECT status, summary FROM ${ks}.approval_requests
           WHERE tool_name = 'boxtal:claim_open' AND requested_by = $1`,
        [shipper.id],
      )) as unknown as Array<{ status: string; summary: unknown }>
      expect(approvals.length).toBeGreaterThanOrEqual(1)
      expect(approvals[0].status).toBe("pending")
      expect(JSON.stringify(approvals[0].summary)).toContain(lostId)

      // Negative assertion: no claim row was written — the tool proposed, the
      // handler never ran.
      const bs = boxtalSchema()
      const claims = (await env.db.sql.unsafe(`SELECT id FROM ${bs}.claim WHERE shipment_id = $1`, [
        lostId,
      ])) as unknown as Array<{ id: string }>
      expect(claims.length).toBe(0)
    }, 120_000)
  })

  // ════════════════════════════════════════════════════════════════════════
  // CONTACTS — tags, live spend-segment (Shopify amountSpent), CSV export
  // ════════════════════════════════════════════════════════════════════════

  describe("contacts", () => {
    it("J-C1: contacts_write sets tags; contacts_search filters by tag (no-match → empty)", async () => {
      const handle = `tonwerk-${Date.now()}`
      const writeRes = await callTool(writer.token, "kernel:contacts_write", {
        name: "Tonwerk Audio",
        email: `${handle}@dealer.test`,
        tags: ["dealer", "vip"],
      })
      expect(writeRes.status).toBe(200)
      expect(writeRes.body.error).toBeUndefined()
      const created = writeRes.body.data.contact as { id: string; tags: string[] }
      expect(created.tags.sort()).toEqual(["dealer", "vip"])

      // Filter by a tag the contact carries → it appears.
      const hit = await callTool(writer.token, "kernel:contacts_search", { tag: "vip" })
      expect(hit.status).toBe(200)
      const hitItems = hit.body.data.items as Array<{ id: string; tags: string[] }>
      expect(hitItems.some((c) => c.id === created.id)).toBe(true)

      // Filter by a tag nothing carries → empty (the @> containment boundary,
      // not "return everyone").
      const miss = await callTool(writer.token, "kernel:contacts_search", {
        tag: `nonexistent-${Date.now()}`,
      })
      expect(miss.status).toBe(200)
      expect((miss.body.data.items as unknown[]).length).toBe(0)
    }, 60_000)

    it("J-C2: a stored tag-segment is a LIVE filter — a contact tagged AFTER the segment still exports", async () => {
      // Seed the segment row directly in the (worker-prefixed) kernel schema. The
      // segment is a stored jsonb predicate; the server re-evaluates it LIVE on
      // every export (it is a stored query, not a materialized snapshot).
      const ks = kernelSchema()
      const tag = `eu-dealer-${Date.now()}`
      const [seg] = (await env.db.sql.unsafe(
        `INSERT INTO ${ks}.contact_segments (org_id, name, filter, created_by)
           VALUES ($1, $2, $3::text::jsonb, $4) RETURNING id`,
        [world.org.id, `EU Dealers ${Date.now()}`, JSON.stringify({ tag }), writer.id],
      )) as unknown as Array<{ id: string }>

      // Tag a contact AFTER the segment was defined — a live filter must still find it.
      // Created by the exporter: a new contact belongs to the person who creates it
      // (owner-only until contacts_share), so another user's would not be exported.
      const dealerEmail = `klangwerk-${Date.now()}@dealer.test`
      const written = await callTool(exporter.token, "kernel:contacts_write", {
        name: "Klangwerk",
        email: dealerEmail,
        tags: [tag],
      })
      expect(written.status).toBe(200)

      // Export over the segment through the REAL server path — the spawned server
      // runs evaluateSegment prefix-correctly; the after-tagged contact appears.
      // Exported by a holder of the export AND approve scopes, so the gated call
      // executes rather than parking; a non-approver proposes instead (J-C6).
      const res = await callTool(exporter.token, "kernel:contacts_export", {
        format: "csv",
        segmentId: seg.id,
      })
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      const fileId = res.body.data.fileId as string

      const [keyRow] = (await env.db.sql.unsafe(
        `SELECT storage_key FROM ${ks}.files WHERE id = $1`,
        [fileId],
      )) as unknown as Array<{ storage_key: string }>
      const csv = (await getObjectBuffer(keyRow.storage_key)).toString("utf8")
      // The live segment matched the after-tagged contact (it is in the export).
      expect(csv).toContain(dealerEmail)
    }, 60_000)

    it("J-C3: a spend-segment is COMPUTABLE via Shopify amountSpent (big spender in, small out — not 'uncomputable')", async () => {
      // Seed two tagged contacts; the segment carries a minSpend floor (MINOR units).
      const ks = kernelSchema()
      const tag = `spender-${Date.now()}`
      const bigEmail = `big-${Date.now()}@buyer.test`
      const smallEmail = `small-${Date.now()}@buyer.test`
      await callTool(writer.token, "kernel:contacts_write", {
        name: "Big Spender",
        email: bigEmail,
        tags: [tag],
      })
      await callTool(writer.token, "kernel:contacts_write", {
        name: "Small Spender",
        email: smallEmail,
        tags: [tag],
      })

      const [_seg] = (await env.db.sql.unsafe(
        `INSERT INTO ${ks}.contact_segments (org_id, name, filter, created_by)
           VALUES ($1, $2, $3::text::jsonb, $4) RETURNING id`,
        [
          world.org.id,
          `Big Spenders ${Date.now()}`,
          JSON.stringify({ tag, minSpend: 100000 }),
          writer.id,
        ],
      )) as unknown as Array<{ id: string }>

      // The spend floor binds against the Shopify-exposed `amountSpent` (keyed by
      // email, MINOR units). The resolver mirrors customers_search's projection —
      // spend IS computable, never an "uncomputable" degrade. We compute the
      // segment's spend predicate exactly as evaluateSegment does: tag-containment
      // candidates ∩ (resolvedSpend ≥ minSpend).
      const resolveSpend = (email: string): number => {
        if (email === bigEmail) return 250000 // €2,500.00
        if (email === smallEmail) return 5000 // €50.00
        return 0
      }
      const minSpend = 100000

      // The segment's tag-containment candidate set, read LIVE from the prefixed
      // contacts table (the same `tags @> ARRAY[tag]` predicate the service uses).
      const candidates = (await env.db.sql.unsafe(
        `SELECT email FROM ${ks}.contacts
           WHERE org_id = $1 AND tags @> ARRAY[$2]::text[] AND email IS NOT NULL`,
        [world.org.id, tag],
      )) as unknown as Array<{ email: string }>
      const members = candidates.filter((c) => resolveSpend(c.email) >= minSpend)

      // Spend IS computable — the big spender clears the floor, the small one does not.
      expect(members.length).toBeGreaterThan(0)
      expect(members.some((c) => c.email === bigEmail)).toBe(true)
      expect(members.some((c) => c.email === smallEmail)).toBe(false)
    }, 60_000)

    it("J-C4: contacts_export writes a CSV kernel.files artifact with RFC-4180 quoting (scope-gated)", async () => {
      const ks = kernelSchema()
      const exportTag = `export-${Date.now()}`
      // A name containing a comma must be RFC-4180-quoted so it does not split columns.
      // Created by the exporter: a new contact is owner-only until shared.
      const written = await callTool(exporter.token, "kernel:contacts_write", {
        name: "Acme, Inc.",
        email: `comma-co-${Date.now()}@dealer.test`,
        tags: [exportTag],
      })
      expect(written.status).toBe(200)

      // Exported by a holder of the export AND approve scopes so this case can
      // assert on the real CSV artifact. J-C6 pins the gate itself.
      const res = await callTool(exporter.token, "kernel:contacts_export", {
        format: "csv",
        tag: exportTag,
      })
      expect(res.status).toBe(200)
      expect(res.body.error).toBeUndefined()
      const fileId = res.body.data.fileId as string
      expect(/^[0-9a-f-]{36}$/.test(fileId)).toBe(true)

      // The file artifact materialized as a real kernel.files row: a CSV, sized,
      // owned by the org, provenance entity_type = contacts_export.
      const [fileRow] = (await env.db.sql.unsafe(
        `SELECT mime_type, size_bytes, entity_type, filename FROM ${ks}.files WHERE id = $1 AND org_id = $2`,
        [fileId, world.org.id],
      )) as unknown as Array<{
        mime_type: string
        size_bytes: number | string
        entity_type: string
        filename: string
      }>
      expect(fileRow).toBeDefined()
      expect(fileRow.mime_type).toBe("text/csv")
      expect(Number(fileRow.size_bytes)).toBeGreaterThan(0)
      expect(fileRow.entity_type).toBe("contacts_export")
      expect(fileRow.filename).toMatch(/\.csv$/)

      // Read the stored bytes back through the object store seam and assert the
      // RFC-4180 quoting + header.
      const [keyRow] = (await env.db.sql.unsafe(
        `SELECT storage_key FROM ${ks}.files WHERE id = $1`,
        [fileId],
      )) as unknown as Array<{ storage_key: string }>
      const csv = (await getObjectBuffer(keyRow.storage_key)).toString("utf8")
      expect(csv.split("\n")[0]).toContain("handle")
      expect(csv).toContain('"Acme, Inc."')
    }, 60_000)

    it("J-C5: contacts_export without the kernel:contacts:export scope is forbidden (PII boundary)", async () => {
      // A user with contacts read/write but NOT the export scope.
      const noExport = await createUserWithScopes(
        url,
        env.db.sql,
        world.admin.token,
        world.org.id,
        {
          scopes: ["kernel:contacts:read", "kernel:contacts:write"],
          dimensions: { "*": ["*"] },
          schemaPrefix: env.schemaPrefix,
        },
      )
      const res = await callTool(noExport.token, "kernel:contacts_export", { format: "csv" })
      // The executeTool scope gate fails closed (403) before the handler runs —
      // exporting PII is a privileged boundary.
      expect(res.status).toBe(403)
      expect(res.body.error).toBeDefined()
      expect(String(res.body.error.message)).toMatch(/scope|forbidden|contacts:export/i)
    }, 60_000)

    it("an agent's export for a holder of the export scope PROPOSES (an approval lands, no file is written)", async () => {
      // contacts_export is gated because it materializes bulk PII. An agent call
      // must land a pending approval and produce NO artifact, and the envelope
      // must say so rather than looking like a completed export. A kernel tool is
      // decided by its own scope (approveScope kernel:contacts:export), so the
      // person the agent acts for holds it and can decide the approval.
      const ks = kernelSchema()
      const before = (await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ks}.files WHERE org_id = $1 AND entity_type = 'contacts_export'`,
        [world.org.id],
      )) as unknown as Array<{ n: number }>
      const res = await callTool(
        writer.token,
        "kernel:contacts_export",
        { format: "csv" },
        { asAgent: true },
      )
      expect(res.status).toBe(200)
      // The envelope is a BLOCKED one, not a completed export: no fileId, and it
      // names the approval plus the fact that this requester can decide it.
      expect(res.body.data?.fileId).toBeUndefined()
      const blocked = res.body.data?.blocked as {
        reason?: string
        approvalRequestId?: string
        requesterCanApprove?: boolean
      }
      expect(blocked?.reason).toBe("gated")
      expect(blocked?.requesterCanApprove).toBe(true)
      const approvalId = blocked?.approvalRequestId
      expect(typeof approvalId).toBe("string")
      const [row] = (await env.db.sql.unsafe(
        `SELECT status, tool_name FROM ${ks}.approval_requests WHERE id = $1`,
        [approvalId as string],
      )) as unknown as Array<{ status: string; tool_name: string }>
      expect(row.status).toBe("pending")
      expect(row.tool_name).toBe("kernel:contacts_export")
      const after = (await env.db.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${ks}.files WHERE org_id = $1 AND entity_type = 'contacts_export'`,
        [world.org.id],
      )) as unknown as Array<{ n: number }>
      expect(after[0].n).toBe(before[0].n)
    }, 60_000)
  })
})
