// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import {
  appBridgeExtensionRegistry,
  type BridgeExtensionContext,
  buildBridgeExtensions,
} from "~/modules/apps/sandbox/bridge-extensions"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-4000-8000-0000000be001"
const txDb = db as unknown as RlsClient

const ctx = (appName: string): BridgeExtensionContext => ({
  appName,
  orgId: ORG,
  userId: "system",
  txDb,
  actorType: "system",
})

describe("bridge extensions", () => {
  afterEach(() => {
    appBridgeExtensionRegistry.delete([ORG, "demo"])
    appBridgeExtensionRegistry.delete(["*", "demo"])
  })

  it("returns no methods when an app registered none", () => {
    expect(buildBridgeExtensions(ctx("demo"))).toEqual({})
  })

  it("yields the registered app's methods and prefers org-scoped over wildcard", async () => {
    appBridgeExtensionRegistry.set(["*", "demo"], () => ({
      ping: async () => JSON.stringify({ from: "wildcard" }),
    }))
    appBridgeExtensionRegistry.set([ORG, "demo"], () => ({
      ping: async () => JSON.stringify({ from: "org" }),
    }))
    const methods = buildBridgeExtensions(ctx("demo"))
    expect(Object.keys(methods)).toEqual(["ping"])
    // Pin the precedence its title claims: the org-scoped factory must win, so
    // invoking ping returns the org payload — not the wildcard one.
    expect(JSON.parse(await methods.ping(JSON.stringify({})))).toEqual({ from: "org" })
  })

  it("createRpcBridge exposes an app's extension methods only to that app", async () => {
    appBridgeExtensionRegistry.set([ORG, "demo"], (c) => ({
      demo_echo: async (paramsJson: string) =>
        JSON.stringify({ app: c.appName, params: JSON.parse(paramsJson) }),
    }))

    const manifest = { name: "demo", capabilities: [] }
    const ownBridge = createRpcBridge("demo", "system", ORG, txDb, manifest)
    expect(typeof ownBridge.demo_echo).toBe("function")
    const out = JSON.parse(await ownBridge.demo_echo(JSON.stringify({ x: 1 })))
    expect(out).toEqual({ app: "demo", params: { x: 1 } })

    // A different app gets a bridge WITHOUT the demo extension — no app-name
    // literal gates it; the registry simply has no entry for this app.
    const otherBridge = createRpcBridge("other", "system", ORG, txDb, { name: "other" })
    expect(otherBridge.demo_echo).toBeUndefined()
  })
})
