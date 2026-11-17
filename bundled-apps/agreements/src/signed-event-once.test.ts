// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { packageOf, sealRetry, sealVersion } from "./seal"
import { ACTION_B, signedWorld } from "./seal.testutil"

describe("the signed event", () => {
  it("a version holding a signature with no proven code is not sealed, and no signed event goes", async () => {
    const w = await signedWorld()
    const events = (await w.db.findMany("signature_events", {
      where: { client_action_id: ACTION_B },
      limit: 1,
    })) as Array<{ id: string }>
    await w.db.update("signature_events", String(events[0]?.id), { code_verified_at: null })
    expect(await sealVersion(w.ctx, w.versionId)).toMatchObject({ status: "not_ready" })
    await sealRetry(w.ctx)
    expect(await packageOf(w.ctx, w.versionId)).toBeNull()
    expect(w.ctx.calls.emitted).toHaveLength(0)
    expect(w.ctx.calls.mails).toHaveLength(0)
  })

  it("the signed event is emitted once, after sealing", async () => {
    const w = await signedWorld()
    await sealVersion(w.ctx, w.versionId)
    await sealVersion(w.ctx, w.versionId)
    await sealRetry(w.ctx)
    const signed = w.ctx.calls.emitted.filter(
      (e) => e.entity === "agreement" && e.action === "signed",
    )
    expect(signed).toHaveLength(1)
    const pkg = await packageOf(w.ctx, w.versionId)
    expect(signed[0]?.data).toMatchObject({
      number: "AG-2026-001",
      version: 1,
      package_id: pkg?.id,
    })
    expect(w.ctx.calls.mails).toHaveLength(2)
  })

  it("a merge failure leaves the version signed with no package, and the retry seals it; one item after an hour", async () => {
    const w = await signedWorld()
    const real = w.ctx.evidence_signed_pdf
    w.ctx.evidence_signed_pdf = async () => ({
      status: "error",
      error: { code: "MERGE_FAILED", message: "boom" },
    })
    expect(await sealVersion(w.ctx, w.versionId)).toMatchObject({ status: "seal_pending" })
    expect(await packageOf(w.ctx, w.versionId)).toBeNull()
    expect(w.ctx.calls.emitted).toHaveLength(0)
    w.clock.now = new Date(w.clock.now.getTime() + 2 * 60 * 60_000)
    await sealRetry(w.ctx)
    await sealRetry(w.ctx)
    expect(w.ctx.calls.emitted.filter((e) => e.action === "seal_overdue")).toHaveLength(1)
    w.ctx.evidence_signed_pdf = real
    await sealRetry(w.ctx)
    expect(await packageOf(w.ctx, w.versionId)).not.toBeNull()
    expect(w.ctx.calls.emitted.filter((e) => e.action === "signed")).toHaveLength(1)
  })

  it("a version with a signer still to sign is not sealed", async () => {
    const w = await signedWorld()
    await w.db.update("agreement_versions", w.versionId, { status: "frozen" })
    expect(await sealVersion(w.ctx, w.versionId)).toMatchObject({ status: "not_ready" })
    expect(w.ctx.calls.emitted).toHaveLength(0)
  })
})

describe("a failing host door", () => {
  it("a throw from a host door leaves the version signed for the retry, and emits nothing", async () => {
    const w = await signedWorld()
    w.ctx.evidence_signed_pdf = async () => {
      throw new Error("forbidden")
    }
    expect(await sealVersion(w.ctx, w.versionId)).toMatchObject({
      status: "seal_pending",
      reason: "forbidden",
    })
    expect(w.ctx.calls.emitted).toHaveLength(0)
  })
})
