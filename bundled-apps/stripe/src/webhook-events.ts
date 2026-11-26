// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The event types an admin selects on the Stripe webhook endpoint: exactly the ones the event
// handler acts on (dispatch.ts `HANDLED`; webhook-setup.test.ts holds the two equal). A plain list,
// so the settings page's bundle does not carry the handler.
export const WEBHOOK_EVENTS: readonly string[] = [
  "charge.dispute.closed",
  "charge.dispute.created",
  "charge.dispute.funds_reinstated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.updated",
  "charge.failed",
  "charge.refund.updated",
  "charge.refunded",
  "charge.succeeded",
  "charge.updated",
  "customer.created",
  "customer.deleted",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "customer.subscription.updated",
  "customer.updated",
  "invoice.finalization_failed",
  "invoice.finalized",
  "invoice.marked_uncollectible",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.updated",
  "invoice.voided",
]
