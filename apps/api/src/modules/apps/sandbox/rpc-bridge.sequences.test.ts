// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B6 — `sequences_allocate` RPC bridge integration tests. Mirrors
// B2 / B4 shape: capability gate + forwarding round-trip into the K3
// allocator.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createRpcBridge } from "./rpc-bridge"

describe("rpc-bridge — sequences_allocate (K3)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("rejects when the calling app did not declare 'sequences.allocate' capability", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    await withPrivilegedDb(org.id, "b6-no-cap", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: [] } as never,
      )
      await expect(
        bridge.sequences_allocate(JSON.stringify({ key: "invoicing:doc:y2026" })),
      ).rejects.toMatchObject({ code: "CAPABILITY_NOT_DECLARED" })
    })
  })

  test("forwards to allocateSequence and returns a JSON envelope with the new value", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const raw = await withPrivilegedDb(org.id, "b6-forward", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: ["sequences.allocate"] } as never,
      )
      return bridge.sequences_allocate(JSON.stringify({ key: "invoicing:b6-test" }))
    })
    expect(JSON.parse(raw)).toEqual({ value: 1 })
  })

  test("returns an error envelope when key violates the app namespace", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const raw = await withPrivilegedDb(org.id, "b6-namespace", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: ["sequences.allocate"] } as never,
      )
      return bridge.sequences_allocate(JSON.stringify({ key: "mail:not-mine" }))
    })
    const parsed = JSON.parse(raw) as { error?: { code?: string } }
    expect(parsed.error?.code).toBe("forbidden")
  })

  // RLS boundary: the bridge must work correctly when the transaction runs under
  // the real liaison_rls role (as it does in production requests), not just
  // under the BYPASSRLS privileged connection.
  test("allocates a sequence through the real liaison_rls role", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const raw = await withRlsContext(
      {
        actorType: "user",
        userId: admin.id,
        orgId: org.id,
        scopes: ["kernel:sequences:write"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        const bridge = createRpcBridge("invoicing", admin.id, org.id, rlsTx, {
          name: "invoicing",
          capabilities: ["sequences.allocate"],
        } as never)
        return bridge.sequences_allocate(JSON.stringify({ key: "invoicing:rls-test" }))
      },
    )
    expect(JSON.parse(raw)).toEqual({ value: 1 })
  })
})
