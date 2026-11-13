// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 1 of the two-phase agent read protocol (blueprint Task 9.1 and 9.6):
// the sandbox tool resolves envelope metadata and returns a MARKER, fast. It
// never blocks, never waits, and never calls out to a browser, because the
// sandbox budget is 5 s in production and a timeout kills the worker.

import { describe, expect, it } from "bun:test"
import { runMail } from "~/apps/mail/test-page-write-bridge"
import { readMailboxMarker } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"

const CONVERSATION_ID = "conv-1"
const ACCOUNT_ID = "acct-1"

const SEALED_ACCOUNT = {
  id: ACCOUNT_ID,
  email_address: "owner@example.com",
  owner_type: "user",
  owner_id: "user-1",
  encryption_state: "ready",
  provider: "gmail",
}

const SHARED_ACCOUNT = {
  id: ACCOUNT_ID,
  email_address: "support@example.com",
  owner_type: "org",
  owner_id: null,
  encryption_state: "none",
  provider: "gmail",
}

const PLAINTEXT_MESSAGE = {
  id: "msg-1",
  conversation_id: CONVERSATION_ID,
  from_address: { email: "customer@example.com" },
  to_addresses: [{ email: "support@example.com" }],
  sent_at: "2026-01-01T00:00:00.000Z",
  direction: "inbound",
  subject: "Invoice 42",
  snippet: "THE SNIPPET PHRASE",
  text_body: "THE BODY PHRASE",
  labels: ["INBOX"],
}

function bridgeFor(account: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    db_findOne: async (entity: string, id: string) => {
      if (entity === "accounts") return JSON.stringify(account)
      if (entity === "conversations") {
        return JSON.stringify({
          id: CONVERSATION_ID,
          account_id: ACCOUNT_ID,
          subject: account.encryption_state === "ready" ? null : "Invoice 42",
          status: "open",
          is_read: false,
          is_starred: false,
          assigned_to: null,
          message_count: 1,
          last_message_at: "2026-01-01T00:00:00.000Z",
          contact_id: null,
        })
      }
      if (entity === "messages") return JSON.stringify({ ...PLAINTEXT_MESSAGE, id })
      return JSON.stringify(null)
    },
    db_findMany: async () => JSON.stringify([PLAINTEXT_MESSAGE]),
    kernel_findOne: async () => JSON.stringify(null),
    files_listAttachments: async () => JSON.stringify([]),
    log_debug: () => {},
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    ...overrides,
  }
}

