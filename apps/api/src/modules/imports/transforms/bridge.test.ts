// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildTransformBridge, TRANSFORM_MAX_KEPT_ISSUES } from "./bridge"

describe("transform bridge bounds", () => {
  it("keeps the first rejected records' issues and counts the rest", async () => {
    const bridge = buildTransformBridge({ sourceType: "upload", kinds: ["tickets.ticket"] })
    const bad = Array.from({ length: 1500 }, () => "not a record")
    const answer = (await bridge.methods.emitRecords("tickets.ticket", JSON.stringify(bad))) as {
      rejected: unknown[]
      rejectedCount: number
    }
    expect(answer.rejectedCount).toBe(1500)
    expect(answer.rejected.length).toBeLessThanOrEqual(100)
    await bridge.methods.emitRecords("tickets.ticket", JSON.stringify(bad))
    expect(bridge.ledger.rejected).toHaveLength(TRANSFORM_MAX_KEPT_ISSUES)
    expect(TRANSFORM_MAX_KEPT_ISSUES).toBe(1000)
    expect(bridge.ledger.rejectedCount).toBe(3000)
  })

  it("a download filename is sanitized where it enters", async () => {
    const bridge = buildTransformBridge({ sourceType: "api", kinds: ["tickets.ticket"] })
    await bridge.methods.downloadToFile(
      "/attachments/1",
      JSON.stringify({ filename: "../../etc/.passwd" }),
    )
    expect(bridge.ledger.downloads[0]?.filename).toBe("passwd")
  })
})
