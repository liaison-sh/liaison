// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { cleanupSeededOrg, seedApprovedGatedRequest } from "~/modules/mcp/test-helpers"

describe("decided-result persistence", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("persists the decided tool result and reads it back by approvalRequestId", async () => {
    const { orgId, approvalRequestId, expectedResult } = await seedApprovedGatedRequest()
    orgs.push(orgId)

    const persisted = await readDecidedResult(orgId, approvalRequestId)
    expect(persisted).toEqual(expectedResult)
  }, 30_000)

  it("returns null for an approval with no decided result yet", async () => {
    const { orgId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    expect(await readDecidedResult(orgId, approvalRequestId)).toBeNull()
  }, 30_000)
})