describe("mail read and search under a sealed personal mailbox", () => {
  async function run(
    exportName: string,
    params: unknown,
    bridge: Record<string, (...args: any[]) => any>,
  ) {
    return (await runMail({
      exportName,
      params,
      bridge,
    })) as any
  }

  it("returns bodies verbatim for a shared org mailbox (non-vacuity)", async () => {
    const result = await run(
      "agentMailRead",
      { conversationId: CONVERSATION_ID, includeBody: true },
      bridgeFor(SHARED_ACCOUNT),
    )
    expect(result.needsPlaintext).toBeUndefined()
    expect(JSON.stringify(result)).toContain("THE BODY PHRASE")
    expect(JSON.stringify(result)).toContain("THE SNIPPET PHRASE")
  })

  it("returns a marker and envelope, and no body text, for a ready personal mailbox", async () => {
    const result = await run(
      "agentMailRead",
      { conversationId: CONVERSATION_ID, includeBody: true },
      bridgeFor(SEALED_ACCOUNT),
    )
    expect(result.needsPlaintext.requestKind).toBe("mail.read")
    expect(result.needsPlaintext.messageIds).toEqual(["msg-1"])
    expect(typeof result.needsPlaintext.purpose).toBe("string")
    expect(Array.isArray(result.envelope)).toBe(true)
    expect(result.envelope[0].messageId).toBe("msg-1")
    expect(result.envelope[0].from).toEqual({ email: "customer@example.com" })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("THE BODY PHRASE")
    expect(serialized).not.toContain("THE SNIPPET PHRASE")
    expect(serialized).not.toContain("Invoice 42")
  })

  // The marker contract crosses the sandbox boundary: `handlers.ts` is a bundle
  // and cannot import the host, so it writes the `requestKind` literals by hand
  // and `readMailboxMarker` re-lists them by hand. Asserting the literals on
  // both sides separately would stay green through a drift, so this feeds a REAL
  // handler marker into the real host parser. A drift on either side is a
  // silently broken read path (no leak, but the agent never gets the plaintext).
  it("a real handler marker parses through the host's readMailboxMarker", async () => {
    const result = await run(
      "agentMailRead",
      { conversationId: CONVERSATION_ID, includeBody: true },
      bridgeFor(SEALED_ACCOUNT),
    )
    const marker = readMailboxMarker(result)
    expect(marker).not.toBeNull()
    expect(marker?.requestKind).toBe("mail.read")
    expect(marker?.messageIds).toEqual(["msg-1"])
    expect(marker?.purpose.length).toBeGreaterThan(0)
    // Non-vacuity: the shared mailbox result is not a marker at all.
    const plain = await run(
      "agentMailRead",
      { conversationId: CONVERSATION_ID, includeBody: true },
      bridgeFor(SHARED_ACCOUNT),
    )
    expect(readMailboxMarker(plain)).toBeNull()
  })

  it("returns the same marker for a single-message drill down", async () => {
    const result = await run(
      "agentMailRead",
      { conversationId: CONVERSATION_ID, messageId: "msg-1" },
      bridgeFor(SEALED_ACCOUNT),
    )
    expect(result.needsPlaintext.requestKind).toBe("mail.read")
    expect(JSON.stringify(result)).not.toContain("THE BODY PHRASE")
  })

  it("runs the structured half of a search server-side and marks the free text half", async () => {
    const searched: string[] = []
    const bridge = bridgeFor(SEALED_ACCOUNT, {
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity === "accounts") return JSON.stringify([SEALED_ACCOUNT])
        void optsJson
        return JSON.stringify([])
      },
      mail_search: async (paramsJson: string) => {
        searched.push(paramsJson)
        return JSON.stringify({
          items: [
            {
              id: CONVERSATION_ID,
              subject: null,
              snippet: null,
              account_email: "owner@example.com",
              from_email: "customer@example.com",
              is_read: false,
              is_starred: false,
              assigned_to: null,
              status: "open",
              last_message_at: "2026-01-01T00:00:00.000Z",
              message_count: 1,
            },
          ],
          totalCount: 1,
        })
      },
    })
    const result = await run(
      "agentMailSearch",
      { query: "invoice", accountId: ACCOUNT_ID, unreadOnly: true },
      bridge,
    )
    // The structured half still answers: one envelope row came back.
    expect(result.items.length).toBe(1)
    expect(result.needsClientSearch.query).toBe("invoice")
    // The free-text term was NOT passed to the server-side search: the server
    // holds ciphertext and cannot answer it.
    expect(searched[0]).not.toContain("invoice")
    // And the agent is told which half went unanswered.
    expect(typeof result.unanswered).toBe("string")
  })

  // The second half of the client-search exchange. The browser answered with
  // ids, the broker retried the tool with them, and this is where they are
  // spent. Without this the retry runs the identical query, raises the identical
  // marker, and the browser's answer is thrown away: the agent's free-text
  // search over a sealed mailbox can never return a hit.
  it("spends the client's search ids on the retry, and does not ask again", async () => {
    const searched: string[] = []
    const bridge = bridgeFor(SEALED_ACCOUNT, {
      db_findMany: async (entity: string) =>
        entity === "accounts" ? JSON.stringify([SEALED_ACCOUNT]) : JSON.stringify([]),
      mail_search: async (paramsJson: string) => {
        searched.push(paramsJson)
        return JSON.stringify({
          items: [
            {
              id: CONVERSATION_ID,
              subject: null,
              snippet: null,
              account_email: "owner@example.com",
              from_email: "customer@example.com",
              is_read: false,
              is_starred: false,
              assigned_to: null,
              status: "open",
              last_message_at: "2026-01-01T00:00:00.000Z",
              message_count: 1,
            },
          ],
          totalCount: 1,
        })
      },
    })

    const result = await run(
      "agentMailSearch",
      { query: "invoice", accountId: ACCOUNT_ID, __mailboxSearchIds: ["msg-1"] },
      bridge,
    )

    // Asked once, answered once. A second marker would be an unanswerable loop.
    expect(result.needsClientSearch).toBeUndefined()
    // The client's ids reached the server-side query, which intersects them with
    // the structured filters and the caller's own RLS.
    expect(JSON.parse(searched[0]).messageIds).toEqual(["msg-1"])
    // Still no free text on the wire: the server holds ciphertext.
    expect(searched[0]).not.toContain("invoice")
    expect(result.items.length).toBe(1)
  })

  it("reports no matches when the browser's index answered with nothing", async () => {
    const searched: string[] = []
    const bridge = bridgeFor(SEALED_ACCOUNT, {
      db_findMany: async (entity: string) =>
        entity === "accounts" ? JSON.stringify([SEALED_ACCOUNT]) : JSON.stringify([]),
      mail_search: async (paramsJson: string) => {
        searched.push(paramsJson)
        return JSON.stringify({ items: [], totalCount: 0 })
      },
    })

    const result = await run(
      "agentMailSearch",
      {
        query: "invoice",
        __mailboxSearchIds: [],
        __mailboxSearchIndexComplete: true,
      },
      bridge,
    )

    expect(result.needsClientSearch).toBeUndefined()
    expect(JSON.parse(searched[0]).messageIds).toEqual([])
    expect(result.items).toEqual([])
  })

  it("says the free text half went unanswered when the browser has no index", async () => {
    const searched: string[] = []
    const bridge = bridgeFor(SEALED_ACCOUNT, {
      db_findMany: async (entity: string) =>
        entity === "accounts" ? JSON.stringify([SEALED_ACCOUNT]) : JSON.stringify([]),
      mail_search: async (paramsJson: string) => {
        searched.push(paramsJson)
        return JSON.stringify({ items: [], totalCount: 0 })
      },
    })

    const result = await run(
      "agentMailSearch",
      {
        query: "invoice",
        __mailboxSearchIds: [],
        __mailboxSearchIndexComplete: false,
      },
      bridge,
    )

    // An unbuilt index is not "no matches": narrowing to an empty id set would
    // report an empty mailbox as fact.
    expect(result.needsClientSearch).toBeUndefined()
    expect(JSON.parse(searched[0]).messageIds).toBeUndefined()
    expect(typeof result.unanswered).toBe("string")
  })

  it("leaves a structured-only search byte identical for a shared mailbox", async () => {
    const bridge = bridgeFor(SHARED_ACCOUNT, {
      db_findMany: async (entity: string) =>
        entity === "accounts" ? JSON.stringify([SHARED_ACCOUNT]) : JSON.stringify([]),
      mail_search: async () =>
        JSON.stringify({
          items: [
            {
              id: CONVERSATION_ID,
              subject: "Invoice 42",
              snippet: "THE SNIPPET PHRASE",
              account_email: "support@example.com",
              from_email: "customer@example.com",
              is_read: false,
              is_starred: false,
              assigned_to: null,
              status: "open",
              last_message_at: "2026-01-01T00:00:00.000Z",
              message_count: 1,
            },
          ],
          totalCount: 1,
        }),
    })
    const result = await run("agentMailSearch", { query: "invoice" }, bridge)
    expect(result.needsClientSearch).toBeUndefined()
    expect(JSON.stringify(result)).toContain("Invoice 42")
  })
})

