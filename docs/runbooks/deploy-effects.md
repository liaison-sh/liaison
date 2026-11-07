# Outside effects during a deploy

A deploy, a restart or a crashed worker can run a background job twice: the
job was handed back by a stopping process, or it stalled and the queue ran it
again on another worker. Liaison makes sure each effect that leaves the box (a
mail, a push, a deposit at a platform) happens once anyway. This page lists
every job, schedule and event consumer, what it does outside, and what keeps
that effect from happening twice.

## How an effect is claimed

Each effect below runs through the effect ledger (`kernel.effect_ledger`):

1. The job **claims** a key that names the effect (for example
   `mail:<digest key>`) before it calls out.
2. It calls out, then stores the answer under the key (**done**).
3. A second run with the same key finds the answer and does not call out
   again (**replayed**).
4. A run that finds the key held by a live worker waits and tries later.
5. A run that finds the key held by a worker that died, or held past its
   deadline (10 minutes by default), sees the effect as **unknown**: it may
   have happened. What happens then is the site's unknown policy below.
   Nothing is ever sent twice to resolve an unknown.

A call that fails for sure releases its claim, so the next attempt runs
again. A call whose outcome is in doubt (a timeout, a server error from the
other side) marks its key unknown instead, so the next attempt asks the other
side first. The `effect-ledger-retention` schedule (04:27 daily) tidies the
ledger: done entries are deleted after 30 days, unknown entries after a year
(while one exists, nothing claims that key afresh), and a claim still pending
after 30 days is turned unknown.

Plugin apps claim their effects the same way through `ctx.effects` (see
[Build an app](../app-development.md)). An app's keys are its own: one app can
never read or settle another app's keys.

## Effects and their guards

| Job or consumer | Outside effect | Key | If unknown |
|---|---|---|---|
| `attention-digest-urgent`, `-cadence`, `-hourly`, `-daily` (schedules) | Digest mail | `mail:<digest key>`, with the same key sent as the provider's idempotency key | Not resent; the next digest carries the items again |
| `push-fanout` (consumer) | APNs, FCM and Web Push to each device | `push:<event>:<device token>` | Counted as delivered, not resent |
| `notify-desktop-fallback` (job) | Web Push to a browser | The existing claim `notify-fallback:<notification>` taken before the send | Not resent |
| `retry-webhook` (job, the automatic retry of an inbound webhook whose handler failed) | Re-runs the app's webhook handler, whose writes commit in one transaction | `webhook:<app>:<endpoint>:<retry id>`, one id per queued retry | Run again: a worker that died inside the handler rolled its transaction back, so nothing was applied. A handler that had committed when its worker died finds the key done and is not run again, except in the instant between its commit and the key being stored, where the handler's own dedup on the provider's webhook id applies |
| Invoicing `einvoicing-transmit` (app job) | Deposit of an e-invoice at the platform | `einv:<transmission key>:submit` | The job asks the platform whether it holds the invoice: adopts it if so, deposits it if not, waits if the platform cannot say. A deposit that timed out or met a server error is marked unknown at once, so the next attempt asks first; only a definite refusal frees the key |
| Invoicing `einvoicing-book-daily`, `einvoicing-booking-invariant` (app jobs) | Booking a sale at the platform | The booking's own idempotency key, checked at the platform before each booking | Looked up at the platform before booking |
| Invoicing `deferred-retry` (app job) | Re-sends the automatic mail of an issued document | `auto-email:<document>`, claimed before the send; a re-run after the send replays it and closes the parked event | Never resent by the job, even after the ledger forgot the key; the parked event stays open with the reason `email_outcome_unknown`. A person checks the mailbox's sent folder and, if the mail is not there, sends the document with `documents_send_to_customer`, which closes the parked event |
| `oauth-revoke-on-disconnect` (consumer), `connection-teardown-sweep` (singleton) | Stops a push watch and revokes an OAuth grant at the provider, from `kernel.connection_teardowns` | A claim holds the row for 2 min, and the row goes once the provider answered. Stopping or revoking twice is harmless, and an already invalid grant counts as revoked | Stopped and revoked again |
| `files-delete-object` (job and consumer), `files-orphan-gc` (schedule) | Deletes objects in the object store | None needed: deleting twice is harmless | Deleted again |
| `demo-reset`, `demo-reap` (schedules, demo boxes only) | Removes a demo workspace's webhook subscriptions at its providers | None needed: removal is best effort and harmless twice | Removed again |
| Agent turns: `agent-turn-dispatch`, `agent-turn-resume`, `agent-reinvoke`, `routine-tick`, `routine-event-reconcile`, `agent-subrun` | The tools an agent calls | The turn journal: a resumed turn replays the tool results it already has instead of calling the tools again | A tool call cut off mid-run is not replayed by the journal |
| Approvals: `approval-approving-reaper`, `approval-deferred-step-reaper` | The approved write | The approval's `pending → approving` claim | The approval stays in `approving` for a person to check; never run twice |
| `control-plane-outbox` (schedule) | Sends the messages an admin chose to share with the Liaison team (registration, heartbeat, forwarded bug reports) | Each message's fixed `messageId`, which the control plane deduplicates; a row is claimed with a 2-minute lease before it is sent | Sent again with the same `messageId` once the lease runs out; the control plane answers it as a duplicate. See [Share with the Liaison team](../self-hosting/liaison-team.md) |
| `approval-poll-output` (job) | Resumes the remaining steps of an approved bundle once the first step's output arrived (those steps write outside) | The step's `awaiting_output → succeeded` compare-and-set on its execution record: only the run that flips it resumes the bundle, and each resumed step takes its own approval claim | A re-run finds the step resolved and stops; never resumed twice |

