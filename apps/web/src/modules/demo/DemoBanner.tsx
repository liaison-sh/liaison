// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One quiet line, always there, saying what this is.
//
// EVERY TIER, unlike the offline banner: a visitor on a demo box has to be able
// to tell at any moment that nothing they are looking at is real, and a desktop
// browser's chrome does not say that for us.
//
// THE ONE CLAIM IT MAKES IS GROUNDED. The expiry is the one the SERVER gave us
// (`expiresAt` on the signup response and on every status read), never a
// duration this file assumes. A session with no local workspace record is the
// reserved App Review account, which carries no expiry and needs no second
// clause, so the banner names the instance and stops there. Wrong claims here
// are worse than no claims.
import { type Component, createSignal, Show } from "solid-js"
import { DemoLimitsPanel } from "~/modules/demo/DemoLimitsPanel"
import { DemoNextStepsBannerEntry } from "~/modules/demo/DemoNextSteps"
import { ScenariosBannerEntry } from "~/modules/demo/DemoWelcome"
import { demoWorkspace, openDemoNextSteps } from "~/modules/demo/demo-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { demoOrgSurfaces } from "~/modules/shell/branding-store"

export const DemoBanner: Component = () => {
  const i18n = useI18n()
  const [limitsOpen, setLimitsOpen] = createSignal(false)

  const expiresAt = () => {
    const raw = demoWorkspace()?.expiresAt
    if (!raw) return null
    const at = Date.parse(raw)
    return Number.isFinite(at) ? at : null
  }

  return (
    <Show when={demoOrgSurfaces()}>
      <div
        data-testid="demo-banner"
        // `status`, not `alert`: a standing condition, announced without
        // interrupting whatever a screen reader was reading.
        role="status"
        class="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-border-subtle bg-surface-active px-3 py-1.5 text-center text-[12px] leading-snug text-text-secondary"
      >
        <span class="font-medium text-text">{i18n.t("kernel.demo.bannerLabel")}</span>
        <Show when={expiresAt()}>
          {(at) => (
            <span data-testid="demo-banner-expiry">
              {i18n.t("kernel.demo.bannerExpires", {
                when: i18n.fmtDate(at(), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </span>
          )}
        </Show>
        {/* Brings the welcome popup back (its step 1 holds the code and the key form). */}
        <ScenariosBannerEntry />
        {/* The next-steps dialog, always one click away (it also opens by
            itself on the first refusal that says the budget is spent). */}
        <Show when={demoWorkspace()}>
          <button
            type="button"
            data-testid="demo-budget-open"
            onClick={() => openDemoNextSteps("budget")}
            class="underline underline-offset-2 hover:text-text"
          >
            {i18n.t("kernel.demo.bannerBudgetLink")}
          </button>
        </Show>
        <button
          type="button"
          data-testid="demo-limits-open"
          onClick={() => setLimitsOpen(true)}
          class="underline underline-offset-2 hover:text-text"
        >
          {i18n.t("kernel.demo.bannerLimitsLink")}
        </button>
        {/* What to do next, at any moment: run it yourself or have it set up. */}
        <DemoNextStepsBannerEntry />
      </div>
      <DemoLimitsPanel open={limitsOpen()} onClose={() => setLimitsOpen(false)} />
    </Show>
  )
}
