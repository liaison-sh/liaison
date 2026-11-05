// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ATELIER STEPPER (P2-T14; S35, S36). A session that runs an Atelier
// pipeline shows its phases in the header (web and phone): `plan[]` as steps
// (and `phase` after them when the plan does not name it), those in `done[]`
// ticked, `phase` current (every step ticked once the
// pipeline is complete), then what it waits for or how it ended ("Waiting for
// you" when `awaiting` is the user, Complete, Failed with its reason), then
// its boards. The state is header-info.ts `atelier`: the row's, or the latest
// `atelier` event on an older API. Board links are https only, re-checked
// there, and open outside the app (`target="_blank"`, no opener, no
// referrer). No state, no stepper.

import type { NodeSessionAtelierState, NodeSessionEvent } from "@liaison/shared"
import { Check, SquareArrowOutUpRight } from "lucide-solid"
import { createMemo, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { atelier } from "./header-info"
import type { NodeSessionRow } from "./session-api"

type StepState = "done" | "current" | "pending"

/**
 * The steps shown: `plan[]`, then the current phase when the plan does not
 * name it (a phase Atelier added, or one the node's step clip dropped), so
 * the current step is always on screen (batch-2 F10).
 */
function shownSteps(s: NodeSessionAtelierState): string[] {
  return s.phase && !s.plan.includes(s.phase) ? [...s.plan, s.phase] : s.plan
}

function stepState(s: NodeSessionAtelierState, step: string): StepState {
  if (s.status === "complete" || s.done.includes(step)) return "done"
  return step === s.phase ? "current" : "pending"
}

export function AtelierStepper(props: {
  session: Pick<NodeSessionRow, "atelier">
  events: readonly NodeSessionEvent[]
}) {
  const t = useI18n().t
  const state = createMemo(() => atelier(props.session, props.events))
  const statusText = (s: NodeSessionAtelierState): string | null => {
    if (s.status === "complete") return t("kernel.nodeSessions.atelier.complete")
    if (s.status === "failed") {
      return s.failureReason
        ? t("kernel.nodeSessions.atelier.failedWithReason", { reason: s.failureReason })
        : t("kernel.nodeSessions.atelier.failed")
    }
    return s.awaiting === "user" ? t("kernel.nodeSessions.atelier.waitingForYou") : null
  }
  const tone = (s: NodeSessionAtelierState) =>
    s.status === "complete" ? "text-success" : s.status === "failed" ? "text-error" : "text-warning"

  return (
    <Show when={state()}>
      {(s) => (
        <nav
          data-testid="atelier-stepper"
          aria-label={t("kernel.nodeSessions.atelier.steps")}
          class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
        >
          <ol class="flex min-w-0 flex-wrap items-center gap-1">
            <For each={shownSteps(s())}>
              {(step, i) => {
                const st = () => stepState(s(), step)
                return (
                  <li
                    data-testid="atelier-step"
                    data-state={st()}
                    aria-current={st() === "current" ? "step" : undefined}
                    class="inline-flex min-w-0 items-center gap-1"
                    classList={{
                      // The separator is drawn, not text: a step reads as its name alone.
                      "before:text-text-tertiary before:content-['›']": i() > 0,
                      "text-text-secondary": st() === "done",
                      "font-medium text-accent": st() === "current",
                      "text-text-tertiary": st() === "pending",
                    }}
                  >
                    <Show when={st() === "done"}>
                      <span data-testid="atelier-step-tick" class="inline-flex shrink-0">
                        <Check class="h-3 w-3 text-success" aria-hidden="true" />
                      </span>
                    </Show>
                    <span class="min-w-0 truncate">{step}</span>
                  </li>
                )
              }}
            </For>
          </ol>
          <Show when={statusText(s())}>
            {(text) => (
              <span data-testid="atelier-status" class={`min-w-0 truncate ${tone(s())}`}>
                {text()}
              </span>
            )}
          </Show>
          <For each={s().boards ?? []}>
            {(board) => (
              <a
                href={board.url}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex min-w-0 items-center gap-1 text-accent hover:underline"
              >
                <SquareArrowOutUpRight class="h-3 w-3 shrink-0" aria-hidden="true" />
                <span class="min-w-0 truncate">{board.title}</span>
              </a>
            )}
          </For>
        </nav>
      )}
    </Show>
  )
}
