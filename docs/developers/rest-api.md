---
title: Use the HTTP API
description: "See what a Liaison API key can call (creating tickets from your site or app), how to create one, and how the rest of the HTTP API authenticates."
---

Liaison's HTTP API has two kinds of credential, and they open different doors:

| Credential | Works on | How you get it |
| --- | --- | --- |
| **API key** | The public ticket ingest endpoints under `/webhooks/<orgId>/…` only | **Generate API key** in Tickets settings, `liaison config apply`, or the CLI |
| **Session access token** | Every `/api/…` route | Signing in. It lives 15 minutes and is renewed by the app. It stops working as soon as its session ends (sign-out, password change), even before it expires |

An API key never authenticates an `/api/…` route. To give an outside AI client access to your workspace, use the MCP server instead: see [Use Liaison over MCP](mcp.md). An MCP token does not work on `/api/…` either.

There is no OpenAPI or Swagger document for Liaison's API.

## Create tickets from your website or app

An API key belongs to the Tickets app. It lets your contact form, your app or your backend create tickets, with or without attachments.

### Create a key

1. Open **Settings › Apps › Tickets**, section **Inboxes**. You need `tickets:inboxes:admin`.
2. Click **Create API inbox**, or use an existing API inbox.
3. On the inbox, click **Generate API key**. The key is shown once. Click **Copy API key** and store it.

The inbox also shows its own ingest address, `<your Liaison address>/webhooks/<orgId>/inboxes/<inboxId>/tickets/create`, with **Copy**.

The **API keys** section of the same settings lists every key that still works, with **Label**, **Key** (its first characters), **Allowed origins** and **Last used**, and **Revoke**. Managing keys needs `tickets:settings:admin`.

You can also create keys without the browser:

- In a config file, the `apiKeys` section: each entry has a `label`, an optional `key` (supply one, or leave it out and Liaison generates one and prints it once, as `LIAISON_API_KEY` in the report) and optional `allowedOrigins`. See [`apiKeys` in the config reference](../reference/config.md#apikeys).
- `liaison tickets inbox create --name <name> --kind api --mint-key` creates an API inbox and mints its key. See the [CLI reference](../reference/cli.md#tickets-inbox-create).
- An agent with `tickets:settings:admin` can call `tickets__apiKeys.create` (gated: it waits for approval), `tickets__apiKeys.list` and `tickets__apiKeys.revoke`.

### Send a ticket

Pass the key in the `Authorization` header, as `Bearer <key>` or `ApiKey <key>`:

```
curl -X POST https://liaison.resonantaudiolabs.example/webhooks/<orgId>/inboxes/<inboxId>/tickets/create \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Amp hums on channel 2",
    "fromEmail": "sam@customer.example",
    "fromName": "Sam Lee",
    "textBody": "Since the last update, channel 2 hums at low volume."
  }'
```

The answer is `{"data": {"ticketId": "…", "ticketHandle": "…"}}`. The generic address `/webhooks/<orgId>/tickets/create` takes the inbox from `sourceInboxId` in the body, or uses the org's default.

| Field | Who may send it |
| --- | --- |
| `subject`, `fromEmail`, `fromName`, `textBody` or `htmlBody` (one is required), `honeypot` | Anyone, even without a key |
| `externalRef`, `appendIfExisting`, `priority`, `categoryId`, `categoryPath`, `team`, `sensitivity`, `assignedTo`, `contactId`, `attachmentFileIds`, `sourceInboxId` | A key only |

### Attach files

Upload each file first, as the multipart field `file`, to `/webhooks/<orgId>/tickets/attachments` (or `/webhooks/<orgId>/inboxes/<inboxId>/tickets/attachments`). This needs a key. The answer carries a `fileId`. Pass the ids in `attachmentFileIds` when you create the ticket.

### Use a key in a web page

A key with **Allowed origins** is meant for a form in a public page, where every visitor can read it. Liaison then refuses:

- a request whose `Origin` is not in the list (`origin_disallowed`),
- any of `team`, `sensitivity`, `assignedTo`, `contactId`, `attachmentFileIds`, `appendIfExisting`, `sourceInboxId`, `externalRef` and `priority` (`browser_key_field_not_allowed`),
- a ticket for another inbox than the key's own (`inbox_scope_violation`).

Keep a key without allowed origins on your server only.

### Errors

Errors come back as `{"error": {"code": "…", "message": "…"}}`. A missing, unknown or revoked key answers `401` with `invalid_api_key`. A body that does not validate answers `400` with `validation_failed` and the details. When Tickets is turned off for the org, the endpoints answer `503` (`app_disabled`).

## The `/api` routes

Every other route lives under `/api/` and expects `Authorization: Bearer <access token>`, the token of a signed-in user. These are the routes the web, desktop and phone apps use. They act with that user's scopes and are not a published, versioned contract.

Responses follow one envelope:

```json
{ "data": { "id": "…" } }
{ "data": [ … ], "meta": { "page": 1, "limit": 50, "total": 120 } }
{ "error": { "message": "Contact not found", "code": "…" } }
```

A device sign-in (a command-line tool or another program holding a token capped to the scopes it declared) can run tools through these routes, and its calls count as a program's, never as a person's click. A gated tool waits for a person's approval and answers `{ "data": { "blocked": { … } } }`, and outside-text and host rules apply as they do for an [MCP client](mcp.md).

For automation, prefer the tools made for it:

- [`liaison` CLI](../provisioning-cli.md) for provisioning: org, users, roles, mailboxes, API keys, connectors (`liaison config apply`).
- [The MCP server](mcp.md) for an AI client that works in your workspace.
- [The API connector](../sales/connect-your-crm.md) for Liaison to read your own systems, rather than the reverse.

## Related pages

- [Tickets](../apps/tickets.md)
- [CLI reference](../reference/cli.md)
