// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Create invoice and Undo on a reconcile card, on the real database, with the invoicing app
// registered from source: the projects handler runs each step in its own short transaction (as
// the core host runs it) around invoicing's preview, draft and discard. No number is ever taken
// here; a person issues the draft.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { CardTemplate, ResolvedCard } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import {
  billingTermsSet,
  reconcileCreateInvoice,
  reconcileFacts,
  reconcileGet,
  reconcileLineUpdate,
  reconcilePropose,
  reconcileUndo,
  updateProject,
} from "~/apps/projects/handlers"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { clearTaintFlag } from "~/modules/agent/scopes/taint"
import { decideApproval } from "~/modules/approvals/decide"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { resolveToolCard } from "~/modules/apps/result-card"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { addAddress } from "~/modules/contacts/addresses"
import { seedContext } from "~/seed/context"
import { type AppCell, insertAppRow, jsonCell } from "~/seed/factories/app-tables"
import { asUser } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { resolveContacts } from "~/seed/factories/people/contacts"
import { seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { reserveClaims } from "./claims"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const HPD = 420
const day = (d: number) => Math.round(d * HPD)

const PROJECTS = ["projects:*"]
const ISSUING = ["invoicing:documents:read", "invoicing:documents:write", "invoicing:settings:read"]
const LEAD = [...PROJECTS, "invoicing:documents:read"]
const FINANCE = [...PROJECTS, ...ISSUING, "invoicing:approve"]

let orgId = ""
let owner: minimal.Session
let otherLead: minimal.Session
let thread = ""
let delorme = ""
let erika = ""
let compta = ""
let solo = ""
let seule = ""
let vide = ""
let nue = ""

function actorOf(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

type Handler = (params: unknown, ctx: never) => Promise<unknown>

/**
 * A projects handler run as a person, as the core host runs it: one short transaction per bridge
 * call, so a step's writes are committed before invoicing reads them.
 */
async function run<T = Record<string, any>>(
  handler: Handler,
  input: unknown,
  opts: {
    userId?: string
    scopes?: string[]
    origin?: string
    patch?: Record<string, unknown>
  } = {},
): Promise<T> {
  const a = actorOf(opts.userId ?? owner.userId, opts.scopes ?? FINANCE)
  const bridge = createSessionRpcBridge(
    "projects",
    a.userId,
    orgId,
    createRlsSession(a),
    projectsAppManifest as never,
    a.scopes,
    "user",
    undefined,
    {
      origin: opts.origin ?? "human-ui",
      threadId: thread,
      // As the core host passes it: a person's own click who holds the tool's approve scope.
      humanAuthorized:
        (opts.origin ?? "human-ui") === "human-ui" &&
        a.scopes.some((s) => s === "*" || s === "projects:*" || s === "projects:approve"),
    } as never,
  )
  const out = (await handler(input, { ...bridge, ...(opts.patch ?? {}) } as never)) as T
  await awaitTimeRowWrites()
  return out
}

/** A projects bridge method as the owner (setup only). */
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

async function invoicing(tool: string, params: Record<string, unknown>, scopes = FINANCE) {
  return executeTool<Record<string, unknown>>({
    toolName: `invoicing:${tool}`,
    orgId,
    actor: actorOf(owner.userId, scopes),
    params,
    threadId: thread,
    origin: "human-ui",
  })
}

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    // The image's own catalog app: what it declares for its approved runs holds.
    _firstParty: true,
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
 * A project billed by the day at 930 EUR, closed in October: Data export planned and spent 3 d,
 * Monitoring 4 d. Answers its id and its card.
 */
async function october(
  opts: {
    basis?: "daily" | "hourly" | "fixed" | "retainer"
    rate?: number | null
    company?: string | null
  } = {},
) {
  keys++
  const key = `INV${keys}`
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Maison Delorme ${key}`,
    key,
    ...(opts.company === null ? {} : { companyId: opts.company ?? delorme }),
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis: opts.basis ?? "daily" })
  if (opts.basis === "fixed") {
    await call("projects_billingTermsSet", {
      projectId: made.id,
      fixedPrice: 6000,
      currency: "EUR",
    })
  } else if (opts.rate !== null) {
    await call("projects_billingTermsSet", {
      projectId: made.id,
      rate: opts.rate ?? 930,
      currency: "EUR",
    })
  }
  const t: Record<string, string> = {}
  for (const [k, box] of [
    ["e", 3],
    ["m", 4],
  ] as const) {
    const task = await call<{ id: string }>("projects_createTask", {
      projectId: made.id,
      title: `Task ${k}`,
      statusLabel: "done",
      timebox: `${box} days`,
    })
    t[k] = task.id
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-10-20 10:00+00'::timestamptz WHERE id = ${task.id}::uuid`,
    )
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId, ["*"]), [
      { taskId: task.id, projectId: made.id, workDate: "2026-10-12", minutes: day(box) },
    ])
  }
  const card = await run(reconcilePropose, {
    project: key,
    month: "2026-10",
    lines: [
      { name: "Data export", taskIds: [t.e], proofs: [{ kind: "task", ref: t.e }] },
      { name: "Monitoring", taskIds: [t.m], proofs: [] },
    ],
  })
  if (card.error) throw new Error(`no card: ${JSON.stringify(card.error)}`)
  return { projectId: made.id, key, card }
}

const docsOf = (projectId: string) =>
  db
    .execute(drizzleSql`
      SELECT id::text AS id, status, number, external_ref, approved_by::text AS approved_by,
             subtotal_minor::text AS excl
        FROM app_invoicing.documents
       WHERE org_id = ${orgId}::uuid AND billing_project_id = ${projectId}::uuid`)
    .then((r) => extractRows<Record<string, string | null>>(r))

const claimsOf = (id: string) =>
  db
    .execute(drizzleSql`
      SELECT state FROM app_projects.billing_claims
       WHERE reconciliation_id = ${id}::uuid ORDER BY state`)
    .then((r) => extractRows<{ state: string }>(r).map((c) => c.state))

const stateOf = (id: string) =>
  db
    .execute(drizzleSql`
      SELECT state, document_ref, document_id::text AS document_id
        FROM app_projects.reconciliations WHERE id = ${id}::uuid`)
    .then(
      (r) =>
        extractRows<{ state: string; document_ref: string | null; document_id: string | null }>(
          r,
        )[0],
    )

const numbersTaken = () =>
  db
    .execute(drizzleSql`
      SELECT count(*)::int AS n FROM app_invoicing.documents
       WHERE org_id = ${orgId}::uuid AND number IS NOT NULL`)
    .then((r) => Number(extractRows<{ n: number }>(r)[0]?.n ?? 0))

const issueApprovals = (draftId: string) =>
  db
    .execute(drizzleSql`
      SELECT status FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:invoice_issue'
         AND current_payload->>'draft_id' = ${draftId}`)
    .then((r) => extractRows<{ status: string }>(r).map((a) => a.status))

const issuerProfileId = () =>
  db
    .execute(drizzleSql`
      SELECT id::text AS id FROM app_invoicing.issuer_profiles WHERE org_id = ${orgId}::uuid LIMIT 1`)
    .then((r) => String(extractRows<{ id: string }>(r)[0]?.id))

/** A buyer's registry identity (its SIREN), as a registry check records it. */
async function registryIdentity(contactId: string, siren: string, name: string) {
  await insertAppRow(db as never, "invoicing", "counterparty_identities", {
    id: crypto.randomUUID(),
    org_id: orgId,
    contact_id: contactId,
    customer_kind: "business",
    siren,
    registry_name: name,
    registry_country_code: "FR",
    registry_status: "A",
    registry_checked_at: "2026-10-01",
    source: "registry",
    confirmed_via: "auto",
    changed_at: "2026-10-01",
  })
}

/** A retainer schedule of 40 h a month at a 4,500.00 fee and 120.00 an hour above it. */
async function retainerSchedule(
  projectId: string,
  from = "2026-01",
  extra: Record<string, AppCell> = {},
): Promise<string> {
  const id = crypto.randomUUID()
  await insertAppRow(db as never, "invoicing", "recurring_schedules", {
    id,
    org_id: orgId,
    issuer_profile_id: await issuerProfileId(),
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
    retainer_from: from,
    ...extra,
  })
  return id
}

/**
 * An issued advance of 4,500.00 + 20% VAT on the project for October, as advance_draft_create
 * dates it, billed to Maison Delorme's accounts desk. Answers its id.
 */
async function issuedAdvance(projectId: string, number: string): Promise<string> {
  const id = crypto.randomUUID()
  await insertAppRow(db as never, "invoicing", "documents", {
    id,
    org_id: orgId,
    type: "invoice",
    status: "issued",
    number,
    year_of_issue: 2026,
    issued_at: "2026-10-01",
    issuer_profile_id: await issuerProfileId(),
    counterparty_contact_id: compta,
    counterparty_name: "Maison Delorme",
    counterparty_address: "4 rue des Lilas, 69002 Lyon",
    counterparty_country: "FR",
    counterparty_email: "compta@delorme.example",
    currency: "EUR",
    invoice_role: "advance",
    billing_project_id: projectId,
    service_period_start: "2026-10-01",
    service_period_end: "2026-10-31",
    subtotal_minor: 450000,
    tax_total_minor: 90000,
    grand_total_minor: 540000,
  })
  await insertAppRow(db as never, "invoicing", "document_lines", {
    id: crypto.randomUUID(),
    org_id: orgId,
    document_id: id,
    position: 1,
    description: "Advance on October",
    quantity: 1,
    unit_price_minor: 450000,
    line_kind: "service",
    tax_rate_bp: 2000,
    subtotal_minor: 450000,
    tax_minor: 90000,
    total_minor: 540000,
  })
  return id
}

async function retainerTimebox(projectId: string, schedule: string, from: string, to: string) {
  await insertAppRow(db as never, "projects", "project_timeboxes", {
    id: crypto.randomUUID(),
    org_id: orgId,
    project_id: projectId,
    period_start: from,
    period_end: to,
    minutes: 2400,
    source: "retainer",
    source_ref: schedule,
    created_by: owner.userId,
  })
}

