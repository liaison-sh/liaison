// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  computeSkipGate,
  personRefusalError,
  preflightRequiresPerson,
} from "~/modules/apps/execute-tool"

// computeSkipGate(a) → { skip, autoApprovedByPolicy? }: true ONLY when the
// human-approver bypass holds, OR an auto-approve policy fires AND the params
// carry NO @ref tokens (a sequenced bundle step must always gate).
describe("computeSkipGate auto-approve insertion", () => {
  const base = {
    orgId: "org1",
    toolName: "shopify:refund_create",
    appName: "shopify",
    actor: {
      actorType: "agent" as const,
      userId: "u",
      orgId: "org1",
      scopes: [],
      dimensionGrants: {},
    },
    isDirectHumanCall: false,
    requesterCanApprove: false,
    // Neutral tightening policy (no escalation) so these stay pure unit tests of
    // the auto-approve (loosening) path. The tighten path is covered below.
    evaluatePolicy: async () => ({ requireApproval: false, minApprovers: 1 }),
  }

  test("auto-approves a gated tool when policy approves and no @ref present", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: true,
      validatedParams: { amount: { minor: 4000, currency: "EUR" } },
      evaluate: async () => ({ decision: "auto_approve", policyId: "p1" }),
    })
    expect(r.skip).toBe(true)
    expect(r.autoApprovedByPolicy).toBe("p1")
  })
  // An invoice whose buyer the agent declared a private consumer against the org's business
  // evidence: the invoicing preflight answers { ok: true, noAutoApprove: true }. The org's
  // auto-approve policy on invoice_create_and_issue must not answer it: it stays pending for a person.
  test("a preflight's noAutoApprove keeps an auto-approve policy from answering the call", async () => {
    const policy = async () => ({ decision: "auto_approve" as const, policyId: "p-invoices" })
    const call = {
      ...base,
      toolName: "invoicing:invoice_create_and_issue",
      appName: "invoicing",
      gated: true,
      validatedParams: { buyer_is_consumer: true },
      evaluate: policy,
    }
    const forced = await computeSkipGate({
      ...call,
      noAutoApprove: preflightRequiresPerson({ ok: true, noAutoApprove: true }),
    })
    expect(forced.skip).toBe(false)
    expect(forced.autoApprovedByPolicy).toBeUndefined()
    // A plain preflight pass leaves the policy in charge, and a refusal or junk never forces anything.
    expect(
      (await computeSkipGate({ ...call, noAutoApprove: preflightRequiresPerson({ ok: true }) }))
        .skip,
    ).toBe(true)
    expect(
      preflightRequiresPerson({ error: { code: "x", message: "y" }, noAutoApprove: true }),
    ).toBe(false)
    expect(preflightRequiresPerson(null)).toBe(false)
    // A machine-authorized cross-app hop does not answer it either.
    const hop = await computeSkipGate({
      ...call,
      noAutoApprove: true,
      machineAuthorizedCrossAppCall: true,
      origin: "system",
      callerApp: "shopify",
    })
    expect(hop.skip).toBe(false)
  })

  test("hands the policy the turn's untrusted-content state", async () => {
    let asked: boolean | undefined
    const r = await computeSkipGate({
      ...base,
      gated: true,
      validatedParams: { amount: { minor: 4000, currency: "EUR" } },
      untrustedTurn: async () => true,
      evaluate: async (args) => {
        asked = args.untrustedTurn ? await args.untrustedTurn() : undefined
        return asked
          ? { decision: "gate", reason: "untrusted_content_turn" }
          : { decision: "auto_approve" }
      },
    })
    expect(asked).toBe(true)
    expect(r.skip).toBe(false)
  })
  test("REFUSES auto-approve when params carry a REAL @ref token (sequenced bundle step)", async () => {
    // Valid token per refs.ts: @ref:<UUID-v4>:<lowercase_snake_key>.
    const r = await computeSkipGate({
      ...base,
      gated: true,
      validatedParams: {
        orderId: "@ref:11111111-1111-4111-8111-111111111111:order_id",
        amount: { minor: 1000, currency: "EUR" },
      },
      evaluate: async () => ({ decision: "auto_approve", policyId: "p1" }), // policy WOULD approve
    })
    expect(r.skip).toBe(false) // but a real @ref forces the gate
  })
  test("a MALFORMED @ref-looking string does NOT trip the gate (boundary pinned both ways)", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: true,
      validatedParams: { orderId: "@ref:step1.orderId", amount: { minor: 1000, currency: "EUR" } },
      evaluate: async () => ({ decision: "auto_approve", policyId: "p1" }),
    })
    expect(r.skip).toBe(true) // not a valid token → findRefTokens [] → policy approves
  })
  test("does not auto-approve when policy gates", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: true,
      validatedParams: { amount: { minor: 99999, currency: "EUR" } },
      evaluate: async () => ({ decision: "gate" }),
    })
    expect(r.skip).toBe(false)
  })
  test("a person's own call holding the tool's scopes runs regardless of policy", async () => {
    const r = await computeSkipGate({
      ...base,
      isDirectHumanCall: true,
      personHoldsToolScopes: true,
      requesterCanApprove: false,
      gated: true,
      validatedParams: {},
      evaluate: async () => ({ decision: "gate" }),
    })
    expect(r.skip).toBe(true)
  })
  test("non-gated tool with NO tightening policy is never gated and never consults auto-approve", async () => {
    let consulted = false
    const r = await computeSkipGate({
      ...base,
      gated: false,
      validatedParams: {},
      evaluate: async () => {
        consulted = true
        return { decision: "gate" }
      },
    })
    expect(r.skip).toBe(true)
    expect(r.effectiveGated).toBe(false)
    expect(consulted).toBe(false)
  })
})

