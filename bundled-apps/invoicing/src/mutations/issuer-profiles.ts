// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: Settings issuer-profile CRUD.

import { checkIssuerTimezone, normalizeIssuerTimezone } from "../issue-date"
import type { ErrorEnvelope, MutationsCtx, MutationResult, PreflightResult } from "./shared"

// ─────────────────────────────────────────────────────────────────────────
// Task F — Settings issuer-profile CRUD + PDF retry. Back the Settings page
// and the document-detail "retry render" affordance the F-stage shipped but
// never wired tools for.
// ─────────────────────────────────────────────────────────────────────────

const ISSUER_WRITE_COLUMNS = [
  "legal_name",
  "country",
  "vat_id",
  "tax_registration_id",
  "address",
  "iban",
  "swift_bic",
  "bank_name",
  "logo_file_id",
  "default_currency",
  "default_language",
  "default_payment_terms_days",
  "prefix_invoice",
  "prefix_quote",
  "prefix_proforma",
  "prefix_po",
  "invoice_approval_threshold_minor",
  "po_approval_threshold_minor",
  "require_two_eyes",
  "auto_email_enabled",
  "prices_include_tax",
  "mail_account_id",
  "timezone",
  "email_templates",
  "shopify_shop_id",
] as const

/** Whitelist the writable issuer columns from a UI/agent payload (drops id,
 *  reference_count, archived_at and any other read-only/derived fields). */
function pickIssuerWrite(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of ISSUER_WRITE_COLUMNS) {
    if (input[c] !== undefined) out[c] = input[c]
  }
  // `UTC` in a write is someone's choice; the column default is what no write ever touched.
  if (typeof out.timezone === "string") out.timezone = normalizeIssuerTimezone(out.timezone)
  return out
}

/** A zone is checked against the host's table when it is saved, never first at issue time. */
async function checkWrittenTimezone(
  ctx: MutationsCtx,
  input: Record<string, unknown>,
): Promise<ErrorEnvelope | null> {
  return typeof input.timezone === "string" ? checkIssuerTimezone(ctx, input.timezone) : null
}

/** Columns whose change redirects money or loosens a control (payout bank details, approval
 *  thresholds, two-eyes, auto-email, send-from mailbox). The tools are `gated`, so an agent
 *  caller always parks an approval card (see summarizeIssuerProfileChange); this list drives
 *  the audit event's `sensitive_fields`. */
export const ISSUER_SENSITIVE_COLUMNS: ReadonlyArray<string> = [
  "iban",
  "swift_bic",
  "bank_name",
  "invoice_approval_threshold_minor",
  "po_approval_threshold_minor",
  "require_two_eyes",
  "auto_email_enabled",
  "mail_account_id",
]

/** The scope that may change the bank and control fields above, or delete a profile (which takes
 *  its bank and control settings with it). Held by the admin role (`*`) and grantable to any role;
 *  it is not part of a member tier. */
export const ISSUER_ADMIN_SCOPE = "invoicing:issuer:admin"

/** A form round-trips unset text as "" and numbers as strings: compare on the stored meaning. */
function sameIssuerValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === "" ? null : auditValue(v))
  return norm(a) === norm(b)
}

/** The sensitive columns this write actually sets: on create, every one given a value (a false
 *  toggle or an empty field is the default, not a change); on update, every one whose value
 *  differs from the stored row, so a form that resends unchanged bank details is not refused. */
function sensitiveColumnsTouched(
  data: Record<string, unknown>,
  before: Record<string, unknown> | null,
): string[] {
  return ISSUER_SENSITIVE_COLUMNS.filter((c) => {
    if (!(c in data)) return false
    if (before) return !sameIssuerValue(before[c] ?? null, data[c] ?? null)
    const v = data[c]
    return v !== null && v !== undefined && v !== "" && v !== false
  })
}

function issuerAdminRequired(what: string): ErrorEnvelope {
  return {
    status: "error",
    error: {
      code: "forbidden",
      message:
        `${what} needs the ${ISSUER_ADMIN_SCOPE} scope (held by admins, grantable to a role). ` +
        "Ask an administrator to make this change.",
    },
  }
}

/** Refuse unless the caller holds ISSUER_ADMIN_SCOPE. No scope check on the ctx (a caller outside
 *  the kernel bridge) refuses: the default is the safe side. */
async function holdsIssuerAdmin(ctx: MutationsCtx): Promise<boolean> {
  return typeof ctx.hasScope === "function" ? (await ctx.hasScope(ISSUER_ADMIN_SCOPE)) === true : false
}

/** The authority check shared by the handlers and their stage-time preflights, so an agent call
 *  that would be refused never parks an approval card first. */
async function checkIssuerWriteAuthority(
  ctx: MutationsCtx,
  action: "create" | "update" | "delete",
  input: Record<string, unknown>,
): Promise<ErrorEnvelope | null> {
  if (action === "delete") {
    return (await holdsIssuerAdmin(ctx)) ? null : issuerAdminRequired("Deleting an issuer profile")
  }
  const data = pickIssuerWrite(input)
  const before =
    action === "update" && input.id
      ? ((await ctx.db.findOne("issuer_profiles", String(input.id))) as Record<string, unknown> | null)
      : null
  const touched = sensitiveColumnsTouched(data, action === "update" ? (before ?? {}) : null)
  if (touched.length === 0 || (await holdsIssuerAdmin(ctx))) return null
  return issuerAdminRequired(`Changing ${touched.join(", ")}`)
}

