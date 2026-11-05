// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A2 reactive visibility, org containment. A grant change in org A must reach
// only the affected user's sockets IN ORG A.
//
// One person can belong to several orgs and keep a tab open in each, and each
// tab holds its own socket carrying its own `orgId`. Matching connections on
// the user id alone therefore delivered org A's thread ids onto the org B
// socket. The payload is opaque thread uuids that only trigger a refetch under
// RLS, so nothing readable crossed, but it is still a cross-org signal and it
// falsified the containment argument written for `grant-invalidation.ts`.

import { describe, expect, it, mock, spyOn } from "bun:test"
import { WebSocketManager } from "~/infra/websocket"
import * as grantInvalidation from "~/services/security/grant-invalidation"

const ORG_A = "org-a"
const ORG_B = "org-b"
const USER = "user-in-both-orgs"

function openWs(): {
  send: ReturnType<typeof mock>
  close: ReturnType<typeof mock>
  readyState: number
} {
  return { send: mock(() => {}), close: mock(() => {}), readyState: 1 }
}

function invalidatesOf(ws: { send: ReturnType<typeof mock> }): Array<Record<string, unknown>> {
  return ws.send.mock.calls
    .map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>)
    .filter((frame) => frame.type === "visibility:invalidate")
}

/**
 * The redis calls `bufferAndBroadcast` makes on a direct (non fan-out) call: the
 * sequence `incr`, then the replay buffer append, one Lua script
 * (websocket-replay-buffer.ts).
 */
const stubRedis = {
  incr: mock(async () => 1),
  eval: mock(async () => 0),
}

function manager(): WebSocketManager {
  return new WebSocketManager(stubRedis as never)
}

describe("visibility invalidate is delivered inside the event's own org", () => {
  it("a user with a socket in two orgs receives the frame only on the org the grant changed in", () => {
    const vm = manager()
    const inA = openWs()
    const inB = openWs()
    vm.addConnection(USER, inA, ["kernel"], ORG_A)
    vm.addConnection(USER, inB, ["kernel"], ORG_B)

    vm.emitVisibilityInvalidate(ORG_A, USER, ["thread-in-org-a"])

    expect(invalidatesOf(inA)).toEqual([
      { type: "visibility:invalidate", threadIds: ["thread-in-org-a"] },
    ])
    // The other org's tab is a different session with a different scope set:
    // it learns nothing, not even that a thread of org A changed.
    expect(invalidatesOf(inB)).toHaveLength(0)
    expect(inB.send).not.toHaveBeenCalled()
  })

  it("every socket the user has in that org is reached, and no other user's", () => {
    const vm = manager()
    const a1 = openWs()
    const a2 = openWs()
    const other = openWs()
    vm.addConnection(USER, a1, ["kernel"], ORG_A)
    vm.addConnection(USER, a2, ["kernel"], ORG_A)
    vm.addConnection("someone-else", other, ["kernel"], ORG_A)

    vm.emitVisibilityInvalidate(ORG_A, USER, ["thread-in-org-a"])

    expect(invalidatesOf(a1)).toHaveLength(1)
    expect(invalidatesOf(a2)).toHaveLength(1)
    expect(invalidatesOf(other)).toHaveLength(0)
  })

  it("the grant event drain delivers into the event's org only", async () => {
    const vm = manager()
    const inA = openWs()
    const inB = openWs()
    vm.addConnection(USER, inA, ["kernel"], ORG_A)
    vm.addConnection(USER, inB, ["kernel"], ORG_B)
    const resolveSpy = spyOn(grantInvalidation, "resolveGrantInvalidations").mockImplementation(
      async () => [{ userId: USER, threadIds: ["thread-in-org-a"] }],
    )
    try {
      await vm.bufferAndBroadcast({
        app: "kernel",
        entity: "user_scope",
        action: "grant",
        entityId: USER,
        orgId: ORG_A,
        data: { targetUserId: USER, scope: "kernel:threads:read" },
      })
    } finally {
      resolveSpy.mockRestore()
    }

    expect(invalidatesOf(inA)).toEqual([
      { type: "visibility:invalidate", threadIds: ["thread-in-org-a"] },
    ])
    expect(invalidatesOf(inB)).toHaveLength(0)
  })
})
