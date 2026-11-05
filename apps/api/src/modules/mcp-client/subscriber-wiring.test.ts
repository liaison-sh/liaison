// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T24 — Subscriber-wiring contract. The handler `handleResourceUpdated` is
// unit-tested in isolation in `resource-notifier.test.ts`. This file locks the
// surface that Task 33 will wire to the event bus: the handler is exported as
// an `(event: AppEvent) => Promise<void>` and can be passed directly to
// `onEvent(...)` / `subscribeToEvent(...)`.
import { describe, expect, it } from "bun:test"
import type { AppEvent } from "~/infra/events/event-bus"
import { handleResourceUpdated } from "./resource-notifier"

describe("mcp-client subscriber-wiring contract", () => {
  it("handleResourceUpdated is assignable to the AppEvent global handler signature", () => {
    // Type-level assertion — if the signature drifts, this won't compile.
    const handler: (event: AppEvent) => Promise<void> = handleResourceUpdated
    expect(typeof handler).toBe("function")
  })

  it("handleResourceUpdated tolerates a freestanding event (no-op, no throw)", async () => {
    await expect(
      handleResourceUpdated({
        app: "mcp",
        entity: "resource",
        action: "updated",
        orgId: "00000000-0000-0000-0000-000000000000",
        data: {
          connection_id: "00000000-0000-0000-0000-000000000001",
          uri: "file:///x",
          subscriber_actor_id: "00000000-0000-0000-0000-000000000002",
          subscriber_actor_type: "agent",
          // no thread_id → drops silently
        },
      }),
    ).resolves.toBeUndefined()
  })
})
