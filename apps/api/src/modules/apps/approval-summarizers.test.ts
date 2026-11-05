// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { approvalSummarizerRegistry } from "~/modules/apps/app-registries"
import {
  generateApprovalSummary,
  registerApprovalSummarizer,
  templateApprovalSummarizer,
} from "~/modules/apps/approval-summarizers"

const ORG = "00000000-0000-0000-0000-000000000a01"

afterEach(() => {
  approvalSummarizerRegistry.clear()
})

describe("approval summarizer registry", () => {
  it("registers and looks up by [orgId, app, name]", async () => {
    registerApprovalSummarizer(ORG, "mail", "reply", async () => ({
      kind: "mail.reply",
      title: "Re: x",
      lines: ["To: y"],
    }))

    const result = await generateApprovalSummary(
      ORG,
      "mail",
      "reply",
      { conversationId: "c1", textBody: "hi" },
      {} as any,
      "mail:reply",
    )

    expect(result.kind).toBe("mail.reply")
    expect(result.title).toBe("Re: x")
  })

  it("returns the default fallback when no summarizer is registered", async () => {
    const result = await generateApprovalSummary(
      ORG,
      "mail",
      "missing",
      { foo: "bar" },
      {} as any,
      "mail:missing",
    )
    expect(result.kind).toBe("mail:missing")
    // The card's title: never the raw tool id (iPhone walk 2026-10-19).
    expect(result.title).toBe("Mail: missing")
    expect(result.subtitle).toBe("Pending approval")
    expect(result.lines.length).toBe(1)
    expect(result.lines[0]).toBe("Foo: bar")
  })

  it("default fallback renders params as readable key-value lines, not a JSON blob", async () => {
    const result = await generateApprovalSummary(
      ORG,
      "mail",
      "missing",
      {
        orderId: "gid://shopify/Order/12390079529291",
        fulfillment: { notifyCustomer: false },
        tags: ["a", "b"],
        items: [{ sku: "X" }, { sku: "Y" }, { sku: "Z" }, { sku: "W" }, { sku: "V" }],
        count: 3,
        enabled: true,
        note: null,
        extra1: "x",
        extra2: "y",
      },
      {} as any,
      "mail:missing",
    )
    expect(result.lines).toContain("Order id: gid://shopify/Order/12390079529291")
    // A nested object reads field by field, a boolean as a word.
    expect(result.lines).toContain("Fulfillment, notify customer: no")
    expect(result.lines).toContain("Tags: a, b")
    expect(result.lines).toContain("Items: 5 items")
    expect(result.lines).toContain("Count: 3")
    expect(result.lines).toContain("Enabled: yes")
    expect(result.lines).toContain("Note: (none)")
    // 9 fields: first 7 rendered + a "more fields" marker, capped at 8 lines.
    expect(result.lines.length).toBe(8)
    expect(result.lines[7]).toBe("(and 2 more fields)")
  })

  it("returns the default fallback when the summarizer throws", async () => {
    registerApprovalSummarizer(ORG, "mail", "reply", async () => {
      throw new Error("boom")
    })

    const result = await generateApprovalSummary(
      ORG,
      "mail",
      "reply",
      { foo: "bar" },
      {} as any,
      "mail:reply",
    )
    expect(result.kind).toBe("mail:reply")
    expect(result.subtitle).toBe("Pending approval")
  })

  it("truncates summarizer output to 8 lines, 500 chars each", async () => {
    registerApprovalSummarizer(ORG, "mail", "reply", async () => ({
      kind: "mail.reply",
      title: "x",
      lines: Array.from({ length: 20 }, (_, i) => `line-${i}-${"x".repeat(600)}`),
    }))

    const result = await generateApprovalSummary(ORG, "mail", "reply", {}, {} as any, "mail:reply")
    expect(result.lines.length).toBe(8)
    expect(result.lines.every((line) => line.length <= 500)).toBe(true)
    expect(result.lines[0]).toContain("line-0")
    expect(result.lines[7]).toContain("line-7")
  })

  it("accepts external {label, url} links from a summarizer", async () => {
    registerApprovalSummarizer(ORG, "mail", "reply", async () => ({
      kind: "mail.reply",
      title: "x",
      lines: ["y"],
      links: [
        { label: "Open order in Shopify", url: "https://fabrikam.myshopify.com/admin/orders/1" },
        { label: "Open ticket", app: "tickets", entityType: "ticket", entityId: "t1" },
      ],
    }))
    const result = await generateApprovalSummary(ORG, "mail", "reply", {}, {} as any, "mail:reply")
    expect(result.links).toEqual([
      { label: "Open order in Shopify", url: "https://fabrikam.myshopify.com/admin/orders/1" },
      { label: "Open ticket", app: "tickets", entityType: "ticket", entityId: "t1" },
    ])
  })

  it("falls back to default when summarizer returns invalid shape", async () => {
    registerApprovalSummarizer(ORG, "mail", "reply", async () => ({ wrong: true }) as any)
    const result = await generateApprovalSummary(
      ORG,
      "mail",
      "reply",
      { p: 1 },
      {} as any,
      "mail:reply",
    )
    expect(result.subtitle).toBe("Pending approval")
  })

  it("default fallback reads a nested payload as summarised lines, not dotted parameter paths", async () => {
    // The walk's Shopify card showed `basicCodeDiscount.startsAt: 2026-...` and
    // `true` wrapping as "tru/e".
    const result = await generateApprovalSummary(
      ORG,
      "shopify",
      "unknown_discount",
      {
        basicCodeDiscount: {
          code: "AUTUMN15",
          startsAt: "2026-10-22T12:44:50.603Z",
          appliesOncePerCustomer: true,
        },
      },
      {} as any,
      "shopify:unknown_discount",
    )
    expect(result.title).toBe("Shopify: unknown discount")
    expect(result.lines).toEqual([
      "Basic code discount, code: AUTUMN15",
      "Basic code discount, starts at: 2026-10-22T12:44:50.603Z",
      "Basic code discount, applies once per customer: yes",
    ])
    expect(result.lines.join("\n")).not.toContain("basicCodeDiscount.")
  })

  it("a tool's approvalCard summary template titles its card when it has no summarizer", async () => {
    registerApprovalSummarizer(
      ORG,
      "tickets",
      "inboxes.create",
      templateApprovalSummarizer(
        "Create inbox {{params.name}} (reply-to, from address)",
        "tickets:inboxes.create",
      ),
    )
    const result = await generateApprovalSummary(
      ORG,
      "tickets",
      "inboxes.create",
      { name: "Sales", ackEnabled: false },
      {} as any,
      "tickets:inboxes.create",
    )
    expect(result.title).toBe("Create inbox Sales (reply-to, from address)")
    expect(result.lines).toEqual(["Name: Sales", "Ack enabled: no"])
  })

  it("a template placeholder the payload lacks drops out instead of printing braces", async () => {
    const summarize = templateApprovalSummarizer(
      "Update inbox {{params.id}}",
      "tickets:inboxes.update",
    )
    const result = await summarize({}, {} as any)
    expect(result.title).toBe("Update inbox")
  })
})
