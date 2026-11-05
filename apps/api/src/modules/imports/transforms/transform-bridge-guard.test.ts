// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GUARD ORACLE: the transform bridge and the app RPC bridge never meet.
//
// 1. The transform bridge exposes exactly emitRecords, declareFile,
//    downloadToFile and apiGet, and none of those is an app bridge method;
//    no app bridge method is a transform bridge method either (both ways).
// 2. Only `buildTransformBridge` builds it, and only the transform modules
//    call it, so no app bundle call path can be handed a transform bridge.
// 3. The transform modules never build an app bridge nor drive the app pool,
//    so a transform cannot be handed app methods.
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { RlsClient } from "~/db"
import type { RlsSession } from "~/db/rls"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { buildTransformBridge, TRANSFORM_BRIDGE_METHODS } from "./bridge"

const poisonTx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`bridge construction touched txDb.${String(prop)}`)
    },
  },
) as unknown as RlsClient

const ORG = "00000000-0000-0000-0000-00000000d0a1"
const USER = "00000000-0000-0000-0000-00000000d0a2"

function appBridgeMethodNames(): string[] {
  const ambient = Object.keys(
    createRpcBridge("guard-probe", USER, ORG, poisonTx, { name: "guard-probe" }),
  )
  const session = {
    run: async () => {
      throw new Error("no bridge method is invoked in this test")
    },
  } as unknown as RlsSession
  const sessionKeys = Object.keys(
    createSessionRpcBridge("guard-probe", USER, ORG, session, { name: "guard-probe" }),
  )
  return [...new Set([...ambient, ...sessionKeys])]
}

const SRC_ROOT = path.resolve(__dirname, "../../..")
const TRANSFORMS_DIR = "modules/imports/transforms/"

function productionFiles(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop() as string
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__test-helpers__") continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(path.relative(SRC_ROOT, full))
      }
    }
  }
  return out
}

describe("transform bridge method set", () => {
  it("is exactly the four transform methods", () => {
    const bridge = buildTransformBridge({ sourceType: "upload", kinds: [] })
    expect(Object.keys(bridge.methods).sort()).toEqual(
      ["apiGet", "declareFile", "downloadToFile", "emitRecords"].sort(),
    )
    const declared: string[] = [...TRANSFORM_BRIDGE_METHODS]
    expect(declared.sort()).toEqual(Object.keys(bridge.methods).sort())
  })

  it("shares no name with the app RPC bridge, in either direction", () => {
    const app = appBridgeMethodNames()
    expect(app.length).toBeGreaterThan(50)
    const transform = Object.keys(buildTransformBridge({ sourceType: "api", kinds: [] }).methods)
    expect(transform.filter((m) => app.includes(m))).toEqual([])
    expect(app.filter((m) => transform.includes(m))).toEqual([])
  })
})

describe("transform bridge reachability", () => {
  const files = productionFiles(SRC_ROOT)

  it("only the transform modules build or receive a transform bridge", () => {
    const outside = files.filter(
      (f) =>
        !f.startsWith(TRANSFORMS_DIR) &&
        fs.readFileSync(path.join(SRC_ROOT, f), "utf8").includes("buildTransformBridge"),
    )
    expect(outside).toEqual([])
    const builders = files.filter((f) =>
      /export function buildTransformBridge\b/.test(
        fs.readFileSync(path.join(SRC_ROOT, f), "utf8"),
      ),
    )
    expect(builders).toEqual(["modules/imports/transforms/bridge.ts"])
  })

  it("the transform modules never build an app bridge or use the app pool", () => {
    const forbidden = [
      "createRpcBridge",
      "createSessionRpcBridge",
      "getWorkerPool",
      "executeInSandbox",
      "sandbox/rpc-bridge",
      "sandbox/bridge/",
    ]
    const hits = files
      .filter((f) => f.startsWith(TRANSFORMS_DIR))
      .flatMap((f) => {
        const text = fs.readFileSync(path.join(SRC_ROOT, f), "utf8")
        return forbidden.filter((m) => text.includes(m)).map((m) => `${f}: ${m}`)
      })
    expect(hits).toEqual([])
  })
})
