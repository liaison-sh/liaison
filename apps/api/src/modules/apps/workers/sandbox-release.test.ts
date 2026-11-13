// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NETWORK_OPEN_CODE } from "@liaison/sandbox-supervisor"
import { env } from "~/lib/env"
import { probeSandbox } from "./sandbox-release"

const mutable = env as unknown as Record<string, string | undefined>

describe("the sandbox dependency of /healthz", () => {
  const saved = mutable.LIAISON_SANDBOX_URL
  beforeEach(() => {
    mutable.LIAISON_SANDBOX_URL = "http://sandbox:8790"
  })
  afterEach(() => {
    mutable.LIAISON_SANDBOX_URL = saved
  })

  const answer = (status: number, body: unknown) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch

  it("is network_open while the service finds more than the bridge port reachable", async () => {
    const r = await probeSandbox({
      fetchImpl: answer(503, {
        ok: false,
        code: NETWORK_OPEN_CODE,
        message: "The sandbox service can reach 10.73.250.1:22",
      }),
    })
    expect(r).toEqual({
      status: "network_open",
      message: "The sandbox service can reach 10.73.250.1:22",
    })
  })

  it("is ok when the network is closed and the bridge answers", async () => {
    const r = await probeSandbox({
      fetchImpl: answer(200, { ok: true, release: "r1", bridge: "ok", network: "closed" }),
    })
    expect(r).toEqual({ status: "ok", release: "r1" })
  })

  it("is no dependency while LIAISON_APP_RUNTIME=quickjs runs every app elsewhere", async () => {
    const savedRuntime = mutable.LIAISON_APP_RUNTIME
    mutable.LIAISON_APP_RUNTIME = "quickjs"
    try {
      let called = false
      const r = await probeSandbox({
        fetchImpl: (async () => {
          called = true
          return Response.json({}, { status: 503 })
        }) as unknown as typeof fetch,
      })
      expect(r).toBeNull()
      expect(called).toBe(false)
    } finally {
      mutable.LIAISON_APP_RUNTIME = savedRuntime
    }
  })
})
