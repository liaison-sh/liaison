// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Consent-join enforcement at the HANDLER level (SC 8, section 5.4). Buyer
// audiences require purchase-time ad_consent from commerce.purchase_
// attribution (joined by email); newsletter audiences require subscribers.
// marketing_consent. Both read via the `database` app cross-app (section
// 2.2) -- the same hub-DB path as the metrics input layer. DEFAULT-DENY: an
// email with no consent record, or whose consent source cannot be reached
// at all, is dropped -- never uploaded. Consent domains never cross (buyer
// consent does not authorize a newsletter upload and vice versa).

export interface CustomerIdentifier {
  email?: string | null
}

export interface ConsentJoinResult<T extends CustomerIdentifier> {
  allowed: T[]
  /** Emails with a consent record present but denied/false. */
  droppedNoConsent: number
  /** Emails with NO consent record at all (fail-closed, not merely denied). */
  droppedNoConsentSource: number
  /** True when the consent source itself could not be reached for ANY lookup -- everything drops. */
  sourceUnreachable: boolean
}

interface ConsentJoinCtx {
  executeTool?: (target: string, args: Record<string, unknown>) => Promise<{
    status: "completed" | "pending_approval" | "error"
    result?: unknown
    error?: { code: string; message: string; retryable?: boolean }
  }>
}

type ConsentCheck = "granted" | "denied" | "no_source" | "unreachable"

/** Per readName, the db_query fallback SELECT + params builder used when the curated db_read errors (§2.2 sanctioned fallback, mirrored from metrics/inputs.ts's gatherAttributionRows). */
const DB_QUERY_FALLBACK: Record<string, (email: string) => { sql: string; params: unknown[] }> = {
  purchase_attribution_by_email: (email) => ({
    // buyer_email exists from hub migration 0015 (lowercased at insert,
    // nulled on GDPR erasure); case-insensitive match to be safe.
    sql: "SELECT ad_consent FROM commerce.purchase_attribution WHERE lower(buyer_email) = lower($1) ORDER BY created_at DESC LIMIT 1",
    params: [email],
  }),
  subscribers_marketing_consent: (email) => ({
    // marketing_consent is a COLUMN on public.subscribers, not a schema.table.
    sql: "SELECT marketing_consent FROM public.subscribers WHERE lower(email) = lower($1)",
    params: [email],
  }),
}

async function checkConsent(
  ctx: ConsentJoinCtx,
  readName: string,
  email: string,
  isGranted: (row: Record<string, unknown>) => boolean,
): Promise<ConsentCheck> {
  if (!ctx.executeTool) return "unreachable"

  async function evaluate(rows: unknown): Promise<ConsentCheck> {
    const arr = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
    if (arr.length === 0) return "no_source"
    return isGranted(arr[0]!) ? "granted" : "denied"
  }

  try {
    const envelope = await ctx.executeTool("database:db_read", { name: readName, params: { email } })
    if (envelope.status === "completed") {
      return evaluate(envelope.result)
    }
    // envelope.status is "error" or "pending_approval" -- fall through to the
    // db_query fallback (§2.2 sanctioned pattern) before giving up as
    // unreachable. A curated read missing from the hub catalog (not yet
    // provisioned) should not fail-closed an entire consent-join when a
    // parameterized SELECT can answer the same question.
  } catch {
    // fall through to fallback
  }

  const buildFallback = DB_QUERY_FALLBACK[readName]
  if (!buildFallback) return "unreachable"

  try {
    const { sql, params } = buildFallback(email)
    const fallback = await ctx.executeTool("database:db_query", { sql, params })
    if (fallback.status !== "completed") {
      // Distinguish "no record for this email" from "the source itself is
      // broken" is not reliably possible from the envelope alone in every
      // deployment, so any error from BOTH the curated read and the db_query
      // fallback is treated as unreachable -- fail-closed is the safe
      // direction either way.
      return "unreachable"
    }
    return evaluate(fallback.result)
  } catch {
    return "unreachable"
  }
}

async function joinConsent<T extends CustomerIdentifier>(
  customers: T[],
  ctx: ConsentJoinCtx,
  readName: string,
  isGranted: (row: Record<string, unknown>) => boolean,
): Promise<ConsentJoinResult<T>> {
  const withEmail = customers.filter((c): c is T & { email: string } => typeof c.email === "string" && c.email.length > 0)
  // Customers with NO email (e.g. phone-only identifiers) have no joinable
  // consent record at all under this email-keyed join — default-deny drops
  // them too (counted as "no consent source", never silently passed
  // through un-joined).
  const noEmailCount = customers.length - withEmail.length

  const allowed: T[] = []
  let droppedNoConsent = 0
  let droppedNoConsentSource = noEmailCount
  let anyUnreachable = false
  let anyChecked = false

  for (const customer of withEmail) {
    const check = await checkConsent(ctx, readName, customer.email, isGranted)
    anyChecked = true
    if (check === "granted") {
      allowed.push(customer)
    } else if (check === "denied") {
      droppedNoConsent++
    } else if (check === "no_source") {
      droppedNoConsentSource++
    } else {
      anyUnreachable = true
      droppedNoConsentSource++
    }
  }

  // If EVERY lookup came back unreachable (the consent source itself is
  // down, not just "no record"), report sourceUnreachable so the caller can
  // surface a clear connect-error rather than a silent all-denied result.
  // (No-email customers are excluded from this check — they never reach a
  // consent lookup at all, so they can't signal "source unreachable".)
  const sourceUnreachable = anyChecked && anyUnreachable && allowed.length === 0 &&
    droppedNoConsent === 0 && droppedNoConsentSource === withEmail.length + noEmailCount

  return { allowed, droppedNoConsent, droppedNoConsentSource, sourceUnreachable }
}

/**
 * Buyer audience consent-join: keep only emails with a `granted` ad_consent
 * record in commerce.purchase_attribution (joined by email via the hub-DB
 * catalog's consent-by-email read -- see p5-blueprint.md section 2.2 / R1).
 * Newsletter consent does NOT transfer to buyer audiences.
 */
export async function filterByBuyerConsent<T extends CustomerIdentifier>(
  customers: T[],
  ctx: ConsentJoinCtx,
): Promise<ConsentJoinResult<T>> {
  return joinConsent(customers, ctx, "purchase_attribution_by_email", (row) => row.ad_consent === "granted")
}

/**
 * Newsletter audience consent-join: keep only emails with
 * subscribers.marketing_consent === true. Buyer (purchase-time ad) consent
 * does NOT transfer to newsletter audiences.
 */
export async function filterByNewsletterConsent<T extends CustomerIdentifier>(
  customers: T[],
  ctx: ConsentJoinCtx,
): Promise<ConsentJoinResult<T>> {
  return joinConsent(customers, ctx, "subscribers_marketing_consent", (row) => row.marketing_consent === true)
}
