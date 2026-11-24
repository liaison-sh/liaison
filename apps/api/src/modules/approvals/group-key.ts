// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH HOME ROW A CARD FOLDS INTO. Home shows the approval cards that belong together as one
// row ("6 approvals: Invoicing: issue invoice", Show all), each card still decided on its own
// (attention.ts `annotateApprovalRunGroups`). Two cards belong together when:
//
//   1. the same run staged them (the routine run, else the root of the agent run): `run:<id>`;
//   2. otherwise, no run behind them (a person's own calls, a scheduled job, an event handler),
//      they ask the same people for the same action of the same app on the same business day in
//      the org's zone: `batch:<decision scope>|<owner>|<tool>|<day>`.
//
// The run comes first: a run's cards stay one row even across days. A bundle step never groups
// (its head stands for the bundle), and a bundle head without a run stays its own row (its steps
// make it a different action). Pure, so the QA harness reads the same rule.

import { decidingScopeOfRow } from "@liaison/shared"

/** The facts of an approval row the key is made from. */
export interface ApprovalGroupSource {
  id: string
  bundle_id: string | null
  tool_name: string
  /** The row's own decision scope; null reads as `<app>:approve`, as the gate does. */
  approve_scope: string | null
  /** An ownership-routed row: only this person decides it. */
  resource_owner_id: string | null
  created_at: Date | string
  metadata: { originRoutineRunId?: unknown; originRootRunId?: unknown } | null
}

/** The calendar day `at` falls on in `zone` (YYYY-MM-DD); UTC for a zone the runtime rejects. */
export function civilDayIn(at: Date | string, zone: string): string {
  const d = at instanceof Date ? at : new Date(at)
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/**
 * The group a card belongs to (see the head of this file), or null when it stands alone.
 * `zone` is the org's time zone, which sets the business day of a card with no run.
 */
export function approvalRunKey(r: ApprovalGroupSource, zone: string): string | null {
  if (r.bundle_id !== null && r.bundle_id !== r.id) return null
  const run = r.metadata?.originRoutineRunId ?? r.metadata?.originRootRunId
  if (typeof run === "string" && run.length > 0) return `run:${run}`
  if (r.bundle_id !== null) return null
  const audience = `${decidingScopeOfRow(r.tool_name, r.approve_scope)}|${r.resource_owner_id ?? ""}`
  return `batch:${audience}|${r.tool_name}|${civilDayIn(r.created_at, zone)}`
}

/** How a group was formed: one run, or same action and audience on one day. */
export function approvalGroupBasis(key: string): "run" | "batch" {
  return key.startsWith("batch:") ? "batch" : "run"
}
