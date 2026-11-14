// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month's timesheet filed on an invoice draft, on the real database with the invoicing app
// registered from source: Create invoice on a card of a project with dated hours files the sheet
// with the draft (marked partial when it is), and "Attach to invoice" on the timesheet tab files
// the sheet that same call exported, never a file the caller names.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { reconcileCreateInvoice, reconcilePropose } from "~/apps/projects/handlers"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { seedContext } from "~/seed/context"
import { seedCompanies } from "~/seed/factories/people/companies"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const FINANCE = [
  "projects:*",
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:approve",
]

let orgId = ""
let owner: minimal.Session
let thread = ""
let delorme = ""

function actorOf(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

type Handler = (params: unknown, ctx: never) => Promise<unknown>

/** A projects handler run as the owner, one short transaction per bridge call. */
async function run<T = Record<string, any>>(handler: Handler, input: unknown): Promise<T> {
  const a = actorOf(owner.userId, FINANCE)
  const bridge = createSessionRpcBridge(
    "projects",
    a.userId,
    orgId,
    createRlsSession(a),
    projectsAppManifest as never,
    a.scopes,
    "user",
    undefined,
    { origin: "human-ui", threadId: thread, humanAuthorized: true } as never,
  )
  const out = (await handler(input, bridge as never)) as T
  await awaitTimeRowWrites()
  return out
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actorOf(owner.userId, ["*"])
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
  await awaitTimeRowWrites()
  return out
}

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

let keys = 0
/**
 * A project billed by the day with dated hours on, two tasks closed in October and time entered
 * on the sheet for the first only (so October's sheet is partial, 1 of 2), and its card.
 */
async function datedOctober() {
  keys++
  const key = `SHEET${keys}`
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Maison Delorme ${key}`,
    key,
    companyId: delorme,
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis: "daily", datedHours: true })
  await call("projects_billingTermsSet", { projectId: made.id, rate: 930, currency: "EUR" })
  const ids: string[] = []
  for (const [title, box] of [
    ["Data export", 3],
    ["Monitoring", 4],
  ] as const) {
    const task = await call<{ id: string }>("projects_createTask", {
      projectId: made.id,
      title,
      statusLabel: "done",
      timebox: `${box} days`,
    })
    ids.push(task.id)
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-10-20 10:00+00'::timestamptz WHERE id = ${task.id}::uuid`,
    )
  }
  const took = await call("projects_taskTimeSet", {
    taskId: ids[0],
    time: "3 days",
    date: "2026-10-12",
  })
  expect(took.error).toBeUndefined()
  const card = await run(reconcilePropose, {
    project: key,
    month: "2026-10",
    lines: [
      { name: "Data export", taskIds: [ids[0]], proofs: [] },
      { name: "Monitoring", taskIds: [ids[1]], proofs: [] },
    ],
  })
  if (card.error) throw new Error(`no card: ${JSON.stringify(card.error)}`)
  return { projectId: made.id, key, card }
}

const attachmentsOf = (documentId: string) =>
  db
    .execute(drizzleSql`
      SELECT a.kind, a.partial, a.file_id::text AS file_id, f.copied_from_id::text AS source
        FROM app_invoicing.document_attachments a
        LEFT JOIN kernel.files f ON f.id = a.file_id
       WHERE a.document_id = ${documentId}::uuid ORDER BY a.created_at`)
    .then((r) =>
      extractRows<{ kind: string; partial: boolean; file_id: string; source: string | null }>(r),
    )

const purposeOf = (fileId: string | null) =>
  db
    .execute(drizzleSql`
      SELECT uploaded_by::text AS by, filename FROM kernel.files WHERE id = ${fileId}::uuid`)
    .then((r) => extractRows<{ by: string; filename: string }>(r)[0])

async function rest(path: string, body: unknown) {
  const res = await app.request(`/api/projects${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } }
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  thread = await minimal.thread(orgId, owner.userId)
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  await registerApps([invoicingDescriptor() as never], orgId)
  await primeOrgApps(orgId, 0)
  const ctx = seedContext({ orgId, now: new Date() })
  const companies = await seedCompanies(
    ctx,
    actorOf(owner.userId, ["*"]),
    [{ key: "delorme", name: "Maison Delorme", domain: "delorme.example" }],
    {},
  )
  delorme = companies.delorme!
  const issuer = await executeTool<Record<string, unknown>>({
    toolName: "invoicing:settings_issuer_profile_create",
    orgId,
    actor: actorOf(owner.userId, ["invoicing:*"]),
    params: {
      legal_name: "Studio Issuer SAS",
      country: "FR",
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      default_currency: "EUR",
      default_language: "en",
    },
    threadId: thread,
    origin: "human-ui",
  })
  if (!(issuer.data as { id?: string } | undefined)?.id) {
    throw new Error(`no issuer profile: ${JSON.stringify(issuer)}`)
  }
}, 300_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("the month's timesheet on the draft", () => {
  it("the sheet is filed on the draft and marked partial when it is", async () => {
    const p = await datedOctober()
    const created = await run(reconcileCreateInvoice, {
      reconciliationId: p.card.reconciliationId,
      revision: p.card.revision,
    })
    expect(created.error).toBeUndefined()
    expect(created.message).toContain("The month's timesheet is filed on it, marked partial")
    const files = await attachmentsOf(created.documentId)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ kind: "timesheet", partial: true })
    // The annex is a copy of the sheet exported for the person in that same call.
    const source = await purposeOf(files[0]!.source)
    expect(source?.by).toBe(owner.userId)
    expect(source?.filename).toContain("dated-hours-2026-10")

    // From the timesheet tab: a partial sheet asks once, then files the sheet it exports.
    const asked = await rest(`/${p.projectId}/timesheet/attach`, {
      documentId: created.documentId,
      month: "2026-10",
    })
    expect(asked.status).toBe(200)
    expect(asked.body.data).toMatchObject({ needsConfirm: true, filed: false })
    expect(await attachmentsOf(created.documentId)).toHaveLength(1)
    const filed = await rest(`/${p.projectId}/timesheet/attach`, {
      documentId: created.documentId,
      month: "2026-10",
      acceptPartial: true,
    })
    expect(filed.status).toBe(200)
    expect(filed.body.data).toMatchObject({ filed: true, partial: true })
    const after = await attachmentsOf(created.documentId)
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({ kind: "timesheet", partial: true })
  })

  it("only the sheet just exported can be filed from the timesheet", async () => {
    const p = await datedOctober()
    const created = await run(reconcileCreateInvoice, {
      reconciliationId: p.card.reconciliationId,
      revision: p.card.revision,
    })
    expect(created.error).toBeUndefined()
    const before = await attachmentsOf(created.documentId)
    // Some other file of the org, named by the caller: the route takes no file at all.
    const other = before[0]!.file_id
    const refused = await rest(`/${p.projectId}/timesheet/attach`, {
      documentId: created.documentId,
      month: "2026-10",
      acceptPartial: true,
      fileId: other,
    })
    expect(refused.status).toBe(400)
    expect(await attachmentsOf(created.documentId)).toHaveLength(before.length)
  })
})
