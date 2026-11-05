// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Aggregation barrel — re-exports every handler, summarizer, and subscribe
// handler the manifest references.
//
// Every tool handler that resolves a platform connection is wrapped ONCE here
// with its connection envelope (lib/get-client.ts, lib/google-config.ts). Not
// connected is an expected state on a fresh install, not a crash: unwrapped,
// the throw reached the tool route as HTTP 500 and the dashboard could only
// read it as an outage. Wrapped, the tool answers
// `{ error: { code: "<platform>_not_connected", message } }`, the same contract
// the shopify app ships and the same one the google and merchant reads already
// built inline. Any other throw still propagates.
import { withMetaConnectionEnvelope } from "./lib/get-client"
import { withGoogleConnectionEnvelope } from "./lib/google-config"
import * as reads from "./reads"
import * as writes from "./writes"
import * as pauseHandlers from "./pause"
import * as googleReads from "./google-reads"
import * as googleWrites from "./google-writes"
import * as googlePause from "./google-pause"

// ─── Meta reads (reads.ts) ───────────────────────────────────────────────────
export const insights_query = withMetaConnectionEnvelope(reads.insights_query)
export const campaigns_list = withMetaConnectionEnvelope(reads.campaigns_list)
export const adsets_list = withMetaConnectionEnvelope(reads.adsets_list)
export const ads_list = withMetaConnectionEnvelope(reads.ads_list)
export const targeting_search = withMetaConnectionEnvelope(reads.targeting_search)
export const media_list = withMetaConnectionEnvelope(reads.media_list)
export const audiences_list = withMetaConnectionEnvelope(reads.audiences_list)
export const pages_list = withMetaConnectionEnvelope(reads.pages_list)
export const account_info = withMetaConnectionEnvelope(reads.account_info)
export const graph_get = withMetaConnectionEnvelope(reads.graph_get)
export const creative_get = withMetaConnectionEnvelope(reads.creative_get)
export const ad_preview = withMetaConnectionEnvelope(reads.ad_preview)
export const counts = withMetaConnectionEnvelope(reads.counts)
// pending_approvals_list reads the kernel approvals surface, never Meta.
export const pending_approvals_list = reads.pending_approvals_list
export const __resetCountsCache = reads.__resetCountsCache

// ─── Meta writes (writes.ts) ─────────────────────────────────────────────────
export const create_campaign = withMetaConnectionEnvelope(writes.create_campaign)
export const create_adset = withMetaConnectionEnvelope(writes.create_adset)
export const create_adset_preflight = withMetaConnectionEnvelope(writes.create_adset_preflight)
export const create_ad = withMetaConnectionEnvelope(writes.create_ad)
export const create_creative = withMetaConnectionEnvelope(writes.create_creative)
export const upload_image = withMetaConnectionEnvelope(writes.upload_image)
export const update_budget = withMetaConnectionEnvelope(writes.update_budget)
export const update_budget_preflight = withMetaConnectionEnvelope(writes.update_budget_preflight)
export const set_status = withMetaConnectionEnvelope(writes.set_status)
export const create_custom_audience = withMetaConnectionEnvelope(writes.create_custom_audience)
export const create_custom_audience_preflight = withMetaConnectionEnvelope(
  writes.create_custom_audience_preflight,
)
export const create_lookalike_audience = withMetaConnectionEnvelope(writes.create_lookalike_audience)
export const add_users_to_audience = withMetaConnectionEnvelope(writes.add_users_to_audience)
export const add_users_to_audience_preflight = withMetaConnectionEnvelope(
  writes.add_users_to_audience_preflight,
)
// Pure param validators, no connection of their own.
export const preflightCreateAdsetParams = writes.preflightCreateAdsetParams
export const preflightUpdateBudgetParams = writes.preflightUpdateBudgetParams
export const preflightCreateCustomAudienceParams = writes.preflightCreateCustomAudienceParams
export const preflightAddUsersToAudienceParams = writes.preflightAddUsersToAudienceParams

// ─── Meta pause (pause.ts) ───────────────────────────────────────────────────
export const pause = withMetaConnectionEnvelope(pauseHandlers.pause)
export const pause_preflight = withMetaConnectionEnvelope(pauseHandlers.pause_preflight)
export const preflightPauseParams = pauseHandlers.preflightPauseParams

// ─── Google reads (google-reads.ts) ──────────────────────────────────────────
export const google_campaigns_list = withGoogleConnectionEnvelope(googleReads.google_campaigns_list)
export const google_adgroups_list = withGoogleConnectionEnvelope(googleReads.google_adgroups_list)
export const google_ads_list = withGoogleConnectionEnvelope(googleReads.google_ads_list)
export const google_insights_query = withGoogleConnectionEnvelope(googleReads.google_insights_query)
export const google_account_info = withGoogleConnectionEnvelope(googleReads.google_account_info)
export const google_search_terms = withGoogleConnectionEnvelope(googleReads.google_search_terms)
export const google_recommendations_list = withGoogleConnectionEnvelope(
  googleReads.google_recommendations_list,
)

// ─── Google writes (google-writes.ts) ────────────────────────────────────────
export const google_create_campaign = withGoogleConnectionEnvelope(googleWrites.google_create_campaign)
export const google_create_campaign_preflight = withGoogleConnectionEnvelope(
  googleWrites.google_create_campaign_preflight,
)
export const google_create_adgroup = withGoogleConnectionEnvelope(googleWrites.google_create_adgroup)
export const google_create_ad = withGoogleConnectionEnvelope(googleWrites.google_create_ad)
export const google_update_budget = withGoogleConnectionEnvelope(googleWrites.google_update_budget)
export const google_set_status = withGoogleConnectionEnvelope(googleWrites.google_set_status)
export const google_set_status_preflight = withGoogleConnectionEnvelope(
  googleWrites.google_set_status_preflight,
)
export const google_add_negative_keywords = withGoogleConnectionEnvelope(
  googleWrites.google_add_negative_keywords,
)
export const google_add_negative_keywords_preflight = withGoogleConnectionEnvelope(
  googleWrites.google_add_negative_keywords_preflight,
)
export const google_create_conversion_action = withGoogleConnectionEnvelope(
  googleWrites.google_create_conversion_action,
)
export const preflightGoogleCreateCampaignParams = googleWrites.preflightGoogleCreateCampaignParams
export const preflightGoogleSetStatusParams = googleWrites.preflightGoogleSetStatusParams
export const preflightGoogleAddNegativeKeywordsParams =
  googleWrites.preflightGoogleAddNegativeKeywordsParams

// ─── Google pause (google-pause.ts) ──────────────────────────────────────────
export const google_pause = withGoogleConnectionEnvelope(googlePause.google_pause)
export const google_pause_preflight = withGoogleConnectionEnvelope(googlePause.google_pause_preflight)
export const preflightGooglePauseParams = googlePause.preflightGooglePauseParams

// ─── Handlers that build their own not-connected envelope already ────────────
export * from "./merchant-reads"
export * from "./summarizers"
export * from "./lab/experiments"
export * from "./lab/manual-spend"
export * from "./lab/dealer-profiles"
export * from "./metrics/tools"
export * from "./lab/audience-erasure-consumer"
