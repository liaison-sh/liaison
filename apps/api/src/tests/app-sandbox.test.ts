// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { withRlsContext } from "~/db/rls"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createAppContext } from "~/modules/apps/context"
import { validateAppDescriptor } from "~/modules/apps/contract"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000000050"

describe("App sandbox", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("emit rejects cross-app impersonation", async () => {
    await withRlsContext(
      { actorType: "system", orgId: ORG_ID, purpose: "job", scopes: ["kernel"] },
      async (tx) => {
        const ctx = createAppContext("test", "user1", ORG_ID, tx)
        await expect(
          ctx.emit({
            app: "kernel",
            entity: "user",
            action: "registered",
            entityId: "1",
            orgId: ORG_ID,
            data: {},
            actorId: "user1",
            actorType: "user",
          }),
        ).rejects.toThrow('App "test" cannot emit events on behalf of "kernel"')
      },
    )
  })

  it("validated descriptor preserves trustBoundary", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Test tool",
          requiredScopes: ["test:items:read"],
          handler: () => {},
          trustBoundary: "internal",
        },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data.tools.myTool.trustBoundary).toBe("internal")
  })

  it("enqueueAppJob rejects undeclared job names", async () => {
    // The app name is this file's own, not the shared "test": the job handler
    // registry is process-wide, and once this file shares a bun process with
    // any other that registers jobs for an app called "test", a fixture keyed
    // on that name stops being an undeclared one. The claim is unchanged -
    // enqueueing a job nobody registered throws - and now nothing else in the
    // process can satisfy it by accident.
    await expect(enqueueAppJob("app-sandbox-fixture", "nonexistent-job", {})).rejects.toThrow(
      "No handler registered",
    )
  })

  it("approvalCard rejects non-record values (XSS prevention)", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Test",
          requiredScopes: ["test:items:read"],
          handler: () => {},
          approvalCard: "<script>alert(1)</script>",
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("executeTool rejects non-system actor for internal trustBoundary", async () => {
    // Register a tool with trustBoundary: "internal" directly in the registry
    const toolKey = [ORG_ID, "sandbox-test", "internal-tool"] as [string, string, string]
    toolRegistry.set(toolKey, {
      appName: "sandbox-test",
      name: "internal-tool",
      description: "Internal only",
      requiredScopes: ["sandbox-test:items:read"],
      handler: async () => ({ ok: true }),
      trustBoundary: "internal",
    })

    try {
      await expect(
        executeTool({
          toolName: "sandbox-test:internal-tool",
          orgId: ORG_ID,
          actor: {
            actorType: "user",
            userId: "user1",
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: {},
          },
          params: {},
        }),
      ).rejects.toThrow("Tool restricted to internal use")
    } finally {
      toolRegistry.delete(toolKey)
    }
  })
})
