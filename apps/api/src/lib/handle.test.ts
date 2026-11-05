// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { nextApprovalHandle, nextHandle } from "~/lib/handle"
import { isApprovalHandleCollision } from "~/modules/apps/execute-tool"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import * as minimal from "~/seed/tiers/minimal"

describe("nextHandle", () => {
  it("returns prefix-N where N comes from the named sequence", async () => {
    const a = await withPrivilegedDb("00000000-0000-0000-0000-00000000ABCD", "handle-test", (tx) =>
      nextHandle(tx, "kernel.thread_handle_seq", "thing"),
    )
    const b = await withPrivilegedDb("00000000-0000-0000-0000-00000000ABCD", "handle-test", (tx) =>
      nextHandle(tx, "kernel.thread_handle_seq", "thing"),
    )
    const aN = Number(a.split("-")[1])
    const bN = Number(b.split("-")[1])
    expect(a.startsWith("thing-")).toBe(true)
    expect(bN - aN).toBe(1)
  })

  it("rejects an invalid sequence name (non-identifier)", async () => {
    await expect(
      withPrivilegedDb("00000000-0000-0000-0000-00000000ABCD", "handle-test", (tx) =>
        nextHandle(tx, "bad'; DROP TABLE x;--", "thing"),
      ),
    ).rejects.toThrow()
  })
})

describe("nextApprovalHandle", () => {
  async function org(): Promise<{ orgId: string; userId: string }> {
    const { orgId } = await ensureOrg({
      slug: `handle-${crypto.randomUUID().slice(0, 12)}`,
      name: "Handle Org",
    })
    const { userId } = await ensureUser({
      orgId,
      email: `h-${crypto.randomUUID().slice(0, 8)}@handle.example`,
      name: "Owner",
      password: "pw-handle-1!",
      role: "admin",
    })
    return { orgId, userId }
  }
  const next = (orgId: string) =>
    withPrivilegedDb(orgId, "handle-test", (tx) => nextApprovalHandle(tx, orgId))

  it("numbers each organisation's approvals on its own, from request-1", async () => {
    const a = await org()
    const b = await org()
    expect(await next(a.orgId)).toBe("request-1")
    expect(await next(a.orgId)).toBe("request-2")
    // Another tenant's approvals in between do not move this one's numbers.
    expect(await next(b.orgId)).toBe("request-1")
    expect(await next(a.orgId)).toBe("request-3")
  })

  it("skips a number the organisation already holds", async () => {
    const a = await org()
    const threadId = await minimal.thread(a.orgId, a.userId)
    await sql`INSERT INTO kernel.approval_requests
      (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload, expires_at, requested_by)
      VALUES (${a.orgId}, 'request-2', ${threadId}, ${threadId}, 'kernel:noop', '{}'::jsonb, '{}'::jsonb, now() + interval '1 day', ${a.userId})`
    expect(await next(a.orgId)).toBe("request-1")
    expect(await next(a.orgId)).toBe("request-3")
  })

  it("concurrent calls for one organisation each get their own number", async () => {
    const a = await org()
    const handles = await Promise.all(Array.from({ length: 10 }, () => next(a.orgId)))
    expect(new Set(handles).size).toBe(10)
    expect(handles.map((h) => Number(h.split("-")[1])).sort((x, y) => x - y)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })

  it("a handle taken by another transaction is recognised for a retry, wrapped or not", () => {
    const pg = new Error(
      'duplicate key value violates unique constraint "approval_requests_org_handle_idx"',
    )
    expect(isApprovalHandleCollision(pg)).toBe(true)
    expect(isApprovalHandleCollision({ message: "Failed query", cause: pg })).toBe(true)
    expect(
      isApprovalHandleCollision(new Error("approval_requests_bundle_unique_position_idx")),
    ).toBe(false)
  })
})
