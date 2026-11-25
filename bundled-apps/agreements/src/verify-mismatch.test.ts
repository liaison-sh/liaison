// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  agreementVerify,
  type EvidencePackage,
  evidenceVerify,
  packageOf,
  sealVersion,
} from "./seal"
import { signedWorld } from "./seal.testutil"

describe("verify", () => {
  it("unchanged files verify and record the check", async () => {
    const w = await signedWorld()
    await sealVersion(w.ctx, w.versionId)
    const out = await agreementVerify(w.ctx, { id: w.agreementId })
    expect(out).toMatchObject({ status: "ok", matches: true, agreement: "AG-2026-001", version: 1 })
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.last_verify_ok).toBe(true)
    expect(pkg.last_verified_at).toBeTruthy()
  })

  it("swapped bytes in storage record a failed verify and open an incident; nothing is repaired", async () => {
    const w = await signedWorld()
    await sealVersion(w.ctx, w.versionId)
    const before = JSON.stringify(await packageOf(w.ctx, w.versionId))
    w.storage.set("file-signed", "0".repeat(64))
    const out = await agreementVerify(w.ctx, { id: w.versionId })
    expect(out).toMatchObject({ status: "ok", matches: false })
    expect((out as { message: string }).message).toContain("Nothing was repaired")
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.last_verify_ok).toBe(false)
    const mismatch = w.ctx.calls.emitted.filter((e) => e.action === "mismatch")
    expect(mismatch).toHaveLength(1)
    expect(mismatch[0]?.data).toMatchObject({ what: "the signed PDF" })
    // Only the verify columns moved; storage still holds the swapped bytes.
    const after = { ...pkg, last_verified_at: null, last_verify_ok: null }
    expect({ ...JSON.parse(before), last_verified_at: null, last_verify_ok: null }).toEqual(after)
    expect(w.storage.get("file-signed")).toBe("0".repeat(64))
  })

  it("an edited trail fails the weekly check", async () => {
    const w = await signedWorld()
    await sealVersion(w.ctx, w.versionId)
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    const trail = pkg.trail as { events: Array<{ typed_name: string }> }
    ;(trail.events[0] as { typed_name: string }).typed_name = "Someone Else"
    expect(await evidenceVerify(w.ctx)).toMatchObject({ checked: 1, mismatches: 1 })
  })
})
