// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The revenue stream tools: `revenue_streams_list` (read) and `revenue_stream_bind` (gated, never
// auto-approved: a person decides which sales app's sales this organization invoices, under which
// issuer profile, and how). A new stream issues the sales paid from the moment it is bound; older
// ones go through `sales_catch_up`.

import { REVENUE_STREAM } from "@liaison/app-sdk/contracts"
import type { MutationsCtx } from "../mutations/shared"
import {
  type RevenueStream,
  SHOPIFY,
  STREAMS,
  type StreamMail,
  type StreamMode,
  streamById,
  streamsOf,
  toStream,
} from "./streams"

type Row = Record<string, unknown>

export interface StreamToolsCtx {
  db: MutationsCtx["db"]
  getUserId: MutationsCtx["getUserId"]
  approval?: MutationsCtx["approval"] | null
  contracts?: { providers?(contract: string): Promise<unknown> }
}

const fail = (code: string, message: string) => ({
  status: "error" as const,
  error: { code, message },
})

const MODES: ReadonlySet<string> = new Set(["auto", "review", "off"])
const MAILS: ReadonlySet<string> = new Set(["thanks", "invoice_only", "none"])

async function providersOf(ctx: StreamToolsCtx): Promise<string[] | null> {
  if (!ctx.contracts?.providers) return null
  const raw = await ctx.contracts.providers(REVENUE_STREAM)
  const list = typeof raw === "string" ? JSON.parse(raw) : raw
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
}

function view(s: RevenueStream) {
  return {
    streamId: s.id,
    providerApp: s.provider_app,
    sourceRef: s.source_ref,
    label: s.label,
    issuerProfileId: s.issuer_profile_id,
    mode: s.mode,
    issueFrom: s.issue_from,
    mail: s.mail,
    decidedAt: s.decided_at,
  }
}

/** Every bound stream, and the installed apps that could be bound (implementing the contract). */
export async function revenueStreamsList(ctx: StreamToolsCtx) {
  const rows = (await ctx.db.findMany(STREAMS, {
    orderBy: { createdAt: "asc" },
    limit: 200,
  })) as Row[]
  const providers = (await providersOf(ctx)) ?? []
  return {
    status: "completed" as const,
    streams: rows.map(toStream).map(view),
    availableProviders: providers,
  }
}

export interface BindInput {
  streamId?: string
  providerApp?: string
  issuerProfileId?: string
  sourceRef?: string | null
  label?: string | null
  mode?: string
  mail?: string
}

/**
 * Bind a sales app's sales to an issuer profile, or change a bound stream (its mode, mail,
 * label or issuer). Runs only on a person's decision (the tool is gated, never auto-approved).
 */
export async function revenueStreamBind(ctx: StreamToolsCtx, input: BindInput) {
  const mode = input.mode ?? "review"
  const mail = input.mail ?? "none"
  if (!MODES.has(mode)) return fail("invalid_input", "mode is one of auto, review, off")
  if (!MAILS.has(mail)) return fail("invalid_input", "mail is one of thanks, invoice_only, none")
  const by = ctx.approval?.approvalDeciderId ?? (await ctx.getUserId())
  const now = new Date().toISOString()
  const issuerOk = async (id: string | undefined) => {
    if (!id) return false
    const rows = await ctx.db.findMany("issuer_profiles", { where: { id }, limit: 1 })
    return rows.length > 0
  }

  if (input.streamId) {
    const current = await streamById(ctx.db, input.streamId)
    if (!current) return fail("stream_not_found", "No revenue stream has that id.")
    if (input.issuerProfileId !== undefined && !(await issuerOk(input.issuerProfileId)))
      return fail("issuer_profile_not_found", "No issuer profile has that id.")
    if (current.provider_app === SHOPIFY && input.issuerProfileId !== undefined)
      return fail(
        "issuer_from_shop_mapping",
        "The shop's issuer is chosen per shop by the shop mapping (settings_shop_mapping_list), not on its stream.",
      )
    await ctx.db.update(STREAMS, current.id, {
      ...(input.mode !== undefined ? { mode: mode as StreamMode } : {}),
      ...(input.mail !== undefined ? { mail: mail as StreamMail } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.issuerProfileId !== undefined ? { issuer_profile_id: input.issuerProfileId } : {}),
      decided_by: by,
      decided_at: now,
    })
    const after = await streamById(ctx.db, current.id)
    return { status: "completed" as const, stream: after ? view(after) : null, changed: true }
  }

  const provider = String(input.providerApp ?? "").trim()
  if (!provider) return fail("invalid_input", "providerApp names the sales app to bind")
  if (provider === SHOPIFY)
    return fail(
      "shop_stream_automatic",
      "The shop's stream exists by itself once the store is connected; change it with its streamId.",
    )
  const providers = await providersOf(ctx)
  if (providers && !providers.includes(provider))
    return fail(
      "provider_not_available",
      `${provider} is not an installed app reporting its sales (revenue-stream@1). Available: ${providers.join(", ") || "none"}.`,
    )
  if (!(await issuerOk(input.issuerProfileId)))
    return fail(
      "issuer_profile_not_found",
      "issuerProfileId names the issuer profile to invoice under.",
    )
  const sourceRef = input.sourceRef ?? null
  const existing = (await streamsOf(ctx.db, provider)).find((s) => s.source_ref === sourceRef)
  if (existing)
    return fail(
      "stream_exists",
      `${provider} is already bound (stream ${existing.id}); change it with its streamId.`,
    )
  const created = await ctx.db.insert(STREAMS, {
    provider_app: provider,
    source_ref: sourceRef,
    label: input.label ?? provider,
    issuer_profile_id: input.issuerProfileId,
    mode,
    // From the moment of binding: older sales issue only through the catch-up.
    issue_from: now,
    mail,
    decided_by: by,
    decided_at: now,
  })
  const createdId = String((created as { id?: unknown } | null)?.id ?? "")
  const after = createdId ? await streamById(ctx.db, createdId) : null
  return { status: "completed" as const, stream: after ? view(after) : null, changed: true }
}
