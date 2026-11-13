// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { registerKernelAttentionProvider } from "~/modules/apps/runtime"

describe("attention.aggregator", () => {
  afterEach(() => {
    attentionItemsRegistry.deleteByPrefix(["*", "kernel"])
  })

  it("attention.aggregator.kernel-provider-registers", () => {
    registerKernelAttentionProvider({
      handler: "computeApprovalAttentionItems",
      bundlePath: "/abs/path/to/approvals-attention.js",
    })
    const entry = attentionItemsRegistry.get(["*", "kernel"])
    expect(entry?.handler).toBe("computeApprovalAttentionItems")
    expect(entry?.scope).toBeUndefined()
    expect(entry?.core).toBe(true)
    expect(entry?.bundlePath).toBe("/abs/path/to/approvals-attention.js")
  })
})
