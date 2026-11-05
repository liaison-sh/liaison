# Social

Social "Ground Control" — monitors Facebook, Instagram and YouTube for
brand-relevant activity, drafts human-approved replies, and manages DMs. The
agent triages each finding (comment, mention, DM), drafts a brand-voice reply
grounded in Knowledge, and waits for approval before anything is posted.

This is a Liaison bundled (first-party) plugin app. See
[docs/app-development.md](../../docs/app-development.md) for the full developer
guide.

## Tools (overview)

| Tool | What it does |
|---|---|
| `findings_list` / `findings_get` | Read triaged findings. |
| `set_triage` / `correct_triage` / `dismiss_finding` | Record/adjust a triage verdict (autonomous). |
| `reply_to_finding` | Draft + post a reply to a comment/post — **gated**. |
| `send_dm` | Send a DM; recomputes the platform reply window at send time — **gated**. |
| `like_item` | Like a finding's item (Facebook own-Page / Instagram own-media only) — **gated**. |
| `webhooks_setup` | Point the Meta app's Page webhooks (feed, messages) at this instance and subscribe every managed Page — **gated**, idempotent. |
| `dm_list` / `dm_get` | Read DM conversations (each carries a `reply_window`). |
| `watch_object` / `unwatch_object` / `watched_list` | Manage the set of posts/videos whose future comments are polled. |
| `monitor_terms_add` / `monitor_terms_remove` / `monitor_terms_list` | Brand keyword/handle/hashtag terms (drive YouTube discovery). |

## Connecting

Social declares **three** oauth2 connections — `instagram`, `facebook`, and
`google` (YouTube). Read
[docs/connecting-apps.md](../../docs/connecting-apps.md) first — it covers the
shared machinery (connection types, the single OAuth callback URL, OAuth-client
resolution, ownership, token refresh). This section covers what is specific to
each provider.

All three are **bundled**, so none ships a TS env resolver: each needs its
OAuth client (client id + secret) in the DB row `kernel.oauth_providers` named
`social:instagram`, `social:facebook`, and `social:google` respectively (central
doc §3). The manifest's `clientSecretConfigKey` (`socialInstagramAppSecret`,
`socialMetaAppSecret`) names the config key the app also reads for
webhook/signature verification — it does **not** replace the DB OAuth-client
row, which is still required for the authorize flow.

Connect only the platforms you monitor; each is independent.

### What each connection needs

| Connection | Provider registration | Scopes / token notes |
|---|---|---|
| `instagram` | An **Instagram-with-Facebook-Login / Instagram Business** app in the Meta developer console. Client id/secret → `social:instagram`. | `instagram_business_basic`, `..._manage_comments`, `..._manage_messages`. The short-lived token is exchanged for a **long-lived** token (`ig_exchange_token`) and **self-refreshed in place** via `ig_refresh_token` — there is **no separate `refresh_token`**; the kernel refreshes using the access token itself (`refreshWindowMs` ≈ 10 days). Identity comes from the token's `user_id`. |
| `facebook` | A **Meta / Facebook** app (Pages product). Client id/secret → `social:facebook`. | `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `pages_messaging`, `pages_manage_metadata`, `business_management`. `pages_manage_metadata` lets `webhooks_setup` subscribe each Page to the app (`/{page-id}/subscribed_apps`). The user token is exchanged for a long-lived token (`fb_exchange_token`); identity from `graph.facebook.com/me`. |
| `google` (YouTube) | A **Google Cloud** OAuth client (Web application). Client id/secret → `social:google`. | `youtube.force-ssl`, `youtube.readonly`. `access_type=offline` + `prompt=consent` are requested so Google returns a `refresh_token` for automatic refresh. |

### Provisioning steps (per platform)

1. **Register the OAuth client** with the provider (Meta app for
   instagram/facebook, Google Cloud OAuth client for google). Add
   `${BASE_URL}/api/connections/callback` as an authorised redirect URI — the
   exact scheme+host matching this instance's `BASE_URL`. For Meta this is the
   "Valid OAuth Redirect URIs"; for Google the "Authorized redirect URIs".
2. **Provision the OAuth client** into the DB row (admin scope
   `kernel:apps:admin`), once per connection you use:
   ```
   PUT ${BASE_URL}/api/connections/social/instagram/oauth-client   { "clientId": "…", "clientSecret": "…" }
   PUT ${BASE_URL}/api/connections/social/facebook/oauth-client    { "clientId": "…", "clientSecret": "…" }
   PUT ${BASE_URL}/api/connections/social/google/oauth-client      { "clientId": "…", "clientSecret": "…" }
   ```
   or use **Settings → Social → OAuth client** per connection.
3. **Connect.** In **Settings → Social**, click Connect on each platform,
   approve the consent screen, and the token is stored on the callback.
4. **Facebook webhooks.** Run `webhooks_setup` once after connecting Facebook
   (and again after adding a Page). It sets the Meta app's `page` subscription
   to `${BASE_URL}/webhooks/<orgId>/social/meta` (fields `feed`, `messages`)
   with a verify token it stores itself, then subscribes each managed Page.
   Without it, Page comments and DMs arrive only through polling.

### Ownership

Connect the brand accounts **org-owned** (`mode: "org"`, requires
`social:accounts:admin`). The community-manager agent and the discovery /
watch-poller / dm-sync jobs run as the org, not as one person; a user-owned
connection returns `not_connected` for those runs and for other members (central
doc §4). These are shared brand assets, not personal accounts — org-owned is the
correct choice.

### Failure modes

| Error / symptom | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at the provider | `${BASE_URL}/api/connections/callback` not registered on the Meta/Google app, or `BASE_URL` wrong | Register the exact callback URL; verify `BASE_URL`. |
| "No OAuth client configured" on Connect | no `social:<connection>` row in `kernel.oauth_providers` | `PUT …/social/<connection>/oauth-client` (step 2). |
| Tool returns `not_connected` for some users/jobs | connection is user-owned; the caller/agent/job is a different actor | Reconnect **org-owned** (`mode: "org"`). |
| "requires re-authorization" / repeated 401s (facebook/google) | refresh token or long-lived token revoked/expired at the provider | Disconnect and reconnect that platform. |
| Instagram silently stops after ~weeks | long-lived IG token lapsed (self-refresh missed its window) | Reconnect Instagram — there is no `refresh_token` to re-drive. |
| `send_dm` fails with `dm_window_closed` | last inbound message is > 7 days old; the platform messaging window is closed | Not a connection issue — the message must go via the native app/another channel. |
| `like_unsupported_for_target` on `like_item` | liking a YouTube finding (or a target the platform API can't like) | Not a connection issue — offer a gated `reply_to_finding` instead. |
| Post-connect init lost (findings not syncing after connect) | post-connect event missed | `POST ${BASE_URL}/api/connections/social/<connection>/reconcile`. |
