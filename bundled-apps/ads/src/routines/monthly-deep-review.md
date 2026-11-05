---
description: Monthly deep review: creative fatigue signals, dealer-adjusted DTC-split geo, and a budget reallocation STAGED as a gated approval (never auto-executed) with an experiment design block.
kind: recurring
cron: 0 9 1 * *
timezone: Europe/Paris
scopes: ["ads:insights:read", "ads:campaigns:read", "ads:google:read", "ads:merchant:read", "ads:internal", "shopify:orders:read", "ads:campaigns:write", "ads:google:write"]
enabledByDefault: false
---
Run the monthly deep review: (1) call account_info (Meta) AND google_account_info (Google) FIRST for account currency and timezone — never assume.

(2) Creative fatigue signals: call insights_query at the ad level with frequency and CTR fields over the last 30 days (Meta) — look for rising frequency paired with declining CTR (fatigue). Call google_recommendations_list (Google) for any fatigue- or creative-related recommendations. Report signals as directional, not definitive — creative fatigue calls are structural judgment, not a statistical test. Frequency and CTR are upper-funnel signals: at this volume they are directional color only and must never by themselves justify a win claim for the reallocation proposed later in this review — the win criterion is the blended MER / revenue_by_channel read in step 3, not frequency or CTR movement.

(3) DTC-split geo, dealer-adjusted: call dealer_profiles_list to identify B2B/dealer accounts BEFORE drawing any geo, AOV, or audience conclusion — dealer sell-in is coarse demand-sensing, not buyer geography, and must never be credited as brand halo at low volume (hybrid DTC/wholesale doctrine). Call metrics_run with formula_id "revenue_by_channel" for the review period to get the DTC channel split, quoting the returned value and its "unattributed" bucket verbatim — never silently drop unattributed revenue.

(4) Read experiment_list BEFORE proposing anything — do not re-run a test already in flight or just concluded, and note any open experiment relevant to the reallocation you are about to propose.

(5) Stage the reallocation as a GATED draft approval, never execute it: call experiment_open first (ungated bookkeeping) with a title, hypothesis, metric_tier, and decision_date for the proposed reallocation. Then call the gated update_budget (Meta) or google_update_budget (Google) — whichever platform the reallocation targets — passing the new proposed budget AND an experiment object (title, hypothesis, metric_tier, minimum_sample, decision_date, or the experiment_id from experiment_open) so the human's approval card shows the full reallocation rationale as the experiment design. Because these tools are gated, this call executes NOTHING by itself — it creates a pending approval. Report to the user: "budget reallocation staged as a pending approval — awaiting your decision." Never claim the reallocation has taken effect.

(6) Honesty rules, always on: platform-reported values are unaudited; MER and channel-split figures are directional/rear-view, never causal; a month of purchases below the minimum-sample floor is inconclusive, not a win or a loss; dealer/B2B revenue must be subtracted before any DTC geo or audience conclusion; never auto-raise budget — every reallocation this routine proposes lands as a gated approval, never an ungated write.
