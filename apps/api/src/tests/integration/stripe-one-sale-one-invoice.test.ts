// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One sale on Stripe, one legal invoice, proven on two real Postgres transactions. Each side runs
// the app's own handler on the sandbox bridge inside a transaction this test holds open, so both
// have passed every check before either commits: the first to commit wins, the second rolls its
// batch back, takes no number, and says who has the sale. Whatever the two sides are: the same
// event twice, the Stripe invoice and a click on its charge (two different document keys), an issue
// and a payment linked by hand, in both orders.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { type SystemContext, withRlsContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { issuePipelineCtx } from "../../../../../bundled-apps/invoicing/src/__tests__/credit-note-fixtures"
import { reconcileStripePayments } from "../../../../../bundled-apps/invoicing/src/handlers/reconcile-stripe-payments"
import { onStripeInvoiceFinalized } from "../../../../../bundled-apps/invoicing/src/handlers/stripe-invoice-finalized"
import { finalized } from "../../../../../bundled-apps/invoicing/src/handlers/stripe-money.testkit"
import {
  invoiceFromStripePayment,
  onStripePaymentUnmatched,
  paymentLinkToInvoice,
} from "../../../../../bundled-apps/invoicing/src/handlers/stripe-payment-unmatched"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
) as Record<string, unknown>

type Row = Record<string, unknown>
type Ctx = Parameters<typeof onStripeInvoiceFinalized>[1]
let ORG = ""
let ISSUER = ""

const PAID = { charge_id: "ch_1", status: "paid", paid_at: "2026-11-15T10:00:00Z" }
const CHARGE = {
  charge_id: "ch_1",
  invoice_id: null,
  customer_id: "cus_1",
  contact_id: null,
  amount_minor: "12000",
  currency: "eur",
  created: "2026-11-15T10:00:00Z",
  description: null,
  customer: finalized().customer,
}

const actor = (): SystemContext => ({
  actorType: "system",
  orgId: ORG,
  purpose: "job",
  scopes: ["invoicing:*"],
})

/** The app's ctx on `tx`: the real bridge under the database, the rest of the issue pipeline stubbed. */
function ctxOn(tx: unknown): Ctx {
  const bridge = createRpcBridge(
    "invoicing",
    "system",
    ORG,
    tx as never,
    MANIFEST as never,
    ["invoicing:*"],
    "system",
    undefined,
    { actor: actor() },
  ) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const call = async (name: string, ...args: unknown[]) => {
    const out = await (bridge[name] as (...a: unknown[]) => Promise<unknown>)(...args)
    return typeof out === "string" ? JSON.parse(out) : out
  }
  const plain = (v: unknown) =>
    JSON.stringify(v ?? {}, (_k, x) => (typeof x === "bigint" ? x.toString() : x))
  return {
    ...issuePipelineCtx({} as never),
    db: {
      findMany: (e: string, o?: unknown) => call("db_findMany", e, plain(o)),
      findOne: (e: string, id: string) => call("db_findOne", e, id),
      insert: (e: string, d: unknown) => call("db_insert", e, plain(d)),
      update: (e: string, id: string, d: unknown) => call("db_update", e, id, plain(d)),
      updateMany: (e: string, o: unknown) => call("db_updateMany", e, plain(o)),
      delete: (e: string, id: string) => call("db_delete", e, id),
      count: (e: string, o?: unknown) => call("db_count", e, plain(o)),
      batch: (s: unknown) => call("db_batch", plain(s)),
    },
    // No renderer here: the document commits without its PDF, which is tried again later.
    pdf: {
      render: async () => {
        throw new Error("no renderer in this test")
      },
    },
    approval: null,
    decideApproval: async () => ({ status: "ok" }),
    getUserId: async () => "system",
    emit: async () => {},
    resolveContact: async () => null,
    // Stripe, as it answers for the sale.
    executeTool: async (tool: string, params: Row) =>
      tool === "stripe:invoice_payload"
        ? {
            status: "completed",
            result: {
              invoice: finalized({ ...PAID, stripe_invoice_id: String(params.stripeInvoiceId) }),
            },
          }
        : tool === "stripe:payment_payload"
          ? {
              status: "completed",
              result: { payment: { ...CHARGE, invoice_id: null, status: "succeeded" } },
            }
          : { status: "error", error: { code: "absent", message: "absent" } },
  } as unknown as Ctx
}

