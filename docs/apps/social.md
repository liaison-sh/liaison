---
title: Answer comments and messages on social media
description: "Connect Facebook, Instagram and YouTube, review the comments and messages agents find, and approve replies before anything is posted."
---

The Social app watches your Facebook Pages, Instagram business account and YouTube channel for brand-relevant comments, mentions and direct messages. An agent triages each finding and drafts a reply grounded in your [Knowledge](knowledge.md). Nothing is posted, sent or liked until a person approves it.

## Connect your accounts

Social covers three platforms: Facebook, Instagram and YouTube. Connect only the platforms you use. Instagram connects one of two ways: **Instagram account**, through Meta's Instagram API with Unified login (what current Meta apps offer, see [Connect Instagram with Unified login](#connect-instagram-with-unified-login)), or **Instagram account (Instagram login, older Meta apps)** for a Meta app that still offers API setup with Instagram login. Settings lists the first as Instagram and the second as an optional alternative.

1. Register an OAuth client with the platform. The Connect card shows the exact steps, and `liaison guide social/facebook`, `liaison guide social/instagram_unified` or `liaison guide social/instagram` prints them on the server (all of them are in the [setup reference](../reference/setup.md#social)):
   - Facebook: register as a Meta developer first at developers.facebook.com (otherwise **My Apps** shows "Sorry, the link you followed may be broken"), then create a Meta app with the use cases **Manage everything on your Page** (its Page permissions, under **Customize**) and **Engage with customers on Messenger from Meta** (`pages_messaging` is only under its **Customize**); its App ID and App secret are the client ID and secret.
   - Instagram (Unified login): the same Meta app as Facebook, its App ID and App secret, with a configuration (see below).
   - Instagram (Instagram login, older Meta apps): a Meta app with the Instagram product (API setup with Instagram login); its Instagram app ID and secret are the client ID and secret.
   - YouTube: a Google Cloud OAuth client of type Web application (`liaison guide google`).
2. Add `https://<your-liaison-host>/api/connections/callback` as a redirect URI ("Valid OAuth Redirect URIs" at Meta, "Authorized redirect URIs" at Google). It must match your instance's `BASE_URL` exactly.
3. In Liaison, open **Settings › Social › Connections** and click **Connect** on the platform.
4. If the app has no OAuth client yet, fill in **Client ID** and **Client secret** from step 1 and click **Connect via OAuth**. When a client is already configured, the dialog shows one **Connect** button instead.
5. Approve the consent screen.

Connecting needs `social:admin:connection`. Connect the brand accounts for the whole organization: the agent and the background jobs run as the organization, and a personal connection returns `not_connected` to them. See [Connect apps](../connecting-apps.md).

| Connection | Permissions requested |
| --- | --- |
| Facebook Page | `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `pages_messaging`, `pages_manage_metadata`, `business_management` |
| Instagram account | `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages` (set in the Meta configuration, not requested by Liaison) |
| Instagram account (Instagram login, older Meta apps) | `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages` |
| Google account (YouTube) | `youtube.force-ssl`, `youtube.readonly` |

Settings names each account after the provider: Facebook by its Pages (or your name when you manage none), Instagram by its username, Google by its YouTube channel. An account connected earlier without a name gets it the next time its settings page lists it.

### Turn on real-time Facebook and Instagram updates

After connecting Facebook or Instagram (Unified login), and again after adding a Page, ask an agent to run `webhooks_setup` (from a terminal: `liaison agent ask --as <your email> "Run the Social app's webhooks_setup"`, then approve it in Liaison). With Facebook connected, it points the Meta app's Page webhooks (comments and messages) at your instance and subscribes each Page. With Instagram connected through the Unified login, it subscribes each Instagram account to the app (comments and messages). The call waits for approval. Without it, comments and messages arrive only when the app polls.

Meta lets you set the app's Instagram webhook only in the App Dashboard, not through its API. `webhooks_setup` reports whether it points at your instance; when it does not, its result gives the callback URL and the verify token (once it does, the token is left out). Enter them once in the Meta app under **Use cases > Manage messaging & content on Instagram > Customize > API setup with Unified login > Configure webhooks**, click **Verify and save**, and subscribe the **comments** and **messages** fields. Without a Facebook account connected, `webhooks_setup` leaves the Page webhooks alone.

On a managed server, every workspace connects Facebook through the server's own Meta app, which has a single callback. `webhooks_setup` then points it at the server's callback (`/webhooks/_cell/meta`), which hands each delivery only to the workspaces holding that Page, and records the Pages it subscribed: run it again after adding a Page. An Instagram delivery goes to the workspace whose Instagram (Unified login) connection holds that account and is active. The server's operator sets that Meta app's Instagram webhook in the App Dashboard, so `webhooks_setup` gives no verify token there: it reports the webhook and subscribes each Instagram account. Before a delivery is read, Social checks those Pages against the ones the Facebook account still manages on Meta (at most once a minute, and again on every discovery sync): a Page the account no longer manages, for example one handed to another workspace, leaves the list and its comments and messages are not stored. Disconnecting Facebook, or a token Meta refuses, empties the list. If the Meta app's callback already belongs to another server, the call is refused and nothing changes.

Liaison adds each account's token to the app's requests itself, so the token never reaches the app's code. For the app-level subscription it gets the Meta app's own token from your Facebook OAuth client (client ID and secret) and writes the verify token into the request; the Meta webhook signature is checked by Liaison with the app secret.

Instagram-login tokens renew themselves. If an Instagram account connected that way stops updating after some weeks, reconnect it.

The Facebook token lasts about 60 days, and its access to Page data about 90 days; it cannot renew itself. At connect, Liaison asks Facebook for both dates (`debug_token`): 14 days before the earlier one, admins get a Home item with the date. Reconnect Facebook before then.

### Connect Instagram with Unified login

Current Meta apps offer **API setup with Unified login** for Instagram: the connection **Instagram account**. Liaison reads the account's comments and direct messages and posts the replies you approve, through `graph.facebook.com` with the account's own id.

1. In Meta's **Business settings > Accounts > Instagram accounts**, add the Instagram professional account to the business portfolio that owns your Meta app. If the **Add** dialog stays blank, link the account to a Facebook Page the portfolio owns instead.
2. In the Meta app, **Use cases > Add use case**, tick **Manage messaging & content on Instagram**, then **Customize > API setup with Unified login > Create new configuration**. Pick the permissions `instagram_basic`, `instagram_manage_comments` and `instagram_manage_messages`, choose the token expiry **Never**, and select the Instagram account.
3. Copy the **Configuration ID** and ask the agent to set the Social setting `instagramLoginConfigurationId` to it (or `apps[].config` with `liaison config apply`).
4. Add the redirect URI to **Facebook Login for Business > Settings > Valid OAuth Redirect URIs** (already there if you connected Facebook with this app).
5. The client ID and secret are the Meta **App ID** and **App secret**, the same as for Facebook.
6. While the Meta app is in Development mode, add the Instagram account under **App roles > Roles > Instagram testers** and accept the invitation in Instagram.
7. Click **Connect** on **Instagram account**. If the sign-in covers several Instagram accounts, Liaison connects none and names them: ask the agent to connect the one you mean.
8. Turn on access to direct messages, before or right after connecting: in the Instagram app, open **Settings and activity > Messages and story replies > Message requests > Connected tools** and turn on **Allow access to messages** (older app versions: **Message controls > Connected tools**). It is off by default on new professional accounts. While it is off, Instagram refuses Liaison's direct message reads: **Messages** shows a notice saying how to turn it on, and `connections_status` lists the issue `dm_access_disabled` on the connection. Messages arrive on the next sync after you turn it on.

On a managed server that provides a Meta app for every workspace (`META_APP_ID`, `META_APP_SECRET` and `META_INSTAGRAM_CONFIG_ID`, see [Connecting apps](../connecting-apps.md)), a workspace with no Meta app of its own skips steps 2 to 5: click **Connect** on **Facebook Page** or **Instagram account**. The server's app secret then also checks the Meta webhook signatures and is the one `webhooks_setup` uses; it is never shown to the agent.

`liaison guide social/instagram_unified` prints every step. Meta has no call to revoke this token: after you disconnect it in Liaison, remove the app from the business portfolio in Business settings to revoke it at Meta. Meta accepts a direct message reply from an account connected this way within 24 hours of the person's last message only, and liking is not available for it.

## Review findings and approve replies

1. Open **Social** and click **Findings** (brand-relevant comments, mentions and keyword hits). **Awaiting approval** lists findings whose reply waits for a decision.
2. Click a finding. **Open at source ↗** opens it on the platform.
3. Read or edit the **Drafted reply** (or write one under **Reply**).
4. Click **Approve & post** to send it, or **Reject** to dismiss the finding.
5. Click **Like** to like the item. Liking works on your own Facebook Page and on Instagram media of an account connected with Instagram login, not on YouTube or an Instagram account connected with the Unified login.

The approval card for a reply shows what it answers: the comment (shortened when long), the post it is under, and a link that opens the comment on the platform (or its post, when the platform gives no comment link). The comment and the post are shown as quotes from outside the organization, and the agent reads them as outside text, never as instructions. The link only ever opens Facebook, Instagram or YouTube.

Your own replies never become findings, whether they were sent from Liaison or from the platform: when the platform reports a reply your Page wrote, the comment it answers is marked as handled instead. Before posting, the app checks whether your Page already replied to that comment with the same words, so an approved reply is never posted twice. If the platform takes too long to confirm a reply, the approval is not left stalled: about a minute later the app looks for the reply on the platform. When it is there, the approval is recorded as done; when it is not, the approval goes back to waiting, so you can approve it again. When the platform refuses a reply because the comment is gone or the reply is blocked, nothing is posted, the finding is marked failed and the approval closes, since approving it again would meet the same refusal. When the platform only asks to slow down, the approval goes back to waiting.

Each pending reply is named by the words it would post, and a reply or direct message gets 30 seconds to reach the platform. A reply or like you send from here still goes through approval when your role requires it. If the original comment was edited after the reply was drafted, the finding says so: re-check before posting.

## Read direct messages

**Messages** lists direct messages across Facebook and Instagram. Click a conversation to read it, or **Open in** the native app.

To answer, type in the box under the conversation and click **Approve & send**. The message is sent with `send_dm` and appears in the conversation. It needs `social:dm:write`; if your organization's approval policy holds it, the box says **Waiting for approval** instead. Between 24 hours and 7 days after the person's last message, the button reads **Approve & send (human agent)**: the message goes out with Meta's human agent tag. After the window closes, the box is replaced by **Open in** the native app.

When someone unsends a message on Instagram, the conversation shows **Message unsent** in its place and the text is removed from Liaison. Instagram reports an unsend through the `messages` webhook, so it shows only when the Instagram webhook is set up; the periodic sync does not detect it. Facebook Messenger does not report unsent messages.

To remove a conversation from the inbox, open it and click **Delete**, then **Delete** again to confirm. This needs `social:dm:write` and no approval. The conversation is removed from Liaison only: it is not deleted on Instagram or Facebook. Its messages are removed from Liaison. If the person writes again, the conversation comes back with the new messages only. An agent does the same with `dm_delete_conversation`.

Right after you connect an account, its direct messages are read once, so they show within a minute instead of at the next sync (every 10 minutes).

If an Instagram account's owner has not turned on **Allow access to messages** in the Instagram app, its messages cannot be read: **Messages** says so at the top with the path to the setting (see step 8 of [Connect Instagram with Unified login](#connect-instagram-with-unified-login)), and the notice goes away after the first sync that reads them.

Platforms only allow a reply within 7 days of the person's last message. An Instagram account connected with the Unified login sends without Meta's human agent tag, so its window is 24 hours. After the window, `send_dm` fails with `dm_window_closed` and the reply has to go through the platform's own app or another channel. Ask an agent to reply: `send_dm` waits for approval.

## Follow posts and videos

**Watched** lists the posts and videos whose new comments the app keeps polling. Active threads are added automatically. A watch that has slowed down shows **Resume**. Starting a watch also links the comments already found on that post or video to it, in the same save.

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
| `social:dm:write` | Send direct messages and delete conversations from the inbox |
| `social:watched:read` / `social:watched:write` | Read / change watched posts and videos |
| `social:terms:read` / `social:terms:write` | Read / change monitor terms |
| `social:admin:connection` | Connect accounts and set up Facebook and Instagram webhooks |
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
| `dm_delete_conversation` | Delete a conversation from Liaison's inbox (not on the platform) | No |
| `watch_object`, `unwatch_object`, `watched_list` | Start, stop and list watched posts and videos | No |
| `monitor_terms_add`, `monitor_terms_remove`, `monitor_terms_list` | Manage monitor terms | No |
| `connections_status` | Status of each connection | No |
| `quota_status` | API usage per platform | No |
| `counts` | Sidebar badge counts | No |
| `webhooks_setup` | Point Facebook Page and Instagram webhooks at this instance | Always |

Related: [Approve what agents do](../agents/approvals.md), [Ads](ads.md), [Knowledge](knowledge.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md).
