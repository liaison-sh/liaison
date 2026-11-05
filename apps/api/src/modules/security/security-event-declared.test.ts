// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * An org's security signal reaches its admins only when the kernel declares the
 * event it becomes: an undeclared one throws at the outbox and no alert is made.
 */
import { describe, expect, it } from "bun:test"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { securityAppEvent } from "~/modules/security/security-events"

describe("security event emit", () => {
  it("is a declared kernel event", () => {
    const event = securityAppEvent({
      kind: "admin_signin_new_ip",
      orgId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
    })
    expect(event.app).toBe("kernel")
    expect(KERNEL_DECLARED_EMITS.has(`${event.entity}:${event.action}`)).toBe(true)
  })
})