// ── Task 9.8: a forward or reply never sends an empty quote ──────────────────
describe("forwarding and replying from a sealed personal mailbox", () => {
  function sendBridge(account: Record<string, unknown>, sends: unknown[]) {
    return bridgeFor(account, {
      db_findMany: async (entity: string) =>
        entity === "messages" ? JSON.stringify([PLAINTEXT_MESSAGE]) : JSON.stringify([]),
      smtp_send: async (_c: string, _i: string, messageJson: string) => {
        sends.push(JSON.parse(messageJson))
        return JSON.stringify({ messageId: "sent-1", externalThreadId: "t-1" })
      },
      connections_getToken: async () => JSON.stringify({ accessToken: "token" }),
      fetch: async (url: string, optsJson: string) => {
        sends.push({ url, optsJson })
        return JSON.stringify({ status: 200, body: JSON.stringify({ id: "sent-1" }) })
      },
      approval_recordStarted: async () => {},
      approval_recordSucceeded: async () => {},
      approval_recordFailedNoEffect: async () => {},
      approval_recordAmbiguous: async () => {},
      db_insert: async () => JSON.stringify({ id: "new-msg" }),
      db_update: async () => {},
      emit: async () => {},
      resolveContact: async () => JSON.stringify(null),
    })
  }

  async function run(
    exportName: string,
    params: unknown,
    bridge: Record<string, (...args: any[]) => any>,
  ) {
    return (await runMail({
      exportName,
      params,
      bridge,
    })) as any
  }

  /** What actually went on the wire, with the RFC-822 payload decoded. */
  function outboundText(result: unknown, sends: unknown[]): string {
    const serialized = JSON.stringify({ result, sends })
    const decoded = serialized.replace(/[A-Za-z0-9_-]{40,}/g, (candidate) => {
      try {
        return `${candidate} ${Buffer.from(candidate, "base64url").toString("utf8")}`
      } catch {
        return candidate
      }
    })
    return decoded
  }

  it("forwards a plaintext message with its quoted text, byte for byte (non-vacuity)", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailForward",
      { conversationId: CONVERSATION_ID, to: ["someone@example.com"] },
      sendBridge(SHARED_ACCOUNT, sends),
    ).catch((err: unknown) => ({ threw: String(err) }))
    // Either the compose pipeline ran (and quoted the body) or it reported a
    // provider problem, but it must never have quoted an EMPTY original.
    expect(outboundText(result, sends)).toContain("THE BODY PHRASE")
  })

  it("returns a mail.quote marker and sends NOTHING for a sealed mailbox", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailForward",
      { conversationId: CONVERSATION_ID, to: ["someone@example.com"] },
      sendBridge(SEALED_ACCOUNT, sends),
    )
    expect(result.needsPlaintext.requestKind).toBe("mail.quote")
    expect(result.needsPlaintext.messageIds).toEqual(["msg-1"])
    expect(sends.length).toBe(0)
  })

  it("refuses with MAILBOX_LOCKED, and sends nothing, when the quote comes back empty", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailForward",
      {
        conversationId: CONVERSATION_ID,
        to: ["someone@example.com"],
        __mailboxQuote: { "msg-1": { quotedBody: null, resolvedSubject: null } },
      },
      sendBridge(SEALED_ACCOUNT, sends),
    )
    expect(result.error.code).toBe("MAILBOX_LOCKED")
    expect(sends.length).toBe(0)
  })

  it("sends the client-supplied quote and subject once they are supplied", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailForward",
      {
        conversationId: CONVERSATION_ID,
        to: ["someone@example.com"],
        __mailboxQuote: {
          "msg-1": { quotedBody: "CLIENT SUPPLIED BODY", resolvedSubject: "Invoice 42" },
        },
      },
      sendBridge(SEALED_ACCOUNT, sends),
    ).catch((err: unknown) => ({ threw: String(err) }))
    const wire = outboundText(result, sends)
    expect(wire).toContain("CLIENT SUPPLIED BODY")
    expect(wire).toContain("Fwd: Invoice 42")
  })

  it("refuses to reply from a sealed mailbox without the resolved subject", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailReply",
      { conversationId: CONVERSATION_ID, textBody: "our answer" },
      sendBridge(SEALED_ACCOUNT, sends),
    )
    expect(result.needsPlaintext.requestKind).toBe("mail.quote")
    expect(sends.length).toBe(0)
  })

  // ── Task 9.8, the approval half ───────────────────────────────────────────
  //
  // A gated send from a sealed mailbox reaches its handler with the body STRIPPED
  // (Phase 6 sealed it, so `current_payload` holds ciphertext under different
  // key names). If nobody supplies the plaintext at approve time, the drafted
  // body simply is not there, and a send that goes out anyway is a blank email
  // reported as a success. It must refuse.
  it("refuses a compose from a sealed mailbox whose body never arrived, and sends nothing", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      { accountId: ACCOUNT_ID, to: ["someone@example.com"], subject: "Invoice 42" },
      sendBridge(SEALED_ACCOUNT, sends),
    )
    expect(result.error.code).toBe("MAILBOX_LOCKED")
    expect(sends.length).toBe(0)
  })

  it("sends a compose from a sealed mailbox once the body is supplied (non-vacuity)", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      {
        accountId: ACCOUNT_ID,
        to: ["someone@example.com"],
        subject: "Invoice 42",
        textBody: "THE DECRYPTED DRAFT",
      },
      sendBridge(SEALED_ACCOUNT, sends),
    ).catch((err: unknown) => ({ threw: String(err) }))
    expect(outboundText(result, sends)).toContain("THE DECRYPTED DRAFT")
  })

  it("still sends an empty-bodied compose from a shared org mailbox (no behaviour change)", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      { accountId: ACCOUNT_ID, to: ["someone@example.com"], subject: "ping" },
      sendBridge(SHARED_ACCOUNT, sends),
    ).catch((err: unknown) => ({ threw: String(err) }))
    expect((result as any)?.error?.code).not.toBe("MAILBOX_LOCKED")
  })
})

