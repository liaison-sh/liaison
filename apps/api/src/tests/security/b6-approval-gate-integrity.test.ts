// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedGatedToolFixture } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

// Approvals are for agents (execute-tool.ts, computeSkipGate): an agent's call to a gated
// tool always parks for a person, and a person's own click is decided by the tool's OWN
// scope (it runs when they hold it, and is refused otherwise). Neither path reaches the
// handler of a gated tool without either an approval or the caller's own permission.
describe("B6 — approval gate integrity: gated handler never runs without approval", () => {
  test("100 agent attempts against a gated tool never reach the handler", async () => {
    const { gatedTool, memberId, orgId, threadId, cleanup } = await seedGatedToolFixture()
    try {
      const { scopes } = await withPrivilegedDb(orgId, "b6-member-scopes", (tx) =>
        loadEffectivePermissions(tx, memberId, orgId),
      )
      const actor: UserContext = {
        actorType: "user",
        userId: memberId,
        orgId,
        scopes,
        dimensionGrants: {},
      }

      // 100 attempts is enough to demonstrate the invariant; 500 would also
      // pass but the wall-clock cost (each call creates an approval request)
      // is disproportionate to the assertion strength.
      const attempts = 100
      let blockedCount = 0
      for (let i = 0; i < attempts; i++) {
        const r = await executeTool({
          toolName: "test:riskyAction",
          orgId,
          actor,
          threadId,
          params: { itemId: "noop", action: "noop" },
          origin: "in-app-agent",
        })
        if (r.blocked) blockedCount++
      }
      expect(blockedCount).toBe(attempts)
      expect(gatedTool.handlerCallCount).toBe(0)
    } finally {
      await cleanup()
    }
    // 100 sequential tool calls (each creating an approval request) exceed bun's
    // default 5s test timeout on slower hosts — the assertion is the invariant,
    // not wall-clock, so give it ample headroom.
  }, 30_000)

  test("a person lacking the tool's own scope is refused on every direct call, never parked or run", async () => {
    const { gatedTool, orgId, threadId, cleanup } = await seedGatedToolFixture()
    try {
      const outsider = await minimal.session(orgId)
      const app = await buildTestApp()
      const hdr = { authorization: `Bearer ${outsider.bearer}`, "content-type": "application/json" }
      for (let i = 0; i < 20; i++) {
        const r = await app.request("/api/apps/tools/test:riskyAction", {
          method: "POST",
          headers: hdr,
          body: JSON.stringify({ threadId, params: { itemId: "noop", action: "noop" } }),
        })
        expect(r.status).toBe(403)
      }
      expect(gatedTool.handlerCallCount).toBe(0)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
