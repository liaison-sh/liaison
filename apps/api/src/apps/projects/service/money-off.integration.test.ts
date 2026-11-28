// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Off never traps money, on the real database with the invoicing app registered from source: on
// projects turned off after their cards made drafts, a draft from planned vs done still issues and
// its claims flip, Undo still frees another card's claims, and a billed line is still corrected
// by a credit note.

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
/** A project billed by the day at 930 EUR, two tasks closed in October (3 and 4 days), its card. */
async function october() {
  keys++
  const key = `OFF${keys}`
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Maison Delorme ${key}`,
    key,
    companyId: delorme,
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis: "daily" })
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
  const card = await run(reconcilePropose, {
    project: key,
    month: "2026-10",
    lines: [
      { name: "Data export", taskIds: [ids[0]], proofs: [] },
      { name: "Monitoring", taskIds: [ids[1]], proofs: [] },
    ],
  })
  if (card.error) throw new Error(`no card: ${JSON.stringify(card.error)}`)
  const created = await run(reconcileCreateInvoice, {
    reconciliationId: card.reconciliationId,
    revision: card.revision,
  })
  if (created.error) throw new Error(`no draft: ${JSON.stringify(created.error)}`)
  return { projectId: made.id, key, card, documentId: String(created.documentId) }
}

/** A tool as the owner's own click: its data, or the error it was refused with. */
function click(
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ data?: Record<string, any>; error?: { code?: string; message?: string } }> {
  return executeTool<Record<string, any>>({
    toolName,
    orgId,
    actor: actorOf(owner.userId, FINANCE),
    params,
    threadId: thread,
    origin: "human-ui",
  }).then(
    (out) => ({ data: out.data }),
    (e) => ({ error: e as { code?: string; message?: string } }),
  )
}

const claimsOf = (id: string) =>
  db
    .execute(drizzleSql`
      SELECT state FROM app_projects.billing_claims
       WHERE reconciliation_id = ${id}::uuid ORDER BY state`)
    .then((r) => extractRows<{ state: string }>(r).map((c) => c.state))

const stateOf = (id: string) =>
  db
    .execute(drizzleSql`SELECT state FROM app_projects.reconciliations WHERE id = ${id}::uuid`)
    .then((r) => extractRows<{ state: string }>(r)[0]?.state)

const docOf = (id: string) =>
  db
    .execute(drizzleSql`
      SELECT status, number, external_ref, billing_project_id::text AS project
        FROM app_invoicing.documents WHERE id = ${id}::uuid`)
    .then((r) => extractRows<Record<string, string | null>>(r)[0])

/** The document carrying a card's key: the issued invoice once the draft was issued. */
const docByRef = (ref: string) =>
  db
    .execute(drizzleSql`
      SELECT status, number, external_ref, billing_project_id::text AS project
        FROM app_invoicing.documents
       WHERE org_id = ${orgId}::uuid AND external_ref = ${ref} AND type = 'invoice'`)
    .then((r) => extractRows<Record<string, string | null>>(r)[0])

const featureOn = () =>
  db
    .execute(drizzleSql`
      SELECT enabled FROM kernel.org_app_features
       WHERE org_id = ${orgId}::uuid AND app_name = 'projects' AND feature = 'time_budgets'`)
    .then((r) => extractRows<{ enabled: boolean }>(r)[0]?.enabled ?? false)

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
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      siren: "902000009",
      legal_form: "SAS",
      share_capital: "10 000",
      rcs_city: "Paris",
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

describe("a project turned off", () => {
  it("on a project turned off a draft from planned vs done issues, its claims flip, Undo frees them and a correction works", async () => {
    const issued = await october()
    const undone = await october()
    // Both projects stop using time and budgets: the org's feature goes off with them.
    for (const p of [issued, undone]) {
      const off = await call("projects_updateProject", {
        projectId: p.projectId,
        timeBudgets: false,
      })
      expect(off.error).toBeUndefined()
    }
    await awaitTimeFeatureSync(orgId)
    expect(await featureOn()).toBe(false)

    // The waiting draft issues, its claims flip and the card is invoiced.
    await db.execute(drizzleSql`
      UPDATE app_invoicing.documents
         SET counterparty_name = 'Maison Delorme', counterparty_country = 'DE',
             counterparty_address = 'Hauptstrasse 1, 10115 Berlin',
             counterparty_email = 'billing@delorme.example', counterparty_vat_id = 'DE811907980',
             billing_line1 = 'Hauptstrasse 1', billing_postcode = '10115', billing_city = 'Berlin',
             billing_country_code = 'DE'
       WHERE id = ${issued.documentId}::uuid`)
    const issue = await click("invoicing:invoice_issue", { draft_id: issued.documentId })
    expect(issue.error).toBeUndefined()
    // The issued invoice keeps the card's key and project; the draft row is gone.
    const doc = await docByRef(`reconcile:${issued.card.reconciliationId}:${issued.card.revision}`)
    expect(doc?.status).toBe("issued")
    expect(doc?.number).toBeTruthy()
    expect(doc?.external_ref).toBe(
      `reconcile:${issued.card.reconciliationId}:${issued.card.revision}`,
    )
    expect(doc?.project).toBe(issued.projectId)
    expect(await claimsOf(issued.card.reconciliationId)).toEqual(["billed", "billed"])
    expect(await stateOf(issued.card.reconciliationId)).toBe("invoiced")

    // Undo on the other card frees its claims and discards its draft.
    const undo = await click("projects:reconcile_undo", {
      reconciliationId: undone.card.reconciliationId,
    })
    expect(undo.error).toBeUndefined()
    expect(await claimsOf(undone.card.reconciliationId)).toEqual(["released", "released"])
    expect(await stateOf(undone.card.reconciliationId)).toBe("proposed")
    expect(await docOf(undone.documentId)).toBeUndefined()

    // A billed line is corrected: 3 days to 2, by a credit note citing the invoice.
    const line = issued.card.lines[0].lineId
    const credit = await click("invoicing:credit_note_from_reconcile", {
      reconciliationId: issued.card.reconciliationId,
      lineId: line,
      correctedQuantity: 2,
      reason: "One day was not delivered.",
    })
    expect(credit.error).toBeUndefined()
    expect(credit.data?.status).toBe("completed")
    const after = extractRows<{ after: number | null }>(
      await db.execute(drizzleSql`
        SELECT billed_after_credit_minutes AS after FROM app_projects.reconciliation_lines
         WHERE id = ${line}::uuid`),
    )[0]
    const hpd = extractRows<{ hpd: number }>(
      await db.execute(drizzleSql`
        SELECT create_hours_per_day_minutes AS hpd FROM app_projects.reconciliations
         WHERE id = ${issued.card.reconciliationId}::uuid`),
    )[0]?.hpd
    expect(after?.after).toBe(2 * Number(hpd))
    expect(await claimsOf(issued.card.reconciliationId)).toEqual(["billed", "billed"])
  })
})
