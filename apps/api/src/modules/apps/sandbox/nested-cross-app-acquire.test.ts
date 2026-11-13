// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A cross-app `ctx.executeTool` hop runs INSIDE a sandbox execution: the calling
// handler holds a worker of the same pool and is blocked until the nested call
// answers. The pool can only keep that call off the queue behind its own caller
// if the dispatch says it is nested, so this pins the wiring, not the policy
// (worker-pool.test.ts owns the policy). Without the flag the pool sees a plain
// acquire and the measured shape is a prepare-queue read whose cross-app draft
// resolutions time out one by one.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { writeFileSync } from "node:fs"
import { executeToolHandler } from "~/modules/apps/execute-tool"
import { armExecutionTokenObserver } from "~/modules/apps/execution-token"
import {
  getWorkerPool,
  initWorkerPool,
  shutdownWorkerPool,
} from "~/modules/apps/sandbox/worker-pool"

const APP = "nestedacquiretest"
const ORG = "00000000-0000-0000-0000-0000000f0a01"
const USER = "00000000-0000-0000-0000-0000000f0a02"
const BUNDLE_PATH = "/tmp/test-nested-cross-app-acquire-bundle.js"

const TOOL = {
  appName: APP,
  name: `${APP}:read`,
  gated: false,
  handler: { __manifestHandler: true, exportName: "read", bundlePath: BUNDLE_PATH, core: false },
  _manifest: { name: APP, schema: {}, events: {}, connections: {}, network: {} },
} as any

/** The single `pool.execute` this dispatch makes, with the spy torn down. */
async function dispatchOptions(bridgeOptions: {
  callChain: string[]
  parentExecutionToken?: string
}): Promise<any> {
  const calls: any[] = []
  const spy = spyOn(getWorkerPool(), "execute").mockImplementation(async (opts: any) => {
    calls.push(opts)
    return { ok: true }
  })
  try {
    await executeToolHandler(
      TOOL,
      TOOL.handler,
      USER,
      ORG,
      ["*"],
      null,
      {},
      undefined,
      bridgeOptions,
    )
  } finally {
    spy.mockRestore()
  }
  expect(calls).toHaveLength(1)
  return calls[0]
}

/** Several dispatches CONCURRENTLY, under one spy, in call order. */
async function dispatchConcurrently(
  all: Array<{ callChain: string[]; parentExecutionToken?: string }>,
): Promise<any[]> {
  const calls: any[] = []
  const spy = spyOn(getWorkerPool(), "execute").mockImplementation(async (opts: any) => {
    calls.push(opts)
    return { ok: true }
  })
  try {
    await Promise.all(
      all.map((bridgeOptions) =>
        executeToolHandler(
          TOOL,
          TOOL.handler,
          USER,
          ORG,
          ["*"],
          null,
          {},
          undefined,
          bridgeOptions,
        ),
      ),
    )
  } finally {
    spy.mockRestore()
  }
  expect(calls).toHaveLength(all.length)
  return calls
}

async function dispatchWithCallChain(callChain: string[]): Promise<boolean> {
  return (await dispatchOptions({ callChain })).nested === true
}

// One pool for the whole file: the dispatch spy never lets an execution reach
// a worker, so every describe here can share it.
beforeAll(async () => {
  writeFileSync(BUNDLE_PATH, `function read(params, ctx) { return { ok: true } }\n`)
  await initWorkerPool({ size: 1, maxSize: 1 })
})

afterAll(async () => {
  await shutdownWorkerPool()
})

describe("cross-app dispatch tells the sandbox pool it is nested", () => {
  it("marks a dispatch whose call chain already holds a caller as nested", async () => {
    expect(await dispatchWithCallChain(["boxtal:to_prepare_list", "invoicing:documents_get"])).toBe(
      true,
    )
  })

  it("does not mark a top level dispatch as nested", async () => {
    expect(await dispatchWithCallChain(["boxtal:to_prepare_list"])).toBe(false)
  })
})