// BL-268 — TIGHTEN-ONLY composition at the gate decision. A per-org
// approval-tightening policy can ESCALATE a non-gated action to gated and a
// 1-approver action to N-eyes; it can NEVER loosen.
describe("computeSkipGate tightening-policy insertion (BL-268)", () => {
  const base = {
    orgId: "org1",
    toolName: "shopify:refund",
    appName: "shopify",
    actor: {
      actorType: "agent" as const,
      userId: "u",
      orgId: "org1",
      scopes: [],
      dimensionGrants: {},
    },
    isDirectHumanCall: false,
    requesterCanApprove: false,
    evaluate: async () => ({ decision: "gate" as const }),
  }

  test("a tightening policy ESCALATES a non-gated action → gated (must NOT skip)", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: false, // built-in NOT gated
      validatedParams: { amount_minor: 25000 },
      evaluatePolicy: async () => ({
        requireApproval: true,
        minApprovers: 2,
        policyId: "p1",
        reason: "refund > €200",
      }),
    })
    expect(r.effectiveGated).toBe(true)
    expect(r.minApprovers).toBe(2)
    expect(r.skip).toBe(false)
    expect(r.tightenedByPolicy).toBe("p1")
  })

  test("N-eyes (minApprovers≥2) parks a person's own call instead of running it", async () => {
    const r = await computeSkipGate({
      ...base,
      isDirectHumanCall: true,
      personHoldsToolScopes: true,
      requesterCanApprove: true, // would normally run...
      gated: true,
      validatedParams: { amount_minor: 25000 },
      evaluatePolicy: async () => ({
        requireApproval: true,
        minApprovers: 2,
        policyId: "p1",
        reason: "refund > €200",
      }),
    })
    expect(r.skip).toBe(false) // ...but N-eyes needs a SECOND distinct human
    expect(r.minApprovers).toBe(2)
    // The one case a person's call parks: it is not refused.
    expect(r.personRefusal).toBeUndefined()
  })

  test("N-eyes can NEVER be auto-approved away by a loosening policy", async () => {
    let autoApproveConsulted = false
    const r = await computeSkipGate({
      ...base,
      gated: true,
      validatedParams: { amount_minor: 25000 },
      evaluate: async () => {
        autoApproveConsulted = true
        return { decision: "auto_approve", policyId: "loosen" }
      },
      evaluatePolicy: async () => ({
        requireApproval: true,
        minApprovers: 2,
        policyId: "p1",
        reason: "refund > €200",
      }),
    })
    expect(r.skip).toBe(false) // tighten store wins over loosen store
    expect(autoApproveConsulted).toBe(false) // never even consulted
  })

  test("⛔ a tightening policy can NEVER un-gate a built-in gated action", async () => {
    const r = await computeSkipGate({
      ...base,
      isDirectHumanCall: true,
      personHoldsToolScopes: false,
      requesterCanApprove: false,
      gated: true, // built-in gated
      validatedParams: {},
      // A misconfigured policy claiming no approval needed MUST NOT loosen.
      evaluatePolicy: async () => ({ requireApproval: false, minApprovers: 1 }),
    })
    expect(r.effectiveGated).toBe(true) // built-in gate survives
  })

  test("a non-matching policy leaves a non-gated action open (no false tightening)", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: false,
      validatedParams: { amount_minor: 15000 }, // €150, below the €200 rule
      evaluatePolicy: async () => ({ requireApproval: false, minApprovers: 1 }),
    })
    expect(r.effectiveGated).toBe(false)
    expect(r.skip).toBe(true)
  })
})

