// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { createBillingState, isManagedAvailable } from "~/modules/settings/BillingState"
import { useApi } from "~/modules/shell/ApiContext"
import { Skeleton } from "~/ui/Skeleton"

const PORTAL_BTN_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-sm border border-border bg-transparent px-4 py-2 text-[13.5px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"

const CHECKOUT_BTN_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-sm bg-accent px-4 py-2 text-[13.5px] font-semibold text-bg transition-colors hover:bg-accent-hover"

const TIER_LABELS: Record<string, string> = {
  starter: "Starter",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
}

const PlanSettings: Component = () => {
  const api = useApi()
  const { t } = useI18n()
  const [billing] = createBillingState(api)

  return (
    <div data-testid="plan-settings" class="flex flex-col gap-6">
      <h1 class="text-lg font-semibold text-text">{t("kernel.usage.plan")}</h1>
      <Show when={billing()} fallback={<Skeleton class="h-32 w-full" />}>
        {(bs) => (
          <Show
            when={isManagedAvailable(bs())}
            fallback={
              <div
                data-testid="plan-unavailable"
                class="rounded-md border border-border p-4 text-sm text-text-secondary"
              >
                {t("kernel.usage.planUnavailable")}
              </div>
            }
          >
            {(_) => {
              const managed = bs() as Extract<
                ReturnType<typeof billing>,
                { mode: "managed"; tier: string }
              >
              return (
                <div data-testid="plan-card" class="rounded-md border border-border p-5">
                  <Show when={managed.stale}>
                    <div
                      data-testid="billing-stale-banner"
                      class="mb-3 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
                    >
                      {t("kernel.settingsUi.billingStateMayBeOutdatedShowing")}
                    </div>
                  </Show>
                  <p class="text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {t("kernel.usage.currentTier")}
                  </p>
                  <p class="mt-1 text-2xl font-semibold text-text">
                    {TIER_LABELS[managed.tier] ?? managed.tier}
                  </p>
                  <p class="mt-2 text-sm text-text-secondary">
                    {t("kernel.usage.status")}: <span class="text-text">{managed.status}</span>
                  </p>
                  <Show when={managed.periodEnd}>
                    <p class="mt-1 text-xs text-text-tertiary">
                      {t("kernel.usage.periodEnd", { date: managed.periodEnd })}
                    </p>
                  </Show>
                  <div class="mt-4 flex gap-2">
                    <Show when={managed.billingPortalUrl}>
                      <a
                        data-testid="plan-billing-portal-link"
                        href={managed.billingPortalUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        class={PORTAL_BTN_CLASS}
                      >
                        {t("kernel.usage.openBillingPortal")}
                      </a>
                    </Show>
                    <Show when={managed.checkoutUrl}>
                      <a
                        data-testid="plan-checkout-link"
                        href={managed.checkoutUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        class={CHECKOUT_BTN_CLASS}
                      >
                        {t("kernel.usage.addCredits")}
                      </a>
                    </Show>
                  </div>
                </div>
              )
            }}
          </Show>
        )}
      </Show>
    </div>
  )
}

export default PlanSettings
