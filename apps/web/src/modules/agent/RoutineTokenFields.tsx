// SPDX-License-Identifier: FSL-1.1-ALv2
import { useI18n } from "~/modules/i18n/i18n-context"

/**
 * A token field's text as the request sends it: null when empty (no budget /
 * no limit), the whole number when valid, "invalid" otherwise.
 */
export function parseTokenField(text: string): number | null | "invalid" {
  const t = text.trim()
  if (!t) return null
  if (!/^\d+$/.test(t)) return "invalid"
  const n = Number(t)
  return Number.isSafeInteger(n) && n > 0 ? n : "invalid"
}

interface RoutineTokenFieldsProps {
  budget: string
  limit: string
  onBudget: (v: string) => void
  onLimit: (v: string) => void
  /** Prefix for the inputs' test ids ("routine" or "routine-edit"). */
  testIdPrefix: string
}

/**
 * The routine's token budget (told to the agent in each run's prompt) and hard
 * token limit (the run stops once it has used that many tokens), S17. Empty =
 * none. Shared by the create form and the detail page's edit form.
 */
export default function RoutineTokenFields(props: RoutineTokenFieldsProps) {
  const i18n = useI18n()
  const inputClass =
    "rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
  return (
    <div class="flex flex-col gap-3 sm:flex-row">
      <label class="flex flex-1 flex-col gap-1.5 text-[12px] text-text-tertiary">
        {i18n.t("kernel.agentForms.tokenBudget")}
        <input
          data-testid={`${props.testIdPrefix}-token-budget`}
          type="text"
          inputmode="numeric"
          class={inputClass}
          value={props.budget}
          onInput={(e) => props.onBudget(e.currentTarget.value)}
        />
        <span class="text-[11px]">{i18n.t("kernel.agentForms.tokenBudgetHint")}</span>
      </label>
      <label class="flex flex-1 flex-col gap-1.5 text-[12px] text-text-tertiary">
        {i18n.t("kernel.agentForms.hardTokenLimit")}
        <input
          data-testid={`${props.testIdPrefix}-hard-token-limit`}
          type="text"
          inputmode="numeric"
          class={inputClass}
          value={props.limit}
          onInput={(e) => props.onLimit(e.currentTarget.value)}
        />
        <span class="text-[11px]">{i18n.t("kernel.agentForms.hardTokenLimitHint")}</span>
      </label>
    </div>
  )
}
