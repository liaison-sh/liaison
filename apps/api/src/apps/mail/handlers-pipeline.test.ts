// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { processMessages } from "~/apps/mail/handlers"
import { mailPageRunner } from "~/apps/mail/test-page-write-bridge"

const runMail = mailPageRunner({
  __test_processMessages: (params, ctx) =>
    processMessages(params.messages, params.account, ctx, params.origin ?? "incremental"),
})

/**
 * A synthetic stand-in for the host's `mailbox_sealAndInsert`, for the sync
 * tests whose subject is paging, pacing and dedup rather than encryption.
 *
 * It mimics the real contract: the plaintext never reaches the row, and the
 * caller gets back key material plus one ciphertext column per sealed field.
 * It deliberately produces FAKE ciphertext, so nothing here can be mistaken for
 * a test of the crypto. The real bridge, against a real enrolled identity, is
 * exercised by T-INT-1 in `src/tests/integration/mail-sync.test.ts`.
 */
async function stubSealAndInsert(bridge: Record<string, any>, paramsJson: string): Promise<string> {
  const params = JSON.parse(paramsJson)
  // Record the plaintext the caller HANDED to the seal, under `data`, so a test
  // asserting "the right subject reached the writer" still can. The row itself
  // never carries it, which is the point of the whole phase.
  const inserted = JSON.parse(
    await bridge.db_insert(
      params.entity,
      JSON.stringify({ ...params.row, __sealedPlaintext: params.plaintext ?? {} }),
    ),
  )
  delete inserted.__sealedPlaintext
  const sealed: Record<string, string> = {}
  for (const [field, value] of Object.entries(params.plaintext ?? {})) {
    if (typeof value !== "string" || value === "") continue
    const column = `${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_ciphertext`
    sealed[column] = Buffer.from(`sealed:${value}`).toString("base64")
  }
  return JSON.stringify({
    ...inserted,
    subject: null,
    text_body: null,
    html_body: null,
    snippet: null,
    ...sealed,
    content_key_wrapped: Buffer.from("wrapped").toString("base64"),
    content_key_epk: Buffer.from("epk").toString("base64"),
    enc_key_id: 1,
    enc_version: 1,
  })
}

