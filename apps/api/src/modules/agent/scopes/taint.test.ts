// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"

// Track broadcastEphemeral calls across tests
const mockBroadcastEphemeral = mock(async () => {})
const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(
  mockBroadcastEphemeral,
)

const ORG_ID = "00000000-0000-0000-0000-000000d20001"
const USER_ID = "00000000-0000-0000-0000-000000d20002"
const CLEAN_THREAD = "00000000-0000-0000-0000-000000d20003"
const TAINTED_THREAD = "00000000-0000-0000-0000-000000d20004"

describe("taint tracker", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG_ID}, 'TaintOrg', 'taint-org', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, 'taint@test.com', 'Taint User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${CLEAN_THREAD}, ${ORG_ID}, 'clean-thread', 'agent_chat', ${USER_ID}, false) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${TAINTED_THREAD}, ${ORG_ID}, 'tainted-thread', 'agent_chat', ${USER_ID}, true) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${CLEAN_THREAD}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${TAINTED_THREAD}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    // Remove approval requests created by taint escalation tests before deleting threads
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    broadcastSpy.mockRestore()
  })

  describe("setTaintFlag", () => {
    afterEach(async () => {
      await sql`UPDATE kernel.threads SET tainted = false WHERE id = ${CLEAN_THREAD}`
      mockBroadcastEphemeral.mockClear()
    })

    it("sets tainted = true on a clean thread", async () => {
      const { setTaintFlag } = await import("./taint")
      await setTaintFlag(CLEAN_THREAD, ORG_ID)
      const [row] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${CLEAN_THREAD}`
      expect(row.tainted).toBe(true)
    })

    it("is idempotent on already-tainted thread", async () => {
      const { setTaintFlag } = await import("./taint")
      await setTaintFlag(TAINTED_THREAD, ORG_ID)
      const [row] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${TAINTED_THREAD}`
      expect(row.tainted).toBe(true)
    })

    it("broadcasts a thread:update ephemeral event with tainted:true", async () => {
      const { setTaintFlag } = await import("./taint")
      await setTaintFlag(CLEAN_THREAD, ORG_ID)
      // Allow the fire-and-forget promise to resolve
      await new Promise((r) => setTimeout(r, 10))
      expect(mockBroadcastEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "thread",
          action: "update",
          entityId: CLEAN_THREAD,
          orgId: ORG_ID,
          data: expect.objectContaining({ changes: { tainted: true } }),
        }),
      )
    })
  })

  describe("checkTaintEscalation — all 8 combinations", () => {
    afterEach(async () => {
      await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${ORG_ID}`
    })

    it("blocks: tainted + hardened + trustBoundary", async () => {
      await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"hardened"}'::jsonb WHERE id = ${ORG_ID}`
      const { checkTaintEscalation } = await import("./taint")
      const result = await checkTaintEscalation({
        threadId: TAINTED_THREAD,
        orgId: ORG_ID,
        toolHasTrustBoundary: true,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toBe("taint_escalation")
    })

    it("allows: tainted + standard + trustBoundary", async () => {
      const { checkTaintEscalation } = await import("./taint")
      const result = await checkTaintEscalation({
        threadId: TAINTED_THREAD,
        orgId: ORG_ID,
        toolHasTrustBoundary: true,
      })
      expect(result.blocked).toBe(false)
    })

    it("allows: clean + hardened + trustBoundary", async () => {
      await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"hardened"}'::jsonb WHERE id = ${ORG_ID}`
      const { checkTaintEscalation } = await import("./taint")
      const result = await checkTaintEscalation({
        threadId: CLEAN_THREAD,
        orgId: ORG_ID,
        toolHasTrustBoundary: true,
      })
      expect(result.blocked).toBe(false)
    })

    it("allows: tainted + hardened + no trustBoundary", async () => {
      await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"hardened"}'::jsonb WHERE id = ${ORG_ID}`
      const { checkTaintEscalation } = await import("./taint")
      const result = await checkTaintEscalation({
        threadId: TAINTED_THREAD,
        orgId: ORG_ID,
        toolHasTrustBoundary: false,
      })
      expect(result.blocked).toBe(false)
    })

    it("allows: clean + standard (both trustBoundary values)", async () => {
      const { checkTaintEscalation } = await import("./taint")
      for (const hasTrust of [true, false]) {
        const result = await checkTaintEscalation({
          threadId: CLEAN_THREAD,
          orgId: ORG_ID,
          toolHasTrustBoundary: hasTrust,
        })
        expect(result.blocked).toBe(false)
      }
    })

    it("allows: tainted + standard + no trustBoundary", async () => {
      const { checkTaintEscalation } = await import("./taint")
      const result = await checkTaintEscalation({
        threadId: TAINTED_THREAD,
        orgId: ORG_ID,
        toolHasTrustBoundary: false,
      })
      expect(result.blocked).toBe(false)
    })

    it("defaults to standard when webContentProtection is absent", async () => {
      const { checkTaintEscalation } = await import("./taint")
      const result = await checkTaintEscalation({
        threadId: TAINTED_THREAD,
        orgId: ORG_ID,
        toolHasTrustBoundary: true,
      })
      expect(result.blocked).toBe(false)
    })
  })

  describe("executeTool taint integration — trustBoundary gate", () => {
    const TOOL_NAME = "taint_test:send_email"
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["taint_test:send", "taint_test:approve"],
      dimensionGrants: {},
    }

    beforeAll(async () => {
      // Register a synthetic trust-boundary tool for this suite
      toolRegistry.set([ORG_ID, "taint_test", "send_email"], {
        appName: "taint_test",
        name: "send_email",
        description: "Send an email (trust-boundary tool)",
        requiredScopes: ["taint_test:send"],
        trustBoundary: "user",
        params: z.object({ to: z.string(), subject: z.string() }),
        handler: async () => ({ sent: true }),
      })
    })

    afterAll(async () => {
      toolRegistry.delete([ORG_ID, "taint_test", "send_email"])
    })

    it("blocks trust-boundary tool call on tainted thread in hardened mode", async () => {
      await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"hardened"}'::jsonb WHERE id = ${ORG_ID}`
      try {
        const result = await executeTool({
          toolName: TOOL_NAME,
          orgId: ORG_ID,
          actor,
          params: { to: "test@example.com", subject: "Hello" },
          threadId: TAINTED_THREAD,
          origin: "in-app-agent",
          stepBundleId: null,
        })
        expect(result.blocked).toBeDefined()
        expect(result.blocked?.reason).toBe("taint_escalation")
      } finally {
        await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${ORG_ID}`
      }
    })

    it("allows trust-boundary tool call on tainted thread in standard mode", async () => {
      const result = await executeTool({
        toolName: TOOL_NAME,
        orgId: ORG_ID,
        actor,
        params: { to: "test@example.com", subject: "Hello" },
        threadId: TAINTED_THREAD,
        origin: "in-app-agent",
        stepBundleId: null,
      })
      expect(result.blocked).toBeUndefined()
      expect(result.data).toEqual({ sent: true })
    })

    it("allows trust-boundary tool call on clean thread in hardened mode", async () => {
      await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"hardened"}'::jsonb WHERE id = ${ORG_ID}`
      try {
        const result = await executeTool({
          toolName: TOOL_NAME,
          orgId: ORG_ID,
          actor,
          params: { to: "test@example.com", subject: "Hello" },
          threadId: CLEAN_THREAD,
          origin: "in-app-agent",
          stepBundleId: null,
        })
        expect(result.blocked).toBeUndefined()
        expect(result.data).toEqual({ sent: true })
      } finally {
        await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${ORG_ID}`
      }
    })
  })

  describe("executeTool taint integration — the org setting", () => {
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["taint_test:post"],
      dimensionGrants: {},
    }
    const call = () =>
      executeTool({
        toolName: "taint_test:post_out",
        orgId: ORG_ID,
        actor,
        params: { body: "hi" },
        threadId: TAINTED_THREAD,
        origin: "in-app-agent",
        stepBundleId: null,
      })

    beforeAll(() => {
      toolRegistry.set([ORG_ID, "taint_test", "post_out"], {
        appName: "taint_test",
        name: "post_out",
        description: "Post outside the org (ungated outward tool)",
        requiredScopes: ["taint_test:post"],
        externalEffect: true,
        params: z.object({ body: z.string() }),
        handler: async () => ({ posted: true }),
      })
    })
    afterAll(() => {
      toolRegistry.delete([ORG_ID, "taint_test", "post_out"])
    })

    it("an ungated outward tool after outside content becomes an approval by default", async () => {
      const result = await call()
      expect(result.blocked?.reason).toBe("taint_escalation")
    })

    it("runs without approval when an admin switched the protection off", async () => {
      await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"off"}'::jsonb WHERE id = ${ORG_ID}`
      try {
        const result = await call()
        expect(result.blocked).toBeUndefined()
        expect(result.data).toEqual({ posted: true })
      } finally {
        await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${ORG_ID}`
      }
    })
  })
})
