// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recurring schedules on the real kernel and Postgres: who parks, who runs, what an org
// auto-approve policy cannot turn on, what a least-privilege member can reach.
//
// The bundled app is sandboxed, so the unit suite proves the rules against an in-memory store and
// this file proves the seam: the approval gate, the stage-time refusals, the `day` columns read
// back, the documents scope on the tables and the approver recorded on automatic issuing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

const ORG = "00000000-0000-4000-8000-0000000e7001"
const STAFF = "00000000-0000-4000-8000-0000000e7002"
const OUTSIDER = "00000000-0000-4000-8000-0000000e7003"
const READER = "00000000-0000-4000-8000-0000000e7007"
const THREAD = "00000000-0000-4000-8000-0000000e7004"
const CONTACT = "00000000-0000-4000-8000-0000000e7005"
const ISSUER = "00000000-0000-4000-8000-0000000e7006"

// A billing clerk: reads and writes documents, reads the issuer settings, decides invoicing
// approvals. No wildcard.
const STAFF_SCOPES = [
  "invoicing:documents:write",
  "invoicing:documents:read",
  "invoicing:settings:read",
  "invoicing:approve",
]
const READER_SCOPES = ["invoicing:documents:read"]
const actor = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})
const staff = actor(STAFF, STAFF_SCOPES)
const outsider = actor(OUTSIDER, [])
const reader = actor(READER, READER_SCOPES)

const lines = [
  { description: "Support plan {period}", qty: 1, unit_price_minor: 4900, vat_bp: 2000 },
]
const schedule = {
  issuer_profile_id: ISSUER,
  contact_id: CONTACT,
  repeats: "month",
  billing_day: "last",
  lines,
}

const rows = () =>
  sql<Array<Record<string, unknown>>>`
    SELECT id::text, status, issue_mode, version, auto_enabled_by::text, next_issue_on::text, next_draft_on::text, created_by
      FROM app_invoicing.recurring_schedules WHERE org_id = ${ORG} ORDER BY created_at`

type Outcome = { data?: unknown; blocked?: { approvalRequestId?: string }; error?: string }

/** A refused call throws; the test reads the refusal as text (message and code) instead. */
async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return (await run()) as Outcome
  } catch (err) {
    const e = err as { message?: string; details?: { code?: string } }
    return { error: `${e.details?.code ?? ""} ${e.message ?? String(err)}` }
  }
}
const agentCall = (toolName: string, params: Record<string, unknown>) =>
  outcome(() =>
    executeTool({
      toolName,
      orgId: ORG,
      actor: staff,
      params,
      threadId: THREAD,
      origin: "in-app-agent",
    }),
  )
const personClick = (toolName: string, params: Record<string, unknown>, as: UserContext = staff) =>
  outcome(() => executeTool({ toolName, orgId: ORG, actor: as, params, origin: "human-ui" }))
async function approve(requestId: string) {
  return decideApproval({ orgId: ORG, requestId, actor: staff, decision: "approve" })
}
const blockedId = (res: Outcome): string | undefined => res.blocked?.approvalRequestId

