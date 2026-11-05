// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B2 — `messages_post` RPC bridge integration tests. Uses a real DB
// (the existing `acquireTestLock` pattern) so we exercise both halves of the
// seam: capability gate + forwarding into the kernel `postAppMessage`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createRpcBridge } from "./rpc-bridge"

describe("rpc-bridge — messages_post (K1)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("rejects when the calling app did not declare 'messages.post' capability", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    await withPrivilegedDb(org.id, "b2-no-cap", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: [] } as never,
      )
      await expect(
        bridge.messages_post(
          JSON.stringify({
            thread_id: "00000000-0000-0000-0000-000000000000",
            body: "y",
          }),
        ),
      ).rejects.toMatchObject({ code: "CAPABILITY_NOT_DECLARED" })
    })
  })

  test("forwards to postAppMessage and returns a JSON envelope with the new message id", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)
    const raw = await withPrivilegedDb(org.id, "b2-forward", async (tx) => {
      const bridge = createRpcBridge(
        "invoicing",
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        { name: "invoicing", capabilities: ["messages.post"] } as never,
      )
      return bridge.messages_post(JSON.stringify({ thread_id: threadId, body: "Hello" }))
    })
    const parsed = JSON.parse(raw) as { message_id: string; thread_id: string }
    expect(parsed.message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(parsed.thread_id).toBe(threadId)
  })

  // RLS boundary: the bridge must work when the transaction runs under the real
  // liaison_rls role (the production request path), not just BYPASSRLS.
  test("posts a message through the real liaison_rls role", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)
    const raw = await withRlsContext(
      {
        actorType: "user",
        userId: admin.id,
        orgId: org.id,
        scopes: ["kernel:threads:write", "kernel:messages:write"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        const bridge = createRpcBridge("invoicing", admin.id, org.id, rlsTx, {
          name: "invoicing",
          capabilities: ["messages.post"],
        } as never)
        return bridge.messages_post(
          JSON.stringify({ thread_id: threadId, body: "RLS boundary check" }),
        )
      },
    )
    const parsed = JSON.parse(raw) as { message_id: string; thread_id: string }
    expect(parsed.message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(parsed.thread_id).toBe(threadId)
  })
})
