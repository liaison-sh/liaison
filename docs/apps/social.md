---
title: Answer comments and messages on social media
description: "Connect Facebook, Instagram and YouTube, review the comments and messages agents find, and approve replies before anything is posted."
---

The Social app watches your Facebook Pages, Instagram business account and YouTube channel for brand-relevant comments, mentions and direct messages. An agent triages each finding and drafts a reply grounded in your [Knowledge](knowledge.md). Nothing is posted, sent or liked until a person approves it.

## Connect your accounts

Social has three independent connections: **Facebook Page**, **Instagram account** and **Google account (YouTube)**. Connect only the platforms you use. A fourth, **Instagram account (Unified login, preview)**, is for Meta apps that no longer offer API setup with Instagram login; see [Instagram with Unified login (preview)](#instagram-with-unified-login-preview).

1. Register an OAuth client with the platform. The Connect card shows the exact steps, and `liaison guide social/facebook` or `liaison guide social/instagram` prints them on the server (all of them are in the [setup reference](../reference/setup.md#social)):
   - Facebook: register as a Meta developer first at developers.facebook.com (otherwise **My Apps** shows "Sorry, the link you followed may be broken"), then create a Meta app with the use cases **Manage everything on your Page** (its Page permissions, under **Customize**) and **Engage with customers on Messenger from Meta** (`pages_messaging` is only under its **Customize**); its App ID and App secret are the client ID and secret.
   - Instagram: a Meta app with the Instagram product (API setup with Instagram login); its Instagram app ID and secret are the client ID and secret.
   - YouTube: a Google Cloud OAuth client of type Web application (`liaison guide google`).
2. Add `https://<your-liaison-host>/api/connections/callback` as a redirect URI ("Valid OAuth Redirect URIs" at Meta, "Authorized redirect URIs" at Google). It must match your instance's `BASE_URL` exactly.
3. In Liaison, open **Settings › Social › Connections** and click **Connect** on the platform.
4. If the app has no OAuth client yet, fill in **Client ID** and **Client secret** from step 1 and click **Connect via OAuth**. When a client is already configured, the dialog shows one **Connect** button instead.
5. Approve the consent screen.

Connecting needs `social:admin:connection`. Connect the brand accounts for the whole organization: the agent and the background jobs run as the organization, and a personal connection returns `not_connected` to them. See [Connect apps](../connecting-apps.md).

| Connection | Permissions requested |
| --- | --- |
| Facebook Page | `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `pages_messaging`, `pages_manage_metadata`, `business_management` |
| Instagram account | `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages` |
| Google account (YouTube) | `youtube.force-ssl`, `youtube.readonly` |

Settings names each account after the provider: Facebook by its Pages (or your name when you manage none), Instagram by its username, Google by its YouTube channel. An account connected earlier without a name gets it the next time its settings page lists it.

### Turn on real-time Facebook updates

After connecting Facebook, and again after adding a Page, ask an agent to run `webhooks_setup` (from a terminal: `liaison agent ask --as <your email> "Run the Social app's webhooks_setup"`, then approve it in Liaison). It points the Meta app's Page webhooks (comments and messages) at your instance and subscribes each Page. The call waits for approval. Without it, Page comments and messages arrive only when the app polls.

On a managed server, every workspace connects Facebook through the server's own Meta app, which has a single callback. `webhooks_setup` then points it at the server's callback (`/webhooks/_cell/meta`), which hands each delivery only to the workspaces holding that Page, and records the Pages it subscribed: run it again after adding a Page. Before a delivery is read, Social checks those Pages against the ones the Facebook account still manages on Meta (at most once a minute, and again on every discovery sync): a Page the account no longer manages, for example one handed to another workspace, leaves the list and its comments and messages are not stored. Disconnecting Facebook, or a token Meta refuses, empties the list. If the Meta app's callback already belongs to another server, the call is refused and nothing changes.

Instagram tokens renew themselves. If Instagram stops updating after some weeks, reconnect it.

The Facebook token lasts about 60 days, and its access to Page data about 90 days; it cannot renew itself. At connect, Liaison asks Facebook for both dates (`debug_token`): 14 days before the earlier one, admins get a Home item with the date. Reconnect Facebook before then.

### Instagram with Unified login (preview)

Newer Meta apps offer only **API setup with Unified login** for Instagram. Social declares it as the optional connection **Instagram account (Unified login, preview)**. Reads are pending verification: the account connects and is named, but the app does not read or post through it yet, and nothing syncs. Keep using **Instagram account** if your Meta app still offers API setup with Instagram login.

1. In Meta's **Business settings > Accounts > Instagram accounts**, add the Instagram professional account to the business portfolio that owns your Meta app. If the **Add** dialog stays blank, link the account to a Facebook Page the portfolio owns instead.
2. In the Meta app, **Use cases > Add use case**, tick **Manage messaging & content on Instagram**, then **Customize > API setup with Unified login > Create new configuration**. Keep the suggested settings and choose the token expiry **Never**.
3. Copy the **Configuration ID** and ask the agent to set the Social setting `instagramLoginConfigurationId` to it (or `apps[].config` with `liaison config apply`).
4. The client ID and secret are the Meta **App ID** and **App secret**, the same as for Facebook.
5. Connect. If the sign-in covers several Instagram accounts, Liaison connects none and names them: ask the agent to connect the one you mean.

`liaison guide social/instagram_unified` prints every step. Meta has no call to revoke this token: after you disconnect it in Liaison, remove the app from the business portfolio in Business settings to revoke it at Meta.

## Review findings and approve replies

1. Open **Social** and click **Findings** (brand-relevant comments, mentions and keyword hits). **Awaiting approval** lists findings whose reply waits for a decision.
2. Click a finding. **Open at source ↗** opens it on the platform.
3. Read or edit the **Drafted reply** (or write one under **Reply**).
4. Click **Approve & post** to send it, or **Reject** to dismiss the finding.
5. Click **Like** to like the item. Liking works on your own Facebook Page and Instagram media only, not on YouTube.

The approval card for a reply shows what it answers: the comment (shortened when long), the post it is under, and a link that opens the comment on the platform (or its post, when the platform gives no comment link). The comment and the post are shown as quotes from outside the organization, and the agent reads them as outside text, never as instructions. The link only ever opens Facebook, Instagram or YouTube.

Each pending reply is named by the words it would post, and a reply or direct message gets 30 seconds to reach the platform. A reply or like you send from here still goes through approval when your role requires it. If the original comment was edited after the reply was drafted, the finding says so: re-check before posting.

## Read direct messages

**Messages** lists direct messages across Facebook and Instagram. Click a conversation to read it, or **Open in** the native app.

Platforms only allow a reply within 7 days of the person's last message. After that, `send_dm` fails with `dm_window_closed` and the reply has to go through the platform's own app or another channel. Ask an agent to reply: `send_dm` waits for approval.

## Follow posts and videos

**Watched** lists the posts and videos whose new comments the app keeps polling. Active threads are added automatically. A watch that has slowed down shows **Resume**.

## Set monitor terms

Monitor terms are the brand keywords, handles and hashtags the app looks for. They drive YouTube discovery.

1. Open **Settings › Social › Monitor terms** (needs `social:terms:write`).
2. Add a **Term** and pick its **Kind**: **Keyword**, **Handle** or **Hashtag**.
3. Click **Remove** to stop looking for a term.

**Settings › Social › API quota** shows YouTube's daily units used and remaining, and Facebook or Instagram rate limits when one is hit.

## Scopes

| Scope | What it allows |
| --- | --- |
| `social:findings:read` | Read findings, counts, connection and quota status |
| `social:findings:write` | Reply to and like findings |
| `social:dm:read` | Read conversations |
| `social:dm:write` | Send direct messages |
| `social:watched:read` / `social:watched:write` | Read / change watched posts and videos |
| `social:terms:read` / `social:terms:write` | Read / change monitor terms |
| `social:admin:connection` | Connect accounts and set up Facebook webhooks |
| `social:approve` | Decide Social approvals |
| `social:internal` | Triage tools used by the app's own agent |

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `findings_list`, `findings_get` | Read findings | No |
| `set_triage`, `correct_triage`, `dismiss_finding` | Record, correct or dismiss a triage verdict | No |
| `reply_to_finding` | Post a reply to a comment or post | Always |
| `like_item` | Like a finding's item (Facebook Page and Instagram media only) | Always |
| `dm_list`, `dm_get` | Read conversations and their reply window | No |
| `send_dm` | Send a direct message | Always |
| `watch_object`, `unwatch_object`, `watched_list` | Start, stop and list watched posts and videos | No |
| `monitor_terms_add`, `monitor_terms_remove`, `monitor_terms_list` | Manage monitor terms | No |
| `connections_status` | Status of each connection | No |
| `quota_status` | API usage per platform | No |
| `counts` | Sidebar badge counts | No |
| `webhooks_setup` | Point Facebook Page webhooks at this instance | Always |

Related: [Approve what agents do](../agents/approvals.md), [Ads](ads.md), [Knowledge](knowledge.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md).
