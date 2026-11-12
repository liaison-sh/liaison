// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SCOPE TAINT BLOCKED EVERY READ AFTER THE FIRST (live QA walk, 2026-09-22).
//
// Once a turn, or any earlier turn of the same thread, had read scoped data, every tool not
// marked readOnly was refused with E_SCOPE_TAINT_BLOCKED "would write (undeclared)": kpi_run,
// the database connector's reads, projects get/comments, and gated writes such as
// kpi_propose_edit, even in a DM between an admin holding every scope and the agent. The
// refusal blamed "room members" the check never looked at.
//
// What the rule is for (scope-taint.ts header): data read under S must not reach a sink
// readable by someone lacking S. The cases below pin the repaired behaviour through the real
// chat seam (buildToolSet's execute closure, then executeToolCore), with the real in-tree
// manifests for projects and database and the marks of a kpi app's manifest:
//
//   1. read then read, in one turn and in the next turn of the same thread, runs;
//   2. a gated write in a DM with a fully scoped user parks an approval, routed only to
//      approvers who hold what the turn read;
//   3. the same gated write in a shared thread where a member lacks the scope is refused,
//      and the refusal says who lacks what;
//   4. an ungated write to a table every app reader sees is still refused (the property).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps } from "~/modules/apps/runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000d7a01"
const USER = "00000000-0000-4000-8000-0000000d7a02"
const OTHER = "00000000-0000-4000-8000-0000000d7a03"
const APPROVER_OK = "00000000-0000-4000-8000-0000000d7a04"
const APPROVER_NO = "00000000-0000-4000-8000-0000000d7a05"
const DM = "00000000-0000-4000-8000-0000000d7a06"
const SHARED = "00000000-0000-4000-8000-0000000d7a07"

const KPI_READ = "kpi:metrics:read"

// The marks a kpi app's manifest declares (the app is not bundled with this
// repository): what the registry would carry for its read tools.
const KPI_MANIFEST: {
  tools: Record<string, { requiredScopes: string[]; readOnly?: boolean; gated?: boolean }>
} = {
  tools: {
    kpi_list_hubs: { requiredScopes: [KPI_READ], readOnly: true },
    kpi_run: { requiredScopes: [KPI_READ], readOnly: true },
  },
}

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

const ran: string[] = []

function spyOn(app: string, name: string) {
  const real = toolRegistry.get([ORG, app, name])
  if (!real) throw new Error(`${app}:${name} is not registered`)
  toolRegistry.set([ORG, app, name], {
    ...real,
    params: z.object({}).passthrough(),
    handler: async () => {
      ran.push(`${app}:${name}`)
      return { ok: true }
    },
  })
}

/** A kpi tool carrying exactly the manifest's scope, readOnly and gated marks. */
function kpiTool(name: string) {
  const m = KPI_MANIFEST.tools[name]
  if (!m) throw new Error(`kpi manifest has no ${name}`)
  toolRegistry.set([ORG, "kpi", name], {
    appName: "kpi",
    name,
    description: name,
    requiredScopes: m.requiredScopes,
    ...(m.readOnly === true ? { readOnly: true } : {}),
    ...(m.gated === true ? { gated: true } : {}),
    params: z.object({}).passthrough(),
    handler: async () => {
      ran.push(`kpi:${name}`)
      return { ok: true }
    },
  } as never)
}

function turnFrame(injected: string[] = []): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  // What context assembly does with an earlier message of the thread read as history.
  turnScopeAccumulator.recordInjected(injected)
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, turnScopeAccumulator }
}

