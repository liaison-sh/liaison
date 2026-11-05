---
description: Monday cross-platform review: Meta + Google spend, blended MER (both variants via metrics_run), open experiments, anomalies, zombie ACTIVE detection. Skip-and-notes an absent platform.
kind: recurring
cron: 0 9 * * 1
timezone: Europe/Paris
scopes: ["ads:insights:read", "ads:campaigns:read", "ads:google:read", "ads:merchant:read", "ads:internal", "shopify:orders:read"]
enabledByDefault: false
---
Run the weekly account review: (1) call account_info (Meta) AND google_account_info (Google) FIRST to read each account's currency and timezone — never assume EUR/USD. If a platform's connection is absent or errors, skip-and-note that platform and continue with the other half — never fail the whole digest for one platform's outage.

(2) Spend, both platforms: call insights_query with level=account and date_preset=last_7d (Meta); call google_insights_query with a GAQL string selecting campaign.id, metrics.cost_micros, metrics.conversions_value over the last 7 days (Google) — convert cost_micros with microsToMajor (÷1,000,000), never rescale by 100.

(3) Blended MER via the deterministic tool: call metrics_run with formula_id "blended_mer_dtc" and metrics_run with formula_id "blended_mer_total" for the same 7-day period_start/period_end window. QUOTE the returned value string VERBATIM together with its lineage and caveats — do NOT re-derive MER freehand, the registry owns the computation. Blended MER outranks any single platform's ROAS (trust hierarchy), but is itself a rear-view directional efficiency ratio, NOT an incrementality measure — never let it alone justify cutting continuity or brand budget.

(4) Open experiments: call experiment_list to surface open and recently-decided experiments with their metric_tier and days-to-decision. Flag any experiment whose linked campaigns were affected by a platform outage or a paused campaign this week as needing review before its decision date.

(5) Anomalies and zombie detection: cross-reference campaigns_list (Meta) and google_campaigns_list (Google) effective_status against the insights spend pulled in step 2. Flag: any campaign with effective_status ACTIVE but zero or near-zero spend this week (zombie ACTIVE — delivering nothing despite being live); any campaign with a sudden spend spike versus the prior week; any Merchant Center disapproved-product count via merchant_feed_status; any platform connection error surfaced in step 1.

(6) Honesty rules, always on: platform-reported purchase values and ROAS are unaudited, self-graded claims — never presented as ground truth. A week of purchases below the minimum-sample floor is INCONCLUSIVE and must be reported as such, never as a win or a loss. MER is directional and rear-view, never causal. Read experiment_list (step 4) before proposing any new test — never propose a test already in flight or just concluded.

(7) Post ONE concise digest covering: both platforms' spend (or the skip-and-note for an absent one), blended MER (both variants, verbatim values + caveats), open experiments with days-to-decision, and the anomalies/zombie/disapproved/connection flags from step 5. This routine makes NO spend writes — it is read-only plus one ungated experiment consult.
