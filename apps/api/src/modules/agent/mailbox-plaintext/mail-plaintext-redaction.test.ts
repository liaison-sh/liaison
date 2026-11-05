// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, Task 6.6: a mail tool result carrying plaintext never lands in
// `kernel.messages.metadata.toolCalls[].result`, never goes out as a
// `tool_result` stream event, and never enters the late-joiner replay buffer.
//
// The predicate is where this goes wrong in both directions, so both are pinned:
//
//   * Read as a positive ALLOWLIST of tools to redact, a mail tool added later
//     defaults to LEAKING. Hence an exemption list and a redact-by-default rule,
//     with a closure test over the manifest that fails the build when a new mail
//     tool has no decision.
//   * Read as "every mail result", it guts the transcript for SHARED and ORG
//     mailboxes, which are explicitly out of scope and are the majority of
//     today's mail-tool traffic. Hence the account condition, with a shared
//     mailbox asserted to survive verbatim on the FULL result object.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import mailManifest from "~/apps/mail/app.manifest.json"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  MAIL_ENVELOPE_ONLY_TOOLS,
  MailPlaintextRedactionTestAccess,
  redactMailPlaintextResult,
  redactMailToolArgs,
  redactMailToolResult,
} from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const BODY_NONCE = "OBSIDIANBODYNONCE"

