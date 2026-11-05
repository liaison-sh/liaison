// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { englishT } from "~/modules/i18n/i18n-context"
import { KERNEL_RULE_KINDS, kindLabel } from "~/modules/settings/notification-settings/kind-labels"

const KERNEL_TRANSLATIONS = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "api",
  "src",
  "modules",
  "attention",
  "kernel-translations.ts",
)

describe("the kernel kinds a Liaison rule allows", () => {
  // A kernel rule is an allow-list (subscriptions.ts): a translator kind left
  // out of it would silently stop reaching everyone who dropped replies.
  it("are exactly the kinds the kernel translator emits", () => {
    const src = readFileSync(KERNEL_TRANSLATIONS, "utf8")
    const emitted = new Set<string>()
    for (const m of src.matchAll(/^\s{4}kind: "([a-z_]+)",$/gm)) emitted.add(m[1]!)
    expect(emitted.size).toBeGreaterThan(3)
    expect([...KERNEL_RULE_KINDS].sort()).toEqual([...emitted].sort())
  })
})

describe("kind labels", () => {
  it("reads a known kind from the catalog", () => {
    expect(kindLabel("shopify:order.created", englishT)).toBe("New orders")
    expect(kindLabel("thread_reply", englishT)).toBe("Replies in your threads")
    expect(kindLabel("thread_followup", englishT)).toBe("Replies in threads you follow")
  })

  it("S11: names the three computer session kinds", () => {
    expect(kindLabel("node_session_needs_you", englishT)).toBe("Computer session needs you")
    expect(kindLabel("node_session_done", englishT)).toBe("Computer session done")
    expect(kindLabel("node_session_failed", englishT)).toBe("Computer session failed")
  })

  it("turns an unknown kind into words, never the raw id", () => {
    expect(kindLabel("acme:widget.stalled", englishT)).toBe("Widget stalled")
    expect(kindLabel("acme:order_backlog", englishT)).toBe("Order backlog")
    expect(kindLabel("plain_kind", englishT)).toBe("Plain kind")
  })
})
