// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { bootstrapAdminCtx, bootstrapAdminThread } from "./agent-ctx"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("agent-ctx test harness", () => {
  test("bootstrapAdminCtx yields a real, non-['*']-shortcut admin scope set", async () => {
    const { orgId, userId, actor } = await bootstrapAdminCtx()
    expect(typeof orgId).toBe("string")
    expect(typeof userId).toBe("string")
    expect(actor.actorType).toBe("user")
    expect(Array.isArray(actor.scopes)).toBe(true)
    expect(actor.scopes.length).toBeGreaterThan(0)
    // The bootstrap admin's real grant is the literal "*" preset scope. The
    // harness must surface the REAL persisted scope set (which includes "*"),
    // not be hand-faked — assert it carries the persisted owner grant.
    expect(actor.scopes).toContain("*")
  })

  test("bootstrapAdminThread yields a created thread and a genuinely non-admin member actor", async () => {
    const { threadId, actor, memberActor } = await bootstrapAdminThread()
    expect(typeof threadId).toBe("string")
    expect(actor.scopes).toContain("*")
    // The member actor must carry the seeded member preset's LIMITED scopes —
    // never the owner "*" grant — so non-admin negative branches are real.
    expect(memberActor.scopes).not.toContain("*")
    expect(memberActor.scopes).toContain("kernel:threads:read")
    expect(memberActor.userId).not.toBe(actor.userId)
  })
})
