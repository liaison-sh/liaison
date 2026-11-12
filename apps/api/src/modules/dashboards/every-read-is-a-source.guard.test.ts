// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY READ IS A DASHBOARD SOURCE. A tool any app declares as a read (`readOnly`, no write
// target), in-tree, bundled or kernel, is either a source a dashboard block can save and run
// on, or it sits on the reviewed exclusion list below with its reason. A new read that is
// neither fails here, so a feature cannot ship a list or a figure people can ask about in
// chat but never chart.
//
// A source passes the rule a saved block is judged by (`dashboardSourceRefusal`, the same
// check `checkToolSource` runs at save and at every run; kernel tools qualify only through
// `KERNEL_DASHBOARD_SOURCES`), and its entry in SOURCES says how a block reads its result:
//   "rows"         the result is a list, or holds one (items, rows, data, or its only list);
//   { rowsPath }  the result holds several lists: a block names the one it charts;
//   "object"       one record or a set of figures: a metric block reads a field by path.
//
// An exclusion carries one of the reasons a read may stay off dashboards: a spec rule, a
// read limited to a person's own turn, a DM or a trust boundary (a secret, a key), a web
// read, a contract op another app or the kernel calls, or (pending a ruling) a duplicate
// of a read that is itself a source. Nothing else: a flag set for convenience goes instead.
//
// `pendingMainFix` lists reads that do not qualify today for a reason that is not one of
// those: a hidden page read (the rule refuses any read not offered to agents), a kernel read
// not yet on the source list. Each waits on a fix on main, to the rule or to the tool; the
// list must be empty before this epic's gate.

import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import type { toolRegistry } from "~/modules/apps/app-registries"
import { dashboardSourceRefusal } from "~/modules/apps/execute-tool"
import { KERNEL_DASHBOARD_SOURCES } from "~/modules/dashboards/sources"
import { collectKernelTools, loadManifests } from "../../../../../scripts/docs/gen-reference"

type Tool = NonNullable<ReturnType<typeof toolRegistry.get>>
type Shape = "rows" | "object" | { rowsPath: string }
type Reason =
  | "spec rule"
  | "human turn"
  | "DM only"
  | "trust boundary"
  | "web read"
  | "contract-only op"
  | "duplicate of a source"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
/** Apps no org runs: the template app and the contacts shim (tool-bench/catalog.ts). */
const LEFT_OUT_APPS = new Set(["example", "contacts"])

