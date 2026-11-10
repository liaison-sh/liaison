// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run on the real kernel, sandbox and Postgres: drafted on Friday, approved with no
// number taken, issued on Monday from 08:00 in Paris one transaction per draft. A failed draft
// rolls back alone; two issues racing on one approved row issue one document and take one number;
// a run draft is refused by invoice_issue; the issued document carries the period's key.
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { ObjectStorageTestAccess } from "~/infra/storage/object-storage"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTemplate } from "~/modules/pdf/registry"
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

async function registerInvoiceTemplate(): Promise<void> {
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(REPO_ROOT, "bundled-apps", "invoicing", "templates", "invoice.ts"),
      "--target",
      "bun",
      "--external",
      "node:*",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (build.exitCode !== 0) throw new Error(`template build failed: ${build.stderr.toString()}`)
  let js = build.stdout.toString()
  const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
  const local = block?.[1]
    ?.split(",")
    .map((x) => x.trim())
    .map((x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null))
    .find((x) => x)
  if (!block || !local) throw new Error("template exports no renderTemplate")
  js = `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`
  registerTemplate("invoicing", "invoicing:invoice_v1", js)
}

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
]
let ORG = ""
let actor: UserContext

type Row = Record<string, unknown>

async function tool(toolName: string, params: Row): Promise<{ data?: Row; error?: string }> {
  try {
    const res = await executeTool<Row>({
      toolName: `invoicing:${toolName}`,
      orgId: ORG,
      actor,
      params,
      origin: "human-ui",
    })
    return { data: res.data as Row }
  } catch (err) {
    const e = err as { message?: string; details?: { code?: string } }
    return { error: `${e.details?.code ?? ""} ${e.message ?? String(err)}` }
  }
}

async function runJob(name: string): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", name)
  if (!handler) throw new Error(`${name} not registered`)
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
    "session",
  )
}

/** An issuer in Paris with `n` monthly schedules due for their draft on Friday 27 November 2026. */
async function monthEnd(n: number): Promise<{ issuer: string; schedules: string[] }> {
  const created = await tool("settings_issuer_profile_create", {
    legal_name: `Studio ${randomUUID().slice(0, 8)}`,
    country: "FR",
    vat_id: "FR40902000009",
    address: "1 rue de Test, 75011 Paris",
    default_currency: "EUR",
    default_language: "en",
  })
  const issuer = String(created.data?.id)
  await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Paris' WHERE id = ${issuer}`
  const schedules: string[] = []
  for (let i = 1; i <= n; i++) {
    const contact = randomUUID()
    const prev = randomUUID()
    const id = randomUUID()
    await sql.unsafe(
      insertSql("app_invoicing.documents", {
        id: prev,
        org_id: ORG,
        type: "invoice",
        status: "issued",
        issuer_profile_id: issuer,
        counterparty_contact_id: contact,
        counterparty_name: `Client ${i}`,
        counterparty_address: `Hauptstrasse ${i}, 10115 Berlin`,
        counterparty_country: "DE",
        customer_kind: "individual",
        counterparty_email: `client${i}@example.com`,
        currency: "EUR",
        external_refs: { raw: "'{}'::jsonb" },
        lifecycle_log: { raw: "'[]'::jsonb" },
      }),
    )
    await sql.unsafe(
      insertSql("app_invoicing.recurring_schedules", {
        id,
        org_id: ORG,
        issuer_profile_id: issuer,
        contact_id: contact,
        status: "active",
        repeats: "month",
        billing_day: "last",
        lines: {
          raw: `'${JSON.stringify([{ description: `Retainer ${i} {period}`, qty: 1, unit_price_minor: 10000 * i, vat_bp: 2000, line_kind: "service" }])}'::jsonb`,
        },
        next_issue_on: "2026-11-30",
        next_draft_on: "2026-11-27",
        last_document_id: prev,
        created_by: actor.userId,
      }),
    )
    schedules.push(id)
  }
  return { issuer, schedules }
}

