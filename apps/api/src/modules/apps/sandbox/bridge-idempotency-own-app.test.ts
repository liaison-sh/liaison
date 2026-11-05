// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.invalidateIdempotency releases a key of the calling app's own tools only.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as idempotencyModule from "~/modules/apps/idempotency"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-0000-0000-0000000e1001"
const APP = "widgets"
const tx = { execute: mock(async () => []), queueEvent: mock(async () => {}) }
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

let calls: string[][]
let spy: ReturnType<typeof spyOn>
beforeEach(() => {
  calls = []
  spy = spyOn(idempotencyModule, "invalidateIdempotency").mockImplementation((async (
    ...args: string[]
  ) => {
    calls.push(args)
  }) as never)
})
afterEach(() => spy.mockRestore())

describe("ctx.invalidateIdempotency", () => {
  const bridge = () => createRpcBridge(APP, `system:${APP}`, ORG, tx as never, manifest as never)

  it("releases a key of the app's own tool", async () => {
    await bridge().invalidateIdempotency(`${APP}:send`, "k1")
    expect(calls).toEqual([[ORG, `${APP}:send`, "k1"]])
  })

  it("refuses another app's tool", async () => {
    await expect(bridge().invalidateIdempotency("mail:compose", "k1")).rejects.toThrow(
      /own idempotency keys/,
    )
    await expect(bridge().invalidateIdempotency(`${APP}x:send`, "k1")).rejects.toThrow()
    expect(calls).toEqual([])
  })
})