/** Every read that feeds a dashboard, and how a block reads its result. */
const SOURCES: Record<string, Shape> = {
  "ads:account_info": "object",
  "ads:ad_preview": "object",
  "ads:ads_list": "rows",
  "ads:adsets_list": "rows",
  "ads:audiences_list": "rows",
  "ads:campaigns_list": "rows",
  "ads:creative_get": "rows",
  "ads:dealer_profiles_list": "rows",
  "ads:experiment_list": "rows",
  "ads:google_account_info": "rows",
  "ads:google_adgroups_list": "rows",
  "ads:google_ads_list": "rows",
  "ads:google_campaigns_list": "rows",
  "ads:google_insights_query": "rows",
  "ads:google_recommendations_list": "rows",
  "ads:google_search_terms": "rows",
  "ads:graph_get": "object",
  "ads:insights_query": "rows",
  "ads:manual_spend_list": "rows",
  "ads:media_list": "rows",
  "ads:merchant_feed_status": "rows",
  "ads:merchant_product_issues": "rows",
  "ads:metrics_list": "rows",
  "ads:metrics_run": "rows",
  "ads:pages_list": "rows",
  "ads:targeting_search": "rows",
  "api-connector:connector_adapter_get": "object",
  "api-connector:connector_adapter_reference": "rows",
  "api-connector:connector_adapter_test": "object",
  "api-connector:connector_adapter_versions": "rows",
  "api-connector:connector_list_operations": "rows",
  "api-connector:connector_read": "object",
  "boxtal:attention_rules_list": { rowsPath: "rules" },
  "boxtal:exceptions_list": "rows",
  "boxtal:get_documents": "rows",
  "boxtal:get_shipment": "object",
  "boxtal:list_content_categories": "rows",
  "boxtal:order_print_record_get": "rows",
  "boxtal:packages_list": { rowsPath: "profiles" },
  "boxtal:prep_list": "rows",
  "boxtal:prep_order_prefill": "rows",
  "boxtal:prep_unlinked_list": "rows",
  "boxtal:print_record_get": "rows",
  "boxtal:queue_counts": "object",
  "boxtal:quote": "rows",
  "boxtal:ready_list": "rows",
  "boxtal:returns_list": "rows",
  "boxtal:search": "rows",
  "boxtal:settings_carrier_allowlist_get": { rowsPath: "allowed" },
  "boxtal:settings_label_format_get": "rows",
  "boxtal:settings_packaging_policy_get": { rowsPath: "cartons" },
  "boxtal:settings_product_codes_get": { rowsPath: "aliases" },
  "boxtal:settings_sender_address_get": "rows",
  "boxtal:shipment_draft_get": { rowsPath: "parcels" },
  "boxtal:stuck_list": "rows",
  "boxtal:to_prepare_list": "rows",
  "boxtal:track": "rows",
  "calendar:list_accounts": "rows",
  "calendar:list_calendars": "rows",
  "calendar:list_events": "rows",
  "calendar:search_events": "rows",
  "calls:calls_list": "object",
  "calls:calls_segments_since": "object",
  "database:db_describe": "rows",
  "database:db_list_reads": "object",
  "database:db_probe": { rowsPath: "missingReads" },
  "database:db_query": "rows",
  "database:db_read": "rows",
  "gitlab:gitlab_get_commit": "object",
  "gitlab:gitlab_get_merge_request": "object",
  "gitlab:gitlab_list_commits": "rows",
  "gitlab:gitlab_list_issues": "rows",
  "gitlab:gitlab_list_labels": "rows",
  "gitlab:gitlab_list_merge_requests": "rows",
  "gitlab:gitlab_list_milestones": "rows",
  "gitlab:gitlab_list_projects": "rows",
  "gitlab:gitlab_list_releases": "rows",
  "gitlab:gitlab_list_tags": "rows",
  "gitlab:gitlab_list_tree": "rows",
  "gitlab:gitlab_read_file": "object",
  "gitlab:gitlab_search": "rows",
  "google-drive:read": "object",
  "google-drive:search": "rows",
  "google-drive:shared_drives": "rows",
  "invoicing:contact_relationships_get": "object",
  "invoicing:counterparty_identity_get": "object",
  "invoicing:counterparty_identity_lookup": { rowsPath: "candidates" },
  "invoicing:customer_history": { rowsPath: "documents" },
  "invoicing:deferred_list": "rows",
  "invoicing:documents_download_pdf": "object",
  "invoicing:documents_for_orders": "rows",
  "invoicing:documents_get": { rowsPath: "lines" },
  "invoicing:documents_issue_preview": "rows",
  "invoicing:documents_search": "rows",
  "invoicing:documents_update_preview": { rowsPath: "lines" },
  "invoicing:einvoice_transmission_get": "rows",
  "invoicing:einvoicing_classify": "rows",
  "invoicing:einvoicing_readiness": "rows",
  "invoicing:einvoicing_settings_get": "rows",
  "invoicing:hs_codes_lookup": "rows",
  "invoicing:issuer_stream_get": "rows",
  "invoicing:legal_originals_verify": { rowsPath: "mismatched" },
  "invoicing:orders_invoiceability_check": "rows",
  "invoicing:received_einvoices_get": { rowsPath: "history" },
  "invoicing:received_einvoices_list": "rows",
  "invoicing:recurring_list": "rows",
  "invoicing:recurring_run_get": "rows",
  "invoicing:settings_hs_code_list": "rows",
  "invoicing:settings_issuer_profile_list": "rows",
  "invoicing:settings_shop_mapping_list": "rows",
  "invoicing:settings_tax_regime_list": "rows",
  "invoicing:vat_lookup": { rowsPath: "candidates" },
  "invoicing:vat_validate": "object",
  "kernel:approvals_list": "rows",
  "kernel:audit_search": "rows",
  "kernel:companies_find_duplicates": "rows",
  "kernel:companies_propose_from_contacts": "rows",
  "kernel:companies_read": { rowsPath: "people" },
  "kernel:companies_search": "rows",
  "kernel:company_timeline": "rows",
  "kernel:contacts_search": "rows",
  "kernel:list_routines": "rows",
  "kernel:threads_list": "rows",
  "kernel:users_list": "rows",
  "knowledge:find_by_title": "object",
  "knowledge:get": "object",
  "knowledge:review_queue": "rows",
  "knowledge:search": { rowsPath: "hits" },
  "mail:getAccount": "object",
  "mail:listAccounts": "rows",
  "mail:read": { rowsPath: "messages" },
  "mail:search": "rows",
  "mail:suppression_check": "rows",
  "mcp-manager:list_connections": "rows",
  "monitoring:incidents_get": "object",
  "monitoring:incidents_list": "rows",
  "monitoring:incidents_summary": "object",
  "pennylane:cash_position": "rows",
  "pennylane:customer_invoices_list": "rows",
  "pennylane:home_load": "object",
  "pennylane:pnl_summary": "object",
  "pennylane:runway_estimate": "object",
  "pennylane:spend_by_category": "rows",
  "pennylane:supplier_invoice_get": "object",
  "pennylane:supplier_invoices_list": "rows",
  "pennylane:transactions_list": "rows",
  "pennylane:trial_balance_get": "rows",
  "projects:attentionItems": "rows",
  "projects:checklist_get": "rows",
  "projects:comments": "rows",
  "projects:deals_followup_candidates": "rows",
  "projects:deals_rollup": "rows",
  "projects:deals_search": "rows",
  "projects:get": "object",
  "projects:labels.list": "rows",
  "projects:portfolio_rollup": "rows",
  "projects:search": "rows",
  "projects:tasks_byAssignee": "rows",
  "projects:tasks_byProject": "rows",
  "shopify:abandoned_checkouts_list": "rows",
  "shopify:analytics_query": "object",
  "shopify:companies_get": { rowsPath: "locations" },
  "shopify:companies_search": "rows",
  "shopify:customers_get": "object",
  "shopify:customers_get_by_external_id": "object",
  "shopify:customers_search": "rows",
  "shopify:customers_segment_search": "rows",
  "shopify:discounts_search": "rows",
  "shopify:draft_orders_get": { rowsPath: "lineItems" },
  "shopify:draft_orders_list": "rows",
  "shopify:fulfillment_orders_get": "rows",
  "shopify:fulfillments_get": "object",
  "shopify:home_load": "object",
  "shopify:inventory_levels_list": "rows",
  "shopify:inventory_value": "rows",
  "shopify:locations_list": "rows",
  "shopify:markets_get": "object",
  "shopify:markets_list": "rows",
  "shopify:metafields_list": "rows",
  "shopify:orders_get": { rowsPath: "lineItems" },
  "shopify:orders_invoice_links": "rows",
  "shopify:orders_search": "rows",
  "shopify:products_get": "object",
  "shopify:products_publication_targets": "object",
  "shopify:products_search": "rows",
  "shopify:products_short_codes": "object",
  "shopify:refunds_get": "object",
  "shopify:repeat_rate": "rows",
  "shopify:returns_search": "rows",
  "shopify:settings_load": { rowsPath: "mappings" },
  "shopify:variants_brief": "rows",
  "shopify:variants_get": "object",
  "shopify:variants_market_price": "object",
  "shopify:variants_search": "rows",
  "social:connections_status": "rows",
  "social:counts": "object",
  "social:dm_get": "rows",
  "social:dm_list": "rows",
  "social:findings_get": "object",
  "social:findings_list": "rows",
  "social:monitor_terms_list": "rows",
  "social:quota_status": "rows",
  "social:watched_list": "rows",
  "stripe:card_update_link": "object",
  "stripe:customers_get": { rowsPath: "subscriptions" },
  "stripe:customers_search": "rows",
  "stripe:disputes_list": "rows",
  "stripe:invoices_search": "rows",
  "stripe:mrr_query": { rowsPath: "lines" },
  "stripe:payments_search": "rows",
  "stripe:subscriptions_search": "rows",
  "tickets:apiKeys.list": "rows",
  "tickets:approveFromHome.get": "object",
  "tickets:backlogHealth": { rowsPath: "byCategory" },
  "tickets:categories.list": "rows",
  "tickets:csat.list": "rows",
  "tickets:csat.summary": "rows",
  "tickets:get": "rows",
  "tickets:idSegment.get": "object",
  "tickets:inboxCounts": "rows",
  "tickets:inboxes.list": "rows",
  "tickets:listForContact": "rows",
  "tickets:search": "rows",
  "tickets:slaReport": { rowsPath: "perAgent" },
  "tickets:teams.list": "rows",
  "tickets:templates.list": "rows",
}

