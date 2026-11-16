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
async function retainerSchedule(projectId: string): Promise<string> {
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
    retainer_from: "2026-01",
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
})
