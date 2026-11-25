// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type EvidencePackage,
  evidenceVerify,
  packageOf,
  sealRetry,
  timestampRetry,
  verifyPackage,
} from "./seal"
import { at, signedWorld } from "./seal.testutil"

describe("the seal of a version signed only by demo stand-ins", () => {
  it("writes one demo record with no files, no seal, no timestamp and no copies, and raises nothing", async () => {
    const w = await signedWorld({ level: "demo" })
    at(w, 2)
    expect(await sealRetry(w.ctx)).toMatchObject({ sealed: 0, waiting: 0 })
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.level).toBe("demo")
    expect(pkg.document_sha256).toBe("e".repeat(64))
    for (const k of [
      "seal",
      "signed_pdf_file_id",
      "evidence_file_id",
      "tsr_file_id",
      "timestamped_at",
    ] as const)
      expect(pkg[k] ?? null).toBeNull()
    expect(w.ctx.calls).toMatchObject({ emitted: [], mails: [], stamps: 0, files: 0 })
    expect(await w.db.findMany("copy_mails", { limit: 10 })).toEqual([])
    const agreement = (await w.db.findOne("agreements", w.agreementId)) as {
      seal_overdue_at?: string | null
    }
    expect(agreement.seal_overdue_at ?? null).toBeNull()
  })

  it("the retries skip the record afterwards: no second record, no timestamp ask, no overdue line", async () => {
    const w = await signedWorld({ level: "demo" })
    at(w, 2)
    await sealRetry(w.ctx)
    at(w, 30)
    await sealRetry(w.ctx)
    await timestampRetry(w.ctx)
    expect(await w.db.findMany("evidence_packages", { limit: 10 })).toHaveLength(1)
    expect(w.ctx.calls).toMatchObject({ emitted: [], mails: [], stamps: 0, files: 0 })
  })

  it("checking the record refuses without reporting a mismatch", async () => {
    const w = await signedWorld({ level: "demo" })
    await sealRetry(w.ctx)
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    const out = await verifyPackage(w.ctx, pkg)
    expect(out).toMatchObject({ error: { code: "NOT_SEALED" } })
    expect(w.ctx.calls.emitted).toEqual([])
  })

  it("the weekly evidence check passes over the record: it checks nothing and opens no incident", async () => {
    const w = await signedWorld({ level: "demo" })
    await sealRetry(w.ctx)
    // Even a stand-in record that carried a seal string is not checked.
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    await w.db.update("evidence_packages", pkg.id, { seal: "x" })
    expect(await evidenceVerify(w.ctx)).toMatchObject({ mismatches: 0 })
    const after = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(after.last_verified_at ?? null).toBeNull()
    expect(w.ctx.calls.emitted).toEqual([])
  })

  it("a version with real signatures still seals, stamps and mails its copies on the retry", async () => {
    const w = await signedWorld()
    at(w, 2)
    expect(await sealRetry(w.ctx)).toMatchObject({ sealed: 1, waiting: 0 })
    const pkg = (await packageOf(w.ctx, w.versionId)) as EvidencePackage
    expect(pkg.level).toBe("ses")
    expect(pkg.seal).toBeTruthy()
    expect(pkg.evidence_file_id).toBeTruthy()
    expect(pkg.timestamp_status).toBe("stamped")
    expect(w.ctx.calls.mails).toHaveLength(2)
    expect(w.ctx.calls.emitted.map((e) => e.action)).toContain("signed")
  })
})
