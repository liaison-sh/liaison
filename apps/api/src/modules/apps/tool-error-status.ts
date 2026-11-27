// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HTTP class of the deliberate error codes the bundled apps return in a
// soft-error envelope (`{ error: { code, message } }`) or a ToolError. The
// kernel's own codes live in `statusForToolError` (execute-tool.ts); an app
// code missing from both answered 500, which the web client turns into a
// generic "Something went wrong" toast and the watchdog pages as a fault, even
// when the message was a clear, expected refusal the user could act on.
//
// 4xx: the caller or the org's data/settings must change (the message says
// how). 502/503: an upstream the app depends on failed or is missing; those
// stay in the fault class on purpose, but no longer read as our own crash.
// `execute-tool.error-status.test.ts` scans every app's sources and fails when
// a code it returns is missing here.

export const APP_TOOL_ERROR_STATUS: Readonly<Record<string, number>> = {
  // ── boxtal ────────────────────────────────────────────────────────────────
  // Bad or incomplete input.
  invalid_order_key: 400,
  invalid_choice: 400,
  validation: 400,
  recipient_phone_invalid: 400,
  too_many: 400,
  invalid_status: 400,
  invalid_recipient: 400,
  invalid_note: 400,
  invalid_category: 400,
  offer_required: 400,
  quoted_price_required: 400,
  content_code_required: 400,
  no_items: 400,
  // set_customs: a unit value that is not a positive number.
  invalid_unit_value: 400,
  // Boxtal refused the route's own data (an invalid postal code for the country).
  cotation_invalid: 400,
  // A batch proforma's source invoice is gone or unreadable: the batch waits on that document.
  source_document_unreadable: 409,
  // Names nothing that exists.
  shipment_not_found: 404,
  document_not_found: 404,
  order_not_found: 404,
  row_not_found: 404,
  // A write naming two different rows: the caller says which one it means.
  order_key_mismatch: 409,
  // A pick between the order's address and the verified one: needed, gone stale or not needed.
  address_differs: 409,
  address_choice_not_needed: 409,
  address_choice_stale: 409,
  // The state moved or does not allow it (re-quote, wait, or pick another row).
  duplicate: 409,
  row_locked: 409,
  // An issuer profile that issued documents: kept for them, edited instead of deleted.
  issuer_in_use: 409,
  already_dispatched: 409,
  price_increased: 409,
  offer_not_quoted: 409,
  partial_overship: 409,
  not_claimable: 409,
  note_pending_approval: 409,
  label_not_ready: 409,
  // The Shopify fulfillment a packed row asks for: no tracking number yet (the label is not
  // generated or unreadable), or Shopify refused it for the order's state (already fulfilled,
  // cancelled, a bad id). The row records why; nothing of ours failed.
  no_tracking: 409,
  // A typed tracking number the carrier's format refuses (re-type it), or a row that already
  // carries one (a typed number never replaces it).
  invalid_tracking_number: 422,
  tracking_already_set: 409,
  // settle_orphan_create: the row is not an orphaned purchase, it already carries a Boxtal order
  // (adopt it instead of releasing), or the order named is linked to another shipment.
  not_orphan: 409,
  has_order_id: 409,
  already_linked: 409,
  shopify_refused: 409,
  // The shipment is not linked to a Shopify order, or a partial batch has lines without a SKU.
  not_linked: 422,
  partial_without_sku: 422,
  // The packed tick: a parked Shopify request only its requester can withdraw, an untick that
  // needs the operator's explicit confirmation, a fulfil/cancel waiting on someone's approval.
  approval_not_withdrawn: 409,
  confirm_required: 409,
  pending_approval: 409,
  // Social: the platform's API exposes no like for this item (like_item's
  // stage-time preflight). An expected refusal the agent acts on, not a fault:
  // it answered 500 and read as a server error.
  like_unsupported_for_target: 422,
  // Settings or order data must be completed first.
  sender_address_required: 422,
  recipient_address_required: 422,
  recipient_phone_required: 422,
  recipient_incomplete: 422,
  nominal_value_unset: 422,
  unresolved_lines: 422,
  order_key_unresolved: 422,
  draft_unresolved: 422,
  no_order: 422,
  no_anchor_document: 422,
  // The Boxtal account itself is blocked on payment.
  boxtal_account_payment_blocked: 402,
  // Upstream (Boxtal, Shopify, invoicing) failed or is not there.
  cotation_error: 502,
  // The carrier's per-parcel label PDFs could not be merged into one document (a malformed upstream PDF).
  label_merge_failed: 502,
  create_uncertain: 502,
  unknown: 502,
  upstream: 502,
  shopify_error: 502,
  // Shopify could not be read, or its fulfil/cancel call threw (fulfillment.ts).
  shopify_unreachable: 502,
  unexpected: 502,
  proforma_failed: 502,
  proforma_not_issued: 502,
  issuer_lookup_failed: 502,
  invoicing_unavailable: 503,
  not_installed: 503,
  unsupported: 501,

  // ── kernel admin tools ────────────────────────────────────────────────────
  // A role, scope or dimension grant aimed at a client's portal account: the
  // target's kind, not a fault (admin-tools.ts EXTERNAL_USER_REFUSAL).
  USER_IS_EXTERNAL: 409,
  // A staff invitation for an address that belongs to a client of the portal.
  EMAIL_IS_PORTAL_USER: 409,

  // ── invoicing ─────────────────────────────────────────────────────────────
  invalid_input: 400,
  invalid_type: 400,
  invalid_amount: 400,
  credit_note_not_negative: 400,
  invalid_hs_code: 400,
  invalid_relationship: 400,
  invalid_original_document: 400,
  notes_too_long: 400,
  invalid_discount: 400,
  invalid_customer_reference: 400,
  customer_reference_too_long: 400,
  empty_document: 400,
  shopify_draft_order_id: 400,
  draft_order_id_missing: 400,
  issuer_not_found: 404,
  // Who issues what: a customer a live card subscription bills, a payment mirror that cannot say
  // yet, a card stream's issuer left unpicked, a stream with no choice, no card stream connected.
  subscription_stream_conflict: 409,
  subscription_check_unavailable: 503,
  issuer_required: 400,
  stream_not_choosable: 400,
  // Revenue streams: a stream or issuer named that does not exist, one bound twice, the shop's
  // stream set by hand, the shop's issuer set on its stream instead of the shop mapping.
  stream_not_found: 404,
  issuer_profile_not_found: 404,
  stream_exists: 409,
  shop_stream_automatic: 409,
  issuer_from_shop_mapping: 409,
  card_stream_not_connected: 409,
  issuer_unknown: 503,
  // Card payments from the payments app: what waits in the queue, how to name it, the rate a
  // bare charge needs.
  payment_ref_missing: 400,
  nothing_waiting: 404,
  vat_rate_required: 400,
  // The payments provider did not answer the read a decision is checked against: nothing was issued.
  payment_unreadable: 502,
  invoice_not_found: 404,
  einvoice_gate: 422,
  // Month-end run rows: a required argument is missing, the row changed under the caller, the run
  // no longer takes changes, or "from now on" has no schedule to change.
  applies_required: 400,
  unknown_field: 400,
  ends_on_required: 400,
  if_unchanged_since_required: 400,
  draft_changed: 409,
  already_in_run: 409,
  amount_changed: 409,
  run_closed: 409,
  schedule_issues_by_itself: 409,
  // No row of the run is ready to issue, so approving it would issue nothing: fix a row first.
  nothing_ready: 409,
  no_schedule: 422,
  schedule_has_no_currency: 422,
  draft_order_not_found: 404,
  issued_document_immutable: 409,
  // A create-and-issue keyed onto an existing document asked for different content: edit that
  // document with documents_update instead.
  already_exists_different_content: 409,
  // An invoice's legal original (fixed at issue) carries these values; changing them needs a
  // credit note and a new invoice, never an in-place edit.
  legal_original_locked: 409,
  // A date a person stated or typed: not a date, after today, or against the document's number. The
  // message says what to pass; nothing was issued or changed.
  issued_at_invalid: 400,
  issue_date_in_future: 422,
  issue_date_before_last_number: 409,
  issue_date_before_original: 409,
  issue_date_after_credit_note: 409,
  issue_date_crosses_number_year: 409,
  issue_date_breaks_number_order: 409,
  issue_date_set_by_draft_order: 409,
  // The issuer's stored time zone is not one: an administrator's setting, not a fault of ours.
  issuer_timezone_invalid: 422,
  invalid_timezone: 422,
  // A parked order that cannot be issued as asked: the row says why, a person chooses again.
  not_issued: 409,
  still_blocked: 409,
  // Changing a buyer's kind away from business needs a person; this caller cannot ask for one.
  approval_required: 409,
  // A received supplier invoice: this action is closed for its status, one already waits, or the
  // reason is not one the platform lists.
  received_action_not_allowed: 409,
  received_action_pending: 409,
  received_reason_invalid: 400,
  document_not_editable: 409,
  already_invoiced: 409,
  // A draft from a planned vs done card: its card changed since (issue refused), or its lines
  // belong to the card (edit refused).
  reconcile_changed: 409,
  from_reconcile_change_on_card: 409,
  // Making a draft from a planned vs done card: the card moved on, or could not be read.
  card_changed: 409,
  card_unreadable: 502,
  // Filing an annex: the invoice was sent, the file is not the caller's to read, or files are off.
  document_sent: 409,
  file_not_readable: 403,
  files_unavailable: 503,
  invalid_kind: 400,
  invalid_project: 400,
  nothing_billed: 422,
  // A retainer: its terms, its month drafted from its card, and the card's own discard.
  no_retainer_schedule: 409,
  nothing_to_bill: 409,
  // A renewal whose schedule bills several fee lines: a person sets the new terms.
  fee_lines_ambiguous: 409,
  not_a_card_draft: 409,
  not_a_retainer: 409,
  period_on_run: 409,
  month_on_other_card: 409,
  draft_outdated: 409,
  retainer_needs_project_money: 403,
  retainer_needs_reconcile: 409,
  // A change of a retainer's terms that does not name the version it was read at.
  version_required: 400,
  // A billing plan, its milestone and advance invoices, and an advance's refund.
  advance_already_deducted: 409,
  advance_exceeds_invoice: 422,
  advance_needs_final: 400,
  advance_not_issued: 409,
  already_drafted: 409,
  final_already_drafted: 409,
  billing_draft_locked: 409,
  invalid_step: 400,
  invalid_task: 400,
  no_billing_step: 404,
  no_customer: 422,
  no_steps: 400,
  not_an_advance: 404,
  not_an_advance_step: 400,
  not_done: 409,
  nothing_to_refund: 409,
  plan_on_rate_project: 409,
  advance_on_rate_project: 409,
  plan_total_mismatch: 422,
  project_unreadable: 502,
  quote_not_found: 404,
  quote_not_sent: 409,
  refund_by_hand: 422,
  step_locked: 409,
  task_gone: 404,
  task_not_in_project: 404,
  task_on_other_plan: 409,
  // An accepted amendment's milestone (billing_step_add) and a plan that lists amendments.
  amendment_not_accepted: 422,
  amendment_amount_mismatch: 422,
  amendment_on_other_plan: 409,
  currency_mismatch: 422,
  no_billing_plan: 409,
  // Correcting a billed line of a planned vs done invoice by a credit note.
  correction_by_hand: 422,
  line_not_found: 404,
  line_not_on_invoice: 422,
  not_invoiced: 409,
  nothing_to_credit: 409,
  use_new_line: 422,
  hs_code_in_use: 409,
  stale_reissue_approval: 409,
  reissue_needs_second_approval: 409,
  two_eyes_required: 409,
  issuer_profile_ambiguous: 409,
  unique_violation: 409,
  unexpected_approval: 409,
  // The Shopify read it needed is waiting on someone's approval.
  draft_order_fetch_pending_approval: 409,
  // Settings or counterparty data must be completed first.
  no_mail_account: 422,
  // The issuer's send-from mailbox is not one this person can send from.
  mailbox_unavailable: 422,
  no_issuer_profile: 422,
  no_recipient: 422,
  counterparty_incomplete: 422,
  // The intra-EU buyer-VAT guard (buyer-vat.ts): VIES says the VAT number is not valid, a
  // business buyer has no VAT number, or the consumer declaration contradicts the evidence.
  vat_id_invalid: 422,
  buyer_vat_id_required: 422,
  buyer_is_consumer_refused: 422,
  buyer_status_contradiction: 400,
  // deferred_tax_override on a park already resolved, or parked on something other than a tax review.
  already_resolved: 409,
  not_a_tax_review: 409,
  over_credit: 422,
  draft_order_sync_skipped: 422,
  // E-invoicing issue gate: buyer data the regime needs is missing or unconfirmed.
  einvoice_data_missing: 422,
  customer_kind_missing: 422,
  siren_invalid: 422,
  siren_inactive: 422,
  einvoice_needs_review: 422,
  operation_category_missing: 422,
  registry_unconfirmed: 422,
  imported_original_missing: 409,
  // E-invoicing transmission (provider contract): the document is not one that may be sent, what
  // was approved changed since, or the platform is not set up yet. Refusals, never faults.
  einvoice_not_eligible: 422,
  einvoice_approval_stale: 409,
  einvoice_already_sent: 409,
  einvoice_send_disabled: 409,
  // Standing authorization asked for before an e-invoicing platform is chosen.
  einvoicing_platform_not_set: 409,
  einvoice_before_cutover: 409,
  einvoice_retry_not_allowed: 409,
  // A send prepared under a stream's standing grant or a month-end row's grant whose document is no
  // longer that stream's or that row's; a standing authorization asked for a stream that has none;
  // a collection the platform did not take.
  stream_mismatch: 409,
  run_item_mismatch: 409,
  stream_not_authorizable: 400,
  not_reported: 502,
  // A payment reminder about an invoice already settled: the send guard's stop codes.
  invoice_paid: 409,
  invoice_credited: 409,
  invoice_voided: 409,
  not_transmitted: 409,
  approval_unavailable: 409,
  booking_disabled: 409,
  provider_not_available: 422,
  vat_rate_unmappable: 422,
  legal_original_mismatch: 409,
  pa_emission_not_activated: 409,
  contract_provider_not_configured: 409,
  contract_provider_unavailable: 409,
  contract_undeclared: 403,
  contract_op_unsupported: 422,
  // Who may make a provider act: the binding only an administrator sets, the dispatch grant a
  // person's approval mints, and the file actually uploaded embedding the checked CII.
  contract_binding_forbidden: 403,
  contract_binding_mismatch: 409,
  contract_grant_required: 403,
  contract_grant_invalid: 403,
  contract_grant_mismatch: 403,
  contract_grant_refused: 403,
  contract_provider_changed: 409,
  einvoice_cii_mismatch: 409,
  embedded_file_mismatch: 409,
  provider_rate_limited: 429,
  provider_unavailable: 503,
  // Recorded on a transmission row (last_error) and surfaced through the transmission read.
  booked_but_einvoiced: 409,
  send_unconfirmed: 409,
  facturx_unreadable: 502,
  provider_failed: 502,
  // A deposit call that failed mid-flight: the platform may have it, the next tick asks first.
  einvoice_outcome_unknown: 502,
  // An approved run threw before anything landed: nothing changed, it can be retried.
  handler_threw_no_effect: 503,
  contracts_unavailable: 503,
  // E-invoicing regime and readiness reason codes (P1): carried in `code` fields of reasons and
  // blockers; a refusal carrying one is the caller's data to fix, never a server fault.
  buyer_country_conflict: 422,
  buyer_not_business: 422,
  buyer_not_in_france: 422,
  buyer_siren_from_identity: 422,
  monaco: 422,
  dom: 422,
  dom_no_vat: 422,
  com: 422,
  credit_note_follows_original: 422,
  facturx_buyer_incomplete: 422,
  facturx_seller_incomplete: 422,
  fr_business_with_siren: 422,
  fx_rate_unavailable: 503,
  gate_warning: 422,
  internal_cancellation: 409,
  issuer_incomplete: 422,
  issuer_out_of_scope: 422,
  not_invoice_document: 422,
  public_entity_chorus_pro: 422,
  // A received supplier e-invoice whose XML the safe parser refuses (markup declarations,
  // entities, size, depth or time bounds), cannot read, or that is neither CII nor UBL: the
  // document is the problem, never the server.
  xml_dtd_refused: 422,
  xml_entity_refused: 422,
  xml_too_large: 422,
  xml_too_complex: 422,
  xml_timeout: 422,
  xml_malformed: 422,
  xml_not_an_invoice: 422,
  // The `code` an attention event carries when it RESOLVES an e-invoicing item (Factur-X built
  // after a failure); never a tool error, classified so the source scan stays exhaustive.
  resolved: 409,
  // Recurring schedules: a schedule that does not exist, has ended or has not started, a repeat
  // or end date it cannot take, and issuing by itself asked for at creation (it is set by an update).
  // A change made from an older version than the schedule now holds is refused, never written over.
  schedule_not_found: 404,
  schedule_ended: 409,
  // An item of a month-end run whose schedule was paused or ended before it issued: left out, no number used.
  schedule_stopped: 409,
  schedule_changed: 409,
  schedule_not_started: 409,
  invalid_schedule: 422,
  invalid_until: 422,
  auto_needs_update: 422,
  // The month-end run: a run or row that does not exist, a run not in the state the step needs,
  // a run's draft reached outside its run, a row not approved or already issued, and a draft
  // changed after its approval (it waits for a new one). The caller's state to act on.
  run_not_found: 404,
  item_not_found: 404,
  run_not_drafted: 409,
  run_not_approved: 409,
  run_already_issuing: 409,
  run_item_draft: 409,
  item_not_approved: 409,
  already_issued: 409,
  changed_since_approval: 409,
  // A row asked to issue outside its run's issue window, and a run draft written without its key.
  outside_issue_window: 409,
  not_a_run_draft: 422,
  // A row whose run stopped issuing, whose draft is gone, or whose draft lost its period key
  // between its approval and its issue: nothing was written and no number was used.
  run_not_issuing: 409,
  draft_missing: 409,
  draft_without_key: 409,
  // A Shopify-linked quote sent to the local convert (it converts by completing its draft order).
  shopify_linked: 409,
  // The local convert step failed; the quote is unchanged and no number was used.
  convert_failed: 502,
  // Upstream (mail, Shopify, the PDF renderer, another app) failed.
  send_dispatch_failed: 502,
  send_failed: 502,
  email_failed: 502,
  draft_order_fetch_failed: 502,
  draft_order_create_failed: 502,
  draft_order_complete_failed: 502,
  customs_fetch_failed: 502,
  thread_post_failed: 502,
  render_failed: 502,
  // The invoice's activity report could not be made into a PDF: nothing was sent, retry the send.
  activity_report_pdf_failed: 502,
  // The order could not be read just now: the address it would compare is unknown.
  order_unreadable: 503,
  target_app_unavailable: 503,
  // ── agreements ────────────────────────────────────────────────────────────
  // Bad or incomplete input.
  INVALID_KIND: 400,
  INVALID_PRICE: 400,
  INVALID_CURRENCY: 400,
  INVALID_SHARES: 400,
  INVALID_FILE: 400,
  INVALID_HOURS: 400,
  INVALID_PROJECT: 400,
  TITLE_REQUIRED: 400,
  TEMPLATE_INVALID: 400,
  USE_CHANGE_REQUEST: 400,
  // A heading, paragraph or clause in a field or value the editor cannot show.
  INVALID_SOURCE: 400,
  // Who may do it: only a person sets a price or says a document is not a guarantee; only an
  // editor on the list changes who can see it; an agent's change waits for a person.
  PRICE_NEEDS_A_PERSON: 403,
  NEEDS_A_PERSON: 403,
  NOT_AN_EDITOR: 403,
  APPROVAL_REQUIRED: 403,
  TEMPLATE_NOT_FOUND: 404,
  // The agreement's state stops it: not a draft, a stale draft, an empty list, a check failed.
  NOT_A_DRAFT: 409,
  VERSION_CONFLICT: 409,
  ACCESS_LIST_EMPTY: 409,
  PRICE_NOT_SET: 409,
  SIGNATURE_DOES_NOT_FIT: 409,
  PERSONAL_GUARANTEE: 409,
  WHAT_IT_IS_REQUIRED: 409,
  AGENT_TEXT_UNREAD: 409,
  DOCUMENT_EMPTY: 409,
  // A renewal retainer lacks the hours, price or first day that replace the current terms.
  RENEWAL_TERMS_MISSING: 409,
  // Freezing and sending for signature (agreements; client action links through the bridge).
  BLANK_FIELD: 409,
  FREEZE_TEXT_MISMATCH: 409,
  // An uploaded PDF (the render service's file checks): the file itself is refused, or the
  // service is missing or busy, or the signed copy of an upload did not read as the file did.
  NOT_A_PDF: 422,
  PDF_UNREADABLE: 422,
  PDF_TOO_LARGE: 422,
  PDF_ENCRYPTED: 422,
  PDF_ACTIVE_CONTENT: 422,
  PDF_VARIES_BY_VIEWER: 422,
  PDF_INFECTED: 422,
  NOT_READABLE: 404,
  // A passage read: a section number that is not one, or one the signed text does not hold.
  INVALID_SECTION: 400,
  SECTION_NOT_FOUND: 404,
  PDF_RENDER_UNAVAILABLE: 503,
  PDF_RENDER_BUSY: 429,
  COPY_DIFFERS: 409,
  // A change request's reply states its own hours or amount; the figures line comes from the card.
  REPLY_STATES_FIGURES: 422,
  // The legal layout refuses the text itself: a reference to nothing or to a hidden clause, a
  // typed number of one of its own articles, a clause starting with a number, a character no
  // face draws.
  BROKEN_REFERENCE: 409,
  TYPED_REFERENCE: 409,
  NUMBERED_CLAUSE: 409,
  CHARACTER_NOT_DRAWABLE: 422,
  ALREADY_SENT: 409,
  NOT_FROZEN: 409,
  NOT_SENT: 409,
  SIGNER_HAS_NO_EMAIL: 409,
  NOT_THE_CONTACTS_ADDRESS: 409,
  TARGET_SENT_BY_ITS_APP: 409,
  // A quote's outcome: set once, on a quote only.
  OUTCOME_ALREADY_SET: 409,
  NOT_A_QUOTE: 409,
  // An imported agreement is filed from its PDF, with its dates as days.
  FILE_REQUIRED: 400,
  INVALID_DATE: 400,
  SIGNERS_REQUIRED: 400,
  TOO_MANY_SIGNERS: 400,
  INVALID_SIGNER: 400,
  INVALID_SIGNERS: 400,
  INVALID_MODE: 400,
  INVALID_ORDER: 400,
  INVALID_EXPIRY: 400,
  REASON_REQUIRED: 400,
  TARGET_NOT_REGISTERED: 400,
  KIND_NOT_ALLOWED: 400,
  EMAIL_REQUIRED: 400,
  MINT_NEEDS_A_PERSON: 403,
  REVOKE_NEEDS_A_PERSON: 403,
  // A change request: only on a signed agreement that is not itself one, with its work, hours
  // and their source, rate, reply and client mail, quoting the parent's signed text; a reply
  // that did not leave withdraws the approval link.
  PARENT_NOT_SIGNED: 409,
  PARENT_IS_A_CHANGE_REQUEST: 409,
  PASSAGE_NOT_SIGNED_TEXT: 409,
  NO_CLIENT_CONTACT: 409,
  WORK_REQUIRED: 400,
  HOURS_REQUIRED: 400,
  HOURS_SOURCE_REQUIRED: 400,
  RATE_REQUIRED: 400,
  REPLY_REQUIRED: 400,
  MAIL_REQUIRED: 400,
  REPLY_NOT_SENT: 502,
  FREEZE_FAILED: 409,
  // A signed agreement's evidence: not signed or not sealed yet, a frozen file that no longer
  // matches its fingerprint (never sealed, never repaired), a name no font can draw.
  NOT_SIGNED: 409,
  SENDER_CALL_UNAVAILABLE: 409,
  NOT_SEALED: 409,
  DOCUMENT_CHANGED: 409,
  NOT_THIS_VERSION_FILE: 409,
  EVIDENCE_INCONSISTENT: 409,
  SIGNATURE_NAME_NOT_DRAWABLE: 422,
  // A verify asked with neither an agreement id nor a version id.
  INVALID_PARAMS: 400,
  MERGE_FAILED: 503,
  // What this server offers: signatures off on the hosted edition, no timestamp authority set up,
  // no renderer or link door on this build. The operator can change these, the caller cannot.
  SIGNING_NOT_AVAILABLE: 422,
  TIMESTAMP_NOT_CONFIGURED: 422,
  FREEZE_NOT_AVAILABLE: 422,
  LINKS_NOT_AVAILABLE: 422,
  NOT_AVAILABLE: 422,
  // The host offers no call made as the sender (an older host): the change request waits.
  UNAVAILABLE: 422,
  // A send's pinned mail check, held again when the approved send goes: the card no longer
  // matches, or the address stopped taking mail since the card (a reply, a bounce, an opt-out).
  // A new link for one signer: they already answered, declined after proving the code, or
  // still wait for the signer before them.
  ALREADY_DECIDED: 409,
  DECLINED_BY_SIGNER: 409,
  NOT_THEIR_TURN: 409,
  // A send whose links could not be written (asking again asks nobody twice), and a save or a
  // void that waits for an answer not recorded yet.
  SEND_NOT_CONFIRMED: 409,
  ANSWER_BEING_RECORDED: 409,
  // Another person in a withdrawn signer's place: a signer who was not withdrawn, more than one
  // person named, someone who already holds a link, or a place already taken.
  SIGNER_NOT_WITHDRAWN: 409,
  ONE_SIGNER_IN_PLACE: 400,
  HOLDS_A_LINK: 409,
  ALREADY_REPLACED: 409,
  // The client's mail is already answered by a change request, or this one was closed meanwhile.
  CHANGE_REQUEST_ALREADY_SENT: 409,
  CHANGE_REQUEST_CLOSED: 409,
  // mail: the run may read no mailbox, so it can send from none.
  MISSING_SCOPE: 403,
  REMIND_FAILED: 409,
  NEW_LINK_FAILED: 409,
  SEND_GUARD_MISMATCH: 409,
  SEND_GUARD_REPLIED: 409,
  SEND_GUARD_BOUNCED: 409,
  SEND_GUARD_OPTED_OUT: 409,
  SEND_GUARD_HELD: 409,
  SEND_GUARD_REF_STOP: 409,
  SEND_GUARD_UNAVAILABLE: 503,
  // The client portal's staff side (modules/portal/access.ts): who may be invited, what a
  // share may point at, a company whose access ended, the hour's invitation budget.
  NO_MAIL_ON_DEMO: 403,
  PORTAL_EMAIL_IN_USE: 409,
  PORTAL_EMAIL_IS_STAFF: 409,
  CONTACT_NOT_THIS_COMPANY: 409,
  PORTAL_ACCESS_ENDED: 409,
  PORTAL_INVITE_LIMIT: 429,
  SHARE_NOT_THIS_COMPANY: 409,
  SHARE_OBJECT_REQUIRED: 422,
  PORTAL_SETTINGS_INVALID: 422,
  ERASE_FAILED: 500,
  // Client reports (apps/projects/service/client-reports.ts): a section of a share that is
  // closed, a report already sent or no longer a draft, a recipient without an address, a
  // project with no client company.
  SHARE_CLOSED: 409,
  REPORT_SENT: 409,
  REPORT_NOT_DRAFT: 409,
  NO_RECIPIENT: 422,
  no_client_company: 422,
}
