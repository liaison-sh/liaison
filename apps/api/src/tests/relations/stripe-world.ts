// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money world: an organization with the payments connector and invoicing registered, a
// company with a person, a second company and person to merge into, the invoicing rows of
// recurring-world.ts, and the payments mirror the connector's sync writes: a customer linked to
// the company and the person, an invoice issued as the Liaison document, a payment and its refund.
// Readers: `admin`; `clerk`, a member holding only the read scopes of the money tables; and
// `outsider`, an admin of another organization, the control. Each link is read as the workspace
// reads it, under the reader's row security; the link a cell reads is the column it names.

import { expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { files } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { executeTool } from "~/modules/apps/execute-tool"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { registerApps } from "~/modules/apps/runtime"
import {
  createCompany,
  deleteCompany,
  linkContactsToCompany,
  mergeCompanies,
  updateCompany,
} from "~/modules/contacts/companies"
import { mergeContactsWithMailReferences, updateContact } from "~/modules/contacts/service"
import * as minimal from "~/seed/tiers/minimal"
import { type ApprovalOrg, approvalOrg, ctxOf } from "./approval-world"
import type { CellImpl, CellWorld } from "./cells"
import type { Reading } from "./classes"
import {
  columnValue,
  countRows,
  type InvoicingRows,
  insertRow,
  inv,
  rowAs,
  sightOfRow,
  writeInvoicing,
} from "./recurring-world"

const READERS = ["admin", "clerk", "outsider"] as const
type Reader = (typeof READERS)[number]
const SEE = ["admin", "clerk"]

/** `<app schema as the run names it>.<table>`. */
const pay = (table: string) => `${schemaRef("app_stripe")}.${table}`

const CLERK_SCOPES = [
  "kernel:contacts:read",
  "kernel:companies:read",
  "stripe:customers:read",
  "stripe:invoices:read",
  "stripe:payments:read",
  "invoicing:documents:read",
]

/** Which link of the money world a case reads. */
export type MoneyLink =
  | "invoiceParty"
  | "scheduleParty"
  | "runItem"
  | "stripeCustomer"
  | "stripeInvoice"
  | "stripeRefund"

interface LinkRead {
  table: () => string
  key: (w: MoneyCase) => { column: string; value: string }
  column: string
  label?: string
  /** The scope whose loss hides the row. */
  scope: string
}

const LINK_READS: Record<MoneyLink, LinkRead> = {
  invoiceParty: {
    table: () => inv("documents"),
    key: (w) => ({ column: "id", value: w.inv.documentId }),
    column: "counterparty_contact_id",
    label: "counterparty_name",
    scope: "invoicing:documents:read",
  },
  scheduleParty: {
    table: () => inv("recurring_schedules"),
    key: (w) => ({ column: "id", value: w.inv.scheduleId }),
    column: "company_id",
    scope: "invoicing:documents:read",
  },
  runItem: {
    table: () => inv("recurring_run_items"),
    key: (w) => ({ column: "id", value: w.inv.runItemId }),
    column: "schedule_id",
    scope: "invoicing:documents:read",
  },
  stripeCustomer: {
    table: () => pay("stripe_customers"),
    key: (w) => ({ column: "stripe_id", value: w.customerId }),
    column: "company_id",
    scope: "stripe:customers:read",
  },
  stripeInvoice: {
    table: () => pay("stripe_invoices"),
    key: (w) => ({ column: "stripe_id", value: w.stripeInvoiceId }),
    column: "liaison_document_id",
    scope: "stripe:invoices:read",
  },
  stripeRefund: {
    table: () => pay("stripe_refunds"),
    key: (w) => ({ column: "stripe_id", value: w.refundId }),
    column: "payment_id",
    scope: "stripe:payments:read",
  },
}

function descriptor(name: string): Record<string, unknown> {
  const m = JSON.parse(
    readFileSync(
      path.join(import.meta.dir, "../../../../../bundled-apps", name, "app.manifest.json"),
      "utf8",
    ),
  ) as Record<string, unknown>
  return {
    name: m.name,
    version: m.version,
    _format: "manifest",
    _bundlePath: `/apps/${name}/handlers.js`,
    scopes: m.scopes,
    roles: m.roles,
    schema: m.schema,
    events: m.events,
  }
}

let money: Promise<ApprovalOrg> | null = null
let other: Promise<{ orgId: string; adminUserId: string }> | null = null

/** One organization for every money cell, with both apps registered and active. */
export function moneyOrg(): Promise<ApprovalOrg> {
  money ??= (async () => {
    const { orgId } = await minimal.secondOrg({ name: "Money Org" })
    const org = await approvalOrg(orgId)
    await registerApps([descriptor("stripe"), descriptor("invoicing")] as never, orgId)
    for (const name of ["stripe", "invoicing"]) {
      await sql.unsafe(
        `INSERT INTO ${schemaRef("kernel")}.apps (org_id, name, version) VALUES ($1, $2, '1.0.0') ON CONFLICT DO NOTHING`,
        [orgId, name],
      )
    }
    return { ...org, admin: await ctxOf(orgId, org.adminId) }
  })()
  return money
}

export class MoneyCase implements CellWorld {
  people = {} as Record<Reader, string>
  tag = ""
  companyId = ""
  companyName = ""
  otherCompanyId = ""
  contactId = ""
  contactName = ""
  otherContactId = ""
  inv = {} as InvoicingRows
  customerId = ""
  stripeInvoiceId = ""
  paymentId = ""
  refundId = ""
  exported: string[] = []
  refusal: string | null = null

  constructor(
    readonly org: ApprovalOrg,
    readonly link: MoneyLink,
  ) {}

  get orgId(): string {
    return this.org.orgId
  }

  get reads(): LinkRead {
    return LINK_READS[this.link]
  }

  async build(): Promise<this> {
    const tag = randomUUID().slice(0, 6)
    this.tag = tag
    this.people.admin = this.org.adminId
    const clerk = await minimal.person(this.orgId, { name: `M${tag}clerk Money` })
    this.people.clerk = clerk.id
    // The clerk holds the money reads as direct grants only, so a lost grant is a lost read.
    await minimal.revokeRole(clerk.id, "member")
    for (const s of CLERK_SCOPES) await minimal.grantScope(clerk.id, s)
    other ??= minimal.secondOrg({ name: "Other Money Org" })
    this.people.outsider = (await other).adminUserId

    this.contactName = `Buyer ${tag}`
    this.contactId = await minimal.contact(this.orgId, `buyer-${tag}@maison-${tag}.example`, {
      name: this.contactName,
    })
    this.otherContactId = await minimal.contact(this.orgId, `again-${tag}@maison-${tag}.example`, {
      name: `${this.contactName} again`,
    })
    const by = { orgId: this.orgId, userId: this.org.adminId }
    this.companyName = `Maison ${tag}`
    await withRlsContext(this.org.admin, async (tx) => {
      this.companyId = (
        await createCompany(tx, { ...by, input: { name: this.companyName } })
      ).company.id
      this.otherCompanyId = (
        await createCompany(tx, { ...by, input: { name: `Maison ${tag} Group` } })
      ).company.id
      await linkContactsToCompany(tx, {
        ...by,
        companyId: this.companyId,
        contactIds: [this.contactId],
      })
    })

    this.inv = await writeInvoicing({
      orgId: this.orgId,
      adminId: this.org.adminId,
      tag,
      companyId: this.companyId,
      contactId: this.contactId,
      contactName: this.contactName,
      // A schedule naming the company holds it (its delete is refused), so only its own cells have one.
      scheduleBillsCompany: this.link !== "stripeCustomer",
    })

    // The payments mirror, as the connector's sync writes it.
    const now = new Date().toISOString()
    this.customerId = `cus_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("stripe_customers"), {
      org_id: this.orgId,
      stripe_id: this.customerId,
      email: `buyer-${tag}@maison-${tag}.example`,
      name: this.companyName,
      company_id: this.companyId,
      contact_id: this.contactId,
      match_method: "email",
      stripe_updated: now,
      created_at_stripe: now,
    })
    this.stripeInvoiceId = `in_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("stripe_invoices"), {
      org_id: this.orgId,
      stripe_id: this.stripeInvoiceId,
      customer_id: this.customerId,
      status: "paid",
      total_minor: 120000,
      tax_minor: 20000,
      amount_paid_minor: 120000,
      amount_due_minor: 0,
      currency: "eur",
      issuer: "liaison",
      liaison_document_id: this.inv.documentId,
      stripe_updated: now,
    })
    this.paymentId = `ch_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("stripe_payments"), {
      org_id: this.orgId,
      stripe_id: this.paymentId,
      invoice_id: this.stripeInvoiceId,
      customer_id: this.customerId,
      amount_minor: 120000,
      currency: "eur",
      status: "succeeded",
      created_at_stripe: now,
    })
    this.refundId = `re_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("stripe_refunds"), {
      org_id: this.orgId,
      stripe_id: this.refundId,
      payment_id: this.paymentId,
      amount_minor: 20000,
      currency: "eur",
      status: "succeeded",
      created_at_stripe: now,
    })
    return this
  }

  async read(): Promise<Reading> {
    const out: Reading = {}
    const r = this.reads
    for (const who of READERS) {
      const orgId = who === "outsider" ? ((await other)?.orgId ?? this.orgId) : this.orgId
      const ctx = await ctxOf(orgId, this.people[who])
      const cols = [r.column, ...(r.label ? [r.label] : [])]
      out[who] = sightOfRow(await rowAs(ctx, r.table(), r.key(this), cols), r.column, r.label)
    }
    return out
  }

  /** The link's column on its row, read past row security; undefined when the row is gone. */
  linkValue(): Promise<string | null | undefined> {
    const r = this.reads
    return columnValue(r.table(), r.key(this), r.column)
  }

  async rows(): Promise<number> {
    const r = this.reads
    const k = r.key(this)
    return countRows(r.table(), k.column, k.value)
  }

  // ── events ────────────────────────────────────────────────────────────────

  async renameCompany(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      updateCompany(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        companyId: this.companyId,
        patch: { name: `${this.companyName} renamed` },
      }),
    )
  }

  async companyName_(): Promise<string | null> {
    const [row] = (await sql`
      SELECT name FROM ${sql(schemaRef("kernel"))}.companies WHERE id = ${this.companyId}`) as Array<{
      name: string
    }>
    return row?.name ?? null
  }

  async mergeCompany(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      mergeCompanies(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        sourceId: this.companyId,
        targetId: this.otherCompanyId,
      }),
    )
  }

  async renameContact(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      updateContact(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        contactId: this.contactId,
        updates: { name: `${this.contactName} renamed` },
      }),
    )
  }

  async contactName_(): Promise<string | null> {
    const [row] = (await sql`
      SELECT name FROM ${sql(schemaRef("kernel"))}.contacts WHERE id = ${this.contactId}`) as Array<{
      name: string
    }>
    return row?.name ?? null
  }

  async mergeContact(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      mergeContactsWithMailReferences(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        sourceId: this.contactId,
        targetId: this.otherContactId,
      }),
    )
  }

  /** Delete the company through the product; a refusal is kept as its sentence. */
  async deleteCompany(): Promise<void> {
    try {
      await withRlsContext(this.org.admin, (tx) =>
        deleteCompany(tx, {
          orgId: this.orgId,
          userId: this.org.adminId,
          companyId: this.companyId,
        }),
      )
    } catch (err) {
      this.refusal = err instanceof Error ? err.message : String(err)
    }
  }

  async companyExists(): Promise<boolean> {
    return (await this.companyName_()) !== null
  }

  async contactExists(id = this.contactId): Promise<boolean> {
    const [row] = (await sql`
      SELECT 1 AS one FROM ${sql(schemaRef("kernel"))}.contacts WHERE id = ${id}`) as unknown[]
    return Boolean(row)
  }

  async loseRead(): Promise<void> {
    await minimal.revokeScope(this.people.clerk, this.reads.scope)
  }

  async regainRead(): Promise<void> {
    await minimal.grantScope(this.people.clerk, this.reads.scope)
  }

  async clerkHolds(): Promise<boolean> {
    return (await ctxOf(this.orgId, this.people.clerk)).scopes.includes(this.reads.scope)
  }

  async clerkVersion(): Promise<number> {
    const [row] = (await sql`
      SELECT permission_version FROM ${sql(schemaRef("kernel"))}.users WHERE id = ${this.people.clerk}`) as Array<{
      permission_version: number
    }>
    return row?.permission_version ?? 0
  }

  /** The payments connector switched off and back on. */
  async paymentsOffAndOn(): Promise<void> {
    await setOrgAppStatus(this.orgId, "stripe", "disabled")
    await setOrgAppStatus(this.orgId, "stripe", "active")
  }

  async appStatus(app: string): Promise<string | null> {
    const [row] = (await sql`
      SELECT status FROM ${sql(schemaRef("kernel"))}.apps WHERE org_id = ${this.orgId} AND name = ${app}`) as Array<{
      status: string
    }>
    return row?.status ?? null
  }

  exportFileId: string | null = null

  /** The person's data subject export, as the admin runs it. */
  async exportContact(): Promise<Record<string, unknown>> {
    const res = await executeTool<{ fileId: string }>({
      toolName: "kernel:data_subject_export",
      orgId: this.orgId,
      actor: this.org.admin,
      params: { contactId: this.contactId },
      origin: "human-ui",
    })
    const fileId = res.data?.fileId
    if (!fileId) throw new Error(`export wrote no file: ${JSON.stringify(res)}`)
    this.exportFileId = fileId
    const [row] = await withSystemDb("relations-read-export", (db) =>
      db.select({ key: files.storageKey }).from(files).where(eq(files.id, fileId)).limit(1),
    )
    if (!row) throw new Error(`no file row ${fileId}`)
    return JSON.parse((await getObjectBuffer(row.key)).toString("utf-8")) as Record<string, unknown>
  }
}

