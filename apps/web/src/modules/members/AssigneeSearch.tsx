// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The search field and the status line shared by the assignee pickers (a
// ticket's header menu and phone assign sheet, a project task's assignee
// chip). Each reads a `createAssignableMembers` state; only the rows differ per
// container. `testIdPrefix` keeps each surface's test ids its own.
import { type Component, Match, Show, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { AssignableMembersStatus } from "~/modules/members/assignable-members"

export const AssigneeSearchField: Component<{
  testIdPrefix: string
  value: string
  onInput: (value: string) => void
  class?: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <input
      type="search"
      autocomplete="off"
      data-testid={`${props.testIdPrefix}-search`}
      aria-label={i18n.t("kernel.common.assigneeSearchPlaceholder")}
      placeholder={i18n.t("kernel.common.assigneeSearchPlaceholder")}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      // Inside a menu, letters typed here must not drive the menu's typeahead
      // or its arrow-key focus: only Escape and Tab reach the menu.
      onKeyDown={(e) => {
        if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation()
      }}
      class={
        props.class ??
        "w-full rounded-sm border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-accent-border"
      }
    />
  )
}

export const AssigneeListStatus: Component<{
  testIdPrefix: string
  status: AssignableMembersStatus
  shown: number
  total: number
  onRetry: () => void
  class?: string
}> = (props) => {
  const i18n = useI18n()
  const lineClass = () => props.class ?? "px-2 py-1 text-[12px] text-text-tertiary"
  return (
    <Switch>
      <Match when={props.status === "error"}>
        <div class={lineClass()} role="alert" data-testid={`${props.testIdPrefix}-error`}>
          <span class="text-red-400">{i18n.t("kernel.common.assigneeLoadFailed")}</span>{" "}
          <button
            type="button"
            class="underline hover:text-text"
            data-testid={`${props.testIdPrefix}-retry`}
            onClick={() => props.onRetry()}
          >
            {i18n.t("kernel.common.assigneeRetry")}
          </button>
        </div>
      </Match>
      <Match when={props.status === "loading" && props.shown === 0}>
        <div class={lineClass()} data-testid={`${props.testIdPrefix}-loading`}>
          {i18n.t("kernel.common.assigneeLoading")}
        </div>
      </Match>
      <Match when={props.status === "ready" && props.shown === 0}>
        <div class={lineClass()} data-testid={`${props.testIdPrefix}-empty`}>
          {i18n.t("kernel.common.assigneeNoMatch")}
        </div>
      </Match>
      <Match when={props.status === "ready"}>
        <Show when={props.total > props.shown}>
          <div class={lineClass()} data-testid={`${props.testIdPrefix}-more`}>
            {i18n.t("kernel.common.assigneeMore", { count: props.total - props.shown })}
          </div>
        </Show>
      </Match>
    </Switch>
  )
}
