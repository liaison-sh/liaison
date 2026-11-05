# Monitoring — production-alert ingestion for Liaison

Turns external production alerts (Grafana, UptimeRobot, error trackers, cron
watchdogs — anything that can POST JSON) into **incidents**: deduplicated,
severity-ranked records with an ack/resolve triage lifecycle, surfaced on the
home attention feed the moment a critical or warning alert fires.

The 3 a.m. scenario this exists for: an alert fires overnight, the webhook
opens an incident, the critical attention item is waiting at the top of the
home feed in the morning — pre-triaged, deduplicated (one incident with
`count: 40`, not 40 items), and workable end-to-end from Claude over MCP
(`incidents_list` → `incidents_get` → `incidents_ack` / `incidents_comment` → `incidents_resolve`).

## Surface

| Piece | What |
|---|---|
| Webhook `alert` | HMAC-SHA256-verified endpoint accepting the alert envelope below |
| Entity `incidents` | Own app schema — source, severity, title, status, count, audit stamps, and the immutable per-org `ref_number` shown as `INC-<n>` |
| Table `incident_comments` | Comments on an incident and the archived previous episodes of a reopened one (`kind` `comment` or `episode`); same RLS scope as `incidents` |
| Job `assign-refs` | Every 5 minutes, atomic, 20 s budget: numbers incidents that still have no ref, oldest first, 50 per run |
| Attention | Manifest translations: `incident:created` / `reopened` / `escalated` → feed items (critical = urgency 90/urgent, warning = 60); repeats emit `incident:repeated`, which has **no** translation → no feed flood |
| MCP tools | `incidents_list`, `incidents_get`, `incidents_ack`, `incidents_comment`, `incidents_resolve` (+ admin-only `webhook_info`) |

## Alert envelope

```json
{
  "source":   "grafana-prod",          // required — which system sent it
  "severity": "critical",              // required — info | warning | critical
  "title":    "API p99 latency > 5s",  // required
  "body":     "p99 6.2s over last 5m", // optional
  "dedupKey": "api-p99",               // optional — stable alert identity within source
  "ts":       "2026-07-05T03:12:00Z",  // required — ISO-8601 or epoch ms
  "url":      "https://…/alert/42"     // optional — http(s) deep link to the source
}
```

A `url` that is not `http://` or `https://` is rejected 400. A repeat delivery
carrying a `url` refreshes the incident's link; one without keeps the old link.
A repeat or reopen delivery also refreshes the incident's `title`, and its `body`
when the alert carries a non-empty one. The NUL character (U+0000), which the
database refuses, is removed from `source`, `title`, `body` and `dedupKey`.

### Resolve envelope

The source can clear its own alert: send the same signed envelope with
`"status": "resolved"` (or `"event": "resolve"`). `source`, `dedupKey` and `ts`
are required (400 without `dedupKey`); `severity` and `title` are optional. Any
other `status` or `event` value is rejected 400.

```json
{ "source": "grafana-prod", "dedupKey": "api-p99", "status": "resolved", "ts": "2026-07-05T03:40:00Z" }
```

| Situation | Effect | Response |
|---|---|---|
| Open or acknowledged incident for (source, dedupKey) | resolved, `resolved_by` null, note `cleared by <source> at <ts ISO>`, `incident:resolved` emitted with `auto: true` | 200 `{"resolved":true,"id":"…"}` |
| `ts` older than the incident's latest alert `ts` | nothing (out-of-order delivery) | 200 `{"resolved":false,"stale":true}` |
| No incident, or already resolved | nothing, no incident created | 200 `{"resolved":false}` |

A later alert for the same (source, dedupKey) reopens the incident as usual.
Signature and freshness rules are the same as for alerts.

## Source profiles and app config

Two optional, non-secret app config keys shape the board (`incidents_summary`
returns them parsed, with `canConfigure` true for callers holding
`kernel:apps:admin`):

- `monitoringSources`: a JSON list of `{ "source", "label"?, "rank"?, "urgent"?, "hue"? }`
  (`hue` an integer 0 to 359). Profiled sources are listed by `rank`, then
  unprofiled sources alphabetically. Invalid entries are ignored and reported in
  the summary's `warnings`.
- `monitoringUrl`: an http(s) link to a detailed monitoring dashboard; anything
  else is treated as unset.

## Idempotency & flood control

- **Kernel replay protection** — the verifier's replay key is the
  `x-monitoring-delivery-id` header (send one per delivery if you can) or a
  digest of the raw body; an exact redelivery never reaches the handler.
- **`(source, dedupKey)` identity** — deliveries sharing both fold into ONE
  incident: `count` increments, `lastSeenAt` bumps, and the event emitted is
  `incident:repeated` — which no attention translation matches, so a flapping
  alert cannot flood the feed. Severity going *up* on a live incident emits
  `incident:escalated` (that IS feed-worthy); going down just repeats.
- **Resolve → re-fire = reopen** — an alert arriving for a resolved incident
  reopens it (fresh triage stamps, `incident:reopened` → feed item). The reopen
  is a compare-and-set on the resolved status, so two concurrent re-fires reopen
  it once.
- **Fresh text on every fold** — a repeat or reopen refreshes `title` always and
  `body` when the alert sends a non-empty one. A reopen also archives the previous episode
  (its title, body, resolution note and resolved time) as an `episode` entry in
  `incident_comments`, shown in the incident's Activity. Archiving is best
  effort: if it fails the reopen still stands and the failure is logged.
- No `dedupKey` ⇒ every delivery opens its own incident.

## Incident references

