// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T22 (S7, G12): Show full output asks the node through the server, then
// reads until the output is there (202 while pending), 60 s at most; an
// offline node or a gone file reads as null (the row says it is on the
// computer). The action is registered for P2's tool row.
import { afterEach, describe, expect, it, vi } from "vitest"
import { FULL_OUTPUT_ROUTES, fullOutput, setFullOutputApi } from "./full-output"
import { resetSessionActions, sessionActions } from "./session-actions"
import { ensureSteeringActions } from "./session-steering"

const ID = "11111111-2222-4333-8444-555555555555"
const TOOL = "toolu_01ABC"

const res = (status: number, body = "") => new Response(status === 202 ? null : body, { status })

function fakeApi(post: Response, gets: Response[]) {
  const rawPost = vi.fn(async (_p: string, _b?: unknown, _i?: unknown) => post)
  const rawGet = vi.fn(async (_p: string, _i?: unknown) => gets.shift() ?? res(202))
  return { rawPost, rawGet }
}

const noWait = { sleep: async () => {} }

afterEach(() => {
  resetSessionActions()
  setFullOutputApi(() => null)
})

describe("P3-T22 full output", () => {
  it("asks once, then returns the output once ready", async () => {
    const api = fakeApi(res(202), [res(202), res(202), res(200, "1\n2\n3\n")])
    setFullOutputApi(() => api as never)
    expect(await fullOutput(ID, TOOL, noWait)).toBe("1\n2\n3\n")
    expect(api.rawPost).toHaveBeenCalledTimes(1)
    expect(api.rawPost.mock.calls[0]?.slice(0, 2)).toEqual([
      FULL_OUTPUT_ROUTES.ask(ID),
      { toolUseId: TOOL },
    ])
    expect(api.rawGet).toHaveBeenCalledTimes(3)
    expect(api.rawGet.mock.calls[0]?.[0]).toBe(`/me/node-sessions/${ID}/full-output/${TOOL}`)
  })

  it("an offline node (404 on ask) or a gone file (404 on read) is null", async () => {
    setFullOutputApi(() => fakeApi(res(404), []) as never)
    expect(await fullOutput(ID, TOOL, noWait)).toBeNull()
    setFullOutputApi(() => fakeApi(res(202), [res(404)]) as never)
    expect(await fullOutput(ID, TOOL, noWait)).toBeNull()
  })

  it("stops polling after 60 s and reads as null", async () => {
    const api = fakeApi(res(202), [])
    setFullOutputApi(() => api as never)
    const sleep = vi.fn(async () => {})
    expect(await fullOutput(ID, TOOL, { sleep, pollMs: 2_000, maxMs: 60_000 })).toBeNull()
    expect(api.rawGet).toHaveBeenCalledTimes(30)
    expect(sleep).toHaveBeenCalledTimes(29)
  })

  it("a tool id that is not toolu_… asks nothing", async () => {
    const api = fakeApi(res(202), [])
    setFullOutputApi(() => api as never)
    expect(await fullOutput(ID, "../x", noWait)).toBeNull()
    expect(api.rawPost).not.toHaveBeenCalled()
  })

  it("is registered as P2's fullOutput action", async () => {
    resetSessionActions()
    ensureSteeringActions()
    setFullOutputApi(() => fakeApi(res(202), [res(200, "all of it")]) as never)
    expect(await sessionActions().fullOutput?.(ID, TOOL)).toBe("all of it")
  })
})
