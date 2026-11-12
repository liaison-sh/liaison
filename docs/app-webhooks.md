# App Webhooks: verifier contract

Manifest-driven apps that accept external webhooks declare two bundle exports per webhook entry:

```json
{
  "webhooks": {
    "orders-create": {
      "handler": "ordersCreateHandler",
      "verify": "hmacSha256Verifier",
      "bodyLimitBytes": 5242880
    }
  }
}
```

Webhook keys must match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`: lowercase alphanumerics and hyphens only, no slashes.

A handler that makes several provider calls can declare a budget, `timeoutMs` (1000 to 29000), next to `bodyLimitBytes`. Its run is stopped at that budget, on the delivery and on the retry alike. `LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS` caps it, as it caps a tool's. Without one the handler has the sandbox default (5 s in production). A sandboxed app's handler holds no database transaction across its run: each `ctx` call commits on its own, so what it wrote before it failed stays written and the replay runs it again over those writes ([Event handlers and webhooks commit each call on its own](app-sandbox.md#event-handlers-and-webhooks-commit-each-call-on-its-own)). A delivery that does hold one for its whole run (a core app's, or a listed exception's) and declares a budget waits for a free slot on the background connections first, within what the budget leaves of `REQUEST_TIMEOUT_MS`; if none frees up, it is answered `500` and stays in the inbox for a replay, unrun.

## Verifier signature

```ts
// From the app bundle.
export const hmacSha256Verifier = (
  request: { headers: Record<string, string>; body: string; method: string; query: Record<string, string> },
) =>
  | { ok: true; replayKey: string; replayTtlSeconds?: number; scopes?: string[] }
  | { ok: false; status: number; retryAfterSeconds?: number }
  | { drop: true; status: number }