describe("processMessages pipeline", () => {
  it("creates conversation and message for new thread", async () => {
    const inserts: any[] = []
    const emits: any[] = []
    let findCallCount = 0

    const bridge: Record<string, any> = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findMany: async () => {
        findCallCount++
        return JSON.stringify([])
      },
      db_findOne: async () => JSON.stringify(null),
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        const id = `gen-${inserts.length}`
        inserts.push({ entity, data, id })
        return JSON.stringify({ id, ...data })
      },
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async (eventJson: string) => {
        emits.push(JSON.parse(eventJson))
      },
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (paramsJson: string) => {
        const params = JSON.parse(paramsJson)
        return JSON.stringify({ id: "contact-1", email: params.email, name: params.name })
      },
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<sent@example.com>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await runMail({
      exportName: "__test_processMessages",
      params: {
        messages: [
          {
            externalMessageId: "<msg1@example.com>",
            externalProviderId: "1",
            externalThreadId: "<thread1@example.com>",
            from: { name: "Alice", email: "alice@example.com" },
            to: [{ name: "Bob", email: "bob@example.com" }],
            cc: [],
            bcc: [],
            subject: "Hello",
            textBody: "Hi there",
            htmlBody: "<p>Hi there</p>",
            snippet: "Hi there",
            headers: {},
            inReplyTo: null,
            references: [],
            labels: ["INBOX"],
            isRead: false,
            isStarred: false,
            sentAt: "2026-01-15T10:00:00Z",
            direction: "inbound",
          },
        ],
        account: {
          id: "acc-1",
          owner_type: "user",
          owner_id: "user-1",
        },
      },
      bridge,
    })

    expect(findCallCount).toBeGreaterThanOrEqual(2)
    expect(inserts.length).toBeGreaterThanOrEqual(2)
    const convInsert = inserts.find((insert) => insert.entity === "conversations")
    expect(convInsert).toBeDefined()
    expect(convInsert.data.accountId).toBe("acc-1")
    expect(convInsert.data.ownerType).toBe("user")

    const msgInsert = inserts.find((insert) => insert.entity === "messages")
    expect(msgInsert).toBeDefined()
    expect(msgInsert.data.externalMessageId).toBe("<msg1@example.com>")

    const convEvent = emits.find(
      (event) => event.entity === "conversation" && event.action === "create",
    )
    expect(convEvent).toBeDefined()
    const msgEvent = emits.find((event) => event.entity === "message" && event.action === "create")
    expect(msgEvent).toBeDefined()
  })

  it("skips duplicate messages", async () => {
    const inserts: any[] = []
    let findCallCount = 0

    const bridge: Record<string, any> = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findMany: async () => {
        findCallCount++
        if (findCallCount === 1) {
          return JSON.stringify([{ id: "existing-msg", external_message_id: "<msg1@example.com>" }])
        }
        return JSON.stringify([])
      },
      db_findOne: async () => JSON.stringify(null),
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_entity: string, dataJson: string) => {
        inserts.push(JSON.parse(dataJson))
        return JSON.stringify({ id: "x" })
      },
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await runMail({
      exportName: "__test_processMessages",
      params: {
        messages: [
          {
            externalMessageId: "<msg1@example.com>",
            externalProviderId: "1",
            externalThreadId: "<thread1@example.com>",
            from: { email: "a@b.com" },
            to: [],
            cc: [],
            bcc: [],
            subject: "Dup",
            textBody: "",
            htmlBody: "",
            snippet: "",
            headers: {},
            inReplyTo: null,
            references: [],
            labels: [],
            isRead: false,
            isStarred: false,
            sentAt: "2026-01-15T10:00:00Z",
            direction: "inbound",
          },
        ],
        account: { id: "acc-1", owner_type: "user", owner_id: "user-1" },
      },
      bridge,
    })

    expect(inserts.length).toBe(0)
  })

  // ── Invariant K, Task 6.1: mail event payloads carry ids only ──────────────
  //
  // The strip is CONDITIONAL on the mailbox being encrypted, and both halves of
  // that condition are asserted: a `ready` account emits no content, and a plain
  // org mailbox still emits its subject byte for byte. A global strip would pass
  // the first half and fail the second, which is exactly the mistake this pair
  // exists to catch.
  async function runIngestCapturingEmits(
    account: Record<string, unknown>,
    existingConversation: Record<string, unknown> | null,
  ): Promise<any[]> {
    const emits: any[] = []
    let findCall = 0
    const bridge: Record<string, any> = {
      getUserId: () => "user-1",
      getOrgId: () => "org-1",
      db_findMany: async (entity: string) => {
        findCall++
        if (entity === "conversations" && existingConversation) {
          return JSON.stringify([existingConversation])
        }
        return JSON.stringify([])
      },
      db_findOne: async () => JSON.stringify(null),
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (entity: string, dataJson: string) =>
        JSON.stringify({ id: `${entity}-${findCall}`, ...JSON.parse(dataJson) }),
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async (eventJson: string) => {
        emits.push(JSON.parse(eventJson))
      },
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await runMail({
      exportName: "__test_processMessages",
      params: {
        messages: [
          {
            externalMessageId: `<k-${Math.random()}@example.com>`,
            externalProviderId: "1",
            externalThreadId: "<thread-k@example.com>",
            from: { name: "Alice", email: "alice@example.com" },
            to: [{ email: "bob@example.com" }],
            cc: [],
            bcc: [],
            subject: "ZEPHYRSUBJECT confidential",
            textBody: "ZEPHYRBODY confidential",
            htmlBody: "<p>ZEPHYRBODY confidential</p>",
            snippet: "ZEPHYRBODY confidential",
            headers: {},
            inReplyTo: null,
            references: [],
            labels: ["INBOX"],
            isRead: false,
            isStarred: false,
            sentAt: "2026-01-15T10:00:00Z",
            direction: "inbound",
          },
        ],
        account,
      },
      bridge,
    })
    return emits
  }

  it("emits no subject or snippet for a ready personal mailbox", async () => {
    const created = await runIngestCapturingEmits(
      { id: "acc-k", owner_type: "user", owner_id: "user-1", encryption_state: "ready" },
      null,
    )
    // Non-vacuity: the pipeline must actually have emitted, or the negative
    // assertions below are about an empty array.
    expect(created.length).toBeGreaterThan(0)
    const convCreate = created.find((e) => e.entity === "conversation" && e.action === "create")
    expect(convCreate).toBeDefined()
    expect(Object.keys(convCreate.data).sort()).toEqual(["accountId", "id"])
    expect(JSON.stringify(created)).not.toContain("ZEPHYRSUBJECT")
    expect(JSON.stringify(created)).not.toContain("ZEPHYRBODY")

    const updated = await runIngestCapturingEmits(
      { id: "acc-k", owner_type: "user", owner_id: "user-1", encryption_state: "ready" },
      {
        id: "conv-existing",
        external_thread_id: "<thread-k@example.com>",
        message_count: 1,
        labels: [],
        is_read: true,
        is_starred: false,
      },
    )
    const convUpdate = updated.find((e) => e.entity === "conversation" && e.action === "update")
    expect(convUpdate).toBeDefined()
    expect(convUpdate.data.snippet).toBeUndefined()
    expect(JSON.stringify(updated)).not.toContain("ZEPHYRBODY")
  })

  it("still emits the subject for a mailbox that is not encrypted", async () => {
    const created = await runIngestCapturingEmits(
      { id: "acc-org", owner_type: "org", owner_id: null },
      null,
    )
    const convCreate = created.find((e) => e.entity === "conversation" && e.action === "create")
    expect(convCreate).toBeDefined()
    expect(convCreate.data.subject).toBe("ZEPHYRSUBJECT confidential")

    const updated = await runIngestCapturingEmits(
      { id: "acc-org", owner_type: "org" },
      {
        id: "conv-existing",
        external_thread_id: "<thread-k@example.com>",
        message_count: 1,
        labels: [],
        is_read: true,
        is_starred: false,
      },
    )
    const convUpdate = updated.find((e) => e.entity === "conversation" && e.action === "update")
    expect(convUpdate.data.snippet).toBe("ZEPHYRBODY confidential")
  })

  it("keeps the already-clean emit payloads exactly as narrow as they are", async () => {
    const emits = await runIngestCapturingEmits(
      { id: "acc-k2", owner_type: "user", owner_id: "user-1", encryption_state: "ready" },
      null,
    )
    const msgCreate = emits.find((e) => e.entity === "message" && e.action === "create")
    expect(msgCreate).toBeDefined()
    // S16 added the sync origin and the inbound envelope facts the new-email
    // producer decides on (labels, read state, Gmail receipt time). None of
    // them is content: still no subject, snippet or body. senderAuth is the
    // sender authentication verdict ("pass", "fail" or "none").
    expect(Object.keys(msgCreate.data).sort()).toEqual([
      "accountId",
      "conversationId",
      "direction",
      "from",
      "id",
      "internalDate",
      "isRead",
      "labels",
      "origin",
      "senderAuth",
    ])
    expect(JSON.stringify(msgCreate.data)).not.toContain("ZEPHYR")
  })
})
