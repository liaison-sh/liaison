// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mirror of the supplier e-invoices the organisation receives through its e-invoicing platform
// (contract `einvoicing-pa@1`, reception ops). Three ways in, one ingest:
//   - the platform's arrival webhook, delivered through the provider's inbox and drained by the
//     e-invoicing job (`drainStatusChanges`, kind `supplier_invoice`), at most minutes later;
//   - the 3-hourly catch-up (`list_received` from the stored cursor), which also re-reads every
//     open received invoice (the platform pushes no status change for received invoices);
//   - the Refresh action (UI and agent), which runs the catch-up now.
// Ingest upserts one `received_einvoices` row per provider ref (status merged monotonically, the
// history appended), stores each file the provider offers in its own `received_einvoice_files`
// row (downloaded host-side by the provider onto that row; sha256 recorded; the row is
// write-once and kept 10 years), and reads the original XML's own figures through the safe
// reader, flagging any total that differs from the provider's.
import {
  type ContractEnvelope,
  isReceivedState,
  mergeReceived,
  RECEIVED_CODE,
  type ReceivedInvoice,
  type ReceivedState,
} from "@liaison/app-sdk/contracts"
import { decodeUtf8 } from "../einvoicing/transmit"
import { extractReceivedFacts, totalsDiffer } from "./extract"

export const CONTRACT = "einvoicing-pa@1"
/** Original XML parsed in the sandbox up to this size (the download cap stays 25 MB). */
export const PARSE_MAX_BYTES = 5 * 1024 * 1024

type Row = Record<string, unknown>

export interface ReceivedDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  delete?(entity: string, id: string): Promise<unknown>
}

export interface ReceivedCtx {
  db: ReceivedDb
  contracts?: {
    call(
      contract: string,
      op: string,
      params: Record<string, unknown>,
    ): Promise<ContractEnvelope<unknown>>
  }
  files_getAttachmentBytes?(argsJson: string): Promise<string>
  logger?: {
    info?(m: string, d?: unknown): void
    warn?(m: string, d?: unknown): void
    error?(m: string, d?: unknown): void
  }
}

export type Fail = {
  status: "error"
  error: { code: string; message: string; retryable?: boolean; detail?: unknown }
}

