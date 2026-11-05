// SPDX-License-Identifier: FSL-1.1-ALv2
// Deployments are configured through MCP and the provisioning CLI, so the agent
// context never carries an in-product first-run setup block, not even for an
// admin in a brand-new org with nothing enabled.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { bootstrapAdminThread } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { assembleContext, resetSystemPromptCache, systemPartsToText } from "./context"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("agent context: no first-run setup block", () => {
  beforeEach(() => resetSystemPromptCache())

  test("admin turn in an org with no setup state and no enabled apps carries no first-run setup block", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const { system } = await assembleContext({ threadId, orgId, actor })
    const text = systemPartsToText(system)
    expect(text).not.toContain("First-run setup")
    expect(text).not.toContain("Pending steps:")
  })
})
