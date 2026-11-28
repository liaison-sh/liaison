// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Revenue streams: the sales apps whose sales this organization invoices. One row per provider
// app (and account of it, `source_ref`) and issuer profile (`revenue_streams`). The kernel lets
// invoicing read a provider's sales (`revenue-stream@1` `sale_get` / `sales_list`) only while a row
// names that provider (contract_calls bindingSetting `revenue_streams.provider_app`).
//
// Binding a stream is a person's decision (`revenue_stream_bind`, gated, never auto-approved). Its
// `issue_from` is the moment of binding: older sales are issued only through the catch-up, never by
// an event. `mode`: `auto` issues each sale (the issuer's approval threshold applies), `review`
// asks a person for every sale, `off` issues nothing.
//
// The shop is the exception carried over from before streams existed: a connected Shopify store
// has always had its paid orders invoiced, the issuer chosen per shop by the issuer profile's shop
// mapping (`issuer_profiles.shopify_shop_id`). Its row is created when its first sale arrives
// (`ensureShopifyStream`), with no issuer of its own (the mapping decides, as before), mode auto
// and no lower bound, so nothing about the shop's invoices changes.

import type { IssueDb } from "../issue"

type Row = Record<string, unknown>
type Db = Pick<IssueDb, "findMany" | "insert">

export const STREAMS = "revenue_streams"

export type StreamMode = "auto" | "review" | "off"
export type StreamMail = "thanks" | "invoice_only" | "none"

export interface RevenueStream {
  id: string
  provider_app: string
  /** The provider's account the stream covers (a shop domain); null: every sale of the provider. */
  source_ref: string | null
  label: string | null
  /** Null for the shop's stream: its shop mapping chooses the issuer per shop. */
  issuer_profile_id: string | null
  mode: StreamMode
  /** Sales paid before this instant are issued only by the catch-up. Null: no bound. */
  issue_from: string | null
  mail: StreamMail
  /** The `source.stream` the buyer invoices API lists this stream's sales under: the name the
   *  shop's website gives the stream ("hub"). Null: the provider app's name. Never on the shop's
   *  stream, whose sales are always `shopify`. */
  buyer_source_key: string | null
  decided_by: string | null
  decided_at: string | null
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "string" && v !== "") return new Date(v).toISOString()
  return null
}

export function toStream(r: Row): RevenueStream {
  const mode = String(r.mode ?? "review")
  const mail = String(r.mail ?? "none")
  return {
    id: String(r.id),
    provider_app: String(r.provider_app ?? ""),
    source_ref: (r.source_ref as string | null | undefined) ?? null,
    label: (r.label as string | null | undefined) ?? null,
    issuer_profile_id: (r.issuer_profile_id as string | null | undefined) ?? null,
    mode: mode === "auto" || mode === "off" ? mode : "review",
    issue_from: iso(r.issue_from),
    mail: mail === "thanks" || mail === "invoice_only" ? mail : "none",
    buyer_source_key: (r.buyer_source_key as string | null | undefined) || null,
    decided_by: (r.decided_by as string | null | undefined) ?? null,
    decided_at: iso(r.decided_at),
  }
}

export async function streamsOf(db: Db, providerApp: string): Promise<RevenueStream[]> {
  const rows = (await db.findMany(STREAMS, {
    where: { provider_app: providerApp },
    orderBy: { createdAt: "asc" },
    limit: 50,
  })) as Row[]
  return rows.map(toStream)
}

export async function streamById(db: Db, id: string): Promise<RevenueStream | null> {
  const rows = (await db.findMany(STREAMS, { where: { id }, limit: 1 })) as Row[]
  return rows[0] ? toStream(rows[0]) : null
}

export const SHOPIFY = "shopify"

/** A buyer source key: a short lower-case name ("hub", "web-shop"). */
export const BUYER_SOURCE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** The shop's stream, created on its first sale (see the header). */
export async function ensureShopifyStream(db: Db): Promise<void> {
  if ((await streamsOf(db, SHOPIFY)).length > 0) return
  try {
    await db.insert(STREAMS, {
      provider_app: SHOPIFY,
      source_ref: null,
      label: "Shopify",
      issuer_profile_id: null,
      mode: "auto",
      issue_from: null,
      // The shop's invoices are mailed as before: when the mapped issuer profile mails them.
      mail: "invoice_only",
      decided_at: new Date().toISOString(),
    })
  } catch (err) {
    // A concurrent first sale created it.
    if ((await streamsOf(db, SHOPIFY)).length === 0) throw err
  }
}

/**
 * The stream a sale belongs to: the provider's stream for the sale's account, else its stream
 * covering every account. Null when none does.
 */
export function streamForSale(
  streams: RevenueStream[],
  account: string | null | undefined,
): RevenueStream | null {
  const exact = account ? streams.find((s) => s.source_ref === account) : undefined
  return exact ?? streams.find((s) => s.source_ref === null) ?? null
}
