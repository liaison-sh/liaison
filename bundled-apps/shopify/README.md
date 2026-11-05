# Shopify

Shopify integration — orders, customers, products, markets, draft orders,
refunds, fulfillments, and returns. It is the store-and-order data lane: order
and customer lookups, unfulfilled/oversell reconciliation, period totals via
`analytics_query`, draft-order quoting (dealer discount tiers), returns/RMA, and
inventory edits. Reads are ungated; spend- or store-affecting writes (refunds,
draft-order completion, returns, product merges/unpublish) are gated behind
human approval.

This is a Liaison bundled (first-party) plugin app. See
[docs/app-development.md](../../docs/app-development.md) for the full
developer guide — scaffold, develop, test, freeze, and publish.

## Layout

| File | Purpose |
|---|---|
| `app.manifest.json` | App metadata, schema, tools, scopes |
| `manifest-descriptor.ts` | TS descriptor wrapping the manifest + bundle path |
| `handlers.ts` | Tool handler implementations |
| `handlers.test.ts` | Handler unit tests |

The matching frontend panel lives at `apps/web/src/modules/shopify/`.

## Develop

```bash
bun dev                              # auto-discovers this app
bun test apps/api/src/apps/shopify/   # run handler tests
```

## Ship

```bash
bun run app:freeze shopify      # → dist/apps/shopify-0.0.1.liaisonapp
bun run app:sign  dist/apps/shopify-0.0.1.liaisonapp
```

## Connecting

Shopify declares one connection, **`shop`** (`type: oauth2`). Read
[docs/connecting-apps.md](../../docs/connecting-apps.md) first — it covers the
shared connection machinery (connection types, the single OAuth callback URL,
OAuth-client resolution, ownership, token refresh). This section only covers
what is specific to Shopify.

Two things make Shopify's OAuth different from a plain Google-style flow:

- **Per-store endpoints.** The authorize and token URLs are templated on the
  store domain — `https://{shop}/admin/oauth/authorize` and
  `https://{shop}/admin/oauth/access_token`. `{shop}` is substituted from the
  shop domain you pass, so there is no single provider host: each store is its
  own OAuth endpoint.
- **The shop domain must be supplied.** The connect flow needs
  `?shop=<store>.myshopify.com` on the authorize call, and Shopify echoes it on
  the callback. Without it the kernel cannot build the per-store authorize URL.
  The manifest normalises the value (`templateVars.shop`: lowercased, and
  `.myshopify.com` appended if you omit it), so `acme` and `acme.myshopify.com`
  both resolve to `acme.myshopify.com`.

### What the connection needs

| What | Where it comes from |
|---|---|
| Store domain | Your `your-store.myshopify.com` (a free **development store** from the Shopify Dev Dashboard works for testing). Passed as `?shop=` at authorize time. |
| OAuth client id + secret | The Shopify **app's** API key/secret. Because Shopify is a **bundled** app it ships no env resolver, so these live in the DB row `kernel.oauth_providers` named `shopify:shop` (see central doc §3). Provision them before anyone clicks Connect. |
| Granted Admin API scopes | Listed in the Shopify app's released configuration, from the manifest (Shopify-managed installation grants exactly those; Liaison's authorize request names them too) (`read_orders`, `read/write_customers`, `products`, `inventory`, `fulfillments`, `returns`, `read_markets`, `read_reports`, …); the merchant approves them on the store permission screen. `read_all_orders` (orders older than 60 days) is a protected scope: requested only once the org turns on **Full order history** (after Shopify approved the app for it) or when the store already holds it, and granted only once the released configuration lists it (the generated `shopify.app.toml` does once the toggle is on). |

The access token is issued by the store and returned on the callback — no token
is copied by hand.

### Provisioning steps

1. **Create the Shopify app in the Dev Dashboard** (`dev.shopify.com`, no app
   review, no CLI). `liaison guide shopify` (or the agent's
   `kernel__shopify_setup`) prints the exact values for this instance: in a new
   version, the **App URL** `${BASE_URL}`, the **Redirect URLs**
   `${BASE_URL}/api/connections/callback` (the exact scheme+host, matching this
   instance's `BASE_URL`; a mismatch is the most common failure,
   `redirect_uri_mismatch`), the **Scopes** (leave optional scopes empty) and the
   webhooks API version, with **Use legacy install flow** off (Shopify-managed
   installation: a store gets exactly the scopes of the released version, so a
   scope added later is added there and released before a Reconnect). Release the version, choose custom distribution for
   the store, then copy the **Client ID** and **Secret** from Settings. Someone
   who prefers the Shopify CLI can deploy the `shopify.app.toml` that
   `kernel__shopify_app_toml` writes instead. When the instance provides a
   Shopify client (`SHOPIFY_APP_CLIENT_ID` / `SHOPIFY_APP_CLIENT_SECRET`), skip
   this step and step 2.
2. **Provision the OAuth client** into the `shopify:shop` DB row (admin scope
   `kernel:apps:admin`):
   ```
   PUT ${BASE_URL}/api/connections/shopify/shop/oauth-client
   { "clientId": "<API key>", "clientSecret": "<API secret>" }
   ```
   or use **Settings → Shopify → OAuth client**. Read it back with
   `GET …/oauth-client` (secret is never returned).
3. **Connect.** In **Settings → Shopify → Connect**, enter the store domain and
   click **Connect via OAuth**. You are redirected to the store's permission
   screen; approve the requested Admin API scopes; Shopify redirects back to the
   callback and the connection is established. `install_metadata` records the
   granted scopes, api version, and connection status.

### Ownership

Connect the store **org-owned** (`mode: "org"`, requires
`shopify:accounts:admin`). A Shopify store is a shared company resource that the
Shopify agent, routines (unfulfilled-order scan, customer reconcile), and every
member's tool calls must reach. A user-owned connection returns `not_connected`
for every other user and for agents acting as someone else — the isolation
gotcha described in the central doc (§4).

### Failure modes

| Error / symptom | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at Shopify | `${BASE_URL}/api/connections/callback` not in the app's Allowed redirection URLs, or `BASE_URL` wrong | Register the exact callback URL; verify `BASE_URL`. |
| "No OAuth client configured" on Connect | no `shopify:shop` row in `kernel.oauth_providers` | `PUT …/shopify/shop/oauth-client` (step 2). |
| Authorize fails to build / invalid shop | `?shop=` missing or malformed | Pass a valid `<store>.myshopify.com` domain; the manifest lowercases and appends the suffix, but the value must match the store. |
| `shopify_not_connected` | no live `shop` connection (never connected, or disconnected) for the calling user/org | Connect the store (org-owned if agents/routines need it). |
| `not_installed` | the app has no install metadata for the resolved store | Reconnect; verify the store domain resolves to an installed store. |
| Tool returns empty (no error) for an order/customer | the id belongs to a store **outside** the connected store | Not an error — confirm you are querying the connected store. |
| `shopify_error` | Shopify Admin API rejected the call (scope, plan, or bad input) | Read the message; add the missing scope to the Shopify app's configuration, `shopify app deploy`, then reconnect; or fix the input. |
| Tool `not_connected` for some users only | connection is user-owned | Reconnect **org-owned** (`mode: "org"`). |
| App uninitialised after connecting | post-connect event lost | `POST ${BASE_URL}/api/connections/shopify/shop/reconcile`. |

`analytics_query` returning `partial: true` (ShopifyQL unavailable on the plan)
is not a connection failure — it is a plan limitation; treat the result as a
bounded estimate.