describe("recurring schedules on the real kernel", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Recurring Tools Org', 'recurring-tools-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, mail] of [
      [STAFF, "staff"],
      [OUTSIDER, "outsider"],
      [READER, "reader"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
        VALUES (${id}, ${ORG}, ${`recurring-${mail}@test.com`}, 'hash', ${`Recurring ${mail}`}, 'active') ON CONFLICT (id) DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD}, ${ORG}, 'recurring-tools-thread', 'agent_chat', ${STAFF}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${THREAD}, ${STAFF}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${STAFF}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    for (const scope of STAFF_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${STAFF}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    for (const scope of READER_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${READER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
    await sql`INSERT INTO app_invoicing.issuer_profiles (id, org_id, legal_name, country, default_currency, timezone)
      VALUES (${ISSUER}, ${ORG}, 'Recurring Issuer SAS', 'FR', 'EUR', 'Europe/Paris') ON CONFLICT (id) DO NOTHING`
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.recurring_schedules WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await releaseTestLock()
  }, 60_000)

  it("an agent's schedule parks, a person's Start runs, and save refuses a missing customer, date or line before anything parks", async () => {
    const parked = await agentCall("invoicing:recurring_schedule_create", schedule)
    const requestId = blockedId(parked)
    expect(requestId).toBeTruthy()
    expect(await rows()).toHaveLength(0)

    // The same call from a person's click runs at once, as that person.
    const started = await personClick("invoicing:recurring_schedule_create", schedule)
    expect(started.error).toBeUndefined()
    const [row] = await rows()
    expect(row).toMatchObject({
      status: "active",
      issue_mode: "review",
      version: 1,
      created_by: STAFF,
    })
    expect(row?.next_issue_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(String(row?.next_draft_on) <= String(row?.next_issue_on)).toBe(true)

    // Approving the agent's request creates the second schedule.
    await approve(requestId as string)
    expect(await rows()).toHaveLength(2)

    // A missing customer, date or line is refused at the call, with nothing parked and nothing saved.
    const before =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    for (const bad of [
      { ...schedule, contact_id: "" },
      { ...schedule, billing_day: "" },
      { ...schedule, lines: [] },
    ]) {
      const res = await agentCall("invoicing:recurring_schedule_create", bad)
      expect(res.blocked).toBeUndefined()
      expect(res.error).toContain("The schedule was not saved")
    }
    const after =
      await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(after[0]?.n).toBe(before[0]?.n)
    expect(await rows()).toHaveLength(2)
  }, 60_000)

  // Mutation caught: letting create accept issue_mode auto, or dropping noAutoApprove from update.
  it("issue by itself is off by default and only a person's gated change turns it on, whatever the org's auto-approve policy", async () => {
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, created_by)
      VALUES (${ORG}, 'invoicing:recurring_schedule_create', ${STAFF}), (${ORG}, 'invoicing:recurring_schedule_update', ${STAFF})`
    const [first] = await rows()
    const id = first?.id as string
    const total = (await rows()).length

    // Create refuses automatic issuing outright, so the policy has nothing to approve.
    const refused = await agentCall("invoicing:recurring_schedule_create", {
      ...schedule,
      issue_mode: "auto",
    })
    expect(refused.blocked).toBeUndefined()
    expect(refused.error).toContain("cannot issue by itself")
    expect(await rows()).toHaveLength(total)

    // The update parks although the policy names it, and nothing changes until a person approves.
    const parked = await agentCall("invoicing:recurring_schedule_update", {
      id,
      issue_mode: "auto",
    })
    const requestId = blockedId(parked)
    expect(requestId).toBeTruthy()
    expect((await rows()).find((r) => r.id === id)).toMatchObject({
      issue_mode: "review",
      auto_enabled_by: null,
      version: 1,
    })

    await approve(requestId as string)
    expect((await rows()).find((r) => r.id === id)).toMatchObject({
      issue_mode: "auto",
      auto_enabled_by: STAFF,
      version: 2,
    })
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
  }, 60_000)

  it("a pause runs on a clean turn, drops the schedule from what is due, and pausing again writes nothing", async () => {
    const [first] = await rows()
    const id = first?.id as string
    const paused = await agentCall("invoicing:recurring_schedule_pause", { id })
    expect(paused.blocked).toBeUndefined()
    expect(paused.error).toBeUndefined()
    const after = (await rows()).find((r) => r.id === id)
    expect(after?.status).toBe("paused")
    const version = after?.version

    const again = await agentCall("invoicing:recurring_schedule_pause", { id })
    expect(JSON.stringify(again.data)).toContain("unchanged")
    expect((await rows()).find((r) => r.id === id)?.version).toBe(version)

    // `recurring_list` reads the day columns back as plain dates.
    const listed = await personClick("invoicing:recurring_list", { status: "paused" })
    const text = JSON.stringify(listed.data)
    expect(text).toContain(id)
    expect(text).toMatch(/"next_issue_on":"\d{4}-\d{2}-\d{2}"/)
  }, 60_000)

  it("a member with the documents scopes and no wildcard reads the schedules, and a user with none sees none", async () => {
    const ids = (await rows()).map((r) => String(r.id))
    expect(ids.length).toBeGreaterThan(0)
    for (const who of [staff, reader]) {
      const mine = await personClick("invoicing:recurring_list", {}, who)
      expect(mine.error).toBeUndefined()
      for (const id of ids) expect(JSON.stringify(mine.data)).toContain(id)
    }
    // Without the documents scope the tool is refused, or answers with no row: never a leaked id.
    const theirs = await personClick("invoicing:recurring_list", {}, outsider)
    for (const id of ids) expect(JSON.stringify(theirs)).not.toContain(id)

    // A reader cannot save a schedule: the write scope is the tool's own.
    const refused = await personClick("invoicing:recurring_schedule_create", schedule, reader)
    expect(refused.error).toBeTruthy()
    expect(await rows()).toHaveLength(ids.length)
  }, 60_000)
})
