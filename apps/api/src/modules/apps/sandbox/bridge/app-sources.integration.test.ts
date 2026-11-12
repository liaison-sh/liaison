// SPDX-License-Identifier: FSL-1.1-ALv2
// `knowledge_appSource` / `knowledge_appSourceWrite`: an app's own knowledge
// sources through the real bridge and database. A source is ensured once per
// app, kind, owner, ref and account (a second ensure reuses it); another app
// never sees it; a disconnected account's content goes with it, unless the same
// owner still holds an active connection of that account.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { knowledgeSourceKindRegistry } from "~/modules/apps/app-registries"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedConnectedAccountRow } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "srcprobe"
const OTHER = "srcother"
const manifest = (name: string) => ({ name, schema: {}, events: {}, network: {}, connections: {} })

let ORG = ""
let ALICE = ""

function bridge(app: string) {
  return {
    call: async (method: "knowledge_appSource" | "knowledge_appSourceWrite", params: unknown) =>
      JSON.parse(
        await withRlsContext(
          {
            actorType: "user",
            userId: ALICE,
            orgId: ORG,
            scopes: ["*"],
            dimensionGrants: { "*": ["*"] },
          },
          (tx) =>
            createRpcBridge(app, ALICE, ORG, tx as never, manifest(app) as never, ["*"])[method](
              JSON.stringify(params),
            ),
        ),
      ),
  }
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  ALICE = (await minimal.orgAdmin(ORG)).id
  for (const app of [APP, OTHER]) {
    knowledgeSourceKindRegistry.set([ORG, app], {
      kinds: { folder: { title: "Folder", handler: "syncFolder" } },
      dispatch: async () => ({ done: true }),
    } as never)
  }
}, 120_000)

afterAll(async () => {
  await db.execute(sql`DELETE FROM app_knowledge.synced_sources WHERE org_id = ${ORG}::uuid`)
  await db.execute(sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}::uuid`)
  await releaseTestLock()
})

describe("an app's own knowledge sources", () => {
  it("ensure creates once and reuses; get and list see it; another app sees nothing", async () => {
    const a = bridge(APP)
    const ensure = {
      op: "ensure",
      kind: "folder",
      ref: "folder0001",
      config: { ref: "folder0001" },
      account: "ana@example.com",
      displayName: "Drive folder",
      scope: "personal",
    }
    const first = await a.call("knowledge_appSourceWrite", ensure)
    expect(first).toMatchObject({
      kind: "folder",
      ref: "folder0001",
      sourceAccount: "ana@example.com",
      ownerUserId: ALICE,
    })
    const again = await a.call("knowledge_appSourceWrite", ensure)
    expect(again.id).toBe(first.id)
    expect(
      await a.call("knowledge_appSource", {
        op: "get",
        kind: "folder",
        ref: "folder0001",
        scope: "personal",
      }),
    ).toMatchObject({ id: first.id, config: { ref: "folder0001" } })
    expect(
      (await a.call("knowledge_appSource", { op: "list" })).map((s: { id: string }) => s.id),
    ).toEqual([first.id])
    expect(await bridge(OTHER).call("knowledge_appSource", { op: "list" })).toEqual([])
    await expect(
      bridge(OTHER).call("knowledge_appSourceWrite", { op: "sync", id: first.id }),
    ).rejects.toMatchObject({
      code: "not_found",
    })
    // A write never goes through the read method.
    await expect(a.call("knowledge_appSource", ensure)).rejects.toMatchObject({
      code: "invalid_params",
    })
  })

  it("purgeAccount deletes what a disconnected account synced, and keeps it on a re-authorization", async () => {
    const a = bridge(APP)
    const src = await a.call("knowledge_appSourceWrite", {
      op: "ensure",
      kind: "folder",
      ref: "folder0002",
      config: { ref: "folder0002" },
      account: "bob@example.com",
      displayName: "Bob's folder",
      scope: "personal",
    })
    const account = (status: string) =>
      seedConnectedAccountRow({
        orgId: ORG,
        appName: APP,
        connectionName: "drive",
        ownerType: "user",
        ownerId: ALICE,
        providerType: "oauth2",
        identifier: "bob@example.com",
        status,
        createdBy: ALICE,
      })
    const gone = await account("disconnected")
    const live = await account("active")
    // The same owner still connects the account: nothing goes.
    expect(
      await a.call("knowledge_appSourceWrite", { op: "purgeAccount", connectionId: gone }),
    ).toMatchObject({ kept: true })
    await db.execute(
      sql`UPDATE kernel.connected_accounts SET status = 'disconnected' WHERE id = ${live}::uuid`,
    )
    // Another app cannot purge through this app's account.
    expect(
      await bridge(OTHER).call("knowledge_appSourceWrite", {
        op: "purgeAccount",
        connectionId: gone,
      }),
    ).toMatchObject({
      kept: true,
    })
    const out = await a.call("knowledge_appSourceWrite", { op: "purgeAccount", connectionId: gone })
    expect(out).toMatchObject({ kept: false, syncedSources: 1 })
    const left = extractRows(
      await db.execute(sql`SELECT id FROM app_knowledge.synced_sources WHERE id = ${src.id}::uuid`),
    )
    expect(left).toEqual([])
  })
})
