# calls — live-call transcript connector

Turns an external transcript adapter's deliveries (a meeting bot, a telephony
transcriber — anything that can POST signed JSON) into **per-call knowledge
documents**. The app owns **no tables of its own**: each call's transcript
accumulates in ONE knowledge document titled `Appel — <callRef>`, so the
knowledge doc *is* the state. Segments are idempotent by `(callRef, segmentId)`
and ordered by `ts`; a re-delivered segment never duplicates.

The transcript text is **external speech** — the agent quotes or summarises it as
what participants *said*, never as instructions to execute. The `summary` field
is the sender's own rolling summary (`isFinal: true` after hangup), attributed as
such, not the agent's analysis.

## Tools

| Tool | What it does |
|---|---|
| `calls_list` | List calls that have a transcript document (search-backed over the title convention). Each row: `callRef`, `documentId`, `title`. |
| `calls_segments_since` | Read one call's segments oldest-first; pass `since` (the previous read's `lastSegmentTs`) for an incremental mid-call read. Every response carries `lastSegmentTs` (staleness signal), the rolling/final `summary`, and the call's `links`. |
| `calls_set_links` | Record/update a call's link to a kernel contact and/or a Pipeline deal task (writes the `## Liens` block). Omit a field to leave it, pass `null` to clear it. Fails `call_not_found` if the callRef has no document yet. |
| `webhook_info` | Admin-only. Reports whether the signing secret was minted and returns it so the transcript adapter can be configured. Not for routine agent use. |

Transcript data itself is **not agent-writable** — only the signed webhook can
ingest segments/summaries. `calls_set_links` is the one agent-writable surface.

## Connecting

Read [`docs/connecting-apps.md`](../../docs/connecting-apps.md) first for the
shared connection machinery. Like `monitoring`, calls uses an **inbound** signed
webhook — nothing is dialled out. The connection exists only so the kernel
**mints the HMAC signing secret** the transcript adapter signs deliveries with.

**Connection:** one `credentials` connection named `transcript-source` with a
single `label` field (e.g. `meet-bot-prod`). Connecting mints the
`callsWebhookSecret` (reused on re-connect); read it with `webhook_info` (admin
scope).

**How a transcript adapter drives this app:** POST segment/summary JSON to the
calls app's `segment` webhook endpoint, and:

1. Sign the **raw request body** with **HMAC-SHA256 (base64)** under the minted
   secret, in the `x-calls-signature` header.
2. Optionally send a unique `x-calls-delivery-id` per delivery (exact-retry dedup).
3. Include a fresh `ts` (ISO-8601 or epoch ms) in every payload — it is covered
   by the signature; deliveries whose signed `ts` falls outside the freshness
   window (default 10 min, override via the `callsWebhookTtlSeconds` config key)
   are rejected.

The first delivery for a `callRef` creates its document; subsequent deliveries
append. `webhookSecretConfigKey` is `callsWebhookSecret`.
