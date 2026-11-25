// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed agreement drafts its project's advance: one draft parked for a person,
// nothing issued, and a replayed event drafts nothing more. A change request's
// approval or an agreement without a project drafts nothing.

import { describe, expect, test } from "bun:test"
import { harness, PROJECT, withPlan } from "./__tests__/billing-plan-fixtures"
import { onAgreementSignedAdvance } from "./agreement-signed"

type Row = Record<string, unknown>

const signed = (data: Row) => ({ data: { number: "AG-2026-004", ...data } })

describe("a signed agreement and its project's advance", () => {
  test("an advance step parks a draft and issues nothing", async () => {
    const h = harness()
    await withPlan(h)
    const out = await onAgreementSignedAdvance(
      h.ctx,
      signed({ kind: "proposal", project_id: PROJECT }),
    )
    expect(out.status).toBe("drafted")
    const docs = h.db.__all("documents")
    const drafts = docs.filter((d) => d.status === "draft" && d.billing_project_id === PROJECT)
    expect(drafts).toHaveLength(1)
    expect(docs.filter((d) => d.number && d.type === "invoice")).toHaveLength(0)
    // The same event again finds the step drafted.
    const again = await onAgreementSignedAdvance(
      h.ctx,
      signed({ kind: "proposal", project_id: PROJECT }),
    )
    expect(again.status).toBe("ignored")
    expect(
      h.db
        .__all("documents")
        .filter((d) => d.status === "draft" && d.billing_project_id === PROJECT),
    ).toHaveLength(1)
  })

  test("a change request's approval or an agreement with no project drafts nothing", async () => {
    const h = harness()
    await withPlan(h)
    const before = h.db.__all("documents").length
    expect(
      (
        await onAgreementSignedAdvance(
          h.ctx,
          signed({ kind: "change_request", project_id: PROJECT }),
        )
      ).status,
    ).toBe("ignored")
    expect(
      (await onAgreementSignedAdvance(h.ctx, signed({ kind: "proposal", project_id: null })))
        .status,
    ).toBe("ignored")
    expect(h.db.__all("documents").length).toBe(before)
  })
})
