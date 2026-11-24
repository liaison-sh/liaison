// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A retainer turned off and on again, on the real kernel, sandbox and Postgres. The last retainer
// month and the ones before it stay on their planned vs done card with their own terms; the
// month-end run starts with the first month after, never on a past day and never on a month a
// retainer invoice or an advance already covers. Also the two writes that could lose a signed fee:
// a change staged before a renewal and approved after it, and two changes at once.
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool, executeToolCore } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
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

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
  "projects:money:write",
]
const HOUR = 3_600_000
let ORG = ""
let THREAD = ""
let ISSUER = ""
let actor: UserContext

type Row = Record<string, unknown>

async function call(
  toolName: string,
  params: Row,
  origin: "human-ui" | "in-app-agent" = "human-ui",
): Promise<{ data?: Row; blocked?: { approvalRequestId?: string }; error?: string }> {
  try {
    return (await executeTool<Row>({
      toolName: `invoicing:${toolName}`,
      orgId: ORG,
      actor,
      params,
      origin,
      ...(origin === "in-app-agent" ? { threadId: THREAD } : {}),
    })) as never
  } catch (err) {
    const e = err as { message?: string; details?: { code?: string } }
    return { error: `${e.details?.code ?? ""} ${e.message ?? String(err)}` }
  }
}

/** A tool only code calls, as the person it runs for. */
async function internal(toolName: string, params: Row): Promise<Row> {
  const env = await executeToolCore({
    toolName: `invoicing:${toolName}`,
    orgId: ORG,
    actor,
    params,
    origin: "system",
    internalCall: { callerApp: "invoicing" },
  })
  if ("error" in env) throw new Error(`${env.error.code} ${env.error.message}`)
  return ("data" in env ? env.data : {}) as Row
}

async function runJob(): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", "recurring-draft")
  if (!handler) throw new Error("recurring-draft not registered")
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
    "session",
  )
}

/** The hourly job, several times: a schedule behind takes one month a tick. */
async function tick(day: string, times = 5): Promise<void> {
  setSystemTime(new Date(Date.parse(day) + 9 * HOUR))
  for (let i = 0; i < times; i++) await runJob()
}

const line = (price: number) => ({
  description: "Monthly retainer, 40 h included",
  qty: 1,
  unit_price_minor: price,
  vat_bp: 2000,
  line_kind: "service",
})

interface World {
  issuer: string
  id: string
  project: string
  contact: string
}

async function world(over: Row = {}): Promise<World> {
  const issuer = ISSUER
  const contact = await minimal.contact(ORG, `client-${randomUUID().slice(0, 8)}@example.com`, {
    name: "Client",
  })
  await minimal.contactAddress(ORG, contact, {
    role: "billing",
    street1: "Hauptstrasse 1",
    postalCode: "10115",
    city: "Berlin",
    countryIso2: "DE",
  })
  const id = randomUUID()
  const project = randomUUID()
  const { lines, ...columns } = { lines: [line(450_000)], ...over } as Row & { lines: unknown }
  await sql.unsafe(
    insertSql("app_invoicing.recurring_schedules", {
      id,
      org_id: ORG,
      issuer_profile_id: issuer,
      contact_id: contact,
      status: "active",
      repeats: "month",
      billing_day: "last",
      lines: { raw: `'${JSON.stringify(lines)}'::jsonb` },
      retainer_project_id: project,
      retainer_minutes: 2400,
      retainer_overage_rate_minor: 12_000,
      retainer_from: "2026-10",
      next_issue_on: "2026-10-31",
      next_draft_on: "2026-10-28",
      created_by: actor.userId,
      ...columns,
    }),
  )
  return { issuer, id, project, contact }
}

async function stored(w: World): Promise<Row> {
  const [row] = await sql<Row[]>`
    SELECT status, version, next_issue_on::text, retainer_terms, lines
      FROM app_invoicing.recurring_schedules WHERE id = ${w.id}`
  return row as Row
}

const at = (day: string) => setSystemTime(new Date(Date.parse(day) + 12 * HOUR))

