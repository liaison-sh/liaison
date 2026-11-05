// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { aggregateAttentionItems, dedupeByApproval } from "~/modules/apps/attention-aggregator"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"

const FIXTURE_PATH = new URL("../../tests/fixtures/aggregator-providers.ts", import.meta.url)
  .pathname

const cleanupKeys: Array<[string, string]> = []

function registerFakeKernelProvider(appName: string, handler: string): void {
  const key: [string, string] = ["*", appName]
  attentionItemsRegistry.set(key, {
    handler,
    bundlePath: FIXTURE_PATH,
    trusted: true,
  } as never)
  cleanupKeys.push(key)
}

afterEach(() => {
  while (cleanupKeys.length > 0) {
    const key = cleanupKeys.pop()!
    attentionItemsRegistry.delete(key)
  }
})

describe("attention aggregator (unit)", () => {
  it("runs every kernel provider in one transaction; a provider failing on the database fails alone", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000a7"
    registerFakeKernelProvider("aggTxA", "txProviderA")
    registerFakeKernelProvider("aggTxFail", "sqlFailingProvider")
    registerFakeKernelProvider("aggTxB", "txProviderB")
    rememberOrgAppStates(orgId, [])
    try {
      const result = await aggregateAttentionItems({
        orgId,
        actor: {
          actorType: "user",
          userId: "00000000-0000-0000-0000-000000000001",
          orgId,
          scopes: ["*"],
          dimensionGrants: {},
        },
      })
      const txOf = (app: string) =>
        result.items.find((i: AttentionItem) => i.app === app)?.id.split(":tx:")[1]
      expect(txOf("aggTxA")).toBeDefined()
      expect(txOf("aggTxB")).toBe(txOf("aggTxA"))
      // The failing provider is reported; the one after it still ran, in the same transaction.
      expect(result.errors.map((e) => e.app)).toContain("aggTxFail")
      expect(result.errors.map((e) => e.app)).not.toContain("aggTxB")
    } finally {
      forgetOrgApps(orgId)
    }
  })

  it("drops kernel providers' items about an app turned Off for the org (S19)", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000a6"
    registerFakeKernelProvider("aggKernelAboutApps", "kernelItemsAboutAppsProvider")
    rememberOrgAppStates(orgId, [
      { app: "aggOffApp", status: "disabled" },
      { app: "aggOnApp", status: "active" },
    ])
    try {
      const result = await aggregateAttentionItems({
        orgId,
        actor: {
          actorType: "user",
          userId: "00000000-0000-0000-0000-000000000001",
          orgId,
          scopes: ["*"],
          dimensionGrants: {},
        },
      })
      const ids = result.items.map((i: AttentionItem) => i.id)
      expect(ids).toContain("conn:on")
      expect(ids).not.toContain("conn:off")
      expect(ids).not.toContain("appr:off")
    } finally {
      forgetOrgApps(orgId)
    }
  })

  it("drops the attention of an app restricted away from the reader; a listed person keeps it (S20, MGT-11)", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000a7"
    const member = "00000000-0000-0000-0000-000000000002"
    const listed = "00000000-0000-0000-0000-000000000003"
    registerFakeKernelProvider("aggKernelAboutApps", "kernelItemsAboutAppsProvider")
    // The restricted app's own provider: never invoked for the member (it would
    // fail here, having no bridge manifest, and report a provider error).
    const ownKey: [string, string] = [orgId, "aggOffApp"]
    attentionItemsRegistry.set(ownKey, {
      handler: "highUrgencyProvider",
      bundlePath: FIXTURE_PATH,
      trusted: true,
    } as never)
    cleanupKeys.push(ownKey)
    rememberOrgAppStates(orgId, [
      {
        app: "aggOffApp",
        status: "active",
        accessMode: "restricted",
        allowedUserIds: new Set([listed]),
      },
      { app: "aggOnApp", status: "active" },
    ])
    const feedFor = (userId: string) =>
      aggregateAttentionItems({
        orgId,
        actor: { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} },
      })
    try {
      const denied = await feedFor(member)
      const deniedIds = denied.items.map((i: AttentionItem) => i.id)
      expect(deniedIds).toContain("conn:on")
      expect(deniedIds).not.toContain("conn:off")
      expect(deniedIds).not.toContain("appr:off")
      expect(denied.errors.map((e) => e.app)).not.toContain("aggOffApp")

      const kept = (await feedFor(listed)).items.map((i: AttentionItem) => i.id)
      expect(kept).toContain("conn:off")
      expect(kept).toContain("appr:off")
    } finally {
      forgetOrgApps(orgId)
    }
  })

  it("attention.aggregator.sort-and-partial-failure", async () => {
    registerFakeKernelProvider("aggSortHigh", "highUrgencyProvider")
    registerFakeKernelProvider("aggSortLow", "lowUrgencyProvider")
    registerFakeKernelProvider("aggSortError", "throwingProvider")

    const result = await aggregateAttentionItems({
      orgId: "00000000-0000-0000-0000-000000000000",
      actor: {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000001",
        orgId: "00000000-0000-0000-0000-000000000000",
        scopes: ["*"],
        dimensionGrants: {},
      },
    })

    // Successful providers' items are present and sorted urgency DESC.
    const fromHigh = result.items.find((i: AttentionItem) => i.app === "aggSortHigh")
    const fromLow = result.items.find((i: AttentionItem) => i.app === "aggSortLow")
    expect(fromHigh).toBeDefined()
    expect(fromLow).toBeDefined()
    const idxHigh = result.items.findIndex((i: AttentionItem) => i.app === "aggSortHigh")
    const idxLow = result.items.findIndex((i: AttentionItem) => i.app === "aggSortLow")
    expect(idxHigh).toBeLessThan(idxLow)
    expect(fromHigh!.urgency).toBeGreaterThan(fromLow!.urgency)

    // Failing provider surfaces in errors but does not suppress successful items.
    const errored = result.errors.find((e) => e.app === "aggSortError")
    expect(errored).toBeDefined()
    expect(errored?.reason).toBe("error")
    expect(result.items.find((i: AttentionItem) => i.app === "aggSortError")).toBeUndefined()
  })

  it("attention.aggregator.dedupe-same-entity", async () => {
    registerFakeKernelProvider("aggDedupe", "multiKindProvider")

    const result = await aggregateAttentionItems({
      orgId: "00000000-0000-0000-0000-000000000000",
      actor: {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000001",
        orgId: "00000000-0000-0000-0000-000000000000",
        scopes: ["*"],
        dimensionGrants: {},
      },
    })

    const forShared = result.items.filter(
      (i: AttentionItem) => i.app === "aggDedupe" && i.entityId === "ticket-1",
    )
    // One row per entity, highest-urgency kind wins, merged kinds are badged.
    expect(forShared.length).toBe(1)
    expect(forShared[0]!.kind).toBe("sla_risk")
    expect(forShared[0]!.urgency).toBe(75)
    expect(forShared[0]!.alsoKinds?.sort()).toEqual(["awaiting_agent", "unassigned"])
    // Distinct entities are untouched.
    const other = result.items.filter(
      (i: AttentionItem) => i.app === "aggDedupe" && i.entityId === "ticket-2",
    )
    expect(other.length).toBe(1)
    expect(other[0]!.alsoKinds).toBeUndefined()
  })
})