describe("Invariant K: mail plaintext redaction at the agent persist and stream sites", () => {
  let orgId: string
  let userId: string
  let readyAccountId: string
  let sharedAccountId: string
  let readyConversationId: string
  let readyMessageId: string
  let sharedConversationId: string
  let sharedMessageId: string

  beforeAll(async () => {
    const user = await minimal.person((await createTestOrg()).id)
    orgId = user.orgId
    userId = user.id
    readyAccountId = crypto.randomUUID()
    sharedAccountId = crypto.randomUUID()
    readyConversationId = crypto.randomUUID()
    readyMessageId = crypto.randomUUID()
    sharedConversationId = crypto.randomUUID()
    sharedMessageId = crypto.randomUUID()

    await withSystemDb("redaction-fixture", async (tx) => {
      for (const [id, ownerType, ownerId, state] of [
        [readyAccountId, "user", userId, "ready"],
        [sharedAccountId, "shared", null, "none"],
      ] as Array<[string, string, string | null, string]>) {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
                  ${ownerId}, 'gmail', ${`${id}@redact.test`}, 'active', ${state})`)
      }
      for (const [convId, msgId, acctId, ownerType, ownerId] of [
        [readyConversationId, readyMessageId, readyAccountId, "user", userId],
        [sharedConversationId, sharedMessageId, sharedAccountId, "shared", null],
      ] as Array<[string, string, string, string, string | null]>) {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.conversations
            (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
             is_read, is_starred, message_count)
          VALUES (${convId}::uuid, ${orgId}::uuid, ${acctId}::uuid, ${ownerType},
                  ${ownerId}, ${`thread-${convId}`}, 'open', '[]'::jsonb, false, false, 1)`)
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.messages
            (id, org_id, conversation_id, account_id, external_message_id, message_references,
             from_address, to_addresses, cc_addresses, bcc_addresses, is_read, is_starred, labels,
             direction, raw_headers, owner_type, owner_id)
          VALUES (${msgId}::uuid, ${orgId}::uuid, ${convId}::uuid,
                  ${acctId}::uuid, ${`redact-${msgId}`}, '[]'::jsonb,
                  '{"email":"alice@example.test"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                  false, false, '[]'::jsonb, 'inbound', '{}'::jsonb, ${ownerType}, ${ownerId})`)
      }
    })
    MailPlaintextRedactionTestAccess.resetCache()
  }, 60_000)

  afterAll(async () => {
    await withSystemDb("redaction-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
    })
    MailPlaintextRedactionTestAccess.resetCache()
  })

  // Shaped like a real `mail__read` result: the account id lives under
  // `conversation.account.id`, never at the top level.
  function readResult(
    accountId: string,
    conversationId: string,
    messageId: string,
  ): Record<string, unknown> {
    return {
      conversation: {
        id: conversationId,
        subject: `${BODY_NONCE} subject`,
        account: { id: accountId, email: "someone@redact.test" },
      },
      messages: [{ id: messageId, textBody: `${BODY_NONCE} the whole body`, snippet: BODY_NONCE }],
    }
  }

  it("closure: every mail tool is either redacted or on the named exemption list", () => {
    const tools = Object.keys((mailManifest as { tools: Record<string, unknown> }).tools)
    // Non-vacuity: the manifest must actually have declared tools.
    expect(tools.length).toBeGreaterThan(5)
    const undecided = tools.filter(
      (name) => !MAIL_ENVELOPE_ONLY_TOOLS.has(name) && !isRedactedByDefault(name),
    )
    expect(undecided).toEqual([])
    // And the exemption list may not name a tool that does not exist.
    for (const exempt of MAIL_ENVELOPE_ONLY_TOOLS) {
      expect(tools).toContain(exempt)
    }
  })

  // Every mail tool not on the exemption list redacts. The helper exists so the
  // closure test above states the rule rather than restating the list.
  function isRedactedByDefault(name: string): boolean {
    return !MAIL_ENVELOPE_ONLY_TOOLS.has(name)
  }

  it("redacts a mail__read result on a ready personal mailbox", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const result = readResult(readyAccountId, readyConversationId, readyMessageId)
    const out = await redactMailToolResult(orgId, "mail__read", result)
    // Non-vacuity, positively stated: the replacement is the documented shape,
    // with a non-empty messageIds, so a function that returned `undefined` for
    // everything cannot pass.
    expect(out).not.toBe(result)
    const redacted = out as { messageIds: string[]; byteLength: number; redacted: boolean }
    expect(redacted.redacted).toBe(true)
    expect(redacted.messageIds).toEqual([readyMessageId])
    expect(redacted.byteLength).toBeGreaterThan(0)
    expect(JSON.stringify(out)).not.toContain(BODY_NONCE)
  })

  it("leaves a mail__read on a SHARED org mailbox verbatim, on the whole object", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const result = readResult(sharedAccountId, sharedConversationId, sharedMessageId)
    const out = await redactMailToolResult(orgId, "mail__read", result)
    expect(out).toEqual(result)
  })

  it("leaves an exempted mail tool verbatim even on a ready mailbox", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const result = { accounts: [{ id: readyAccountId, emailAddress: "x@redact.test" }] }
    const out = await redactMailToolResult(orgId, "mail__listAccounts", result)
    expect(out).toEqual(result)
  })

  it("leaves a non-mail tool result verbatim, byte for byte", async () => {
    const result = {
      ticket: { id: "t1", subject: "Broken pedal", body: `${BODY_NONCE} a long ticket body` },
    }
    const out = await redactMailToolResult(orgId, "tickets__get", result)
    expect(out).toBe(result)
  })

  it("fails closed when the mail tool result names no resolvable account", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const out = await redactMailToolResult(orgId, "mail__read", {
      messages: [{ id: readyMessageId, textBody: BODY_NONCE }],
      conversation: { id: crypto.randomUUID() },
    })
    // The message id DOES resolve to the ready mailbox, so this must redact.
    expect((out as { redacted?: boolean }).redacted).toBe(true)

    const unresolvable = await redactMailToolResult(orgId, "mail__read", {
      note: `${BODY_NONCE} nothing identifiable here`,
    })
    expect((unresolvable as { redacted?: boolean }).redacted).toBe(true)
    expect(JSON.stringify(unresolvable)).not.toContain(BODY_NONCE)
  })

  it("redacts a two-phase marker-shaped result regardless of account state", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const out = await redactMailToolResult(orgId, "mail__search", {
      needsClientSearch: true,
      requestId: "abc",
      accountId: sharedAccountId,
      preview: BODY_NONCE,
    })
    expect((out as { redacted?: boolean }).redacted).toBe(true)
  })

  // Tool CALL ARGS are the other half of the same transcript row. A gated
  // `mail__reply` seals its body into the approval payload and then wrote the
  // very same cleartext into `kernel.messages.metadata.toolCalls[].args` and on
  // to the stream, so the seal bought nothing against an org admin or the
  // operator. The Phase 12 purge only strips `{toolCalls}` for PRE-cutover rows,
  // on the stated assumption that everything written after the cutover is
  // envelope only.
  it("redacts the drafted body out of a mail__reply's call args on a ready mailbox", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const out = (await redactMailToolArgs(orgId, "mail__reply", {
      conversationId: readyConversationId,
      messageId: readyMessageId,
      subject: `${BODY_NONCE} subject`,
      textBody: `${BODY_NONCE} the drafted body`,
      htmlBody: `<p>${BODY_NONCE}</p>`,
      note: `${BODY_NONCE} note`,
      quotedOriginal: `${BODY_NONCE} quoted`,
    })) as Record<string, unknown>

    expect(JSON.stringify(out)).not.toContain(BODY_NONCE)
    expect(out.redacted).toBe(true)
    // The envelope survives, so the transcript still says what was replied to.
    expect(out.conversationId).toBe(readyConversationId)
    expect(out.messageId).toBe(readyMessageId)
    expect(out.redactedFields).toEqual(
      expect.arrayContaining(["subject", "textBody", "htmlBody", "note", "quotedOriginal"]),
    )
    expect(out.byteLength).toBeGreaterThan(0)
  })

  it("leaves a mail__reply's args verbatim on a SHARED org mailbox", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const args = {
      conversationId: sharedConversationId,
      subject: `${BODY_NONCE} subject`,
      textBody: `${BODY_NONCE} the drafted body`,
    }
    const out = await redactMailToolArgs(orgId, "mail__reply", args)
    expect(out).toBe(args)
  })

  it("leaves a non-mail tool's args verbatim, by reference", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const args = { body: `${BODY_NONCE} not mail at all` }
    expect(await redactMailToolArgs(orgId, "tickets__reply", args)).toBe(args)
  })

  it("fails closed when mail args name no resolvable mailbox", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const out = (await redactMailToolArgs(orgId, "mail__compose", {
      to: ["someone@example.test"],
      subject: `${BODY_NONCE} subject`,
      textBody: `${BODY_NONCE} body`,
    })) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain(BODY_NONCE)
    expect(out.redacted).toBe(true)
  })

  it("leaves an exempted mail tool's args verbatim", async () => {
    MailPlaintextRedactionTestAccess.resetCache()
    const args = { accountId: readyAccountId }
    expect(await redactMailToolArgs(orgId, "mail__getAccount", args)).toBe(args)
  })

  it("shapes the replacement identically wherever it is applied", () => {
    const out = redactMailPlaintextResult({
      messages: [{ id: "m1" }, { id: "m2" }],
      body: "x".repeat(40),
    })
    expect(out.redacted).toBe(true)
    expect(out.messageIds).toEqual(["m1", "m2"])
    expect(out.byteLength).toBeGreaterThan(0)
  })

  describe("file analysis tools (analyze_media, mail_attachment_read)", () => {
    const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
    const privateFile = crypto.randomUUID()
    const sharedFile = crypto.randomUUID()
    const ticketFile = crypto.randomUUID()

    beforeAll(async () => {
      await withSystemDb("redaction-file-fixture", async (tx) => {
        for (const [id, app, entityType, entityId] of [
          [privateFile, "mail", "message", readyMessageId],
          [sharedFile, "mail", "message", sharedMessageId],
          [ticketFile, "tickets", "ticket", crypto.randomUUID()],
        ] as Array<[string, string, string, string]>) {
          await tx.execute(drizzleSql`
            INSERT INTO ${K}.files
              (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
            VALUES (${id}::uuid, ${orgId}::uuid, ${app}, ${entityType}, ${entityId},
                    'invoice.pdf', 'application/pdf', 10, ${`orgs/${orgId}/${app}/${id}`})`)
        }
      })
    })

    afterAll(async () => {
      await withSystemDb("redaction-file-cleanup", async (tx) => {
        await tx.execute(drizzleSql`DELETE FROM ${K}.files WHERE org_id = ${orgId}::uuid`)
      })
    })

    const summary = (fileId?: string) => ({
      ...(fileId ? { fileId } : {}),
      summary: `${BODY_NONCE} invoice INV-2207`,
      model: "gemini-flash-lite-latest",
      analyzedAt: "2026-11-04T00:00:00.000Z",
      cached: false,
    })

    for (const tool of ["kernel__analyze_media", "kernel__mail_attachment_read"]) {
      it(`${tool}: a summary of a private mailbox's attachment is redacted`, async () => {
        const out = await redactMailToolResult(orgId, tool, summary(privateFile))
        expect(JSON.stringify(out)).not.toContain(BODY_NONCE)
        expect(out).toMatchObject({ fileId: privateFile, redacted: true })
      })

      it(`${tool}: a summary with no resolvable file fails closed`, async () => {
        for (const result of [summary(), summary(crypto.randomUUID())]) {
          const out = await redactMailToolResult(orgId, tool, result)
          expect(JSON.stringify(out)).not.toContain(BODY_NONCE)
        }
      })

      it(`${tool}: a shared mailbox's attachment and another app's file stay verbatim`, async () => {
        for (const id of [sharedFile, ticketFile]) {
          const result = summary(id)
          expect(await redactMailToolResult(orgId, tool, result)).toBe(result)
        }
      })

      it(`${tool}: a result with no content (error, marker, delivered stub) stays verbatim`, async () => {
        for (const result of [
          { error: { code: "private_mailbox", message: "Use kernel__mail_attachment_read." } },
          {
            fileId: privateFile,
            mailbox: { status: "delivered", message: "in the context block" },
          },
        ]) {
          expect(await redactMailToolResult(orgId, tool, result)).toBe(result)
        }
      })
    }
  })
})
