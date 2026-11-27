// SPDX-License-Identifier: FSL-1.1-ALv2
// biome-ignore-all lint/correctness/noUnusedVariables: handlers are resolved by manifest export name inside the sandbox
//
// An organization's own sales app, implementing revenue-stream@1 (revenue-stream-custom-app
// .integration.test.ts): it keeps each sale in its own table, announces it with sale:paid or
// sale:refunded, and answers the contract's sale_get and sales_list from that table. Evaluated
// raw inside QuickJS on the bridge: self-contained, no imports.

async function rowOf(ctx, externalId) {
  const rows = JSON.parse(
    await ctx.db_findMany(
      "sales",
      JSON.stringify({ where: { external_id: externalId }, limit: 1 }),
    ),
  )
  return rows[0] || null
}

function saleOf(row) {
  return typeof row.sale === "string" ? JSON.parse(row.sale) : row.sale
}

async function record_sale(params, ctx) {
  const sale = params.sale
  const row = await rowOf(ctx, sale.external_id)
  if (row) await ctx.db_update("sales", row.id, JSON.stringify({ sale }))
  else await ctx.db_insert("sales", JSON.stringify({ external_id: sale.external_id, sale }))
  // A payment provider's webhook announces it (the test publishes that event); a person's own
  // record emits here.
  if (params.announce === false) return { recorded: sale.external_id }
  await ctx.emit(
    JSON.stringify({
      entity: "sale",
      action: "paid",
      entityId: sale.external_id,
      data: { external_id: sale.external_id, occurred_at: sale.sold_at },
    }),
  )
  return { recorded: sale.external_id }
}

async function store_sale(params, ctx) {
  const sale = params.sale
  await ctx.db_insert("sales", JSON.stringify({ external_id: sale.external_id, sale }))
  return { stored: sale.external_id }
}

async function refund_sale(params, ctx) {
  const row = await rowOf(ctx, params.external_id)
  if (!row) return { refunded: null }
  const sale = saleOf(row)
  sale.refunds = (sale.refunds || []).concat([params.refund])
  sale.paid = { status: "partially_refunded", payment_ref: sale.paid && sale.paid.payment_ref }
  await ctx.db_update("sales", row.id, JSON.stringify({ sale }))
  if (params.announce === false) return { refunded: params.refund.refund_id }
  await ctx.emit(
    JSON.stringify({
      entity: "sale",
      action: "refunded",
      entityId: params.external_id,
      data: { external_id: params.external_id, occurred_at: params.refund.at },
    }),
  )
  return { refunded: params.refund.refund_id }
}

async function rs_sale_get(params, ctx) {
  const row = await rowOf(ctx, params.external_id)
  return row ? { found: true, sale: saleOf(row) } : { found: false }
}

async function rs_sales_list(params, ctx) {
  const rows = JSON.parse(await ctx.db_findMany("sales", JSON.stringify({ limit: 100 })))
  const from = Date.parse(params.paid_from)
  const to = Date.parse(params.paid_to)
  const sales = rows.map(saleOf).filter((s) => {
    const at = Date.parse(s.sold_at)
    return at >= from && at < to
  })
  return { sales, next: null }
}
