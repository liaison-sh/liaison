// SPDX-License-Identifier: FSL-1.1-ALv2
// Typed WS event helpers for Tickets E2E. Each helper builds the exact
// frontend payload shape, validates the action against manifest emits, and
// inserts a JSON object into worker-prefixed kernel.pending_events; the
// outbox worker picks it up and broadcasts via WS.
import type { WorkerEnv } from "@liaison/test-helpers"

function ks(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

interface BasePayload {
  app: string
  entity: string
  action: string
  entityId: string
  orgId: string
  actorId: string
  actorType: "system" | "user" | "agent" | "mcp"
  timestamp: string
  data: Record<string, unknown>
}

async function queue(env: WorkerEnv, payload: BasePayload): Promise<void> {
  // postgres.js encodes JS objects directly as jsonb. Avoid JSON.stringify here
  // (would double-encode and downstream consumers see a JSON string literal).
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.pending_events (org_id, payload) VALUES ($1, $2::jsonb)`,
    [payload.orgId, payload as unknown as string],
  )
}

/** Emit `tickets/message:create` for a fresh inbound/outbound message on a ticket. */
export async function queueTicketMessageCreated(
  env: WorkerEnv,
  orgId: string,
  ticketId: string,
  message: {
    id: string
    kind: "inbound" | "outbound" | "note"
    textBody?: string | null
    htmlBody?: string | null
    sentAt?: string
  },
): Promise<void> {
  await queue(env, {
    app: "tickets",
    entity: "message",
    action: "create",
    entityId: message.id,
    orgId,
    actorId: "system:tickets",
    actorType: "system",
    timestamp: new Date().toISOString(),
    data: {
      id: message.id,
      ticketId,
      kind: message.kind,
      textBody: message.textBody ?? null,
      htmlBody: message.htmlBody ?? null,
      sentAt: message.sentAt ?? new Date().toISOString(),
      orgId,
    },
  })
}

/** Emit `tickets/ticket:summary_updated` for a ticket whose summary text/status changed. */
export async function queueTicketSummaryUpdated(
  env: WorkerEnv,
  orgId: string,
  ticketId: string,
  fields: { summaryText?: string | null; summaryStatus?: "idle" | "generating" | "error" },
): Promise<void> {
  await queue(env, {
    app: "tickets",
    entity: "ticket",
    action: "summary_updated",
    entityId: ticketId,
    orgId,
    actorId: "system:tickets",
    actorType: "system",
    timestamp: new Date().toISOString(),
    data: {
      id: ticketId,
      ticketId,
      summaryText: fields.summaryText ?? null,
      summaryStatus: fields.summaryStatus ?? "idle",
      orgId,
    },
  })
}

/** Emit `tickets/inbox:update` for an inbox row that mutated (rename, archive, default flip). */
export async function queueTicketInboxUpdated(
  env: WorkerEnv,
  orgId: string,
  inbox: { id: string; name?: string; archivedAt?: string | null },
): Promise<void> {
  await queue(env, {
    app: "tickets",
    entity: "inbox",
    action: "update",
    entityId: inbox.id,
    orgId,
    actorId: "system:tickets",
    actorType: "system",
    timestamp: new Date().toISOString(),
    data: { ...inbox, id: inbox.id, orgId },
  })
}
