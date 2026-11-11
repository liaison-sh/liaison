// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app's attention items are stored state (attention-store.ts): the feed
// reads them and runs no app code; a woken run of the app recomputes and
// stores them, and a list the provider no longer returns is cleared.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import type { ActorContext } from "~/db/rls"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import {
  AttentionStoreTestAccess,
  attentionRefreshesSettled,
  refreshAppAttention,
  wireAttentionRefreshWakes,
} from "~/modules/apps/attention-store"
import * as executor from "~/modules/apps/sandbox/executor"
import * as runAppModule from "~/modules/apps/sandbox/run-app"
import { emitRunSettled } from "~/modules/apps/workers/run-settled"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "attnstore"

function item(id: string, urgency = 50): AttentionItem {
  return {
    id,
    app: APP,
    entity: "thing",
    entityId: id,
    kind: "admin_action",
    summary: `thing ${id}`,
    urgency,
    occurredAt: new Date().toISOString(),
    action: { type: "open_entity", tabType: `${APP}:thing`, entityId: id },
  }
}

describe("stored app attention", () => {
  let orgId = ""
  let userId = ""
  // What the app's provider would list now; the double stands in for the sandbox run.
  let listed: AttentionItem[] = []
  let providerRuns = 0
  const notified: string[] = []
  const deps = {
    listActiveUsers: async () => [userId],
    loadPersonActor: async (o: string, u: string): Promise<ActorContext> => ({
      actorType: "user",
      userId: u,
      orgId: o,
      scopes: ["*"],
      dimensionGrants: {},
    }),
    // The org's other apps (tickets, projects, ...) are refreshed too when the
    // feed finds no stored list for them: they list nothing here.
    invoke: async (_reg: unknown, appName: string) => {
      if (appName !== APP) return []
      providerRuns++
      return listed
    },
    notify: async (_o: string, u: string, appName: string) => {
      if (appName === APP) notified.push(u)
    },
  }
  const feed = () =>
    aggregateAttentionItems({
      orgId,
      actor: { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
    })

  beforeAll(async () => {
    await acquireTestLock()
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    attentionItemsRegistry.set([orgId, APP], {
      handler: "computeAttention",
      bundlePath: "/nonexistent/attention-store-test-bundle.js",
      trusted: false,
    } as never)
    AttentionStoreTestAccess.setWakeDeps({ ...deps, ensureOrgApps: async () => {} })
    wireAttentionRefreshWakes()
  })
  afterEach(() => {
    listed = []
    providerRuns = 0
    notified.length = 0
  })
  afterAll(async () => {
    attentionItemsRegistry.delete([orgId, APP])
    AttentionStoreTestAccess.reset()
    await releaseTestLock()
  })

  it("a feed poll runs no app code: it reads the stored list", async () => {
    listed = [item("a", 70), item("b", 30)]
    await refreshAppAttention(orgId, APP, deps)
    expect(providerRuns).toBe(1)
    expect(notified).toEqual([userId])

    const runApp = spyOn(runAppModule, "runApp")
    const inSandbox = spyOn(executor, "executeInSandbox")
    try {
      const first = await feed()
      const second = await feed()
      expect(runApp).not.toHaveBeenCalled()
      expect(inSandbox).not.toHaveBeenCalled()
      expect(providerRuns).toBe(1)
      for (const res of [first, second]) {
        const ours = res.items.filter((i) => i.app === APP).map((i) => i.id)
        expect(ours).toEqual(["a", "b"])
        expect(res.errors.filter((e) => e.app === APP)).toEqual([])
      }
    } finally {
      runApp.mockRestore()
      inSandbox.mockRestore()
    }
  })

  it("items appear and clear after a woken run of the app", async () => {
    listed = [item("x")]
    // A tool run of the app settles: the platform recomputes its list.
    emitRunSettled({
      app: APP,
      orgId,
      entry: "tool:do_something",
      executor: "quickjs",
      nested: false,
      ms: 1,
      ok: true,
      at: Date.now(),
    })
    await attentionRefreshesSettled()
    expect((await feed()).items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["x"])

    // The provider no longer lists it after the next run: the stored item clears.
    listed = []
    emitRunSettled({
      app: APP,
      orgId,
      entry: "job:sync",
      executor: "quickjs",
      nested: false,
      ms: 1,
      ok: true,
      at: Date.now(),
    })
    await attentionRefreshesSettled()
    expect((await feed()).items.filter((i) => i.app === APP)).toEqual([])
    expect(notified).toEqual([userId, userId])
  })

  it("an attention run does not wake another refresh", async () => {
    emitRunSettled({
      app: APP,
      orgId,
      entry: "attention:computeAttention",
      executor: "quickjs",
      nested: false,
      ms: 1,
      ok: true,
      at: Date.now(),
    })
    await attentionRefreshesSettled()
    expect(providerRuns).toBe(0)
  })

  it("a failed run keeps the last good list and reports the failure", async () => {
    listed = [item("kept")]
    await refreshAppAttention(orgId, APP, deps)
    await refreshAppAttention(orgId, APP, {
      ...deps,
      invoke: async () => {
        throw new Error("provider broke")
      },
    })
    const res = await feed()
    expect(res.items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["kept"])
    expect(res.errors).toContainEqual({ app: APP, reason: "error", message: "provider broke" })
  })

  it("drops malformed items and caps nothing it should not", async () => {
    listed = [item("ok"), { id: "bad" } as unknown as AttentionItem]
    await refreshAppAttention(orgId, APP, deps)
    const res = await feed()
    expect(res.items.filter((i) => i.app === APP).map((i) => i.id)).toEqual(["ok"])
    expect(res.errors.find((e) => e.app === APP)?.message).toContain("malformed")
  })
})