// The pool bounds one handler's fan-out by `nestedParentKey`, so that key has
// to name the EXECUTION the fan-out belongs to. Keyed on the chain of tool
// names instead, two concurrent, independent executions of the same chain
// shared one budget: the second one's first hop was demoted to queued work
// behind the first one's, with no caller in common between them.
describe("the nested breadth key names the parent execution, not the chain", () => {
  const CHAIN = ["boxtal:to_prepare_list", "invoicing:documents_get"]

  it("gives two concurrent executions of the same chain a key each", async () => {
    const [first, second] = await dispatchConcurrently([
      { callChain: CHAIN, parentExecutionToken: "execution-one" },
      { callChain: CHAIN, parentExecutionToken: "execution-two" },
    ])
    expect(first.nestedParentKey).toBeTruthy()
    expect(second.nestedParentKey).toBeTruthy()
    expect(first.nestedParentKey).not.toBe(second.nestedParentKey)
  })

  it("gives two hops of ONE execution the same key, whatever tools they are", async () => {
    const left = await dispatchOptions({
      callChain: ["boxtal:to_prepare_list", "invoicing:documents_get"],
      parentExecutionToken: "execution-one",
    })
    const right = await dispatchOptions({
      callChain: ["boxtal:to_prepare_list", "shopify:orders_get"],
      parentExecutionToken: "execution-one",
    })
    expect(left.nestedParentKey).toBe("execution-one")
    expect(right.nestedParentKey).toBe("execution-one")
  })

  it("gives a grandchild the key of the execution that opened it", async () => {
    const child = await dispatchOptions({
      callChain: ["boxtal:to_prepare_list", "invoicing:documents_get"],
      parentExecutionToken: "execution-one",
    })
    const grandchild = await dispatchOptions({
      callChain: ["boxtal:to_prepare_list", "invoicing:documents_get", "shopify:orders_get"],
      parentExecutionToken: "execution-two",
    })
    expect(grandchild.nestedParentKey).toBe("execution-two")
    expect(grandchild.nestedParentKey).not.toBe(child.nestedParentKey)
  })

  it("leaves a top level dispatch unkeyed, since it has no parent execution", async () => {
    const top = await dispatchOptions({ callChain: ["boxtal:to_prepare_list"] })
    expect(top.nestedParentKey).toBeUndefined()
  })

  // The cases above hand the key in, so they pin what the pool does with a key
  // it is GIVEN. Where the key comes from is the other half: the token is minted
  // inside the dispatch and only ever reaches the bridge closure, so replacing
  // the mint with a single constant left every one of them green while two
  // concurrent executions of the same chain shared one breadth budget again.
  it("mints a key per execution, so two concurrent executions never share one", async () => {
    const minted: string[] = []
    const disarm = armExecutionTokenObserver((token) => minted.push(token))
    try {
      await dispatchConcurrently([{ callChain: CHAIN }, { callChain: CHAIN }])
    } finally {
      disarm()
    }
    expect(minted).toHaveLength(2)
    expect(new Set(minted).size).toBe(2)

    // And a hop each execution opens arrives at the pool under ITS token, which
    // is what gives each of them the full MAX_NESTED_BREADTH_PER_PARENT the pool
    // grants per key (worker-pool.test.ts owns that budget).
    const fromFirst = await dispatchOptions({
      callChain: [...CHAIN, "shopify:orders_get"],
      parentExecutionToken: minted[0],
    })
    const fromSecond = await dispatchOptions({
      callChain: [...CHAIN, "shopify:orders_get"],
      parentExecutionToken: minted[1],
    })
    expect(fromFirst.nestedParentKey).toBe(minted[0])
    expect(fromSecond.nestedParentKey).toBe(minted[1])
    expect(fromFirst.nestedParentKey).not.toBe(fromSecond.nestedParentKey)
  })
})
