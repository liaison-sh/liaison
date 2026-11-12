// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the Pennylane app's contract fixtures (fixtures/pennylane/*.json)
// against a Pennylane SANDBOX company (never a production token). Not part of
// any suite run (it skips unless CONTRACT_RECORD=1): run it by path when
// the app's egress changes, read what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-pennylane.recorder.test.ts)
//
// Needs PENNYLANE_SANDBOX_TOKEN (a sandbox company token). The plan reads the
// sandbox's books, deposits one Factur-X e-invoice (never transmitted: the
// sandbox cannot send to the PA), books one sale, uploads one supplier bill,
// and creates a webhook subscription to a stand-in address that it deletes at
// the end. CONTRACT_RECORD_ONLY=<entry,entry> writes only those entries.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { putObject } from "~/infra/storage/object-storage"
import { replayDrawCommands } from "~/modules/pdf/replay"
import { seedFileRow } from "~/seed/factories/files/file-row"
import {
  installPermissiveFilesSelectPolicy,
  restoreFilesSelectPolicy,
} from "~/tests/helpers/files-select-policy"
import {
  connectCredentials,
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "./replay-bridge"

const APP = "pennylane"
const TOKEN = process.env.PENNYLANE_SANDBOX_TOKEN ?? ""
const API = "https://app.pennylane.com/api/external/v2"
/** The stand-in public address the webhook subscription points at (deleted at the end). */
const CALLBACK_BASE = "https://liaison.example.com"
/** Signs the recorded webhook delivery: the verifier reads it from the app's config. */
const SECRET = "contract-webhook-secret-not-real"
/** The contract isolate's virtual clock starts here (isolate.ts): a fresh delivery is signed now. */
const NOW_S = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000)
const CONFIG = { einvoicingWebhookSecret: SECRET }

const INVOICING = "../../../../../../bundled-apps/invoicing/src"
/** The buyer the Factur-X fixtures name (fictional): the e-invoice's CII carries this SIREN. */
const FX_BUYER = { siren: "356000000", legal_name: "Client Exemple SARL" }
const ISSUE_DATE = "2026-10-15"

interface PlanState extends RecordingState {
  run: string
  number: string
  facturx: { fileId: string; sha: string; cii: string }
  plain: { fileId: string; sha: string }
  bill: { fileId: string; sha: string }
  customerInvoice?: { id: string; number: string }
  supplierInvoiceId?: string
  providerRef?: string
  receivedRef?: string
}

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })

/** A file of the contract org in the object store, as the invoicing app keeps its legal originals. */
async function storeFile(
  bytes: Uint8Array,
  filename: string,
  owner: "invoicing" | "user",
): Promise<{ fileId: string; sha: string }> {
  const fileId = randomUUID()
  const key = `orgs/${CONTRACT_ORG_ID}/provider/contract/${fileId}/${filename}`
  await putObject({ key, body: bytes, contentType: "application/pdf" })
  await seedFileRow({
    id: fileId,
    orgId: CONTRACT_ORG_ID,
    // A legal original the invoicing app hands over, or a file the user attached in a conversation.
    ...(owner === "invoicing"
      ? { app: "invoicing", entityType: "legal_original" }
      : { app: "kernel", entityType: "thread", uploadedBy: CONTRACT_USER_ID }),
    entityId: randomUUID(),
    filename,
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    storageKey: key,
  })
  return { fileId, sha: createHash("sha256").update(bytes).digest("hex") }
}

