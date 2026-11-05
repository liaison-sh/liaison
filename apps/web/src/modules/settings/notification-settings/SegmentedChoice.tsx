// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The segmented radio group of Settings -> Notifications (the email digest
// cadence, the approval reminder frequency): one row of equal options, two per
// row on a phone, the chosen one lit with the accent.

import { For } from "solid-js"

interface SegmentedChoiceProps<T extends string> {
  name: string
  options: readonly T[]
  value: T
  label: string
  /** The group's test id; each option is `<testId>-<value>`. */
  testId: string
  optionLabel: (value: T) => string
  onChange: (value: T) => void
  /** Three options in one row (the kind modes); default two, then four. */
  threeColumns?: boolean
}

export function SegmentedChoice<T extends string>(props: SegmentedChoiceProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      data-testid={props.testId}
      class="grid gap-1 rounded-md border border-border bg-bg p-1"
      classList={{
        "grid-cols-3": props.threeColumns === true,
        "grid-cols-2 sm:grid-cols-4": props.threeColumns !== true,
      }}
    >
      <For each={props.options}>
        {(value) => (
          <label
            data-testid={`${props.testId}-${value}`}
            class="relative flex min-h-11 cursor-pointer items-center justify-center rounded-sm px-2 py-2 text-center text-[12.5px] font-medium transition-colors duration-150 lg:min-h-0"
            classList={{
              "bg-accent-glow text-text shadow-[inset_0_0_0_1px_var(--color-accent-border)]":
                props.value === value,
              "text-text-tertiary hover:text-text-secondary": props.value !== value,
            }}
          >
            <input
              type="radio"
              name={props.name}
              value={value}
              checked={props.value === value}
              onChange={() => props.onChange(value)}
              class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            {props.optionLabel(value)}
          </label>
        )}
      </For>
    </div>
  )
}
