// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { COPY_MAX_ATTEMPTS, copiesRetry, copyStateOf, sealVersion } from "./seal"
import { ACTION_A, ACTION_B, signedWorld } from "./seal.testutil"

describe("signers' copies", () => {
  it("each signer gets their own copy at their invited address, at seal", async () => {
    const w = await signedWorld()
    await sealVersion(w.ctx, w.versionId)
    expect(w.ctx.calls.mails.map((m) => m.to).sort()).toEqual([
      "anne@maison-morel.example",
      "paul@maison-morel.example",
    ])
    const paul = w.ctx.calls.mails.find((m) => m.to === "paul@maison-morel.example")
    expect(paul?.copyFileId).toContain(ACTION_A)
    expect(await copyStateOf(w.ctx, w.versionId, ACTION_A)).toBe("sent")
  })

  it("a failed send is retried, and after three failures one attention item names the signer", async () => {
    const w = await signedWorld()
    w.mail.failing.add("anne@maison-morel.example")
    await sealVersion(w.ctx, w.versionId)
    expect(await copyStateOf(w.ctx, w.versionId, ACTION_B)).toBe("on_its_way")
    for (let i = 0; i < 5; i++) await copiesRetry(w.ctx)
    const failed = w.ctx.calls.emitted.filter((e) => e.action === "copy_failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]?.data).toMatchObject({ signer: "Anne Morel", attempts: COPY_MAX_ATTEMPTS })
    expect(await copyStateOf(w.ctx, w.versionId, ACTION_B)).toBe("not_sent")
    expect(await copyStateOf(w.ctx, w.versionId, ACTION_A)).toBe("sent")
  })

  it("a copy that failed once and then goes out counts as sent", async () => {
    const w = await signedWorld()
    w.mail.failing.add("anne@maison-morel.example")
    await sealVersion(w.ctx, w.versionId)
    w.mail.failing.clear()
    await copiesRetry(w.ctx)
    expect(await copyStateOf(w.ctx, w.versionId, ACTION_B)).toBe("sent")
    expect(w.ctx.calls.emitted.filter((e) => e.action === "copy_failed")).toHaveLength(0)
  })

  it("before the last signature a signer's copy waits for the others", async () => {
    const w = await signedWorld()
    await w.db.update("agreement_versions", w.versionId, { status: "frozen" })
    expect(await copyStateOf(w.ctx, w.versionId, ACTION_A)).toBe("waiting_for_others")
  })
})
