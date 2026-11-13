# Mail — email send and receive (Gmail + IMAP/SMTP)

Mail connects a mailbox so the agent can read, search, triage, and draft replies
to email. Sending is always a **gated** action a human approves. A mailbox can be
connected two ways: **Gmail over OAuth**, or any **IMAP/SMTP** mailbox with
stored credentials.

## Tools (agent-facing highlights)

| Tool | Scope | Gated | What it does |
|------|-------|-------|--------------|
| `search` | `mail:conversations:read` | — | Search synced conversations (filters: `from`, `since`/`until`, `body`, `contactId`, `status`, …). |
| `read` | `mail:conversations:read` | — | Read a conversation / one message (with bodies + attachments). |
| `reply` | `mail:conversations:write` | ✓ | Draft a reply to a conversation (lands as a pending approval). |
| `compose` | `mail:conversations:write` | ✓ | Draft a new message (one envelope, no mass-send). |
| `forward` | `mail:conversations:write` | ✓ | Forward a message with its attachments. |
| `convertToTicket` | `mail:conversations:write` | — | Escalate a conversation into a new Tickets ticket. |
| `archive` / `setLabels` | `mail:conversations:write` | — | Inbox hygiene (internal only, never notifies the customer). |
| `export_conversations` | `mail:conversations:read` | — | Bundle a scoped conversation set into one downloadable file. |
| `listAccounts` / `getAccount` / `getSyncStatus` / `disconnectAccount` | `mail:accounts:*` | — | Manage existing mailboxes. There is **no** agent connect/add-account tool — onboarding a mailbox is an interactive flow in Settings → Mail. |

## Connecting

> **Mail is a mail client, not a ticket desk.** Tickets declares its *own*
> `gmail` **and** `imap` connections, and connecting the wrong app succeeds
> silently — no error, no tickets. If you want inbound mail to become
> **tickets**, connect **`tickets/gmail`** or **`tickets/imap`** instead
> ([tickets README](../tickets/README.md),
> [§7 of `docs/connecting-apps.md`](../../../../../docs/connecting-apps.md)).
> The IMAP pair is the easier mistake: the credentials form is identical in both
> apps.

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) first —
it covers the shared machinery (credentials vs oauth2, callback URL, client
resolution, ownership, token refresh). This section is the Mail-specific runbook.

Mail declares **two** connections. Pick one per mailbox:

### 1. `gmail` — oauth2 (Google)

Scopes: `openid` + `email` + `profile` +
`https://www.googleapis.com/auth/gmail.modify` (read + label/modify) +
`https://www.googleapis.com/auth/gmail.send` (send). Both are Google-sensitive
scopes, so consent-screen audience rules apply exactly as for Calendar.

| Thing | Where it comes from |
|---|---|
| OAuth client id + secret | The **shared Google integration client**, picked by the one resolver (`modules/apps/connections/oauth-client.ts`): (1) the workspace's Google client saved in **Settings → Mail Setup** (org `settings.integrations.google.oauthClient`); else (2) a client stored for this connection, the DB row `kernel.oauth_providers` named `mail:gmail` (`PUT /api/connections/mail/gmail/oauth-client` or `config apply`); else (3) the instance's client, env **`GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`** (both or neither; not `GOOGLE_OAUTH_*`). Mail, Calendar and Tickets share the workspace client — configure it once. Each connected account keeps the client that minted its tokens (recorded at connect): saving another client moves an account only when it is reconnected. |
| The user's mailbox access | Granted at consent time when the operator connects in Settings → Mail. `access_type=offline` + `prompt=consent` guarantee a refresh token. Tokens stored encrypted, refreshed automatically. |

> **Trap:** the env names are `GMAIL_OAUTH_*` — not `GOOGLE_OAUTH_*`, not
> `MAIL_OAUTH_*`. Any other name is silently ignored.

**Provisioning (once per workspace):**

1. Create an **OAuth 2.0 Client ID** (*Web application*) in Google Cloud — or
   reuse the shared Gmail/Calendar/Tickets client.
2. Add `${BASE_URL}/api/connections/callback` to **Authorized redirect URIs**
   (exact scheme + host — a mismatch is `redirect_uri_mismatch`).
3. **Enable the Gmail API** on that GCP project.
4. Set the **consent screen audience** (Internal for same-workspace mailboxes;
   External + Testing with the mailbox added as a test user otherwise;
   External + Production needs Google verification for these sensitive scopes).