/** A handler run inside its own transaction, kept open until `commit()`. */
function held<T>(fn: (ctx: Ctx) => Promise<T>) {
  const ran = Promise.withResolvers<T>()
  const gate = Promise.withResolvers<void>()
  const committed = withRlsContext(
    actor(),
    async (tx) => {
      try {
        ran.resolve(await fn(ctxOn(tx)))
      } catch (err) {
        ran.reject(err)
        throw err
      }
      await gate.promise
    },
    { pool: "jobs" },
  )
  committed.catch(() => {})
  return {
    ran: ran.promise,
    commit: async () => {
      gate.resolve()
      await committed
    },
  }
}

const once = <T>(fn: (ctx: Ctx) => Promise<T>) => {
  const t = held(fn)
  return t.ran.then(async (r) => {
    await t.commit()
    return r
  })
}

/** Run `first` up to its commit, start `second`, let it reach the wait, commit both in that order. */
async function race<A, B>(first: (c: Ctx) => Promise<A>, second: (c: Ctx) => Promise<B>) {
  const one = held(first)
  const a = await one.ran
  const two = held(second)
  // The second has passed its checks (they read nothing uncommitted) and waits for the first.
  const early = await Promise.race([
    two.ran.then(() => "ended"),
    new Promise((r) => setTimeout(() => r("waiting"), 700)),
  ])
  await one.commit()
  const b = await two.ran
  await two.commit()
  return { a, b, early }
}

const invoices = () => sql<Row[]>`
  SELECT id::text, number, number_int, external_ref, external_refs FROM app_invoicing.documents
  WHERE org_id = ${ORG} AND type = 'invoice' ORDER BY number_int`
const openParks = () => sql<Row[]>`
  SELECT event_id, blocked_on FROM app_invoicing.deferred_events
  WHERE org_id = ${ORG} AND status NOT IN ('resolved', 'permanent_failure')
    AND event_id LIKE 'stripe:%'`
const sequence = async () => {
  const rows = await sql<Row[]>`
    SELECT COALESCE(sum(value), 0)::int AS n FROM kernel.app_sequences
    WHERE org_id = ${ORG} AND app_id = 'invoicing'`
  return Number(rows[0]?.n)
}

