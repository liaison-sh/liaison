// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { sanitizeCustomerHtml } from "~/lib/email/sanitize"
import { rootLogger } from "~/lib/logger"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { ERROR_NOT_FOUND, envelopeError } from "~/modules/apps/sandbox/bridge/shared"

/** Mail <-> tickets conversion in both directions. */
export function createConversionMethods(ctx: BridgeContext): Record<string, any> {
  const {
    actorIdForEvent,
    actorType,
    appTable,
    auditActorType,
    callerScopes,
    kernelSchema,
    mailSchema,
    mapMailMessageRow,
    mapTicketMessageRowToMail,
    naturalAppendKey,
    orgId,
    queueAppEvent,
    requireApp,
    rpcBridge,
    ticketsSchema,
    txDb,
    userId,
  } = ctx
  return {
    // --- Mail conversion bridge methods ---
    mail_conversion_readConversation: async (conversationId: string): Promise<string> => {
      requireApp("mail", "mail_conversion_readConversation")
      const conversations = appTable(mailSchema, "conversations")
      const tickets = appTable(ticketsSchema, "tickets")
      const messages = appTable(mailSchema, "messages")
      const conv = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT c.id, c.status, c.escalated_ticket_id, c.subject, c.account_id, c.contact_id,
                 t.handle AS escalated_ticket_handle
          FROM ${conversations} c
          LEFT JOIN ${tickets} t ON t.id = c.escalated_ticket_id AND t.org_id = c.org_id
          WHERE c.id = ${conversationId}::uuid AND c.org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!conv) return envelopeError(ERROR_NOT_FOUND.code, "conversation not visible")
      // The escalated ticket is named by its DISPLAY handle (`ticket-B2B-12`).
      if (conv.escalated_ticket_id && conv.escalated_ticket_handle) {
        const { displayHandleFor } = await import("~/apps/tickets/display-handle")
        conv.escalated_ticket_handle =
          (await displayHandleFor(txDb as never, orgId, String(conv.escalated_ticket_id))) ??
          conv.escalated_ticket_handle
      }
      const msgRows = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject,
                 html_body, text_body, external_message_id, external_provider_id,
                 in_reply_to, message_references, sent_at
          FROM ${messages}
          WHERE conversation_id = ${conversationId}::uuid AND org_id = ${orgId}::uuid
          ORDER BY sent_at, created_at, id
        `),
      )
      return JSON.stringify({ conversation: conv, messages: msgRows.map(mapMailMessageRow) })
    },

    mail_conversion_markConverted: async (
      conversationId: string,
      ticketId: string,
      ticketHandle: string,
    ): Promise<string> => {
      requireApp("mail", "mail_conversion_markConverted")
      const conversations = appTable(mailSchema, "conversations")
      const updated = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          UPDATE ${conversations}
          SET escalated_ticket_id = ${ticketId}::uuid, status = 'escalated', updated_at = now()
          WHERE id = ${conversationId}::uuid AND org_id = ${orgId}::uuid
          RETURNING id
        `),
      )
      if (updated.length === 0)
        return envelopeError(ERROR_NOT_FOUND.code, "conversation not visible")
      await queueAppEvent("mail", "conversation", "converted", conversationId, {
        conversationId,
        escalatedTicketId: ticketId,
        escalatedTicketHandle: ticketHandle,
      })
      return JSON.stringify({ ok: true })
    },

    mail_createFromTicket: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_createFromTicket")
      const params = JSON.parse(paramsJson || "{}") as Record<string, any>
      const accountId = params.accountId as string | undefined
      const subject = params.subject as string | undefined
      if (!accountId || !subject)
        return envelopeError("invalid_params", "accountId and subject required")
      const actorUserId = actorIdForEvent()
      if (!actorUserId) return envelopeError("forbidden", "user-owned account required")
      const accounts = appTable(mailSchema, "accounts")
      const conversations = appTable(mailSchema, "conversations")
      const messages = appTable(mailSchema, "messages")
      // BL-79: accept EITHER the actor's own personal mailbox OR an org-owned
      // (shared) account in this org. De-escalating a ticket back into a SHARED
      // team mailbox (e.g. routing a mis-filed dealer-pricing case to sales) is a
      // legitimate flow; restricting the target to the actor's personal mailbox
      // blocked it ("account not visible" on a valid org account). The actor has
      // already passed the gated mail:conversations:write scope, the query is
      // org-scoped, and it runs under the caller's RLS.
      const account = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT id, owner_type, owner_id, encryption_state
          FROM ${accounts}
          WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid
            AND (
              (owner_type = 'user' AND owner_id = ${actorUserId}::uuid)
              OR owner_type = 'org'
            )
          LIMIT 1
        `),
      )[0]
      if (!account) return envelopeError(ERROR_NOT_FOUND.code, "account not visible")

      // Converting a ticket into an end-to-end encrypted personal mailbox seals
      // the ticket's content to ONE person's key: the team can no longer read it
      // through the mail surface. That is the accepted consequence of the
      // mailbox being personal, and the ticket keeps its own team-visible copy.
      // What is NOT acceptable is writing it as plaintext, so a mailbox that
      // cannot be sealed to refuses the conversion outright.
      const {
        applyMailSealToRow,
        assertMailboxWritable: assertMailWritableHost,
        assertSealRecipient: assertSealRecipientHost,
        mailboxRequiresSealing,
        pointConversationAtMessage,
        resolveMailAccountCrypto: resolveAccountCryptoTicket,
      } = await import("~/modules/mailbox-crypto/mail-writer")
      const ticketAccountCrypto = await resolveAccountCryptoTicket(
        txDb,
        mailSchema,
        orgId,
        account.id as string,
      )
      assertMailWritableHost(ticketAccountCrypto, "mail_createFromTicket")
      const ticketSealing = mailboxRequiresSealing(ticketAccountCrypto)
      if (ticketSealing) assertSealRecipientHost(ticketAccountCrypto, actorUserId)

      const externalThreadId = `ticket:${params.idempotencyKey ?? crypto.randomUUID()}`
      const conversation = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          INSERT INTO ${conversations} (
            id, org_id, account_id, owner_type, owner_id, external_thread_id, subject,
            snippet, contact_id, status, labels, is_read, is_starred, last_message_at,
            message_count, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${accountId}::uuid, ${account.owner_type}, ${account.owner_id}::uuid,
            ${externalThreadId}, ${ticketSealing ? null : subject}, null, ${params.contact?.id ?? null}::uuid,
            'open', '[]'::jsonb, true, false, null, 0, now(), now()
          )
          ON CONFLICT (org_id, account_id, external_thread_id) DO NOTHING
          RETURNING id
        `),
      )[0]
      if (!conversation?.id) {
        // The same idempotency key converted this ticket already (a retried
        // conversion): that conversation is the answer, not a unique violation.
        const existing = extractRows<{ id: string }>(
          await txDb.execute(drizzleSql`
            SELECT id FROM ${conversations}
             WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
               AND external_thread_id = ${externalThreadId}`),
        )[0]
        if (existing?.id) return JSON.stringify({ mailConversationId: existing.id })
        return envelopeError("insert_failed", "mail conversation insert failed")
      }

      let messageCount = 0
      let lastMessageAt: string | null = null
      let snippet: string | null = null
      let lastSealedMessageId: string | null = null
      for (const m of (params.messages ?? []) as Record<string, any>[]) {
        if (m.direction !== "inbound" && m.direction !== "outbound") continue
        const sentAt = m.sentAt ?? new Date().toISOString()
        const body = m.textBody ?? m.htmlBody ?? ""
        const inserted = extractRows<{ id: string }>(
          await txDb.execute(drizzleSql`
            INSERT INTO ${messages} (
              id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
              in_reply_to, message_references, from_address, to_addresses, cc_addresses,
              bcc_addresses, subject, text_body, html_body, snippet, is_read, is_starred,
              labels, direction, sent_at, synced_at, raw_headers, owner_type, owner_id,
              sent_by_user_id, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${orgId}::uuid, ${conversation.id}::uuid, ${accountId}::uuid,
              ${m.externalMessageId ?? null}, ${m.externalProviderId ?? null}, ${m.inReplyTo ?? null},
              ${JSON.stringify(m.messageReferences ?? m.references ?? [])}::jsonb,
              ${JSON.stringify(m.fromEmail ? { email: m.fromEmail, name: m.fromName ?? undefined } : {})}::jsonb,
              ${JSON.stringify((m.toEmails ?? []).map((email: string) => ({ email })))}::jsonb,
              ${JSON.stringify((m.ccEmails ?? []).map((email: string) => ({ email })))}::jsonb,
              '[]'::jsonb, ${ticketSealing ? null : (m.subject ?? subject)},
              ${ticketSealing ? null : (m.textBody ?? null)},
              ${ticketSealing ? null : (m.htmlBody ?? null)},
              ${ticketSealing ? null : body.slice(0, 200)}, true, false, '[]'::jsonb, ${m.direction}, ${sentAt}::timestamptz,
              now(), '{}'::jsonb, ${account.owner_type}, ${account.owner_id}::uuid, null, now(), now()
            )
            ON CONFLICT (org_id, account_id, external_message_id) DO NOTHING
            RETURNING id
          `),
        )[0]
        // A ticket message whose Message-ID this mailbox already stores (it was
        // synced, or listed twice) is not copied a second time.
        if (!inserted) continue
        // Seal against the id the INSERT returned, inside the same transaction:
        // a failure rolls the whole conversion back rather than leaving
        // plaintext behind.
        if (ticketSealing) {
          await applyMailSealToRow(txDb, {
            schemaName: mailSchema,
            orgId,
            userId: ticketAccountCrypto.ownerId as string,
            account: ticketAccountCrypto,
            entity: "messages",
            rowId: inserted.id,
            values: {
              subject: m.subject ?? subject,
              textBody: m.textBody ?? null,
              htmlBody: m.htmlBody ?? null,
              snippet: body.slice(0, 200),
            },
            headers: {},
          })
          lastSealedMessageId = inserted.id
        }
        messageCount += 1
        lastMessageAt = sentAt
        snippet = body.slice(0, 200)
        await queueAppEvent("mail", "message", "create", inserted.id, {
          id: inserted.id,
          conversationId: conversation.id,
          accountId,
          direction: m.direction,
        })
      }
      await txDb.execute(drizzleSql`
        UPDATE ${conversations}
        SET message_count = ${messageCount}, last_message_at = ${lastMessageAt}::timestamptz,
            snippet = ${ticketSealing ? null : snippet}, updated_at = now()
        WHERE id = ${conversation.id}::uuid AND org_id = ${orgId}::uuid
      `)
      if (ticketSealing && lastSealedMessageId) {
        await pointConversationAtMessage(
          txDb,
          mailSchema,
          orgId,
          conversation.id,
          lastSealedMessageId,
        )
      }
      await queueAppEvent("mail", "conversation", "create", conversation.id, {
        id: conversation.id,
        accountId,
        subject,
      })
      return JSON.stringify({ mailConversationId: conversation.id })
    },

    mail_appendInboundMessage: async (
      conversationId: string,
      messageJson: string,
      idempotencyKey?: string,
    ): Promise<string> => {
      requireApp("mail", "mail_appendInboundMessage")
      const message = JSON.parse(messageJson || "{}") as Record<string, any>
      // Sanitize the inbound HTML body server-side as defence-in-depth — the
      // client renderer is the last line of defence, but storing already-stripped
      // HTML prevents exfiltration via other read paths (exports, webhooks, agent
      // tool calls). This is the dominant inbound-mail channel (raw IMAP/SMTP),
      // so it must mirror the db_insert sanitization above.
      if (typeof message.htmlBody === "string") {
        message.htmlBody = sanitizeCustomerHtml(message.htmlBody)
      }
      const key = idempotencyKey ?? naturalAppendKey(conversationId, message)
      let localIdempotencyReserved = false
      const conversations = appTable(mailSchema, "conversations")
      const messages = appTable(mailSchema, "messages")
      const conversation = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT c.id, c.account_id, c.owner_type, c.owner_id, a.encryption_state
          FROM ${conversations} c
          JOIN ${appTable(mailSchema, "accounts")} a ON a.id = c.account_id
          WHERE c.id = ${conversationId}::uuid AND c.org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!conversation) return envelopeError(ERROR_NOT_FOUND.code, "conversation not visible")
      // API-inbox ingest seals exactly as the sync path does. The recipient is
      // the mailbox OWNER, resolved here and never supplied by the caller, so an
      // append into a personal mailbox can only ever be sealed to that mailbox's
      // own owner.
      const {
        applyMailSealToRow: applySealAppend,
        assertMailboxWritable: assertWritableAppend,
        mailboxRequiresSealing: requiresSealingAppend,
        pointConversationAtMessage: pointConvAppend,
        resolveMailAccountCrypto: resolveAccountCryptoAppend,
      } = await import("~/modules/mailbox-crypto/mail-writer")
      const appendAccountCrypto = await resolveAccountCryptoAppend(
        txDb,
        mailSchema,
        orgId,
        conversation.account_id as string,
      )
      assertWritableAppend(appendAccountCrypto, "mail_appendInboundMessage")
      const appendSealing = requiresSealingAppend(appendAccountCrypto)
      if (!idempotencyKey) {
        const { reserveIdempotency } = await import("~/modules/apps/idempotency")
        const reservation = await reserveIdempotency(orgId, "mail:appendInboundMessage", key, {
          conversationId,
          message,
          idempotencyKey: key,
        })
        if (reservation.outcome === "hit") {
          if ("data" in reservation.cached) {
            return JSON.stringify({
              ...(reservation.cached.data as Record<string, unknown>),
              idempotent: true,
            })
          }
          return JSON.stringify(reservation.cached)
        }
        if (reservation.outcome === "conflict") {
          return envelopeError("idempotency_conflict", "different params for same idempotency key")
        }
        if (reservation.outcome === "in_flight") {
          return envelopeError(
            "idempotency_in_flight",
            "concurrent call with same idempotency key in progress",
            true,
          )
        }
        localIdempotencyReserved = true
      }
      try {
        if (message.externalMessageId) {
          const existing = extractRows<{ id: string }>(
            await txDb.execute(drizzleSql`
            SELECT id FROM ${messages}
            WHERE conversation_id = ${conversationId}::uuid AND org_id = ${orgId}::uuid
              AND external_message_id = ${message.externalMessageId}
            LIMIT 1
          `),
          )[0]
          if (existing?.id) return JSON.stringify({ messageId: existing.id, idempotent: true })
        }
        const sentAt = message.sentAt ?? new Date().toISOString()
        const body = message.textBody ?? message.htmlBody ?? ""
        const inserted = extractRows<{ id: string }>(
          await txDb.execute(drizzleSql`
          INSERT INTO ${messages} (
            id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
            in_reply_to, message_references, from_address, to_addresses, cc_addresses,
            bcc_addresses, subject, text_body, html_body, snippet, is_read, is_starred,
            labels, direction, sent_at, synced_at, raw_headers, owner_type, owner_id,
            sent_by_user_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${conversationId}::uuid, ${conversation.account_id}::uuid,
            ${message.externalMessageId ?? null}, ${message.externalProviderId ?? null}, ${message.inReplyTo ?? null},
            ${JSON.stringify(message.references ?? [])}::jsonb,
            ${JSON.stringify(message.fromEmail ? { email: message.fromEmail, name: message.fromName ?? undefined } : {})}::jsonb,
            ${JSON.stringify((message.toEmails ?? []).map((email: string) => ({ email })))}::jsonb,
            ${JSON.stringify((message.ccEmails ?? []).map((email: string) => ({ email })))}::jsonb,
            '[]'::jsonb, ${appendSealing ? null : (message.subject ?? null)},
            ${appendSealing ? null : (message.textBody ?? null)},
            ${appendSealing ? null : (message.htmlBody ?? null)},
            ${appendSealing ? null : body.slice(0, 200)}, false, false, '[]'::jsonb, 'inbound', ${sentAt}::timestamptz,
            now(), '{}'::jsonb, ${conversation.owner_type}, ${conversation.owner_id}::uuid, null, now(), now()
          )
          RETURNING id
        `),
        )[0]
        if (appendSealing) {
          await applySealAppend(txDb, {
            schemaName: mailSchema,
            orgId,
            userId: appendAccountCrypto.ownerId as string,
            entity: "messages",
            rowId: inserted.id,
            values: {
              subject: message.subject ?? null,
              textBody: message.textBody ?? null,
              htmlBody: message.htmlBody ?? null,
              snippet: body.slice(0, 200),
            },
            headers: {},
          })
        }
        await txDb.execute(drizzleSql`
        UPDATE ${conversations}
        SET message_count = message_count + 1, last_message_at = ${sentAt}::timestamptz,
            snippet = ${appendSealing ? null : body.slice(0, 200)}, is_read = false, updated_at = now()
        WHERE id = ${conversationId}::uuid AND org_id = ${orgId}::uuid
      `)
        if (appendSealing) {
          await pointConvAppend(txDb, mailSchema, orgId, conversationId, inserted.id)
        }
        await queueAppEvent("mail", "message", "create", inserted.id, {
          id: inserted.id,
          conversationId,
          accountId: conversation.account_id,
          direction: "inbound",
          idempotencyKey: key,
        })
        // Persist any inbound attachments into the kernel files store.
        // Best-effort: a single failed attachment must not roll back the message.
        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
          for (let ordinal = 0; ordinal < message.attachments.length; ordinal++) {
            const att = message.attachments[ordinal] as {
              filename?: string
              mimeType?: string
              bytesBase64?: string
              disposition?: string
              contentId?: string
            }
            if (!att?.bytesBase64) continue
            try {
              await rpcBridge.files_importAttachment(
                JSON.stringify({
                  targetApp: "mail",
                  targetEntityType: "message",
                  targetEntityId: inserted.id,
                  filename: att.filename || "attachment",
                  mimeType: att.mimeType || "application/octet-stream",
                  bytesBase64: att.bytesBase64,
                  disposition: att.disposition ?? "attachment",
                  contentId: att.contentId ?? null,
                  ordinal,
                }),
              )
            } catch {
              // Log but continue — a failed attachment row must not abort the ingest.
              rootLogger.warn(
                { messageId: inserted.id, filename: att.filename },
                "Failed to persist inbound message attachment",
              )
            }
          }
        }
        if (localIdempotencyReserved) {
          const { finalizeIdempotency } = await import("~/modules/apps/idempotency")
          await finalizeIdempotency(
            orgId,
            "mail:appendInboundMessage",
            key,
            { conversationId, message, idempotencyKey: key },
            { data: { messageId: inserted.id, idempotent: false } },
          )
        }
        return JSON.stringify({ messageId: inserted.id, idempotent: false })
      } catch (err) {
        if (localIdempotencyReserved) {
          const { invalidateIdempotency } = await import("~/modules/apps/idempotency")
          await invalidateIdempotency(orgId, "mail:appendInboundMessage", key)
        }
        throw err
      }
    },

    // --- Tickets conversion and summary bridge methods ---
    tickets_conversion_readTicket: async (ticketId: string): Promise<string> => {
      requireApp("tickets", "tickets_conversion_readTicket")
      const tickets = appTable(ticketsSchema, "tickets")
      const messages = appTable(ticketsSchema, "messages")
      const contacts = appTable(kernelSchema, "contacts")
      const ticket = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT t.*, c.id AS contact_id_value, c.email AS contact_email, c.name AS contact_name
          FROM ${tickets} t
          LEFT JOIN ${contacts} c ON c.id = t.contact_id AND c.org_id = t.org_id
          WHERE t.id = ${ticketId}::uuid AND t.org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!ticket) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
      const msgRows = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT * FROM ${messages}
          WHERE ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          ORDER BY sent_at, created_at, id
        `),
      )
      const contact = ticket.contact_id_value
        ? { id: ticket.contact_id_value, email: ticket.contact_email, name: ticket.contact_name }
        : null
      return JSON.stringify({
        ticket: { ...ticket, contact },
        messages: msgRows,
        mailMessages: msgRows
          .filter((row) => row.kind === "inbound" || row.kind === "outbound")
          .map(mapTicketMessageRowToMail),
      })
    },

    tickets_createFromMail: async (paramsJson: string): Promise<string> => {
      requireApp("tickets", "tickets_createFromMail")
      const params = JSON.parse(paramsJson || "{}") as Record<string, any>
      const { createTicket } = await import("~/apps/tickets/create")
      const created = await createTicket(
        txDb as never,
        orgId,
        {
          subject: params.subject,
          channel: "mail_escalation",
          priority: params.priority ?? "normal",
          categoryId: params.categoryId ?? null,
          assignedTo: params.assigneeId ?? null,
          // BL-73: prefer the conversation's authoritative contact id (createTicket
          // links it directly); fall back to resolving/creating from the sender email.
          contactId: params.contact?.id ?? null,
          contactEmail: params.contact?.email ?? null,
          contactName: params.contact?.name ?? null,
          sourceInboxId: params.sourceInboxId,
        },
        { actorType: actorType as "user" | "agent" | "system" | "mcp", auditActorType, userId },
      )
      if ("error" in created) return JSON.stringify(created)
      const tickets = appTable(ticketsSchema, "tickets")
      const messages = appTable(ticketsSchema, "messages")
      await txDb.execute(drizzleSql`
        UPDATE ${tickets}
        SET source_conversation_id = ${params.sourceConversationId ?? null}::uuid, updated_at = now()
        WHERE id = ${created.ticketId}::uuid AND org_id = ${orgId}::uuid
      `)
      let count = 0
      let lastInbound: string | null = null
      let lastOutbound: string | null = null
      let lastMessage: string | null = null
      let firstResponse: string | null = null
      for (const m of (params.messages ?? []) as Record<string, any>[]) {
        const kind = m.direction === "outbound" ? "outbound" : "inbound"
        const sentAt = m.sentAt ?? new Date().toISOString()
        const body = m.textBody ?? m.htmlBody ?? ""
        // ON CONFLICT DO NOTHING makes the copy idempotent: convertToTicket can
        // partially apply and then retry (e.g. a transient mid-convert error), and
        // the per-message UNIQUE (org_id, external_message_id) would otherwise abort
        // the retry with a duplicate-key "Failed query". On conflict the message
        // already exists from the first pass — skip its counters + event.
        const inserted = extractRows<{ id: string }>(
          await txDb.execute(drizzleSql`
            INSERT INTO ${messages} (
              id, org_id, ticket_id, kind, from_email, from_name, to_emails, cc_emails,
              subject, html_body, text_body, snippet, external_message_id, in_reply_to,
              header_references, sent_at, created_by, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${orgId}::uuid, ${created.ticketId}::uuid, ${kind},
              ${m.fromEmail ?? null}, ${m.fromName ?? null}, ${JSON.stringify(m.toEmails ?? [])}::jsonb,
              ${JSON.stringify(m.ccEmails ?? [])}::jsonb, ${m.subject ?? null}, ${m.htmlBody ?? null},
              ${m.textBody ?? null}, ${body.slice(0, 200)}, ${m.externalMessageId ?? null},
              ${m.inReplyTo ?? null}, ${JSON.stringify(m.references ?? [])}::jsonb,
              ${sentAt}::timestamptz, ${actorIdForEvent()}::uuid, now(), now()
            )
            ON CONFLICT (org_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
            RETURNING id
          `),
        )[0]
        if (!inserted) continue
        count += 1
        lastMessage = sentAt
        if (kind === "inbound") lastInbound = sentAt
        if (kind === "outbound") {
          lastOutbound = sentAt
          firstResponse ??= sentAt
        }
        await queueAppEvent("tickets", "message", "create", inserted.id, {
          ticketId: created.ticketId,
          messageId: inserted.id,
          kind,
        })
      }
      await txDb.execute(drizzleSql`
        UPDATE ${tickets}
        SET message_count = ${count}, last_inbound_at = ${lastInbound}::timestamptz,
            last_outbound_at = ${lastOutbound}::timestamptz,
            last_message_at = ${lastMessage}::timestamptz,
            first_response_at = ${firstResponse}::timestamptz,
            sla_active_started_at = CASE WHEN ${firstResponse}::timestamptz IS NOT NULL THEN NULL ELSE sla_active_started_at END,
            sla_paused_at = CASE WHEN ${firstResponse}::timestamptz IS NOT NULL THEN NULL ELSE sla_paused_at END,
            sla_breached_at = CASE WHEN ${firstResponse}::timestamptz IS NOT NULL THEN NULL ELSE sla_breached_at END,
            updated_at = now()
        WHERE id = ${created.ticketId}::uuid AND org_id = ${orgId}::uuid
      `)
      // BL-78: echo the applied fields so mail:convertToTicket's atomic result is
      // self-verifying (priority/assignee/category all set in the one convert call).
      return JSON.stringify({
        ticketId: created.ticketId,
        ticketHandle: created.ticketHandle,
        priority: created.priority,
        assignedTo: created.assignedTo,
        categoryId: created.categoryId,
      })
    },

    tickets_conversion_closeAsMailConverted: async (
      ticketId: string,
      mailConversationId: string,
      note?: string,
    ): Promise<string> => {
      requireApp("tickets", "tickets_conversion_closeAsMailConverted")
      const { validateAndApply } = await import("~/apps/tickets/state-machine")
      const result = await validateAndApply(
        txDb as never,
        ticketId,
        { kind: "convertToMail", mailConversationId },
        {
          actorType: actorType as "user" | "agent" | "system" | "mcp",
          auditActorType,
          userId,
          orgId,
        },
      )
      if (!result.ok)
        return JSON.stringify({
          error: { code: result.code, message: result.message, retryable: false },
        })
      if (note) {
        const { generateTimelineEntries } = await import("~/modules/audit/timeline")
        await generateTimelineEntries(
          txDb as never,
          {
            orgId,
            app: "tickets",
            entity: "ticket",
            entityId: ticketId,
            action: "converted_to_mail_note",
            userId: actorIdForEvent(),
            // The same X10 split: `kernel.timeline_entries` has no agent
            // column, so only the category can follow the acting agent here.
            actorType: auditActorType,
            data: { note, mailConversationId },
            actionLabel: "Converted to mail",
            details: { note, mailConversationId },
          } as never,
        )
      }
      return JSON.stringify({ ticketId, mailConversationId })
    },

    tickets_deleteIfUnreferenced: async (
      ticketId: string,
      idempotencyKey?: string,
    ): Promise<string> => {
      requireApp("tickets", "tickets_deleteIfUnreferenced")
      const tickets = appTable(ticketsSchema, "tickets")
      const messages = appTable(ticketsSchema, "messages")
      const mailConversations = appTable(mailSchema, "conversations")
      const locked = extractRows<{ id: string; created_at: Date | string }>(
        await txDb.execute(drizzleSql`
          SELECT id, created_at FROM ${tickets}
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          FOR UPDATE
        `),
      )[0]
      if (!locked) return envelopeError(ERROR_NOT_FOUND.code, "ticket not found")
      // Reference-integrity checks MUST be complete — a compensating-cleanup caller
      // is often a system/cross-app actor (NIL_UUID under RLS, no dimension grants),
      // so an RLS-bound read of the referencing rows (e.g. a user-owned mail
      // conversation under conversations_deny_default) under-counts to zero and the
      // guard would delete a still-referenced ticket. Read every reference under a
      // privileged org-scoped tx, exactly like the approval-ref check below.
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { refs, merged, later, approvals } = await withPrivilegedDb(
        orgId,
        "tickets-delete-ref-check",
        async (privilegedTx) => ({
          refs: extractRows(
            await privilegedTx.execute(drizzleSql`
              SELECT 1 FROM ${mailConversations}
              WHERE escalated_ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
              LIMIT 1
            `),
          ),
          merged: extractRows(
            await privilegedTx.execute(drizzleSql`
              SELECT 1 FROM ${tickets}
              WHERE merged_into_ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
              LIMIT 1
            `),
          ),
          later: extractRows(
            await privilegedTx.execute(drizzleSql`
              SELECT 1 FROM ${messages}
              WHERE ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
                AND created_at > (${locked.created_at}::timestamptz + interval '1 second')
              LIMIT 1
            `),
          ),
          approvals: extractRows(
            await privilegedTx.execute(drizzleSql`
              SELECT 1 FROM ${appTable(kernelSchema, "approval_requests")}
              WHERE org_id = ${orgId}::uuid
                AND (tool_params::text LIKE ${`%${ticketId}%`} OR current_payload::text LIKE ${`%${ticketId}%`})
              LIMIT 1
            `),
          ),
        }),
      )
      if (refs.length > 0 || merged.length > 0 || later.length > 0 || approvals.length > 0) {
        return envelopeError("still_referenced", "ticket is still referenced")
      }
      await txDb.execute(
        drizzleSql`DELETE FROM ${messages} WHERE ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid`,
      )
      await txDb.execute(
        drizzleSql`DELETE FROM ${tickets} WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid`,
      )
      if (idempotencyKey) {
        const { invalidateIdempotency } = await import("~/modules/apps/idempotency")
        await invalidateIdempotency(orgId, "tickets:createFromMail", idempotencyKey)
      }
      return JSON.stringify({ deleted: true })
    },

    tickets_pullMailReply: async (
      ticketId: string,
      mailMessageId: string,
      _idempotencyKey?: string,
    ): Promise<string> => {
      requireApp("tickets", "tickets_pullMailReply")
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("mail:conversations:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "missing scope: mail:conversations:read")
      }
      const tickets = appTable(ticketsSchema, "tickets")
      const ticketMessages = appTable(ticketsSchema, "messages")
      const mailConversations = appTable(mailSchema, "conversations")
      const mailMessages = appTable(mailSchema, "messages")
      const ticket = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          SELECT id FROM ${tickets}
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!ticket) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
      const mail = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT mm.*
          FROM ${mailMessages} mm
          JOIN ${mailConversations} mc ON mc.id = mm.conversation_id AND mc.org_id = mm.org_id
          JOIN ${tickets} t ON t.source_conversation_id = mc.id AND t.org_id = mc.org_id
          WHERE t.id = ${ticketId}::uuid
            AND t.org_id = ${orgId}::uuid
            AND mc.escalated_ticket_id = t.id
            AND mm.id = ${mailMessageId}::uuid
            AND mm.direction = 'inbound'
            AND mm.sent_at > t.created_at
          LIMIT 1
        `),
      )[0]
      if (!mail) return envelopeError(ERROR_NOT_FOUND.code, "eligible mail reply not visible")
      const sourceRef = `liaison:source-mail-message:${mailMessageId}`
      const key = _idempotencyKey ?? `tickets:pullMailReply:${ticketId}:${mailMessageId}`
      let localIdempotencyReserved = false
      if (!_idempotencyKey) {
        const { reserveIdempotency } = await import("~/modules/apps/idempotency")
        const reservation = await reserveIdempotency(orgId, "tickets:pullMailReply", key, {
          ticketId,
          mailMessageId,
          idempotencyKey: key,
        })
        if (reservation.outcome === "hit") {
          if ("data" in reservation.cached) {
            return JSON.stringify({
              ...(reservation.cached.data as Record<string, unknown>),
              idempotent: true,
            })
          }
          return JSON.stringify(reservation.cached)
        }
        if (reservation.outcome === "conflict") {
          return envelopeError("idempotency_conflict", "different params for same idempotency key")
        }
        if (reservation.outcome === "in_flight") {
          return envelopeError(
            "idempotency_in_flight",
            "concurrent call with same idempotency key in progress",
            true,
          )
        }
        localIdempotencyReserved = true
      }
      try {
        if (mail.external_message_id) {
          const existing = extractRows<{ id: string }>(
            await txDb.execute(drizzleSql`
            SELECT id FROM ${ticketMessages}
            WHERE ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
              AND external_message_id = ${mail.external_message_id}
            LIMIT 1
          `),
          )[0]
          if (existing?.id) {
            if (localIdempotencyReserved) {
              const { finalizeIdempotency } = await import("~/modules/apps/idempotency")
              await finalizeIdempotency(
                orgId,
                "tickets:pullMailReply",
                key,
                { ticketId, mailMessageId, idempotencyKey: key },
                { data: { ticketId, messageId: existing.id, idempotent: false } },
              )
            }
            return JSON.stringify({ ticketId, messageId: existing.id, idempotent: true })
          }
        }
        const existingBySource = extractRows<{ id: string }>(
          await txDb.execute(drizzleSql`
          SELECT id FROM ${ticketMessages}
          WHERE ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
            AND header_references @> ${JSON.stringify([sourceRef])}::jsonb
          LIMIT 1
        `),
        )[0]
        if (existingBySource?.id) {
          if (localIdempotencyReserved) {
            const { finalizeIdempotency } = await import("~/modules/apps/idempotency")
            await finalizeIdempotency(
              orgId,
              "tickets:pullMailReply",
              key,
              { ticketId, mailMessageId, idempotencyKey: key },
              { data: { ticketId, messageId: existingBySource.id, idempotent: false } },
            )
          }
          return JSON.stringify({ ticketId, messageId: existingBySource.id, idempotent: true })
        }
        const mapped = mapMailMessageRow(mail)
        const sentAt = mapped.sentAt ?? new Date().toISOString()
        const body = mapped.textBody ?? mapped.htmlBody ?? ""
        const headerReferences = Array.from(new Set([...(mapped.references ?? []), sourceRef]))
        const inserted = extractRows<{ id: string }>(
          await txDb.execute(drizzleSql`
          INSERT INTO ${ticketMessages} (
            id, org_id, ticket_id, kind, from_email, from_name, to_emails, cc_emails,
            subject, html_body, text_body, snippet, external_message_id, in_reply_to,
            header_references, sent_at, created_by, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${ticketId}::uuid, 'inbound',
            ${mapped.fromEmail ?? null}, ${mapped.fromName ?? null}, ${JSON.stringify(mapped.toEmails ?? [])}::jsonb,
            ${JSON.stringify(mapped.ccEmails ?? [])}::jsonb, ${mapped.subject ?? null}, ${mapped.htmlBody ?? null},
            ${mapped.textBody ?? null}, ${body.slice(0, 200)}, ${mapped.externalMessageId ?? null},
            ${mapped.inReplyTo ?? null}, ${JSON.stringify(headerReferences)}::jsonb,
            ${sentAt}::timestamptz, ${actorIdForEvent()}::uuid, now(), now()
          ) RETURNING id
        `),
        )[0]
        await txDb.execute(drizzleSql`
        UPDATE ${tickets}
        SET message_count = message_count + 1, last_inbound_at = ${sentAt}::timestamptz,
            last_message_at = ${sentAt}::timestamptz, updated_at = now()
        WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
      `)
        await queueAppEvent("tickets", "message", "create", inserted.id, {
          ticketId,
          messageId: inserted.id,
          kind: "inbound",
        })
        if (localIdempotencyReserved) {
          const { finalizeIdempotency } = await import("~/modules/apps/idempotency")
          await finalizeIdempotency(
            orgId,
            "tickets:pullMailReply",
            key,
            { ticketId, mailMessageId, idempotencyKey: key },
            { data: { ticketId, messageId: inserted.id, idempotent: false } },
          )
        }
        return JSON.stringify({ ticketId, messageId: inserted.id, idempotent: false })
      } catch (err) {
        if (localIdempotencyReserved) {
          const { invalidateIdempotency } = await import("~/modules/apps/idempotency")
          await invalidateIdempotency(orgId, "tickets:pullMailReply", key)
        }
        throw err
      }
    },
  }
}