/** Reads that stay off dashboards, each with its reviewed reason. */
const EXCLUDED: ReadonlyArray<{ tool: string; reason: Reason; why: string }> = [
  {
    tool: "ads:pending_approvals_list",
    reason: "duplicate of a source",
    why: "the same rows as kernel approvals_list, a source; hidden so the agent has one approvals read",
  },
  {
    tool: "calendar:activity_read",
    reason: "contract-only op",
    why: "the kernel's timeline contract: called by the kernel with its cursor; the app's own search reads give the same records",
  },
  {
    tool: "calls:webhook_info",
    reason: "trust boundary",
    why: "returns the webhook signing secret to an operator; a secret never goes on a page",
  },
  {
    tool: "invoicing:activity_read",
    reason: "contract-only op",
    why: "the kernel's timeline contract: called by the kernel with its cursor; the app's own search reads give the same records",
  },
  {
    tool: "invoicing:approval_route_read",
    reason: "contract-only op",
    why: "the kernel's approval-routing contract: who a staged card is for",
  },
  {
    tool: "invoicing:card_stream_issuer",
    reason: "contract-only op",
    why: "a cross-app contract the Stripe app's refunds call",
  },
  {
    tool: "invoicing:document_send_state",
    reason: "contract-only op",
    why: "the send check's contract: whether a reminder may still go out, read at send time",
  },
  {
    tool: "invoicing:draft_issue_preview",
    reason: "contract-only op",
    why: "what an approval card reads for a saved draft",
  },
  {
    tool: "invoicing:pending_approvals_list",
    reason: "duplicate of a source",
    why: "the same rows as kernel approvals_list, a source; hidden so the agent has one approvals read",
  },
  {
    tool: "kernel:contacts_identity",
    reason: "contract-only op",
    why: "an app's internal identity check (id, email, company id); kernel contacts_search is the source",
  },
  {
    tool: "kernel:suggest_next_steps",
    reason: "human turn",
    why: "adds reply chips to the turn it runs in and reads no records",
  },
  {
    tool: "mail:activity_read",
    reason: "contract-only op",
    why: "the kernel's timeline contract: called by the kernel with its cursor; the app's own search reads give the same records",
  },
  {
    tool: "monitoring:webhook_info",
    reason: "trust boundary",
    why: "returns the webhook signing secret to an operator; a secret never goes on a page",
  },
  {
    tool: "pennylane:einvoicing_find",
    reason: "contract-only op",
    why: "a provider-contract op invoicing calls; the tool is marked contractOnly and internal",
  },
  {
    tool: "pennylane:einvoicing_find_booking",
    reason: "contract-only op",
    why: "a provider-contract op invoicing calls; the tool is marked contractOnly and internal",
  },
  {
    tool: "pennylane:einvoicing_received_get",
    reason: "contract-only op",
    why: "a provider-contract op invoicing calls; the tool is marked contractOnly and internal",
  },
  {
    tool: "pennylane:einvoicing_received_list",
    reason: "contract-only op",
    why: "a provider-contract op invoicing calls; the tool is marked contractOnly and internal",
  },
  {
    tool: "pennylane:einvoicing_registration_status",
    reason: "contract-only op",
    why: "a provider-contract op invoicing calls; the tool is marked contractOnly and internal",
  },
  {
    tool: "pennylane:einvoicing_status",
    reason: "contract-only op",
    why: "a provider-contract op invoicing calls; the tool is marked contractOnly and internal",
  },
  {
    tool: "projects:activity_read",
    reason: "contract-only op",
    why: "the kernel's timeline contract: called by the kernel with its cursor; the app's own search reads give the same records",
  },
  {
    tool: "projects:approval_route_read",
    reason: "contract-only op",
    why: "the kernel's approval-routing contract: who a staged card is for",
  },
  {
    tool: "projects:company_context",
    reason: "contract-only op",
    why: "the kernel's context contract: facts for the company in view",
  },
  {
    tool: "projects:deal_send_state",
    reason: "contract-only op",
    why: "the send check's contract: whether a mail about a deal may still go out",
  },
  {
    tool: "projects:webhook_info",
    reason: "trust boundary",
    why: "returns the webhook signing secret to an operator; a secret never goes on a page",
  },
  {
    tool: "stripe:activity_read",
    reason: "contract-only op",
    why: "the kernel's timeline contract: called by the kernel with its cursor; the app's own search reads give the same records",
  },
  {
    tool: "stripe:approval_route_read",
    reason: "contract-only op",
    why: "the kernel's approval-routing contract: who a staged card is for",
  },
  {
    tool: "stripe:billing_status_for_counterparty",
    reason: "contract-only op",
    why: "a cross-app contract invoicing's issuer guard and schedule end call",
  },
  {
    tool: "stripe:connection_precheck",
    reason: "trust boundary",
    why: "checks a secret key before it is stored; the key is a param and never goes on a page",
  },
  {
    tool: "stripe:customer_context",
    reason: "contract-only op",
    why: "the kernel's context contract: facts for the record in view",
  },
  {
    tool: "stripe:invoice_send_state",
    reason: "contract-only op",
    why: "the send check's contract: whether a reminder may still go out, read from Stripe at send time",
  },
  {
    tool: "stripe:reconcile_candidates",
    reason: "contract-only op",
    why: "a cross-app contract invoicing's safety job calls",
  },
  {
    tool: "stripe:refunds_for_charge",
    reason: "contract-only op",
    why: "a cross-app contract invoicing's refund handler calls, one live Stripe read per charge",
  },
  {
    tool: "stripe:settings_load",
    reason: "contract-only op",
    why: "the settings page's contract: connection state and the key's permissions, no business records",
  },
  {
    tool: "stripe:subscription_cancel_effect",
    reason: "contract-only op",
    why: "what a cancellation's approval card reads",
  },
  {
    tool: "tickets:activity_read",
    reason: "contract-only op",
    why: "the kernel's timeline contract: called by the kernel with its cursor; the app's own search reads give the same records",
  },
  {
    tool: "tickets:approval_route_read",
    reason: "contract-only op",
    why: "the kernel's approval-routing contract: who a staged card is for",
  },
]