describe("two transactions on one Stripe sale", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    ORG = (await createTestOrg()).id
    await registerApps(
      [
        {
          ...MANIFEST,
          trusted: false,
          _firstParty: true,
          _format: "manifest",
          _bundlePath: join(
            REPO_ROOT,
            "bundled-apps",
            "invoicing",
            String(MANIFEST.version),
            "bundle.js",
          ),
        } as never,
      ],
      ORG,
    )
  }, 120_000)

  beforeEach(async () => {
    for (const t of ["deferred_events", "stripe_sales", "stripe_streams", "document_lines"])
      await sql.unsafe(`DELETE FROM app_invoicing.${t} WHERE org_id = $1`, [ORG])
    // Every test its own issuer and series: the documents of the tests before stay (they are legal).
    await sql`UPDATE app_invoicing.documents SET external_ref = NULL, external_refs = '{}'::jsonb WHERE org_id = ${ORG}`.catch(
      () => {},
    )
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.app_sequences WHERE org_id = ${ORG}`
    ISSUER = randomUUID()
    await sql.unsafe(
      insertSql("app_invoicing.issuer_profiles", {
        id: ISSUER,
        org_id: ORG,
        legal_name: `Studio ${ISSUER.slice(0, 8)}`,
        country: "FR",
        vat_id: "FR40902000009",
        address: "1 rue de Test, 75011 Paris",
        default_currency: "EUR",
        default_language: "en",
        timezone: "Europe/Paris",
      }),
    )
    await sql.unsafe(
      insertSql("app_invoicing.stripe_streams", {
        id: randomUUID(),
        org_id: ORG,
        issuer_profile_id: ISSUER,
        issuer: "liaison",
        stripe_connected: true,
        created_at: new Date(Date.UTC(2026, 10, 1, 9)).toISOString(),
      }),
    )
  })

  afterAll(async () => {
    resetAppRegistries()
    await releaseTestLock()
  })

  const event =
    (over: Row = {}) =>
    (c: Ctx) =>
      onStripeInvoiceFinalized({ data: finalized(over) }, c)
  const click = (c: Ctx) => invoiceFromStripePayment(c, { stripeInvoiceId: "in_1" })
  const chargeClick = (c: Ctx) => invoiceFromStripePayment(c, { chargeId: "ch_1", vatRateBp: 2000 })

  async function oneInvoice(ref: string) {
    const docs = await invoices()
    expect(docs.map((d) => [d.external_ref, Number(d.number_int)])).toEqual([[ref, 1]])
    expect(await sequence()).toBe(1)
    expect((await openParks()).filter((p) => p.event_id !== "stripe:re_1")).toHaveLength(0)
    // The next sale takes the next number: the loser consumed none.
    const next = await once(event({ stripe_invoice_id: "in_next", charge_id: "ch_next" }))
    expect(next.status).toBe("ok")
    expect((await invoices()).map((d) => Number(d.number_int))).toEqual([1, 2])
  }

  it("the same event twice: one commits, the other rolls back and takes no number", async () => {
    const { a, b, early } = await race(event(), event())
    expect(early).toBe("waiting")
    expect(a.status).toBe("ok")
    expect(b).toMatchObject({ status: "skipped", reason: "duplicate_document" })
    await oneInvoice("stripe:in_1")
  }, 60_000)

  it("a person's click past the retries and the safety job's event: one invoice", async () => {
    await once(event({ customer: { name: "L", email: "l@lumen.example", country: "FR" } }))
    await sql`UPDATE app_invoicing.deferred_events SET retry_count = 10 WHERE org_id = ${ORG}`
    const { a, b, early } = await race(click, click)
    expect(early).toBe("waiting")
    expect(a.status).toBe("completed")
    expect(b).toMatchObject({ status: "error", error: { code: "already_invoiced" } })
    await oneInvoice("stripe:in_1")
  }, 60_000)

  it("the Stripe invoice and a click on its charge: two keys of one sale, one invoice", async () => {
    await once((c) => onStripePaymentUnmatched({ data: CHARGE }, c))
    const { a, b, early } = await race(event(PAID), chargeClick)
    expect(early).toBe("waiting")
    expect(a.status).toBe("ok")
    expect(b).toMatchObject({ status: "error", error: { code: "already_invoiced" } })
    await oneInvoice("stripe:in_1")
  }, 60_000)

  it("the click on the charge first, its Stripe invoice second: one invoice", async () => {
    await once((c) => onStripePaymentUnmatched({ data: CHARGE }, c))
    const { a, b, early } = await race(chargeClick, event(PAID))
    expect(early).toBe("waiting")
    expect(a.status).toBe("completed")
    expect(b).toMatchObject({ status: "skipped", reason: "duplicate_document" })
    await oneInvoice("stripe:ch_1")
  }, 60_000)

  /** An invoice a person made of the sale, number 1, with no Stripe key. */
  async function byHand(): Promise<string> {
    const r = (await once(event({ stripe_invoice_id: "in_hand" }))) as { document_id: string }
    await sql`UPDATE app_invoicing.documents SET external_ref = NULL, external_refs = '{}'::jsonb WHERE id = ${r.document_id}`
    await sql`DELETE FROM app_invoicing.stripe_sales WHERE org_id = ${ORG}`
    return r.document_id
  }
  const link = (documentId: string) => (c: Ctx) =>
    paymentLinkToInvoice(c, { chargeId: "ch_1", documentId })

  it("a payment linked by hand while its Stripe invoice issues: the issue rolls back, no number", async () => {
    const doc = await byHand()
    const { a, b, early } = await race(link(doc), event(PAID))
    expect(early).toBe("waiting")
    expect(a.status).toBe("completed")
    expect(b).toMatchObject({ status: "skipped", document_id: doc })
    await oneInvoice("stripe:ch_1")
  }, 60_000)

  it("the issue first, the link second: the link is refused and changes nothing", async () => {
    const doc = await byHand()
    const { a, b, early } = await race(event(PAID), link(doc))
    expect(early).toBe("waiting")
    expect(a.status).toBe("ok")
    expect(b).toMatchObject({ status: "error", error: { code: "already_linked" } })
    const docs = await invoices()
    expect(docs.map((d) => d.external_ref)).toEqual([null, "stripe:in_1"])
    expect(docs[0]?.external_refs).toEqual({})
    expect(await sequence()).toBe(2)
  }, 60_000)

  it("six at once, of every kind, in any order: one invoice and no gap", async () => {
    await once((c) => onStripePaymentUnmatched({ data: CHARGE }, c))
    const all = await Promise.allSettled([
      once(event(PAID)),
      once(chargeClick),
      once(event(PAID)),
      once(click),
      once(chargeClick),
      once((c) => reconcileStripePayments(c)),
    ])
    expect(all.filter((r) => r.status === "rejected")).toEqual([])
    const docs = await invoices()
    expect(docs).toHaveLength(1)
    expect(await sequence()).toBe(1)
  }, 60_000)
})