/** A PDF/A-3 Factur-X invoice (the invoicing app's own builder) and its CII. */
async function facturx(number: string): Promise<{ bytes: Uint8Array; cii: string }> {
  const { buildCii } = (await import(`${INVOICING}/facturx/cii`)) as {
    buildCii: (i: unknown) => string
  }
  const { fxDocument } = (await import(`${INVOICING}/facturx/fixtures`)) as {
    fxDocument: (o: unknown) => unknown
  }
  const { facturxXmpExtension } = (await import(`${INVOICING}/legal-originals/record`)) as {
    facturxXmpExtension: () => unknown
  }
  const cii = buildCii(fxDocument({ number, issue_date: ISSUE_DATE, due_date: ISSUE_DATE }))
  const bytes = await replayDrawCommands(
    [
      {
        op: "setMetadata",
        title: `Invoice ${number}`,
        producer: "Liaison Invoicing",
        creator: "Liaison Invoicing",
      },
      { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawText", page: 0, text: `Facture ${number}`, x: 40, y: 800, size: 12, font: "f1" },
    ] as never,
    {
      pdfa: {
        level: "3b",
        attachments: [
          {
            name: "factur-x.xml",
            mime: "text/xml",
            bytes: new TextEncoder().encode(cii),
            afRelationship: "Data",
            description: "Factur-X invoice",
          },
        ],
        xmpExtensions: [facturxXmpExtension()],
        now: new Date(),
      },
    } as never,
  )
  return { bytes, cii }
}

async function plainPdf(text: string): Promise<Uint8Array> {
  return replayDrawCommands([
    { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
    { op: "addPage", width: 595, height: 842 },
    { op: "drawText", page: 0, text, x: 40, y: 800, size: 12, font: "f1" },
  ] as never)
}

async function sandbox(method: string, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
  })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function signed(body: Rec): { headers: Record<string, string>; body: string } {
  const text = JSON.stringify(body)
  const v1 = createHmac("sha256", SECRET).update(`${NOW_S}.${text}`).digest("hex")
  return {
    headers: { "content-type": "application/json", "x-pennylane-signature": `t=${NOW_S},v1=${v1}` },
    body: text,
  }
}

const first = (answer: unknown, key: string): string | undefined => {
  const items = (answer as Rec | null)?.[key]
  const row = Array.isArray(items) ? (items[0] as Rec | undefined) : undefined
  const id = row?.id ?? row?.provider_ref
  return id === undefined || id === null ? undefined : String(id)
}

const ENVELOPE = {
  id: "evt_contract_1",
  type: "customer_invoice.einvoice_status_changed",
  data: { object: { id: 4242 } },
}

/** The sandbox's request budget is small: each step waits this long first. */
const STEP_PAUSE_MS = 4_000

const STEPS: RecordingStep<PlanState>[] = [
  { entry: "tool:einvoicing_registration_status", input: () => params({}) },
  {
    entry: "tool:supplier_invoices_list",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.supplierInvoiceId = first(a, "items")
    },
  },
  {
    entry: "tool:supplier_invoice_get",
    input: (s) => params({ id: s.supplierInvoiceId ?? "1" }),
  },
  {
    entry: "tool:customer_invoices_list",
    input: () => params({ limit: 5 }),
    after: async (a, s) => {
      const id = first(a, "items")
      if (!id) return
      const inv = (await sandbox("GET", `/customer_invoices/${id}`)) as {
        invoice_number?: string
      } | null
      if (inv?.invoice_number) s.customerInvoice = { id, number: inv.invoice_number }
    },
  },
  { entry: "tool:trial_balance_get", input: () => params({ period: "2026" }) },
  { entry: "tool:pnl_summary", input: () => params({ period: "2026-Q3" }) },
  { entry: "tool:spend_by_category", input: () => params({ period: "2026" }) },
  { entry: "tool:cash_position", input: () => params({}) },
  { entry: "tool:transactions_list", input: () => params({ limit: 5 }) },
  { entry: "tool:runway_estimate", input: () => params({}) },
  { entry: "job:refresh-snapshots", input: () => params({}) },
  { entry: "tool:home_load", input: () => params({}) },
  { entry: "tool:webhooks_setup", input: () => params({ callback_base_url: CALLBACK_BASE }) },
  { entry: "job:probe-webhook-upstream", input: () => params({}) },
  {
    entry: "webhook-verify:einvoicing",
    input: () => {
      const d = signed(ENVELOPE)
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  {
    entry: "webhook:einvoicing",
    input: () => {
      const d = signed(ENVELOPE)
      return { params: JSON.parse(d.body), extraArgs: [d.headers] }
    },
  },
  { entry: "tool:einvoicing_status_changes", input: () => params({ cursor: null, kind: null }) },
  {
    entry: "tool:einvoicing_find",
    input: (s) => params({ invoice_number: s.number, issue_date: ISSUE_DATE }),
  },
  {
    entry: "tool:einvoicing_submit",
    input: (s) =>
      params({
        document_ref: `doc-${s.run}`,
        invoice_number: s.number,
        issue_date: ISSUE_DATE,
        facturx_file_id: s.facturx.fileId,
        legal_original_sha256: s.facturx.sha,
        cii_xml: s.facturx.cii,
        buyer: {
          contact_ref: null,
          legal_name: FX_BUYER.legal_name,
          siren: FX_BUYER.siren,
          vat_id: null,
          routing_address: FX_BUYER.siren,
          address: {
            line1: "2 avenue du Test",
            postcode: "69002",
            city: "Lyon",
            country_code: "FR",
          },
        },
        idempotency_key: `key-${s.run}`,
      }),
    bridgeOptions: (s) => ({ contractFileGrant: [s.facturx.fileId] }),
    after: (a, s) => {
      const ref = (a as Rec | null)?.provider_ref
      if (typeof ref === "string") s.providerRef = ref
    },
  },
  {
    entry: "tool:einvoicing_status",
    // The sandbox cannot deposit (emission is off there): read an invoice it already holds.
    input: (s) => params({ provider_ref: s.providerRef ?? s.customerInvoice?.id ?? "" }),
  },
  {
    entry: "tool:einvoicing_advance",
    input: (s) =>
      params({
        provider_ref: s.providerRef ?? s.customerInvoice?.id ?? "",
        invoice_number: s.providerRef ? s.number : (s.customerInvoice?.number ?? s.number),
        issue_date: ISSUE_DATE,
        document_ref: `doc-${s.run}`,
        legal_original_sha256: s.facturx.sha,
      }),
  },
  {
    entry: "tool:einvoicing_find_booking",
    input: (s) => params({ idempotency_key: `book-${s.run}` }),
  },
  {
    entry: "tool:einvoicing_book",
    input: async (s) => {
      const { bookingData } = await import(
        "../../../../../../bundled-apps/pennylane/src/einvoicing/fake/fixtures"
      )
      return params({
        document_ref: `sale-${s.run}`,
        pdf_file_id: s.plain.fileId,
        legal_original_sha256: s.plain.sha,
        data: bookingData({ number: `S-${s.run}` }),
        idempotency_key: `book-${s.run}`,
      })
    },
    bridgeOptions: (s) => ({ contractFileGrant: [s.plain.fileId] }),
  },
  {
    entry: "tool:einvoicing_received_list",
    input: () => params({ cursor: null }),
    after: (a, s) => {
      s.receivedRef = first(a, "items") ?? first(a, "invoices")
    },
  },
  {
    entry: "tool:einvoicing_received_get",
    input: (s) => params({ provider_ref: s.receivedRef ?? s.supplierInvoiceId ?? "" }),
  },
  {
    entry: "tool:einvoicing_received_file",
    input: (s) =>
      params({
        provider_ref: s.receivedRef ?? s.supplierInvoiceId ?? "",
        file: "original",
        target: { app: "invoicing", entity_type: "received_file", entity_id: randomUUID() },
      }),
  },
  {
    entry: "tool:einvoicing_received_set_status",
    input: (s) =>
      params({
        provider_ref: s.receivedRef ?? s.supplierInvoiceId ?? "",
        status: "in_dispute",
        reason: null,
        comment: "Quantities differ from the delivery note.",
      }),
  },
  {
    entry: "tool:supplier_invoice_upload",
    input: (s) =>
      params({
        file_id: s.bill.fileId,
        supplier_name: "Restaurants",
        invoice_date: ISSUE_DATE,
        due_date: "2026-11-14",
        invoice_number: `F-${s.run}`,
        amount_minor: "12000",
        tax_minor: "2000",
        currency: "EUR",
      }),
  },
]

const PLAN: RecordingStep<PlanState>[] = STEPS.map((step) => ({
  ...step,
  before: async (s) => {
    await Bun.sleep(STEP_PAUSE_MS)
    await step.before?.(s)
  },
}))

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record pennylane contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>
  let state: PlanState

  beforeAll(async () => {
    if (!TOKEN) throw new Error("PENNYLANE_SANDBOX_TOKEN is not set (a sandbox company token)")
    installed = await installForRecording(APP, CONFIG)
    // The user's own file has no registered parent in this database: an org-scoped stand-in policy
    // lets the user's run read it, as the thread parent does in production.
    await installPermissiveFilesSelectPolicy()
    await connectCredentials(APP, "pennylane", "contract-company", {
      apiToken: TOKEN,
      scope: "company",
    })
    await sql`DELETE FROM app_pennylane.einvoicing_inbox WHERE org_id = ${CONTRACT_ORG_ID}`.catch(
      () => undefined,
    )
    const run = Date.now().toString(36)
    const number = `CT-${run}`
    const fx = await facturx(number)
    state = {
      values: {},
      run,
      number,
      facturx: { ...(await storeFile(fx.bytes, `${number}.pdf`, "invoicing")), cii: fx.cii },
      plain: await storeFile(await plainPdf(`Sale ${run}`), `S-${run}.pdf`, "invoicing"),
      bill: await storeFile(await plainPdf(`Bill ${run}`), `F-${run}.pdf`, "user"),
    }
  }, 300_000)

  afterAll(async () => {
    // The subscription webhooks_setup made points at a stand-in address: remove it.
    const page = (await sandbox("GET", "/webhook_subscriptions?limit=100").catch(() => null)) as {
      items?: Array<{ id: number; callback_url?: string }>
    } | null
    for (const s of page?.items ?? []) {
      if (s.callback_url?.startsWith(CALLBACK_BASE)) {
        await sandbox("DELETE", `/webhook_subscriptions/${s.id}`).catch(() => undefined)
      }
    }
    await restoreFilesSelectPolicy()
    await uninstallAfterRecording(APP)
  })

  it("records every planned entry", async () => {
    const report = await runRecordingPlan({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: PLAN,
      state,
      replacements: [{ from: TOKEN, to: "contract-sandbox-token" }],
      secrets: [TOKEN],
      recordedFrom: "a Pennylane sandbox company, record-pennylane.recorder.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: CONFIG,
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => l.startsWith("FAIL") || l.startsWith("WEAK"))).toEqual([])
  }, 900_000)
})
