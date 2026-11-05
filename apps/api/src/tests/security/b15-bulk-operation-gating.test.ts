// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { type BulkDispatchDeps, runBulkDispatch } from "~/modules/apps/bulk-dispatch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedBulkGatedItems } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const APP = "b15_bulk"
const TOOL = "delete"
const BULK_ACTION = "delete"

// This suite mocks `dispatch`, so it verifies fan-out CARDINALITY (N items
// never collapse into one batched approval) at scale (50 items), not the
// origin discriminator itself: the mocked dispatch never reaches
// executeToolCore's isDirectHumanCall check. That security property (a
// forgotten/human-ui origin cannot bypass the per-item gate) is covered with
// the REAL dispatch path, no mock, in
// modules/apps/bulk-dispatch.test.ts's "origin propagation through the real
// gate (regression)" suite. Splitting it this way keeps this suite fast at
// 50 items while the real-path suite stays small and exercises the actual
// gate end to end.
describe("B15 — bulk operation gating: N gated items produce N approvals, never a batched bypass", () => {
  test("runBulkDispatch over 50 gated items creates 50 individual approval requests", async () => {
    const { itemIds, orgId, userId } = await seedBulkGatedItems(50)
    const actor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: [`${APP}:items:write`],
      dimensionGrants: {},
    }
    manifestRegistry.set([orgId, APP], {
      name: APP,
      bulk: {
        [BULK_ACTION]: {
          label: "Delete",
          underlyingTool: TOOL,
          dispatchMode: "perItem",
          perItemParam: "itemId",
          sharedFields: [],
        },
      },
      uiBundleUrl: null,
    } as any)
    toolRegistry.set([orgId, APP, TOOL], {
      appName: APP,
      name: TOOL,
      description: "delete",
      requiredScopes: [`${APP}:items:write`],
      gated: true,
      handler: async () => ({}),
    } as any)

    try {
      const calls: Array<{ itemId: unknown }> = []
      const dispatch: BulkDispatchDeps["dispatch"] = async (opts) => {
        const p = opts.params as Record<string, unknown>
        calls.push({ itemId: p.itemId })
        return {
          blocked: {
            reason: "gated",
            approvalRequestId: `appr-${String(p.itemId)}`,
            requesterCanApprove: false,
          },
        }
      }
      const noopOrigin = async () => undefined
      const res = await runBulkDispatch(
        {
          app: APP,
          action: BULK_ACTION,
          ids: itemIds,
          params: {},
          idempotencyKey: crypto.randomUUID(),
          actor,
          origin: "human-ui",
        },
        { dispatch, ensureOriginThread: noopOrigin },
      )

      expect(res.approvalsCreated).toBe(50)
      expect(res.items.length).toBe(50)
      expect(res.items.every((i) => i.status === "pending_approval")).toBe(true)
      // Approval IDs are distinct — never a single batched approval covering
      // multiple items (the bypass we are guarding against).
      const distinctApprovals = new Set(res.items.map((i) => i.approvalRequestId))
      expect(distinctApprovals.size).toBe(50)
      expect(calls.length).toBe(50)
    } finally {
      toolRegistry.deleteByPrefix([orgId, APP])
      manifestRegistry.delete([orgId, APP])
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
    }
  })
})
