---
title: Run ad campaigns with approval
description: "Connect Meta Ads, Google Ads and Merchant Center, follow spend and campaigns, and approve every spend-affecting change an agent proposes."
---

The Ads app lets an agent read and manage your Meta (Facebook and Instagram) and Google Ads campaigns and watch your Merchant Center feed. Reads are open, in chat and in scheduled routines alike. Every write that can affect spend, including pausing, waits for a person's approval.

## Connect Meta Ads

1. In Meta Business Manager, create a System User and give it Admin access to your ad account.
2. Generate a non-expiring token for it with the `ads_management`, `ads_read` and `pages_show_list` permissions.
3. In Liaison, open **Settings › Ads › Connections** and click **Connect** on the Meta ads account.
4. Fill in **System User access token** and **Ad account id (act_<id>)**.
5. Optionally fill in **Default Facebook Page id**, used when an ad needs a Page.

## Connect Google Ads and Merchant Center

Google Ads is optional: connect it only if you want the agent on your Google Ads. Google needs two connections: the Google account (OAuth tokens) and the Google Ads API settings (account ids). Both must be set before any Google or Merchant Center tool works. No developer token is needed: Google retired them on 2026-09-09, and API access now belongs to the Google Cloud project of your OAuth client.

1. Register a Google Cloud OAuth client of type Web application and add `https://<your-liaison-host>/api/connections/callback` to its authorized redirect URIs.
1. In the same Cloud project, [enable the Google Ads API](https://console.cloud.google.com/flows/enableapi?apiid=googleads.googleapis.com), then open the [Google Ads API overview](https://console.cloud.google.com/google/ads-apis/overview), expand **Upgrade access level** and click **Apply for access** to get **Explorer** access (production accounts, 2,880 operations a day). Basic access is not needed. Don't use the API Center's "Apply for Basic Access" link in Google Ads: it opens the App Conversion Tracking form, which grants no Google Ads API access.
2. In **Settings › Ads › Connections**, click **Connect** on the Google Ads account. When an OAuth client is already configured, the dialog shows one **Connect** button: click it. Otherwise fill in **Client ID** and **Client secret**, then click **Connect via OAuth**.
3. Sign in with the Google account that has access to Google Ads and Merchant Center, and grant the Ads and Content permissions.
4. Connect the Google Ads API settings and fill in:
   - **MCC login customer id (digits only, no dashes)**: open [Accounts](https://ads.google.com/aw/accounts). If the left menu has **Accounts** and **Admin** has **Manager account settings**, you are in a manager account and the number at the top left is its id. Without an **Accounts** menu you have a plain ad account: enter its own id here and below.
   - **Operating customer id (digits only, no dashes)**, the account the agent reads and pauses: in **Accounts** > **Performance**, the **Account** column of the row whose **Direct manager** reads **(This manager)**.
   - **Merchant Center account id**, only if you sell through Google Shopping. Without it, Merchant Center reads report that it is not configured.
   - Leave **Legacy developer token** empty.

If a Google Ads read fails with `AUTHORIZATION_ERROR` right after your project's Explorer or Basic access was approved, it is a known issue Google lists on its [developer token page](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) (projects upgraded after September 9, 2026; Google is rolling out a fix). Google's workaround is to create a new Google Cloud project, apply for Explorer access from that project, and use that project's OAuth client.

Connect the **Separate Merchant Center account** only when your Merchant Center lives on a different Google account than Google Ads. Merchant Center reads then use it first.

Settings names a Google account by the Merchant Center accounts it can reach; one that reaches none reads as its connection's name.

Connecting needs `ads:admin:connection`. Connect every account for the whole organization so the agent and other members can reach it. See [Connect apps](../connecting-apps.md).

**Settings › Ads › Account status** shows whether **Meta Ads**, **Google Ads** and **Merchant Center** are connected.

The access token, the OAuth tokens and any legacy developer token never reach the app's code: Liaison adds them to each Meta and Google request itself, and refreshes the Google token. The ad account, Page and customer ids are plain settings the app reads.

## Follow spend and campaigns

Open **Ads** in the activity bar.

- **Dashboard** shows spend, blended MER, **Active Experiments**, **Health** and **Pending Approvals** at a glance, with **Daily Spend** and **By Campaign** breakdowns.
- **Guide** explains, in plain language, how to work with the Ads agent and what it will never do.
- **Campaigns** lists Meta Ads and Google Ads campaigns with their delivery status and budget. Open a Meta campaign to see its **Ad Sets**.
- **Ads** shows creative thumbnails. Click one to preview it.
- **Audiences** lists custom audiences with their size.

Campaigns, ads and audiences are created by the agent or in the platform's own Ads Manager.

## Pause or resume a Meta campaign

1. Open **Campaigns** and pick a Meta campaign.
2. Click **Pause** or **Resume** and confirm.

Both go through approval: the campaign changes state only once someone with `ads:approve` approves it. See [Approve what agents do](../agents/approvals.md).

## What the agent will not do on its own

- Google campaigns, ad groups and ads are always created paused.
- Budgets are given in major units (for example `50.00`) and the agent reads the account currency first.
- Bulk negative keywords can suppress delivery, so check every keyword on the approval card.
- `graph_get` and `google_search_terms` count as reading outside text: a Graph read can return page and post comments, and the search-terms report holds the queries people typed. After either one, a later call in the same turn whose effect leaves the organization waits for a person's approval.

## Roles and scopes

The app has two roles. The **admin** role holds every scope, including `ads:approve` and `ads:admin:connection`. The **member** role can create and manage campaigns, ad sets, ads and audiences, and read insights and Merchant Center, but cannot approve spend or connect accounts.

| Scope | What it allows |
| --- | --- |
| `ads:insights:read` | Meta insights and the raw read-only Graph API |
| `ads:campaigns:read` | Meta campaigns, ad sets, ads, creatives, pages, account info |
| `ads:campaigns:write` | Create campaigns, change budgets and status, pause |
| `ads:adsets:write` | Create ad sets |
| `ads:ads:write` | Create ads and creatives, upload images |
| `ads:audiences:read` / `ads:audiences:write` | Read / create and fill custom and lookalike audiences |
| `ads:google:read` | Google Ads campaigns, ad groups, ads, insights, search terms, recommendations |
| `ads:google:pause` | Pause Google Ads objects |
| `ads:google:write` | Create and change Google Ads objects |
| `ads:merchant:read` | Merchant Center feed health and product issues |
| `ads:admin:connection` | Connect ad accounts |
| `ads:approve` | Decide Ads approvals |
| `ads:internal` | Experiments, manual spend, dealer profiles, metrics |

## What agents can do

Every tool marked "Always" files an approval and changes nothing until a person approves it.

| Tool | What it does | Approval |
| --- | --- | --- |
| `insights_query`, `graph_get` | Meta insights and raw Graph API reads | No |
| `campaigns_list`, `adsets_list`, `ads_list`, `creative_get`, `ad_preview`, `media_list`, `audiences_list` | Read Meta objects | No |
| `account_info`, `pages_list`, `targeting_search`, `pending_approvals_list` | Account details, Pages, targeting options, your pending approvals | No |
| `create_campaign`, `create_adset`, `create_ad`, `create_creative`, `upload_image` | Create Meta objects (ads are created paused) | Always |
| `update_budget` | Change a campaign or ad set budget | Always |
| `set_status` | Resume a Meta object | Always |
| `pause` | Pause Meta objects | Always |
| `create_custom_audience`, `create_lookalike_audience`, `add_users_to_audience` | Build audiences (emails and phones are hashed before upload) | Always |
| `google_campaigns_list`, `google_adgroups_list`, `google_ads_list`, `google_insights_query`, `google_account_info`, `google_search_terms`, `google_recommendations_list` | Read Google Ads | No |
| `google_pause` | Pause a Google Ads object | Always |
| `google_set_status` | Resume a Google Ads object | Always |
| `google_create_campaign`, `google_create_adgroup`, `google_create_ad` | Create Google Ads objects, always paused | Always |
| `google_update_budget` | Change a Google Ads budget | Always |
| `google_add_negative_keywords` | Add negative keywords | Always |
| `google_create_conversion_action` | Create a conversion action | Always |
| `merchant_feed_status`, `merchant_product_issues` | Merchant Center feed health and product issues | No |
| `experiment_open`, `experiment_update`, `experiment_close`, `experiment_list` | Keep the experiment ledger | No |
| `manual_spend_add` | Record spend outside the ad platforms | Always |
| `manual_spend_list` | List manual spend | No |
| `dealer_profile_upsert` | Create or update a dealer profile | Always |
| `dealer_profiles_list` | List dealer profiles | No |
| `metrics_list`, `metrics_run` | Compute deterministic metrics | No |
| `audience_erasure_sweep` | Apply pending erasure requests to audiences | No |

A large Meta insights read (a daily series below account level, or one with no date range) is a report Meta builds in the background. The first `insights_query` answers "not ready yet" and starts the report; asking again with the same question picks up that report instead of starting a new one, and answers its rows once Meta has finished. A report older than an hour is dropped and started again.

The metrics that split DTC from B2B revenue (`blended_mer_dtc`, `blended_mer_total`, `cpa_by_sku_class`) recognise a B2B order by the order itself, with the store's own rule from [Store](store.md): placed for a Shopify B2B company, tagged with a B2B order tag, or, on older orders, carrying a B2B sku suffix. A B2B order counts as B2B as a whole, whatever its skus.

Related: [Social](social.md), [Store](store.md), [Approve what agents do](../agents/approvals.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md).
