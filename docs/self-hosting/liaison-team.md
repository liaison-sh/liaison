---
title: Share with the Liaison team
description: What a Liaison server sends to the Liaison team when an admin turns sharing on, how it is delivered and kept, and how to turn it off.
---

A Liaison server can share a little with the Liaison team: that it exists, which version and edition it runs and how many people use it, and, report by report, the bug reports people choose to send. Sharing is off until an admin of the operator org turns it on, and nothing is sent before that. This page lists every field, explains how messages are delivered and kept, and how to turn sharing off.

## What is sent

Registration and the daily heartbeat carry exactly these fields:

| Field | What it is |
|---|---|
| Server id | A random id this server picks when registration is first turned on. It is not derived from anything about the server. |
| `version` | The Liaison version (`LIAISON_VERSION`). |
| `edition` | `self_hosted` or `managed`. |
| `activeUsers` | Active people across the server's orgs. Demo orgs, orgs being deleted and imported placeholder accounts are not counted. |
| `nonce` | Registration only: random bytes that let the Liaison team recognise a repeated registration. |

Never sent: your domain or any URL, org names, people's names or email addresses, your IP address beyond the connection itself.

A forwarded bug report carries only what [Forward a bug report](#forward-a-bug-report) lists.

## Register this server

When an admin turns registration on, the server picks its random id and sends one registration. The Liaison team answers with a key, which the server stores encrypted with `ENCRYPTION_KEY`. Every later message is signed with that key, so the Liaison team knows it comes from the same server.

If the key can no longer be read (for example after `ENCRYPTION_KEY` changed or a database was restored onto a new server), the server registers again under a new id. A backup restored onto two servers shares one id; turn registration off and on again on one of them to give it its own.

## Settings > System

An admin finds the switches in the **Liaison team** section of **Settings > System** ([Settings](../admin/settings.md)). Any admin of any org can read them; changing them is for the admins of the org that runs the server. On a shared server (demo or managed) other orgs' admins see the switches disabled, and never the server id or the outbox counts. A member who is not an admin gets a 403.

- **Register this server** is the switch described above. The section shows the state (off, registering, registered, leaving, error) and the last error.
- **Allow sending bug reports** can only be turned on while registration is on. Turning it on without registration is refused with `REGISTRATION_REQUIRED`. Turning registration off turns it off as well, and turning registration on while the server is still leaving is refused with `RETIRING`.
- **Send bug reports only to the Liaison team** can only be turned on while bug report forwarding is on. Turning it on without forwarding is refused with `FORWARDING_REQUIRED`. Turning forwarding or registration off turns it off as well. See [Send bug reports only to the Liaison team](#send-bug-reports-only-to-the-liaison-team).
- The server id and the outbox counts (waiting, failed, expired, last delivery) are shown to the operator only.
- If `LIAISON_TEAM_ENDPOINT` is empty, the section says sharing is not available and changing a switch is refused.

Every change is written to the org's audit log as `liaison_team.updated`, with who changed it and the switches as they are after the change. A change that alters nothing is logged too.

## Forward a bug report

When **Allow sending bug reports** is on and the server is registered, the **Report a bug** form shows an unticked box, **Also send to the Liaison team**. The report is always filed in your own bug inbox first, as without the box; forwarding never changes that.

1. Tick **Also send to the Liaison team**. The form shows exactly what would be sent, as JSON. The app logs attached to the report are frozen at this moment, and so are the server's recent error signatures, so what you approve is what is sent.
2. Tick **Include my email so the team can reply** if you want an answer. Without it the report is anonymous.
3. Each attached file has its own box, unticked. Only the files you tick are sent. A file over 7 MB shows "Too large to send to the Liaison team (max 7 MB); it stays on your local report" and cannot be ticked.
4. Click **Send report**.

Every change (a tick, an edit of the description) refreshes the preview. If the report changed since the preview you saw, nothing is filed: the form shows the new preview and you send again. If an admin turned forwarding off meanwhile, nothing is filed either: the box is unticked and you send again to file the report locally. The frozen logs are kept 10 minutes; after that the next preview freezes them again.

A forwarded report carries exactly these fields:

| Field | What it is |
|---|---|
| `version`, `edition` | As for registration. |
| `report.description` | The description as typed, with this server's host (from `BASE_URL`) replaced by `<instance>`. |
| `report.page` | The page path and the names of its query parameters. The domain and the parameter values are removed. |
| `report.userAgent` | The browser's user agent. |
| `report.logs`, `report.logsTruncated` | The recent app logs, with tokens, email addresses and other sensitive values removed and the host replaced. The oldest lines are dropped when the report would pass 256 KB, and `logsTruncated` says so. |
| `report.serverErrors` | The server's error signatures of the last hour, cleaned the same way. Only when the reporter belongs to the org that runs the server. |
| `report.attachments` | For each ticked file: its position, name, type, size and SHA-256. |
| `reporter.email` | Only when **Include my email so the team can reply** is ticked. |

Never sent: the reporter's name, the local ticket, org or user ids, files you did not tick. Each ticked file is sent as its own message after the report, read from storage when it is sent and checked against the SHA-256 you approved. A file deleted (or changed) before it is sent is not sent. Bug reports filed by an agent or an MCP client (the `report_bug` tool) are never forwarded: forwarding needs a person's tick. The one exception is the team-only mode below, where the person still confirms the exact report.

## Send bug reports only to the Liaison team

When **Send bug reports only to the Liaison team** is on, bug reports are not filed in a local bug inbox at all. It applies to the reporters of the org that runs the server (the operator org) only; every other org on the server keeps its own bug inbox and the opt-in box above.

- **Report a bug** shows "This report goes only to the Liaison team. Nothing is kept on this server." instead of the box. The preview is always shown, **Include my email so the team can reply** is ticked (untick it to stay anonymous), and only the files you tick are sent. The form answers with a reference, the message id the Liaison team receives.
- A submit without the previewed payload is refused with `FORWARD_REQUIRED`. If the mode or forwarding was turned off since the preview, nothing is sent or filed (`FORWARDING_UNAVAILABLE`): send again to file the report on this server.
- The ticked files are kept for the outbox only, and no user can open them. They are deleted once every message naming them is delivered, refused, cancelled or expired, and after 8 days at the latest.
- If the Liaison team endpoint is down, the report waits in the outbox and is retried, as any message. A report that ends refused, expired or cancelled (for example because registration was turned off, or it waited 7 days, also when the endpoint was unset after it was queued) is not lost silently: the org admins get one notice, with the report text, so it can be sent again.

The `report_bug` agent tool sends nothing by itself in this mode. It prepares the exact report (with the reporter's email, no app logs) and answers only its reference, digest and a short summary (title and sizes), so the conversation never holds the email or the server's errors; the reporter sees it on a card under the tool call, or in **Report a bug** when the agent was used from another app, and only their click on **Send to the Liaison team** queues it. Nobody else can see or send it. A turn no person started (a routine, a schedule, an agent asked by another agent, an agent-bound MCP connection) is refused and told to use the form, before any approval. The prepared report is read by its reporter alone, so it never waits in an approval for the people who read the bug inbox, whatever the conversation read before. A report an agent filed into an approval before this mode was turned on is not lost: approving it prepares the same card for the reporter, and nothing is sent until their click; one from a routine is closed with the reason instead. Any member's agent can use the tool, whatever their roles or the agent's scope ceiling. One reporter can send at most 5 prepared reports an hour (a send that could not be queued does not count), have at most 10 waiting, and have at most 20 prepared an hour.

## During onboarding and in a config file

Both answers are also asked once during setup, after the basics: by the coding agent's playbook ([Install Liaison](../getting-started/install.md)) and by the in-app setup agent. Each is a yes or no with the default no, and a no is an answer: it is recorded, and the setup checklist's Liaison team item (shown only to the operator org, and only when sharing is available) turns done after either. The in-app agent applies them with an approval card (`config_liaisonTeam`); a config file does it with the `liaisonTeam` section ([Configuration file reference](../reference/config.md)):

```yaml
liaisonTeam:
  register: true
  forwardBugReports: false
```

`forwardBugReports: true` without `register: true` is refused. The agent tool `config_export` prints the current values to the operator org and leaves the section out for other orgs.

## The heartbeat

A registered server sends one heartbeat a day, with the same fields as the registration (without the nonce). The minute of the UTC day is derived from the server id, so servers do not all call at once; the same server always uses the same minute. It also sends one at start-up when `LIAISON_VERSION` differs from the version of the last heartbeat it queued, so a new release shows up the same day. Nothing is sent while registration is off, still pending, or being turned off. If the user count cannot be read, that day's heartbeat is skipped and tried again at the next check (every 10 minutes).

## How messages are delivered

Each message waits in the server's outbox until it is delivered. A job runs every minute, sends what is due and retries what failed:

- Failed sends are retried after 30 seconds, then twice as long each time, up to one hour, with some randomness. A reply that asks to wait longer is honoured.
- Each message keeps its id across retries, so a retry after a lost reply is recognised and never counted twice.
- If the server's clock is off by more than two minutes, it learns the difference from the reply and retries.
- If the Liaison team no longer knows the server, or its signatures keep failing for a whole day, the server registers again under a new id. Messages still waiting are sent under the new id.
- A message the Liaison team refuses (malformed) is not retried.
- A message not delivered after 7 days expires.

Several workers can run the job at once. A worker claims a batch of messages for two minutes and sends only while it can still finish within one minute; it gives the rest back for the next run, so a slow Liaison team never holds the job for long. A reply that comes back after another worker took a message over is ignored.

If the registration is refused, or not delivered within 7 days, Settings shows an error. Turn registration off and on again to try again under a new id.

## What the server keeps

The outbox is in the `kernel.control_plane_outbox` table. The content of a delivered, refused, cancelled or expired message is erased 7 days after it finished; its status and counters stay. The rows are deleted after 90 days.

## Turn sharing off

Turning registration off cancels every message still waiting, tells the Liaison team the server is leaving, and deletes the server's id and key once that message is delivered, refused or expired. Turning it on again later picks a new id with no link to the old one. While the leaving message is being sent, turning registration on again is refused for a minute.

If the Liaison team no longer knows the server when it leaves, the leaving message counts as delivered. If the key can no longer be read while the server is leaving, the server deletes its id and key without sending the message, and never registers again.

To make sharing unavailable on a server, set `LIAISON_TEAM_ENDPOINT` to an empty string. Unset, it is `https://hq.liaison.sh/webhooks/8a934d70-a7ef-4f92-b09d-99c455eb3be7/control`.

## Demo leads (for the Liaison team's own demo server; leave off)

The public demo (`LIAISON_DEMO_MODE`) keeps a lead for each visitor who types an address into "Start the demo". The Liaison team's own demo server can send those leads to the Liaison team's support system. This is a separate switch, `LIAISON_TEAM_FORWARD_DEMO_LEADS`, off by default. Registering a server never sends leads, and a server that is not a demo server never sends any.

Leads are sent only when all of these hold: `LIAISON_TEAM_FORWARD_DEMO_LEADS` is `true`, `LIAISON_DEMO_MODE` is on, the server is registered, and the lead has not opted out. A load-test lead (an address on the reserved `.invalid` domain) is never sent. Each lead is queued under the same lock as the switches, so a lead can never be queued after registration was turned off, and while the server is leaving only its leaving message goes out: anything else still queued is cancelled. A lead carries `leadId`, `email`, `name`, `needs` (the picks made on the door), `verified` (whether the visitor confirmed the address), `notifyManaged`, `noticeVersion` (the version of the demo privacy notice the visitor was shown, which names this copy) and `signedUpAt`. Never sent: the signup network, the opt-out token, the demo workspace id.

Later changes go as updates to the same lead: the address was confirmed, the visitor asked to hear about the managed launch, the visitor opted out, and, just before a visitor's demo workspace is deleted (or the visitor starts over), the ids of the scenarios they opened (`scenarios`). A lead that opted out sends nothing more than its opt-out, and a lead that opts out before its first send attempt is cancelled instead, so neither goes out. A lead that cannot be queued is logged and never fails the signup. Messages follow the delivery rules above.

## Managed edition

A server started with `LIAISON_EDITION=managed` hosts many orgs and answers to its control plane, so sharing works differently there:

- Registration and bug report forwarding are always on. Nobody changes them: Settings > System and the `liaisonTeam` config section refuse a change with 403 (`MANAGED_EDITION`).
- The server never registers itself. Its identity is provisioned in two steps. `liaison team identity mint` picks a new server id (state `pending`) and prints it, so the operator can pin it on the control plane. `liaison team identity install --key-file <path>` stores the key the control plane derived for that id, read from a file only its owner can read (mode 0600), and prints the id and the key fingerprint (the first 16 hex characters of its SHA-256). `mint --force` replaces an existing identity to re-key.
- If the control plane stops accepting the server's key, or the key no longer decrypts, the server logs an error and keeps its identity. It never registers again under a new id: provision a new identity instead.
- The server refuses to start without `LIAISON_OPERATOR_ORG_ID`, `LIAISON_ORG_HOST_TEMPLATE` (with a `{slug}` placeholder), an explicit `LIAISON_TEAM_ENDPOINT` (the built-in default only with `LIAISON_TEAM_ENDPOINT_ALLOW_DEFAULT=1`), `LIAISON_PAY_FRAME_ORIGIN` (the https origin of the Billing page's payment frame, with no path), `LIAISON_MANAGED_DEFAULT_MODELS` (the OpenRouter model ids a new org gets switched on, comma-separated, the first one as Auto), a mail transport (`RESEND_API_KEY` or `SMTP_HOST`), `OPENROUTER_API_KEY` and an installed identity. The error names each missing setting.
- Every AI call of a managed server runs on OpenRouter: chat, search embeddings, media analysis and web search. So it also refuses to start while any other provider key is set: `LIAISON_ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `EXA_API_KEY` or any `GEMINI_*` variable. The error names each one to unset. Google sign-in variables such as `GOOGLE_OAUTH_CLIENT_ID` are not provider keys and stay allowed.
- Billing comes from the control plane: it pushes each org's plan, status and caps to the server, grants credits, and sets the credit rate, through signed requests under `/api/cloud`. The server keeps the latest state and answers `GET /api/billing/state` from it, so the control plane being down never blocks it. The former `/api/admin/billing` routes answer 404.
- Organizations cannot add their own model provider keys or model servers: those requests answer 403 (`managed_no_byok`).
- AI use is metered in credits: the provider's cost (in USD, converted to EUR at the day's ECB rate) times the credit rate the control plane set. Each usage row keeps the USD cost and the exchange rate used.
- The server sends two money messages through the outbox, signed like the others and posted to `LIAISON_TEAM_ENDPOINT/cell-billing` (message version 2): `usage.report`, once a day after 00:10 UTC, with each org's billed provider cost in USD for the previous UTC day and its row count; and `billing.auto_topup_request`, when a deduction takes an org with auto top-up on below its threshold (once per crossing).
- Only the org named by `LIAISON_OPERATOR_ORG_ID` may install, upgrade or remove apps; the instance's first org is never assumed. The first account is created from the command line: the sign-up page that creates a fresh server's first account answers 404.
- Only `LIAISON_EDITION=managed` makes a server managed, and the boot checks always apply to it. The older `CONTROL_PLANE_URL` and `CONTROL_PLANE_API_KEY` pair no longer does: a server that sets the pair without `LIAISON_EDITION` runs self-hosted and logs a warning saying to set `LIAISON_EDITION=managed` or `self_hosted`, or to unset both.

### Each org on its own address

With `LIAISON_ORG_HOST_TEMPLATE` set, for example `https://{slug}.example.com`, every org is served on its own address:

- Every link the server builds for an org (sign-in and invitation mails, password resets, connect links, file and export downloads, MCP discovery) uses the org's address.
- Sign-in takes the org from the address: there is no workspace field. A workspace named in the request that is not the address's org is refused with 400, before any password is checked, so it never counts as a wrong password.
- A session, refresh token, WebSocket, MCP token, download link, invitation or password-reset link of one org works on that org's address only. Anywhere else it is refused (401, or "invalid or expired" for an invitation or a reset link, which stays usable on its own address).
- The browser may call the server only from the org's own address (CORS), and every cookie is a `__Host-` cookie.
- An address that names no org (the server's own names, a tunnel host, an IP address) serves only the control API (`/api/cloud/`), `/healthz`, `/readyz`, `/diag` and inbound webhooks. Everything else there, the web app included, answers 404.

### Sign in from the control plane

The control plane creates an org with `POST /api/cloud/orgs` and then asks for a one-time sign-in link for its owner (`POST /api/cloud/orgs/<id>/handoff`). The link opens on the org's address and is valid 10 minutes, once. The page names the workspace and the account, and signs in only when the person clicks **Continue**. On any other address the link is refused.

A new org can be signed in to on its address as soon as it is created. Deleting an org also frees its slug for a new org.

## Endpoints

Messages are JSON posts to `LIAISON_TEAM_ENDPOINT/<type>`, one path segment per message type (`register`, `heartbeat`, `deregister`, `bug-report` and `bug-report-attachment` for forwarded bug reports, and for demo leads `lead` and `lead-update`). Each carries `v`, `type`, `messageId`, the server id, a timestamp and the fields above. Every message except the registration carries an `x-liaison-signature` header: a base64 HMAC-SHA256 of the body, keyed with the server's key.
