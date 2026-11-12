// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The incident's `INC-<n>` ref as a small mono tag, shared by the incident row, the status
// table and the detail badge row. Renders nothing while the incident is not numbered yet.
import { type Component, Show } from "solid-js"
import { cx } from "./kit"

export const RefTag: Component<{ value?: string | null; testid: string; prominent?: boolean }> = (
  props,
) => (
  <Show when={props.value}>
    <span
      class={cx(
        "shrink-0 font-mono",
        // The detail page shows it a step larger and selectable (people copy it into messages).
        props.prominent
          ? "select-all text-[11.5px] text-text-secondary"
          : "text-[11px] text-text-tertiary",
      )}
      data-testid={props.testid}
    >
      {props.value}
    </span>
  </Show>
)
