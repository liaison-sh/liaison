// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { withSystemDb } from "~/db/privileged"
import { approvalPolicies } from "~/db/schema/kernel"
import { composeGate, evaluateApprovalPolicy } from "~/modules/approvals/approval-policy"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
  const u = await minimal.orgAdmin((await createTestOrg()).id)
  orgId = u.orgId
  userId = u.id
  await withSystemDb("t", (db) =>
    db.insert(approvalPolicies).values([
      {
        orgId,
        toolName: "shopify:refund",
        enabled: true,
        // refund over €200 (amount_minor >= 20000) → require a 2nd approver.
        conditions: [{ path: "params.amount_minor", op: "gte", value: 20000 }],
        requireApproval: true,
        minApprovers: 2,
        createdBy: userId,
      },
      {
        orgId,
        toolName: "invoicing:credit_note",
        enabled: true,
        // every credit note → require a 2nd approver (no conditions = always).
        conditions: [],
        requireApproval: true,
        minApprovers: 2,
        createdBy: userId,
      },
    ]),
  )
})
afterAll(async () => {
  await releaseTestLock()
})

describe("evaluateApprovalPolicy — condition matching", () => {
  test("a €250 refund matches the >€200 policy → requires 2 approvers", async () => {
    const r = await evaluateApprovalPolicy({
      orgId,
      toolName: "shopify:refund",
      appName: "shopify",
      params: { amount_minor: 25000 },
    })
    expect(r.requireApproval).toBe(true)
    expect(r.minApprovers).toBe(2)
    expect(r.policyId).toBeDefined()
  })

  test("a €150 refund does NOT match the >€200 policy → no escalation", async () => {
    const r = await evaluateApprovalPolicy({
      orgId,
      toolName: "shopify:refund",
      appName: "shopify",
      params: { amount_minor: 15000 },
    })
    expect(r.requireApproval).toBe(false)
    expect(r.minApprovers).toBe(1)
  })

  test("every credit note matches the unconditional policy → 2 approvers", async () => {
    const r = await evaluateApprovalPolicy({
      orgId,
      toolName: "invoicing:credit_note",
      appName: "invoicing",
      params: { id: "cn-1" },
    })
    expect(r.requireApproval).toBe(true)
    expect(r.minApprovers).toBe(2)
  })

  test("an unrelated tool with no policy is unaffected", async () => {
    const r = await evaluateApprovalPolicy({
      orgId,
      toolName: "tickets:reply",
      appName: "tickets",
      params: { body: "hi" },
    })
    expect(r.requireApproval).toBe(false)
    expect(r.minApprovers).toBe(1)
  })
})

describe("composeGate — TIGHTEN-ONLY MAX semantics (security core)", () => {
  test("escalates a NON-gated action to gated when the policy requires approval", () => {
    const c = composeGate(
      { gated: false, minApprovers: 1 },
      { requireApproval: true, minApprovers: 1, policyId: "p1", reason: "r" },
    )
    expect(c.gated).toBe(true)
    expect(c.escalated).toBe(true)
  })

  test("raises a 1-approver gated action to N-eyes", () => {
    const c = composeGate(
      { gated: true, minApprovers: 1 },
      { requireApproval: true, minApprovers: 2, policyId: "p1", reason: "r" },
    )
    expect(c.gated).toBe(true)
    expect(c.minApprovers).toBe(2)
    expect(c.escalated).toBe(true)
  })

  test("⛔ a policy can NEVER un-gate a built-in gated action (MAX, never loosen)", () => {
    // A malicious/misconfigured policy demanding require_approval:false MUST NOT
    // turn off a built-in gate. The gate stays on; nothing is escalated/loosened.
    const c = composeGate(
      { gated: true, minApprovers: 1 },
      { requireApproval: false, minApprovers: 0, policyId: "p1", reason: "r" },
    )
    expect(c.gated).toBe(true) // built-in gate survives — NEVER loosened
    expect(c.minApprovers).toBe(1) // floor never dips below the built-in default
    expect(c.escalated).toBe(false)
  })

  test("⛔ a policy can NEVER lower min_approvers below the built-in floor", () => {
    const c = composeGate(
      { gated: true, minApprovers: 3 },
      { requireApproval: true, minApprovers: 1, policyId: "p1", reason: "r" },
    )
    expect(c.minApprovers).toBe(3) // MAX(3, 1) = 3 — policy cannot lower it
    expect(c.escalated).toBe(false)
  })

  test("a neutral (no-match) decision leaves the built-in gating untouched", () => {
    const c = composeGate(
      { gated: false, minApprovers: 1 },
      { requireApproval: false, minApprovers: 1 },
    )
    expect(c.gated).toBe(false)
    expect(c.minApprovers).toBe(1)
    expect(c.escalated).toBe(false)
  })
})
