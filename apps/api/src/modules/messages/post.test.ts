// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { asOrgMember } from "~/tests/helpers/org-caller"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { postAppMessage } from "./post"

describe("messages.post (K1)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("posts a message into an explicit thread and stamps origin_app_id metadata", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)

    const { message_id, thread_id } = await withPrivilegedDb(org.id, "b1-post-explicit", (tx) =>
      postAppMessage(tx as unknown as RlsClient, {
        orgId: org.id,
        callingAppId: "invoicing",
        requiredScopes: [],
        authorUserId: admin.id,
        thread_id: threadId,
        body: "Hello",
      }),
    )
    expect(thread_id).toBe(threadId)
    const [row] = await sql<
      Array<{ metadata: Record<string, unknown> | null; content: string; author_type: string }>
    >`SELECT metadata, content, author_type FROM kernel.messages WHERE id = ${message_id}`
    expect(row.content).toBe("Hello")
    expect(row.author_type).toBe("system")
    expect(row.metadata).toMatchObject({ origin_app_id: "invoicing", origin_kind: "app_post" })
  })

  test("an app cannot mark its post as seeded: the flag that silences notifications is stripped", async () => {
    // `{ seeded: true }` keeps a message out of the push fanout and the attention feed
    // (notifications/seeded.ts). Only the server-side seed writes it; an app setting it would post
    // silently into someone's thread.
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)
    const { message_id } = await withPrivilegedDb(org.id, "post-seeded-strip", (tx) =>
      postAppMessage(tx as unknown as RlsClient, {
        orgId: org.id,
        callingAppId: "invoicing",
        requiredScopes: [],
        authorUserId: admin.id,
        thread_id: threadId,
        body: "Hello",
        metadata: { seeded: true, invoiceId: "inv-1" },
      }),
    )
    const [row] = await sql<
      Array<{ metadata: Record<string, unknown> | null }>
    >`SELECT metadata FROM kernel.messages WHERE id = ${message_id}`
    expect(row.metadata?.seeded).toBeUndefined()
    expect(row.metadata).toMatchObject({ invoiceId: "inv-1", origin_app_id: "invoicing" })
  })

  test("resolves contact → primary thread, idempotently", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const contactId = await minimal.contact(org.id, `c-${crypto.randomUUID()}@t.co`)

    const { thread_id } = await asOrgMember(org.id, admin.id, (tx) =>
      postAppMessage(tx, {
        orgId: org.id,
        callingAppId: "invoicing",
        requiredScopes: [],
        authorUserId: admin.id,
        contact_id: contactId,
        body: "Issued INV-2026-0001",
      }),
    )
    expect(thread_id).toMatch(/^[0-9a-f-]{36}$/)

    const { thread_id: again } = await asOrgMember(org.id, admin.id, (tx) =>
      postAppMessage(tx, {
        orgId: org.id,
        callingAppId: "invoicing",
        requiredScopes: [],
        authorUserId: admin.id,
        contact_id: contactId,
        body: "Marked paid",
      }),
    )
    expect(again).toBe(thread_id)
  })

  test.each([
    [
      "both thread_id and contact_id",
      {
        thread_id: "00000000-0000-0000-0000-000000000000",
        contact_id: "00000000-0000-0000-0000-000000000001",
      },
    ],
    ["neither thread_id nor contact_id", {}],
  ])("returns bad_request when %s", async (_label, args) => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    await expect(
      withPrivilegedDb(org.id, "b1-post-bad", (tx) =>
        postAppMessage(tx as unknown as RlsClient, {
          orgId: org.id,
          callingAppId: "invoicing",
          requiredScopes: [],
          authorUserId: admin.id,
          body: "y",
          ...(args as { thread_id?: string; contact_id?: string }),
        }),
      ),
    ).rejects.toMatchObject({ code: "bad_request" })
  })

  test("rejects bodies over 64KB with body_too_large", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)
    const big = "x".repeat(64 * 1024 + 1)
    await expect(
      withPrivilegedDb(org.id, "b1-post-big", (tx) =>
        postAppMessage(tx as unknown as RlsClient, {
          orgId: org.id,
          callingAppId: "invoicing",
          requiredScopes: [],
          authorUserId: admin.id,
          thread_id: threadId,
          body: big,
        }),
      ),
    ).rejects.toMatchObject({ code: "body_too_large" })
  })

  test("rejects unreadable attachment file ids with attachment_unreadable", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)
    const strangerFileId = "00000000-0000-0000-0000-000000000000"
    await expect(
      withPrivilegedDb(org.id, "b1-post-attach", (tx) =>
        postAppMessage(tx as unknown as RlsClient, {
          orgId: org.id,
          callingAppId: "invoicing",
          requiredScopes: [],
          authorUserId: admin.id,
          thread_id: threadId,
          body: "x",
          attachment_file_ids: [strangerFileId],
        }),
      ),
    ).rejects.toMatchObject({ code: "attachment_unreadable" })
  })

  // RLS boundary: postAppMessage must work correctly when the calling transaction
  // runs under the real liaison_rls role (the production request path).
  test("posts a message through the real liaison_rls role", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    const threadId = await minimal.thread(org.id, admin.id)

    const result = await withRlsContext(
      {
        actorType: "user",
        userId: admin.id,
        orgId: org.id,
        scopes: ["kernel:threads:write", "kernel:messages:write"],
        dimensionGrants: {},
      },
      (rlsTx) =>
        postAppMessage(rlsTx, {
          orgId: org.id,
          callingAppId: "invoicing",
          requiredScopes: [],
          authorUserId: admin.id,
          thread_id: threadId,
          body: "Sent under real RLS role",
        }),
    )

    expect(result.message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.thread_id).toBe(threadId)

    const [row] = await sql<Array<{ content: string; author_type: string }>>`
      SELECT content, author_type FROM kernel.messages WHERE id = ${result.message_id}
    `
    expect(row.content).toBe("Sent under real RLS role")
    expect(row.author_type).toBe("system")
  })
})