// ── Task 9.9: outbound re-attachment of a sealed file ───────────────────────
describe("re-attaching a stored attachment from a sealed personal mailbox", () => {
  const FILE_ID = "file-1"
  const STAGED_ID = "staged-1"
  const PLAINTEXT_BYTES = Buffer.from("REAL ATTACHMENT BYTES").toString("base64")
  const SEALED_BYTES = Buffer.from("ciphertext-not-readable").toString("base64")

  function attachmentBridge(
    account: Record<string, unknown>,
    sends: unknown[],
    opts: { encVersion: number; bytesBase64: string },
  ) {
    return bridgeFor(account, {
      db_findMany: async (entity: string) =>
        entity === "messages" ? JSON.stringify([PLAINTEXT_MESSAGE]) : JSON.stringify([]),
      smtp_send: async (_c: string, _i: string, messageJson: string) => {
        sends.push(JSON.parse(messageJson))
        return JSON.stringify({ messageId: "sent-1", externalThreadId: "t-1" })
      },
      connections_getToken: async () => JSON.stringify({ accessToken: "token" }),
      fetch: async (url: string, optsJson: string) => {
        sends.push({ url, optsJson })
        return JSON.stringify({ status: 200, body: JSON.stringify({ id: "sent-1" }) })
      },
      approval_recordStarted: async () => {},
      approval_recordSucceeded: async () => {},
      approval_recordFailedNoEffect: async () => {},
      approval_recordAmbiguous: async () => {},
      db_insert: async () => JSON.stringify({ id: "new-msg" }),
      db_update: async () => {},
      emit: async () => {},
      resolveContact: async () => JSON.stringify(null),
      files_attachToParent: async () =>
        JSON.stringify({ id: STAGED_ID, filename: "spec.pdf", mimeType: "application/pdf" }),
      files_getAttachmentBytes: async () =>
        JSON.stringify({
          filename: "spec.pdf",
          mimeType: "application/pdf",
          bytesBase64: opts.bytesBase64,
          encVersion: opts.encVersion,
        }),
      files_reparent: async () => {},
    })
  }

  async function run(
    exportName: string,
    params: unknown,
    bridge: Record<string, (...args: any[]) => any>,
  ) {
    return (await runMail({
      exportName,
      params,
      bridge,
    })) as any
  }

  /** The MIME payload is base64 of a body that itself base64s the attachment,
   *  so one decoding pass is needed before the bytes are recognisable. */
  function wire(result: unknown, sends: unknown[]): string {
    const serialized = JSON.stringify({ result, sends })
    return serialized.replace(/[A-Za-z0-9_-]{40,}/g, (candidate) => {
      try {
        return `${candidate} ${Buffer.from(candidate, "base64url").toString("utf8")}`
      } catch {
        return candidate
      }
    })
  }

  it("re-attaches an unsealed file byte for byte (non-vacuity)", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      {
        accountId: ACCOUNT_ID,
        to: ["someone@example.com"],
        subject: "here it is",
        textBody: "attached",
        attachments: [FILE_ID],
      },
      attachmentBridge(SHARED_ACCOUNT, sends, { encVersion: 0, bytesBase64: PLAINTEXT_BYTES }),
    ).catch((err: unknown) => ({ threw: String(err) }))
    expect(wire(result, sends)).toContain(PLAINTEXT_BYTES)
  })

  it("asks the client for a sealed file instead of sending ciphertext", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      {
        accountId: ACCOUNT_ID,
        to: ["someone@example.com"],
        subject: "here it is",
        textBody: "attached",
        attachments: [FILE_ID],
      },
      attachmentBridge(SEALED_ACCOUNT, sends, { encVersion: 1, bytesBase64: SEALED_BYTES }),
    )
    expect(result.needsPlaintext.requestKind).toBe("mail.attachment")
    expect(result.needsPlaintext.messageIds).toEqual([FILE_ID])
    expect(sends.length).toBe(0)
    // The ciphertext must not have left the system in any shape.
    expect(wire(result, sends)).not.toContain(SEALED_BYTES)
  })

  it("sends the client-supplied plaintext bytes once they are supplied", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      {
        accountId: ACCOUNT_ID,
        to: ["someone@example.com"],
        subject: "here it is",
        textBody: "attached",
        attachments: [FILE_ID],
        __mailboxAttachments: { [FILE_ID]: PLAINTEXT_BYTES },
      },
      attachmentBridge(SEALED_ACCOUNT, sends, { encVersion: 1, bytesBase64: SEALED_BYTES }),
    ).catch((err: unknown) => ({ threw: String(err) }))
    const sent = wire(result, sends)
    expect(sent).toContain(PLAINTEXT_BYTES)
    expect(sent).not.toContain(SEALED_BYTES)
  })

  // A forward carries the original's attachments itself; the caller names none.
  // The approving browser's readable copies have to reach the send all the same.
  it("forwards a sealed original attachment with the client-supplied plaintext bytes", async () => {
    const sends: unknown[] = []
    const bridge = attachmentBridge(SEALED_ACCOUNT, sends, {
      encVersion: 1,
      bytesBase64: SEALED_BYTES,
    })
    bridge.files_listAttachments = async () =>
      JSON.stringify([
        {
          id: FILE_ID,
          filename: "spec.pdf",
          mimeType: "application/pdf",
          sizeBytes: 21,
          disposition: "attachment",
        },
      ])
    const result = await run(
      "agentMailForward",
      {
        conversationId: CONVERSATION_ID,
        to: ["someone@example.com"],
        __mailboxQuote: {
          "msg-1": { quotedBody: "CLIENT SUPPLIED BODY", resolvedSubject: "Invoice 42" },
        },
        __mailboxAttachments: { [FILE_ID]: PLAINTEXT_BYTES },
      },
      bridge,
    ).catch((err: unknown) => ({ threw: String(err) }))
    expect((result as any)?.needsPlaintext).toBeUndefined()
    const sent = wire(result, sends)
    expect(sent).toContain(PLAINTEXT_BYTES)
    expect(sent).not.toContain(SEALED_BYTES)
  })

  it("refuses, and sends nothing, when the supplied bytes are empty", async () => {
    const sends: unknown[] = []
    const result = await run(
      "agentMailCompose",
      {
        accountId: ACCOUNT_ID,
        to: ["someone@example.com"],
        subject: "here it is",
        textBody: "attached",
        attachments: [FILE_ID],
        __mailboxAttachments: { [FILE_ID]: "" },
      },
      attachmentBridge(SEALED_ACCOUNT, sends, { encVersion: 1, bytesBase64: SEALED_BYTES }),
    )
    expect(result.error.code).toBe("MAILBOX_LOCKED")
    expect(sends.length).toBe(0)
  })
})

