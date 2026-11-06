// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The issue date and number year of a document, proven where the bug lived: through executeTool ->
// sandbox -> bridge. The sandbox has no `Intl`, so a mock that skips QuickJS passes on code that
// always lands on UTC. The clock is the host's: the bridge reads it, so `setSystemTime` sets the
// instant the number is taken, and the rows and PDF text below are what the instant produced.

import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { approvalPolicies } from "~/db/schema/kernel"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import { registerTemplate } from "~/modules/pdf/registry"
import { getFileBytes } from "~/modules/pdf/render"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { onOrAfterCutover } from "../../../../../bundled-apps/invoicing/src/einvoicing/transmit"

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

/** The invoice and credit note PDF templates, built as the package build makes them. */
async function registerInvoicingTemplates(): Promise<void> {
  for (const kind of ["invoice", "credit_note", "quote", "proforma", "po"]) {
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(REPO_ROOT, "bundled-apps", "invoicing", "templates", `${kind}.ts`),
        "--target",
        "bun",
        "--external",
        "node:*",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (build.exitCode !== 0)
      throw new Error(`template ${kind} build failed: ${build.stderr.toString()}`)
    let js = build.stdout.toString()
    const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
    const local = block?.[1]
      ?.split(",")
      .map((x) => x.trim())
      .map(
        (x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null),
      )
      .find((x) => x)
    if (!block || !local) throw new Error(`template ${kind} exports no renderTemplate`)
    js = `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`
    registerTemplate("invoicing", `invoicing:${kind}_v1`, js)
  }
}

let ORG = ""
let THREAD = ""

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
]
let actor: UserContext

// A German consumer: plain VAT, no e-invoice gate, no e-invoicing prerequisites to set up here.
const buyer = {
  legal_name: "Erika Mustermann",
  country: "DE",
  address: "Hauptstrasse 1, 10115 Berlin",
  email: "erika@example.com",
  customer_kind: "individual",
}
const items = [
  { description: "Service", quantity: "1", unit_price_minor: 10000, line_kind: "software" },
]

interface ToolResult {
  status?: string
  code?: unknown
  message?: string
  data?: Record<string, unknown>
}

/** A refusal either way the tool reports it: a thrown typed error, or an error envelope in `data`. */
async function tool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const res = await executeTool<Record<string, unknown>>({
      toolName: `invoicing:${toolName}`,
      orgId: ORG,
      actor,
      params,
      threadId: THREAD,
      origin: "human-ui",
    })
    return { data: res.data }
  } catch (err) {
    return { status: "error", code: (err as { code?: unknown }).code, message: String(err) }
  }
}

function documentId(res: ToolResult): string {
  const id = res.data?.document_id
  if (!id) throw new Error(`no document issued: ${JSON.stringify(res)}`)
  return String(id)
}

/** An issuer as a person creates one; `zone` then sets the stored value as it may already be. */
async function issuerAt(zone: string | null): Promise<string> {
  const created = await tool("settings_issuer_profile_create", {
    legal_name: `Issuer ${randomUUID().slice(0, 8)}`,
    country: "FR",
    vat_id: "FR40902000009",
    address: "1 rue de Test, 75011 Paris",
    default_currency: "EUR",
    default_language: "en",
  })
  const id = created.data?.id
  if (!id) throw new Error(`issuer not created: ${JSON.stringify(created)}`)
  if (zone !== null) {
    await sql`UPDATE app_invoicing.issuer_profiles SET timezone = ${zone} WHERE id = ${String(id)}`
  }
  return String(id)
}

async function setOrgZone(zone: string): Promise<void> {
  await sql`UPDATE kernel.organizations SET timezone = ${zone} WHERE id = ${ORG}`
}

interface DocRow {
  id: string
  issued_at: Date | string
  year_of_issue: number
  number: string
  pdf_file_id: string | null
  pdf_status: string
  status: string
}

async function doc(id: unknown): Promise<DocRow> {
  const [row] = await sql<DocRow[]>`SELECT * FROM app_invoicing.documents WHERE id = ${String(id)}`
  if (!row) throw new Error(`no document ${String(id)}`)
  return row
}

