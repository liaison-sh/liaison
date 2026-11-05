# Ads

Meta Ads + Google Ads + Merchant Center — manage Facebook/Instagram ad
campaigns, audiences, creatives, and budgets; read Google Ads performance and
pause campaigns; and monitor Merchant Center feed health, through a Liaison
agent. Reads are ungated; all spend-affecting writes, including `pause` and
`google_pause`, are gated behind human approval.

This is a Liaison bundled (first-party) plugin app. See
[docs/app-development.md](../../docs/app-development.md) for the full developer
guide.

## Tools (overview)

- **Meta:** `insights_query`, `campaigns_list`, `adsets_list`, `ads_list`,
  `account_info`, `pages_list`, `targeting_search`, `create_campaign` /
  `create_adset` / `create_ad` / `create_creative`, `update_budget`,
  `set_status`, `pause`, audiences (`create_custom_audience`,
  `create_lookalike_audience`, `add_users_to_audience`).
- **Google Ads:** `google_campaigns_list`, `google_adgroups_list`,
  `google_ads_list`, `google_insights_query`, `google_account_info`,
  `google_search_terms`, `google_recommendations_list`, `google_pause`,
  `google_create_campaign` / `_adgroup` / `_ad`, `google_update_budget`,
  `google_set_status`, `google_add_negative_keywords`,
  `google_create_conversion_action`.
- **Merchant Center:** `merchant_feed_status`, `merchant_product_issues`.

Spend-affecting writes are gated; reads (insights, lists, account info) are not.

## Connecting

Ads uses **four** connections, split by mechanism. Read
[docs/connecting-apps.md](../../docs/connecting-apps.md) first for the shared
machinery (credentials vs oauth2, the OAuth callback URL, OAuth-client
resolution, ownership, token refresh). This section covers the Ads-specific
shape.

| Connection | Type | Purpose |
|---|---|---|
| `meta` | credentials | Meta Ads — System User token + ad account id. |
| `google` | oauth2 | Google Ads + Merchant Center OAuth tokens (`adwords` + `content` scopes). |
| `merchant` | oauth2 | **Optional** — a *separate* Merchant Center Google account. Merchant reads prefer this token and fall back to `google`. |
| `google-config` | credentials | The non-OAuth strings the Google Ads REST API needs on every call: the account ids. |

The Google side deliberately splits the **OAuth tokens** (`google`) from the
**account configuration** (`google-config`). The OAuth2 connection can only hold
tokens; the Google Ads API additionally needs an MCC login customer id, an
operating customer id, and (optionally) a Merchant Center id on every call.
No developer token: Google retired them on 2026-09-09, and API access levels now
belong to the Google Cloud project of the OAuth client (Explorer access, applied
for at console.cloud.google.com/google/ads-apis/overview, reaches production
accounts). A legacy `developerToken` in an existing config is still accepted but
ignored: the client never sends the header (Google will reject it in a future
API version). Those live in the `google-config` credentials connection and are
read by `src/lib/google-config.ts` (`getGoogleConfig` / `getGoogleClient`). Both
`google` **and** `google-config` must be present before any `google_*` or
`merchant_*` tool works.

### `meta` — what it needs

| Field | Where it comes from |
|---|---|
| `accessToken` | A **System User** access token from Meta Business Manager, granted **Admin** on the ad account, with `ads_management` + `ads_read` + `pages_show_list` permissions. Generate it as **non-expiring**. |
| `adAccountId` | The ad account id in `act_<id>` form (the code normalises it to `act_<id>`). |
| `defaultPageId` | *Optional* — a default Facebook Page id used when creating ads that need a Page. |

`meta` is `type: credentials`: there is no OAuth redirect, no `oauth_providers`
row. The operator pastes the values in **Settings → Ads → Meta → Connect**.

### `google` / `merchant` — what they need

Both are `type: oauth2` and **bundled**, so their OAuth clients live in the DB
rows `ads:google` and `ads:merchant` in `kernel.oauth_providers` (central doc
§3). `google` requests scopes `adwords` + `content`; `merchant` requests
`content` only. Both request `access_type=offline` + `prompt=consent` so Google
returns a refresh token.

Connect `merchant` **only** when your Merchant Center lives on a different Google
account than Google Ads; otherwise the single `google` token covers both and you
consent once.

