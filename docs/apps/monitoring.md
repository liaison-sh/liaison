---
title: Turn production alerts into incidents
description: "Send signed alerts from Grafana or any system that can POST JSON, see deduplicated incidents, and acknowledge and resolve them yourself or with an agent."
---

The Monitoring app turns production alerts (Grafana, UptimeRobot, error trackers, cron watchdogs, anything that can POST JSON) into incidents: deduplicated, ranked by severity, and acknowledged and resolved by your team. A critical or warning alert lands on the home attention feed the moment it fires.

## Connect an alert source

Liaison never calls out to your alerting system. The connection exists so Liaison generates the secret your system signs its alerts with.

1. Open **Settings › Monitoring › Alert source** and click **Connect**.
2. Fill in **Alert source label (e.g. grafana-prod)** with any name. Connecting creates the signing secret, and reconnecting reuses it.
3. Read the secret with the `webhook_info` tool. It needs `monitoring:admin`, and agents cannot call it.

## Send alerts

Point your alerting system at the Monitoring app's `alert` webhook, `https://<your-liaison-host>/webhooks/<org-id>/monitoring/alert`.

1. Sign the raw request body with HMAC-SHA256 under the secret and send the base64 digest in the `x-monitoring-signature` header.
2. Optionally send a unique `x-monitoring-delivery-id` header per delivery, so an exact retry is ignored.
3. Put a fresh `ts` in every payload. A delivery outside the freshness window is rejected. The window is 10 minutes by default and is set with the `monitoringAlertTtlSeconds` config key.

```json
{
  "source":   "grafana-prod",
  "severity": "critical",
  "title":    "API p99 latency > 5s",
  "body":     "p99 6.2s over last 5m",
  "dedupKey": "api-p99",
  "ts":       "2026-07-05T03:12:00Z",
  "url":      "https://grafana.resonantaudiolabs.example/alert/42"
}
```

`source`, `severity` (`info`, `warning` or `critical`), `title` and `ts` are required. `url` must be an `http://` or `https://` link.

An unsigned or wrongly signed delivery is refused with 401, a malformed one with 400. A temporary failure answers 503 so your system retries.

### Clear an alert from the source

Send the same signed envelope with `"status": "resolved"` (or `"event": "resolve"`), plus `source`, `dedupKey` and `ts`. The open or acknowledged incident is resolved automatically.

```json
{ "source": "grafana-prod", "dedupKey": "api-p99", "status": "resolved", "ts": "2026-07-05T03:40:00Z" }
```

## How alerts group

- Alerts with the same `source` and `dedupKey` fold into one incident. Its count goes up and the feed is not flooded with repeats.
- When the severity rises on a live incident, it is escalated and appears on the feed again.
- An alert for a resolved incident reopens it. The previous episode (title, body, resolution note, resolved time) is kept in the incident's **Activity**.
- A repeat or reopen refreshes the incident's title, and its body when the alert sends one.
- An alert with no `dedupKey` always opens a new incident.

Critical and warning incidents reach everyone holding `monitoring:incidents:read` on the home attention feed.

## Incident references

Every incident gets a short name, `INC-<n>`, numbered per organisation in the order incidents were first seen. People and agents can use it in place of the incident's id, feed items show it in front of the title, and `/monitoring/incident/INC-<n>` opens the incident. A brand new incident may show no reference for a few minutes while older incidents are numbered first.

## Triage incidents

1. Open **Monitoring** in the activity bar. **Overview** shows live incidents by severity and per-source health. An urgent source's banner counts its open and its acknowledged incidents apart ("1 open, 1 acknowledged").
2. Use **Acknowledged** and **Resolved** in the sidebar to see incidents in those states, or click a source under **Sources** to see its live and recently resolved incidents.
3. Open an incident to see its **Alert detail**, **Timeline** and **Dedup key**. **Open in source system ↗** opens the alert's link.
4. Click **Acknowledge** to show someone is on it.
5. Under **Activity**, click **Add comment** to record context a teammate will need (vendor ticket, next step, who is on it). Comments are kept in every status and never notify the feed.
6. Write a note under **Resolve with a note** (what fixed it, future triage reads it) and click **Resolve**.

## Set up sources and the dashboard link

- **Settings › Monitoring › Sources** sets each source's **Label**, its **Colour** (or **Automatic colour**), whether it is urgent (**Urgent sources use red**), and its order (**Move up**, **Move down**). Click **Save**. These are stored in the `monitoringSources` config key.
- **Settings › Monitoring › Detailed monitoring** holds the **Detailed monitoring link** (`monitoringUrl`), shown as **Detailed monitoring** in the sidebar.

## Scopes

| Scope | What it allows |
| --- | --- |
| `monitoring:incidents:read` | List and read incidents, get feed items |
| `monitoring:incidents:write` | Acknowledge, comment on and resolve incidents |
| `monitoring:admin` | Read the signing secret |
| `monitoring:approve` | Decide Monitoring approvals |

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `incidents_list` | Incidents by status, severity and source | No |
| `incidents_get` | One incident by id or `INC-<n>` with its full record, comments and previous episodes | No |
| `incidents_ack` | Acknowledge an open incident, with an optional note saved as a comment | No |
| `incidents_comment` | Add a comment to an incident, in any status | No |
| `incidents_resolve` | Resolve an incident with a resolution note | No |
| `incidents_summary` | Open counts by severity, recent resolutions, per-source health | No |

`webhook_info` returns the signing secret for setup. It is not offered to agents.

Related: [Calls](calls.md), [Schedule routines](../agents/routines.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md).