/** The stored date as Postgres holds it, read in UTC: the same day the document states. */
async function storedDate(id: unknown): Promise<string> {
  const [row] = await sql<Array<{ d: string }>>`
    SELECT to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM app_invoicing.documents WHERE id = ${String(id)}`
  return String(row?.d)
}

async function invoiceOf(issuerId: string): Promise<DocRow & { date: string }> {
  const res = await tool("invoice_create_and_issue", {
    counterparty: buyer,
    issuer_profile_id: issuerId,
    currency: "EUR",
    operation_category: "services",
    items,
  })
  const id = res.data?.document_id
  if (!id) throw new Error(`issue failed: ${JSON.stringify(res)}`)
  return { ...(await doc(id)), date: await storedDate(id) }
}

describe("issue date and number year (real Postgres, sandbox, bridge)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    ORG = org.id
    const admin = await minimal.person(ORG, { role: "admin" })
    THREAD = await minimal.thread(ORG, admin.id)
    actor = { actorType: "user", userId: admin.id, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([invoicingDescriptor() as never], ORG)
    await registerInvoicingTemplates()
  }, 120_000)

  afterEach(async () => {
    setSystemTime()
    if (ORG) await setOrgZone("UTC")
  })

  afterAll(async () => {
    setSystemTime()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("00:20 on 1 January in Paris: dated 1 January, numbered in the new year, printed so", async () => {
    const issuer = await issuerAt("Europe/Paris")
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const d = await invoiceOf(issuer)
    expect(d.date).toBe("2027-01-01")
    expect(d.year_of_issue).toBe(2027)
    expect(d.number).toContain("2027")
    expect(d.pdf_status).toBe("ready")
    const text = await extractPdfText(await getFileBytes(null, String(d.pdf_file_id)))
    expect(text).toContain(d.number)
    expect(text).toMatch(/(2027-01-01|01\/01\/2027|1 January 2027|Jan(uary)? 1, 2027|01 Jan 2027)/)
    expect(text).not.toMatch(
      /(2026-12-31|31\/12\/2026|31 December 2026|December 31, 2026|31 Dec 2026)/,
    )
  }, 60_000)

  it("00:20 on the cut-over day counts as on it, and the stored date says why", async () => {
    const issuer = await issuerAt("Europe/Paris")
    setSystemTime(new Date("2026-08-31T22:20:00Z"))
    const d = await invoiceOf(issuer)
    expect(d.date).toBe("2026-09-01")
    expect(d.year_of_issue).toBe(2026)
    // As `sendSwitchProblem` reads it: the row's value, in the form the bridge returns it.
    const [viaJson] = JSON.parse(JSON.stringify([d.issued_at])) as string[]
    expect(onOrAfterCutover(viaJson, "2026-09-01")).toBe(true)
    expect(onOrAfterCutover(viaJson, "2026-09-02")).toBe(false)
  }, 60_000)

  it("the night the clocks change", async () => {
    const issuer = await issuerAt("Europe/Paris")
    setSystemTime(new Date("2027-03-28T01:30:00Z"))
    expect((await invoiceOf(issuer)).date).toBe("2027-03-28")
    // One hour after local midnight the winter before: still the offset of that day.
    setSystemTime(new Date("2027-03-27T23:30:00Z"))
    expect((await invoiceOf(issuer)).date).toBe("2027-03-28")
    setSystemTime(new Date("2027-03-27T22:30:00Z"))
    expect((await invoiceOf(issuer)).date).toBe("2027-03-27")
  }, 60_000)

  it("an issuer on the default UTC follows its org; both on UTC stay on UTC", async () => {
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const issuer = await issuerAt("UTC")
    const both = await invoiceOf(issuer)
    expect(both.date).toBe("2026-12-31")
    expect(both.year_of_issue).toBe(2026)
    await setOrgZone("Europe/Paris")
    const follows = await invoiceOf(issuer)
    expect(follows.date).toBe("2027-01-01")
    expect(follows.year_of_issue).toBe(2027)
    const untouched = await issuerAt(null)
    expect((await invoiceOf(untouched)).date).toBe("2027-01-01")
  }, 60_000)

  it("UTC chosen on purpose stays UTC in an org on another zone, and clears the readiness line", async () => {
    await setOrgZone("Europe/Paris")
    const issuer = await issuerAt("UTC")
    const line = async () => {
      const res = await tool("einvoicing_readiness", {})
      const zones = (res.data?.issuer_time_zones_to_choose ?? []) as Array<{
        issuer_profile_id: string
      }>
      return zones.some((z) => z.issuer_profile_id === issuer)
    }
    expect(await line()).toBe(true)
    const listed = async () => {
      const res = await tool("settings_issuer_profile_list", {})
      const rows = (res.data?.items ?? []) as Array<Record<string, unknown>>
      return rows.find((r) => r.id === issuer)
    }
    expect((await listed())?.timezone_choice_needed).toBe(true)

    const saved = await tool("settings_issuer_profile_update", { id: issuer, timezone: "UTC" })
    expect(saved.data?.id ?? saved.data?.status).toBeTruthy()
    expect(await line()).toBe(false)
    expect((await listed())?.timezone_choice_needed).toBe(false)

    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const d = await invoiceOf(issuer)
    expect(d.date).toBe("2026-12-31")
    expect(d.year_of_issue).toBe(2026)
  }, 60_000)

  it("choosing a zone clears the line and takes effect; an unknown one is refused when saved", async () => {
    const issuer = await issuerAt("UTC")
    const bad = await tool("settings_issuer_profile_update", {
      id: issuer,
      timezone: "Europe/Atlantis",
    })
    expect(JSON.stringify(bad)).toContain("issuer_timezone_invalid")
    const [row] = await sql<
      Array<{ timezone: string }>
    >`SELECT timezone FROM app_invoicing.issuer_profiles WHERE id = ${issuer}`
    expect(row?.timezone).toBe("UTC")

    await tool("settings_issuer_profile_update", { id: issuer, timezone: "Asia/Tokyo" })
    setSystemTime(new Date("2026-12-31T16:00:00Z"))
    expect((await invoiceOf(issuer)).date).toBe("2027-01-01")
  }, 60_000)

  it("an unknown zone already on file refuses the issue, and no number is taken", async () => {
    const issuer = await issuerAt("Europe/Atlantis")
    const res = await tool("invoice_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      operation_category: "services",
      items,
    })
    expect(JSON.stringify(res)).toContain("issuer_timezone_invalid")
    const rows =
      await sql`SELECT id FROM app_invoicing.documents WHERE org_id = ${ORG} AND issuer_profile_id = ${issuer}`
    expect(rows.length).toBe(0)
    const seqs =
      await sql`SELECT key FROM kernel.app_sequences WHERE org_id = ${ORG} AND key LIKE ${`invoicing:doc_number:${issuer}:%`}`
    expect(seqs.length).toBe(0)
  }, 60_000)

  it("every other issuing tool takes the same date: draft, quote, proforma, purchase order, conversion", async () => {
    const issuer = await issuerAt("Europe/Paris")
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const expectNewYear = async (id: unknown) => {
      expect(await storedDate(id)).toBe("2027-01-01")
      const d = await doc(id)
      expect(d.year_of_issue).toBe(2027)
      expect(d.number).toContain("2027")
    }

    const draft = await tool("drafts_create", {
      type: "invoice",
      issuer_profile_id: issuer,
      counterparty_name: buyer.legal_name,
      counterparty_country: buyer.country,
      counterparty_address: buyer.address,
      counterparty_email: buyer.email,
      customer_kind: buyer.customer_kind,
      currency: "EUR",
      operation_category: "services",
      items,
    })
    const draftId = draft.data?.draft_id ?? draft.data?.id ?? draft.data?.document_id
    if (!draftId) throw new Error(`draft failed: ${JSON.stringify(draft)}`)
    const fromDraft = await tool("invoice_issue", { draft_id: draftId })
    await expectNewYear(documentId(fromDraft))

    const proforma = await tool("proforma_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      items,
    })
    await expectNewYear(documentId(proforma))

    const po = await tool("po_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      items,
    })
    await expectNewYear(documentId(po))

    const quote = await tool("quote_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      items,
    })
    await expectNewYear(documentId(quote))

    const converted = await tool("documents_convert_to_invoice", {
      source_document_id: documentId(quote),
      operation_category: "services",
    })
    await expectNewYear(converted.data?.document_id ?? converted.data?.invoice_id)
  }, 120_000)

  it("a conversion refused for its zone leaves the quote as it was", async () => {
    const issuer = await issuerAt("Europe/Paris")
    const quote = await tool("quote_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      items,
    })
    await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Atlantis' WHERE id = ${issuer}`
    const res = await tool("documents_convert_to_invoice", {
      source_document_id: documentId(quote),
      operation_category: "services",
    })
    expect(JSON.stringify(res)).toContain("issuer_timezone_invalid")
    expect((await doc(documentId(quote))).status).toBe("sent")
  }, 60_000)

  it("a credit note keeps its stated date, never one before the last number of its series", async () => {
    const issuer = await issuerAt("Europe/Paris")
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const negative = [
      { description: "Reversal", quantity: "1", unit_price_minor: -10000, line_kind: "software" },
    ]
    const today = await tool("credit_note_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      operation_category: "services",
      items: negative,
    })
    expect(await storedDate(documentId(today))).toBe("2027-01-01")
    expect((await doc(documentId(today))).year_of_issue).toBe(2027)

    setSystemTime(new Date("2027-01-10T10:00:00Z"))
    const stated = await tool("credit_note_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      operation_category: "services",
      issued_at: "2027-01-05",
      items: negative,
    })
    expect(await storedDate(documentId(stated))).toBe("2027-01-05")

    const before = await tool("credit_note_create_and_issue", {
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      operation_category: "services",
      issued_at: "2027-01-04",
      items: negative,
    })
    expect(JSON.stringify(before)).toContain("issue_date_before_last_number")
    const rows =
      await sql`SELECT id FROM app_invoicing.documents WHERE org_id = ${ORG} AND issuer_profile_id = ${issuer}`
    expect(rows.length).toBe(2)
  }, 60_000)

  describe("a date stated on a new quote, proforma or purchase order", () => {
    const series = async (issuer: string) =>
      sql<Array<{ key: string; value: string }>>`
        SELECT key, value::text AS value FROM kernel.app_sequences
         WHERE org_id = ${ORG} AND key LIKE ${`invoicing:doc_number:${issuer}:quote:%`} ORDER BY key`
    const issueQuote = (issuer: string, issuedAt: unknown) =>
      tool("quote_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuer,
        currency: "EUR",
        items,
        issued_at: issuedAt,
      })

    it("the document takes the date, and the date decides the number's year", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2027-01-20T10:00:00Z"))
      const quote = documentId(await issueQuote(issuer, "2026-12-15"))
      expect(await storedDate(quote)).toBe("2026-12-15")
      expect((await doc(quote)).year_of_issue).toBe(2026)

      const proforma = await tool("proforma_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuer,
        currency: "EUR",
        reason: "Customs",
        items,
        issued_at: "2027-01-05",
      })
      expect(await storedDate(documentId(proforma))).toBe("2027-01-05")

      const po = await tool("po_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuer,
        currency: "EUR",
        items,
        issued_at: "2027-01-06",
      })
      expect(await storedDate(documentId(po))).toBe("2027-01-06")
    }, 60_000)

    it("no date still means today in the issuer's time zone", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      const quote = await tool("quote_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuer,
        currency: "EUR",
        items,
      })
      expect(await storedDate(documentId(quote))).toBe("2027-01-01")
    }, 60_000)

    it("a date after today, or no real date, is refused and no number is taken", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      const before = await series(issuer)
      expect(JSON.stringify(await issueQuote(issuer, "2026-06-16"))).toContain(
        "issue_date_in_future",
      )
      expect(JSON.stringify(await issueQuote(issuer, "2026-02-31"))).toContain("issued_at_invalid")
      expect(await series(issuer)).toEqual(before)
    }, 60_000)

    it("a quote on a shop-linked issuer takes its draft order's day: another date is refused first", async () => {
      const issuer = await issuerAt("Europe/Paris")
      await sql`UPDATE app_invoicing.issuer_profiles SET shopify_shop_id = 'shop.example' WHERE id = ${issuer}`
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      const refused = await issueQuote(issuer, "2026-06-10")
      expect(JSON.stringify(refused)).toContain("issue_date_set_by_draft_order")
    }, 60_000)
  })

  describe("documents_update on an issued document's date", () => {
    /** Two invoices 10 and 15 June 2026, as a document with no legal original has them. */
    async function twoInvoices(issuer: string) {
      setSystemTime(new Date("2026-06-10T10:00:00Z"))
      const first = await invoiceOf(issuer)
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      const second = await invoiceOf(issuer)
      setSystemTime(new Date("2026-06-20T10:00:00Z"))
      for (const d of [first, second]) {
        await sql`UPDATE app_invoicing.documents SET legal_original_id = NULL WHERE id = ${d.id}`
      }
      return { first, second }
    }

    it("a date in another year is refused and steers to a credit note", async () => {
      const issuer = await issuerAt("Europe/Paris")
      const { second } = await twoInvoices(issuer)
      const refused = await tool("documents_update", { id: second.id, issued_at: "2027-01-03" })
      expect(JSON.stringify(refused)).toContain("issue_date_crosses_number_year")
      expect(JSON.stringify(refused)).toContain("credit note")
      expect(await storedDate(second.id)).toBe("2026-06-15")
    }, 60_000)

    it("inside the year, the date stays between the neighbouring numbers and on or before today", async () => {
      const issuer = await issuerAt("Europe/Paris")
      const { first, second } = await twoInvoices(issuer)
      expect(
        JSON.stringify(await tool("documents_update", { id: second.id, issued_at: "2026-06-09" })),
      ).toContain("issue_date_breaks_number_order")
      expect(
        JSON.stringify(await tool("documents_update", { id: first.id, issued_at: "2026-06-16" })),
      ).toContain("issue_date_breaks_number_order")
      expect(
        JSON.stringify(await tool("documents_update", { id: second.id, issued_at: "2026-06-21" })),
      ).toContain("issue_date_in_future")
      expect(await storedDate(second.id)).toBe("2026-06-15")

      await tool("documents_update", { id: second.id, issued_at: "2026-06-12" })
      expect(await storedDate(second.id)).toBe("2026-06-12")
    }, 60_000)

    it("the same date again is no change, in the form the row comes back in", async () => {
      const issuer = await issuerAt("Europe/Paris")
      const { second } = await twoInvoices(issuer)
      const got = await tool("documents_get", { id: second.id })
      const sent = got.data?.issued_at
      expect(sent).toBeTruthy()
      const res = await tool("documents_update", { id: second.id, issued_at: sent, notes: "Merci" })
      expect(JSON.stringify(res)).not.toContain("issue_date")
      expect((await doc(second.id)).status).toBe("issued")
      const [row] = await sql<Array<{ notes: string }>>`
        SELECT notes FROM app_invoicing.documents WHERE id = ${second.id}`
      expect(row?.notes).toBe("Merci")
    }, 60_000)
  })

  describe("a credit note's stated date and its number agree", () => {
    const creditNote = (issuer: string, issued_at?: string) =>
      tool("credit_note_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuer,
        currency: "EUR",
        operation_category: "services",
        ...(issued_at ? { issued_at } : {}),
        items: [
          {
            description: "Reversal",
            quantity: "1",
            unit_price_minor: -10000,
            line_kind: "software",
          },
        ],
      })
    const issued = async (res: ToolResult) => {
      const id = documentId(res)
      return { ...(await doc(id)), date: await storedDate(id) }
    }
    const series = async (issuer: string) =>
      sql<Array<{ key: string; value: string }>>`
        SELECT key, value::text FROM kernel.app_sequences
        WHERE org_id = ${ORG} AND key LIKE ${`invoicing:doc_number:${issuer}:%`} ORDER BY key`

    it("a past year's date takes that year's series, and the current series goes on", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2027-02-10T10:00:00Z"))
      const first = await issued(await creditNote(issuer))
      expect(first).toMatchObject({ date: "2027-02-10", year_of_issue: 2027 })

      const past = await issued(await creditNote(issuer, "2026-12-20"))
      expect(past).toMatchObject({ date: "2026-12-20", year_of_issue: 2026 })
      expect(past.number).toContain("2026")
      expect(past.number).not.toContain("2027")
      const text = await extractPdfText(await getFileBytes(null, String(past.pdf_file_id)))
      expect(text).toContain(past.number)
      expect(text).toMatch(
        /(2026-12-20|20\/12\/2026|20 December 2026|December 20, 2026|20 Dec 2026)/,
      )

      const next = await issued(await creditNote(issuer))
      expect(next.year_of_issue).toBe(2027)
      expect(next.number).toContain("2027")
      expect(next.number).not.toBe(first.number)
      expect((await series(issuer)).map((r) => [r.key.split(":").at(-1), r.value])).toEqual([
        ["2026", "1"],
        ["2027", "2"],
      ])
    }, 60_000)

    it("a date before the last number of that year is refused, and no number is taken", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2027-02-10T10:00:00Z"))
      await issued(await creditNote(issuer, "2026-12-20"))
      const before = await series(issuer)

      const refused = await creditNote(issuer, "2026-12-19")
      expect(JSON.stringify(refused)).toContain("issue_date_before_last_number")
      expect(await series(issuer)).toEqual(before)

      // The same day as the last number follows it.
      expect(await issued(await creditNote(issuer, "2026-12-20"))).toMatchObject({
        date: "2026-12-20",
        year_of_issue: 2026,
      })
      // An earlier year has its own series: nothing in it precedes this date.
      expect(await issued(await creditNote(issuer, "2025-06-01"))).toMatchObject({
        date: "2025-06-01",
        year_of_issue: 2025,
      })
    }, 60_000)

    it("23:59 on 31 December in Paris: 2026, and 1 January has not come yet", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-12-31T22:59:00Z"))
      expect(await issued(await creditNote(issuer))).toMatchObject({
        date: "2026-12-31",
        year_of_issue: 2026,
      })
      expect(await issued(await creditNote(issuer, "2026-12-31"))).toMatchObject({
        date: "2026-12-31",
        year_of_issue: 2026,
      })
      const before = await series(issuer)
      expect(JSON.stringify(await creditNote(issuer, "2027-01-01"))).toContain(
        "issue_date_in_future",
      )
      expect(await series(issuer)).toEqual(before)
    }, 60_000)

    it("00:20 on 1 January in Paris: 31 December stays 2026, today and 1 January are 2027", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      const lastYear = await issued(await creditNote(issuer, "2026-12-31"))
      expect(lastYear).toMatchObject({ date: "2026-12-31", year_of_issue: 2026 })
      expect(lastYear.number).toContain("2026")
      const today = await issued(await creditNote(issuer))
      expect(today).toMatchObject({ date: "2027-01-01", year_of_issue: 2027 })
      expect(today.number).toContain("2027")
      const stated = await issued(await creditNote(issuer, "2027-01-01"))
      expect(stated).toMatchObject({ date: "2027-01-01", year_of_issue: 2027 })
      expect(stated.number).toContain("2027")
      expect(JSON.stringify(await creditNote(issuer, "2026-12-30"))).toContain(
        "issue_date_before_last_number",
      )
    }, 60_000)

    it("the same instant on UTC is still 31 December", async () => {
      const issuer = await issuerAt("Etc/UTC")
      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      expect(await issued(await creditNote(issuer))).toMatchObject({
        date: "2026-12-31",
        year_of_issue: 2026,
      })
      expect(JSON.stringify(await creditNote(issuer, "2027-01-01"))).toContain(
        "issue_date_in_future",
      )
    }, 60_000)

    it("a stated date that is no real date is refused, and no number is taken", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2027-02-10T10:00:00Z"))
      for (const bad of ["2026-02-30", "31/12/2026", "soon"]) {
        expect(JSON.stringify(await creditNote(issuer, bad))).toContain("issued_at_invalid")
      }
      expect((await series(issuer)).length).toBe(0)
    }, 60_000)
  })

  describe("a paid date nobody stated reads the issuer's date", () => {
    const paidAt = async (id: string) => {
      const [row] = await sql<Array<{ d: string | null; payment_status: string }>>`
        SELECT to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, payment_status
        FROM app_invoicing.documents WHERE id = ${id}`
      return row
    }

    it("00:20 on 1 January in Paris reads 1 January; UTC reads 31 December", async () => {
      const paris = await issuerAt("Europe/Paris")
      const utc = await issuerAt("Etc/UTC")
      setSystemTime(new Date("2026-12-20T10:00:00Z"))
      const inParis = await invoiceOf(paris)
      const inUtc = await invoiceOf(utc)

      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      expect((await tool("documents_mark_paid", { document_id: inParis.id })).data?.status).toBe(
        "completed",
      )
      expect(await paidAt(inParis.id)).toEqual({ d: "2027-01-01", payment_status: "paid" })
      expect((await tool("documents_mark_paid", { document_id: inUtc.id })).data?.status).toBe(
        "completed",
      )
      expect(await paidAt(inUtc.id)).toEqual({ d: "2026-12-31", payment_status: "paid" })
    }, 60_000)

    it("a stated date stays as stated, whatever the zone", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-12-20T10:00:00Z"))
      const invoice = await invoiceOf(issuer)
      await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Atlantis' WHERE id = ${issuer}`
      await tool("documents_mark_paid", { document_id: invoice.id, paid_date: "2026-12-22" })
      expect(await paidAt(invoice.id)).toEqual({ d: "2026-12-22", payment_status: "paid" })
    }, 60_000)

    it("an unknown zone with no stated date refuses, and the document stays unpaid", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-12-20T10:00:00Z"))
      const invoice = await invoiceOf(issuer)
      await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Atlantis' WHERE id = ${issuer}`
      const res = await tool("documents_mark_paid", { document_id: invoice.id })
      expect(JSON.stringify(res)).toContain("issuer_timezone_invalid")
      expect(await paidAt(invoice.id)).toEqual({ d: null, payment_status: "unpaid" })
    }, 60_000)
  })

  it("the issuer list states each issuer's today, for the editor's default date", async () => {
    const paris = await issuerAt("Europe/Paris")
    const utc = await issuerAt("Etc/UTC")
    const unset = await issuerAt(null)
    const broken = await issuerAt("Europe/Atlantis")
    await setOrgZone("Europe/Paris")
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    const res = await tool("settings_issuer_profile_list", {})
    const items = (res.data?.items ?? []) as Array<{ id: string; today?: string | null }>
    const today = (id: string) => items.find((i) => i.id === id)?.today
    expect(today(paris)).toBe("2027-01-01")
    expect(today(utc)).toBe("2026-12-31")
    expect(today(unset)).toBe("2027-01-01")
    expect(today(broken)).toBeNull()
  }, 60_000)

  describe("a refused date is a typed 4xx with its plain message, through the sandbox", () => {
    /** The class and words the caller gets: what the route answers and the agent reads. */
    const refusal = async (toolName: string, params: Record<string, unknown>) => {
      try {
        const res = await executeTool<Record<string, unknown>>({
          toolName: `invoicing:${toolName}`,
          orgId: ORG,
          actor,
          params,
          threadId: THREAD,
          origin: "human-ui",
        })
        throw new Error(`not refused: ${JSON.stringify(res.data)}`)
      } catch (err) {
        const e = err as Error & { status?: number; code?: string }
        return { status: e.status, code: e.code, message: e.message }
      }
    }
    const creditNote = (issuer: string, issued_at: string) => ({
      counterparty: buyer,
      issuer_profile_id: issuer,
      currency: "EUR",
      issued_at,
      items: [{ ...items[0], unit_price_minor: -1000 }],
    })

    it("on a new credit note and quote", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      expect(
        await refusal("credit_note_create_and_issue", creditNote(issuer, "2026-02-31")),
      ).toMatchObject({
        status: 400,
        code: "issued_at_invalid",
        message: expect.stringContaining("is not a date, so nothing was issued"),
      })
      expect(
        await refusal("credit_note_create_and_issue", creditNote(issuer, "2026-06-16")),
      ).toMatchObject({
        status: 422,
        code: "issue_date_in_future",
        message: expect.stringContaining("is after today"),
      })
      await tool("credit_note_create_and_issue", creditNote(issuer, "2026-06-10"))
      expect(
        await refusal("credit_note_create_and_issue", creditNote(issuer, "2026-06-09")),
      ).toMatchObject({
        status: 409,
        code: "issue_date_before_last_number",
      })
      await sql`UPDATE app_invoicing.issuer_profiles SET shopify_shop_id = 'shop.example' WHERE id = ${issuer}`
      expect(
        await refusal("quote_create_and_issue", {
          counterparty: buyer,
          issuer_profile_id: issuer,
          currency: "EUR",
          issued_at: "2026-06-01",
          items,
        }),
      ).toMatchObject({ status: 409, code: "issue_date_set_by_draft_order" })
    }, 60_000)

    it("on an issued invoice's date", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      const first = await invoiceOf(issuer)
      const later = await invoiceOf(issuer)
      // These rules sit behind the legal original's own lock, which an invoice with no stored file
      // does not have.
      for (const d of [first, later]) {
        await sql`UPDATE app_invoicing.documents SET legal_original_id = NULL WHERE id = ${d.id}`
      }
      expect(
        await refusal("documents_update", { id: later.id, issued_at: "2025-06-15" }),
      ).toMatchObject({
        status: 409,
        code: "issue_date_crosses_number_year",
        message: expect.stringContaining("credit note"),
      })
      expect(
        await refusal("documents_update", { id: later.id, issued_at: "2026-06-01" }),
      ).toMatchObject({
        status: 409,
        code: "issue_date_breaks_number_order",
      })
    }, 60_000)
  })

  describe("the card a person approves a credit note on", () => {
    // An agent's call an org policy parks is gated by the host, ahead of the handler's own card.
    const stage = async (params: Record<string, unknown>) => {
      await withSystemDb("test-credit-note-card-policy", (db) =>
        db
          .insert(approvalPolicies)
          .values({
            orgId: ORG,
            toolName: "invoicing:credit_note_create_and_issue",
            enabled: true,
            conditions: [],
            requireApproval: true,
            minApprovers: 1,
            createdBy: actor.userId,
          })
          .onConflictDoNothing(),
      )
      const res = await executeTool<Record<string, unknown>>({
        toolName: "invoicing:credit_note_create_and_issue",
        orgId: ORG,
        actor,
        params,
        threadId: THREAD,
        origin: "in-app-agent",
      })
      const summary = res.blocked?.summary
      if (!summary) throw new Error(`not parked: ${JSON.stringify(res)}`)
      return summary
    }

    it("states the amount, the lines, the date and the invoice it reverses", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      const invoice = await invoiceOf(issuer)
      const summary = await stage({
        counterparty: buyer,
        issuer_profile_id: issuer,
        original_document_id: invoice.id,
        currency: "EUR",
        issued_at: "2026-06-15",
        reason: "Goods returned",
        items: [{ ...items[0], unit_price_minor: -10000 }],
      })
      const card = [summary.title, ...summary.lines].join("\n")
      // A German consumer pays German VAT: the card says what the document will carry, tax included.
      expect(summary.title).toContain(`on ${invoice.number}`)
      expect(card).toContain("-119.00 EUR")
      expect(card).toContain("Service")
      expect(card).toContain("Issue date: 2026-06-15")
      expect(card).toContain(`Reverses invoice: ${invoice.number} (${invoice.date})`)
      expect(card).not.toContain("Counterparty,")
    }, 60_000)

    it("says when no date is stated, and the total matches the document approval issues", async () => {
      const issuer = await issuerAt("Europe/Paris")
      setSystemTime(new Date("2026-06-15T10:00:00Z"))
      const invoice = await invoiceOf(issuer)
      const params = {
        counterparty: buyer,
        issuer_profile_id: issuer,
        original_document_id: invoice.id,
        currency: "EUR",
        items: [{ ...items[0], unit_price_minor: -4000 }],
      }
      const summary = await stage(params)
      expect(summary.lines.join("\n")).toContain("Issue date: the day this is approved")
      const issued = await tool("credit_note_create_and_issue", params)
      const [row] = await sql<Array<{ grand_total_minor: string }>>`
        SELECT grand_total_minor FROM app_invoicing.documents WHERE id = ${documentId(issued)}`
      expect(row?.grand_total_minor).toBe("-4760")
      expect(summary.lines.join("\n")).toContain("-47.60 EUR")
    }, 60_000)
  })
})
