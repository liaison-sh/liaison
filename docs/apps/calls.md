---
title: Bring call transcripts into Liaison
description: "Connect a transcript source so call transcripts land as knowledge documents, then let agents read them and link calls to contacts and deals."
---

The Calls connector turns transcripts sent by an outside service (a meeting bot, a telephony transcriber, anything that can POST signed JSON) into one [knowledge](knowledge.md) document per call. Agents then read the transcript and link the call to a contact or a deal.

Calls is a connector: it has no screen of its own. You set it up from **Settings › Connectors** and use it through agents and the call's knowledge document.

## Connect a transcript source

Liaison never calls out to your transcript service. The connection exists so Liaison generates the secret your service signs its deliveries with.

1. Open **Settings › Connectors** and open the Calls card.
2. Click **Connect**.
3. Fill in **Transcript source label (e.g. meet-bot-prod)** with any name for your source. Connecting creates the signing secret, and reconnecting reuses it.
4. Read the secret with the `webhook_info` tool. It needs `calls:admin`, and agents cannot call it.

Setting up the connection needs `calls:admin`.

The app never holds the signing secret: `webhook_info` returns it because Liaison writes it into the answer for an admin, and Liaison checks each delivery's signature itself.
## Send transcripts from your service

Configure your transcript service to POST segment and summary JSON to the Calls app's `segment` webhook, `https://<your-liaison-host>/webhooks/<org-id>/calls/segment`:

1. Sign the raw request body with HMAC-SHA256 (base64) under the secret, in the `x-calls-signature` header.
2. Optionally send a unique `x-calls-delivery-id` header per delivery, so an exact retry is not counted twice.
3. Put a fresh `ts` (ISO-8601 or epoch milliseconds) in every payload. A delivery whose signed `ts` is outside the freshness window is rejected. The window is 10 minutes by default and is set with the `callsWebhookTtlSeconds` config key.

The first delivery for a call reference (`callRef`) creates its document, titled `Appel : <callRef>`. Later deliveries append to it. A segment sent twice is stored once, and segments are ordered by `ts`.

## Read a call and link it

Ask an agent about a call. It lists calls with `calls_list` and reads one with `calls_segments_since`, which also returns the sender's rolling summary (final after hangup) and the call's links.

The agent treats the transcript as what participants said, never as instructions. The summary is the transcript service's own, not the agent's analysis.

To link a call to a contact or a [Projects](projects.md) deal task, ask the agent. It records the link with `calls_set_links` once it has found the real contact or task. The link is written into the call's document.

Transcripts themselves cannot be written by agents: only the signed webhook adds segments and summaries.

## Scopes

| Scope | What it allows |
| --- | --- |
| `calls:transcripts:read` | List calls and read transcripts |
| `calls:transcripts:write` | Link a call to a contact or deal task |
| `calls:admin` | Set up the transcript source and read the signing secret |
| `calls:approve` | Decide Calls approvals |

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `calls_list` | Calls that have a transcript | No |
| `calls_segments_since` | One call's segments oldest first, with `since` for only what is new | No |
| `calls_set_links` | Record or clear a call's contact and deal task link | No |

`webhook_info` returns the signing secret for setup. It is not offered to agents.

Related: [Knowledge](knowledge.md), [Contacts](contacts.md), [Monitoring](monitoring.md), [Agent tools](../reference/agent-tools.md).
