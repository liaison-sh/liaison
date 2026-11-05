// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B11 — sandbox bridge exposes the post-approval `approvalContext`
// as `ctx.approval` via the `_approvalContext_get()` RPC method.
//
// Re-invocation invariant: gated tool handlers that need to know whether
// they're running post-approval (e.g. issuing an invoice number only after the
// reviewer approved) must be able to read `ctx.approval` and short-circuit
// the gating logic. Without this, the handler can't tell the difference
// between "first call, surface an approval card" and "second call, do the
// work" — a contradiction for re-entrant gates.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createRpcBridge } from "./rpc-bridge"

const rlsDb = db as unknown as RlsClient
const manifest = { name: "invoicing", capabilities: [] }

describe("rpc-bridge — ctx.approval (B11)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("_approvalContext_get returns null on first invocation (no approvalContext arg)", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    const bridge = createRpcBridge("invoicing", user.id, org.id, rlsDb, manifest as never, [])
    const raw = await bridge._approvalContext_get()
    expect(typeof raw).toBe("string")
    expect(JSON.parse(raw)).toBeNull()
  })

  test("_approvalContext_get returns the approvalContext on post-approval re-invocation", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    const approvalContext = {
      approvalRequestId: "11111111-2222-3333-4444-555555555555",
      approvalDeciderId: "22222222-3333-4444-5555-666666666666",
      toolName: "invoicing:invoice.issue",
    }
    const bridge = createRpcBridge(
      "invoicing",
      user.id,
      org.id,
      rlsDb,
      manifest as never,
      [],
      undefined,
      approvalContext,
    )
    const raw = await bridge._approvalContext_get()
    expect(JSON.parse(raw)).toEqual(approvalContext)
  })

  test("_approvalContext_get is a real function on the bridge surface (sandbox can call it)", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    const bridge = createRpcBridge("invoicing", user.id, org.id, rlsDb, manifest as never, [])
    expect(typeof bridge._approvalContext_get).toBe("function")
  })
})
