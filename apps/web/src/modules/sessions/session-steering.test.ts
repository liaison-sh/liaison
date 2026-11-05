// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T16 (D55): the steering actions P2's request cards and header call are
// registered in the session action registry and each sends its command.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toasts } from "~/modules/shell/toast-store"
import { resetSessionActions, sessionActions } from "./session-actions"
import { resetSessionCommands, setSessionCommandsApi } from "./session-commands"
import { ensureSteeringActions } from "./session-steering"

const ID = "11111111-2222-4333-8444-555555555555"

function fakeApi() {
  let n = 0
  const post = vi.fn(async (_path: string, _body?: unknown) => {
    n++
    return { commandId: `00000000-0000-4000-8000-00000000000${n}`, seq: n }
  })
  return { post, get: vi.fn(async () => ({ commands: [] })) }
}

let api: ReturnType<typeof fakeApi>
beforeEach(() => {
  resetSessionActions()
  resetSessionCommands()
  api = fakeApi()
  setSessionCommandsApi(() => api as never)
  ensureSteeringActions()
})
afterEach(() => {
  resetSessionActions()
  resetSessionCommands()
})

const bodies = () => api.post.mock.calls.map((c) => c[1])

describe("P3-T16 steering actions in the registry", () => {
  it("registers stop, permission decisions, answers and plan decisions, once", () => {
    const a = sessionActions()
    expect(typeof a.stop).toBe("function")
    expect(typeof a.decidePermission).toBe("function")
    expect(typeof a.answerQuestion).toBe("function")
    expect(typeof a.decidePlan).toBe("function")
    expect(ensureSteeringActions()).toBeNull()
  })

  it("a permission card's three buttons send once, session and deny", async () => {
    const a = sessionActions()
    await a.decidePermission?.(ID, "toolu_1", true, "once")
    await a.decidePermission?.(ID, "toolu_1", true, "session")
    await a.decidePermission?.(ID, "toolu_1", false, "once")
    expect(bodies()).toEqual([
      {
        type: "permission_decision",
        payload: { requestId: "toolu_1", allow: true, scope: "once" },
      },
      {
        type: "permission_decision",
        payload: { requestId: "toolu_1", allow: true, scope: "session" },
      },
      {
        type: "permission_decision",
        payload: { requestId: "toolu_1", allow: false, scope: "once" },
      },
    ])
  })

  it("an answer sends the answers; Approve plan sends allow, Keep planning deny; Stop sends stop", async () => {
    const a = sessionActions()
    await a.answerQuestion?.(ID, "toolu_q", { "Pick?": "A, B" })
    await a.decidePlan?.(ID, "toolu_p", true)
    await a.decidePlan?.(ID, "toolu_p", false)
    await a.stop?.(ID)
    expect(bodies()).toEqual([
      { type: "answer", payload: { requestId: "toolu_q", answers: { "Pick?": "A, B" } } },
      {
        type: "permission_decision",
        payload: { requestId: "toolu_p", allow: true, scope: "once" },
      },
      {
        type: "permission_decision",
        payload: { requestId: "toolu_p", allow: false, scope: "once" },
      },
      { type: "stop", payload: {} },
    ])
    expect(api.post.mock.calls.every((c) => c[0] === `/me/node-sessions/${ID}/commands`)).toBe(true)
  })

  it("a refused command shows a toast saying what failed and rejects", async () => {
    api.post.mockRejectedValueOnce(new Error("session not found"))
    await expect(sessionActions().stop?.(ID)).rejects.toThrow("session not found")
    expect(toasts().at(-1)).toMatchObject({ type: "error", message: "Not sent: session not found" })
  })
})
