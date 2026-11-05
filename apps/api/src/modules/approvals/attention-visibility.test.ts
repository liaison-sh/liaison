// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (reported 2026-08-06): three pending kernel:update_skill approvals
// were returned by approvals_list yet invisible in EVERY attention feed. Two
// independent filters each dropped one person, which is why it looked like the
// rows simply did not exist.

import { describe, expect, it } from "bun:test"
import { canSeeApprovalInFeed } from "~/modules/approvals/attention"

const SKILL_APPROVAL = {
  tool_name: "kernel:update_skill",
  // Skill approvals decide under a DIMENSION-CONSTRAINED scope, not <app>:approve.
  approve_scope: "kernel:skills:approve",
  resource_owner_id: null,
  notify_user_ids: ["requester-1"],
  requested_by: "requester-1",
}

describe("attention feed approval visibility", () => {
  // The bug for the C-Level approver: the feed asked for `kernel:approve`
  // (recomputed from the tool name) instead of the row's real scope, and
  // kernel:approve is admin-grade and deliberately not granted to C-Level.
  it("shows it to the notified decider holding the row's approve_scope, not kernel:approve", () => {
    const notifiedDecider = { ...SKILL_APPROVAL, notify_user_ids: ["decider-1"] }
    expect(canSeeApprovalInFeed(notifiedDecider, "decider-1", ["kernel:skills:approve"])).toBe(true)
    // The regression: the old code asked for kernel:approve and refused them.
    expect(canSeeApprovalInFeed(notifiedDecider, "decider-1", ["kernel:approve"])).toBe(false)
  })

  // The audience gate stays as designed: a decider who was never notified does
  // NOT get the row. Widening it would put every ticket reply in every
  // tickets:approve holder's feed. Taylor not seeing this approval is a
  // ROUTING question (who gets notified), not the rendering bug.
  it("does NOT show it to a decider who was never notified", () => {
    expect(canSeeApprovalInFeed(SKILL_APPROVAL, "admin-1", ["*"])).toBe(false)
  })

  it("hides it from a notified user who cannot decide it", () => {
    expect(canSeeApprovalInFeed(SKILL_APPROVAL, "requester-1", [])).toBe(false)
  })

  it("hides it from someone with neither the scope nor a notification", () => {
    expect(canSeeApprovalInFeed(SKILL_APPROVAL, "bystander-1", ["tickets:approve"])).toBe(false)
  })

  // Privacy must still beat scope: an ownership-routed approval is the owner's.
  it("keeps an ownership-routed approval private to its owner", () => {
    // Ownership routing notifies the owner, so a realistic row lists them.
    const owned = {
      ...SKILL_APPROVAL,
      resource_owner_id: "owner-1",
      notify_user_ids: ["owner-1"],
    }
    // Privacy beats scope: holding the decide scope is not enough.
    expect(canSeeApprovalInFeed(owned, "decider-1", ["kernel:skills:approve"])).toBe(false)
    // Even an admin with `*` must not see someone else's owner-routed approval.
    expect(canSeeApprovalInFeed(owned, "admin-1", ["*"])).toBe(false)
    expect(canSeeApprovalInFeed(owned, "owner-1", ["kernel:skills:approve"])).toBe(true)
  })

  // An ordinary approval with no custom scope keeps the derived default.
  it("falls back to <app>:approve when the row declares no scope", () => {
    const plain = {
      tool_name: "tickets:reply",
      approve_scope: null,
      resource_owner_id: null,
      notify_user_ids: [],
      requested_by: "someone-else",
    }
    const plainNotified = { ...plain, notify_user_ids: ["u"] }
    expect(canSeeApprovalInFeed(plainNotified, "u", ["tickets:approve"])).toBe(true)
    expect(canSeeApprovalInFeed(plainNotified, "u", ["boxtal:approve"])).toBe(false)
  })
})