/** A change as a person makes it: on the version the schedule holds. */
async function update(w: World, patch: Row): Promise<Row> {
  const res = await call("recurring_schedule_update", {
    id: w.id,
    expected_version: Number((await stored(w)).version),
    ...patch,
  })
  expect(res.error).toBeUndefined()
  return res.data as Row
}
const off = (w: World) =>
  update(w, {
    retainer_minutes: null,
    retainer_project_id: null,
    retainer_overage_rate_minor: null,
  })

async function renew(w: World, startsOn: string, feeMinor: string, number: string) {
  return internal("retainer_terms_renew", {
    projectId: w.project,
    agreementId: randomUUID(),
    agreementNumber: number,
    startsOn,
    minutes: 2640,
    feeMinor,
  })
}

/** The run's drafts of the schedule, as `{ "2026-12": { net, due } }`. */
async function drafts(w: World): Promise<Record<string, number>> {
  const rows = await sql<Array<{ ref: string; net: string }>>`
    SELECT d.external_ref AS ref, sum(l.quantity::numeric * l.unit_price_minor)::text AS net
      FROM app_invoicing.documents d
      JOIN app_invoicing.document_lines l ON l.document_id = d.id
     WHERE d.org_id = ${ORG} AND d.external_ref LIKE ${`recurring:${w.id}:%`}
     GROUP BY d.external_ref`
  return Object.fromEntries(
    rows.map((r) => [r.ref.slice(`recurring:${w.id}:`.length), Number(r.net)]),
  )
}

/** A month's card, as its preview prices it for 60 h of work. */
async function card(w: World, month: string) {
  const out = await internal("preview_totals", {
    projectId: w.project,
    basis: "retainer",
    contactId: w.contact,
    periodFrom: `${month}-01`,
    lines: [{ lineId: randomUUID(), billMinutes: 3600 }],
  })
  const r = out.retainer as Row
  return {
    fee: r.feeExclMinor,
    rate: r.overageRateMinor,
    hours: Number(r.includedMinutes) / 60,
    onRun: r.billedBySchedule,
  }
}

async function document(over: Row): Promise<string> {
  const id = randomUUID()
  await sql.unsafe(
    insertSql("app_invoicing.documents", {
      id,
      org_id: ORG,
      type: "invoice",
      status: "issued",
      currency: "EUR",
      external_refs: { raw: "'{}'::jsonb" },
      lifecycle_log: { raw: "'[]'::jsonb" },
      ...over,
    }),
  )
  return id
}

const retainerInvoice = (w: World, month: string) =>
  document({
    issuer_profile_id: w.issuer,
    counterparty_contact_id: w.contact,
    billing_project_id: w.project,
    external_ref: `retainer:${w.id}:${month}`,
  })

const advance = (w: World, month: string, over: Row = {}) =>
  document({
    issuer_profile_id: w.issuer,
    counterparty_contact_id: w.contact,
    billing_project_id: w.project,
    invoice_role: "advance",
    external_ref: `advance:${w.project}:${month}`,
    service_period_start: `${month}-01`,
    grand_total_minor: 540_000,
    subtotal_minor: 450_000,
    ...over,
  })

const OWN = { fee: 450_000, rate: 12_000, hours: 40, onRun: false }