const create = (card: Record<string, any>, opts: Parameters<typeof run>[2] = {}) =>
  run(
    reconcileCreateInvoice,
    { reconciliationId: card.reconciliationId, revision: card.revision },
    opts,
  )

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  otherLead = await minimal.session(orgId, { role: "admin" })
  thread = await minimal.thread(orgId, owner.userId)
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  await registerApps([invoicingDescriptor() as never], orgId)
  await primeOrgApps(orgId, 0)
  const ctx = seedContext({ orgId, now: new Date() })
  const people = new Map(
    await resolveContacts(ctx, actorOf(owner.userId, ["*"]), [
      { key: "erika", email: "erika@autre.example", name: "Erika Mustermann" },
      { key: "marc", email: "marc@delorme.example", name: "Marc Delorme" },
      { key: "compta", email: "compta@delorme.example", name: "Delorme accounts" },
      { key: "solo", email: "solo@seule.example", name: "Sacha Seule" },
      { key: "nue", email: "nadia@nue.example", name: "Nadia Nue" },
    ]),
  )
  const idOf = (key: string) => people.get(key)!.id
  erika = idOf("erika")
  compta = idOf("compta")
  solo = idOf("solo")
  const companies = await seedCompanies(
    ctx,
    actorOf(owner.userId, ["*"]),
    [
      {
        key: "delorme",
        name: "Maison Delorme",
        domain: "delorme.example",
        contactKeys: ["marc", "compta"],
      },
      { key: "autre", name: "Maison Autre", domain: "autre.example", contactKeys: ["erika"] },
      { key: "seule", name: "Maison Seule", domain: "seule.example", contactKeys: ["solo"] },
      { key: "vide", name: "Maison Vide", domain: "vide.example" },
      { key: "nue", name: "Maison Nue", domain: "nue.example", contactKeys: ["nue"] },
    ],
    { erika, marc: idOf("marc"), compta, solo, nue: idOf("nue") },
  )
  delorme = companies.delorme!
  seule = companies.seule!
  vide = companies.vide!
  nue = companies.nue!
  // Delorme's accounts desk has the billing address; Maison Seule's one person is its main contact.
  await asUser(actorOf(owner.userId, ["*"]), (tx) =>
    addAddress(tx as never, {
      orgId,
      userId: owner.userId,
      contactId: compta,
      fields: {
        role: "billing",
        street1: "4 rue des Lilas",
        postalCode: "69002",
        city: "Lyon",
        countryIso2: "FR",
      },
    }),
  )
  // Maison Seule's one person has an address that is not marked billing.
  await asUser(actorOf(owner.userId, ["*"]), (tx) =>
    addAddress(tx as never, {
      orgId,
      userId: owner.userId,
      contactId: solo,
      fields: {
        role: "other",
        street1: "9 quai Seul",
        postalCode: "13002",
        city: "Marseille",
        countryIso2: "FR",
      },
    }),
  )
  await db.execute(
    drizzleSql`UPDATE kernel.companies SET main_contact_id = ${solo}::uuid WHERE id = ${seule}::uuid`,
  )
  await db.execute(
    drizzleSql`UPDATE kernel.companies SET main_contact_id = ${idOf("nue")}::uuid WHERE id = ${nue}::uuid`,
  )
  const issuer = await invoicing(
    "settings_issuer_profile_create",
    {
      legal_name: "Studio Issuer SAS",
      country: "FR",
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
    ["invoicing:*"],
  )
  if (!(issuer.data as { id?: string } | undefined)?.id) {
    throw new Error(`no issuer profile: ${JSON.stringify(issuer)}`)
  }
  await registryIdentity(compta, "900000001", "MAISON DELORME")
  await registryIdentity(solo, "900000019", "MAISON SEULE")
}, 300_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("Create invoice on a reconcile card", () => {
  let october1: Awaited<ReturnType<typeof october>>
  let created: Record<string, any> = {}
  let numbersBefore = 0

  beforeAll(async () => {
    october1 = await october()
    numbersBefore = await numbersTaken()
    created = await create(october1.card)
  }, 120_000)

  it("Create invoice is offered on the card with its VAT and total", () => {
    expect(october1.card.createInvoice).toBe("yes")
    expect(october1.card.tot).toEqual([
      { k: "Excl. VAT", v: { minor: 651000, currency: "EUR" } },
      { k: "VAT", v: { minor: 130200, currency: "EUR" } },
      { k: "Incl. VAT", v: { minor: 781200, currency: "EUR" } },
    ])
  })

  it("pressing Create on the October card makes one approved draft of 7,812.00 and a report, and the card says so with Undo", async () => {
    expect(created.error).toBeUndefined()
    expect(created.summary).toBe("Draft made, not issued yet, €7,812.00 incl. VAT")
    expect(created.undo).toBe("yes")
    expect(created.createInvoice).toBeNull()
    expect(created.state).toBe("drafted")
    const docs = await docsOf(october1.projectId)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      id: created.documentId,
      status: "draft",
      number: null,
      external_ref: `reconcile:${october1.card.reconciliationId}:${october1.card.revision}`,
      approved_by: owner.userId,
    })
    // The draft stores its totals from the moment it is made, as the card shows them.
    const [totals] = extractRows<{ excl: string; vat: string; incl: string }>(
      await db.execute(drizzleSql`
        SELECT subtotal_minor::text AS excl, tax_total_minor::text AS vat,
               grand_total_minor::text AS incl
          FROM app_invoicing.documents WHERE id = ${created.documentId}::uuid`),
    )
    expect(totals).toEqual({ excl: "651000", vat: "130200", incl: "781200" })
    const items = extractRows<{ quantity: string; unit_price_minor: string }>(
      await db.execute(drizzleSql`
        SELECT quantity::text AS quantity, unit_price_minor::text AS unit_price_minor
          FROM app_invoicing.document_lines
         WHERE document_id = ${created.documentId}::uuid ORDER BY position`),
    )
    expect(items.map((l) => [Number(l.quantity), Number(l.unit_price_minor)])).toEqual([
      [3, 93000],
      [4, 93000],
    ])
    const reports = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_invoicing.activity_reports
         WHERE document_id = ${created.documentId}::uuid`),
    )
    expect(reports[0]?.n).toBe(1)
    expect(await claimsOf(october1.card.reconciliationId)).toEqual(["reserved", "reserved"])
    const lines = extractRows<{ document_line_position: number | null }>(
      await db.execute(drizzleSql`
        SELECT document_line_position FROM app_projects.reconciliation_lines
         WHERE reconciliation_id = ${october1.card.reconciliationId}::uuid ORDER BY position`),
    )
    expect(lines.map((l) => l.document_line_position)).toEqual([1, 2])
  })

  it("the draft goes to the billing contact of the project's company, with its billing address", async () => {
    const [doc] = extractRows<{ contact: string | null; address: string | null; email: string }>(
      await db.execute(drizzleSql`
        SELECT counterparty_contact_id::text AS contact, counterparty_address AS address,
               counterparty_email AS email
          FROM app_invoicing.documents WHERE id = ${created.documentId}::uuid`),
    )
    expect(doc).toEqual({
      contact: compta,
      address: "4 rue des Lilas, 69002 Lyon",
      email: "compta@delorme.example",
    })
  })

  it("a clicker holding the issuing and approving scopes takes no number at Create", async () => {
    expect(await numbersTaken()).toBe(numbersBefore)
    expect(await issueApprovals(created.documentId)).toEqual(["pending"])
    expect(created.approvalId).toBeTruthy()
  })

  it("asking again while a draft waits shows the drafted card, to another lead too", async () => {
    const again = (userId: string) =>
      run(
        reconcilePropose,
        {
          project: october1.key,
          month: "2026-10",
          lines: [{ name: "Something else", taskIds: [], proofs: [] }],
        },
        { userId },
      )
    for (const who of [owner.userId, otherLead.userId]) {
      const card = await again(who)
      expect(card.error).toBeUndefined()
      expect(card.reconciliationId).toBe(october1.card.reconciliationId)
      expect(card.state).toBe("drafted")
      expect(card.summary).toContain("On draft")
      expect(card.createInvoice).toBeNull()
    }
    const rows = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_projects.reconciliations
         WHERE project_id = ${october1.projectId}::uuid`),
    )
    expect(rows[0]?.n).toBe(1)
  })

  it("Undo before issue returns the card, frees every claim, discards the draft and uses no number", async () => {
    // The person's next turn starts clean: what the card's turn read no longer holds the click.
    await clearTaintFlag(thread, orgId)
    const undone = await run(reconcileUndo, { reconciliationId: october1.card.reconciliationId })
    expect(undone.error).toBeUndefined()
    expect(undone.undone).toBe(true)
    expect(undone.state).toBe("proposed")
    expect(undone.summary).toBeNull()
    expect(undone.createInvoice).toBe("yes")
    expect(await docsOf(october1.projectId)).toEqual([])
    expect(await claimsOf(october1.card.reconciliationId)).toEqual(["released", "released"])
    expect(await stateOf(october1.card.reconciliationId)).toEqual({
      state: "proposed",
      document_ref: null,
      document_id: null,
    })
    expect(await issueApprovals(created.documentId)).not.toContain("pending")
    expect(await numbersTaken()).toBe(numbersBefore)
  })
})

describe("a card of lines whose rounding differs", () => {
  it("three 20-min lines at 90.00 an hour: the card, its total, the agent's words and the draft all say 89.10", async () => {
    keys++
    const key = `INV${keys}`
    const made = await call<{ id: string }>("projects_createProject", {
      name: `Maison Delorme ${key}`,
      key,
      companyId: delorme,
      timeBudgets: true,
    })
    await awaitTimeFeatureSync(orgId)
    await call("projects_timePlanSet", { projectId: made.id, basis: "hourly" })
    await call("projects_billingTermsSet", { projectId: made.id, rate: 90, currency: "EUR" })
    const ids: string[] = []
    for (const k of ["a", "b", "c"]) {
      const task = await call<{ id: string }>("projects_createTask", {
        projectId: made.id,
        title: `Task ${k}`,
        statusLabel: "done",
        timebox: "1 days",
      })
      ids.push(task.id)
      // Each task is planned at 20 min, done in October.
      await db.execute(
        drizzleSql`UPDATE app_projects.tasks SET timebox_minutes = 20, completed_at = '2026-10-20 10:00+00'::timestamptz WHERE id = ${task.id}::uuid`,
      )
      await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId, ["*"]), [
        { taskId: task.id, projectId: made.id, workDate: "2026-10-12", minutes: 20 },
      ])
    }
    const card = await run(reconcilePropose, {
      project: key,
      month: "2026-10",
      lines: ids.map((id, i) => ({ name: `Line ${i + 1}`, taskIds: [id], proofs: [] })),
    })
    expect(card.error).toBeUndefined()
    expect(card.lines.map((l: Record<string, unknown>) => [l.billMinutes, l.amount])).toEqual([
      [20, 29.7],
      [20, 29.7],
      [20, 29.7],
    ])
    expect(card.totals.amountExclVat).toBe(89.1)
    expect(card.message).toContain("(89.10 EUR excluding VAT)")
    expect(card.tot[0]).toEqual({ k: "Excl. VAT", v: { minor: 8910, currency: "EUR" } })
    const drafted = await create(card)
    expect(drafted.error).toBeUndefined()
    const [doc] = extractRows<{ excl: string }>(
      await db.execute(drizzleSql`
        SELECT subtotal_minor::text AS excl FROM app_invoicing.documents
         WHERE id = ${drafted.documentId}::uuid`),
    )
    expect(doc?.excl).toBe("8910")
    // The drafted card keeps the same total, without invoicing's preview.
    expect(drafted.totals.amountExclVat).toBe(89.1)
  }, 120_000)
})

describe("the card in its conversation", () => {
  it("Create replaces the stored card by its summary line and Undo brings it back", async () => {
    const p = await october()
    const template = (
      projectsAppManifest as unknown as { tools: Record<string, { resultCard: CardTemplate }> }
    ).tools.reconcile_create_invoice!.resultCard
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    // The thread's stored call: the proposal's result, its card collapsed by the Create click.
    const collapsed = resolveToolCard(template, out)
    expect(collapsed?.summary?.text).toBe("Draft made, not issued yet, €7,812.00 incl. VAT")
    await minimal.postUserMessage(orgId, thread, owner.userId, "", {
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "projects__reconcile_propose",
          result: p.card,
          card: collapsed,
        },
      ],
    })
    await clearTaintFlag(thread, orgId)
    const undone = await run(reconcileUndo, { reconciliationId: p.card.reconciliationId })
    expect(undone.undone).toBe(true)
    const stored = extractRows<{
      metadata: { toolCalls: Array<{ card?: ResolvedCard; cardRevision?: number }> }
    }>(
      await db.execute(drizzleSql`
        SELECT metadata FROM kernel.messages
         WHERE thread_id = ${thread}::uuid AND metadata -> 'toolCalls' @> ${JSON.stringify([
           { toolCallId: "call-1" },
         ])}::text::jsonb`),
    )
    const card = stored.at(-1)?.metadata.toolCalls[0]?.card
    expect(card?.summary).toBeUndefined()
    expect((card?.groups ?? []).flatMap((g) => g.rows)).toHaveLength(2)
    expect(stored.at(-1)?.metadata.toolCalls[0]?.cardRevision).toBe(2)
  })
})

describe("Undo on a conversation that read outside text", () => {
  it("Undo discards the card's own draft at once, even after outside text was read, and brings the card back", async () => {
    const p = await october()
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    await db.execute(
      drizzleSql`UPDATE kernel.threads SET tainted = true WHERE id = ${thread}::uuid`,
    )
    const undone = await run(reconcileUndo, { reconciliationId: p.card.reconciliationId })
    expect(undone.error).toBeUndefined()
    expect(undone.undone).toBe(true)
    expect((await stateOf(p.card.reconciliationId))?.state).toBe("proposed")
    expect(await docsOf(p.projectId)).toEqual([])
    await clearTaintFlag(thread, orgId)
  })
})

