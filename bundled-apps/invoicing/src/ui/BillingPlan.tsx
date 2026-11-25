// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's billing plan (/invoicing/billing-plan/:projectId): the steps its quote is invoiced
// in, each with its amount and what became of it. A milestone whose task is not done yet shows
// that nothing is drafted; one that is done waits for a person to draft it; a drafted or issued
// step opens its invoice. The amounts come from the plan, never from hours. Calm: one quiet list.

import { app, navigate } from "@liaison/host"
import { type Component, createResource, For, Show } from "solid-js"
import { MoneyFirstChoices } from "./AdvanceLedger"
import { tr } from "./i18n"
import { Button, formatMoneyMinor } from "./kit"

export interface PlanStep {
  id: string
  kind: string
  label: string
  amountMinor: number
  currency: string
  state: string
  taskDone?: boolean | null
  document: { id: string; number: string | null; status: string } | null
}

export interface PlanView {
  status?: string
  title?: string
  quote?: { id: string; number: string | null } | null
  steps?: PlanStep[]
}

/** The state a step is shown in. */
export type ShownState =
  | "not-done-yet"
  | "ready"
  | "not-invoiced"
  | "drafted"
  | "issued"
  | "paid"
  | "cancelled"

export function shownState(step: PlanStep): ShownState {
  if (step.state === "cancelled") return "cancelled"
  if (step.state === "paid") return "paid"
  if (step.state === "issued") return "issued"
  if (step.state === "drafted") return "drafted"
  if (step.kind === "advance") return "not-invoiced"
  return step.taskDone === true ? "ready" : "not-done-yet"
}

function stateText(step: PlanStep): string {
  const number = step.document?.number ?? ""
  switch (shownState(step)) {
    case "not-done-yet":
      return tr("Not done yet, nothing drafted")
    case "ready":
      return tr("Done, ready to draft")
    case "not-invoiced":
      return tr("Not invoiced yet")
    case "drafted":
      return tr("Drafted, no number yet")
    case "issued":
      return tr("Issued, {{number}}", { number })
    case "paid":
      return tr("Paid, {{number}}", { number })
    case "cancelled":
      return tr("Cancelled")
  }
}

function kindText(kind: string): string {
  if (kind === "advance") return tr("Advance")
  if (kind === "final") return tr("Final")
  return tr("Milestone")
}

export const InvoicingBillingPlan: Component<{ entityId?: string }> = (props) => {
  const [plan] = createResource(
    () => props.entityId,
    async (projectId) =>
      (await app.invokeTool<PlanView>("billing_plan_get", { projectId })) ?? { steps: [] },
  )
  const steps = () => plan()?.steps ?? []
  return (
    <div data-testid="invoicing-billing-plan" class="flex flex-col gap-3 p-5">
      <h1 class="text-[15px] font-semibold text-text">{tr("Billing plan")}</h1>
      <p class="text-[12.5px] text-text-secondary">
        {tr("The amount comes from the billing plan. Hours do not move it.")}
      </p>
      <Show
        when={steps().length > 0}
        fallback={
          <div data-testid="billing-plan-empty" class="text-[12.5px] text-text-tertiary">
            {plan.loading ? "" : tr("This project has no billing plan.")}
          </div>
        }
      >
        <ul class="flex flex-col gap-2">
          <For each={steps()}>
            {(step) => (
              <li
                data-testid={`billing-step-${step.id}`}
                data-state={shownState(step)}
                class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
              >
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-text">
                    {kindText(step.kind)}: {step.label}
                  </span>
                  <span
                    data-testid={`billing-step-state-${step.id}`}
                    class="text-[11.5px] text-text-tertiary"
                  >
                    {stateText(step)}
                  </span>
                  <Show when={shownState(step) === "not-invoiced" && props.entityId}>
                    {(projectId) => <MoneyFirstChoices projectId={projectId()} stepId={step.id} />}
                  </Show>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-text">
                    {formatMoneyMinor(BigInt(step.amountMinor), step.currency)} {step.currency}
                  </span>
                  <Show when={step.document}>
                    {(doc) => (
                      <Button
                        testid={`billing-step-open-${step.id}`}
                        onClick={() => navigate(`/invoicing/document/${doc().id}`)}
                      >
                        {tr("Open")}
                      </Button>
                    )}
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
