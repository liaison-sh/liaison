// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The company timeline's Agreements source (`activitySources`): one row per agreement of the
// company, or of one of its people, change requests included, at its latest status and never
// a draft. The row is the number and the status, with no price and no signer: it never reads
// signature events (another scope). Rows the caller cannot see never come back (row security).

import type { AgreementsCtx } from "./ctx"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LIMIT_MAX = 100

interface ActivityInput {
  contactIds?: unknown
  companyId?: unknown
  before?: { at?: unknown; id?: unknown } | null
  limit?: unknown
  prefix?: unknown
}

interface TimelineAgreement {
  id: string
  number: string
  status: string
  kind?: string | null
  company_id?: string | null
  contact_id?: string | null
  signed_at?: string | null
  updated_at?: string | null
  created_at?: string | null
}

const STATUS_WORD: Record<string, string> = {
  sent: "sent",
  partly_signed: "partly signed",
  signed: "signed",
  declined: "declined",
  expired: "expired",
  voided: "voided",
  imported: "imported",
  accepted: "accepted",
}

function iso(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export async function activityRead(ctx: AgreementsCtx, p: ActivityInput) {
  const companyId = typeof p?.companyId === "string" && UUID.test(p.companyId) ? p.companyId : null
  const contactIds = Array.isArray(p?.contactIds)
    ? p.contactIds.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 200)
    : []
  const limit = Math.min(Math.max(Number(p?.limit) || 30, 1), LIMIT_MAX)
  const prefix = typeof p?.prefix === "string" ? p.prefix : "agreements:"
  if (!companyId && contactIds.length === 0) return { rows: [] }

  const found = new Map<string, TimelineAgreement>()
  const reads: Array<Record<string, unknown>> = []
  if (companyId) reads.push({ company_id: companyId })
  if (contactIds.length > 0) reads.push({ contact_id: { in: contactIds } })
  for (const where of reads) {
    const rows = (await ctx.db.findMany("agreements", { where, limit: 500 })) as TimelineAgreement[]
    for (const r of rows) found.set(r.id, r)
  }

  const beforeAt = iso(p?.before?.at)
  const beforeId = typeof p?.before?.id === "string" ? p.before.id : ""
  const rows = [...found.values()]
    .filter((a) => a.status !== "draft")
    .map((a) => {
      const at = iso(a.signed_at) ?? iso(a.updated_at) ?? iso(a.created_at)
      const word = STATUS_WORD[a.status] ?? a.status
      return {
        id: a.id,
        at,
        title: `${a.number} ${word}`,
        who: null,
        contactId: a.contact_id ?? null,
        href: { app: "agreements", entityType: "agreement", entityId: a.id },
      }
    })
    .filter((r): r is typeof r & { at: string } => r.at !== null)
    // Strictly older than the cursor in (at, id) order, ids compared with the source prefix.
    .filter(
      (r) => !beforeAt || r.at < beforeAt || (r.at === beforeAt && `${prefix}${r.id}` < beforeId),
    )
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    .slice(0, limit)
  return { rows }
}
