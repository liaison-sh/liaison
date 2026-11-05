# Tickets — customer-facing ticketing

Local ticketing foundation: an inbox of tickets with an
`open → awaiting_customer → awaiting_followup → closed` lifecycle, categories,
templates, SLA/backlog reporting, CSAT surveys, and mail bridging
(`createFromMail` / `convertToMail` / `pullMailReply`). Full tool surface in the
manifest (`search`, `get`, `create`, `reply`, `assign`, `setStatus`, `merge`,
`csat.*`, `inboxes.*`, `apiKeys.*`, …).

## Connecting

> **Connect the desk's mailbox to `tickets/gmail` (or `tickets/imap`) — NOT
> `mail/gmail` / `mail/imap`.** Both apps declare connections by those names,
> they are different things, and picking the wrong one fails **silently**: the
> connect succeeds, the account reads `active`, and no ticket ever arrives.
> See [§7 of `docs/connecting-apps.md`](../../../../../docs/connecting-apps.md).
>
> **The tell:** connecting `tickets/*` auto-creates a tickets inbox named after
> the address. No new inbox in Settings → Tickets Inboxes ⇒ wrong app.

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) for the
shared OAuth/credentials machinery, ownership, and token refresh. Tickets owns
its own local data, but it also declares **two connections** — the support
mailbox(es) that feed tickets and receive replies: a `gmail` (oauth2) and an
`imap` (credentials) connection, the same two shapes the **mail** app offers.
Connect one so email-in → ticket and ticket reply → email work.

**Give it a DEDICATED account.** The sync lists `q=after:<date>` with **no label
filter** (`sync.ts`), so every message landing in that mailbox becomes a ticket.
Point it at a person's mailbox and their whole correspondence turns into
tickets — and the scopes are read *and* write.

**What connecting actually triggers**, beyond storing a token:
`ticketsOnAccountConnected` (`handlers.ts`, on `kernel/connected_account:create`)
fires only when `appName === "tickets"`, and it (1) creates or re-binds a tickets
inbox of `kind: "mailbox"` named after the address, and (2) enqueues the initial
sync. Thereafter the incremental sync polls and `gmail-watch-renewal` keeps the
Gmail push watch alive — it expires ~7 days after each connect, so without that
cron push dies quietly and nothing arrives.

### `gmail` (oauth2)

| Thing | Where it comes from |
|---|---|
| OAuth client id + secret | The **shared Google integration client**, picked by the one resolver (`modules/apps/connections/oauth-client.ts`): (1) the workspace's Google client saved in **Settings → Mail Setup** (org `settings.integrations.google.oauthClient`); else (2) a client stored for this connection, the DB row `kernel.oauth_providers` named `tickets:gmail` (`PUT /api/connections/tickets/gmail/oauth-client` or `config apply`); else (3) the instance's client, env **`GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`** (both or neither; not `GOOGLE_OAUTH_*`). Mail, Calendar and Tickets share the workspace client — configure it once. Each connected account keeps the client that minted its tokens (recorded at connect): saving another client moves an account only when it is reconnected. |
| The mailbox access | Granted at consent time (scopes include `gmail.modify` + `gmail.send`). Auto-refreshed. |

Provision: register `${BASE_URL}/api/connections/callback` in the Google client's
authorized redirect URIs, enable the **Gmail API** on that GCP project, set the
consent-screen audience (see the Google checklist in
[`../google-drive/README.md`](../google-drive/README.md)), then **Connect**.

### `imap` (credentials)

Enter `email`, `imapHost`, `imapPort`, `smtpHost`, `smtpPort`, `username`,
`password` (all required). Most providers need an **app-specific password** when
2FA is on — not the normal login password. Stored encrypted; `allowedDomains` is
empty (any mail host is allowed).

**Same trap as `gmail`, and harder to spot:** Mail declares `mail/imap` too, and
the credentials form is the *same* host/port/user/password in both apps with
nothing on screen to tell them apart. For a desk it is **`tickets/imap`**.

### Sending: which inbox carries the reply

A `kind: "mailbox"` inbox sends through its own connected account. A
`kind: "api"` inbox (a receiving bucket: web form, per-tenant endpoint) has **no
transport of its own** — set its `reply_via_inbox_id` to a mailbox inbox, or its
replies and acknowledgements have nowhere to go even with `ack_enabled = true`.
Easy to miss because nothing errors: the ack is simply never sent.

**Ownership:** a support mailbox is a **shared** resource — connect it
**org-owned** (`mode: "org"`, needs `tickets:accounts:admin`) so every agent and
member works the same inbox. A user-owned mailbox returns `not_connected` for
everyone else (the isolation gotcha in the central doc).

Two adjacent surfaces are **not** kernel connections: the **mail-app bridge**
(`convertToMail` / `pullMailReply`, which reaches the separate *mail* app — see
[`../mail/README.md`](../mail/README.md)) and **inbound API keys**
(`apiKeys.create` / `apiKeys.list` / `apiKeys.revoke`, app-managed keys for an
external system to file tickets over the tickets API).

### Failure modes

| Code | Cause | Fix |
|---|---|---|
| `not_found` / `ticket_not_found` | ticket id doesn't resolve | Re-`search`; use a valid id. |
| `inbox_not_found` | reply/create targeting a missing inbox | Create the inbox (`inboxes.create`) or use an existing one. |
| `status_not_found` | unknown status | Use a status from the ticket's workflow. |
| `invalid_params` | malformed tool input | Fix the offending field. |
