// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetCatalogNotifier,
  onCatalogEvent,
  registerActiveServer,
  unregisterActiveServer,
} from "~/modules/mcp/catalog-notifier"

const ORG = "00000000-0000-4000-c000-00000000c001"
const OWNER = "00000000-0000-4000-c000-00000000c002"

function fakeServer(id: string, orgId = ORG, ownerId = OWNER) {
  let calls = 0
  return {
    register: () =>
      registerActiveServer({
        connectionId: id,
        orgId,
        ownerId,
        sendListChanged: () => {
          calls += 1
        },
      }),
    get calls() {
      return calls
    },
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("mcp catalog notifier", () => {
  afterEach(() => __resetCatalogNotifier())

  it("app-lifecycle event → exactly one list_changed within debounce", async () => {
    const s = fakeServer("c1")
    s.register()
    onCatalogEvent({ orgId: ORG, entity: "app", action: "install" })
    await wait(350)
    expect(s.calls).toBe(1)
  })

  it("permission-change event affecting the owner → one list_changed", async () => {
    const s = fakeServer("c2")
    s.register()
    onCatalogEvent({
      orgId: ORG,
      entity: "user_scope",
      action: "grant",
      // Real event contract: permissions/roles.ts emits data.targetUserId.
      data: { targetUserId: OWNER },
    })
    await wait(350)
    expect(s.calls).toBe(1)
  })

  it("burst of 5 events within the window → exactly one (coalesced)", async () => {
    const s = fakeServer("c3")
    s.register()
    for (let i = 0; i < 5; i++) onCatalogEvent({ orgId: ORG, entity: "app", action: "install" })
    await wait(350)
    expect(s.calls).toBe(1)
  })

  it("event for an org with no active connection → no-op, no throw", async () => {
    expect(() =>
      onCatalogEvent({
        orgId: "00000000-0000-4000-c000-00000000c099",
        entity: "app",
        action: "install",
      }),
    ).not.toThrow()
  })

  it("after unregister, subsequent events do not call the stub", async () => {
    const s = fakeServer("c4")
    s.register()
    unregisterActiveServer("c4")
    onCatalogEvent({ orgId: ORG, entity: "app", action: "install" })
    await wait(350)
    expect(s.calls).toBe(0)
  })

  it("permission change for a different user does not notify this owner", async () => {
    const s = fakeServer("c5")
    s.register()
    onCatalogEvent({
      orgId: ORG,
      entity: "user_scope",
      action: "grant",
      data: { targetUserId: "00000000-0000-4000-c000-00000000c0ff" },
    })
    await wait(350)
    expect(s.calls).toBe(0)
  })

  it("stateless transport reality: a permission change after the request ends is NOT pushed (reconnect is the guarantee — spec Amendment 2)", async () => {
    // Mirrors the production transport lifecycle: the connection is registered
    // only for the duration of one sub-second request and unregistered in the
    // `finally`. A permission change arriving after that window has no held
    // stream to push into — criterion 10's in-session push is best-effort;
    // correctness is guaranteed by reconnect (fresh tools/list recompute).
    const s = fakeServer("c7")
    s.register()
    unregisterActiveServer("c7") // request ended
    onCatalogEvent({
      orgId: ORG,
      entity: "user_scope",
      action: "grant",
      data: { targetUserId: OWNER },
    })
    await wait(350)
    expect(s.calls).toBe(0)
  })

  it("role-level permission change (no targetUserId) notifies all org connections", async () => {
    const s = fakeServer("c6")
    s.register()
    // role_scope carries only roleId — affects every user with that role, so
    // it must NOT be per-user filtered.
    onCatalogEvent({
      orgId: ORG,
      entity: "role_scope",
      action: "grant",
      data: { roleId: "00000000-0000-4000-c000-00000000c0aa" },
    })
    await wait(350)
    expect(s.calls).toBe(1)
  })
})