### `google-config` — what it needs

Entered as credentials in **Settings → Ads → Google Ads Config** (no OAuth):

| Field | Where it comes from |
|---|---|
| `loginCustomerId` | The MCC login customer id — **digits only, no dashes** (the code strips dashes). |
| `customerId` | The operating customer id the agent reads/pauses — digits only. |
| `merchantId` | *Optional* — the Merchant Center account id (not a Google Ads customer id; not dash-stripped). Empty ⇒ Merchant reads report not-configured. |
| `developerToken` | *Legacy, optional* — no longer needed; accepted in old configs and ignored (never sent). |

`liaison config apply` derives the connection's identifier from `customerId`
(manifest `identifierVar`), so the config needs no `identifier`. The step-by-step
guide (Explorer access, telling a manager account from an ad account) is the
connection's `setupGuide`: `liaison guide ads/google-config`.

### Provisioning steps

1. **Meta:** create the System User + non-expiring token (as above), then paste
   `accessToken`, `adAccountId`, and optionally `defaultPageId` in Settings.
2. **Google OAuth client:** register a Google Cloud OAuth client (Web
   application). Add `${BASE_URL}/api/connections/callback` to its **Authorized
   redirect URIs** — exact scheme+host matching `BASE_URL`. Provision it (admin
   scope `kernel:apps:admin`):
   ```
   PUT ${BASE_URL}/api/connections/ads/google/oauth-client
   { "clientId": "…", "clientSecret": "…" }
   ```
   (and `ads/merchant/oauth-client` only if you use a separate Merchant account).
3. **Connect Google:** Settings → Ads → Google → Connect; sign in with the
   account that has Google Ads + Merchant Center access; grant Ads + Content
   permissions.
4. **Google Ads API settings:** enter `loginCustomerId`, `customerId`, and
   optionally `merchantId` in Settings → Ads → Google Ads API settings (the
   Cloud project needs Explorer access first, see `liaison guide ads/google-config`).

### Ownership

Connect all four **org-owned** (`mode: "org"`, requires
`ads:accounts:admin`). Ad accounts and the Google config are shared company
assets that the agent and any member must reach; a user-owned connection returns
`not_connected` for other actors (central doc §4).

### Failure modes

| Error code / symptom | Cause | Fix |
|---|---|---|
| `meta_not_connected` | no `meta` credentials, or `accessToken` / `adAccountId` missing | Enter the System User token + `act_<id>` in Settings. |
| `google_not_connected` | `google` OAuth token missing **or** `google-config` empty/incomplete (missing developer token / login customer id / customer id) | Connect the Google account **and** fill Google Ads Config; the message names what is missing. |
| `merchant_not_configured` | `merchantId` empty in `google-config` (or a Merchant tool called with no Merchant Center) | Enter the Merchant Center account id, or accept that Merchant reads are unavailable. |
| `connect_error` | the provider API rejected the call (bad/expired token, revoked System User, wrong account) | Re-check the Meta token / reconnect Google; verify account ids. |
| `redirect_uri_mismatch` at Google (on `google`/`merchant` connect) | `${BASE_URL}/api/connections/callback` not in the OAuth client's Authorized redirect URIs, or `BASE_URL` wrong | Register the exact callback URL; verify `BASE_URL`. |
| "No OAuth client configured" on Google connect | no `ads:google` (or `ads:merchant`) row in `kernel.oauth_providers` | `PUT …/ads/google/oauth-client` (step 2). |
| `quota_exceeded` | provider rate/quota limit hit | Back off and retry; check Google Ads API quota. |
| `gtin_invalid` / `price_mismatch` / `shipping_settings_missing` | Merchant Center product/feed data problem surfaced by `merchant_product_issues` | Fix the feed data in Merchant Center; these are data issues, not connection issues. |
| `invalid_params` | malformed tool input (e.g. dashes in a customer id, bad id form) | Enter customer ids as digits only; correct the input. |
| Tool returns `not_connected` for some users only | a connection is user-owned | Reconnect **org-owned** (`mode: "org"`). |
| "requires re-authorization" / repeated 401s on Google | refresh token revoked/expired at Google | Disconnect and reconnect `google` (or `merchant`). |
