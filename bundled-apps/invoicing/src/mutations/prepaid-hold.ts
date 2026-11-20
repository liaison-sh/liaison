// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A prepaid retainer makes two documents around each month end: the next month's advance and this
// month's final. Home shows at most one money item per project and month, so a prepaid retainer's
// project has one issue approval waiting at a time: a second draft holds its approval (marked
// `issue_held` on the draft) until the first is issued or discarded, or its approval is turned
// down or runs out, and is raised then: at once on an issue or a discard, by the hourly draft job
// otherwise. Best effort, never throws: a draft whose approval could not be raised keeps its mark,
// so the next hour tries again, and stays a draft to issue from its page.

import { formatMoneyMinor } from "../money"
import { isRetainerSchedule } from "../recurring/retainer"
import { raiseIssueApproval } from "./billing-plan"
import type { MutationsCtx } from "./shared"

type Row = Record<string, unknown>
type Ctx = MutationsCtx & { logger?: { warn?: (m: string, d?: Row) => void } }

const asJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/** The project's draft whose issue approval is waiting, other than `draftId`, or null. */
async function waitingDraftOf(ctx: Ctx, projectId: string, draftId: string): Promise<Row | null> {
  const pendingFor = ctx.approvals?.pendingFor
  if (!pendingFor) return null
  try {
    const raw = asJson(await pendingFor("draft_id", ["invoicing:invoice_issue"]))
    const rows = (Array.isArray(raw) ? raw : []) as Array<{ target_id?: unknown }>
    for (const r of rows) {
      if (typeof r.target_id !== "string" || r.target_id === draftId) continue
      const doc = (await ctx.db.findOne("documents", r.target_id)) as Row | null
      if (doc && doc.billing_project_id === projectId && String(doc.status) === "draft") return doc
    }
  } catch {
    return null
  }
  return null
}

const titleOf = (doc: Row): string => {
  const month =
    typeof doc.service_period_start === "string" ? doc.service_period_start.slice(0, 7) : ""
  const what = doc.invoice_role === "advance" ? "Advance invoice draft" : "Retainer invoice draft"
  return month ? `${what}, ${month}` : what
}

/**
 * Raise a prepaid retainer draft's issue approval unless another draft of its project already
 * waits on one; `heldBy` names that draft when it does.
 */
export async function raiseOnePerProject(
  ctx: Ctx,
  projectId: string,
  draftId: string,
  title: string,
  lines: string[],
  latestIssueOn?: string | null,
): Promise<{ approvalId: string | null; heldBy: { id: string; title: string } | null }> {
  const waiting = await waitingDraftOf(ctx, projectId, draftId)
  if (waiting) {
    await markHeld(ctx, draftId, true)
    return { approvalId: null, heldBy: { id: String(waiting.id), title: titleOf(waiting) } }
  }
  return {
    approvalId: await raiseIssueApproval(ctx, draftId, title, lines, latestIssueOn),
    heldBy: null,
  }
}

const refsOf = (doc: Row | null): Row => {
  const refs = asJson(doc?.external_refs)
  return refs && typeof refs === "object" && !Array.isArray(refs) ? (refs as Row) : {}
}

/** Mark a draft as holding its issue approval, or clear the mark once it is raised. */
async function markHeld(ctx: Ctx, draftId: string, held: boolean): Promise<void> {
  const doc = (await ctx.db.findOne("documents", draftId)) as Row | null
  if (!doc) return
  const { issue_held: _was, ...rest } = refsOf(doc)
  await ctx.db.update("documents", draftId, {
    external_refs: held ? { ...rest, issue_held: true } : rest,
  })
}

/** A draft's latest issue day, as its row stores it, or null. */
const latestIssueOf = (doc: Row): string | null => {
  const v = doc.latest_issue_on
  if (typeof v === "string" && v !== "") return v.slice(0, 10)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return null
}

/** The result's words for a held approval. */
export function heldText(heldBy: { id: string; title: string }): string {
  return `Its issue approval waits until ${heldBy.title} (draft ${heldBy.id}) is issued or discarded, or its approval is turned down or runs out, so the project has one invoice to approve at a time; it is raised then.`
}

/**
 * After a draft of a prepaid retainer's project was issued or discarded, or when no draft of the
 * project waits on an approval any more: raise the issue approval the project's next held draft
 * held, the earliest month first. A draft whose own approval was turned down is not held, so it is
 * never asked again by itself.
 */
export async function raiseHeldApproval(
  ctx: Ctx,
  gone: { id: string; billing_project_id?: unknown },
): Promise<void> {
  try {
    const projectId = typeof gone.billing_project_id === "string" ? gone.billing_project_id : ""
    if (!projectId) return
    const schedules = (await ctx.db.findMany("recurring_schedules", {
      where: { retainer_project_id: projectId },
      limit: 20,
    })) as Row[]
    const prepaid = schedules.some(
      (s) => s.status !== "ended" && isRetainerSchedule(s) && s.covers === "period_ahead",
    )
    if (!prepaid) return
    if (await waitingDraftOf(ctx, projectId, String(gone.id))) return
    const drafts = (
      (await ctx.db.findMany("documents", {
        where: { billing_project_id: projectId, status: "draft" },
        limit: 50,
      })) as Row[]
    )
      .filter((d) => d.id !== gone.id)
      .filter((d) => /^(advance|retainer):/.test(String(d.external_ref ?? "")))
      .filter((d) => refsOf(d).issue_held === true)
      .sort((a, b) =>
        String(a.service_period_start ?? "").localeCompare(String(b.service_period_start ?? "")),
      )
    const next = drafts[0]
    if (!next) return
    const lines = (await ctx.db.findMany("document_lines", {
      where: { document_id: String(next.id) },
      limit: 200,
    })) as Row[]
    const excl = lines.reduce(
      (a, l) => a + Math.round(Number(l.quantity ?? 0) * Number(l.unit_price_minor ?? 0)),
      0,
    )
    const currency = String(next.currency ?? "EUR")
    const approvalId = await raiseIssueApproval(
      ctx,
      String(next.id),
      titleOf(next),
      [
        `${formatMoneyMinor(BigInt(excl), currency)} excl. VAT`,
        "It waited until the project's previous invoice was settled",
      ],
      latestIssueOf(next),
    )
    if (approvalId) await markHeld(ctx, String(next.id), false)
  } catch (err) {
    ctx.logger?.warn?.("raising a held issue approval failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * The hourly pass: each prepaid retainer's project whose drafts wait on no approval (the one that
 * did was turned down or ran out) gets its held draft's approval raised.
 */
export async function raiseHeldApprovals(ctx: Ctx): Promise<number> {
  let raised = 0
  try {
    const schedules = (await ctx.db.findMany("recurring_schedules", {
      where: { covers: "period_ahead" },
      limit: 500,
    })) as Row[]
    const projects = new Set(
      schedules
        .filter((s) => s.status !== "ended" && isRetainerSchedule(s))
        .map((s) => s.retainer_project_id)
        .filter((p): p is string => typeof p === "string" && p !== ""),
    )
    for (const projectId of projects) {
      const held = (
        (await ctx.db.findMany("documents", {
          where: { billing_project_id: projectId, status: "draft" },
          limit: 50,
        })) as Row[]
      ).some((d) => refsOf(d).issue_held === true)
      if (!held) continue
      await raiseHeldApproval(ctx, { id: "", billing_project_id: projectId })
      raised += 1
    }
  } catch (err) {
    ctx.logger?.warn?.("the hourly pass over held issue approvals failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return raised
}