/** Reads that wait on a fix on main (the rule or the tool). Must be empty before the gate. */
const pendingMainFix: ReadonlyArray<{ tool: string; why: string }> = [
  {
    tool: "projects:company_work",
    why: "hidden page read (a company's Work section); un-hiding costs the agent's search ranking and catalog, so it waits for the rule to stop requiring agentVisible",
  },
  {
    tool: "tickets:company_tickets",
    why: "hidden page read (a company's Support section); un-hiding costs the agent's search ranking and catalog, so it waits for the rule to stop requiring agentVisible",
  },
  {
    tool: "stripe:home_load",
    why: "hidden page read (the Stripe page's counts); its bare name collides with two other apps' home_load, so it waits for the rule to stop requiring agentVisible",
  },
  {
    tool: "ads:counts",
    why: "hidden (agentVisible false) as a sidebar helper; campaigns_list holds the same campaigns",
  },
  { tool: "boxtal:settings_form_get", why: "hidden settings-page form read" },
  { tool: "boxtal:settings_sender_form_get", why: "hidden settings-page form read" },
  {
    tool: "database:report_access_find_people",
    why: "hidden people lookup for a Report access rule",
  },
  { tool: "database:report_access_get", why: "hidden Report access settings read" },
  { tool: "invoicing:documents_preview_pdf", why: "hidden; returns a file id and URL, not rows" },
  { tool: "invoicing:einvoicing_provider_options", why: "hidden settings-page options read" },
  { tool: "invoicing:einvoicing_settings_values", why: "hidden settings-page form read" },
  { tool: "invoicing:viewer_access", why: "hidden; the caller's own permissions in Invoicing" },
  { tool: "kernel:ai_models_get", why: "not on the kernel source list" },
  { tool: "kernel:analyze_media", why: "not on the kernel source list" },
  { tool: "kernel:approval_policy_get", why: "not on the kernel source list" },
  { tool: "kernel:apps_build_get", why: "not on the kernel source list" },
  { tool: "kernel:apps_build_list", why: "not on the kernel source list" },
  { tool: "kernel:apps_build_logs", why: "not on the kernel source list" },
  { tool: "kernel:apps_build_preview", why: "not on the kernel source list" },
  { tool: "kernel:apps_build_versions", why: "not on the kernel source list" },
  { tool: "kernel:call_tool", why: "not on the kernel source list" },
  { tool: "kernel:computer_session_import_list", why: "not on the kernel source list" },
  { tool: "kernel:config_export", why: "not on the kernel source list" },
  { tool: "kernel:config_plan", why: "not on the kernel source list" },
  { tool: "kernel:contacts_addresses_list", why: "not on the kernel source list" },
  { tool: "kernel:contacts_find_duplicates", why: "not on the kernel source list" },
  { tool: "kernel:contacts_group_members", why: "not on the kernel source list" },
  { tool: "kernel:contacts_groups_list", why: "not on the kernel source list" },
  { tool: "kernel:contacts_read", why: "not on the kernel source list" },
  { tool: "kernel:dashboards_get", why: "not on the kernel source list" },
  { tool: "kernel:dashboards_history", why: "not on the kernel source list" },
  { tool: "kernel:dashboards_list", why: "not on the kernel source list" },
  { tool: "kernel:dashboards_preview_block", why: "not on the kernel source list" },
  { tool: "kernel:dashboards_snapshot", why: "not on the kernel source list" },
  { tool: "kernel:dashboards_sources", why: "not on the kernel source list" },
  { tool: "kernel:data_collections_list", why: "not on the kernel source list" },
  { tool: "kernel:data_get", why: "not on the kernel source list" },
  { tool: "kernel:data_query", why: "not on the kernel source list" },
  { tool: "kernel:describe_user_access", why: "not on the kernel source list" },
  { tool: "kernel:document_record_types_list", why: "not on the kernel source list" },
  { tool: "kernel:document_rules_list", why: "not on the kernel source list" },
  { tool: "kernel:document_rules_match", why: "not on the kernel source list" },
  { tool: "kernel:document_template_get", why: "not on the kernel source list" },
  { tool: "kernel:document_templates_list", why: "not on the kernel source list" },
  { tool: "kernel:drive_picker", why: "not on the kernel source list" },
  { tool: "kernel:export", why: "not on the kernel source list" },
  { tool: "kernel:files_list", why: "not on the kernel source list" },
  { tool: "kernel:files_read", why: "not on the kernel source list" },
  { tool: "kernel:find_repos_on_my_computer", why: "not on the kernel source list" },
  { tool: "kernel:get_role", why: "not on the kernel source list" },
  { tool: "kernel:google_setup", why: "not on the kernel source list" },
  { tool: "kernel:import_kinds", why: "not on the kernel source list" },
  { tool: "kernel:import_reference", why: "not on the kernel source list" },
  { tool: "kernel:import_sample", why: "not on the kernel source list" },
  { tool: "kernel:import_status", why: "not on the kernel source list" },
  { tool: "kernel:list_dimensions", why: "not on the kernel source list" },
  { tool: "kernel:list_locked_capabilities", why: "not on the kernel source list" },
  { tool: "kernel:list_my_remote_repos", why: "not on the kernel source list" },
  { tool: "kernel:list_routine_events", why: "not on the kernel source list" },
  { tool: "kernel:list_scopes", why: "not on the kernel source list" },
  { tool: "kernel:list_skills", why: "not on the kernel source list" },
  { tool: "kernel:mail_attachment_read", why: "not on the kernel source list" },
  { tool: "kernel:mailbox_setup", why: "not on the kernel source list" },
  { tool: "kernel:memory_episode", why: "not on the kernel source list" },
  { tool: "kernel:memory_open", why: "not on the kernel source list" },
  { tool: "kernel:memory_search", why: "not on the kernel source list" },
  { tool: "kernel:memory_view", why: "not on the kernel source list" },
  { tool: "kernel:merge_imported_user_preview", why: "not on the kernel source list" },
  { tool: "kernel:notifications_get", why: "not on the kernel source list" },
  { tool: "kernel:open_app", why: "not on the kernel source list" },
  { tool: "kernel:outside_text_sources", why: "not on the kernel source list" },
  { tool: "kernel:policy_get", why: "not on the kernel source list" },
  { tool: "kernel:product_attributes_list", why: "not on the kernel source list" },
  { tool: "kernel:roles_list", why: "not on the kernel source list" },
  { tool: "kernel:routine_tool_scopes", why: "not on the kernel source list" },
  { tool: "kernel:setup_state", why: "not on the kernel source list" },
  { tool: "kernel:shopify_setup", why: "not on the kernel source list" },
  { tool: "kernel:sidebar_apps_get", why: "not on the kernel source list" },
  { tool: "kernel:skill_read", why: "not on the kernel source list" },
  { tool: "kernel:skill_search", why: "not on the kernel source list" },
  { tool: "kernel:subagent_get", why: "not on the kernel source list" },
  { tool: "kernel:subagent_list", why: "not on the kernel source list" },
  { tool: "kernel:threads_read", why: "not on the kernel source list" },
  { tool: "kernel:threads_search", why: "not on the kernel source list" },
  { tool: "kernel:tool_search", why: "not on the kernel source list" },
  { tool: "kernel:user_memory_get", why: "not on the kernel source list" },
  { tool: "kernel:users_search", why: "not on the kernel source list" },
  { tool: "knowledge:synced_sources.list", why: "hidden settings-page read of synced sources" },
  { tool: "mail:getSyncStatus", why: "hidden; listAccounts holds the same status" },
  { tool: "mail:providers.get", why: "hidden settings-page read" },
  { tool: "projects:labels.tree", why: "hidden settings-page tree read" },
  { tool: "tickets:categories.tree", why: "hidden settings-page tree read" },
]