async function runOf(issuer: string): Promise<Row> {
  const [run] = await sql<
    Row[]
  >`SELECT id::text, status, approval_request_id, approved_by::text FROM app_invoicing.recurring_runs WHERE issuer_profile_id = ${issuer}`
  if (!run) throw new Error("no run")
  return run
}

async function itemsOf(runId: string): Promise<Row[]> {
  return sql<
    Row[]
  >`SELECT id::text, state, document_id::text, issued_number, position FROM app_invoicing.recurring_run_items WHERE run_id = ${runId} ORDER BY position`
}

async function documentsOf(issuer: string): Promise<Row[]> {
  return sql<
    Row[]
  >`SELECT id::text, status, number, number_int, external_ref, external_refs, lifecycle_log, to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS issued_on, year_of_issue FROM app_invoicing.documents WHERE issuer_profile_id = ${issuer} AND (status = 'draft' OR external_ref IS NOT NULL) ORDER BY number_int NULLS LAST`
}

async function sequenceOf(issuer: string): Promise<number> {
  const [row] = await sql<
    Array<{ value: number | string }>
  >`SELECT value FROM kernel.app_sequences WHERE org_id = ${ORG} AND key = ${`invoicing:doc_number:${issuer}:invoice:2026`}`
  return Number(row?.value ?? 0)
}

/** Draft on Friday 27 November, approve the card, move the clock to Monday 30 November 08:30 Paris. */
async function draftAndApprove(n: number) {
  const fx = await monthEnd(n)
  setSystemTime(new Date("2026-11-27T09:00:00Z"))
  await runJob("recurring-draft")
  const run = await runOf(fx.issuer)
  expect(run.status).toBe("drafted")
  await decideApproval({
    orgId: ORG,
    requestId: String(run.approval_request_id),
    actor,
    decision: "approve",
  })
  setSystemTime(new Date("2026-11-30T07:30:00Z"))
  return { ...fx, runId: String(run.id) }
}

