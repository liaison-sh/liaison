// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { type EvidencePackage, packageOf, sealVersion, timestampRetry } from "./seal"
import { signedWorld } from "./seal.testutil"

const overdue = (w: Awaited<ReturnType<typeof signedWorld>>) =>
  w.ctx.calls.emitted.filter((e) => e.action === "timestamp_overdue").length

describe("timestamp retry", () => {
  it("authority down then up; at 23 h 59 no item, at 24 h 01 one, at 48 h still one", async () => {
    const w = await signedWorld({ authorityUp: false })
    const sealedAt = w.clock.now.getTime()
    const out = await sealVersion(w.ctx, w.versionId)
    expect(out).toMatchObject({ status: "sealed", timestamp: "pending" })
    // Copies go out at once, unstamped.
    expect(w.ctx.calls.mails).toHaveLength(2)
    expect(w.ctx.calls.mails.every((m) => !m.timestamped)).toBe(true)

    w.clock.now = new Date(sealedAt + (23 * 60 + 59) * 60_000)
    await timestampRetry(w.ctx)
    expect(overdue(w)).toBe(0)
    w.clock.now = new Date(sealedAt + (24 * 60 + 1) * 60_000)
    await timestampRetry(w.ctx)
    expect(overdue(w)).toBe(1)
    w.clock.now = new Date(sealedAt + 48 * 60 * 60_000)
    await timestampRetry(w.ctx)
    expect(overdue(w)).toBe(1)

    w.authority.up = true
    await timestampRetry(w.ctx)
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.timestamp_status).toBe("stamped")
    expect(pkg.tsr_file_id).toBeTruthy()
    expect(pkg.timestamped_at).toBeTruthy()
    expect(pkg.stamped_evidence_file_id).toBeTruthy()
    expect(pkg.stamped_evidence_file_id).not.toBe(pkg.evidence_file_id)
    // The stamped evidence file is mailed to each signer.
    expect(w.ctx.calls.mails.filter((m) => m.timestamped)).toHaveLength(2)
    // Nothing more once stamped.
    const stamps = w.ctx.calls.stamps
    await timestampRetry(w.ctx)
    expect(w.ctx.calls.stamps).toBe(stamps)
  })

  it("a stamp at seal time fills the stamped set at once and mails no second copy", async () => {
    const w = await signedWorld({ authorityUp: true })
    await sealVersion(w.ctx, w.versionId)
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.timestamp_status).toBe("stamped")
    expect(pkg.stamped_evidence_file_id).toBe(pkg.evidence_file_id)
    await timestampRetry(w.ctx)
    expect(w.ctx.calls.mails).toHaveLength(2)
  })

  it("an authority call that fails outright leaves the stamp pending, and the evidence and copies still go out", async () => {
    const w = await signedWorld({ authorityUp: false })
    w.ctx.signing_timestamp = async () => {
      throw new Error("the timestamp authority is not configured on this host")
    }
    const out = await sealVersion(w.ctx, w.versionId)
    expect(out).toMatchObject({ status: "sealed", timestamp: "pending" })
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.evidence_file_id).toBeTruthy()
    expect(w.ctx.calls.mails).toHaveLength(2)
  })
})
