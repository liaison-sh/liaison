// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily legal-date job of month-end runs. A run issues no later than its last issue day (the
// billing month's last day, in the issuer's time zone), so an undecided run is pushed up as that
// day nears: three days before, its line rises to the top; on the day, the card says it ends
// today; the day after, the run is late, the line stays, and nothing issues by itself: one new card
// marked Late asks what to do with each row, whatever was open on the run before. It is followed
// while it waits, staged again when it expired, and left alone once a person rejected it (a change
// of a row asks again). A rejected card also lands here: its drafts stay drafts until the issue job
// asks again.
import {
  approvalStatus,
  approvedLateOn,
  cardOf,
  dayOf,
  endHold,
  type Row,
  type RunCtx,
  runItems,
  stageRunCard,
} from "./run-card"
import { addDays } from "./schedule"

export type Urgency = "normal" | "rising" | "ends_today" | "late"

/** How pressing an undecided run is on `today`, both sides of its last issue day. */
export function urgencyOf(today: string, lastDay: string): Urgency {
  if (today > lastDay) return "late"
  if (today === lastDay) return "ends_today"
  if (today >= addDays(lastDay, -3)) return "rising"
  return "normal"
}

const OPEN = ["drafted", "rejected", "approved", "issuing", "partial", "late"]

/** How long a run approved after its last day may take to issue before it is late again, in days. */
const LATE_ISSUE_DAYS = 2

/**
 * A late run that never had its late card: marked late by an older build, whose rows may still read
 * approved or failed and whose card, if it has one, was staged before its last day.
 */
const neverAsked = (run: Row): boolean =>
  typeof run.late_card_id !== "string" || run.late_card_id === ""

/**
 * The run's last day passed with rows undecided or not issued: it is late. A row approved in time
 * and not issued is not issued by itself any more, and the card it had is replaced by a late one.
 */
async function markLate(ctx: RunCtx, run: Row): Promise<void> {
  const runId = String(run.id)
  for (const item of await runItems(ctx, runId)) {
    if (item.state !== "approved" && item.state !== "failed") continue
    // Only as it was read: a row issued in between is the issue job's.
    await ctx.db.updateMany("recurring_run_items", {
      where: { run_id: runId, document_id: String(item.document_id), state: item.state },
      data: {
        state: "waiting_reapproval",
        approved_hash: null,
        approved_total_minor: null,
        send_grant: null,
      },
    })
  }
  const card = cardOf(run)
  if (card && ctx.approvals?.withdraw)
    await ctx.approvals
      .withdraw(card, "The run's last issue day has passed: its late card replaces this one.")
      .catch(() => null)
  await ctx.db.update("recurring_runs", runId, {
    status: "late",
    approval_request_id: null,
    late_approved_on: null,
  })
}

export async function recurringLegalDateJob(
  ctx: RunCtx,
): Promise<{ status: "ok"; runs: Array<{ run_id: string; urgency: Urgency }> }> {
  const runs = (await ctx.db.findMany("recurring_runs", {
    where: { status: { in: OPEN } },
    orderBy: { issue_on: "asc" },
    limit: 200,
  })) as Row[]
  const out: Array<{ run_id: string; urgency: Urgency }> = []
  if (runs.length > 0) await endHold(ctx, "recurring-legal-date")
  for (const run of runs) {
    const runId = String(run.id)
    const issuer = (await ctx.db.findOne(
      "issuer_profiles",
      String(run.issuer_profile_id),
    )) as Row | null
    if (!issuer) continue
    const now = await ctx.time.civil({ timezone: String(issuer.timezone || "UTC") })
    let status = String(run.status)
    // A card denied or expired leaves the drafts as they are; the issue job stages a new one.
    if (
      status === "drafted" &&
      typeof run.approval_request_id === "string" &&
      run.approval_request_id !== "staging"
    ) {
      const decided = await approvalStatus(ctx, run.approval_request_id)
      if (decided === "denied" || decided === "expired" || decided === "cancelled") {
        await ctx.db.update("recurring_runs", runId, { status: "rejected" })
        status = "rejected"
      }
    }
    if (status === "approved" || status === "issuing" || status === "partial") {
      // Approved runs issue by themselves; only a run past its last day still owes something.
      if (now.date <= (dayOf(run.latest_issue_on) as string)) continue
      const approvedLate = approvedLateOn(run)
      if (approvedLate && now.date <= addDays(approvedLate, LATE_ISSUE_DAYS)) continue
      const items = await runItems(ctx, runId)
      if (items.every((i) => i.state === "issued" || i.state === "left_out")) continue
    }
    const urgency = urgencyOf(now.date, dayOf(run.latest_issue_on) as string)
    if (urgency === "late") {
      if (status !== "late" || neverAsked(run)) await markLate(ctx, run)
      const late = (await ctx.db.findOne("recurring_runs", runId)) as Row
      const card = cardOf(late)
      const decided = card ? await approvalStatus(ctx, card) : null
      if (decided !== "denied") await stageRunCard(ctx, runId)
      // Nothing left to decide: the run closed instead.
      if (((await ctx.db.findOne("recurring_runs", runId)) as Row).status !== "late") continue
    }
    if (urgency === "normal") continue
    out.push({ run_id: runId, urgency })
    if (ctx.emit) {
      await ctx.emit({
        entity: "recurring_run",
        action: urgency === "late" ? "late" : "due",
        entityId: runId,
        data: {
          run_id: runId,
          urgency,
          issue_on: dayOf(run.issue_on),
          latest_issue_on: dayOf(run.latest_issue_on),
          period: run.period_label,
          // The card says the last issue day: the row repeats no date, only that the day has come.
          when:
            urgency === "ends_today" ? "waits for approval and ends today" : "waits for approval",
          resolved: false,
        },
      })
    }
  }
  return { status: "ok", runs: out }
}