describe("attention aggregator: one row per approval", () => {
  const approvalId = "11111111-1111-1111-1111-111111111111"
  const kernelItem = (): AttentionItem => ({
    id: `kernel:approval_pending:${approvalId}`,
    app: "kernel",
    entity: "approval_request",
    entityId: approvalId,
    kind: "approval_pending",
    summary: "Social: reply to finding",
    urgency: 60,
    occurredAt: "2026-10-16T10:00:00.000Z",
    action: { type: "decide_approval", approvalId },
    metadata: { expiresInSeconds: 600_000 },
  })
  const appItem = (): AttentionItem => ({
    id: "social-approval-finding-1",
    app: "social",
    entity: "finding",
    entityId: "finding-1",
    kind: "approval_pending",
    summary: "A drafted reply is awaiting your approval",
    urgency: 70,
    occurredAt: "2026-10-16T09:00:00.000Z",
    action: { type: "decide_approval", approvalId },
  })

  it("an app's item routed to a kernel approval collapses onto the kernel's item, whatever the order", () => {
    // The app's copy sorts first (higher urgency) and carries no deadline; the
    // kernel's item is the one with the request's real expiry and is kept.
    const out = dedupeByApproval([appItem(), kernelItem()])
    expect(out).toHaveLength(1)
    expect(out[0]?.app).toBe("kernel")
    expect(out[0]?.metadata?.expiresInSeconds).toBe(600_000)
  })

  it("leaves other approvals and non-approval items alone", () => {
    const other: AttentionItem = {
      ...kernelItem(),
      id: "kernel:approval_pending:other",
      entityId: "other",
      action: { type: "decide_approval", approvalId: "other" },
    }
    const mention: AttentionItem = {
      ...appItem(),
      id: "social-mention-finding-2",
      entityId: "finding-2",
      kind: "mention",
      action: { type: "open_entity", tabType: "findings", entityId: "finding-2" },
    }
    const out = dedupeByApproval([appItem(), mention, kernelItem(), other])
    expect(out.map((i) => i.id)).toEqual([
      "social-mention-finding-2",
      `kernel:approval_pending:${approvalId}`,
      "kernel:approval_pending:other",
    ])
  })

  it("keeps an app's approval item when the kernel lists no row for that request", () => {
    expect(dedupeByApproval([appItem()])).toHaveLength(1)
  })
})