async function call(
  frame: RunContext,
  threadId: string | undefined,
  sdkName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(ORG, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

function refused(r: Record<string, unknown>): boolean {
  if (r.code === "E_SCOPE_TAINT_BLOCKED") return true
  return typeof r.error === "string" && r.error.includes("E_SCOPE_TAINT_BLOCKED")
}

function refusalText(r: Record<string, unknown>): string {
  return JSON.stringify(r)
}

async function grant(userId: string, scopes: string[]) {
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

describe("scope taint: reads run, gated writes park for a scoped audience", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Taint Reads Org', 'taint-reads-org') ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [USER, "taint-reads-user@test.com"],
      [OTHER, "taint-reads-other@test.com"],
      [APPROVER_OK, "taint-reads-ok@test.com"],
      [APPROVER_NO, "taint-reads-no@test.com"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    // The admin in the DM holds everything; the colleague in the shared thread can read
    // the audience app but not the KPIs; two approvers, only one of whom may see KPIs.
    await grant(USER, ["*"])
    // The colleague also reads projects, so the projects table has a reader lacking the KPIs
    // (a table is judged by its readers, scope-taint.ts rule 6a).
    await grant(OTHER, ["aud:items:read", "projects:projects:read"])
    await grant(APPROVER_OK, ["aud:approve", KPI_READ])
    await grant(APPROVER_NO, ["aud:approve"])
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'taint-reads-dm', 'agent_chat', ${USER}),
             (${SHARED}, ${ORG}, 'taint-reads-shared', 'thread', ${USER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${DM}, ${USER}, ${ORG}, 'admin'),
             (${SHARED}, ${USER}, ${ORG}, 'admin'),
             (${SHARED}, ${OTHER}, ${ORG}, 'member')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${DM}, ${ORG}), (${USER}, ${SHARED}, ${ORG}), (${OTHER}, ${SHARED}, ${ORG})
      ON CONFLICT DO NOTHING`

    await ensureAppsForOrg(ORG)
    for (const name of [
      "get",
      "comments",
      "search",
      "comment",
      "checklist_set_validation",
      "create",
      "checklist_update_item",
      "createProject",
    ]) {
      spyOn("projects", name)
    }
    // The database app is a catalog app: registered for this org from its package's manifest.
    const dbManifest = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../../../bundled-apps/database/app.manifest.json"),
        "utf8",
      ),
    ) as { version: string }
    await registerApps(
      [
        {
          ...dbManifest,
          trusted: false,
          _firstParty: true,
          _format: "manifest",
          _bundlePath: join(import.meta.dir, "../../../../../bundled-apps/database/bundle.js"),
        },
      ] as never,
      ORG,
    )
    for (const name of ["db_list_reads", "db_read", "db_describe"]) spyOn("database", name)
    for (const name of ["kpi_list_hubs", "kpi_run"]) kpiTool(name)

    // A gated write (the kpi_propose_edit shape) and an ungated write to an app table.
    toolRegistry.set([ORG, "aud", "propose"], {
      appName: "aud",
      name: "propose",
      description: "gated proposal",
      requiredScopes: ["aud:items:write"],
      gated: true,
      params: z.object({ note: z.string() }),
      handler: async () => {
        ran.push("aud:propose")
        return { ok: true }
      },
    } as never)
    toolRegistry.set([ORG, "aud", "write"], {
      appName: "aud",
      name: "write",
      description: "ungated write to an app table",
      requiredScopes: ["aud:items:write"],
      writesToTable: "app_aud.items",
      params: z.object({}).passthrough(),
      handler: async () => {
        ran.push("aud:write")
        return { ok: true }
      },
    } as never)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("kpi_list_hubs then kpi_run in one turn: both run", async () => {
    ran.length = 0
    const frame = turnFrame()
    const hubs = await call(frame, DM, "kpi__kpi_list_hubs")
    expect(frame.turnScopeAccumulator?.snapshot()).toContain(KPI_READ)
    const run = await call(frame, DM, "kpi__kpi_run")
    expect(refused(hubs)).toBe(false)
    expect(refused(run)).toBe(false)
    expect(ran).toEqual(["kpi:kpi_list_hubs", "kpi:kpi_run"])
  })

  it("the next turn of the same thread: its FIRST call, a kpi_run, runs", async () => {
    ran.length = 0
    // The previous turn's reply carries requiredScopes [kpi:metrics:read] and is read back as
    // history, so this turn starts tainted before it calls anything.
    const frame = turnFrame([KPI_READ])
    const run = await call(frame, DM, "kpi__kpi_run")
    expect(refused(run)).toBe(false)
    expect(ran).toEqual(["kpi:kpi_run"])
  })

  it("projects get/comments and the database reads run on a tainted turn", async () => {
    ran.length = 0
    const frame = turnFrame([KPI_READ])
    const results = [
      await call(frame, DM, "projects__search"),
      await call(frame, DM, "projects__get"),
      await call(frame, DM, "projects__comments"),
      await call(frame, DM, "database__db_list_reads"),
      await call(frame, DM, "database__db_read"),
      await call(frame, DM, "database__db_describe"),
    ]
    for (const r of results) expect(refused(r)).toBe(false)
    expect(ran).toEqual([
      "projects:search",
      "projects:get",
      "projects:comments",
      "database:db_list_reads",
      "database:db_read",
      "database:db_describe",
    ])
  })

  it("after a scoped read, a task comment, a checklist validation and a new task run", async () => {
    ran.length = 0
    const frame = turnFrame()
    await call(frame, SHARED, "kpi__kpi_run")
    expect(frame.turnScopeAccumulator?.snapshot()).toContain(KPI_READ)
    const results = [
      await call(frame, SHARED, "projects__comment"),
      await call(frame, SHARED, "projects__checklist_set_validation"),
      await call(frame, SHARED, "projects__create"),
      await call(frame, SHARED, "projects__checklist_update_item"),
    ]
    for (const r of results) expect({ r, refused: refused(r) }).toEqual({ r, refused: false })
    expect(ran).toEqual([
      "kpi:kpi_run",
      "projects:comment",
      "projects:checklist_set_validation",
      "projects:create",
      "projects:checklist_update_item",
    ])
  })

  it("after a scoped read, creating a project is still refused: only task tables are low sensitivity", async () => {
    ran.length = 0
    const frame = turnFrame()
    await call(frame, SHARED, "kpi__kpi_run")
    const r = await call(frame, SHARED, "projects__createProject")
    expect(refused(r)).toBe(true)
    expect(refusalText(r)).toContain("app_projects.projects")
    expect(ran).toEqual(["kpi:kpi_run"])
  })

  it("a gated write in a DM with a fully scoped user parks an approval routed to approvers holding the scope", async () => {
    ran.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    const frame = turnFrame()
    await call(frame, DM, "kpi__kpi_run")
    const proposal = await call(frame, DM, "aud__propose", { note: "raise the floor" })
    expect(refused(proposal)).toBe(false)
    expect(proposal.blocked).toBe(true)
    // Parked, never run inline.
    expect(ran).toEqual(["kpi:kpi_run"])
    const [row] = (await sql`SELECT status, notify_user_ids, proposing_turn_scopes
      FROM kernel.approval_requests WHERE id = ${proposal.approvalRequestId as string}`) as Array<{
      status: string
      notify_user_ids: string[]
      proposing_turn_scopes: string[] | null
    }>
    expect(row?.status).toBe("pending")
    expect(row?.proposing_turn_scopes).toContain(KPI_READ)
    // The approver who may not see KPIs is not routed a payload built from them.
    expect(row?.notify_user_ids).toContain(USER)
    expect(row?.notify_user_ids).toContain(APPROVER_OK)
    expect(row?.notify_user_ids).not.toContain(APPROVER_NO)
  })

  it("the same gated write in a shared thread where a member lacks the scope is refused, naming who lacks what", async () => {
    ran.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    const frame = turnFrame()
    await call(frame, SHARED, "kpi__kpi_run")
    const proposal = await call(frame, SHARED, "aud__propose", { note: "raise the floor" })
    expect(refused(proposal)).toBe(true)
    const text = refusalText(proposal)
    expect(text).toContain(KPI_READ)
    expect(text).toContain("at least one human member of it does not hold")
    expect(text).not.toContain("room members lack")
    // A refusal by design is a 4xx: the tool bridge logs 4xx at warn, while a
    // statusless refusal came through as HTTP 500 and paged the watchdog.
    expect(text).toContain("HTTP 403 E_SCOPE_TAINT_BLOCKED")
    expect(ran).toEqual(["kpi:kpi_run"])
    const rows = await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(rows).toHaveLength(0)
  })

  it("an ungated write to an app table parks in the DM instead of running, and its card says where the data would go (rule 8)", async () => {
    ran.length = 0
    const frame = turnFrame()
    await call(frame, DM, "kpi__kpi_run")
    const write = await call(frame, DM, "aud__write")
    expect(refused(write)).toBe(false)
    expect(write.blocked).toBe(true)
    expect(write.status).toBe("pending_approval")
    const text = JSON.stringify(write)
    expect(text).toContain("some people who can read app_aud.items cannot see")
    expect(text).toContain("kpi data")
    expect(ran).toEqual(["kpi:kpi_run"])
  })
})
