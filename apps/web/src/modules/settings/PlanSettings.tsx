// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { createBillingState, isManagedAvailable } from "~/modules/settings/BillingState"
import { useApi } from "~/modules/shell/ApiContext"
import { Skeleton } from "~/ui/Skeleton"

// The plan's name as sold and as Billing shows it, never the internal tier behind it.
const PLAN_LABELS: Record<string, string> = { preview: "Preview", base: "Base", pro: "Pro" }

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
                  <p class="text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {t("kernel.usage.currentTier")}
                  </p>
                  <p class="mt-1 text-2xl font-semibold text-text">
                    {PLAN_LABELS[managed.plan] ?? managed.plan}
                  </p>
                  <p class="mt-2 text-sm text-text-secondary">
                    {t("kernel.usage.status")}: <span class="text-text">{managed.status}</span>
                  </p>
                  <p class="mt-3 text-sm">
                    <a href="/settings/billing" class="underline" data-testid="plan-open-billing">
                      {t("cloud-limits.billing.openBilling")}
                    </a>
                  </p>
                  <Show when={managed.periodEnd}>
                    <p class="mt-1 text-xs text-text-tertiary">
                      {t("kernel.usage.periodEnd", {
                        date: new Date(managed.periodEnd).toLocaleDateString(undefined, {
                          dateStyle: "long",
                        }),
                      })}
                    </p>
                  </Show>
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