type ManifestTool = Record<string, unknown>

/** A manifest tool as registration keeps it (runtime.ts), for the fields the source rule reads. */
function asRegistered(app: string, name: string, t: ManifestTool): Tool {
  const entry: Record<string, unknown> = {
    appName: app,
    name,
    description: String(t.description ?? ""),
    requiredScopes: (t.requiredScopes as string[]) ?? [],
    handler: async () => null,
  }
  for (const k of ["gated", "conditionalGate", "externalEffect", "contractOnly", "agentVisible"]) {
    if (typeof t[k] === "boolean") entry[k] = t[k]
  }
  if (typeof t.trustBoundary === "string") entry.trustBoundary = t.trustBoundary
  if (typeof t.writesToTable === "string") entry.writesToTable = t.writesToTable
  // Every app here is first-party, so its readOnly claim is honoured as registration does.
  if (t.readOnly === true) entry.readOnly = true
  if (t.returns) entry.returns = t.returns
  return entry as unknown as Tool
}

const appReads = new Map<string, Tool>()
for (const m of loadManifests(REPO)) {
  if (LEFT_OUT_APPS.has(m.name)) continue
  const tools = (m.manifest.tools ?? {}) as Record<string, ManifestTool>
  for (const [name, t] of Object.entries(tools)) {
    if (t.readOnly === true && typeof t.writesToTable !== "string") {
      appReads.set(`${m.name}:${name}`, asRegistered(m.name, name, t))
    }
  }
}
const kernelReads = new Set(
  collectKernelTools(REPO)
    .tools.filter((t) => t.readOnly)
    .map((t) => `kernel:${t.name}`),
)
const allReads = new Set([...appReads.keys(), ...kernelReads])
const excluded = new Map(EXCLUDED.map((e) => [e.tool, e]))
const pending = new Map(pendingMainFix.map((e) => [e.tool, e]))

