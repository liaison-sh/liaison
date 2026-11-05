// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test"

type Mod = typeof import("./event-provider")
let mod: Mod
beforeAll(async () => {
  mod = await import("./event-provider")
})

const ORG = "00000000-0000-0000-0000-000000000111"
const USER = "00000000-0000-0000-0000-000000000aaa"

function makeTx(rows: any[]) {
  return {
    execute: mock(async () => rows),
  } as any
}

// tx that returns a different result set per successive execute() call — the
// external-only-detail path issues a second query (connected_accounts) after the
// attention-rows query.
function makeTxSeq(resultsByCall: any[][]) {
  let call = 0
  return {
    execute: mock(async () => resultsByCall[call++] ?? []),
  } as any
}

describe("getEventAttentionItems", () => {
  it("returns unread non-email-only rows as AttentionItem[]", async () => {
    const tx = makeTx([
      {
        id: "r1",
        app: "kernel",
        entity_type: "thread",
        entity_id: "t1",
        kind: "mention",
        urgency: 60,
        summary: "@you",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: null,
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "r1",
      app: "kernel",
      entity: "thread",
      entityId: "t1",
      kind: "mention",
      summary: "@you",
      urgency: 60,
      action: { type: "open_entity", tabType: "kernel:thread", entityId: "t1" },
    })
  })

  it("resolves tabType for known kernel entities", async () => {
    const tx = makeTx([
      {
        id: "r2",
        app: "kernel",
        entity_type: "approval_request",
        entity_id: "ap-1",
        kind: "approval_decision",
        urgency: 50,
        summary: "Approval decided",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: null,
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items[0].action).toMatchObject({ tabType: "kernel:approval_request" })
  })

  it("falls back to app:entity tabType for unregistered apps", async () => {
    const tx = makeTx([
      {
        id: "r3",
        app: "widgets",
        entity_type: "widget",
        entity_id: "w1",
        kind: "thread_reply",
        urgency: 30,
        summary: "x",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: null,
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items[0].action).toMatchObject({ tabType: "widgets:widget" })
  })

  it("propagates metadata when present", async () => {
    const tx = makeTx([
      {
        id: "r4",
        app: "kernel",
        entity_type: "thread",
        entity_id: "t2",
        kind: "thread_reply",
        urgency: 30,
        summary: "hi",
        occurred_at: new Date("2026-05-12T12:00:00Z"),
        metadata: { threadId: "t2", actorName: "Alice" },
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items[0].metadata).toEqual({ threadId: "t2", actorName: "Alice" })
  })

  it("maps an agent_notification row's metadata.link to the open_entity action", async () => {
    const tx = makeTx([
      {
        id: "n1",
        app: "kernel",
        entity_type: "agent_notification",
        entity_id: "notif-uuid",
        kind: "agent_notification",
        urgency: 50,
        summary: "Digest posted",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: { link: { tabType: "kernel:thread", entityId: "thread-xyz" } },
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items[0].action).toEqual({
      type: "open_entity",
      tabType: "kernel:thread",
      entityId: "thread-xyz",
    })
  })

  it("keeps an agent_notification row without metadata.link with a valid action", async () => {
    const tx = makeTx([
      {
        id: "n2",
        app: "kernel",
        entity_type: "agent_notification",
        entity_id: "notif-nolink",
        kind: "agent_notification",
        urgency: 40,
        summary: "No link",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: null,
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items).toHaveLength(1)
    expect(items[0].action.type).toBe("open_entity")
    expect((items[0].action as any).entityId).toBe("notif-nolink")
  })

  it("respects the ordering passed in by SQL (relies on caller's ORDER BY)", async () => {
    const tx = makeTx([
      {
        id: "high",
        app: "kernel",
        entity_type: "thread",
        entity_id: "t1",
        kind: "mention",
        urgency: 60,
        summary: "a",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: null,
      },
      {
        id: "low",
        app: "kernel",
        entity_type: "thread",
        entity_id: "t2",
        kind: "thread_reply",
        urgency: 30,
        summary: "b",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: null,
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items.map((i) => i.id)).toEqual(["high", "low"])
  })

  it("maps a metadata.link.url override to an open_url action", async () => {
    const tx = makeTx([
      {
        id: "u1",
        app: "kernel",
        entity_type: "agent_notification",
        entity_id: "notif-url",
        kind: "agent_notification",
        urgency: 50,
        summary: "External link",
        occurred_at: "2026-05-12T12:00:00Z",
        metadata: { link: { url: "https://example.com/x", label: "Open x" } },
      },
    ])
    const items = await mod.getEventAttentionItems(tx, ORG, USER)
    expect(items[0].action).toEqual({
      type: "open_url",
      url: "https://example.com/x",
      label: "Open x",
    })
  })

  it("refuses a metadata.link.url that is not http(s): no open_url action", async () => {
    for (const url of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
    ]) {
      const tx = makeTx([
        {
          id: "u-bad",
          app: "kernel",
          entity_type: "agent_notification",
          entity_id: "notif-bad",
          kind: "agent_notification",
          urgency: 50,
          summary: "Bad link",
          occurred_at: "2026-05-12T12:00:00Z",
          metadata: { link: { url } },
        },
      ])
      const items = await mod.getEventAttentionItems(tx, ORG, USER)
      expect(items[0].action.type, url).toBe("open_entity")
    }
  })

  describe("external-only detail entities (e.g. Shopify order)", () => {
    let registries: typeof import("~/modules/apps/app-registries")
    beforeAll(async () => {
      registries = await import("~/modules/apps/app-registries")
    })
    afterEach(() => {
      registries.viewRegistry.delete(["*", "shopify"])
      registries.connectionConfigRegistry.delete(["*", "shopify", "shop"])
    })

    function registerShopifyOrderExternalLink() {
      registries.viewRegistry.set(["*", "shopify"], {
        detail: {
          order: {
            externalLink: {
              urlTemplate: "https://{{shop}}.myshopify.com/admin/orders/{{id}}",
              label: "Open in Shopify",
            },
          },
        },
      } as any)
      registries.connectionConfigRegistry.set(["*", "shopify", "shop"], {
        type: "oauth2",
        allowedDomains: [],
        identifierVar: "shop",
        templateVars: { shop: { pattern: ".*", appendSuffix: ".myshopify.com" } },
      } as any)
    }

    const orderRow = {
      id: "o1",
      app: "shopify",
      entity_type: "order",
      entity_id: "9001",
      kind: "shopify:order.created",
      urgency: 40,
      summary: "New order #1234",
      occurred_at: "2026-05-12T12:00:00Z",
      metadata: null,
    }

    it("resolves the admin URL as an open_url action, stripping the stored suffix", async () => {
      registerShopifyOrderExternalLink()
      const tx = makeTxSeq([
        [orderRow],
        [{ identifier: "acme.myshopify.com", connection_name: "shop" }],
      ])
      const items = await mod.getEventAttentionItems(tx, ORG, USER)
      expect(items[0].action).toEqual({
        type: "open_url",
        url: "https://acme.myshopify.com/admin/orders/9001",
        label: "Open in Shopify",
      })
    })

    it("degrades to open_entity when no active connection is found", async () => {
      registerShopifyOrderExternalLink()
      const tx = makeTxSeq([[orderRow], []])
      const items = await mod.getEventAttentionItems(tx, ORG, USER)
      expect(items[0].action).toEqual({
        type: "open_entity",
        tabType: "shopify:order",
        entityId: "9001",
      })
    })
  })
})
