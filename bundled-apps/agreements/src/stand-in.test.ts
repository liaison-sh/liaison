// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"
import { agreementEvidenceGetNamed, agreementVerifyNamed, STAND_IN_SENTENCE } from "./stand-in"

/** A signed version whose package the demo seed wrote: level `demo`, no files, no seal. */
async function standInWorld() {
  const w = await signedWorld()
  for (const e of w.db.tables.get("signature_events") ?? []) e.level = "demo"
  await w.db.insert("evidence_packages", {
    version_id: w.versionId,
    level: "demo",
    document_sha256: "e".repeat(64),
    timestamp_status: "none",
  })
  return w
}

describe("a stand-in signature never passes as a real one", () => {
  it("agreement_verify answers stand-in on a demo package, checks nothing and opens nothing", async () => {
    const w = await standInWorld()
    const out = (await agreementVerifyNamed(w.ctx, { id: w.agreementId })) as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ status: "ok", level: "demo", result: "stand-in" })
    expect(out.matches).toBeUndefined()
    expect(String(out.message)).toContain(STAND_IN_SENTENCE)
    expect(String(out.message)).not.toMatch(/\bvalid\b|\bmatch/i)
    expect(w.ctx.calls.emitted.filter((e) => e.action === "mismatch")).toEqual([])
  })

  it("agreement_evidence_get on a demo package offers no evidence and says why", async () => {
    const w = await standInWorld()
    const out = (await agreementEvidenceGetNamed(w.ctx, { id: w.versionId })) as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ status: "ok", level: "demo", result: "stand-in" })
    expect(out.signers).toBeUndefined()
    expect(String(out.message)).toContain("There is no evidence file to download or check.")
  })

  it("a real signature's verify and evidence name the level they read", async () => {
    const w = await signedWorld()
    await sealVersion(w.ctx, w.versionId)
    expect(await agreementVerifyNamed(w.ctx, { id: w.agreementId })).toMatchObject({
      status: "ok",
      matches: true,
      level: "ses",
    })
    expect(await agreementEvidenceGetNamed(w.ctx, { id: w.agreementId })).toMatchObject({
      status: "ok",
      level: "ses",
    })
  })
})