describe("every read is a dashboard source", () => {
  it("finds the catalog's reads", () => {
    expect(appReads.size).toBeGreaterThan(150)
    expect(kernelReads.has("kernel:users_list")).toBe(true)
  })

  it("each read is a source, an exclusion with its reason, or pending its fix, and only one", () => {
    const unplaced: string[] = []
    const twice: string[] = []
    for (const tool of allReads) {
      const n = [tool in SOURCES, excluded.has(tool), pending.has(tool)].filter(Boolean).length
      if (n === 0) unplaced.push(tool)
      if (n > 1) twice.push(tool)
    }
    expect({ unplaced, twice }).toEqual({ unplaced: [], twice: [] })
  })

  it("names only reads that exist", () => {
    const named = [...Object.keys(SOURCES), ...excluded.keys(), ...pending.keys()]
    expect(named.filter((t) => !allReads.has(t))).toEqual([])
    expect(named.length).toBe(new Set(named).size)
  })

  it("an app source passes the rule a saved block is judged by", () => {
    const refused: string[] = []
    for (const [tool, def] of appReads) {
      if (!(tool in SOURCES)) continue
      const why = dashboardSourceRefusal(def)
      if (why) refused.push(`${tool}: ${why}`)
    }
    expect(refused).toEqual([])
  })

  it("a kernel source is on the kernel source list, and the list holds only reads", () => {
    const sources = Object.keys(SOURCES).filter((t) => t.startsWith("kernel:"))
    expect(sources.sort()).toEqual([...KERNEL_DASHBOARD_SOURCES].map((n) => `kernel:${n}`).sort())
  })

  it("a source whose manifest declares its result names the list a block reads", () => {
    const wrong: string[] = []
    for (const [tool, def] of appReads) {
      const shape = SOURCES[tool]
      const schema = def.returns?.schema
      if (!shape || !schema) continue
      if (typeof shape === "object" && !(shape.rowsPath in schema)) wrong.push(tool)
      if (shape === "rows" && !Object.values(schema).some((t) => t === "object" || t === "any"))
        wrong.push(tool)
    }
    expect(wrong).toEqual([])
  })

  it("an exclusion's reason is one the rule allows, and is explained", () => {
    for (const e of EXCLUDED) expect(e.why.length).toBeGreaterThan(20)
  })

  it("a provider-contract or trust-boundary flag on a read keeps it excluded, never pending", () => {
    for (const [tool, def] of appReads) {
      if (!def.contractOnly && def.trustBoundary !== "internal" && def.trustBoundary !== "agent")
        continue
      expect(excluded.get(tool)?.reason).toMatch(/contract-only op|trust boundary/)
    }
  })
})