5. Save the client (Settings → Mail Setup, or `GMAIL_OAUTH_*` env), then connect
   the mailbox in Settings → Mail.

#### Changes made in Liaison reach Gmail

For a Gmail mailbox, archive, read state, star and trash done in Liaison (or by
the agent's archive tool) are written back to the Gmail thread by the
`gmail-write-back` job: archive removes `INBOX`, moving back to the inbox adds
it, read / unread removes / adds `UNREAD`, star / unstar adds / removes
`STARRED`, trash and untrash move the thread. Opening an unread conversation
reads it in Gmail too. Liaison's own labels (the agent's `setLabels`) are
Liaison-only and are not written to Gmail. Archive done in Gmail archives the
conversation here, and moving it back to the inbox reopens it.

A change Gmail does not accept stays in Liaison. A missing `gmail.modify`
grant (an older connection) or a revoked token shows on the mailbox as
"Not written to Gmail: …" in Settings → Mail; reconnecting fixes it. A rate
limit or a Gmail outage is retried a few times before it is reported the same
way.

#### IMAP mailboxes: what reaches the server, what comes back

The same `gmail-write-back` job serves IMAP mailboxes (`imap_writeBack` bridge
method, `modules/apps/sandbox/imap-mailbox.ts`). A message is found on the
server by its `Message-ID` header. Read sets `\Seen`, star sets `\Flagged`.
Folders are found by SPECIAL-USE (RFC 6154), else by their usual names:

- **Gmail** (`X-GM-EXT-1`): archive removes the `\Inbox` label, moving back to
  the inbox adds it, trash moves the message to `[Gmail]/Trash`.
- **Other servers**: archive moves the message from INBOX to the Archive
  folder, trash moves it to Trash, and back again. A server with no Archive
  (or Trash) folder keeps that change in Liaison only, and the settings row
  says so. Mail in Sent is never moved.

One job run writes up to 15 conversations in ONE IMAP session (the bridge
takes a batch of items) and chains the rest, so a bulk archive neither outlives
the job's 60 s budget nor logs in once per conversation. A command the server
refuses fails only its item; a refused password, a refused command or an
unreachable server shows on the mailbox as "Not written to the mail server: …",
like the Gmail case.

Coming back: each incremental sync reads INBOX membership and flags
(`CONDSTORE` changes since the last modseq when the server has it, else the
newest 300 messages compared with the last snapshot). A message gone from
INBOX is archived here (trash done elsewhere also reads as archived); one back
in INBOX reopens; read and star follow the server, only the flag that moved (a
pending local read is not overwritten by a remote star). A conversation trashed
in Liaison stays trashed through the read-back (`keepTrashed`): its messages
get TRASH only once the server confirmed the move. An INBOX above 20,000 UIDs
is not tracked (`inboxTracked: false`), and the settings row says archive done
elsewhere is not seen. A UIDVALIDITY change drops every stored UID for the
account and re-walks the mailbox, which finds each stored message again by
Message-ID. The Sent folder is imported
after the inbox, origin `imap-sent` (outbound messages, deduplicated by
`Message-ID`, so mail sent from Liaison is not imported twice); the mailbox is
`active` as soon as the INBOX is in, and the Sent pages go on as a background
chain. A new thread holding only outbound mail starts `archived`. 30 s after a
send, Liaison APPENDs a copy to Sent unless the host files it itself (Gmail,
Microsoft, Yahoo, AOL: `hostFilesSentItself`) or a search by Message-ID finds
it there.

New mail is polled every 2 minutes. IMAP IDLE is not used: mail jobs are
short-lived, and IDLE needs one long-lived connection per mailbox held by the
host with leader election across API replicas. That is a separate piece of
work; polling stays the delivery path until then.

### 2. `imap` — credentials (any IMAP/SMTP mailbox)

No OAuth client needed. The operator enters the mailbox details in Settings →
Mail; they are validated against the manifest and stored **encrypted**.

| Field | Required | Notes |
|---|---|---|
| `email` | ✓ | The mailbox address (also the stored account identifier). |
| `imapHost` / `imapPort` | ✓ | e.g. `imap.gmail.com` / `993`. |
| `smtpHost` / `smtpPort` | ✓ | e.g. `smtp.gmail.com` / `465` (implicit TLS) or `587` (STARTTLS). |
| `username` | ✓ | Usually the full email address. |
| `password` | ✓ | If 2FA is on, an **app-specific password** — the normal login password will be rejected. |