```

(`valid` is accepted as a synonym for `ok` in both the accept and reject shapes; the two are equivalent.)

Return shapes:

- `{ ok: true, replayKey, replayTtlSeconds?, scopes? }`: accept. `replayKey` is required (a non-empty string) and is hashed and put behind a Redis `SETNX` keyed by org, app, and endpoint for replay protection; `scopes` is the scope set the handler runs with.
- `{ ok: false, status, retryAfterSeconds? }`: reject. `status` is clamped into the 400 to 599 range and echoed to the caller; `retryAfterSeconds`, if present, becomes a `retry-after` header.
- `{ drop: true, status }`: silent acknowledge. The delivery is discarded but the response status (typically a 2xx) is sent as-is, telling the provider the delivery succeeded so it stops retrying.
- Anything else, including a bare `true` or `false`, a thrown error, or an object missing `replayKey` on accept, is treated as verification failure.

## Signing secrets

A verifier reads its signing secret with `config_get(<key>)`. When the key is a connection's `clientSecretConfigKey` (a provider that signs webhooks with the app's OAuth client secret, such as Shopify), the kernel answers with the connection's current client secret: the workspace's own client, else the client the instance provides for every workspace (`modules/apps/connections/oauth-client.ts`). With no client at all, it answers with the copy stored in the app's config when the account connected. Every other key is read from the app's config.

A verifier should not read the secret itself: `config_has(<key>)` says whether it is set, and `crypto_verifyHmacForConfig(<key>, body, signature, "base64" | "hex")` checks a signature with it on the host, in constant time (`modules/webhooks/verify-bridge.ts`). On the Workers executor, and for an organization's custom app on any executor, `config_get` of a declared secret key is refused (`secret_not_available_on_workers`).

## Runtime sequence

The kernel runs, in strict order:

1. Body-size check (default 1 MiB; override via `bodyLimitBytes` in the manifest, range 1 KiB to 10 MiB).
2. `verify(request)` resolved against the built bundle's named export (sandboxed for installed apps; in-process for in-tree trusted apps).
3. On an unrecognized return value or a thrown error: HTTP 401, no handler invoked.
4. On accept: replay-protection lookup; if first delivery, it is stored in the webhook inbox, then the topic handler runs under the same bundle. On reject or drop, the verifier's own status (and, for reject, `retry-after`) is returned instead of running the handler.

### The webhook inbox

Every accepted delivery is written to the inbox (`kernel.webhook_inbox`) before its handler runs, with its payload, the provider's event headers and the handler's scopes (`modules/webhooks/inbox.ts`). Only the `x-*` headers, `content-type` and `user-agent` are kept, minus credentials, cookies, signatures, tokens, API keys and the forwarding and client-address headers (`storedWebhookHeaders`); the handler receives the same set, inline and on a replay, so read signatures in the verifier, not the handler. What happens next depends on the handler:

- It succeeds (2xx, or returns nothing): the delivery is marked done and its payload and headers are cleared.
- It returns a 4xx other than 408 or 429: the delivery is refused, not retried; the status and the handler's message go back to the sender.
- It throws, returns another status, or cannot get a slot in time: the sender gets a 5xx, and the inbox replays the delivery with the `webhook-inbox-replay` job, calling the handler the same way (same payload, headers and scopes). Retries wait 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, then 3 h; after 8 attempts the delivery is marked dead.
- The server stops before the handler finishes: the delivery's claim lapses (`REQUEST_TIMEOUT_MS` plus 2 minutes) and the `webhook-inbox-sweep` job, every minute, replays it.

A second delivery with the same replay key is not processed again while the verifier's replay window (`replayTtlSeconds`, default 24 h) lasts, even if the replay lookup missed it. A redelivery of a delivery that is waiting for a retry, was refused or is dead runs it at once. When the app is turned Off before a replay, the replay is dropped.

Done and refused deliveries hold no payload and are deleted as soon as their replay window closes; dead ones, which keep their payload for diagnosis, 7 days after they died (`webhook-inbox-retention`, hourly). Erasing a member clears every stored payload that names them (their id or email) and drops the unsettled deliveries carrying one. A deleted organization's deliveries go with it. The inbox is an ordinary table: a stored payload is in the database's write-ahead log and backups until they roll over, which is why the stored headers and the retention are kept short.

The replays, the sweep and the retention run on their own job queue (`kernel-webhook`, one slot), so a burst of replays never delays the kernel's minute sweeps on `kernel-cron`; a sweep wakes at most 100 due deliveries a minute.

A handler may therefore see a delivery more than once (a replay after a server stopped mid-run): keep dedup on the provider's own event id.

On upgrade from a version that kept failed deliveries as delayed `retry-webhook` jobs, those jobs are moved into the inbox when the server starts; one that was already about to run still runs as before.

Before step 1, a delivery under an org that may not see the app (another organization's custom app) is answered `404`, like an unknown endpoint. A delivery to an organization's custom app past its budget (120 a minute per organization and app) is answered `429` with `Retry-After` and code `custom_app_rate_limited`, before its `verify` runs. A delivery for an org that has reached an app day cap (see [Limit an organization](provisioning-cli.md#limit-an-organization)) runs its `verify`, then waits in the inbox until the next UTC day, unrun, and is answered `200` with `{ "received": true, "held": true }`. A delivery for an org whose app is Off, an org being deleted, or (managed instances) an org suspended or closed for billing is answered `200` with `{ "ok": true, "dropped": "<code>" }` and no handler runs, so the provider keeps the subscription. A suspended org's deliveries are not replayed after it resumes. While an organization is being moved to another server, its deliveries are answered `503` with `Retry-After` and code `org_moving`, and no handler runs: providers that retry deliver again once the move is over.

## Server-level callbacks (managed edition)

A managed server also answers two callbacks of its own, one per provider for the whole server; a self-hosted server answers neither (404):

- `POST /webhooks/_cell/gmail-push`: the push subscription of the server's Gmail topic (`GMAIL_PUBSUB_TOPIC`). The kernel checks the Google OIDC token against `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT`, reads the mailbox address from the message, and passes the original request to `/webhooks/<org>/<app>/gmail-push` of every org whose Mail or Tickets Gmail connection holds that address; each app's verifier checks it again, with the same values as instance config (`gmailPushAudience`, `gmailPushServiceAccount`). An address no org holds answers `204`.
- `POST /webhooks/_cell/meta` (and its `hub.challenge` GET): the callback of the server's Meta app. The kernel checks `X-Hub-Signature-256` with `META_APP_SECRET`, splits `entry[]` by Page id, and runs each org's Social `meta` handler with only its own entries, from step 4 on (replay protection keyed per org). An org counts for a Page only while the Facebook account that recorded it is still connected with a working token; the Social app also checks the Page against Meta's list of the account's Pages before it ingests anything (see [Social](apps/social.md)).

A suspended or closed org is skipped by both.

## Webhook health

An app that declares webhooks also declares how the kernel can tell its stream stopped, as `webhookHealth` in the manifest:

- `{ "probe": "<scheduled job>" }`: the job reports the newest change the sender knows about (`{ "upstreamActivityAt": "<ISO time>" }`, or `null` when there is none). A change newer than the last accepted delivery, and older than the delivery grace, is reported as a missed delivery.
- `{ "probe": null, "reason": "<why>" }`: no upstream can be asked; the app is judged by refused deliveries only.

The delivery grace is 30 minutes (`WEBHOOK_DELIVERY_GRACE_SEC`). A sender that delivers well after the change it reports sets its own with `deliveryGraceSec`, in seconds (60 to 86400, only next to a probe):

```json
{ "webhookHealth": { "probe": "probe-webhook-upstream", "deliveryGraceSec": 10800 } }
```

## Freeze-time enforcement

`bun run app:freeze <app>` parses the in-tree manifest, builds the bundle, then asserts that every `webhooks[*].handler` AND `webhooks[*].verify` export name actually appears in the built bundle. A missing export aborts freeze with:

```
webhook 'orders-create': verify export 'hmacSha256Verifier' not found in built bundle
```

This catches typos, deleted exports, and rename-without-rebuild mistakes before a broken `.liaisonapp` is published.

## Why both checks?

A missing handler would 500 at first delivery; a missing verifier would silently reject every webhook with 401. Either way, an installed app is broken on day one. The freeze guard makes the failure observable at build time instead of at runtime: it was added after a bundled app shipped with a missing `verify` export, which meant every webhook call to that endpoint failed with a 401 instead of ever reaching the handler.
