// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `beforeDisconnect` hook: a connection that declares one gets its app
// handler run BEFORE the disconnect, while the row is still active (so the app
// can still use the token to clean up at the provider); an org purge runs it for
// every active connection; a failing hook never blocks anything.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import {
  connectionBeforeDisconnectRegistry,
  initializedOrgRuntimes,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import {
  type BeforeDisconnectEvent,
  BeforeDisconnectTestAccess,
  runBeforeDisconnect,
  runBeforeDisconnectForOrg,
} from "~/modules/apps/connections/before-disconnect"
import { disconnectConnection } from "~/modules/apps/connections/service"

let orgId: string
let userId: string

interface Call {
  exportName: string
  bundlePath: string
  params: BeforeDisconnectEvent
  statusAtCall: string | undefined
  tokenAtCall: boolean
}
const calls: Call[] = []
let failWith: string | null = null

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Before Disconnect Org', ${`before-disc-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`before-disc-${suffix}@test.com`}, 'Owner', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id
  BeforeDisconnectTestAccess.setExecutor(async ({ bundlePath, exportName, params }) => {
    // What the app would see: the row as committed when its handler runs.
    const [row] = await db
      .select({
        status: connectedAccounts.status,
        access: connectedAccounts.accessTokenEncrypted,
      })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, params.id))
    calls.push({
      bundlePath,
      exportName,
      params,
      statusAtCall: row?.status,
      tokenAtCall: Boolean(row?.access),
    })
    if (failWith) throw new Error(failWith)
  })
})

afterEach(() => {
  calls.length = 0
  failWith = null
  resetAppRegistries()
})

afterAll(async () => {
  BeforeDisconnectTestAccess.setExecutor(null)
  await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
})

function declareHook(appName: string, connectionName: string): void {
  // The org's apps count as loaded: the hook reads the registries directly.
  initializedOrgRuntimes.add(orgId)
  connectionBeforeDisconnectRegistry.set([orgId, appName, connectionName], {
    bundlePath: `/bundles/${appName}.js`,
    exportName: "onBeforeDisconnect",
  })
}

async function insertConnection(opts: {
  appName: string
  connectionName: string
  identifier: string
  status?: "active" | "disconnected"
}): Promise<string> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({
      orgId,
      appName: opts.appName,
      connectionName: opts.connectionName,
      ownerType: "org",
      ownerId: null,
      providerType: "oauth2",
      identifier: opts.identifier,
      accessTokenEncrypted: encryptSecret(
        "access-token",
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
      status: opts.status ?? "active",
      createdBy: userId,
    })
    .returning({ id: connectedAccounts.id })
  return row.id
}

async function disconnect(id: string): Promise<void> {
  await withPrivilegedDb(orgId, "before-disconnect-test", (tx) =>
    disconnectConnection(tx, orgId, userId, id),
  )
}

describe("beforeDisconnect hook", () => {
  it("runs the declared handler while the connection is still active, then the disconnect proceeds", async () => {
    initializedOrgRuntimes.add(orgId)
    declareHook("shopify", "shop")
    const id = await insertConnection({
      appName: "shopify",
      connectionName: "shop",
      identifier: `s-${randomUUID().slice(0, 8)}.myshopify.com`,
    })

    const outcome = await runBeforeDisconnect(orgId, id)
    await disconnect(id)

    expect(outcome).toEqual({ status: "ran" })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.exportName).toBe("onBeforeDisconnect")
    expect(call.bundlePath).toBe("/bundles/shopify.js")
    expect(call.statusAtCall).toBe("active")
    expect(call.tokenAtCall).toBe(true)
    expect(call.params).toMatchObject({
      id,
      orgId,
      appName: "shopify",
      connectionName: "shop",
      ownerType: "org",
      kernelPublicBaseUrl: env.BASE_URL,
      reason: "disconnect",
    })
    const [after] = await db
      .select({ status: connectedAccounts.status })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
    expect(after?.status).toBe("disconnected")
  })

  it("does nothing for a connection whose app declares no hook", async () => {
    initializedOrgRuntimes.add(orgId)
    const id = await insertConnection({
      appName: "mail",
      connectionName: "google",
      identifier: `m-${randomUUID().slice(0, 8)}@example.test`,
    })
    expect(await runBeforeDisconnect(orgId, id)).toEqual({ status: "skipped", reason: "no_hook" })
    expect(calls).toHaveLength(0)
  })

  it("does nothing for a connection already disconnected", async () => {
    declareHook("shopify", "shop")
    const id = await insertConnection({
      appName: "shopify",
      connectionName: "shop",
      identifier: `d-${randomUUID().slice(0, 8)}.myshopify.com`,
      status: "disconnected",
    })
    expect(await runBeforeDisconnect(orgId, id)).toEqual({
      status: "skipped",
      reason: "not_active",
    })
    expect(calls).toHaveLength(0)
  })

  it("a failing hook is reported, never thrown, and the disconnect still goes through", async () => {
    declareHook("shopify", "shop")
    failWith = "store unreachable"
    const id = await insertConnection({
      appName: "shopify",
      connectionName: "shop",
      identifier: `f-${randomUUID().slice(0, 8)}.myshopify.com`,
    })
    expect(await runBeforeDisconnect(orgId, id)).toEqual({
      status: "failed",
      reason: "store unreachable",
    })
    await disconnect(id)
    const [after] = await db
      .select({ status: connectedAccounts.status })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
    expect(after?.status).toBe("disconnected")
  })

  it("an unknown connection id is skipped", async () => {
    initializedOrgRuntimes.add(orgId)
    expect(await runBeforeDisconnect(orgId, randomUUID())).toEqual({
      status: "skipped",
      reason: "no_connection",
    })
  })

  it("an org purge runs the hook of every active connection that declares one", async () => {
    await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`)
    declareHook("shopify", "shop")
    const active = await insertConnection({
      appName: "shopify",
      connectionName: "shop",
      identifier: `p-${randomUUID().slice(0, 8)}.myshopify.com`,
    })
    await insertConnection({
      appName: "shopify",
      connectionName: "shop",
      identifier: `q-${randomUUID().slice(0, 8)}.myshopify.com`,
      status: "disconnected",
    })
    const noHook = await insertConnection({
      appName: "mail",
      connectionName: "google",
      identifier: `n-${randomUUID().slice(0, 8)}@example.test`,
    })

    const results = await runBeforeDisconnectForOrg(orgId)

    expect(calls.map((c) => c.params.id)).toEqual([active])
    expect(calls[0]?.params.reason).toBe("org_purge")
    expect(results).toContainEqual({ connectionId: active, outcome: { status: "ran" } })
    expect(results).toContainEqual({
      connectionId: noHook,
      outcome: { status: "skipped", reason: "no_hook" },
    })
    expect(results).toHaveLength(2)
  })
})