## Jobs that only read outside

These call out but change nothing there, so running them twice is harmless:
`sync-source` (knowledge sources), `files-link-ingest` (downloads linked
media), `search-embedding-backfill` and `files-media-analysis` (send text or
files to the model provider for embeddings or analysis), `sync-model-pricing`,
`sync-openrouter-prices`, `import-run` (reads the import's source), Boxtal
`reconcile-tracking`, invoicing `einvoicing-received-catchup`,
`einvoicing-status-catchup`, `reconcile-shopify-payments` and
`identity-confirm`, Pennylane `refresh-snapshots`, Shopify `backfill-customers`,
Social `discovery-sync`, `watch-poller` and `dm-sync`, and every app's
`probe-webhook-upstream`.

## Jobs with no outside effect

Everything else writes only to Liaison's own database, search index or live
connections: the search indexers and their sweeps (`search-index-upsert`,
`search-index-sweep`), retention and expiry schedules (sessions, audit log,
attention events, notification deliveries, agent turns, `approval-expiry`,
`approval-expiry-sweep`, `secret-request-expiry`, `check-device-flow-expiry`,
`imports-stale-sweep` and uploads), the timeline, audit, WebSocket and
attention consumers, notification rows (`mail-new-email`), thumbnails
(`files-thumbnail`), memory consolidation, demo world and pool jobs, tour
progress, node and claim sweeps (`node-lease-sweep`,
`local-claim-lapse-sweep`, `subrun-stuck-sweep`), the knowledge schedules
`synced-sources-tick` (it only queues `sync-source`) and
`stale-running-reclaim`, and the app jobs that only update
their own rows (invoicing `overdue-scan`, `backfill-order-numbers`,
`link-shipments`; Shopify `scope-seed`, `reconcile-customers`,
`scan-unfulfilled-orders`, `prune-webhook-deliveries`; Boxtal
`backfill-queue-facts`; Monitoring `assign-refs`; Social `parse-webhook`).

## Check it

- `kernel.effect_ledger` holds one row per claimed effect. Rows in state
  `unknown` are effects a dead worker may or may not have completed; each
  site above says what happens to them.
- Logs: `effect_unknown` is logged for each unknown claim a job meets.