/** Every string under `key` anywhere in a bundle. */
function valuesAt(bundle: unknown, key: string): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === key && typeof x === "string") out.push(x)
        else walk(x)
      }
    }
  }
  walk(bundle)
  return out
}

function cell(c: CellImpl<MoneyCase>): CellImpl {
  return c as CellImpl
}

const money_ = (link: MoneyLink) => async () => new MoneyCase(await moneyOrg(), link).build()

const permissionLost = (name: string, link: MoneyLink): CellImpl =>
  cell({
    link: name,
    event: "Pm",
    says: "a reader lost the read scope",
    build: money_(link),
    mustSee: SEE,
    whoIsTold: ["admin"],
    act: (w) => w.loseRead(),
    took: async (w) => expect(await w.clerkHolds()).toBe(false),
    facts: () => ({ lostAccess: "clerk", neverHad: "outsider" }),
  })

const paymentsBack = (name: string, link: MoneyLink): CellImpl =>
  cell({
    link: name,
    event: "Rv",
    says: "the payments connector switched off and on again",
    build: money_(link),
    mustSee: SEE,
    mark: async (w) => ({ version: await w.clerkVersion(), rows: await w.rows() }),
    act: (w) => w.paymentsOffAndOn(),
    took: async (w, mark) => {
      expect(await w.appStatus("stripe")).toBe("active")
      expect(await w.clerkVersion()).toBeGreaterThanOrEqual(
        (mark as { version: number }).version + 2,
      )
    },
    facts: async (w) => ({ rowsAfter: await w.rows(), rowsBefore: 1 }),
  })

