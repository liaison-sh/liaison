// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month's timesheet filed on an invoice draft, on the real database with the invoicing app
// registered from source: Create invoice on a retainer month of a project with dated hours files
// the sheet with the draft (marked partial when it is), once however often Create is pressed; a
// card billed by the day files none; and the only file projects hands invoicing is the sheet that
// same call exported for the person.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
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
import { insertAppRow, jsonCell } from "~/seed/factories/app-tables"
import { seedCompanies } from "~/seed/factories/people/companies"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { addCompanyBillingAddress } from "../../../../test-support/seed/billing-address"
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
let issuerId = ""

function actorOf(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

type Handler = (params: unknown, ctx: never) => Promise<unknown>

/** A projects handler run as the owner, one short transaction per bridge call. */
async function run<T = Record<string, any>>(
  handler: Handler,
  input: unknown,
  patch: (bridge: Record<string, any>) => Record<string, unknown> = () => ({}),
): Promise<T> {
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
  const ctx = bridge as unknown as Record<string, any>
  const out = (await handler(input, { ...ctx, ...patch(ctx) } as never)) as T
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
 * A project with dated hours on, billed by a monthly retainer (the default) or by the day, two
 * tasks closed in October and time entered on the sheet for the first only (so October's sheet is
 * partial, 1 of 2), and its card. A retainer month gets its schedule and October's timebox.
 */
async function datedOctober(basis: "retainer" | "daily" = "retainer") {
  keys++
  const key = `SHEET${keys}`
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Maison Delorme ${key}`,
    key,
    companyId: delorme,
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis, datedHours: true })
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
  if (basis === "retainer") await retainerOctober(made.id)
  return { projectId: made.id, key, card }
}

/** A 40 h retainer schedule on the project and October's timebox from it. */
async function retainerOctober(projectId: string) {
  const schedule = crypto.randomUUID()
  await insertAppRow(db as never, "invoicing", "recurring_schedules", {
    id: schedule,
    org_id: orgId,
    issuer_profile_id: issuerId,
    company_id: delorme,
    status: "active",
    repeats: "month",
    billing_day: "last",
    lines: jsonCell([
      { description: "Monthly retainer", qty: 1, unit_price_minor: 450000, vat_bp: 2000 },
    ]),
    created_by: owner.userId,
    retainer_project_id: projectId,
    retainer_minutes: 2400,
    retainer_overage_rate_minor: 12000,
    retainer_from: "2026-01",
  })
  await insertAppRow(db as never, "projects", "project_timeboxes", {
    id: crypto.randomUUID(),
    org_id: orgId,
    project_id: projectId,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    minutes: 2400,
    source: "retainer",
    source_ref: schedule,
    created_by: owner.userId,
  })
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
    [
      {
        key: "delorme",
        name: "Maison Delorme",
        domain: "delorme.example",
        contactKeys: ["billing"],
        mainContactKey: "billing",
      },
    ],
    {
      billing: await minimal.contact(orgId, "billing@delorme.example", {
        name: "Maison Delorme billing",
      }),
    },
  )
  delorme = companies.delorme!
  await addCompanyBillingAddress(
    actorOf(owner.userId, ["*"]),
    delorme,
    {
      street1: "4 rue des Lilas",
      postalCode: "69002",
      city: "Lyon",
      countryIso2: "FR",
    },
    { siren: "900000001", registryName: "MAISON DELORME" },
  )
  const issuer = await executeTool<Record<string, unknown>>({
    toolName: "invoicing:settings_issuer_profile_create",
    orgId,
    actor: actorOf(owner.userId, ["invoicing:*"]),
    params: {
      legal_name: "Studio Issuer SAS",
      country: "FR",
      legal_form: "SAS",
      share_capital: "10 000",
      rcs_city: "Paris",
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      siren: "902000009",
      address_line1: "1 rue de Test",
      postcode: "75011",
      city: "Paris",
      country_code: "FR",
      default_currency: "EUR",
      default_language: "en",
    },
    threadId: thread,
    origin: "human-ui",
  })
  issuerId = String((issuer.data as { id?: string } | undefined)?.id ?? "")
  if (!issuerId) throw new Error(`no issuer profile: ${JSON.stringify(issuer)}`)
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

    // Create pressed again on the same card: the same draft, and still one sheet on it.
    const again = await run(reconcileCreateInvoice, {
      reconciliationId: p.card.reconciliationId,
      revision: p.card.revision,
    })
    expect(again.error).toBeUndefined()
    expect(again.documentId).toBe(created.documentId)
    expect(await attachmentsOf(created.documentId)).toHaveLength(1)
  })

  it("a card billed by the day gets its report and no timesheet", async () => {
    const p = await datedOctober("daily")
    const exported: string[] = []
    const created = await run(
      reconcileCreateInvoice,
      { reconciliationId: p.card.reconciliationId, revision: p.card.revision },
      (bridge) => ({
        projects_timesheetExport: async (json: string) => {
          exported.push(json)
          return bridge.projects_timesheetExport(json)
        },
      }),
    )
    expect(created.error).toBeUndefined()
    expect(String(created.message)).not.toContain("timesheet")
    expect(exported).toHaveLength(0)
    expect(await attachmentsOf(created.documentId)).toHaveLength(0)
  })

  it("only the sheet the same call exported is handed to invoicing", async () => {
    const p = await datedOctober()
    const exported: string[] = []
    const handed: string[] = []
    const created = await run(
      reconcileCreateInvoice,
      { reconciliationId: p.card.reconciliationId, revision: p.card.revision },
      (bridge) => ({
        projects_timesheetExport: async (json: string) => {
          const out = await bridge.projects_timesheetExport(json)
          exported.push(String((JSON.parse(out) as { fileId?: string }).fileId))
          return out
        },
        executeTool: async (tool: string, json: string) => {
          if (tool === "invoicing:document_attachment_add") {
            handed.push(String((JSON.parse(json) as { fileId?: string }).fileId))
          }
          return bridge.executeTool(tool, json)
        },
      }),
    )
    expect(created.error).toBeUndefined()
    expect(exported).toHaveLength(1)
    expect(handed).toEqual(exported)
    const files = await attachmentsOf(created.documentId)
    expect(files.map((f) => f.source)).toEqual(exported)
  })
})
