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

## Runtime sequence

The kernel runs, in strict order:

1. Body-size check (default 1 MiB; override via `bodyLimitBytes` in the manifest, range 1 KiB to 10 MiB).
2. `verify(request)` resolved against the built bundle's named export (sandboxed for installed apps; in-process for in-tree trusted apps).
3. On an unrecognized return value or a thrown error: HTTP 401, no handler invoked.
4. On accept: replay-protection lookup; if first delivery, the topic handler runs under the same bundle. On reject or drop, the verifier's own status (and, for reject, `retry-after`) is returned instead of running the handler.

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