// Owner ruling: approvals are for agents, not persons. A person's own direct
// call is decided by the TOOL'S OWN permission: it runs when they hold the
// tool's required scopes and is refused otherwise; the approve scope plays no
// part. It parks only under an org N-eyes policy, and no auto-approve policy
// ever answers it.
describe("computeSkipGate: a person's own call", () => {
  const base = {
    orgId: "org1",
    toolName: "shopify:refund_create",
    appName: "shopify",
    actor: { actorType: "user", userId: "u", orgId: "org1", scopes: ["shopify:refunds:write"] },
    isDirectHumanCall: true,
    gated: true,
    validatedParams: {},
    evaluatePolicy: async () => ({ requireApproval: false, minApprovers: 1 }),
  }

  test("without the tool's own scope: refused, and the auto-approve policy is never consulted", async () => {
    let consulted = false
    const r = await computeSkipGate({
      ...base,
      personHoldsToolScopes: false,
      requesterCanApprove: true, // the approve scope does not rescue it
      evaluate: async () => {
        consulted = true
        return { decision: "auto_approve" as const, policyId: "p1" }
      },
    })
    expect(r.skip).toBe(false)
    expect(r.personRefusal).toBe("missing_scope")
    expect(r.autoApprovedByPolicy).toBeUndefined()
    expect(consulted).toBe(false)
  })

  test("holding the tool's scope but not the approve scope: runs, without consulting a policy", async () => {
    let consulted = false
    const r = await computeSkipGate({
      ...base,
      personHoldsToolScopes: true,
      requesterCanApprove: false,
      evaluate: async () => {
        consulted = true
        return { decision: "gate" as const }
      },
    })
    expect(r.skip).toBe(true)
    expect(r.personRefusal).toBeUndefined()
    expect(consulted).toBe(false)
  })

  test("an ungated tool runs on the person's tool scope alone", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: false,
      personHoldsToolScopes: true,
      requesterCanApprove: false,
      evaluate: async () => ({ decision: "gate" as const }),
    })
    expect(r.skip).toBe(true)
    expect(r.personRefusal).toBeUndefined()
  })

  test("a tightening policy that gates an ungated tool lets a person holding the tool's scope run it", async () => {
    const r = await computeSkipGate({
      ...base,
      gated: false,
      personHoldsToolScopes: true,
      requesterCanApprove: false,
      evaluatePolicy: async () => ({ requireApproval: true, minApprovers: 1, policyId: "t1" }),
      evaluate: async () => ({ decision: "gate" as const }),
    })
    expect(r.effectiveGated).toBe(true)
    expect(r.skip).toBe(true)
    expect(r.personRefusal).toBeUndefined()
  })

  test("an N-eyes policy parks a scoped person's call (no refusal), and no auto-approve answers it", async () => {
    let consulted = false
    const r = await computeSkipGate({
      ...base,
      personHoldsToolScopes: true,
      requesterCanApprove: true,
      evaluatePolicy: async () => ({ requireApproval: true, minApprovers: 2, policyId: "n2" }),
      evaluate: async () => {
        consulted = true
        return { decision: "auto_approve" as const, policyId: "p1" }
      },
    })
    expect(r.skip).toBe(false)
    expect(r.minApprovers).toBe(2)
    expect(r.personRefusal).toBeUndefined()
    expect(consulted).toBe(false)
  })

  test("an N-eyes policy still refuses a person without the tool's scope", async () => {
    const r = await computeSkipGate({
      ...base,
      personHoldsToolScopes: false,
      requesterCanApprove: true,
      evaluatePolicy: async () => ({ requireApproval: true, minApprovers: 2, policyId: "n2" }),
      evaluate: async () => ({ decision: "gate" as const }),
    })
    expect(r.skip).toBe(false)
    expect(r.personRefusal).toBe("missing_scope")
  })

  test("@ref placeholders in a person's call are refused, never sequenced into a bundle", async () => {
    const r = await computeSkipGate({
      ...base,
      personHoldsToolScopes: true,
      requesterCanApprove: true,
      validatedParams: { note: "@ref:00000000-0000-4000-8000-000000000001:value" },
      evaluate: async () => ({ decision: "auto_approve" as const, policyId: "p1" }),
    })
    expect(r.skip).toBe(false)
    expect(r.personRefusal).toBe("sequenced")
  })

  test("an unreadable approval policy fails CLOSED for a person's gated call (503, retryable), never runs or parks", async () => {
    const r = await computeSkipGate({
      ...base,
      personHoldsToolScopes: true,
      requesterCanApprove: true,
      evaluatePolicy: async () => {
        throw new Error("policy store down")
      },
      evaluate: async () => ({ decision: "auto_approve" as const, policyId: "p1" }),
    })
    expect(r.skip).toBe(false)
    expect(r.personRefusal).toBe("policy_unavailable")
    const err = personRefusalError("policy_unavailable", "shopify:refund_create", [])
    expect(err.status).toBe(503)
    expect(err.retryable).toBe(true)
    expect(err.code).toBe("approval_policy_unavailable")
  })

  test("an unreadable policy leaves an agent's gated call parking, as before (tighten-only)", async () => {
    const r = await computeSkipGate({
      ...base,
      isDirectHumanCall: false,
      requesterCanApprove: false,
      evaluatePolicy: async () => {
        throw new Error("policy store down")
      },
      evaluate: async () => ({ decision: "gate" as const }),
    })
    expect(r.skip).toBe(false)
    expect(r.personRefusal).toBeUndefined()
  })

  test("an agent's call is unchanged: no person refusal, the policy may answer it", async () => {
    const r = await computeSkipGate({
      ...base,
      isDirectHumanCall: false,
      requesterCanApprove: false,
      evaluate: async () => ({ decision: "auto_approve" as const, policyId: "p1" }),
    })
    expect(r.skip).toBe(true)
    expect(r.autoApprovedByPolicy).toBe("p1")
    expect(r.personRefusal).toBeUndefined()
  })
})
