// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A turn refused because the org's renewal is unpaid (managed edition):
// the server answers 402 `payment_required`. Said in the reader's language with
// a link to Billing, where an admin pays the open invoice.
import { OUT_OF_CREDITS_CODE, PAYMENT_REQUIRED_CODE } from "@liaison/shared"
import type { Component } from "solid-js"
import { spaNavigate } from "~/framework/spa-navigate"
import { useI18n } from "~/modules/i18n/i18n-context"

/** The Billing page (framework/bootstrap.ts, settings section `billing`). */
export const BILLING_PATH = "/settings/billing"

/** Is this refusal the unpaid renewal? */
export function isPaymentRequired(code: string | undefined | null): boolean {
  return code === PAYMENT_REQUIRED_CODE
}

/** The billing code of a refused turn's row, when Billing is the way out. */
export function billingRefusalOf(metadata: { billingRefusal?: unknown } | null | undefined) {
  const code = metadata?.billingRefusal
  return code === PAYMENT_REQUIRED_CODE || code === OUT_OF_CREDITS_CODE ? code : null
}

export const PaymentRequiredNotice: Component<{ outOfCredits?: boolean }> = (props) => {
  const { t } = useI18n()
  return (
    <span data-testid="payment-required-notice">
      {props.outOfCredits
        ? t("cloud-limits.billing.outOfCredits")
        : t("cloud-limits.billing.paymentRequired")}{" "}
      <a
        href={BILLING_PATH}
        data-testid="payment-required-billing-link"
        class="underline"
        onClick={(e) => {
          e.preventDefault()
          spaNavigate(BILLING_PATH)
        }}
      >
        {t("cloud-limits.billing.openBilling")}
      </a>
    </span>
  )
}
