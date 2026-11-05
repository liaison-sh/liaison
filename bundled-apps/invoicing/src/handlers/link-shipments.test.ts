// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The link-shipments job: an invoice records the Boxtal shipment(s) created against it, read
// through boxtal's public search tool, without ever touching the shipment_ref column (the per
// shipment proforma key, whose use on an invoice would let the order webhook issue a duplicate).
import { describe, expect, test } from "bun:test"
import { documentsGet } from "../reads"
import { createMockDb } from "../test-db"
import { type LinkShipmentsCtx, linkShipments } from "./link-shipments"

const INVOICE = "00000000-0000-4000-8000-000000000a01"
const SERVICES = "00000000-0000-4000-8000-000000000a02"
const OLD = "00000000-0000-4000-8000-000000000a03"
const NOW = new Date("2026-10-05T12:00:00Z")

function doc(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "invoice",
    scope: "goods",
    status: "issued",
    number: `INV-${id.slice(-3)}`,
    issued_at: "2026-10-01",
    shipment_ref: null,
    shopify_order_id: "13035044503883",
    external_refs: { shopify_order_id: "13035044503883" },
    lifecycle_log: [{ event: "issued" }],
    ...over,
  }
}

function boxtal(hits: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<Record<string, unknown>> = []
  const executeTool: LinkShipmentsCtx["executeTool"] = async (target, args) => {
    calls.push({ target, ...args })
    if (target !== "boxtal:search") return { status: "error", error: { code: "unexpected" } }
    return { status: "completed", result: { results: hits[String(args.query)] ?? [] } }
  }
  return { calls, executeTool }
}

describe("link-shipments job", () => {
  // red: make linkShipments a no-op -> shipment_ref stays the only link and it is null, the
  // invoice never learns its parcel (BUG-42).
  test("an invoice learns the live shipment created against it; shipment_ref stays null", async () => {
    const db = createMockDb({ seed: { documents: [doc(INVOICE)] } })
    const { executeTool } = boxtal({
      [INVOICE]: [
        {
          id: "966984e4-353a-40b8-ac86-3e71f7cd37a6",
          attributes: { document_ref: INVOICE, order_status: "CONFIRMED", tracking_number: "875663524252", carrier: "FEDEX" },
        },
        // A substring hit on another document, and a cancelled shipment: never linked.
        { id: "other", attributes: { document_ref: `${INVOICE}-x`, order_status: "CONFIRMED" } },
        { id: "cancelled", attributes: { document_ref: INVOICE, order_status: "CANCELLED" } },
      ],
    })
    const res = await linkShipments({ db, executeTool }, { now: NOW })
    expect(res.linked).toBe(1)
    const row = (await db.findOne("documents", INVOICE)) as Record<string, unknown>
    expect(row.shipment_ref).toBeNull()
    expect((row.external_refs as Record<string, unknown>).shipments).toEqual([
      { shipment_id: "966984e4-353a-40b8-ac86-3e71f7cd37a6", tracking_number: "875663524252", carrier: "FEDEX" },
    ])
    expect((row.external_refs as Record<string, unknown>).shopify_order_id).toBe("13035044503883")
    const log = row.lifecycle_log as Array<Record<string, unknown>>
    expect(log.at(-1)).toMatchObject({ event: "shipment_linked" })
    // documents_get exposes it in one hop.
    const full = await documentsGet({ db } as never, { id: INVOICE })
    expect(full?.shipments.map((s) => s.tracking_number)).toEqual(["875663524252"])
  })

  test("the services half, an old invoice and an already linked invoice are never asked about", async () => {
    const db = createMockDb({
      seed: {
        documents: [
          doc(SERVICES, { scope: "software" }),
          doc(OLD, { issued_at: "2026-06-01" }),
          doc(INVOICE, { external_refs: { shipments: [{ shipment_id: "s-1" }] } }),
        ],
      },
    })
    const { calls, executeTool } = boxtal({})
    const res = await linkShipments({ db, executeTool }, { now: NOW })
    expect(calls).toHaveLength(0)
    expect(res.linked).toBe(0)
  })

  test("boxtal not installed stops the run quietly", async () => {
    const db = createMockDb({ seed: { documents: [doc(INVOICE), doc(OLD, { issued_at: "2026-10-02" })] } })
    let n = 0
    const res = await linkShipments(
      {
        db,
        executeTool: async () => {
          n += 1
          return { status: "error", error: { code: "target_app_unavailable" } }
        },
      },
      { now: NOW },
    )
    expect(n).toBe(1)
    expect(res.stopped).toBe("target_app_unavailable")
    expect(res.linked).toBe(0)
  })

  // red: write external_refs / lifecycle_log from the scan snapshot (the pre-merge shape) -> the
  // refund recorded on the invoice while boxtal answered is dropped from lifecycle_log.
  test("a refund recorded while boxtal answers survives the link (merge, not a stale overwrite)", async () => {
    const db = createMockDb({ seed: { documents: [doc(INVOICE)] } })
    const executeTool: LinkShipmentsCtx["executeTool"] = async () => {
      // A refund lands on the same invoice between the scan and the write.
      const row = (await db.findOne("documents", INVOICE)) as Record<string, unknown>
      await db.update("documents", INVOICE, {
        payment_status: "partial",
        lifecycle_log: [
          ...(row.lifecycle_log as Array<Record<string, unknown>>),
          { event: "partially_refunded", refund_amount_minor: "1750", shopify_refund_id: "r1" },
        ],
        external_refs: { ...(row.external_refs as Record<string, unknown>), note: "kept" },
      })
      return {
        status: "completed",
        result: { results: [{ id: "s-9", attributes: { document_ref: INVOICE, order_status: "CONFIRMED" } }] },
      }
    }
    await linkShipments({ db, executeTool }, { now: NOW })
    const row = (await db.findOne("documents", INVOICE)) as Record<string, unknown>
    const events = (row.lifecycle_log as Array<Record<string, unknown>>).map((e) => e.event)
    expect(events).toEqual(["issued", "partially_refunded", "shipment_linked"])
    expect((row.external_refs as Record<string, unknown>).note).toBe("kept")
    expect(row.payment_status).toBe("partial")
  })

  // red (prod, 2026-10-23): the lock was `updateMany` with `where.id`, which the sandbox bridge
  // refuses, so the job threw on every run and no invoice was ever linked. The mock refuses it
  // too now (test-helpers mock-db); this pins that the lock is a by-id `update` of the number,
  // taken before the re-read and the patch.
  test("locks the row with a by-id update the bridge accepts, before re-reading it", async () => {
    const db = createMockDb({ seed: { documents: [doc(INVOICE)] } })
    const calls: string[] = []
    const traced = {
      ...db,
      findMany: db.findMany.bind(db),
      findOne: async (entity: string, id: string) => {
        calls.push(`findOne ${entity}`)
        return db.findOne(entity, id)
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        calls.push(`update ${entity} ${Object.keys(data).sort().join(",")}`)
        return db.update(entity, id, data)
      },
    }
    const { executeTool } = boxtal({
      [INVOICE]: [{ id: "s-1", attributes: { document_ref: INVOICE, order_status: "CONFIRMED" } }],
    })
    const res = await linkShipments({ db: traced, executeTool }, { now: NOW })
    expect(res.linked).toBe(1)
    const tail = calls.slice(calls.lastIndexOf("update documents number") - 1)
    expect(tail).toEqual([
      "findOne documents",
      "update documents number",
      "findOne documents",
      "update documents external_refs,lifecycle_log",
    ])
  })
})