`imap` declares an empty `allowedDomains` (the mailbox host is operator-supplied,
not a fixed provider host).

### Ownership (both connection types)

For a **shared team mailbox** (e.g. a support@ inbox agents must reach), connect
it **org-owned** (`mode: "org"`, needs `mail:accounts:admin`). A user-owned
mailbox returns `not_connected` for every other user — see the isolation note in
the central doc. Use user-owned for a personal mailbox.

**Contacts follow ownership, and adding one to the organisation is a choice.**
Mail sync never creates an organisation contact. A personal mailbox's new human
sender becomes a contact **private to the mailbox's owner**; a shared
(org-owned) mailbox's new human sender becomes a contact shared with **exactly
the people who can access that mailbox** (a `mail:inbox=<account id>` dimension
grant, so it follows the mailbox's access as it changes). A sender who already
has an organisation contact is linked to it. No mailbox turns a newsletter or a
no-reply sender (List-Unsubscribe, `Precedence: bulk`, `Auto-Submitted`, Gmail
promotions/updates, `noreply@`…) into a contact. A contact becomes the
organisation's only when its owner shares it (the Share action on the contact,
`PUT /api/contacts/:id/sharing`, or the gated `kernel__contacts_share` tool).
The rule is applied host side (`modules/mail/sender-contacts.ts`); the sharing
model is `modules/sharing`. Contacts that personal mailboxes made org-wide
before this change are made private again with
`liaison contacts privatize-mailbox-senders` (dry run first, restorable backup).

**Allowed mail domains.** An org can restrict which mailboxes its members
connect (Mail and Tickets, Gmail and IMAP) with the org setting
`allowedMailDomains`, e.g. `PATCH /api/org` with
`{"settings":{"allowedMailDomains":["acme.example"]}}` as an org admin.
Connecting any other address is refused with a 403 (the OAuth callback returns
to Settings > Mail with `oauth_error=mail_domain_not_allowed` and the reason).
Domains match exactly (list each subdomain); an empty list (`[]`) or no setting
means no restriction. Mailboxes already connected keep syncing. Enforced in
`modules/apps/connections/mail-domains.ts`.

**A personal mailbox waiting for encryption setup does not sync** and is not
polled: its owner gets one attention item ("set up mailbox encryption in
Settings > Mail"), and finishing the setup starts the import.

### Failure modes

| Symptom / code | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at Google (gmail) | callback URL not registered, or `BASE_URL` wrong | Register `${BASE_URL}/api/connections/callback`; verify `BASE_URL`. |
| "No OAuth client configured" on Connect (gmail) | `GMAIL_OAUTH_*` unset, no Mail-Setup org client, **and** no `mail:gmail` DB row | Configure the Google client in Settings → Mail Setup, set `GMAIL_OAUTH_*`, or `PUT …/oauth-client`. |
| Account `reauth-required` / repeated 401s (gmail) | refresh token revoked/expired at Google (`invalid_grant`) | Disconnect and reconnect the mailbox. |
| IMAP/SMTP connect rejected | wrong host/port, or normal password used with 2FA on | Fix host/port; generate and use an **app password**. |
| 400 rejecting a submitted IMAP field | undeclared field name, or a required field missing | The credentials route rejects undeclared fields and requires every non-optional one — match the field names above exactly. |
| `no_inbound` on a `reply` preflight | the target conversation has no inbound message to reply to (nothing to reply to / no recipient) | Compose a new message instead, or pick a conversation that has an inbound message. |
| `empty_conversation` | reply/read against a conversation with no messages | Nothing to act on — verify the conversation id. |
| `GMAIL_SEND_FAILED` | Gmail rejected the send at the API | Read the surfaced Gmail detail; commonly a re-auth (scope/token) or recipient/quota issue. |
| Tool returns `not_connected` for some users only | connection is user-owned; caller/agent is a different user | Reconnect the mailbox **org-owned** (`mode: "org"`, needs `mail:accounts:admin`). |
| Surface renders "not connected" instead of erroring | no mailbox connected for the caller | Connect one in Settings → Mail — there is no agent connect tool. |
