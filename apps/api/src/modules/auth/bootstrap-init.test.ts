// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  agentInstructionsRegistry,
  registeredApps,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { bootstrapRegister } from "~/modules/auth/auth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("bootstrapRegister initializes app registries", () => {
  let orgId = ""

  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    if (orgId) {
      toolRegistry.deleteByPrefix([orgId])
      skillRegistry.deleteByPrefix([orgId])
      agentInstructionsRegistry.deleteByPrefix([orgId])
      registeredApps.delete(`${orgId}:test`)
    }
    await releaseTestLock()
  })

  it("registers kernel tools for a newly bootstrapped org without restart", async () => {
    const tokens = await bootstrapRegister(
      "bootstrap-init@test.com",
      "TestPass123!",
      "Bootstrap Init",
    )
    expect(tokens.accessToken).toBeString()

    const payload = JSON.parse(
      Buffer.from(tokens.accessToken.split(".")[1]!, "base64url").toString("utf8"),
    )
    orgId = payload.orgId

    expect(toolRegistry.get([orgId, "kernel", "threads_list"])).toBeDefined()
    expect(toolRegistry.get([orgId, "kernel", "threads_search"])).toBeDefined()
    expect(agentInstructionsRegistry.get([orgId, "kernel"])).toBeDefined()
    expect(registeredApps.has(`${orgId}:test`)).toBe(true)
  })
})
