// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  einvoicingPaV1,
  KNOWN_CONTRACTS,
  LIFECYCLE_CODE,
  type LifecycleState,
  mergeLifecycle,
} from "./einvoicing-pa"

describe("einvoicing-pa@1 lifecycle merge", () => {
  it("moves forward along the chain and never back", () => {
    let s: LifecycleState | null = null
    for (const next of [
      "imported",
      "deposited",
      "sent",
      "accepted",
      "approved",
      "partially_collected",
      "collected",
    ] as const) {
      s = mergeLifecycle(s, next)
      expect(s).toBe(next)
    }
    expect(mergeLifecycle("collected", "sent")).toBe("collected")
    expect(mergeLifecycle("accepted", "deposited")).toBe("accepted")
  })

  it("never overwrites a terminal refusal or rejection", () => {
    expect(mergeLifecycle("refused", "collected")).toBe("refused")
    expect(mergeLifecycle("rejected", "approved")).toBe("rejected")
    expect(mergeLifecycle("rejected", "refused")).toBe("rejected")
  })

  it("lets any non-terminal state become terminal, and allows the approved / in_dispute lateral move", () => {
    expect(mergeLifecycle("collected", "refused")).toBe("refused")
    expect(mergeLifecycle("sent", "rejected")).toBe("rejected")
    expect(mergeLifecycle("approved", "in_dispute")).toBe("in_dispute")
    expect(mergeLifecycle("in_dispute", "approved")).toBe("approved")
  })

  it("ignores an unknown or empty observation", () => {
    expect(mergeLifecycle("sent", null)).toBe("sent")
    expect(mergeLifecycle("sent", "teleported" as LifecycleState)).toBe("sent")
  })

  it("carries the official codes and the contract registry entry", () => {
    expect(LIFECYCLE_CODE.deposited).toBe(200)
    expect(LIFECYCLE_CODE.refused).toBe(210)
    expect(LIFECYCLE_CODE.rejected).toBe(213)
    expect(KNOWN_CONTRACTS["einvoicing-pa@1"]).toBe(einvoicingPaV1)
    const required = Object.entries(einvoicingPaV1.ops)
      .filter(([, o]) => o.required)
      .map(([k]) => k)
    expect(required).toContain("submit_einvoice")
    expect(required).not.toContain("list_received")
  })
})

describe("einvoicing-pa@1 reception vocabulary", () => {
  it("merges received states monotonically, terminal kept, dispute withdrawable", async () => {
    const { mergeReceived, RECEIVED_CODE } = await import("./einvoicing-pa")
    expect(mergeReceived(null, "received")).toBe("received")
    expect(mergeReceived("received", "in_dispute")).toBe("in_dispute")
    expect(mergeReceived("in_dispute", "approved")).toBe("approved")
    expect(mergeReceived("collected", "received")).toBe("collected")
    expect(mergeReceived("refused", "collected")).toBe("refused")
    expect(mergeReceived("approved", "rejected")).toBe("rejected")
    expect(RECEIVED_CODE.refused).toBe(210)
    expect(RECEIVED_CODE.in_dispute).toBe(207)
    expect(RECEIVED_CODE.received).toBeNull()
  })

  it("declares the reception ops optional, with the comment param on set_received_status", () => {
    for (const op of [
      "list_received",
      "get_received",
      "fetch_received_file",
      "set_received_status",
    ]) {
      expect(einvoicingPaV1.ops[op]?.required).toBe(false)
    }
    expect(einvoicingPaV1.ops.set_received_status!.params).toContain("comment")
    expect(einvoicingPaV1.ops.fetch_received_file!.params).toEqual([
      "provider_ref",
      "file",
      "target",
    ])
  })
})