const permissionBack = (name: string, link: MoneyLink): CellImpl =>
  cell({
    link: name,
    event: "Rv",
    says: "a reader lost the read scope and got it back",
    build: money_(link),
    mustSee: SEE,
    mark: async (w) => ({ version: await w.clerkVersion() }),
    act: async (w) => {
      await w.loseRead()
      await w.regainRead()
    },
    took: async (w, mark) => {
      expect(await w.clerkHolds()).toBe(true)
      expect(await w.clerkVersion()).toBeGreaterThanOrEqual(
        (mark as { version: number }).version + 2,
      )
    },
    facts: async (w) => ({ rowsAfter: await w.rows(), rowsBefore: 1 }),
  })

export function moneyCells(): CellImpl[] {
  return [
    // ── invoice-party ─────────────────────────────────────────────────────────
    cell({
      link: "invoice-party",
      event: "Mg",
      says: "its person merged into another",
      build: money_("invoiceParty"),
      mustSee: SEE,
      act: (w) => w.mergeContact(),
      took: async (w) => expect(await w.contactExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherContactId, goneId: w.contactId }),
    }),
    cell({
      link: "invoice-party",
      event: "Rn",
      says: "its person renamed after the invoice was issued",
      build: money_("invoiceParty"),
      mustSee: SEE,
      act: (w) => w.renameContact(),
      took: async (w) => expect(await w.contactName_()).toBe(`${w.contactName} renamed`),
      facts: (w) => ({ newName: `${w.contactName} renamed`, oldName: w.contactName }),
    }),
    permissionLost("invoice-party", "invoiceParty"),
    permissionBack("invoice-party", "invoiceParty"),
    cell({
      link: "invoice-party",
      event: "Ex",
      says: "the person's data subject export",
      build: money_("invoiceParty"),
      mustSee: SEE,
      act: async (w) => {
        w.exported = valuesAt(await w.exportContact(), "id")
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: (w) => ({ exported: w.exported, linkRowId: w.inv.documentId }),
    }),

    // ── schedule-party ────────────────────────────────────────────────────────
    cell({
      link: "schedule-party",
      event: "Rn",
      says: "its company renamed",
      build: money_("scheduleParty"),
      mustSee: SEE,
      act: (w) => w.renameCompany(),
      took: async (w) => expect(await w.companyName_()).toBe(`${w.companyName} renamed`),
      facts: (w) => ({ newName: `${w.companyName} renamed`, oldName: w.companyName }),
    }),
    cell({
      link: "schedule-party",
      event: "Mg",
      says: "its company merged into another",
      build: money_("scheduleParty"),
      mustSee: SEE,
      act: (w) => w.mergeCompany(),
      took: async (w) => expect(await w.companyExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherCompanyId, goneId: w.companyId }),
    }),
    cell({
      link: "schedule-party",
      event: "Dl",
      says: "its company deleted while the schedule bills it",
      build: money_("scheduleParty"),
      mustSee: SEE,
      act: (w) => w.deleteCompany(),
      took: async (w) => {
        expect(w.refusal).not.toBeNull()
        expect(await w.companyExists()).toBe(true)
      },
      facts: (w) => ({ refusal: w.refusal }),
    }),
    permissionLost("schedule-party", "scheduleParty"),
    permissionBack("schedule-party", "scheduleParty"),

    // ── run-item-schedule-draft ───────────────────────────────────────────────
    permissionLost("run-item-schedule-draft", "runItem"),
    permissionBack("run-item-schedule-draft", "runItem"),

    // ── stripe-customer-party ─────────────────────────────────────────────────
    cell({
      link: "stripe-customer-party",
      event: "Rn",
      says: "its company renamed",
      build: money_("stripeCustomer"),
      mustSee: SEE,
      act: (w) => w.renameCompany(),
      took: async (w) => expect(await w.companyName_()).toBe(`${w.companyName} renamed`),
      facts: (w) => ({ newName: `${w.companyName} renamed`, oldName: w.companyName }),
    }),
    cell({
      link: "stripe-customer-party",
      event: "Mg",
      says: "its company merged into another",
      build: money_("stripeCustomer"),
      mustSee: SEE,
      act: (w) => w.mergeCompany(),
      took: async (w) => expect(await w.companyExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherCompanyId, goneId: w.companyId }),
    }),
    cell({
      link: "stripe-customer-party",
      event: "Dl",
      says: "its company deleted",
      build: money_("stripeCustomer"),
      mustSee: SEE,
      act: (w) => w.deleteCompany(),
      took: async (w) => {
        if (w.refusal) throw new Error(`company delete refused: ${w.refusal}`)
        expect(await w.companyExists()).toBe(false)
      },
      facts: (w) => ({ goneId: w.companyId }),
    }),
    permissionLost("stripe-customer-party", "stripeCustomer"),
    paymentsBack("stripe-customer-party", "stripeCustomer"),

    // ── stripe-invoice-document ───────────────────────────────────────────────
    permissionLost("stripe-invoice-document", "stripeInvoice"),
    paymentsBack("stripe-invoice-document", "stripeInvoice"),

    // ── stripe-refund-charge ──────────────────────────────────────────────────
    permissionLost("stripe-refund-charge", "stripeRefund"),
    paymentsBack("stripe-refund-charge", "stripeRefund"),
  ]
}
