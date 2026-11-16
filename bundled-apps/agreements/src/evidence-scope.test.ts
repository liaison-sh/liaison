// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { agreementEvidenceGet, sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"

describe("evidence scope", () => {
  it("without the devices scope, IP and user agent are withheld", async () => {
    const w = await signedWorld({ holdsDevices: false })
    await sealVersion(w.ctx, w.versionId)
    const out = await agreementEvidenceGet(w.ctx, { id: w.agreementId })
    const text = JSON.stringify(out)
    expect(text).not.toContain("198.51.100.7")
    expect(text).not.toContain("UA-of-Paul")
    expect(out).toMatchObject({ status: "ok", devices: "withheld" })
    expect(text).toContain("Paul Morel")
  })

  it("with the devices scope, each signer's IP and user agent are shown", async () => {
    const w = await signedWorld({ holdsDevices: true })
    await sealVersion(w.ctx, w.versionId)
    const out = await agreementEvidenceGet(w.ctx, { id: w.versionId })
    const text = JSON.stringify(out)
    expect(text).toContain("198.51.100.7")
    expect(text).toContain("UA-of-Anne")
  })

  it("an unsealed agreement answers that it is not sealed yet", async () => {
    const w = await signedWorld()
    expect(await agreementEvidenceGet(w.ctx, { id: w.agreementId })).toMatchObject({
      status: "error",
      error: { code: "NOT_SEALED" },
    })
  })
})