describe("a retainer turned off, on the real kernel", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    ORG = org.id
    const admin = await minimal.person(ORG, { role: "admin" })
    actor = { actorType: "user", userId: admin.id, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
    THREAD = await minimal.thread(ORG, admin.id)
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([invoicingDescriptor() as never], ORG)
    const created = await call("settings_issuer_profile_create", {
      legal_name: "Retainer Studio SAS",
      country: "FR",
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      default_currency: "EUR",
      default_language: "en",
    })
    expect(created.error).toBeUndefined()
    ISSUER = String(created.data?.id)
    await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Paris' WHERE id = ${ISSUER}`
  }, 120_000)

  afterEach(async () => {
    setSystemTime()
    await sql`UPDATE app_invoicing.recurring_schedules SET status = 'ended' WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    setSystemTime()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("a renewal of next month never reaches the running month: its card keeps the old fee", async () => {
    const w = await world({ next_issue_on: "2026-11-30", next_draft_on: "2026-11-27" })
    at("2026-11-19")
    await renew(w, "2026-12-01", "495000", "AG-1")
    at("2026-11-25")
    const r = await off(w)
    expect(String(r.message)).toContain("2026-11")
    expect((await stored(w)).next_issue_on).toBe("2026-12-31")
    await tick("2026-11-30")
    expect(await drafts(w)).toEqual({})
    expect(await card(w, "2026-11")).toEqual(OWN)
    await tick("2026-12-31")
    expect(await drafts(w)).toEqual({ "2026-12": 495_000 })
    expect((await card(w, "2026-12")).onRun).toBe(true)
  }, 120_000)

  it("off before its first month: the run's own month keeps its own lines", async () => {
    const w = await world({
      lines: [line(300_000)],
      retainer_project_id: null,
      retainer_minutes: null,
      retainer_overage_rate_minor: null,
      retainer_from: null,
      next_issue_on: "2026-12-31",
      next_draft_on: "2026-12-28",
    })
    at("2026-12-15")
    await update(w, {
      retainer_project_id: w.project,
      retainer_minutes: 2400,
      retainer_overage_rate_minor: 12_000,
      lines: [line(450_000)],
    })
    at("2026-12-20")
    const r = await off(w)
    expect(String(r.message)).toContain("2026-12-31")
    expect((await stored(w)).next_issue_on).toBe("2026-12-31")
    await tick("2026-12-31")
    expect(await drafts(w)).toEqual({ "2026-12": 300_000 })
    await tick("2027-01-31")
    expect(await drafts(w)).toEqual({ "2026-12": 300_000, "2027-01": 450_000 })
  }, 120_000)

  it("months not invoiced yet stay on their cards, and the run starts next month", async () => {
    const w = await world()
    at("2026-12-10")
    await update(w, { lines: [line(600_000)] })
    const r = await off(w)
    expect(String(r.message)).toContain("last retainer month is 2026-12")
    expect(String(r.message)).toContain("starts with 2027-01")
    expect(r.nextIssueOn).toBe("2027-01-31")
    await tick("2026-12-31")
    expect(await drafts(w)).toEqual({})
    for (const m of ["2026-10", "2026-11", "2026-12"]) expect(await card(w, m)).toEqual(OWN)
    await tick("2027-01-31")
    expect(await drafts(w)).toEqual({ "2027-01": 600_000 })
  }, 120_000)

  it("a first month the retainer already invoiced never stops the run", async () => {
    const w = await world()
    await retainerInvoice(w, "2026-10")
    at("2026-11-10")
    await off(w)
    await tick("2026-12-31")
    expect(await drafts(w)).toEqual({ "2026-12": 450_000 })
    expect(await card(w, "2026-11")).toEqual(OWN)
    await tick("2027-02-27")
    expect(await drafts(w)).toEqual({ "2026-12": 450_000, "2027-01": 450_000, "2027-02": 450_000 })
  }, 120_000)

  it("a row turned off before this rule, stuck on an invoiced month, bills again", async () => {
    const w = await world({
      retainer_project_id: null,
      retainer_minutes: null,
      retainer_overage_rate_minor: null,
      retainer_from: null,
    })
    await retainerInvoice(w, "2026-10")
    await tick("2026-11-30")
    expect(await drafts(w)).toEqual({ "2026-11": 450_000 })
  }, 120_000)

  it("prepaid: the running month's advance, and next month's, are never billed again by the run", async () => {
    const w = await world({ covers: "period_ahead" })
    await advance(w, "2026-12")
    at("2026-12-10")
    const first = await off(w)
    expect(String(first.message)).toContain("last retainer month is 2026-12")
    await tick("2026-12-31")
    expect(await drafts(w)).toEqual({})
    // Its card still deducts what was paid ahead.
    const priced = await internal("preview_totals", {
      projectId: w.project,
      basis: "retainer",
      contactId: w.contact,
      periodFrom: "2026-12-01",
      lines: [],
    })
    expect(priced.retainer).toMatchObject({ billedBySchedule: false, feeExclMinor: 450_000 })

    const ahead = await world({ covers: "period_ahead" })
    await advance(ahead, "2026-12")
    await advance(ahead, "2027-01")
    at("2026-12-10")
    const r = await off(ahead)
    expect(String(r.message)).toContain("last retainer month is 2027-01")
    expect(String(r.message)).toContain("advance")
    expect(r.nextIssueOn).toBe("2027-02-28")
    await tick("2027-01-31")
    expect(await drafts(ahead)).toEqual({})
    expect(await card(ahead, "2027-01")).toEqual(OWN)
    await tick("2027-02-28")
    expect(await drafts(ahead)).toEqual({ "2027-02": 450_000 })

    // Drafted, not issued yet: the same.
    const draft = await world({ covers: "period_ahead" })
    await advance(draft, "2027-01", { status: "draft" })
    at("2026-12-10")
    expect((await off(draft)).nextIssueOn).toBe("2027-02-28")

    // Cancelled: the month is the run's.
    const gone = await world({ covers: "period_ahead" })
    await advance(gone, "2027-01", { status: "cancelled" })
    at("2026-12-10")
    expect((await off(gone)).nextIssueOn).toBe("2027-01-31")
  }, 180_000)

  it("off, on again, off: every month is billed once, by the card or by the run", async () => {
    const w = await world()
    at("2026-12-10")
    await off(w)
    await tick("2027-01-31")
    at("2027-02-10")
    const on = await update(w, {
      retainer_project_id: w.project,
      retainer_minutes: 1800,
      retainer_overage_rate_minor: 13_000,
      lines: [line(500_000)],
    })
    expect(String(on.message)).toContain("2027-03")
    await tick("2027-02-28")
    await tick("2027-03-31")
    expect(await drafts(w)).toEqual({ "2027-01": 450_000, "2027-02": 450_000 })
    expect(await card(w, "2026-12")).toEqual(OWN)
    expect(await card(w, "2027-03")).toEqual({
      fee: 500_000,
      rate: 13_000,
      hours: 30,
      onRun: false,
    })
    at("2027-04-10")
    const again = await off(w)
    expect(String(again.message)).toContain("last retainer month is 2027-04")
    // Twice: nothing moves.
    await off(w)
    await tick("2027-05-31")
    expect(await drafts(w)).toEqual({
      "2027-01": 450_000,
      "2027-02": 450_000,
      "2027-05": 500_000,
    })
    expect((await card(w, "2027-04")).fee).toBe(500_000)
    expect((await card(w, "2027-02")).onRun).toBe(true)
    expect(await card(w, "2026-11")).toEqual(OWN)
  }, 180_000)

  it("a billing day changed, a pause and a resume while the last retainer month runs never land on it", async () => {
    const w = await world()
    at("2026-12-10")
    await off(w)
    await update(w, { billing_day: "15" })
    expect((await stored(w)).next_issue_on).toBe("2027-01-15")
    await call("recurring_schedule_pause", { id: w.id, until: "2026-12-20" })
    await tick("2026-12-20", 1)
    expect(await stored(w)).toMatchObject({ status: "active", next_issue_on: "2027-01-15" })
    await call("recurring_schedule_pause", { id: w.id })
    at("2026-12-21")
    await update(w, { status: "active" })
    expect((await stored(w)).next_issue_on).toBe("2027-01-15")
    await tick("2027-01-15")
    expect(await drafts(w)).toEqual({ "2027-01": 450_000 })
  }, 120_000)

  it("an agent's change without the version is refused before it parks; one staged before a renewal is refused when approved", async () => {
    const w = await world()
    at("2026-12-10")
    const wording = { lines: [{ ...line(450_000), description: "Design retainer, 40 h included" }] }
    for (const origin of ["in-app-agent", "human-ui"] as const) {
      const refused = await call("recurring_schedule_update", { id: w.id, ...wording }, origin)
      expect(refused.blocked).toBeUndefined()
      expect(String(refused.error)).toContain("expected_version")
      expect(String(refused.error)).toContain("version 1")
    }
    const parked = await call(
      "recurring_schedule_update",
      { id: w.id, expected_version: 1, terms_month: "2027-01", ...wording },
      "in-app-agent",
    )
    const requestId = parked.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()
    await renew(w, "2027-01-01", "495000", "AG-1")
    await decideApproval({
      orgId: ORG,
      requestId: requestId as string,
      actor,
      decision: "approve",
    }).catch(() => {})
    expect((await card(w, "2027-01")).fee).toBe(495_000)
  }, 120_000)

  it("on again once the run holds next month: it starts after it, and nothing is billed twice", async () => {
    for (const covers of ["period_ahead", "period_ended"]) {
      const w = await world({
        covers,
        billing_day: "1",
        next_issue_on: "2027-01-01",
        next_draft_on: "2026-12-29",
      })
      at("2026-12-10")
      await off(w)
      await tick("2026-12-30")
      expect(await drafts(w)).toEqual({ "2027-01": 450_000 })
      at("2026-12-30")
      const r = await update(w, {
        retainer_project_id: w.project,
        retainer_minutes: 2400,
        retainer_overage_rate_minor: 12_000,
      })
      expect(String(r.message)).toContain("again from 2027-02")
      expect(String(r.message)).toContain("already holds 2027-01")
      const ask = (month: string) =>
        call("advance_draft_create", { projectId: w.project, amountMinor: 450_000, month })
      expect(String((await ask("2027-01")).error)).toContain("The retainer bills from 2027-02")
      expect((await card(w, "2026-12")).onRun).toBe(false)
      expect((await card(w, "2027-01")).onRun).toBe(true)
      expect(await card(w, "2027-02")).toEqual(OWN)
      await tick("2027-02-27")
      expect(await drafts(w)).toEqual({ "2027-01": 450_000 })
    }
  }, 180_000)

  it("made a retainer for the first time once the run holds next month: from the month after", async () => {
    const w = await world({
      retainer_project_id: null,
      retainer_minutes: null,
      retainer_overage_rate_minor: null,
      retainer_from: null,
      billing_day: "1",
      covers: "period_ahead",
      next_issue_on: "2027-01-01",
      next_draft_on: "2026-12-29",
    })
    await tick("2026-12-30")
    expect(await drafts(w)).toEqual({ "2027-01": 450_000 })
    at("2026-12-30")
    await update(w, {
      retainer_project_id: w.project,
      retainer_minutes: 2400,
      retainer_overage_rate_minor: 12_000,
    })
    const r = await call("advance_draft_create", {
      projectId: w.project,
      amountMinor: 450_000,
      month: "2027-01",
    })
    expect(String(r.error)).toContain("The retainer bills from 2027-02")
    expect((await card(w, "2027-01")).onRun).toBe(true)
    expect(await card(w, "2027-02")).toEqual(OWN)
  }, 120_000)

  it("another retainer's advances on the project never silence a turned-off schedule's months", async () => {
    const a = await world()
    at("2026-12-10")
    await off(a)
    const b = await world({
      retainer_project_id: a.project,
      retainer_from: "2027-01",
      covers: "period_ahead",
      next_issue_on: "2027-01-31",
      next_draft_on: "2027-01-28",
    })
    for (const month of ["2027-02", "2027-03"]) await advance({ ...b, project: a.project }, month)
    await tick("2027-03-31", 8)
    expect(await drafts(a)).toEqual({ "2027-01": 450_000, "2027-02": 450_000, "2027-03": 450_000 })
    expect(await drafts(b)).toEqual({})
  }, 120_000)

  it("a row turned off before this rule with two invoiced months in a row bills the next ones", async () => {
    const w = await world({
      retainer_project_id: null,
      retainer_minutes: null,
      retainer_overage_rate_minor: null,
      retainer_from: null,
    })
    await retainerInvoice(w, "2026-10")
    await retainerInvoice(w, "2026-11")
    await tick("2027-01-31", 8)
    expect(await drafts(w)).toEqual({ "2026-12": 450_000, "2027-01": 450_000 })
  }, 120_000)

  it("ended after it was turned off, or while on: its months stay on their card, none after", async () => {
    for (const first of ["off", "on"]) {
      const w = await world()
      at("2026-12-10")
      if (first === "off") await off(w)
      const r = await update(w, { status: "ended" })
      expect(String(r.message)).toContain("last retainer month is 2026-12")
      for (const m of ["2026-10", "2026-12"]) expect(await card(w, m)).toEqual(OWN)
      const gone = await internal("preview_totals", {
        projectId: w.project,
        basis: "retainer",
        contactId: w.contact,
        periodFrom: "2027-01-01",
        lines: [],
      })
      expect(gone.ready).toBe(false)
      await tick("2027-02-28")
      expect(await drafts(w)).toEqual({})
    }
  }, 120_000)

  it("a signed renewal survives off and on again, and the project never moves", async () => {
    const w = await world()
    at("2026-12-10")
    await renew(w, "2027-03-01", "495000", "AG-9")
    await off(w)
    const on = {
      retainer_project_id: w.project,
      retainer_minutes: 2400,
      retainer_overage_rate_minor: 12_000,
    }
    const r = await update(w, on)
    expect(String(r.message)).toContain("From 2027-03 the signed terms of AG-9 apply")
    expect((await card(w, "2027-02")).fee).toBe(450_000)
    expect((await card(w, "2027-03")).fee).toBe(495_000)
    const move = { retainer_project_id: randomUUID() }
    for (const patch of [move, { ...on, ...move }]) {
      const res = await call("recurring_schedule_update", {
        id: w.id,
        expected_version: Number((await stored(w)).version),
        ...patch,
      })
      expect(String(res.error)).toContain(w.project)
    }
    expect((await card(w, "2026-12")).fee).toBe(450_000)
  }, 120_000)

  it("a pause and a resume by its date never lower the version nor lose a change made meanwhile", async () => {
    at("2026-12-10")
    const held = async (w: World, run: () => Promise<unknown>) => {
      let release: () => void = () => {}
      const go = new Promise<void>((r) => {
        release = r
      })
      let version = 0
      // Another change holds the row while the pause or the job waits to write it.
      const other = sql.begin(async (tx) => {
        const [row] = await tx<Array<{ version: number }>>`
          UPDATE app_invoicing.recurring_schedules SET version = version + 5, notes = 'Net 30'
           WHERE id = ${w.id} RETURNING version`
        version = Number(row?.version)
        await go
      })
      const doing = run()
      for (let i = 0; i < 100; i++) {
        const [row] = await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE NOT l.granted AND a.datname = current_database()`
        if ((row?.n ?? 0) > 0) break
        await Bun.sleep(50)
      }
      release()
      await other
      await doing
      return version
    }
    const w = await world()
    const before = await held(w, () =>
      call("recurring_schedule_pause", { id: w.id, until: "2026-12-20" }),
    )
    expect(await stored(w)).toMatchObject({ status: "paused", version: before + 1 })
    setSystemTime(new Date(Date.parse("2026-12-20") + 9 * HOUR))
    const paused = await held(w, runJob)
    expect(await stored(w)).toMatchObject({ status: "active", version: paused + 1 })
  }, 120_000)

  it("changes at once: each is saved or refused, and no dated terms are lost", async () => {
    at("2026-12-10")
    const w = await world()
    // Every call reads the row, then waits for this lock to write it.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const lock = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM app_invoicing.recurring_schedules WHERE id = ${w.id} FOR UPDATE`
      await held
    })
    const change = (patch: Row) =>
      call("recurring_schedule_update", { id: w.id, expected_version: 1, ...patch })
    const calls = Promise.all([
      change({ retainer_overage_rate_minor: 15_000 }),
      change({ lines: [line(480_000)] }),
      renew(w, "2027-02-01", "495000", "AG-1"),
    ])
    const waiting = async () => {
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(DISTINCT l.pid)::int AS n
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database()`
      return row?.n ?? 0
    }
    for (let i = 0; i < 100 && (await waiting()) < 3; i++) await Bun.sleep(50)
    expect(await waiting()).toBe(3)
    release()
    await lock
    const results = await calls
    const saved = results.filter((r) => !(r as { error?: string }).error)
    const row = await stored(w)
    // Every change that answered done is in the row, and the signed renewal is one of them.
    expect(Number(row.version)).toBe(1 + saved.length)
    expect((row.retainer_terms as Row[]).map((t) => t.agreement_number)).toContain("AG-1")
    expect((await card(w, "2027-02")).fee).toBe(495_000)
    const [rate, fee] = results as Array<{ error?: string }>
    const january = await card(w, "2027-01")
    expect(january.rate).toBe(rate?.error ? 12_000 : 15_000)
    expect(january.fee).toBe(fee?.error ? 450_000 : 480_000)
  }, 60_000)
})