describe("who presses Create", () => {
  it("a creator without the issuing scope is told it waits for finance and cannot issue", async () => {
    const p = await october()
    const out = await create(p.card, { scopes: LEAD })
    expect(out.error).toBeUndefined()
    expect(out.summary).toBe("Draft made, waiting for finance to issue it")
    expect(out.message).toContain("you cannot issue it")
    const docs = await docsOf(p.projectId)
    expect(docs).toHaveLength(1)
    expect(docs[0]?.approved_by).toBeNull()
    expect(await issueApprovals(String(out.documentId))).toEqual(["pending"])
  })

  it("over a coding agent's connection Create is refused and the answer points to the card", async () => {
    const p = await october()
    const out = await create(p.card, { origin: "mcp" })
    expect(out.error?.code).toBe("create_on_card")
    expect(out.error?.details?.next).toContain("presses Create invoice on the card's page")
    expect(await docsOf(p.projectId)).toEqual([])
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("a coding agent reading the card is given the link where a person presses Create invoice", async () => {
    const p = await october()
    const card = await run(
      reconcileGet,
      { reconciliationId: p.card.reconciliationId },
      { origin: "mcp" },
    )
    expect(card.text).toContain("a person presses Create invoice")
    expect(card.text).toContain(`/projects/reconcile/${p.card.reconciliationId}`)
    expect(card.next).toContain("own page in Liaison")
    expect(card.next).not.toContain("this conversation")
  })
})

describe("one draft per card", () => {
  it("two clicks at once and a retry after a timeout make one draft", async () => {
    const p = await october()
    const [a, b] = await Promise.all([create(p.card), create(p.card)])
    const retry = await create(p.card)
    const docs = await docsOf(p.projectId)
    expect(docs).toHaveLength(1)
    for (const out of [a, b, retry].filter((o) => !o.error)) {
      expect(out.documentId).toBe(docs[0]?.id)
    }
    expect([a, b, retry].some((o) => !o.error)).toBe(true)
    expect(await claimsOf(p.card.reconciliationId)).toEqual(["reserved", "reserved"])
  })
})

describe("what Create refuses", () => {
  it("a project billed to another company refuses and creates nothing", async () => {
    const p = await october()
    const out = await run(reconcileCreateInvoice, {
      reconciliationId: p.card.reconciliationId,
      revision: p.card.revision,
      contactId: erika,
    })
    expect(out.error?.code).toBe("counterparty_mismatch")
    expect(await docsOf(p.projectId)).toEqual([])
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("a project with no company asks for one and creates nothing", async () => {
    const p = await october({ company: null })
    expect(p.card.createInvoice).toBeNull()
    expect(JSON.stringify([p.card.notice, p.card.cardNotes])).toContain("the project's company")
    const out = await create(p.card)
    expect(out.error?.code).toBe("company_missing")
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("a company with no billing address bills its main contact", async () => {
    const p = await october({ company: seule })
    expect(p.card.createInvoice).toBe("yes")
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    const [doc] = extractRows<{ contact: string | null }>(
      await db.execute(drizzleSql`
        SELECT counterparty_contact_id::text AS contact
          FROM app_invoicing.documents WHERE id = ${out.documentId}::uuid`),
    )
    expect(doc?.contact).toBe(solo)
  })

  it("a customer with no billing address and no SIREN has no Create, and Create names both and creates nothing", async () => {
    const p = await october({ company: nue })
    expect(p.card.createInvoice ?? null).toBeNull()
    const out = await create(p.card)
    expect(out.error?.code).toBe("billing_address_missing")
    expect(out.error?.message).toContain("the customer's billing address")
    expect(out.error?.message).toContain("the customer's SIREN")
    expect(await docsOf(p.projectId)).toEqual([])
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("a company with no billing contact has no Create, says to set one, and Create creates nothing", async () => {
    const p = await october({ company: vide })
    expect(p.card.createInvoice ?? null).toBeNull()
    expect(JSON.stringify([p.card.notice, p.card.cardNotes])).toContain(
      "To create the invoice from this card, set a billing contact on the project's company.",
    )
    const out = await create(p.card)
    expect(out.error?.code).toBe("billing_contact_missing")
    expect(await docsOf(p.projectId)).toEqual([])
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("with no rate the card names what to set and shows no Create", async () => {
    const p = await october({ rate: null })
    expect(p.card.createInvoice).toBeNull()
    expect(JSON.stringify([p.card.notice, p.card.cardNotes])).toContain("the project's rate")
    const out = await create(p.card)
    expect(out.error?.code).toBe("rate_missing")
    expect(await docsOf(p.projectId)).toEqual([])
  })

  it("an old revision is refused with the latest card", async () => {
    const p = await october()
    const edited = await run(reconcileLineUpdate, {
      reconciliationId: p.card.reconciliationId,
      revision: p.card.revision,
      lineId: p.card.lines[0].lineId,
      bill: 2,
    })
    expect(edited.revision).toBe(p.card.revision + 1)
    const out = await create(p.card)
    expect(out.error?.code).toBe("card_changed")
    expect(out.error?.details?.latest?.revision).toBe(p.card.revision + 1)
    expect(await docsOf(p.projectId)).toEqual([])
  })

  it("with invoicing off the card still compares and has no Create", async () => {
    const off = async () =>
      JSON.stringify({ status: "error", error: { code: "app_not_enabled", message: "off" } })
    const p = await october()
    const card = await run(
      reconcileGet,
      { reconciliationId: p.card.reconciliationId },
      { patch: { executeTool: off } },
    )
    expect(card.error).toBeUndefined()
    expect(card.lines).toHaveLength(2)
    expect(card.createInvoice).toBeNull()
    const out = await create(p.card, { patch: { executeTool: off } })
    expect(out.error?.code).toBe("invoicing_off")
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("a fixed-price card has no Create and the tool refuses", async () => {
    const p = await october({ basis: "fixed" })
    expect(p.card.createInvoice).toBeNull()
    const out = await create(p.card)
    expect(out.error?.code).toBe("basis_not_billable")
    expect(await claimsOf(p.card.reconciliationId)).toEqual([])
  })

  it("a retainer month's Create drafts the fee and the hours above the retainer under the month's key, and Undo discards it", async () => {
    const p = await october({ basis: "retainer" })
    const schedule = await retainerSchedule(p.projectId)
    await retainerTimebox(p.projectId, schedule, "2026-10-01", "2026-10-31")
    const before = await numbersTaken()
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    expect(out.state).toBe("drafted")
    const docs = await docsOf(p.projectId)
    expect(docs).toHaveLength(1)
    // 49 h billed on a 40 h retainer: the 4,500.00 fee and 9 h at 120.00.
    expect(docs[0]).toMatchObject({
      status: "draft",
      number: null,
      external_ref: `retainer:${schedule}:2026-10`,
    })
    const items = extractRows<{ quantity: string; unit_price_minor: string }>(
      await db.execute(drizzleSql`
        SELECT quantity::text AS quantity, unit_price_minor::text AS unit_price_minor
          FROM app_invoicing.document_lines
         WHERE document_id = ${docs[0]?.id}::uuid ORDER BY position`),
    )
    expect(items.map((l) => [Number(l.quantity), Number(l.unit_price_minor)])).toEqual([
      [1, 450000],
      [9, 12000],
    ])
    expect((await stateOf(p.card.reconciliationId))?.document_ref).toBe(
      `retainer:${schedule}:2026-10`,
    )
    expect(await claimsOf(p.card.reconciliationId)).toEqual(["reserved", "reserved"])
    const undone = await run(reconcileUndo, { reconciliationId: p.card.reconciliationId })
    expect(undone.undone).toBe(true)
    expect(await docsOf(p.projectId)).toEqual([])
    expect((await stateOf(p.card.reconciliationId))?.state).toBe("proposed")
    expect(await numbersTaken()).toBe(before)
  })

  it("a prepaid retainer month deducts its issued advance from the month's final", async () => {
    const p = await october({ basis: "retainer" })
    const schedule = await retainerSchedule(p.projectId, "2026-01", { covers: "period_ahead" })
    await retainerTimebox(p.projectId, schedule, "2026-10-01", "2026-10-31")
    const advance = await issuedAdvance(p.projectId, `F-2026-9${keys}01`)
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    expect(out.state).toBe("drafted")
    const final = (await docsOf(p.projectId)).find((d) => d.id !== advance)
    expect(final).toMatchObject({ status: "draft", external_ref: `retainer:${schedule}:2026-10` })
    const taken = extractRows<Record<string, string>>(
      await db.execute(drizzleSql`
        SELECT final_document_id::text AS final, amount_minor::text AS amount, state
          FROM app_invoicing.advance_deductions
         WHERE advance_document_id = ${advance}::uuid`),
    )
    expect(taken).toEqual([{ final: final?.id as string, amount: "450000", state: "reserved" }])
  }, 120_000)

  it("a prepaid retainer month with no work still gets its card, and its final deducts the advance", async () => {
    keys++
    const key = `INV${keys}`
    const made = await call<{ id: string }>("projects_createProject", {
      name: `Maison Delorme ${key}`,
      key,
      companyId: delorme,
      timeBudgets: true,
    })
    await awaitTimeFeatureSync(orgId)
    await call("projects_timePlanSet", { projectId: made.id, basis: "retainer" })
    const schedule = await retainerSchedule(made.id, "2026-01", { covers: "period_ahead" })
    await retainerTimebox(made.id, schedule, "2026-10-01", "2026-10-31")
    const advance = await issuedAdvance(made.id, `F-2026-9${keys}03`)
    // Nothing closed in October: the facts say the month is still invoiced and how.
    const facts = await run(reconcileFacts, { project: key, month: "2026-10" })
    expect(facts.tasks).toEqual([])
    expect(facts.message).toContain("still has its invoice")
    expect(facts.next).toContain("reconcile_propose with no lines")
    const card = await run(reconcilePropose, { project: key, month: "2026-10", lines: [] })
    expect(card.error).toBeUndefined()
    expect(card.reconciliationId).toBeString()
    const out = await create(card)
    expect(out.error).toBeUndefined()
    expect(out.state).toBe("drafted")
    const final = (await docsOf(made.id)).find((d) => d.id !== advance)
    expect(final).toMatchObject({ status: "draft", external_ref: `retainer:${schedule}:2026-10` })
    const taken = extractRows<Record<string, string>>(
      await db.execute(drizzleSql`
        SELECT final_document_id::text AS final, amount_minor::text AS amount
          FROM app_invoicing.advance_deductions
         WHERE advance_document_id = ${advance}::uuid`),
    )
    expect(taken).toEqual([{ final: final?.id as string, amount: "450000" }])
  }, 120_000)

  it("refunding an advance of a stopped project prepares its credit note", async () => {
    const p = await october({ basis: "retainer" })
    const advance = await issuedAdvance(p.projectId, `F-2026-9${keys}02`)
    const res = await invoicing("advance_refund_prepare", { advanceDocumentId: advance }, [
      "invoicing:*",
    ])
    const data = res.data as { status?: string; message?: string }
    expect(["completed", "pending_approval"]).toContain(data.status as string)
    expect(data.message).toContain("citing advance")
  }, 120_000)

  it("a retainer card says what the fee includes and prices no time line at the hourly rate", async () => {
    const p = await october({ basis: "retainer" })
    const schedule = await retainerSchedule(p.projectId)
    await retainerTimebox(p.projectId, schedule, "2026-10-01", "2026-10-31")
    const card = await run(reconcileGet, { reconciliationId: p.card.reconciliationId })
    const notes = JSON.stringify(card.cardNotes)
    expect(notes).toContain("the monthly fee of €4,500.00 excl. VAT includes 40 h")
    expect(notes).toContain("€120.00 an hour")
    const rows = (card.groups as Array<{ rows: Array<Record<string, unknown>> }>).flatMap(
      (g) => g.rows,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.amount === undefined)).toBe(true)
    expect(card.createInvoice).toBe("yes")
  })

  it("a retainer month its schedule bills has no Create and says the schedule bills it", async () => {
    const p = await october({ basis: "retainer" })
    // The retainer starts in November: October is the schedule's own month-end month.
    await retainerSchedule(p.projectId, "2026-11")
    const card = await run(reconcileGet, { reconciliationId: p.card.reconciliationId })
    expect(card.createInvoice ?? null).toBeNull()
    expect(card.notice?.title).toBe("Billed by its schedule")
    expect(card.notice?.text).toContain("billed by the retainer's schedule in Invoicing")
  })

  it("a second lead's card for a retainer month already drafted is refused and adds nothing to that draft", async () => {
    const p = await october({ basis: "retainer" })
    const schedule = await retainerSchedule(p.projectId)
    await retainerTimebox(p.projectId, schedule, "2026-10-01", "2026-10-31")
    // The other lead bills a task the first card left off.
    const c = await call<{ id: string }>("projects_createTask", {
      projectId: p.projectId,
      title: "Task c",
      statusLabel: "done",
      timebox: "1 day",
    })
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-10-21 10:00+00'::timestamptz WHERE id = ${c.id}::uuid`,
    )
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId, ["*"]), [
      { taskId: c.id, projectId: p.projectId, workDate: "2026-10-13", minutes: day(1) },
    ])
    const theirs = await run(
      reconcilePropose,
      {
        project: p.key,
        month: "2026-10",
        lines: [{ name: "Site upkeep", taskIds: [c.id], proofs: [{ kind: "task", ref: c.id }] }],
      },
      { userId: otherLead.userId },
    )
    expect(theirs.error).toBeUndefined()
    expect(theirs.reconciliationId).not.toBe(p.card.reconciliationId)
    // The first card bills the other closed tasks: the second card leaves them off.
    const others = theirs.lines.find((l: Record<string, any>) => l.name !== "Site upkeep")
    const mine = await run(
      reconcileLineUpdate,
      {
        reconciliationId: theirs.reconciliationId,
        revision: theirs.revision,
        lineId: others.lineId,
        bill: 0,
      },
      { userId: otherLead.userId },
    )
    expect(mine.error).toBeUndefined()
    expect((await create(p.card)).state).toBe("drafted")
    const docsBefore = await docsOf(p.projectId)
    const out = await create(mine, { userId: otherLead.userId })
    expect(out.error?.code).toBe("month_on_other_card")
    expect(await docsOf(p.projectId)).toEqual(docsBefore)
    expect(await claimsOf(theirs.reconciliationId)).not.toContain("reserved")
    expect((await stateOf(theirs.reconciliationId))?.state).toBe("proposed")
  })

  it("a retainer month whose invoice was credited in full is drafted again from its card under the next key", async () => {
    const p = await october({ basis: "retainer" })
    const schedule = await retainerSchedule(p.projectId)
    await retainerTimebox(p.projectId, schedule, "2026-10-01", "2026-10-31")
    const key = `retainer:${schedule}:2026-10`
    const first = await create(p.card)
    expect(first.state).toBe("drafted")
    // The month's invoice is issued, then a credit note takes it back whole (the sweep's view).
    const [doc] = extractRows<Record<string, AppCell>>(
      await db.execute(drizzleSql`
        UPDATE app_invoicing.documents
           SET status = 'issued', number = 'F-2026-9901', number_int = 9901, year_of_issue = 2026,
               grand_total_minor = 540000
         WHERE id = ${first.documentId}::uuid
        RETURNING *`),
    )
    if (!doc) throw new Error("the month's draft is gone")
    await insertAppRow(db as never, "invoicing", "documents", {
      ...doc,
      org_id: orgId,
      id: crypto.randomUUID(),
      type: "credit_note",
      external_ref: null,
      external_refs: jsonCell({}),
      lifecycle_log: jsonCell([]),
      number: "A-2026-9901",
      original_document_id: String(doc.id),
      grand_total_minor: -540000,
    })
    await db.execute(drizzleSql`
      UPDATE app_projects.reconciliations SET state = 'credited'
       WHERE id = ${p.card.reconciliationId}::uuid`)
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET state = 'credited'
       WHERE reconciliation_id = ${p.card.reconciliationId}::uuid`)
    // A new card for the month bills it again, under the next key.
    const again = await run(reconcilePropose, {
      project: p.key,
      month: "2026-10",
      lines: [{ name: "Site upkeep again", taskIds: [], proofs: [] }],
    })
    expect(again.error).toBeUndefined()
    expect(again.reconciliationId).not.toBe(p.card.reconciliationId)
    const out = await create(again)
    expect(out.error).toBeUndefined()
    expect(out.state).toBe("drafted")
    expect((await stateOf(again.reconciliationId))?.document_ref).toBe(`${key}:2`)
    const keys = (await docsOf(p.projectId)).map((d) => d.external_ref).filter((k) => k !== null)
    expect(keys.sort()).toEqual([key, `${key}:2`])
  })

  it("turning time off on a project with an active retainer is refused and names the schedule", async () => {
    const p = await october({ basis: "retainer" })
    const schedule = await retainerSchedule(p.projectId)
    await retainerTimebox(p.projectId, schedule, "2099-01-01", "2099-01-31")
    const out = await run(updateProject as never, { projectId: p.projectId, timeBudgets: false })
    expect(out.error?.code).toBe("retainer_needs_reconcile")
    expect(String(out.error?.message)).toContain("Monthly retainer")
    expect(String(out.error?.message)).toContain("Nothing was changed")
    const on = extractRows<{ on: boolean }>(
      await db.execute(
        drizzleSql`SELECT time_budgets_on AS on FROM app_projects.projects WHERE id = ${p.projectId}::uuid`,
      ),
    )[0]
    expect(on?.on).toBe(true)
  })

  it("saving a retainer writes this and next month's timeboxes on its project, marked as the retainer's", async () => {
    const p = await october({ basis: "retainer" })
    const issuerId = await issuerProfileId()
    const saved = await invoicing("recurring_schedule_create", {
      issuer_profile_id: issuerId,
      company_id: delorme,
      contact_id: erika,
      repeats: "month",
      billing_day: "last",
      lines: [{ description: "Monthly retainer", qty: 1, unit_price_minor: 450000, vat_bp: 2000 }],
      retainer_project_id: p.projectId,
      retainer_minutes: 2400,
      retainer_overage_rate_minor: 12000,
    })
    const id = (saved.data as { id?: string } | undefined)?.id
    expect(id, JSON.stringify(saved)).toBeDefined()
    const rows = extractRows<{ source: string; source_ref: string | null; minutes: number }>(
      await db.execute(drizzleSql`
        SELECT source, source_ref, minutes FROM app_projects.project_timeboxes
         WHERE project_id = ${p.projectId}::uuid ORDER BY period_start`),
    )
    expect(rows).toHaveLength(2)
    expect(
      rows.every((r) => r.source === "retainer" && r.source_ref === id && r.minutes === 2400),
    ).toBe(true)
  })

  it("a fixed-price project with plan steps still open cannot switch to hourly", async () => {
    const p = await october({ basis: "fixed" })
    // Invoicing counts the project's plan steps not invoiced yet; one is still open.
    const asked: string[] = []
    const oneOpen = async (tool: string, json: string) => {
      asked.push(`${tool} ${json}`)
      return JSON.stringify({
        status: "completed",
        result: { projectId: p.projectId, ready: false, missing: ["basis"], openPlanSteps: 1 },
      })
    }
    const out = await run(
      billingTermsSet,
      { projectId: p.projectId, rate: 90, currency: "EUR" },
      { patch: { executeTool: oneOpen } },
    )
    expect(out.error?.code).toBe("plan_steps_open")
    expect(asked).toEqual([
      `invoicing:preview_totals ${JSON.stringify({ projectId: p.projectId, basis: "hourly" })}`,
    ])
    const terms = extractRows<{ rate_minor: string | null; fixed_price_minor: string | null }>(
      await db.execute(drizzleSql`
        SELECT rate_minor::text AS rate_minor, fixed_price_minor::text AS fixed_price_minor
          FROM app_projects.project_billing_terms WHERE project_id = ${p.projectId}::uuid`),
    )
    expect(terms[0]).toEqual({ rate_minor: null, fixed_price_minor: "600000" })
    // With every plan step invoiced, the project may switch to a rate.
    const noneOpen = async () =>
      JSON.stringify({ status: "completed", result: { ready: false, openPlanSteps: 0 } })
    const switched = await run(
      billingTermsSet,
      { projectId: p.projectId, rate: 90, currency: "EUR" },
      { patch: { executeTool: noneOpen } },
    )
    expect(switched.error).toBeUndefined()
    expect(switched.rate).toBe(90)
  })
})

describe("after the draft", () => {
  it("a draft discarded in the editor brings the month line and the card back", async () => {
    const p = await october()
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    const discard = await invoicing("drafts_discard", { draft_id: out.documentId })
    expect(JSON.stringify(discard)).not.toContain("error")
    expect((await stateOf(p.card.reconciliationId))?.state).toBe("proposed")
    expect(await claimsOf(p.card.reconciliationId)).toEqual(["released", "released"])
    const card = await run(reconcileGet, { reconciliationId: p.card.reconciliationId })
    expect(card.state).toBe("proposed")
    expect(card.createInvoice).toBe("yes")
  })

  it("a billed line cannot change after issue", async () => {
    const p = await october()
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    // The invoice is issued (the hand-over marks the card invoiced).
    await db.execute(drizzleSql`
      UPDATE app_projects.reconciliations SET state = 'invoiced'
       WHERE id = ${p.card.reconciliationId}::uuid`)
    const edit = await run(reconcileLineUpdate, {
      reconciliationId: p.card.reconciliationId,
      revision: p.card.revision,
      lineId: p.card.lines[0].lineId,
      bill: 1,
    })
    expect(edit.error?.code).toBe("reconcile_locked")
    const card = await run(reconcileGet, { reconciliationId: p.card.reconciliationId })
    expect(card.locked).toBe("yes")
    expect(card.createInvoice).toBeNull()
    expect(JSON.stringify(card.cardNotes)).toContain("Already invoiced")
    const undo = await run(reconcileUndo, { reconciliationId: p.card.reconciliationId })
    expect(undo.error?.code).toBe("already_issued")
    const again = await create(p.card)
    expect(again.error?.code).toBe("already_issued")
  })
})

describe("issuing the card's draft", () => {
  it("a person issuing the draft from its approval marks the card invoiced and bills every claim on the invoice", async () => {
    const p = await october()
    const out = await create(p.card)
    expect(out.error).toBeUndefined()
    const pending = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM kernel.approval_requests
         WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:invoice_issue'
           AND status = 'pending' AND current_payload->>'draft_id' = ${out.documentId}`),
    )
    expect(pending).toHaveLength(1)
    const decided = await decideApproval({
      orgId,
      requestId: pending[0]!.id,
      actor: actorOf(owner.userId, FINANCE),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const docs = await docsOf(p.projectId)
    expect(docs).toHaveLength(1)
    expect(docs[0]?.status).toBe("issued")
    expect(docs[0]?.number).toBeTruthy()
    const rec = await stateOf(p.card.reconciliationId)
    expect(rec?.state).toBe("invoiced")
    expect(rec?.document_id).toBe(docs[0]!.id)
    const claims = extractRows<{ state: string; document_id: string | null; n: string | null }>(
      await db.execute(drizzleSql`
        SELECT state, document_id::text AS document_id, document_number AS n
          FROM app_projects.billing_claims
         WHERE reconciliation_id = ${p.card.reconciliationId}::uuid`),
    )
    expect(claims.length).toBeGreaterThan(0)
    for (const c of claims) {
      expect(c).toEqual({ state: "billed", document_id: docs[0]!.id, n: docs[0]!.number })
    }
    const card = await run(reconcileGet, { reconciliationId: p.card.reconciliationId })
    expect(card.undo).toBeNull()
  }, 120_000)
  it("a retainer month with no time logged issues its fee from the approval and the card is invoiced", async () => {
    keys++
    const key = `INV${keys}`
    const made = await call<{ id: string }>("projects_createProject", {
      name: `Maison Delorme ${key}`,
      key,
      companyId: delorme,
      timeBudgets: true,
    })
    await awaitTimeFeatureSync(orgId)
    await call("projects_timePlanSet", { projectId: made.id, basis: "retainer" })
    const schedule = await retainerSchedule(made.id)
    await retainerTimebox(made.id, schedule, "2026-10-01", "2026-10-31")
    const card = await run(reconcilePropose, { project: key, month: "2026-10", lines: [] })
    expect(card.error).toBeUndefined()
    const out = await create(card)
    expect(out.error).toBeUndefined()
    expect(out.state).toBe("drafted")
    expect(await claimsOf(card.reconciliationId)).toEqual([])
    const pending = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM kernel.approval_requests
         WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:invoice_issue'
           AND status = 'pending' AND current_payload->>'draft_id' = ${out.documentId}`),
    )
    expect(pending).toHaveLength(1)
    const decided = await decideApproval({
      orgId,
      requestId: pending[0]!.id,
      actor: actorOf(owner.userId, FINANCE),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const docs = await docsOf(made.id)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      status: "issued",
      external_ref: `retainer:${schedule}:2026-10`,
    })
    expect(docs[0]?.number).toBeTruthy()
    const items = extractRows<{ quantity: string; unit_price_minor: string }>(
      await db.execute(drizzleSql`
        SELECT quantity::text AS quantity, unit_price_minor::text AS unit_price_minor
          FROM app_invoicing.document_lines
         WHERE document_id = ${docs[0]?.id}::uuid ORDER BY position`),
    )
    expect(items.map((l) => [Number(l.quantity), Number(l.unit_price_minor)])).toEqual([
      [1, 450000],
    ])
    expect((await stateOf(card.reconciliationId))?.state).toBe("invoiced")
  }, 120_000)
})

/** A retainer project on 40 h at 4,500.00 and 120.00 above, with its timeboxes for the months. */
async function retainerProject(months: string[], extra: Record<string, AppCell> = {}) {
  keys++
  const key = `INV${keys}`
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Maison Delorme ${key}`,
    key,
    companyId: delorme,
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis: "retainer" })
  const schedule = await retainerSchedule(made.id, "2026-01", extra)
  for (const m of months) {
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate()
    await retainerTimebox(made.id, schedule, `${m}-01`, `${m}-${last}`)
  }
  return { id: made.id, key, schedule }
}

/** A task of a project closed on a day, with time on given days. */
async function closedTask(
  projectId: string,
  title: string,
  closedOn: string | null,
  time: Array<[string, number]>,
  timebox?: string,
): Promise<string> {
  const task = await call<{ id: string }>("projects_createTask", {
    projectId,
    title,
    statusLabel: closedOn ? "done" : "todo",
    ...(timebox ? { timebox } : {}),
  })
  if (closedOn)
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = ${`${closedOn} 10:00+00`}::timestamptz WHERE id = ${task.id}::uuid`,
    )
  if (time.length > 0)
    await seedTaskTime(
      seedContext({ orgId, now: new Date() }),
      actorOf(owner.userId, ["*"]),
      time.map(([workDate, minutes]) => ({ taskId: task.id, projectId, workDate, minutes })),
    )
  return task.id
}

const draftLinesOf = (documentId: unknown) =>
  db
    .execute(drizzleSql`
      SELECT description, quantity::text AS q, unit_price_minor::text AS p
        FROM app_invoicing.document_lines
       WHERE document_id = ${String(documentId)}::uuid ORDER BY position`)
    .then((r) =>
      extractRows<{ description: string; q: string; p: string }>(r).map(
        (l) => [l.description, Number(l.q), Number(l.p)] as const,
      ),
    )

/** Decide the issue approval of a draft as a person who can issue. */
async function approveIssue(documentId: unknown) {
  const pending = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:invoice_issue'
         AND status = 'pending' AND current_payload->>'draft_id' = ${String(documentId)}`),
  )
  expect(pending).toHaveLength(1)
  return decideApproval({
    orgId,
    requestId: pending[0]!.id,
    actor: actorOf(owner.userId, FINANCE),
    decision: "approve",
  })
}

const addTime = (projectId: string, taskId: string, time: Array<[string, number]>) =>
  seedTaskTime(
    seedContext({ orgId, now: new Date() }),
    actorOf(owner.userId, ["*"]),
    time.map(([workDate, minutes]) => ({ taskId, projectId, workDate, minutes })),
  )

const setSchedule = (id: string, patch: { terms?: unknown; status?: string }) =>
  db.execute(drizzleSql`
    UPDATE app_invoicing.recurring_schedules
       SET retainer_terms = ${patch.terms === undefined ? null : JSON.stringify(patch.terms)}::jsonb,
           status = ${patch.status ?? "active"}
     WHERE id = ${id}::uuid`)

/** The terms of a retainer turned off from a month. */
const offFrom = (month: string) => [
  {
    from: month,
    off: true,
    retainer_minutes: 0,
    retainer_overage_rate_minor: null,
    covers: "period_ended",
    lines: [{ description: "Upkeep", qty: 1, unit_price_minor: 100000, vat_bp: 2000 }],
  },
]

const issuedOf = async (projectId: string) =>
  (await docsOf(projectId)).filter((d) => d.status === "issued")

describe("issuing a retainer month whose card bills no line", () => {
  it("a line the biller set to 0, or left off, does not keep the month's fee from issuing", async () => {
    const r = await retainerProject(["2026-10"])
    const t = await closedTask(r.id, "Extra", "2026-10-20", [["2026-10-12", 120]])
    const card = await run(reconcilePropose, {
      project: r.key,
      month: "2026-10",
      lines: [{ name: "Extra", taskIds: [t], proofs: [] }],
    })
    const zeroed = await run(reconcileLineUpdate, {
      reconciliationId: card.reconciliationId,
      revision: card.revision,
      lineId: card.lines[0].lineId,
      bill: 0,
    })
    expect(zeroed.error).toBeUndefined()
    const out = await create(zeroed)
    expect(out.error).toBeUndefined()
    expect(await claimsOf(card.reconciliationId)).toEqual(["left_off"])
    expect((await approveIssue(out.documentId)).status).toBe("approved")
    const issued = await issuedOf(r.id)
    expect(issued).toHaveLength(1)
    expect((await draftLinesOf(issued[0]?.id)).map((l) => l.slice(1))).toEqual([[1, 450000]])
    expect((await stateOf(card.reconciliationId))?.state).toBe("invoiced")
  }, 120_000)

  it("created, undone and created again with no line, it issues once", async () => {
    const r = await retainerProject(["2026-10"])
    const t = await closedTask(r.id, "Work", "2026-10-20", [["2026-10-12", 120]])
    const card = await run(reconcilePropose, {
      project: r.key,
      month: "2026-10",
      lines: [{ name: "Work", taskIds: [t], proofs: [] }],
    })
    const first = await create(card)
    expect(first.error).toBeUndefined()
    const undone = await run(reconcileUndo, { reconciliationId: card.reconciliationId })
    expect(undone.undone).toBe(true)
    const zeroed = await run(reconcileLineUpdate, {
      reconciliationId: card.reconciliationId,
      revision: undone.revision ?? undone.card?.revision ?? card.revision,
      lineId: card.lines[0].lineId,
      bill: 0,
    })
    expect(zeroed.error).toBeUndefined()
    const again = await create(zeroed)
    expect(again.error).toBeUndefined()
    expect((await approveIssue(again.documentId)).status).toBe("approved")
    expect(await issuedOf(r.id)).toHaveLength(1)
    // The month is billed: a new ask draws the same card, and Create makes nothing more.
    const asked = await run(reconcilePropose, { project: r.key, month: "2026-10", lines: [] })
    expect((await create(asked)).error).toBeDefined()
    expect(await docsOf(r.id)).toHaveLength(1)
  }, 120_000)

  it("a card that bills work not reserved for it is refused with what to do, and doing it issues the month", async () => {
    const r = await retainerProject(["2026-10"])
    const t = await closedTask(r.id, "Work", "2026-10-20", [["2026-10-12", 120]])
    const card = await run(reconcilePropose, {
      project: r.key,
      month: "2026-10",
      lines: [{ name: "Work", taskIds: [t], proofs: [] }],
    })
    const out = await create(card)
    expect(out.error).toBeUndefined()
    await db.execute(
      drizzleSql`UPDATE app_projects.billing_claims SET state = 'released'
                  WHERE reconciliation_id = ${card.reconciliationId}::uuid`,
    )
    const refused = await approveIssue(out.documentId).then(
      (d) => JSON.stringify(d),
      (e) => `${String(e)} ${JSON.stringify(e, Object.getOwnPropertyNames(e as object))}`,
    )
    expect(refused).toContain("Undo")
    expect(await issuedOf(r.id)).toHaveLength(0)
    const undone = await run(reconcileUndo, { reconciliationId: card.reconciliationId })
    expect(undone.undone).toBe(true)
    const again = await run(reconcilePropose, {
      project: r.key,
      month: "2026-10",
      lines: [{ name: "Work", taskIds: [t], proofs: [] }],
    })
    const redrafted = await create(again)
    expect(redrafted.error).toBeUndefined()
    expect((await approveIssue(redrafted.documentId)).status).toBe("approved")
    expect(await issuedOf(r.id)).toHaveLength(1)
  }, 120_000)
})

/** Back-date a card's draft and its claims to a day, as if the invoice had been made then. */
async function draftedOn(card: Record<string, any>, on: string) {
  await db.execute(
    drizzleSql`UPDATE app_projects.reconciliations SET drafted_at = ${`${on} 09:00+00`}::timestamptz
                WHERE id = ${card.reconciliationId}::uuid`,
  )
  await db.execute(
    drizzleSql`UPDATE app_projects.billing_claims
                  SET created_at = ${`${on} 09:00+00`}::timestamptz
                WHERE reconciliation_id = ${card.reconciliationId}::uuid`,
  )
}

const proposal = (key: string, month: string, lines: unknown[] = [], extra: object = {}) =>
  run(reconcilePropose, { project: key, month, lines, ...extra })

const lineOf = (name: string, ids: string[]) => ({ name, taskIds: ids, proofs: [] })

/** A monthly project billed by the day, with a company. */
async function dailyProject() {
  keys++
  const key = `INV${keys}`
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Maison Delorme ${key}`,
    key,
    companyId: delorme,
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: made.id, basis: "daily" })
  await call("projects_billingTermsSet", { projectId: made.id, rate: 930, currency: "EUR" })
  return { id: made.id, key }
}

describe("a period invoiced before it ends", () => {
  it("says on the card that it is not over, and a month that has not begun is never drafted", async () => {
    const p = await dailyProject()
    const now = new Date()
    const month = (n: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + n, 1)).toISOString().slice(0, 7)
    const t = await closedTask(p.id, "Now", now.toISOString().slice(0, 10), [], "1 day")
    const current = await proposal(p.key, month(0), [lineOf("Now", [t])])
    expect(current.error).toBeUndefined()
    expect(current.message).toContain("This period is not over: it ends on")
    expect(JSON.stringify(current.cardNotes)).toContain("goes on the next card")
    expect(current.createInvoice).toBe("yes")
    const made = await create(current)
    expect(made.error).toBeUndefined()
    expect(JSON.stringify(made.cardNotes)).toContain("This period is not over")
    const approval = extractRows<{ s: string }>(
      await db.execute(drizzleSql`
        SELECT summary::text AS s FROM kernel.approval_requests
         WHERE org_id = ${orgId}::uuid AND current_payload->>'draft_id' = ${made.documentId}`),
    )[0]
    expect(approval?.s).toContain("not over")
    // A past month says nothing of the sort.
    const past = await proposal(p.key, "2026-10", [])
    expect(past.message).not.toContain("not over")
    const r = await retainerProject([month(1)])
    const next = await proposal(r.key, month(1), [])
    expect(next.createInvoice ?? null).toBeNull()
    expect(next.notice?.title).toBe("Not started yet")
    expect((await create(next)).error).toMatchObject({ code: "period_not_started" })
    expect(await docsOf(r.id)).toEqual([])
  }, 120_000)

  it("lists work closed in it afterwards on the next card, by the day, once", async () => {
    const p = await dailyProject()
    const a = await closedTask(p.id, "First", "2026-09-04", [["2026-09-03", HPD]], "1 day")
    const jan = await proposal(p.key, "2026-09", [lineOf("First", [a])])
    const made = await create(jan)
    expect(made.error).toBeUndefined()
    await draftedOn(jan, "2026-09-05")
    await approveIssue(made.documentId)
    const planned = await closedTask(p.id, "Late planned", "2026-09-20", [], "2 days")
    const extra = await closedTask(p.id, "Late extra", "2026-09-22", [["2026-09-22", 60]])
    const now = await closedTask(p.id, "October", "2026-10-10", [], "1 day")
    const facts = await run(reconcileFacts, { project: p.key, month: "2026-10" })
    expect(facts.unbilledEarlier.map((t: any) => t.id).sort()).toEqual([planned, extra].sort())
    // Asked with the month's own line alone, the card lists the rest by itself.
    const oct = await proposal(p.key, "2026-10", [lineOf("October", [now])])
    expect(oct.error).toBeUndefined()
    const byName = new Map<string, any>(oct.lines.map((l: any) => [l.name, l]))
    expect(byName.get("Earlier work, closed after its invoice")).toMatchObject({
      taskIds: [planned],
      billMinutes: day(2),
    })
    expect(byName.get("Earlier work not in the plan, closed after its invoice")).toMatchObject({
      taskIds: [extra],
      billMinutes: 0,
    })
    // Asked again, the same card comes back.
    expect((await proposal(p.key, "2026-10", [lineOf("October", [now])])).outcome).toBe("unchanged")
    const oneMade = await create(oct)
    expect(oneMade.error).toBeUndefined()
    expect((await draftLinesOf(oneMade.documentId)).map((l) => l[1])).toEqual([1, 2])
    await approveIssue(oneMade.documentId)
    // Billed, or left off, it is never offered again.
    const nov = await run(reconcileFacts, { project: p.key, month: "2026-11" })
    expect(nov.unbilledEarlier).toEqual([])
    const novCard = await proposal(p.key, "2026-11", [])
    expect(novCard.lines).toEqual([])
  }, 120_000)

  it("keeps the client's own work, and what was on the period's card, off the next one", async () => {
    const p = await dailyProject()
    const a = await closedTask(p.id, "First", "2026-09-04", [], "1 day")
    const own = await closedTask(p.id, "Client's own", "2026-09-04", [], "1 day")
    // Proposed with it first, then without: what is left out is kept on the card as it stands.
    await proposal(p.key, "2026-09", [lineOf("First", [a])])
    const sep = await proposal(p.key, "2026-09", [lineOf("First", [a])], {
      excluded: [{ taskId: own, reason: "client_own" }],
    })
    const made = await create(sep)
    expect(made.error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    const facts = await run(reconcileFacts, { project: p.key, month: "2026-10" })
    expect(facts.unbilledEarlier).toEqual([])
    expect((await proposal(p.key, "2026-10", [])).lines).toEqual([])
    // Dated back into the period after its invoice, work nobody billed is listed all the same.
    const back = await closedTask(p.id, "Dated back", "2026-09-03", [], "1 day")
    const again = await run(reconcileFacts, { project: p.key, month: "2026-10" })
    expect(again.unbilledEarlier.map((t: any) => t.id)).toEqual([back])
    // Excluded on this card, it is off it.
    const without = await proposal(p.key, "2026-10", [], {
      excluded: [{ taskId: back, reason: "client_own" }],
    })
    expect(without.lines).toEqual([])
  }, 120_000)

  it("lists at 0 a late subtask of billed work, for a person to set", async () => {
    const p = await dailyProject()
    const parent = await closedTask(p.id, "Whole", "2026-09-04", [], "3 days")
    const sep = await proposal(p.key, "2026-09", [lineOf("Whole", [parent])])
    expect((await create(sep)).error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    const child = await call<{ id: string }>("projects_createTask", {
      projectId: p.id,
      title: "Part",
      statusLabel: "done",
      parentTaskId: parent,
      timebox: "1 day",
    })
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-09-20 10:00+00'::timestamptz WHERE id = ${child.id}::uuid`,
    )
    const oct = await proposal(p.key, "2026-10", [])
    expect(oct.lines).toHaveLength(1)
    expect(oct.lines[0]).toMatchObject({ taskIds: [child.id], billMinutes: 0 })
    expect(oct.lines[0].name).toContain("part of other work")
  }, 120_000)
})

describe("a retainer month invoiced before it ends", () => {
  /** September invoiced on the 5th at `hours`, on a 40 h retainer. */
  async function september(hours: number, extra: Record<string, AppCell> = {}) {
    const r = await retainerProject(["2026-08", "2026-09", "2026-10", "2026-11"], extra)
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", hours * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect(sep.error).toBeUndefined()
    const made = await create(sep)
    expect(made.error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    await approveIssue(made.documentId)
    return { ...r, a, made }
  }
  const late = (description: string) => description.includes("worked after its invoice")

  it("bills its later hours above the retainer on the next card, as that month's, once", async () => {
    const r = await september(47)
    // Later in September: 10 h on the same task, 8 h on a new one closed then, 30 min entered
    // for a day before the invoice.
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId, ["*"]), [
      { taskId: r.a, projectId: r.id, workDate: "2026-09-18", minutes: 600 },
      { taskId: r.a, projectId: r.id, workDate: "2026-09-02", minutes: 30 },
    ] as never)
    const b = await closedTask(r.id, "New", "2026-09-25", [["2026-09-24", 480]])
    const c = await closedTask(r.id, "October", "2026-10-08", [["2026-10-07", 600]])
    const facts = await run(reconcileFacts, { project: r.key, month: "2026-10" })
    expect(
      facts.unbilledEarlier.map((t: any) => [t.id, t.realMinutes, t.workMonth]).sort(),
    ).toEqual(
      [
        [r.a, 630, "2026-09"],
        [b, 480, "2026-09"],
      ].sort(),
    )
    const oct = await proposal(r.key, "2026-10", [lineOf("October", [c])])
    const lateLine = oct.lines.find((l: any) => l.workMonth === "2026-09")
    expect(lateLine).toMatchObject({ billMinutes: 1110, realMinutes: 1110 })
    expect(lateLine.taskIds.sort()).toEqual([r.a, b].sort())
    expect(lateLine.name).toBe("Earlier work, September 2026, done after its invoice")
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    // October used 10 h of 40: the fee. September was at 47 of 40 already: 18.5 h at 120.00.
    expect((await draftLinesOf(made.documentId)).map((l) => [late(l[0]), l[1], l[2]])).toEqual([
      [false, 1, 450000],
      [true, 18.5, 12000],
    ])
    await approveIssue(made.documentId)
    const nov = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(nov.unbilledEarlier).toEqual([])
    expect((await proposal(r.key, "2026-11", [])).lines).toEqual([])
  }, 120_000)

  it("counts later hours inside the month's included hours first, and keeps the next month's whole", async () => {
    const r = await september(30)
    const b = await closedTask(r.id, "New", "2026-09-25", [["2026-09-24", 12 * 60]])
    const c = await closedTask(r.id, "October", "2026-10-08", [["2026-10-07", 40 * 60]])
    const oct = await proposal(r.key, "2026-10", [
      lineOf("October", [c]),
      lineOf("Site search, September", [b]),
    ])
    // A line that names only late work keeps its own words.
    expect(oct.lines.find((l: any) => l.workMonth === "2026-09")?.name).toBe(
      "Site search, September",
    )
    const made = await create(oct)
    // October: 40 of 40. September: 30 + 12 = 42 of 40, so 2 h above.
    expect((await draftLinesOf(made.documentId)).map((l) => [late(l[0]), l[1], l[2]])).toEqual([
      [false, 1, 450000],
      [true, 2, 12000],
    ])
  }, 120_000)

  it("takes its later hours out of what it rolls into the next month", async () => {
    const r = await september(30, { retainer_rollover: "next" })
    const b = await closedTask(r.id, "New", "2026-09-25", [["2026-09-24", 6 * 60]])
    const c = await closedTask(r.id, "October", "2026-10-08", [["2026-10-07", 46 * 60]])
    const oct = await proposal(r.key, "2026-10", [lineOf("October", [c]), lineOf("New", [b])])
    const made = await create(oct)
    // September keeps 40 - 30 - 6 = 4 h to roll; October used 46 of 40 + 4: 2 h above.
    expect((await draftLinesOf(made.documentId)).map((l) => [late(l[0]), l[1], l[2]])).toEqual([
      [false, 1, 450000],
      [false, 2, 12000],
    ])
  }, 120_000)

  it("a late line set to 0 or left off is not offered again, and an undone card gives it back", async () => {
    const r = await september(47)
    const b = await closedTask(r.id, "New", "2026-09-25", [["2026-09-24", 480]])
    const oct = await proposal(r.key, "2026-10", [])
    const line = oct.lines.find((l: any) => l.workMonth)
    expect(line.taskIds).toEqual([b])
    const made = await create(oct)
    expect((await draftLinesOf(made.documentId)).length).toBe(2)
    const undone = await run(reconcileUndo, { reconciliationId: oct.reconciliationId })
    expect(undone.undone).toBe(true)
    const zeroed = await run(reconcileLineUpdate, {
      reconciliationId: oct.reconciliationId,
      revision: oct.revision,
      lineId: line.lineId,
      bill: 0,
    })
    expect(zeroed.error).toBeUndefined()
    const again = await create(zeroed)
    expect(again.error).toBeUndefined()
    expect((await draftLinesOf(again.documentId)).length).toBe(1)
    await approveIssue(again.documentId)
    const nov = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(nov.unbilledEarlier).toEqual([])
  }, 120_000)

  it("a month undone while the next card holds its later hours cannot bill them again", async () => {
    const r = await retainerProject(["2026-09", "2026-10"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 47 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId, ["*"]), [
      { taskId: a, projectId: r.id, workDate: "2026-09-18", minutes: 600 },
    ] as never)
    const oct = await proposal(r.key, "2026-10", [])
    const made = await create(oct)
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [10, 12000],
    ])
    // September goes back and is asked again: what October's card holds of it is not on it.
    expect((await run(reconcileUndo, { reconciliationId: sep.reconciliationId })).undone).toBe(true)
    const again = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect(again.lines[0].billMinutes).toBe(47 * 60)
    const whole = await create(again)
    expect(whole.error).toBeUndefined()
    // 47 h of 40, and the 10 h are October's: 17 h above in all, as if told on time.
    expect((await draftLinesOf(whole.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [7, 12000],
    ])
    expect((await run(reconcileUndo, { reconciliationId: whole.reconciliationId })).undone).toBe(
      true,
    )
    // The later hours given back, the month bills them all.
    expect((await run(reconcileUndo, { reconciliationId: oct.reconciliationId })).undone).toBe(true)
    const all = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    const last = await create(all)
    expect((await draftLinesOf(last.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [17, 12000],
    ])
  }, 120_000)

  it("a month credited in full while a later card holds hours of it bills the rest, its included hours once", async () => {
    const r = await september(20)
    await closedTask(r.id, "New", "2026-09-25", [["2026-09-24", 15 * 60]])
    const oct = await proposal(r.key, "2026-10", [])
    expect((await create(oct)).error).toBeUndefined()
    // September's claims go as a full credit leaves them, and its invoice with them.
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET state = 'credited'
       WHERE project_id = ${r.id}::uuid AND period_key = '2026-09' AND source_ref = ${r.a}`)
    await db.execute(drizzleSql`
      UPDATE app_projects.reconciliations SET state = 'credited'
       WHERE project_id = ${r.id}::uuid AND period_start = '2026-09-01'`)
    await db.execute(drizzleSql`
      UPDATE app_invoicing.documents SET status = 'cancelled'
       WHERE billing_project_id = ${r.id}::uuid AND external_ref = ${`retainer:${r.schedule}:2026-09`}`)
    await addTime(r.id, r.a, [["2026-09-19", 15 * 60]])
    const again = await proposal(r.key, "2026-09", [lineOf("Upkeep", [r.a])])
    expect(again.lines.map((l: any) => l.billMinutes)).toContain(35 * 60)
    const made = await create(again)
    expect(made.error).toBeUndefined()
    // 35 h now and 15 h on October's card: 50 of 40, so 10 above.
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [10, 12000],
    ])
  }, 120_000)

  it("two cards offering the same later hours bill them once", async () => {
    const r = await september(47)
    await closedTask(r.id, "New", "2026-09-25", [["2026-09-24", 480]])
    const oct = await proposal(r.key, "2026-10", [])
    const other = await run(
      reconcilePropose,
      { project: r.key, month: "2026-11", lines: [] },
      { userId: otherLead.userId },
    )
    expect(other.lines.some((l: any) => l.workMonth === "2026-09")).toBe(true)
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    const second = await create(other, { userId: otherLead.userId })
    expect(second.error).toMatchObject({ code: "already_on" })
    expect((await docsOf(r.id)).length).toBe(2)
    // The month itself cannot take the hours back while the next card holds them.
    const claims = extractRows<{ k: string; state: string }>(
      await db.execute(drizzleSql`
        SELECT period_key AS k, state FROM app_projects.billing_claims
         WHERE project_id = ${r.id}::uuid AND state IN ('reserved', 'billed') ORDER BY period_key`),
    )
    expect(new Set(claims.map((c) => c.k))).toEqual(new Set(["2026-09"]))
  }, 120_000)
})

describe("time entered while a card waits, or after it was claimed", () => {
  const perHour = (l: readonly [string, number, number]) => l.slice(1)

  it("a retainer card whose hours moved is refused with the card as it stands, and bills them all", async () => {
    const r = await retainerProject(["2026-10", "2026-11"])
    const t = await closedTask(r.id, "Upkeep", null, [["2026-10-12", 47 * 60]])
    const card = await proposal(r.key, "2026-10", [lineOf("Upkeep", [t])])
    await addTime(r.id, t, [
      ["2026-10-30", 600],
      ["2026-10-31", 120],
    ])
    const refused = await create(card)
    expect(refused.error).toMatchObject({ code: "card_changed" })
    expect(refused.error.message).toContain("47 h")
    expect(refused.error.message).toContain("59 h")
    expect(await docsOf(r.id)).toEqual([])
    expect(await claimsOf(card.reconciliationId)).toEqual([])
    const latest = refused.error.details.latest
    expect(latest.revision).toBe(card.revision + 1)
    expect(latest.lines[0]).toMatchObject({ billMinutes: 59 * 60, realMinutes: 59 * 60 })
    expect(latest.createInvoice).toBe("yes")
    // The card it was pressed on is gone; the one shown is made whole.
    expect((await create(card)).error).toMatchObject({ code: "card_changed" })
    const made = await create(latest)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [19, 12000],
    ])
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)

  it("an edit of a line does not make a stale card billable, and a bill a person set stays", async () => {
    const r = await retainerProject(["2026-10"])
    const t = await closedTask(r.id, "Upkeep", null, [["2026-10-12", 47 * 60]])
    const u = await closedTask(r.id, "Extra", null, [["2026-10-13", 600]])
    const card = await proposal(r.key, "2026-10", [lineOf("Upkeep", [t]), lineOf("Extra", [u])])
    await addTime(r.id, t, [["2026-10-30", 600]])
    await addTime(r.id, u, [["2026-10-30", 60]])
    const edited = await run(reconcileLineUpdate, {
      reconciliationId: card.reconciliationId,
      revision: card.revision,
      lineId: card.lines[1].lineId,
      bill: "2 h",
    })
    expect(edited.error).toBeUndefined()
    const refused = await create(edited)
    expect(refused.error).toMatchObject({ code: "card_changed" })
    expect(
      refused.error.details.latest.lines.map((l: any) => [l.realMinutes, l.billMinutes]),
    ).toEqual([
      [57 * 60, 57 * 60],
      [660, 120],
    ])
    const made = await create(refused.error.details.latest)
    expect((await draftLinesOf(made.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [19, 12000],
    ])
  }, 120_000)

  it("a late line whose hours moved is refused too, and what is entered after the draft goes on the next card", async () => {
    const r = await retainerProject(["2026-09", "2026-10", "2026-11"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 40 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await addTime(r.id, a, [["2026-09-04", 300]])
    const oct = await proposal(r.key, "2026-10", [])
    expect(oct.lines[0]).toMatchObject({ workMonth: "2026-09", billMinutes: 300 })
    await addTime(r.id, a, [["2026-09-18", 300]])
    const refused = await create(oct)
    expect(refused.error).toMatchObject({ code: "card_changed" })
    const made = await create(refused.error.details.latest)
    expect((await draftLinesOf(made.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [10, 12000],
    ])
    // Dated the same day, entered after the draft: the next card's, once.
    await addTime(r.id, a, [["2026-09-05", 120]])
    const nov = await proposal(r.key, "2026-11", [])
    expect(nov.lines.map((l: any) => [l.workMonth, l.billMinutes])).toEqual([["2026-09", 120]])
    const novMade = await create(nov)
    expect((await draftLinesOf(novMade.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [2, 12000],
    ])
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-12" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)

  it("time entered for a day before the claim, or on the day of it, on a claimed task is billed on the next card", async () => {
    const r = await retainerProject(["2026-09", "2026-10"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-05", 40 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    await addTime(r.id, a, [["2026-09-04", 300]])
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET minutes = minutes + 60
       WHERE task_id = ${a}::uuid AND work_date = '2026-09-05'`)
    const oct = await proposal(r.key, "2026-10", [])
    expect(oct.lines.map((l: any) => [l.workMonth, l.realMinutes])).toEqual([["2026-09", 360]])
  }, 120_000)

  it("an older claim, made before its minutes were kept, counts what is dated up to its day", async () => {
    const r = await retainerProject(["2026-09", "2026-10"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 40 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET counted_minutes = NULL
       WHERE reconciliation_id = ${sep.reconciliationId}::uuid`)
    await addTime(r.id, a, [
      ["2026-09-05", 60],
      ["2026-09-06", 300],
    ])
    const oct = await proposal(r.key, "2026-10", [])
    expect(oct.lines.map((l: any) => [l.workMonth, l.realMinutes])).toEqual([["2026-09", 300]])
    expect((await create(oct)).error).toBeUndefined()
    await addTime(r.id, a, [["2026-09-07", 60]])
    const nov = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(nov.unbilledEarlier.map((t: any) => t.realMinutes)).toEqual([60])
    // Two older claims of one task: the later one says the day.
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims
         SET counted_minutes = NULL, created_at = '2026-10-15 09:00+00'::timestamptz
       WHERE reconciliation_id = ${oct.reconciliationId}::uuid AND state = 'reserved'`)
    const both = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(both.unbilledEarlier).toEqual([])
  }, 120_000)

  it("a line left off counts the hours it left off, and no later ones", async () => {
    const r = await retainerProject(["2026-09", "2026-10", "2026-11"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 600]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    const zeroed = await run(reconcileLineUpdate, {
      reconciliationId: sep.reconciliationId,
      revision: sep.revision,
      lineId: sep.lines[0].lineId,
      bill: 0,
    })
    // Hours entered before Create on a line set to 0 are shown first too.
    await addTime(r.id, a, [["2026-09-04", 60]])
    const refused = await create(zeroed)
    expect(refused.error).toMatchObject({ code: "card_changed" })
    expect((await create(refused.error.details.latest)).error).toBeUndefined()
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-10" })).unbilledEarlier,
    ).toEqual([])
    await addTime(r.id, a, [["2026-09-20", 180]])
    const oct = await proposal(r.key, "2026-10", [])
    expect(oct.lines.map((l: any) => [l.workMonth, l.billMinutes])).toEqual([["2026-09", 180]])
    expect((await create(oct)).error).toBeUndefined()
    // Named by a line, what was left off is billed after all, and is left off no more.
    const nov = await proposal(r.key, "2026-11", [lineOf("Upkeep, after all", [a])])
    expect(nov.lines.map((l: any) => [l.workMonth, l.billMinutes])).toEqual([["2026-09", 660]])
    expect((await create(nov)).error).toBeUndefined()
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-12" })).unbilledEarlier,
    ).toEqual([])
    const back = await proposal(r.key, "2026-12", [lineOf("Again", [a])])
    expect(back.lines.filter((l: any) => l.workMonth)).toEqual([])
  }, 120_000)

  it("a card proposed again after a try that stopped before its draft is reserved as it stands", async () => {
    const r = await retainerProject(["2026-10", "2026-11"])
    const t = await closedTask(r.id, "Upkeep", null, [["2026-10-12", 41 * 60]])
    const card = await proposal(r.key, "2026-10", [lineOf("Upkeep", [t])])
    const stopped = await run(
      reconcileCreateInvoice,
      {
        reconciliationId: card.reconciliationId,
        revision: card.revision,
      },
      {
        patch: {
          executeTool: async (tool: string) => {
            if (tool === "invoicing:retainer_draft_from_reconcile") throw new Error("gone")
            return JSON.stringify({
              status: "completed",
              result: { ready: true, missing: [], excl: 1, vat: 0, incl: 1, currency: "EUR" },
            })
          },
          projects_reconcileCreate: undefined,
        },
      },
    ).catch((e) => ({ error: String(e) }))
    expect(stopped.error).toBeTruthy()
    // Its claims as that try left them.
    await withRlsContext(actorOf(owner.userId, FINANCE), (tx) =>
      reserveClaims(tx as never, {
        orgId,
        reconciliationId: card.reconciliationId,
        documentRef: `retainer:${r.schedule}:2026-10`,
      }),
    )
    const u = await closedTask(r.id, "More", null, [["2026-10-13", 300]])
    await addTime(r.id, t, [["2026-10-30", 60]])
    const again = await proposal(r.key, "2026-10", [lineOf("Upkeep", [t]), lineOf("More", [u])])
    const made = await create(again)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [7, 12000],
    ])
    expect(await claimsOf(card.reconciliationId)).toEqual(["released", "reserved", "reserved"])
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)

  it("a later line of a card proposed again after a try that stopped is reserved as it stands", async () => {
    const r = await retainerProject(["2026-09", "2026-10", "2026-11"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 40 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await addTime(r.id, a, [["2026-09-18", 120]])
    const oct = await proposal(r.key, "2026-10", [])
    await withRlsContext(actorOf(owner.userId, FINANCE), (tx) =>
      reserveClaims(tx as never, {
        orgId,
        reconciliationId: oct.reconciliationId,
        documentRef: `retainer:${r.schedule}:2026-10`,
      }),
    )
    // Pressed again at once, its own claims are its own.
    const again = await create(oct)
    expect(again.error).toBeUndefined()
    expect((await draftLinesOf(again.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [2, 12000],
    ])
    expect((await run(reconcileUndo, { reconciliationId: oct.reconciliationId })).undone).toBe(true)
    await withRlsContext(actorOf(owner.userId, FINANCE), (tx) =>
      reserveClaims(tx as never, {
        orgId,
        reconciliationId: oct.reconciliationId,
        documentRef: `retainer:${r.schedule}:2026-10`,
      }),
    )
    const b = await closedTask(r.id, "More", null, [["2026-09-19", 60]])
    const second = await proposal(r.key, "2026-10", [
      lineOf("Upkeep, late", [a]),
      lineOf("More, late", [b]),
    ])
    expect(second.error).toBeUndefined()
    expect(second.lines.map((l: any) => [l.workMonth, l.billMinutes])).toEqual([
      ["2026-09", 120],
      ["2026-09", 60],
    ])
    const made = await create(second)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map(perHour)).toEqual([
      [1, 450000],
      [3, 12000],
    ])
  }, 120_000)

  it("two reservations of the same later hours at once, many times over: one card holds them", async () => {
    const r = await retainerProject(["2026-09", "2026-10", "2026-11"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 41 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await addTime(r.id, a, [["2026-09-18", 600]])
    const oct = await proposal(r.key, "2026-10", [])
    const nov = await run(
      reconcilePropose,
      { project: r.key, month: "2026-11", lines: [] },
      { userId: otherLead.userId },
    )
    const reserve = (card: Record<string, any>, userId: string, month: string) =>
      withRlsContext(actorOf(userId, FINANCE), (tx) =>
        reserveClaims(tx as never, {
          orgId,
          reconciliationId: card.reconciliationId,
          documentRef: `retainer:${r.schedule}:${month}`,
          revision: card.revision,
        }),
      ).then(
        () => "reserved",
        (e) => (e as { code?: string }).code ?? String(e),
      )
    for (let i = 0; i < 40; i++) {
      const out = await Promise.all([
        reserve(oct, owner.userId, "2026-10"),
        reserve(nov, otherLead.userId, "2026-11"),
      ])
      const held = extractRows<{ n: number; m: number }>(
        await db.execute(drizzleSql`
          SELECT count(*)::int AS n, coalesce(sum(counted_minutes), 0)::int AS m
            FROM app_projects.billing_claims
           WHERE project_id = ${r.id}::uuid AND state = 'reserved'
             AND starts_with(period_key, '2026-09') AND reconciliation_id <> ${sep.reconciliationId}::uuid`),
      )[0]
      expect([...out].sort(), `round ${i}`).toEqual(["already_on", "reserved"])
      expect(held, `round ${i}`).toEqual({ n: 1, m: 600 })
      await db.execute(drizzleSql`
        UPDATE app_projects.billing_claims SET state = 'released'
         WHERE project_id = ${r.id}::uuid AND reconciliation_id <> ${sep.reconciliationId}::uuid`)
      await db.execute(drizzleSql`
        UPDATE app_projects.reconciliations SET document_ref = NULL
         WHERE project_id = ${r.id}::uuid AND state = 'proposed'`)
    }
  }, 180_000)

  it("two people pressing Create at once on cards offering the same later hours bill them once", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await retainerProject(["2026-09", "2026-10", "2026-11"])
      const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 41 * 60]])
      const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
      expect((await create(sep)).error).toBeUndefined()
      await addTime(r.id, a, [["2026-09-18", 600]])
      const oct = await proposal(r.key, "2026-10", [])
      const nov = await run(
        reconcilePropose,
        { project: r.key, month: "2026-11", lines: [] },
        { userId: otherLead.userId },
      )
      const out = await Promise.all([create(oct), create(nov, { userId: otherLead.userId })])
      expect(out.filter((o) => o.error?.code === "already_on")).toHaveLength(1)
      const lines = (
        await Promise.all(out.filter((o) => !o.error).map((o) => draftLinesOf(o.documentId)))
      ).flat()
      expect(lines.map(perHour)).toEqual([
        [1, 450000],
        [10, 12000],
      ])
    }
  }, 180_000)

  it("by the hour with no plan, a card whose time moved is refused, and time entered after it is billed once on the next", async () => {
    const p = await dailyProject()
    await call("projects_timePlanSet", { projectId: p.id, basis: "hourly" })
    const a = await closedTask(p.id, "Support", "2026-09-10", [["2026-09-09", 120]])
    const sep = await proposal(p.key, "2026-09", [lineOf("Support", [a])])
    expect(sep.lines[0].billMinutes).toBe(120)
    await addTime(p.id, a, [["2026-09-10", 60]])
    const refused = await create(sep)
    expect(refused.error).toMatchObject({ code: "card_changed" })
    const made = await create(refused.error.details.latest)
    expect((await draftLinesOf(made.documentId)).map(perHour)).toEqual([[3, 93000]])
    await approveIssue(made.documentId)
    // Time of a billed task, entered after its invoice, for a day before it and one after.
    await addTime(p.id, a, [
      ["2026-09-08", 30],
      ["2026-10-02", 60],
    ])
    const facts = await run(reconcileFacts, { project: p.key, month: "2026-10" })
    expect(facts.unbilledEarlier.map((t: any) => [t.id, t.realMinutes])).toEqual([[a, 90]])
    // Closed again in October, it is still billed only for what is new.
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-10-02 10:00+00'::timestamptz WHERE id = ${a}::uuid`,
    )
    const oct = await proposal(p.key, "2026-10", [])
    expect(oct.lines.map((l: any) => [l.name, l.billMinutes])).toEqual([
      ["Time entered after its invoice", 90],
    ])
    const octMade = await create(oct)
    expect(octMade.error).toBeUndefined()
    expect((await draftLinesOf(octMade.documentId)).map(perHour)).toEqual([[1.5, 93000]])
    expect(
      (await run(reconcileFacts, { project: p.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
    // A task billed by its plan is not: its time moves the margin.
    const planned = await closedTask(p.id, "Planned", "2026-11-05", [["2026-11-04", 60]], "2 h")
    const nov = await proposal(p.key, "2026-11", [lineOf("Planned", [planned])])
    expect((await create(nov)).error).toBeUndefined()
    await addTime(p.id, planned, [["2026-11-06", 600]])
    expect(
      (await run(reconcileFacts, { project: p.key, month: "2026-12" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)
})

describe("two cards of one month", () => {
  it("never hold the same task's month, whatever key each is drafted under", async () => {
    const r = await retainerProject(["2026-09"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 600]])
    const mine = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    const theirs = await run(
      reconcilePropose,
      { project: r.key, month: "2026-09", lines: [lineOf("Upkeep", [a])] },
      { userId: otherLead.userId },
    )
    expect((await create(mine)).error).toBeUndefined()
    const second = await withRlsContext(actorOf(otherLead.userId, FINANCE), (tx) =>
      reserveClaims(tx as never, {
        orgId,
        reconciliationId: theirs.reconciliationId,
        documentRef: "retainer:another:2026-09",
      }),
    ).then(
      () => "reserved",
      (e) => (e as { code?: string }).code,
    )
    expect(second).toBe("already_on")
  }, 120_000)
})

describe("a task billed by its time whose invoice was credited", () => {
  it("is billed whole again on a new card, whatever was left out of a card since", async () => {
    const p = await dailyProject()
    await call("projects_timePlanSet", { projectId: p.id, basis: "hourly" })
    const a = await closedTask(p.id, "Support", "2026-09-10", [["2026-09-09", 120]])
    const sep = await proposal(p.key, "2026-09", [lineOf("Support", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await addTime(p.id, a, [["2026-09-20", 60]])
    const now = await closedTask(p.id, "October", "2026-10-10", [["2026-10-09", 60]])
    const oct = await proposal(p.key, "2026-10", [lineOf("October", [now])], {
      excluded: [{ taskId: a, reason: "client_own" }],
    })
    expect(oct.lines.map((l: any) => l.taskIds)).toEqual([[now]])
    expect((await create(oct)).error).toBeUndefined()
    expect(
      (await run(reconcileFacts, { project: p.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
    await db.execute(drizzleSql`
      UPDATE app_projects.billing_claims SET state = 'credited'
       WHERE reconciliation_id = ${sep.reconciliationId}::uuid`)
    await db.execute(drizzleSql`
      UPDATE app_projects.reconciliations SET state = 'credited'
       WHERE id = ${sep.reconciliationId}::uuid`)
    const again = await proposal(p.key, "2026-09", [lineOf("Support", [a])])
    expect(again.lines.map((l: any) => l.billMinutes)).toEqual([180])
    const made = await create(again)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([[3, 93000]])
  }, 120_000)
})

describe("time entered after a parent and its subtask were billed by their time", () => {
  it("is listed once, on the task it was entered on", async () => {
    const p = await dailyProject()
    await call("projects_timePlanSet", { projectId: p.id, basis: "hourly" })
    const parent = await closedTask(p.id, "Whole", "2026-09-10", [["2026-09-09", 120]])
    const child = await call<{ id: string }>("projects_createTask", {
      projectId: p.id,
      title: "Part",
      statusLabel: "done",
      parentTaskId: parent,
    })
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-09-11 10:00+00'::timestamptz WHERE id = ${child.id}::uuid`,
    )
    await addTime(p.id, child.id, [["2026-09-11", 60]])
    const sep = await proposal(p.key, "2026-09", [lineOf("Both", [parent, child.id])])
    expect(sep.lines[0].billMinutes).toBe(180)
    expect((await create(sep)).error).toBeUndefined()
    await addTime(p.id, child.id, [["2026-09-20", 60]])
    const oct = await proposal(p.key, "2026-10", [])
    expect(oct.lines.map((l: any) => [l.taskIds, l.billMinutes])).toEqual([[[child.id], 60]])
    expect((await create(oct)).error).toBeUndefined()
    await addTime(p.id, parent, [["2026-09-21", 30]])
    const nov = await proposal(p.key, "2026-11", [])
    expect(nov.lines.map((l: any) => [l.taskIds, l.billMinutes])).toEqual([[[parent], 30]])
  }, 120_000)
})

describe("work left out of a card on purpose", () => {
  it("late hours left out of a retainer card stay out, what is entered later does not, and naming the task adds them back", async () => {
    const r = await retainerProject(["2026-09", "2026-10", "2026-11", "2026-12"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 41 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    const b = await closedTask(r.id, "Theirs", null, [["2026-09-20", 600]])
    const oct = await proposal(r.key, "2026-10", [], {
      excluded: [{ taskId: b, reason: "client_own" }],
    })
    expect(oct.lines).toEqual([])
    expect((await create(oct)).error).toBeUndefined()
    const facts = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(facts.unbilledEarlier).toEqual([])
    expect(facts.leftOff).toEqual([])
    await addTime(r.id, b, [["2026-09-21", 120]])
    const later = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(later.unbilledEarlier.map((t: any) => [t.id, t.realMinutes])).toEqual([[b, 120]])
    const nov = await proposal(r.key, "2026-11", [lineOf("Theirs after all", [b])])
    expect(nov.lines.map((l: any) => [l.workMonth, l.billMinutes])).toEqual([["2026-09", 720]])
    const made = await create(nov)
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [12, 12000],
    ])
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-12" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)

  it("the month's own card keeps the client's own work out of every later one, and an undone card forgets it", async () => {
    const r = await retainerProject(["2026-09", "2026-10", "2026-11"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 41 * 60]])
    const b = await closedTask(r.id, "Theirs", null, [["2026-09-04", 600]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])], {
      excluded: [{ taskId: b, reason: "client_own" }],
    })
    expect((await create(sep)).error).toBeUndefined()
    await addTime(r.id, b, [["2026-09-20", 60]])
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-10" })).unbilledEarlier,
    ).toEqual([])
    const c = await closedTask(r.id, "Late", null, [["2026-09-22", 60]])
    const oct = await proposal(r.key, "2026-10", [], {
      excluded: [{ taskId: c, reason: "client_own" }],
    })
    expect((await create(oct)).error).toBeUndefined()
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
    expect((await run(reconcileUndo, { reconciliationId: oct.reconciliationId })).undone).toBe(true)
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-11" })).unbilledEarlier.map(
        (t: any) => t.id,
      ),
    ).toEqual([c])
  }, 120_000)

  it("a closed task left out of a later card by the day stays out of the ones after it, unless a line names it", async () => {
    const p = await dailyProject()
    const a = await closedTask(p.id, "First", "2026-09-04", [], "1 day")
    const sep = await proposal(p.key, "2026-09", [lineOf("First", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await draftedOn(sep, "2026-09-05")
    const theirs = await closedTask(p.id, "Theirs", "2026-09-20", [], "2 days")
    const now = await closedTask(p.id, "October", "2026-10-10", [], "1 day")
    const oct = await proposal(p.key, "2026-10", [lineOf("October", [now])], {
      excluded: [{ taskId: theirs, reason: "client_own" }],
    })
    expect((await create(oct)).error).toBeUndefined()
    expect(
      (await run(reconcileFacts, { project: p.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
    expect((await proposal(p.key, "2026-11", [])).lines).toEqual([])
    const named = await proposal(p.key, "2026-11", [lineOf("Theirs after all", [theirs])])
    expect(named.lines.map((l: any) => l.billMinutes)).toEqual([day(2)])
    expect((await create(named)).error).toBeUndefined()
  }, 120_000)
})

describe("the last month of a retainer, and a project billed another way since", () => {
  /** September invoiced at 47 h of 40, then 18 h more told of it. */
  async function lastMonth(months: string[] = ["2026-09"], extra: Record<string, AppCell> = {}) {
    const r = await retainerProject(months, extra)
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 47 * 60]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    const made = await create(sep)
    expect(made.error).toBeUndefined()
    await approveIssue(made.documentId)
    await addTime(r.id, a, [["2026-09-18", 18 * 60]])
    return { ...r, a }
  }

  it("turned off from the next month, its later hours bill alone from that month's card, once", async () => {
    const r = await lastMonth()
    await setSchedule(r.schedule, { terms: offFrom("2026-10") })
    const c = await closedTask(r.id, "October", "2026-10-08", [["2026-10-07", 300]])
    const oct = await proposal(r.key, "2026-10", [lineOf("October", [c])])
    expect(oct.notice?.title).toBe("Earlier hours only")
    expect(oct.createInvoice).toBe("yes")
    expect(oct.tot[0]).toMatchObject({ k: "Excl. VAT" })
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([[18, 12000]])
    expect((await stateOf(oct.reconciliationId))?.document_ref).toBe(
      `reconcile:${oct.reconciliationId}:${oct.revision}`,
    )
    // Only the earlier hours are claimed: October's are the schedule's.
    const claims = extractRows<{ k: string; n: number }>(
      await db.execute(drizzleSql`
        SELECT period_key AS k, counted_minutes AS n FROM app_projects.billing_claims
         WHERE reconciliation_id = ${oct.reconciliationId}::uuid AND state = 'reserved'`),
    )
    expect(claims).toEqual([{ k: "2026-09+2", n: 1080 }])
    // Pressed again: the same draft. Undone and made again: one draft still.
    expect((await create(oct)).documentId).toBe(made.documentId)
    expect((await run(reconcileUndo, { reconciliationId: oct.reconciliationId })).undone).toBe(true)
    const again = await create(oct)
    expect(again.error).toBeUndefined()
    expect((await approveIssue(again.documentId)).status).toBe("approved")
    expect((await stateOf(oct.reconciliationId))?.state).toBe("invoiced")
    // October's own hours are not a retainer month's later hours, on any card after.
    await addTime(r.id, c, [["2026-10-09", 600]])
    await closedTask(r.id, "More October", "2026-10-21", [["2026-10-20", 60]])
    const nov = await run(reconcileFacts, { project: r.key, month: "2026-11" })
    expect(nov.unbilledEarlier.filter((t: any) => t.workMonth)).toEqual([])
    // More of September still goes on the next card.
    await addTime(r.id, r.a, [["2026-09-19", 60]])
    const novCard = await proposal(r.key, "2026-11", [])
    const novMade = await create(novCard)
    expect((await draftLinesOf(novMade.documentId)).map((l) => l.slice(1))).toEqual([[1, 12000]])
  }, 180_000)

  it("with its schedule ended, they bill alone too", async () => {
    const r = await lastMonth()
    await setSchedule(r.schedule, { terms: offFrom("2026-10"), status: "ended" })
    const oct = await proposal(r.key, "2026-10", [])
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([[18, 12000]])
  }, 120_000)

  it("with a new schedule from the next month, they bill at the old one's rate and hours beside its fee", async () => {
    const r = await lastMonth()
    await setSchedule(r.schedule, { terms: offFrom("2026-10"), status: "ended" })
    const next = await retainerSchedule(r.id, "2026-10", {
      retainer_minutes: 6000,
      retainer_overage_rate_minor: 15000,
    })
    await retainerTimebox(r.id, next, "2026-10-01", "2026-10-31")
    const oct = await proposal(r.key, "2026-10", [])
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [18, 12000],
    ])
  }, 120_000)

  it("on a project billed by the hour since, they bill as the retainer's beside its own lines", async () => {
    const r = await lastMonth()
    await setSchedule(r.schedule, { terms: offFrom("2026-10"), status: "ended" })
    await call("projects_timePlanSet", { projectId: r.id, basis: "hourly" })
    await call("projects_billingTermsSet", { projectId: r.id, rate: 90, currency: "EUR" })
    // Closed in October, with time of September's fee on it: only October's is billed by the hour.
    const c = await closedTask(r.id, "October", "2026-10-08", [
      ["2026-09-10", 240],
      ["2026-10-07", 120],
    ])
    const oct = await proposal(r.key, "2026-10", [lineOf("October", [c])])
    expect(oct.lines.map((l: any) => [l.workMonth ?? null, l.billMinutes])).toEqual([
      [null, 120],
      ["2026-09", 22 * 60],
    ])
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [2, 9000],
      [22, 12000],
    ])
    const doc = extractRows<{ total: string; n: number }>(
      await db.execute(drizzleSql`
        SELECT subtotal_minor::text AS total,
               (external_refs->'retainer'->'late'->0->>'overage_minutes')::int AS n
          FROM app_invoicing.documents WHERE id = ${made.documentId}::uuid`),
    )[0]
    expect(doc).toEqual({ total: "282000", n: 1320 })
    await approveIssue(made.documentId)
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)

  it("on a project with a fixed price since, the card says what it cannot bill and how to", async () => {
    const r = await lastMonth()
    await setSchedule(r.schedule, { terms: offFrom("2026-10"), status: "ended" })
    await call("projects_timePlanSet", { projectId: r.id, basis: "fixed" })
    const oct = await proposal(r.key, "2026-10", [])
    const said = JSON.stringify(oct.cardNotes)
    expect(oct.lines).toEqual([])
    expect(said).toContain("18 h of 2026-09")
    expect(said).toContain("bill it by hand")
    expect(oct.createInvoice ?? null).toBeNull()
    const facts = await run(reconcileFacts, { project: r.key, month: "2026-10" })
    expect(facts.message).toContain("bill it by hand")
  }, 120_000)

  it("a closed task inside the fee is not billed by the day since, and hours within the fee are said to be nothing", async () => {
    const r = await retainerProject(["2026-09"])
    const a = await closedTask(r.id, "Upkeep", null, [["2026-09-03", 600]])
    const sep = await proposal(r.key, "2026-09", [lineOf("Upkeep", [a])])
    expect((await create(sep)).error).toBeUndefined()
    const b = await closedTask(r.id, "Closed late", "2026-09-25", [["2026-09-24", 300]])
    await setSchedule(r.schedule, { terms: offFrom("2026-10"), status: "ended" })
    const alone = await proposal(r.key, "2026-10", [])
    expect(alone.createInvoice ?? null).toBeNull()
    expect((await create(alone)).error).toBeDefined()
    expect(await docsOf(r.id)).toHaveLength(1)
    await call("projects_timePlanSet", { projectId: r.id, basis: "daily" })
    await call("projects_billingTermsSet", { projectId: r.id, rate: 930, currency: "EUR" })
    const c = await closedTask(r.id, "October", "2026-10-08", [], "1 day")
    const oct = await proposal(r.key, "2026-10", [lineOf("October", [c])])
    expect(oct.lines.map((l: any) => [l.taskIds[0], l.workMonth ?? null, l.billMinutes])).toEqual([
      [c, null, day(1)],
      [b, "2026-09", 300],
    ])
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    // 10 h and 5 h of 40: nothing above the fee, and the day.
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([[1, 93000]])
    expect(
      (await run(reconcileFacts, { project: r.key, month: "2026-11" })).unbilledEarlier,
    ).toEqual([])
  }, 120_000)

  it("work of a period billed by the day is said on a retainer's card, which cannot bill it", async () => {
    const p = await dailyProject()
    const a = await closedTask(p.id, "First", "2026-09-04", [], "1 day")
    const sep = await proposal(p.key, "2026-09", [lineOf("First", [a])])
    expect((await create(sep)).error).toBeUndefined()
    await closedTask(p.id, "Closed after", "2026-09-20", [], "2 days")
    await call("projects_timePlanSet", { projectId: p.id, basis: "retainer" })
    const schedule = await retainerSchedule(p.id, "2026-10")
    await retainerTimebox(p.id, schedule, "2026-10-01", "2026-10-31")
    const oct = await proposal(p.key, "2026-10", [])
    const said = JSON.stringify(oct.cardNotes)
    expect(said).toContain("Closed after")
    expect(said).toContain("bill it by hand")
    expect(oct.lines).toEqual([])
  }, 120_000)

  it("a prepaid month deducts its advance and bills the later hours of the month before, and its own later hours next", async () => {
    const r = await lastMonth(["2026-09", "2026-10", "2026-11"], { covers: "period_ended" })
    await db.execute(drizzleSql`
      UPDATE app_invoicing.recurring_schedules SET covers = 'period_ahead' WHERE id = ${r.schedule}::uuid`)
    await issuedAdvance(r.id, `F-2026-9${keys}`)
    const c = await closedTask(r.id, "October", null, [["2026-10-07", 42 * 60]])
    const oct = await proposal(r.key, "2026-10", [lineOf("October", [c])])
    const made = await create(oct)
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [2, 12000],
      [18, 12000],
      [-1, 450000],
    ])
    await addTime(r.id, c, [["2026-10-20", 180]])
    const nov = await proposal(r.key, "2026-11", [])
    const novMade = await create(nov)
    expect(novMade.error).toBeUndefined()
    expect((await draftLinesOf(novMade.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [3, 12000],
    ])
  }, 120_000)

  it("a month with no overage of its own can be made without its earlier one, which then never bills", async () => {
    const r = await lastMonth(["2026-09", "2026-10", "2026-11"])
    const oct = await proposal(r.key, "2026-10", [])
    expect(oct.waiveOverage).toBe(true)
    const made = await run(reconcileCreateInvoice, {
      reconciliationId: oct.reconciliationId,
      revision: oct.revision,
      waiveOverage: true,
    })
    expect(made.error).toBeUndefined()
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([[1, 450000]])
    await approveIssue(made.documentId)
    await addTime(r.id, r.a, [["2026-09-28", 60]])
    const nov = await proposal(r.key, "2026-11", [])
    const novMade = await create(nov)
    expect((await draftLinesOf(novMade.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [1, 12000],
    ])
  }, 120_000)
})

describe("a retainer's line of a task and its subtasks", () => {
  it("counts each task's time once", async () => {
    const r = await retainerProject(["2026-10"])
    const parent = await closedTask(r.id, "Whole", null, [["2026-10-05", 20 * 60]])
    const child = await call<{ id: string }>("projects_createTask", {
      projectId: r.id,
      title: "Part",
      statusLabel: "todo",
      parentTaskId: parent,
    })
    await addTime(r.id, child.id, [["2026-10-06", 30 * 60]])
    const card = await proposal(r.key, "2026-10", [lineOf("Whole", [parent])])
    expect(card.lines.reduce((a: number, l: any) => a + l.billMinutes, 0)).toBe(50 * 60)
    const made = await create(card)
    expect((await draftLinesOf(made.documentId)).map((l) => l.slice(1))).toEqual([
      [1, 450000],
      [10, 12000],
    ])
  }, 120_000)
})

describe("what the approver of a card's invoice saw is what issues", () => {
  const cardOf = async (documentId: unknown) =>
    extractRows<{ id: string; summary: string; payload_hash: string; hash: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id, summary::text AS summary, md5(current_payload::text) AS payload_hash,
               current_payload->>'draft_hash' AS hash
          FROM kernel.approval_requests
         WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:invoice_issue'
           AND status = 'pending' AND current_payload->>'draft_id' = ${String(documentId)}`),
    )
  const issued = async (projectId: string) =>
    extractRows<{ total: string; due: string; on: string }>(
      await db.execute(drizzleSql`
        SELECT grand_total_minor::text AS total,
               to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS due,
               to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "on"
          FROM app_invoicing.documents
         WHERE billing_project_id = ${projectId}::uuid AND status = 'issued'`),
    )[0]
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

  it("a tax country given while the card waits is on the card before anyone can approve it", async () => {
    const { projectId, card } = await october()
    const made = await create(card)
    const [before] = await cardOf(made.documentId)
    expect(before?.hash).toMatch(/^2:[0-9a-f]{64}:781200$/)
    const edit = await invoicing("drafts_update", {
      draft_id: made.documentId,
      patch: { external_refs: { tax_country: "CH" } },
    })
    expect((edit as { error?: unknown }).error).toBeUndefined()
    const [after] = await cardOf(made.documentId)
    expect(after?.id).toBe(before?.id as string)
    expect(after?.payload_hash).not.toBe(before?.payload_hash)
    expect(after?.hash).toMatch(/:651000$/)
    expect(after?.summary).toMatch(/6.?510/)
    expect((await approveIssue(made.documentId)).status).toBe("approved")
    expect((await issued(projectId))?.total).toBe("651000")
  }, 120_000)

  it("a draft whose amount moved behind its card takes no number", async () => {
    const { projectId, card } = await october()
    const made = await create(card)
    await db.execute(drizzleSql`
      UPDATE app_invoicing.documents SET external_refs = '{"tax_country":"CH"}'::jsonb
       WHERE id = ${made.documentId}::uuid`)
    const taken = await numbersTaken()
    await approveIssue(made.documentId).catch(() => null)
    expect(await numbersTaken()).toBe(taken)
    expect(await issued(projectId)).toBeUndefined()
  }, 120_000)

  it("the customer's payment terms recorded while the card waits are on the card, and what it is due by", async () => {
    const { projectId, card } = await october()
    const made = await create(card)
    const [before] = await cardOf(made.documentId)
    expect(before?.summary).toContain("30 days after issue")
    const terms = (days: number | null) =>
      invoicing(
        "counterparty_identity_set",
        { contact_id: compta, source: "manual", payment_terms_days: days },
        ["invoicing:*"],
      )
    try {
      const set = await terms(60)
      expect((set as { error?: unknown }).error).toBeUndefined()
      const [after] = await cardOf(made.documentId)
      expect(after?.id).toBe(before?.id as string)
      expect(after?.payload_hash).not.toBe(before?.payload_hash)
      expect(after?.summary).toContain("60 days after issue")
      expect((await approveIssue(made.documentId)).status).toBe("approved")
      const doc = await issued(projectId)
      expect(daysBetween(String(doc?.on), String(doc?.due))).toBe(60)
    } finally {
      await terms(null)
    }
  }, 120_000)

  it("terms that moved behind its card take no number", async () => {
    const { projectId, card } = await october()
    const made = await create(card)
    await db.execute(drizzleSql`
      UPDATE app_invoicing.counterparty_identities SET payment_terms_days = 90
       WHERE org_id = ${orgId}::uuid AND contact_id = ${compta}::uuid`)
    const taken = await numbersTaken()
    await approveIssue(made.documentId).catch(() => null)
    await db.execute(drizzleSql`
      UPDATE app_invoicing.counterparty_identities SET payment_terms_days = NULL
       WHERE org_id = ${orgId}::uuid AND contact_id = ${compta}::uuid`)
    expect(await numbersTaken()).toBe(taken)
    expect(await issued(projectId)).toBeUndefined()
  }, 120_000)
})
