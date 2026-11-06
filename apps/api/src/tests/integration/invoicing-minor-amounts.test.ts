// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Money in minor units, proven where the bug lived: executeTool -> preflight -> sandbox -> bridge ->
// approval card -> decideApproval -> the stored document. A price written "-1260.50" showed a card
// of 0.00 and issued a credit note of -1,500.00: the card read the field one way and the issue
// another. A person approves what they see, so the grid below reads the card a person reads and the
// row the approval wrote, and they must state the same total.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
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
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { formatMoneyMinor } from "../../../../../bundled-apps/invoicing/src/money"

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

let ORG = ""
let THREAD = ""
let actor: UserContext
let approver: UserContext
let NET_ISSUER = ""
let GROSS_ISSUER = ""
let ORIGINAL = ""

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
]

// Consumers: plain VAT or export, no e-invoice gate to set up.
const BUYERS = {
  de: {
    legal_name: "Erika Mustermann",
    country: "DE",
    address: "Hauptstrasse 1, 10115 Berlin",
    email: "erika@example.com",
    customer_kind: "individual",
  },
  us: {
    legal_name: "Harbor Light LLC",
    country: "US",
    address: "1 Main St, Portland OR 97201",
    email: "ap@harborlight.example",
    customer_kind: "individual",
  },
}

interface Outcome {
  data?: Record<string, unknown>
  blocked?: { approvalRequestId?: string } | null
  code?: unknown
  message?: string
}

/** The call as an agent makes it, so every gate and every preflight runs. */
async function asAgent(tool: string, params: Record<string, unknown>): Promise<Outcome> {
  try {
    const res = await executeTool<Record<string, unknown>>({
      toolName: `invoicing:${tool}`,
      orgId: ORG,
      actor,
      params,
      threadId: THREAD,
      origin: "in-app-agent",
    })
    return { data: res.data, blocked: res.blocked as Outcome["blocked"] }
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    return { code: e.code, message: String(e.message) }
  }
}

async function asPerson(tool: string, params: Record<string, unknown>): Promise<Outcome> {
  try {
    const res = await executeTool<Record<string, unknown>>({
      toolName: `invoicing:${tool}`,
      orgId: ORG,
      actor: approver,
      params,
      threadId: THREAD,
      origin: "human-ui",
    })
    return { data: res.data, blocked: res.blocked as Outcome["blocked"] }
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    return { code: e.code, message: String(e.message) }
  }
}

async function counts(): Promise<{ documents: number; approvals: number; lines: number }> {
  const [d] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM app_invoicing.documents WHERE org_id = ${ORG}`
  const [a] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
  const [l] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM app_invoicing.document_lines WHERE org_id = ${ORG}`
  return { documents: d?.n ?? 0, approvals: a?.n ?? 0, lines: l?.n ?? 0 }
}

async function cardOf(id: string): Promise<{ title: string; lines: string[] }> {
  const [row] = await sql<Array<{ summary: { title: string; lines: string[] } }>>`
    SELECT summary FROM kernel.approval_requests WHERE id = ${id}`
  if (!row) throw new Error(`no approval ${id}`)
  return row.summary
}

/** The total a card states, on its total line: what the person deciding reads. */
function cardTotal(card: { lines: string[] }): string {
  const line = card.lines.find((l) => /^(Lines total|Total): /.test(l))
  if (!line) throw new Error(`card has no total line: ${JSON.stringify(card)}`)
  const m = /^(?:Lines total|Total): (-?[\d.]+ [A-Z]{3})/.exec(line)
  if (!m) throw new Error(`unreadable total line: ${line}`)
  return String(m[1])
}

async function newestDocument(
  type: string,
): Promise<{ number: string; grand_total_minor: string; currency: string; status: string }> {
  const [row] = await sql<
    Array<{ number: string; grand_total_minor: string; currency: string; status: string }>
  >`
    SELECT number, grand_total_minor::text AS grand_total_minor, currency, status
    FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND type = ${type}
    ORDER BY created_at DESC, number DESC LIMIT 1`
  if (!row) throw new Error(`no ${type} issued`)
  return row
}

/** Park as the agent, read the card, approve as the person, read the row. */
async function cardAgainstIssued(
  tool: string,
  type: string,
  params: Record<string, unknown>,
): Promise<{ card: string; issued: string; number: string }> {
  const parked = await asAgent(tool, params)
  const id = parked.blocked?.approvalRequestId
  if (!id) throw new Error(`${tool} did not park: ${JSON.stringify(parked)}`)
  const card = cardTotal(await cardOf(id))
  const before = (await counts()).documents
  const decided = await decideApproval({
    orgId: ORG,
    requestId: id,
    actor: approver,
    decision: "approve",
  })
  expect(decided.status).toBe("approved")
  const after = await counts()
  if (after.documents === before)
    throw new Error(`${tool} approved but no document: ${JSON.stringify(decided)}`)
  const doc = await newestDocument(type)
  return {
    card,
    issued: formatMoneyMinor(BigInt(doc.grand_total_minor), doc.currency),
    number: doc.number,
  }
}