/** Stage-time preflight for the three issuer-profile write tools. */
export async function settingsIssuerProfileWritePreflight(
  ctx: MutationsCtx,
  action: "create" | "update" | "delete",
  input: Record<string, unknown>,
): Promise<PreflightResult> {
  const refused =
    (await checkIssuerWriteAuthority(ctx, action, input ?? {})) ??
    (action === "delete" ? null : await checkWrittenTimezone(ctx, input ?? {}))
  return refused ? { error: refused.error } : { ok: true }
}

/** Audit-timeline value: bigint-safe, bounded, JSON-stored columns reduced to a marker. */
function auditValue(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === "bigint") return v.toString()
  if (typeof v === "object") return "[json]"
  return String(v).slice(0, 200)
}

/** Record who changed which issuer-profile columns (old -> new) on the audit timeline. */
async function emitIssuerProfileChange(
  ctx: MutationsCtx,
  action: "created" | "updated" | "deleted",
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const c of Object.keys(after)) {
    const from = before?.[c] ?? null
    const to = after[c] ?? null
    if (before && auditValue(from) === auditValue(to)) continue
    changes[c] = { from: auditValue(from), to: auditValue(to) }
  }
  if (action === "updated" && Object.keys(changes).length === 0) return
  await ctx.emit({
    entity: "issuer_profile",
    action,
    entityId: id,
    data: {
      issuer_profile_id: id,
      legal_name: String(after.legal_name ?? before?.legal_name ?? ""),
      changed_fields: Object.keys(changes),
      sensitive_fields: Object.keys(changes).filter((c) => ISSUER_SENSITIVE_COLUMNS.includes(c)),
      changes,
    },
  })
}

export async function settingsIssuerProfileCreate(
  ctx: MutationsCtx,
  input: Record<string, unknown>,
): Promise<MutationResult<{ id: string }>> {
  const data = pickIssuerWrite(input)
  if (!data.legal_name || !data.country) {
    return {
      status: "error",
      error: { code: "invalid_params", message: "legal_name and country are required" },
    }
  }
  const refused =
    (await checkIssuerWriteAuthority(ctx, "create", input)) ?? (await checkWrittenTimezone(ctx, input))
  if (refused) return refused
  const row = (await ctx.db.insert("issuer_profiles", data)) as Record<string, unknown>
  await emitIssuerProfileChange(ctx, "created", String(row.id), null, data)
  return { status: "completed", id: String(row.id) }
}

export async function settingsIssuerProfileUpdate(
  ctx: MutationsCtx,
  input: Record<string, unknown> & { id?: string },
): Promise<MutationResult<{ id: string }>> {
  const id = input?.id ? String(input.id) : ""
  if (!id) {
    return { status: "error", error: { code: "invalid_params", message: "id is required" } }
  }
  // Guard the empty-update case: an update with NO writable fields (only `{id}`) makes
  // ctx.db.update emit an empty SET clause, which the driver rejects with an opaque HTTP 500.
  // Return a clean, actionable error instead — naming the writable columns — so a no-op call
  // (a weak agent issuing `settings_issuer_profile_update({id})` to "ensure" settings) fails
  // loudly and instructively rather than crashing the request.
  const data = pickIssuerWrite(input)
  if (Object.keys(data).length === 0) {
    return {
      status: "error",
      error: {
        code: "invalid_params",
        message:
          "No updatable fields provided. Pass at least one issuer-profile field to change " +
          `(one of: ${ISSUER_WRITE_COLUMNS.join(", ")}). To read the current profile without ` +
          "changing it, use settings_issuer_profile_list.",
      },
    }
  }
  const refused =
    (await checkIssuerWriteAuthority(ctx, "update", input)) ?? (await checkWrittenTimezone(ctx, input))
  if (refused) return refused
  const before = (await ctx.db.findOne("issuer_profiles", id)) as Record<string, unknown> | null
  await ctx.db.update("issuer_profiles", id, data)
  await emitIssuerProfileChange(ctx, "updated", id, before, data)
  return { status: "completed", id }
}

export async function settingsIssuerProfileDelete(
  ctx: MutationsCtx,
  input: { id: string },
): Promise<MutationResult<{ id: string }>> {
  const id = input?.id ? String(input.id) : ""
  if (!id) {
    return { status: "error", error: { code: "invalid_params", message: "id is required" } }
  }
  const refused = await checkIssuerWriteAuthority(ctx, "delete", input)
  if (refused) return refused
  const before = (await ctx.db.findOne("issuer_profiles", id)) as Record<string, unknown> | null
  await ctx.db.delete("issuer_profiles", id)
  await emitIssuerProfileChange(ctx, "deleted", id, before, { legal_name: before?.legal_name })
  return { status: "completed", id }
}