export function fail(code: string, message: string, detail?: unknown): Fail {
  return { status: "error", error: { code, message, ...(detail !== undefined ? { detail } : {}) } }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

export async function callProvider(
  ctx: ReceivedCtx,
  op: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: Row; provider: string } | { ok: false; error: Fail["error"] }> {
  if (!ctx.contracts)
    return {
      ok: false,
      error: { code: "contracts_unavailable", message: "contract dispatch is not available here" },
    }
  const env = await ctx.contracts.call(CONTRACT, op, params)
  if (env.status === "error") return { ok: false, error: env.error }
  const result = (env.result ?? {}) as Row
  if (result.status === "error" && result.error)
    return { ok: false, error: result.error as Fail["error"] }
  return { ok: true, result, provider: env.provider }
}

async function findReceived(
  db: ReceivedDb,
  providerApp: string,
  providerRef: string,
): Promise<Row | null> {
  const rows = (await db.findMany("received_einvoices", {
    where: { provider_app: providerApp, provider_ref: providerRef },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

export async function fileRows(db: ReceivedDb, receivedId: string): Promise<Row[]> {
  return (await db.findMany("received_einvoice_files", {
    where: { received_id: receivedId },
    limit: 10,
  })) as Row[]
}

/** The row fields a provider read sets (status merged against the stored one). */
export function rowFromProvider(inv: ReceivedInvoice, existing: Row | null, source: string): Row {
  const observed: ReceivedState = isReceivedState(inv.status?.mapped)
    ? inv.status.mapped
    : "received"
  const current = isReceivedState(existing?.status) ? (existing!.status as ReceivedState) : null
  const next = mergeReceived(current, observed) ?? "received"
  const log = Array.isArray(existing?.lifecycle_log) ? [...(existing!.lifecycle_log as Row[])] : []
  const last = log[log.length - 1]
  const raw = inv.status?.raw ?? null
  // The platform names a refusal's reason by its slug; the reasons it offered (before, or now)
  // carry the words in both languages, kept on the entry so the history reads in the reader's.
  const reasonText = inv.status?.reason_text ?? null
  const offered = [
    ...(Array.isArray(existing?.actions) ? (existing!.actions as ReceivedInvoice["actions"]) : []),
    ...(inv.actions ?? []),
  ]
  const known = reasonText
    ? offered.flatMap((o) => o?.reasons ?? []).find((r) => r.reason === reasonText)
    : undefined
  if (!last || last.raw !== raw || last.mapped !== observed) {
    log.push({
      raw,
      mapped: observed,
      code: RECEIVED_CODE[observed],
      provider_ts: inv.provider_ts ?? null,
      observed_at: new Date().toISOString(),
      source,
      reason_text: reasonText,
      ...(known ? { reason_label: known.label_en, reason_label_fr: known.label_fr } : {}),
      ...(observed !== next ? { ignored: "lower than the current state" } : {}),
    })
  }
  return {
    supplier_name: inv.supplier?.name ?? null,
    supplier_siren: inv.supplier?.siren ?? null,
    supplier_vat_id: inv.supplier?.vat_id ?? null,
    invoice_number: inv.invoice_number ?? null,
    issue_date: inv.issue_date ?? null,
    due_date: inv.due_date ?? null,
    currency: inv.currency ?? null,
    total_before_tax: inv.totals?.before_tax ?? null,
    total_tax: inv.totals?.tax ?? null,
    total: inv.totals?.total ?? null,
    status: next,
    status_raw: next === observed ? raw : ((existing?.status_raw as string | null) ?? raw),
    status_code: RECEIVED_CODE[next],
    status_reason:
      next === observed
        ? (inv.status?.reason_text ?? null)
        : ((existing?.status_reason as string | null) ?? null),
    lifecycle_log: log,
    // What may be done now: nothing on a terminal state, whatever the provider says.
    actions: next === "refused" || next === "rejected" ? [] : (inv.actions ?? []),
    payment_linked: inv.payment_linked === true,
    routing_address: inv.routing_address ?? null,
    flow_id: inv.flow_id ?? null,
    provider_ts: inv.provider_ts ?? null,
    received_at:
      (existing?.received_at as string | null) ?? inv.received_at ?? new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    meta: { files: inv.files ?? [] },
  }
}

/** Store each file the provider offers that is not stored yet; parse the original XML. */
async function ensureFiles(
  ctx: ReceivedCtx,
  row: Row,
  inv: ReceivedInvoice,
): Promise<{ pending: boolean; error: Fail["error"] | null }> {
  const id = String(row.id)
  const existing = await fileRows(ctx.db, id)
  let pending = false
  let lastError: Fail["error"] | null = null
  for (const f of inv.files ?? []) {
    let fr = existing.find((x) => x.kind === f.file)
    if (fr && str(fr.file_id)) continue
    if (!fr) {
      fr = (await ctx.db.insert("received_einvoice_files", {
        received_id: id,
        kind: f.file,
        recorded_at: new Date().toISOString(),
      })) as Row
    }
    const res = await callProvider(ctx, "fetch_received_file", {
      provider_ref: String(row.provider_ref),
      file: f.file,
      target: { app: "invoicing", entity_type: "received_file", entity_id: String(fr.id) },
    })
    if (!res.ok) {
      pending = true
      lastError = res.error
      ctx.logger?.warn?.("received e-invoice file not stored yet", {
        received_id: id,
        file: f.file,
        code: res.error.code,
      })
      continue
    }
    await ctx.db.update("received_einvoice_files", String(fr.id), {
      file_id: res.result.file_id,
      sha256: res.result.sha256 ?? null,
      byte_size: res.result.byte_size ?? null,
      mime_type: res.result.mime_type ?? f.mime_type ?? null,
      filename: res.result.filename ?? f.filename ?? null,
    })
  }
  return { pending, error: lastError }
}

/** Read the stored original's own figures (XML only; a PDF original keeps the provider's). */
async function parseOriginal(ctx: ReceivedCtx, row: Row): Promise<Row> {
  const files = await fileRows(ctx.db, String(row.id))
  const original = files.find((f) => f.kind === "original" && str(f.file_id))
  if (!original) return {}
  const mime = String(original.mime_type ?? "")
  const name = String(original.filename ?? "")
  const isXml = /xml/i.test(mime) || /\.xml$/i.test(name)
  if (!isXml) return { parse_status: "not_xml", parsed: null, totals_mismatch: null }
  if (Number(original.byte_size ?? 0) > PARSE_MAX_BYTES)
    return { parse_status: "too_large", parsed: null, totals_mismatch: null }
  if (!ctx.files_getAttachmentBytes) return {}
  let xml: string
  try {
    const out = JSON.parse(
      await ctx.files_getAttachmentBytes(
        JSON.stringify({
          fileId: original.file_id,
          allowedParents: [
            { app: "invoicing", entityType: "received_file", entityId: original.id },
          ],
        }),
      ),
    ) as { bytesBase64?: string }
    xml = out.bytesBase64 ? decodeUtf8(out.bytesBase64) : ""
  } catch (e) {
    ctx.logger?.warn?.("received e-invoice original unreadable", {
      received_id: row.id,
      err: e instanceof Error ? e.message : String(e),
    })
    return {}
  }
  const outcome = extractReceivedFacts(xml.replace(/^﻿/, ""), { maxBytes: PARSE_MAX_BYTES })
  if (!outcome.ok) {
    const refused = [
      "xml_dtd_refused",
      "xml_entity_refused",
      "xml_too_large",
      "xml_too_complex",
      "xml_timeout",
    ].includes(outcome.code)
    return {
      parse_status: refused ? "refused_unsafe" : "failed",
      parsed: { code: outcome.code, message: outcome.message },
      totals_mismatch: null,
    }
  }
  const f = outcome.facts
  const differs = totalsDiffer(
    { before_tax: str(row.total_before_tax), tax: str(row.total_tax), total: str(row.total) },
    f.totals,
  )
  return { parse_status: "parsed", parsed: f, totals_mismatch: differs.length > 0 ? differs : null }
}

export interface IngestOutcome {
  received_id: string
  created: boolean
  files_pending: boolean
}

/** Read one received invoice from the bound provider and mirror it. */
export async function ingestReceived(
  ctx: ReceivedCtx,
  providerRef: string,
  source: "webhook" | "catch_up" | "refresh",
): Promise<IngestOutcome | Fail> {
  const got = await callProvider(ctx, "get_received", { provider_ref: providerRef })
  if (!got.ok) return fail(got.error.code, got.error.message, got.error.detail)
  const inv = got.result as unknown as ReceivedInvoice
  const providerApp = got.provider
  let existing = await findReceived(ctx.db, providerApp, providerRef)
  const data = rowFromProvider(inv, existing, source)
  let created = false
  if (existing) {
    await ctx.db.update("received_einvoices", String(existing.id), data)
  } else {
    try {
      existing = (await ctx.db.insert("received_einvoices", {
        provider_app: providerApp,
        provider_ref: providerRef,
        ...data,
      })) as Row
      created = true
    } catch (e) {
      // A concurrent ingest of the same ref won the unique key: update that row instead.
      existing = await findReceived(ctx.db, providerApp, providerRef)
      if (!existing) throw e
      await ctx.db.update("received_einvoices", String(existing.id), data)
    }
  }
  const row: Row = { ...existing, ...data }
  const files = await ensureFiles(ctx, row, inv)
  const parsed =
    row.parse_status === "parsed" || row.parse_status === "refused_unsafe"
      ? {}
      : await parseOriginal(ctx, row)
  await ctx.db.update("received_einvoices", String(row.id), {
    ...parsed,
    files_pending: files.pending,
    last_error: files.error
      ? { code: files.error.code, message: String(files.error.message).slice(0, 500) }
      : null,
  })
  return { received_id: String(row.id), created, files_pending: files.pending }
}

// ---------------------------------------------------------------------------------------------
// Refs that could not be read yet. The catch-up's cursor moves past whatever it listed, and the
// provider never lists a ref again, so a ref whose read failed (a 429, a 5xx, an outage) is kept
// in `received_retry` and read again at every catch-up until it is stored. Nothing is dropped.

async function retryRow(db: ReceivedDb, providerRef: string): Promise<Row | null> {
  const rows = (await db.findMany("received_retry", {
    where: { provider_ref: providerRef },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

export async function queueRetry(
  db: ReceivedDb,
  providerRef: string,
  error: Fail["error"],
): Promise<void> {
  const now = new Date().toISOString()
  const last_error = { code: error.code, message: String(error.message ?? "").slice(0, 300) }
  const existing = await retryRow(db, providerRef)
  if (existing) {
    await db.update("received_retry", String(existing.id), {
      attempts: Number(existing.attempts ?? 0) + 1,
      last_error,
      last_failed_at: now,
    })
    return
  }
  try {
    await db.insert("received_retry", {
      provider_ref: providerRef,
      attempts: 1,
      last_error,
      first_failed_at: now,
      last_failed_at: now,
    })
  } catch (e) {
    // A concurrent failure of the same ref queued it first.
    const again = await retryRow(db, providerRef)
    if (!again) throw e
    await db.update("received_retry", String(again.id), {
      attempts: Number(again.attempts ?? 0) + 1,
      last_error,
      last_failed_at: now,
    })
  }
}

async function clearRetry(db: ReceivedDb, providerRef: string): Promise<void> {
  const row = await retryRow(db, providerRef)
  if (row && db.delete) await db.delete("received_retry", String(row.id))
}

/** Ingest one ref; a failed read is queued for the next catch-up instead of being lost. */
export async function ingestOrQueue(
  ctx: ReceivedCtx,
  providerRef: string,
  source: "webhook" | "catch_up" | "refresh",
): Promise<IngestOutcome | Fail> {
  const r = await ingestReceived(ctx, providerRef, source)
  if ("status" in r) {
    await queueRetry(ctx.db, providerRef, r.error)
    ctx.logger?.warn?.("received e-invoice not read yet, queued for the next catch-up", {
      provider_ref: providerRef,
      code: r.error.code,
    })
  } else {
    await clearRetry(ctx.db, providerRef)
  }
  return r
}

// ---------------------------------------------------------------------------------------------
// Catch-up and refresh.

async function syncState(db: ReceivedDb): Promise<Row | null> {
  const rows = (await db.findMany("received_sync_state", {
    orderBy: { createdAt: "asc" },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

export interface CatchUpResult {
  listed: number
  ingested: number
  refreshed: number
  failed: number
  skipped?: string
}

const OPEN_STATES = ["received", "approved", "in_dispute", "partially_collected"]

/** List what arrived since the cursor, ingest it, then re-read open invoices (oldest sync first). */
export async function receivedCatchUp(
  ctx: ReceivedCtx,
  opts: { reread?: number } = {},
): Promise<CatchUpResult> {
  const out: CatchUpResult = { listed: 0, ingested: 0, refreshed: 0, failed: 0 }
  const state = await syncState(ctx.db)
  let cursor = str(state?.cursor)
  let stateId = state ? String(state.id) : null
  const seen = new Set<string>()
  // A rate limit stops the reads of this run; what is left is queued, never skipped.
  let throttled = false
  const readOne = async (ref: string): Promise<boolean> => {
    if (throttled) {
      await queueRetry(ctx.db, ref, {
        code: "provider_rate_limited",
        message: "not read: the platform asked to slow down",
      })
      return false
    }
    const r = await ingestOrQueue(ctx, ref, "catch_up")
    if ("status" in r) {
      if (r.error.code === "provider_rate_limited") throttled = true
      return false
    }
    return true
  }
  // First the refs an earlier run could not read.
  const queued = (await ctx.db.findMany("received_retry", {
    orderBy: { createdAt: "asc" },
    limit: 200,
  })) as Row[]
  for (const q of queued) {
    const ref = String(q.provider_ref)
    if (seen.has(ref)) continue
    seen.add(ref)
    if (await readOne(ref)) out.ingested += 1
    else out.failed += 1
  }
  for (let page = 0; page < 10; page++) {
    const res = await callProvider(ctx, "list_received", { cursor })
    if (!res.ok) {
      if (
        [
          "contract_provider_not_configured",
          "contract_op_unsupported",
          "contract_provider_unavailable",
        ].includes(res.error.code)
      ) {
        return { ...out, skipped: res.error.code }
      }
      out.failed += 1
      break
    }
    const items = (res.result.items ?? []) as Array<{ provider_ref: string }>
    out.listed += items.length
    for (const it of items) {
      const ref = String(it.provider_ref)
      if (seen.has(ref)) continue
      seen.add(ref)
      if (await readOne(ref)) out.ingested += 1
      else out.failed += 1
    }
    cursor = str(res.result.cursor) ?? cursor
    const stamp = { cursor, last_catch_up_at: new Date().toISOString() }
    if (stateId) await ctx.db.update("received_sync_state", stateId, stamp)
    else stateId = String(((await ctx.db.insert("received_sync_state", stamp)) as Row).id)
    if (res.result.has_more !== true) break
  }
  // Statuses of received invoices change without a push: re-read the open ones, and any whose
  // files are not all stored yet.
  const limit = opts.reread ?? 100
  const open: Row[] = []
  for (const status of OPEN_STATES) {
    open.push(
      ...((await ctx.db.findMany("received_einvoices", {
        where: { status },
        orderBy: { last_synced_at: "asc" },
        limit,
      })) as Row[]),
    )
  }
  open.push(
    ...((await ctx.db.findMany("received_einvoices", {
      where: { files_pending: true },
      limit,
    })) as Row[]),
  )
  const done = new Set<string>()
  if (throttled) return out
  for (const row of open.sort((a, b) =>
    String(a.last_synced_at ?? "").localeCompare(String(b.last_synced_at ?? "")),
  )) {
    const ref = String(row.provider_ref)
    if (seen.has(ref) || done.has(ref) || done.size >= limit) continue
    done.add(ref)
    const r = await ingestReceived(ctx, ref, "catch_up")
    if ("status" in r) {
      out.failed += 1
      if (r.error.code === "provider_rate_limited") break
    } else out.refreshed += 1
  }
  return out
}