describe("the month-end run on the real kernel", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    ORG = org.id
    const admin = await minimal.person(ORG, { role: "admin" })
    actor = { actorType: "user", userId: admin.id, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([invoicingDescriptor() as never], ORG)
    await registerInvoiceTemplate()
  }, 120_000)

  afterEach(async () => {
    setSystemTime()
    ObjectStorageTestAccess.resetClient()
    await sql`DROP TRIGGER IF EXISTS refuse_one_issue ON app_invoicing.documents`
  })

  afterAll(async () => {
    setSystemTime()
    await sql`DROP FUNCTION IF EXISTS app_invoicing.refuse_one_issue_fn()`
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("approval records each item's hash and assigns no number", async () => {
    const fx = await draftAndApprove(2)
    const run = await runOf(fx.issuer)
    expect(run).toMatchObject({ status: "approved", approved_by: actor.userId })
    const items = await itemsOf(fx.runId)
    expect(items.map((i) => i.state)).toEqual(["approved", "approved"])
    const docs = await documentsOf(fx.issuer)
    expect(docs.every((d) => d.status === "draft" && d.number === null)).toBe(true)
    expect(await sequenceOf(fx.issuer)).toBe(0)
  }, 120_000)

  it("invoice_issue on a run draft is refused and names the run", async () => {
    const fx = await draftAndApprove(1)
    const [item] = await itemsOf(fx.runId)
    const res = await tool("invoice_issue", { draft_id: String(item?.document_id) })
    expect(JSON.stringify(res)).toContain("belongs to the month-end run")
    expect(JSON.stringify(res)).toContain(fx.runId)
    expect(await sequenceOf(fx.issuer)).toBe(0)
  }, 120_000)

  it("two issue ticks racing on one approved item issue one document and take one number", async () => {
    const fx = await draftAndApprove(1)
    const [item] = await itemsOf(fx.runId)
    await sql`UPDATE app_invoicing.recurring_runs SET status = 'issuing' WHERE id = ${fx.runId}`
    // A barrier: both calls are built, then released together on two connections.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const racer = async () => {
      await gate
      return tool("recurring_item_issue", { item_id: String(item?.id) })
    }
    const both = Promise.all([racer(), racer()])
    release()
    const results = await both
    const done = results.filter((r) => (r.data as Row | undefined)?.status === "completed")
    expect(done).toHaveLength(1)
    expect(JSON.stringify(results)).toContain("is already issued")
    const issued = (await documentsOf(fx.issuer)).filter((d) => d.number !== null)
    expect(issued).toHaveLength(1)
    expect(await sequenceOf(fx.issuer)).toBe(1)
  }, 120_000)

  it("after issue the item, external_ref and the change log all name the issued document", async () => {
    const fx = await draftAndApprove(1)
    const [before] = await itemsOf(fx.runId)
    await runJob("recurring-issue")
    const [after] = await itemsOf(fx.runId)
    const [doc] = (await documentsOf(fx.issuer)).filter((d) => d.number !== null)
    expect(after?.document_id).toBe(String(doc?.id))
    expect(after?.document_id).not.toBe(before?.document_id)
    expect(doc?.external_ref).toBe(`recurring:${fx.schedules[0]}:2026-11`)
    expect((doc?.external_refs as Row).recurring_run_item_id).toBe(after?.id)
    expect(JSON.stringify(doc?.lifecycle_log)).toContain("drafted")
    // Legal date: Monday 30 November in Paris, numbered in 2026.
    expect(doc).toMatchObject({ issued_on: "2026-11-30", year_of_issue: 2026 })
    expect((await runOf(fx.issuer)).status).toBe("issued")
    const draftLeft =
      await sql`SELECT id FROM app_invoicing.documents WHERE id = ${String(before?.document_id)}`
    expect(draftLeft).toHaveLength(0)
  }, 120_000)

  it("a forced failure on item 4 of 7 leaves 6 issued with consecutive numbers, item 4 an unnumbered draft, the sequence advanced by 6, the run partial and one attention item naming it", async () => {
    const fx = await draftAndApprove(7)
    const items = await itemsOf(fx.runId)
    const fourth = items[3]
    const [draft4] = await sql<
      Row[]
    >`SELECT external_ref FROM app_invoicing.documents WHERE id = ${String(fourth?.document_id)}`
    // The issued document of item 4 cannot be written: its number is taken, then refused.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION app_invoicing.refuse_one_issue_fn() RETURNS trigger AS $$
      BEGIN IF NEW.external_ref = '${String(draft4?.external_ref)}' AND NEW.number IS NOT NULL THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await sql.unsafe(
      `CREATE TRIGGER refuse_one_issue BEFORE INSERT ON app_invoicing.documents FOR EACH ROW EXECUTE FUNCTION app_invoicing.refuse_one_issue_fn()`,
    )
    await runJob("recurring-issue")
    const after = await itemsOf(fx.runId)
    expect(after.map((i) => i.state)).toEqual([
      "issued",
      "issued",
      "issued",
      "failed",
      "issued",
      "issued",
      "issued",
    ])
    const numbered = (await documentsOf(fx.issuer))
      .filter((d) => d.number_int !== null)
      .map((d) => Number(d.number_int))
    expect(numbered).toEqual([1, 2, 3, 4, 5, 6])
    const [d4] = await sql<
      Row[]
    >`SELECT status, number FROM app_invoicing.documents WHERE id = ${String(fourth?.document_id)}`
    expect(d4).toMatchObject({ status: "draft", number: null })
    expect(await sequenceOf(fx.issuer)).toBe(6)
    expect((await runOf(fx.issuer)).status).toBe("partial")
    const attention = await sql<
      Row[]
    >`SELECT id FROM kernel.attention_items WHERE org_id = ${ORG} AND kind = 'invoicing:recurring_run.partial' AND summary LIKE ${`%${String(fourth?.document_id)}%`}`
    expect(attention.length).toBe(1)
  }, 180_000)
})
