// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { buildMcpWorld } from "./world"

describe("buildMcpWorld", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  it("returns two orgs, four users, and a roles map", async () => {
    const w = await buildMcpWorld()
    expect(w.org.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.otherOrg.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.org.id).not.toBe(w.otherOrg.id)
    expect(w.admin.actorType).toBe("user")
    expect(w.admin.orgId).toBe(w.org.id)
    expect(w.admin.scopes).toContain("mcp_manager:connection:write")
    expect(w.alice.orgId).toBe(w.org.id)
    expect(w.bob.orgId).toBe(w.org.id)
    expect(w.bob.scopes).not.toContain("mcp_manager:connection:write")
    expect(w.otherAdmin.orgId).toBe(w.otherOrg.id)
    expect(w.otherAdmin.scopes).toContain("mcp_manager:connection:write")
    expect(w.roles.editor).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.roles.viewer).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.roles.editor).not.toBe(w.roles.viewer)
  })
})
