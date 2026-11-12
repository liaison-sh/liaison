// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Status-change inbox. A verified webhook (or the catch-up job) only records WHICH provider ref
// may have changed; the payload is never trusted. `list_status_changes` hands the pending refs to
// the bound caller, which re-reads each one through `get_einvoice_status`. Delivery is
// at-least-once and per item: each item carries `ack` (its inbox rows), and the caller passes
// back as `cursor` only the acks of the items it actually handled. An item it skipped (another
// kind, a re-read that failed) stays pending and is delivered again; `kind` narrows the listing
// so one consumer never holds up another's rows.
import type { PennylaneToolCtx } from "../ctx"

export interface InboxRow {
  id: string
  provider_ref: string
  kind: string
  event_type: string | null
  envelope_id: string | null
  received_at: string | null
  delivered_at: string | null
}

export async function recordStatusChange(
  ctx: Pick<PennylaneToolCtx, "db">,
  row: {
    provider_ref: string
    kind: "customer_invoice" | "supplier_invoice"
    event_type: string | null
    envelope_id: string | null
  },
): Promise<void> {
  if (row.envelope_id) {
    const seen = await ctx.db.findMany("einvoicing_inbox", {
      where: { envelope_id: row.envelope_id },
      limit: 1,
    })
    if (seen.length > 0) return
  }
  await ctx.db.insert("einvoicing_inbox", {
    provider_ref: row.provider_ref,
    kind: row.kind,
    event_type: row.event_type,
    envelope_id: row.envelope_id,
    received_at: new Date().toISOString(),
    delivered_at: null,
  })
}

const BATCH = 100

export async function listStatusChanges(
  ctx: Pick<PennylaneToolCtx, "db">,
  p: { cursor?: string | null; kind?: string | null },
): Promise<{
  items: Array<{
    provider_ref: string
    kind: string
    event_type: string | null
    received_at: string | null
    ack: string
  }>
}> {
  const ack =
    typeof p?.cursor === "string" && p.cursor !== ""
      ? p.cursor.split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x))
      : []
  const now = new Date().toISOString()
  for (const id of ack) await ctx.db.update("einvoicing_inbox", id, { delivered_at: now })
  const kind = typeof p?.kind === "string" && p.kind !== "" ? p.kind : null
  const rows = (await ctx.db.findMany("einvoicing_inbox", {
    where: { delivered_at: null, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: "asc" },
    limit: BATCH,
  })) as InboxRow[]
  const byKey = new Map<
    string,
    {
      provider_ref: string
      kind: string
      event_type: string | null
      received_at: string | null
      ids: string[]
    }
  >()
  for (const r of rows) {
    const key = `${r.kind}:${r.provider_ref}`
    const item = byKey.get(key)
    if (item) item.ids.push(r.id)
    else
      byKey.set(key, {
        provider_ref: r.provider_ref,
        kind: r.kind,
        event_type: r.event_type,
        received_at: r.received_at,
        ids: [r.id],
      })
  }
  return {
    items: [...byKey.values()].map(({ ids, ...item }) => ({ ...item, ack: ids.join(",") })),
  }
}
