// SPDX-License-Identifier: FSL-1.1-ALv2
//
// liaison-self — the first, generic `database` connector adapter: reads any
// liaison-schema Postgres. A deployment self-hosting Liaison as its own support
// backend) is just a consumer of this adapter, supplying only a DSN/gate URL.
//
// Every read here is written against the frozen schema in
// `apps/api/src/db/migrations/0000_initial.sql` (+ `db/schema/kernel/*.ts`).
// Column allow-lists never include anything in `SECRET_COLUMNS`
// (`packages/db-core/src/secret-columns.ts`) — `validateCatalog` enforces
// this at registration time as a second, independent check on top of the
// primary wall (the readonly role's grant allow-list, Task 7).
//
// Domains: licenses/subscriptions, moderation (tickets/knowledge/mail),
// health (pending_events backlog, connected_accounts status, audit activity).
// Orders are intentionally absent — not in liaison's own Postgres; the
// shopify app owns that domain via live proxy.

import type { ReadCatalog } from "@liaison/db-core"
import { registerAdapter, validateCatalog } from "@liaison/db-core"

export const liaisonSelfCatalog: ReadCatalog = {
  adapter: "liaison-self",
  reads: {
    // ---------------------------------------------------------------- licenses
    org_tier_and_slug: {
      description: "Look up this organization's tier and slug.",
      domain: "licenses",
      sql: "SELECT id, slug, name, tier, created_at FROM kernel.organizations WHERE id = :orgId",
      params: { orgId: { type: "string", description: "Organization UUID (always the caller's)" } },
      columns: ["id", "slug", "name", "tier", "created_at"],
      tables: ["kernel.organizations"],
      maxRows: 1,
    },
    credit_balance_by_org: {
      description: "Look up an organization's credit balance (included + purchased) by org id.",
      domain: "licenses",
      sql: "SELECT org_id, included_balance, purchased_balance, currency, updated_at FROM kernel.credit_balances WHERE org_id = :orgId",
      params: { orgId: { type: "string", description: "Organization UUID" } },
      columns: ["org_id", "included_balance", "purchased_balance", "currency", "updated_at"],
      tables: ["kernel.credit_balances"],
      maxRows: 1,
    },
    recent_credit_transactions_by_org: {
      description: "List recent credit transactions (usage/purchases) for an organization.",
      domain: "licenses",
      sql: "SELECT id, org_id, type, amount, balance_after, model, description, created_at FROM kernel.credit_transactions WHERE org_id = :orgId ORDER BY created_at DESC",
      params: { orgId: { type: "string", description: "Organization UUID" } },
      columns: [
        "id",
        "org_id",
        "type",
        "amount",
        "balance_after",
        "model",
        "description",
        "created_at",
      ],
      tables: ["kernel.credit_transactions"],
      maxRows: 50,
    },

    // -------------------------------------------------------------- moderation
    // `handle` in these raw reads is the STORED handle (`ticket-<n>`), never
    // rewritten. The tickets app shows a computed display form
    // (`ticket-<CODE>-<n>`, apps/tickets/display-handle.ts) when the org
    // segments its ids; both resolve to the same ticket by number.
    recent_tickets_by_status: {
      description:
        "List the most recent support tickets in an organization, optionally filtered by status.",
      domain: "moderation",
      sql: "SELECT id, org_id, handle, subject, status, priority, channel, created_at, updated_at FROM app_tickets.tickets WHERE org_id = :orgId AND status = :status ORDER BY updated_at DESC",
      params: {
        orgId: { type: "string", description: "Organization UUID" },
        status: {
          type: "string",
          description: "Ticket status: open | awaiting_customer | awaiting_followup | closed",
        },
      },
      columns: [
        "id",
        "org_id",
        "handle",
        "subject",
        "status",
        "priority",
        "channel",
        "created_at",
        "updated_at",
      ],
      tables: ["app_tickets.tickets"],
      maxRows: 50,
    },
    tickets_by_requester_email: {
      description: "Find support tickets raised by a contact, looked up by email address.",
      domain: "moderation",
      sql: "SELECT t.id, t.org_id, t.handle, t.subject, t.status, t.priority, t.created_at, t.updated_at FROM app_tickets.tickets t JOIN kernel.contacts c ON c.id = t.contact_id WHERE t.org_id = :orgId AND c.email = :email ORDER BY t.updated_at DESC",
      params: {
        orgId: { type: "string", description: "Organization UUID" },
        email: { type: "string", description: "Requester's contact email" },
      },
      columns: [
        "id",
        "org_id",
        "handle",
        "subject",
        "status",
        "priority",
        "created_at",
        "updated_at",
      ],
      tables: ["app_tickets.tickets", "kernel.contacts"],
      // Multi-table (joined) read — grantColumns must be explicit per Task 7
      // S1: app_tickets.tickets needs the result-projection columns PLUS the
      // JOIN key (contact_id); kernel.contacts needs its JOIN key (id) and
      // the WHERE-filter column (email), even though neither is in the flat
      // result `columns` list above.
      grantColumns: {
        "app_tickets.tickets": [
          "id",
          "org_id",
          "handle",
          "subject",
          "status",
          "priority",
          "created_at",
          "updated_at",
          "contact_id",
        ],
        "kernel.contacts": ["id", "email"],
      },
      maxRows: 50,
    },
    knowledge_document_lookup: {
      description:
        "Search organization knowledge-base documents by title (case-insensitive substring).",
      domain: "moderation",
      // The readonly login bypasses row-level security, so the read itself keeps
      // to documents everyone in the org may read (`org_wide`): a restricted or
      // personal document never surfaces here.
      sql: "SELECT id, org_id, title, summary, review_status, updated_at FROM app_knowledge.documents WHERE org_id = :orgId AND org_wide AND title ILIKE :titleQuery AND archived_at IS NULL ORDER BY updated_at DESC",
      params: {
        orgId: { type: "string", description: "Organization UUID" },
        titleQuery: { type: "string", description: "SQL ILIKE pattern, e.g. %refund%" },
      },
      columns: ["id", "org_id", "title", "summary", "review_status", "updated_at"],
      tables: ["app_knowledge.documents"],
      // WHERE filters on archived_at (IS NULL) — not in the result
      // projection, so grantColumns must add it explicitly.
      grantColumns: {
        "app_knowledge.documents": [
          "id",
          "org_id",
          "title",
          "summary",
          "review_status",
          "updated_at",
          "archived_at",
          "org_wide",
        ],
      },
      maxRows: 50,
    },
    mail_thread_lookup_by_address: {
      description:
        "Find mail conversations (threads) involving a given sender email address. Envelope only: the subject is mail CONTENT and is never exposed to the readonly role.",
      domain: "moderation",
      // `subject` is deliberately NOT selected. It is mail content, and for an
      // enrolled personal mailbox it is ciphertext the server cannot read
      // anyway. Selecting it here is what put `subject` in the readonly role's
      // column grant, so removing it here is what removes the grant
      // (T-SEC-2). `app_mail.conversations.subject` is also listed in
      // SECRET_COLUMNS, so re-adding it fails catalog validation rather than
      // silently regranting.
      // Shared (org) mailboxes only: a personal mailbox is its owner's, and the
      // readonly login would otherwise show its correspondents to anyone.
      sql: "SELECT id, org_id, from_email, status, last_message_at, message_count FROM app_mail.conversations WHERE org_id = :orgId AND owner_type = 'org' AND from_email = :email ORDER BY last_message_at DESC",
      params: {
        orgId: { type: "string", description: "Organization UUID" },
        email: { type: "string", description: "Sender email address" },
      },
      columns: ["id", "org_id", "from_email", "status", "last_message_at", "message_count"],
      tables: ["app_mail.conversations"],
      grantColumns: {
        "app_mail.conversations": [
          "id",
          "org_id",
          "from_email",
          "status",
          "last_message_at",
          "message_count",
          "owner_type",
        ],
      },
      maxRows: 50,
    },

    // ------------------------------------------------------------------ health
    pending_events_backlog: {
      description:
        "Summarize the pending_events outbox backlog for an organization: count + oldest unclaimed age.",
      domain: "health",
      sql: "SELECT count(*) AS backlog_count, min(created_at) AS oldest_created_at FROM kernel.pending_events WHERE org_id = :orgId AND processed_at IS NULL",
      params: { orgId: { type: "string", description: "Organization UUID" } },
      columns: ["backlog_count", "oldest_created_at"],
      tables: ["kernel.pending_events"],
      // Aggregate read: the result projection (backlog_count,
      // oldest_created_at) are computed aliases, not real column names —
      // grantColumns must instead name the REAL columns the SQL touches
      // (aggregated column + WHERE filters), so the grant renders correctly.
      resultIsAggregate: true,
      grantColumns: {
        "kernel.pending_events": ["created_at", "org_id", "processed_at"],
      },
      maxRows: 1,
    },
    connected_accounts_status_summary: {
      description:
        "List connected-account statuses and token expiry for an organization (no secrets — status/metadata only).",
      domain: "health",
      sql: "SELECT id, org_id, app_name, connection_name, status, status_message, token_expires_at, updated_at FROM kernel.connected_accounts WHERE org_id = :orgId ORDER BY updated_at DESC",
      params: { orgId: { type: "string", description: "Organization UUID" } },
      columns: [
        "id",
        "org_id",
        "app_name",
        "connection_name",
        "status",
        "status_message",
        "token_expires_at",
        "updated_at",
      ],
      tables: ["kernel.connected_accounts"],
      maxRows: 100,
    },
    recent_audit_activity: {
      description:
        "List recent audit_log activity for an organization, optionally filtered by app.",
      domain: "health",
      sql: "SELECT id, org_id, timestamp, actor_type, app, action, entity_type, entity_id FROM kernel.audit_log WHERE org_id = :orgId AND app = :app ORDER BY timestamp DESC",
      params: {
        orgId: { type: "string", description: "Organization UUID" },
        app: { type: "string", description: "App name to filter by, e.g. 'database'" },
      },
      columns: [
        "id",
        "org_id",
        "timestamp",
        "actor_type",
        "app",
        "action",
        "entity_type",
        "entity_id",
      ],
      tables: ["kernel.audit_log"],
      maxRows: 100,
    },
  },
}

// Validate + register at import time so an invalid catalog fails fast (build
// or app-discovery time), never silently at first tool call.
validateCatalog(liaisonSelfCatalog)
registerAdapter(liaisonSelfCatalog)