Every incident carries a short name, `INC-<n>`, that people and agents use in
place of the UUID. `incidents_get`, `incidents_ack`, `incidents_resolve` and
`incidents_comment` accept either (case and surrounding spaces ignored), and
`/monitoring/incident/INC-<n>` opens the incident in the UI.

- Numbers are per organisation, immutable, and follow `first_seen_at` order
  (ties broken by id). They come from the kernel sequence `monitoring:incident_ref`.
- A new incident is numbered in the same delivery that creates it, after any
  older un-numbered incident (a backlog from before refs existed). That delivery
  numbers at most 10 incidents: a webhook runs under a 5 s budget in production
  and holds the organisation's numbering lock until it commits. The
  `assign-refs` job numbers whatever is left, 50 per run, every 5 minutes. So
  `ref` can be `null` on a brand new incident while more than 9 older incidents
  wait for a number (right after the upgrade to 0.4.0, until the job has
  drained the backlog), and the UI and feed simply omit it until then. Refs keep
  `first_seen_at` order either way: the oldest un-numbered incidents are always
  numbered first.
- The sequence can have gaps, refs stay unique. A value is burned when a
  concurrent numberer drained the list first, and when a new incident's creation
  failed after numbering (the sender retries and the incident gets the next
  number).
- Feed items carry the ref in front of the title (`Critical alert: [INC-142] API p99 latency (grafana-prod)`).

## Comments

`incidents_comment` adds a comment to an incident in any status (vendor ticket,
next step, what was tried): 1 to 4000 characters, stored with its time and its
author. The author is the acting user's id: an agent comments under the user it
runs for (there is no separate agent marker), and a non-user actor is stored
without an author and shown as "System". `incidents_get` returns `comments`
(comments and archived previous episodes, oldest first, the newest 200) and
`commentsTruncated`. Comments never notify the attention feed: they emit
`incident:commented`, which has no translation; that event only refreshes open
screens, so a failure to emit it is logged and the saved comment is still
returned (an error would invite a retry that duplicates the comment). The same
author rule stamps `acknowledged_by` and `resolved_by`. `incidents_resolve`
validates `resolutionNote` like a comment (trimmed, at most 4000 characters; a
blank note is no note), because a reopen copies it into the archived episode.

`incidents_ack` takes an optional `note`, saved as a comment AFTER the
acknowledgement. This is best effort, not atomic: an invalid note (empty, over
4000 characters) is rejected before anything is written; if saving a valid note
fails, the incident stays acknowledged and the tool returns the error. Calling
again with the same note is safe (it re-stamps the acknowledgement, then saves
the note).

## Connecting

Read [`docs/connecting-apps.md`](../../docs/connecting-apps.md) first for the
shared connection machinery. Monitoring's connection is unusual: it is an
**inbound** connection — nothing is dialled out. The `alert-source` connection
exists only so the kernel **mints an HMAC signing secret** that your alerting
system uses to sign the alerts it POSTs in.

**Connection:** one `credentials` connection named `alert-source` with a single
`label` field (any descriptive name, e.g. `grafana-prod`). Connecting it makes
the kernel mint the `monitoringWebhookSecret` signing secret (reused on
re-connect); read it back with the admin-only `webhook_info` tool.

**How an alerting system drives this app:** point any system that can POST JSON
(Grafana, UptimeRobot, an error tracker, a cron watchdog) at the app's `alert`
webhook endpoint. It must:

1. Serialise the alert envelope (see below).
2. Sign the **raw request body** with **HMAC-SHA256** under the minted secret and
   send the **base64 digest** in the `x-monitoring-signature` header.
3. Optionally send a unique `x-monitoring-delivery-id` per delivery (kernel
   replay protection keys off it).
4. To clear an alert, POST a resolve envelope (`status: "resolved"` or
   `event: "resolve"`, see above) signed the same way.

Unsigned or wrongly-signed deliveries are rejected **401** before the handler
runs; malformed envelopes **400** (no retry); a transient processing failure
returns **503** so the source's retry re-delivers. There is no per-user
ownership concern here — the connection just holds the signing secret.

## Setup

1. Install the app and grant the scopes (`monitoring:incidents:read/write`,
   `monitoring:admin` for the operator).
2. Add the **alert-source** connection (Settings → Apps → monitoring). Any
   label works — connecting is what makes the kernel mint the
   `monitoringWebhookSecret` signing secret (reused on re-connect).
3. Read the secret with the `webhook_info` tool (admin scope).
4. Configure the alert source to POST the envelope to the app's `alert`
   webhook endpoint, signing the **raw request body** with HMAC-SHA256 and
   sending the **base64 digest** in `x-monitoring-signature`. Optionally send
   a unique `x-monitoring-delivery-id` per delivery.

Unsigned or wrongly-signed deliveries are rejected 401 before the handler
runs. Malformed envelopes are rejected 400 (no retry). A transient processing
failure returns 503 so the source's retry schedule re-delivers.

## Development

```bash
cd bundled-apps/monitoring && bun install
bun run typecheck
# tests: bun run scripts/test-run.ts bundled-monitoring   # from liaison/
#        CI suite: `bundled-monitoring` in scripts/test-run.ts (part of test:full)
bash scripts/build-bundled-app.sh monitoring --skip-sign   # from liaison/
```

Pure SDK app: imports only `@liaison/app-sdk` + `zod` (enforced by
`scripts/check-bundled-app-purity.ts`). Nothing deployment-specific is
hardcoded — sources, severities and secrets all arrive via the envelope,
the manifest connection, and kernel-minted config.