/** A deterministic source of cases: a failure reproduces by re-running this file. */
function grid(seed: number) {
  let s = seed >>> 0
  return (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s % n
  }
}

const QUANTITIES = ["1", "2", "3", "1.5", "1.125", "0.333", "2.675", "40"]
const PRICES = [1, 7, 99, 101, 1261, 1999, 41940, 12345, 100005]

function linesFor(next: (n: number) => number, opts: { negate: boolean; discounts: boolean }) {
  const count = 1 + next(3)
  return Array.from({ length: count }, (_, i) => {
    const quantity = QUANTITIES[next(QUANTITIES.length)]!
    const unit = PRICES[next(PRICES.length)]!
    const line: Record<string, unknown> = {
      description: `Line ${i + 1}`,
      quantity,
      unit_price_minor: opts.negate ? -unit : unit,
      line_kind: "software",
    }
    if (next(4) === 0) line.tax_rate_bp_override = [0, 550, 2000][next(3)]
    if (next(2) === 0) line.unit_price_minor = String(line.unit_price_minor)
    if (opts.discounts && next(3) === 0 && unit > 10) line.discount_minor = next(2) === 0 ? 3 : "7"
    return line
  })
}

describe("minor-unit money (real Postgres, sandbox, bridge)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    ORG = org.id
    const requester = await minimal.person(ORG, { role: "admin" })
    const decider = await minimal.person(ORG, { role: "admin" })
    THREAD = await minimal.thread(ORG, requester.id)
    actor = {
      actorType: "user",
      userId: requester.id,
      orgId: ORG,
      scopes: SCOPES,
      dimensionGrants: {},
    }
    approver = {
      actorType: "user",
      userId: decider.id,
      orgId: ORG,
      scopes: SCOPES,
      dimensionGrants: {},
    }
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([invoicingDescriptor() as never], ORG)

    const issuer = async (legal: string, gross: boolean) => {
      const res = await asPerson("settings_issuer_profile_create", {
        legal_name: `${legal} ${randomUUID().slice(0, 8)}`,
        country: "FR",
        address: "1 rue de Test, 75011 Paris",
        default_currency: "EUR",
        default_language: "en",
      })
      const id = String(res.data?.id ?? "")
      if (!id) throw new Error(`issuer not created: ${JSON.stringify(res)}`)
      if (gross)
        await sql`UPDATE app_invoicing.issuer_profiles SET prices_include_tax = true WHERE id = ${id}`
      return id
    }
    NET_ISSUER = await issuer("Net", false)
    GROSS_ISSUER = await issuer("Gross", true)

    // A large invoice every credit note of the grid can reverse without reaching over_credit.
    const original = await asPerson("invoice_create_and_issue", {
      issuer_profile_id: NET_ISSUER,
      counterparty: BUYERS.de,
      currency: "EUR",
      operation_category: "services",
      items: [
        {
          description: "Original",
          quantity: "1",
          unit_price_minor: 90_000_000,
          line_kind: "software",
        },
      ],
    })
    ORIGINAL = String(original.data?.document_id ?? "")
    if (!ORIGINAL) throw new Error(`original not issued: ${JSON.stringify(original)}`)
  }, 120_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  const CREATE_TOOLS = [
    "invoice_create_and_issue",
    "quote_create_and_issue",
    "proforma_create_and_issue",
    "po_create_and_issue",
    "credit_note_create_and_issue",
  ]

  function createParams(tool: string, unit: unknown): Record<string, unknown> {
    return {
      issuer_profile_id: NET_ISSUER,
      counterparty: BUYERS.de,
      currency: "EUR",
      ...(tool.startsWith("credit_note")
        ? { original_document_id: ORIGINAL, reason: "Correction" }
        : {}),
      ...(tool.startsWith("invoice") || tool.startsWith("credit_note")
        ? { operation_category: "services" }
        : {}),
      items: [
        { description: "Thing", quantity: "1", unit_price_minor: unit, line_kind: "software" },
      ],
    }
  }

  it("the walk's case: -1260.50 is refused before anything parks, naming what to send", async () => {
    const before = await counts()
    const res = await asAgent(
      "credit_note_create_and_issue",
      createParams("credit_note_create_and_issue", "-1260.50"),
    )
    expect(res.blocked?.approvalRequestId).toBeUndefined()
    expect(res.code).toBe("invalid_amount")
    expect(res.message).toContain('"-1260.50"')
    expect(res.message).toContain("-126050")
    expect(res.message).toContain("-1260 or -1261")
    expect(await counts()).toEqual(before)
  }, 60_000)

  for (const tool of CREATE_TOOLS) {
    const values: Array<[string, unknown]> = [
      ["a decimal string with cents", "-1260.50"],
      ["a whole number written with .00", "899.00"],
      ["a one decimal string", "-5.5"],
      ["a fractional number", -550.5],
      ["a currency sign", "$1"],
      ["a decimal comma", "1,50"],
      ["an exponent", "1e3"],
    ]
    for (const [label, value] of values) {
      it(`${tool} refuses ${label} and leaves nothing behind`, async () => {
        const before = await counts()
        const res = await asAgent(tool, createParams(tool, value))
        expect(res.blocked?.approvalRequestId).toBeUndefined()
        expect(res.data).toBeUndefined()
        expect(["invalid_amount", "invalid_params"]).toContain(res.code as string)
        expect(res.message).toContain(String(value))
        expect(res.message).toMatch(/whole number/)
        expect(await counts()).toEqual(before)
      }, 60_000)
    }
  }

  it("a draft refuses the same value at create and at update, and an edited approval cannot slip one through", async () => {
    const before = await counts()
    const bad = await asPerson("drafts_create", {
      type: "invoice",
      issuer_profile_id: NET_ISSUER,
      counterparty_name: "Erika Mustermann",
      counterparty_country: "DE",
      currency: "EUR",
      items: [{ description: "Thing", quantity: "1", unit_price_minor: "899.00" }],
    })
    expect(bad.code).toBe("invalid_amount")
    expect(bad.message).toContain('"899.00"')
    expect(await counts()).toEqual(before)

    const good = await asPerson("drafts_create", {
      type: "invoice",
      issuer_profile_id: NET_ISSUER,
      counterparty_name: "Erika Mustermann",
      counterparty_country: "DE",
      currency: "EUR",
      items: [{ description: "Thing", quantity: "1", unit_price_minor: 89900 }],
    })
    const draftId = String(good.data?.draft_id ?? good.data?.id ?? "")
    expect(draftId).not.toBe("")
    const update = await asPerson("drafts_update", {
      draft_id: draftId,
      patch: { lines: [{ description: "Thing", quantity: "1", unit_price_minor: "899.00" }] },
    })
    expect(update.code).toBe("invalid_amount")
    expect(update.message).toContain('"899.00"')
    const [row] = await sql<Array<{ grand: string }>>`
      SELECT grand_total_minor::text AS grand FROM app_invoicing.documents WHERE id = ${draftId}`
    const [line] = await sql<Array<{ unit: string }>>`
      SELECT unit_price_minor::text AS unit FROM app_invoicing.document_lines WHERE document_id = ${draftId}`
    expect(line?.unit).toBe("89900")
    expect(row?.grand).toBeDefined()
  }, 60_000)

  it("a stored payload written before this rule is refused at approval, and issues nothing", async () => {
    const parked = await asAgent(
      "credit_note_create_and_issue",
      createParams("credit_note_create_and_issue", -1500),
    )
    const id = parked.blocked?.approvalRequestId
    if (!id) throw new Error(`did not park: ${JSON.stringify(parked)}`)
    const payload = createParams("credit_note_create_and_issue", "-1260.50")
    await sql`UPDATE kernel.approval_requests
      SET current_payload = ${sql.json(payload as never)}, tool_params = ${sql.json(payload as never)}
      WHERE id = ${id}`
    const before = (await counts()).documents
    let refused = ""
    try {
      await decideApproval({ orgId: ORG, requestId: id, actor: approver, decision: "approve" })
    } catch (err) {
      refused = String((err as { message?: unknown }).message)
    }
    expect((await counts()).documents).toBe(before)
    expect(refused).toContain("-1260.50")
  }, 60_000)

  it("a credit note's total is negative: a positive one is refused and says what to send", async () => {
    const before = await counts()
    const res = await asAgent(
      "credit_note_create_and_issue",
      createParams("credit_note_create_and_issue", 500),
    )
    expect(res.blocked?.approvalRequestId).toBeUndefined()
    expect(res.code).toBe("credit_note_not_negative")
    expect(res.message).toContain("5.00 EUR")
    expect(res.message).toContain("-500")
    expect(await counts()).toEqual(before)
  }, 60_000)

  it("a credit note of nothing is refused", async () => {
    const res = await asAgent(
      "credit_note_create_and_issue",
      createParams("credit_note_create_and_issue", 0),
    )
    expect(res.blocked?.approvalRequestId).toBeUndefined()
    expect(res.code).toBe("credit_note_not_negative")
  }, 60_000)

  it("a credit note with a positive line stays allowed while its total is negative", async () => {
    const { card, issued, number } = await cardAgainstIssued(
      "credit_note_create_and_issue",
      "credit_note",
      {
        ...createParams("credit_note_create_and_issue", -1000),
        items: [
          {
            description: "Returned",
            quantity: "1",
            unit_price_minor: -1000,
            line_kind: "software",
          },
          {
            description: "Restocking fee",
            quantity: "1",
            unit_price_minor: 100,
            line_kind: "software",
          },
        ],
      },
    )
    expect(number).toMatch(/^CN-/)
    expect(card).toBe(issued)
    expect(issued.startsWith("-")).toBe(true)
  }, 60_000)

  it("a draft credit note with a positive total is refused at issue, before a number is taken", async () => {
    const draft = await asPerson("drafts_create", {
      type: "credit_note",
      issuer_profile_id: NET_ISSUER,
      counterparty_name: "Erika Mustermann",
      counterparty_country: "DE",
      counterparty_email: "erika@example.com",
      counterparty_address: "Hauptstrasse 1, 10115 Berlin",
      currency: "EUR",
      items: [
        { description: "Thing", quantity: "1", unit_price_minor: 500, line_kind: "software" },
      ],
    })
    const draftId = String(draft.data?.draft_id ?? draft.data?.id ?? "")
    expect(draftId).not.toBe("")
    const res = await asAgent("credit_note_issue", { draft_id: draftId })
    expect(res.blocked?.approvalRequestId).toBeUndefined()
    expect(res.code).toBe("credit_note_not_negative")
    const [row] = await sql<Array<{ status: string; number: string | null }>>`
      SELECT status, number FROM app_invoicing.documents WHERE id = ${draftId}`
    expect(row?.status).toBe("draft")
    expect(row?.number).toBeNull()
  }, 60_000)

  it("across issuers, buyers, types and amounts the card states the total that issues", async () => {
    const next = grid(20261106)
    const failures: string[] = []
    const types: Array<[string, string, boolean]> = [
      ["invoice_create_and_issue", "invoice", false],
      ["quote_create_and_issue", "quote", true],
      ["proforma_create_and_issue", "proforma", true],
      ["po_create_and_issue", "purchase_order", true],
      ["credit_note_create_and_issue", "credit_note", false],
    ]
    for (let i = 0; i < 40; i++) {
      const [tool, type, discounts] = types[i % types.length]!
      const credit = type === "credit_note"
      const buyer = next(3) === 0 ? BUYERS.us : BUYERS.de
      const params = {
        issuer_profile_id: !credit && next(2) === 0 ? GROSS_ISSUER : NET_ISSUER,
        counterparty: credit ? BUYERS.de : buyer,
        currency: "EUR",
        ...(credit ? { original_document_id: ORIGINAL, reason: "Correction" } : {}),
        ...(tool.startsWith("invoice") || credit ? { operation_category: "services" } : {}),
        items: linesFor(next, { negate: credit, discounts }),
      }
      const seen = await cardAgainstIssued(tool, type, params)
      if (seen.card !== seen.issued) {
        failures.push(
          `${i} ${tool} ${seen.number}: card ${seen.card}, issued ${seen.issued}, ${JSON.stringify(params.items)}`,
        )
      }
    }
    expect(failures).toEqual([])
  }, 300_000)

  it("a draft issued by an agent: the card states the total that issues", async () => {
    const draft = await asPerson("drafts_create", {
      type: "invoice",
      issuer_profile_id: NET_ISSUER,
      counterparty_name: "Erika Mustermann",
      counterparty_country: "DE",
      counterparty_email: "erika@example.com",
      counterparty_address: "Hauptstrasse 1, 10115 Berlin",
      currency: "EUR",
      operation_category: "services",
      items: [
        { description: "A", quantity: "1.125", unit_price_minor: 1261, line_kind: "software" },
        {
          description: "B",
          quantity: "3",
          unit_price_minor: "1999",
          discount_minor: 7,
          line_kind: "software",
        },
      ],
    })
    const draftId = String(draft.data?.draft_id ?? draft.data?.id ?? "")
    expect(draftId).not.toBe("")
    const seen = await cardAgainstIssued("invoice_issue", "invoice", { draft_id: draftId })
    expect(seen.card).toBe(seen.issued)
  }, 60_000)
})