// ── Task 9.7: ticket conversion is client-fulfilled and explicitly consented ──
describe("converting a sealed personal mail conversation into a team ticket", () => {
  const INBOX_ID = "inbox-1"

  function conversionBridge(account: Record<string, unknown>, created: unknown[]) {
    return bridgeFor(account, {
      db_findMany: async (entity: string) =>
        entity === "messages" ? JSON.stringify([PLAINTEXT_MESSAGE]) : JSON.stringify([]),
      mail_conversion_readConversation: async () =>
        JSON.stringify({
          conversation: {
            id: CONVERSATION_ID,
            account_id: ACCOUNT_ID,
            status: "open",
            subject: account.encryption_state === "ready" ? null : "Invoice 42",
            contact_id: null,
          },
          messages: [
            {
              id: "msg-1",
              direction: "inbound",
              fromEmail: "customer@example.com",
              fromName: "Customer",
              toEmails: ["owner@example.com"],
              subject: account.encryption_state === "ready" ? null : "Invoice 42",
              textBody: account.encryption_state === "ready" ? null : "THE BODY PHRASE",
              htmlBody: null,
              sentAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      mail_conversion_markConverted: async () => JSON.stringify({ ok: true }),
      executeTool: async (toolName: string, paramsJson: string) => {
        created.push({ toolName, params: JSON.parse(paramsJson) })
        return JSON.stringify({
          data: {
            ticketId: "ticket-1",
            ticketHandle: "T-1",
            priority: "normal",
            assignedTo: null,
            categoryId: null,
          },
        })
      },
      emit: async () => {},
    })
  }

  async function run(
    exportName: string,
    params: unknown,
    bridge: Record<string, (...args: any[]) => any>,
  ) {
    return (await runMail({
      exportName,
      params,
      bridge,
    })) as any
  }

  it("converts a shared mailbox conversation with its real body (non-vacuity)", async () => {
    const created: any[] = []
    const result = await run(
      "convertToTicket",
      { conversationId: CONVERSATION_ID, inboxId: INBOX_ID },
      conversionBridge(SHARED_ACCOUNT, created),
    )
    expect(result.ticketId).toBe("ticket-1")
    expect(JSON.stringify(created)).toContain("THE BODY PHRASE")
  })

  it("creates NO ticket for a sealed mailbox and asks for explicit consent instead", async () => {
    const created: any[] = []
    const result = await run(
      "convertToTicket",
      { conversationId: CONVERSATION_ID, inboxId: INBOX_ID },
      conversionBridge(SEALED_ACCOUNT, created),
    )
    expect(result.needsPlaintext.requestKind).toBe("mail.convert")
    expect(result.needsPlaintext.messageIds).toEqual(["msg-1"])
    // The consent copy must name what becomes readable by others.
    expect(result.needsPlaintext.disclosure).toContain("readable by everyone")
    expect(created.length).toBe(0)
  })

  it("converts with the client-supplied plaintext, and audits ids only", async () => {
    const created: any[] = []
    const audits: unknown[] = []
    const bridge = conversionBridge(SEALED_ACCOUNT, created) as Record<string, any>
    bridge.emit = async (payloadJson: string) => {
      const event = JSON.parse(payloadJson)
      if (event.action === "disclosed_to_team") audits.push(event)
    }
    const result = await run(
      "convertToTicket",
      {
        conversationId: CONVERSATION_ID,
        inboxId: INBOX_ID,
        __mailboxConversion: {
          consented: true,
          messages: {
            "msg-1": { subject: "Invoice 42", textBody: "CLIENT DECRYPTED BODY", htmlBody: null },
          },
        },
      },
      bridge,
    )
    expect(result.ticketId).toBe("ticket-1")
    expect(JSON.stringify(created)).toContain("CLIENT DECRYPTED BODY")
    expect(audits.length).toBe(1)
    const audit = JSON.stringify(audits[0])
    expect(audit).toContain("msg-1")
    expect(audit).not.toContain("CLIENT DECRYPTED BODY")
  })

  it("refuses to convert when the client answered without consent", async () => {
    const created: any[] = []
    const result = await run(
      "convertToTicket",
      {
        conversationId: CONVERSATION_ID,
        inboxId: INBOX_ID,
        __mailboxConversion: { consented: false, messages: {} },
      },
      conversionBridge(SEALED_ACCOUNT, created),
    )
    expect(result.error.code).toBe("MAILBOX_LOCKED")
    expect(created.length).toBe(0)
  })
})
