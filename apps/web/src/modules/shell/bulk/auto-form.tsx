// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, For, Show } from "solid-js"
import type { BulkFieldSpec } from "~/framework/app-registry"

interface AutoFormProps {
  fields: string[]
  specs?: Record<string, BulkFieldSpec>
  values: Record<string, unknown>
  onChange: (field: string, value: string) => void
}

// "closedReason" -> "Closed reason", "no_response" -> "No response".
function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Shared-fields renderer for the bulk-action toolbar. Renders a <select> for any
 * field whose underlying tool param is an enum (e.g. a ticket's closedReason),
 * and a text input for everything else.
 */
export const AutoForm: Component<AutoFormProps> = (props) => {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.fields}>
        {(field) => {
          const id = `bulk-field-${field}`
          const spec = (): BulkFieldSpec | undefined => props.specs?.[field]
          const options = (): string[] | undefined => {
            const e = spec()?.enum
            return e && e.length > 0 ? e : undefined
          }
          return (
            <label for={id} class="flex flex-col gap-1 text-xs text-text-secondary">
              <span>{spec()?.label ?? humanize(field)}</span>
              <Show
                when={options()}
                fallback={
                  <input
                    id={id}
                    type="text"
                    class="rounded border border-border bg-surface px-2 py-1 text-sm text-text"
                    data-testid={id}
                    value={(props.values[field] as string) ?? ""}
                    onInput={(e) => props.onChange(field, e.currentTarget.value)}
                  />
                }
              >
                {(opts) => (
                  <select
                    id={id}
                    class="rounded border border-border bg-surface px-2 py-1 text-sm text-text"
                    data-testid={id}
                    value={(props.values[field] as string) ?? ""}
                    onChange={(e) => props.onChange(field, e.currentTarget.value)}
                  >
                    <For each={opts()}>{(opt) => <option value={opt}>{humanize(opt)}</option>}</For>
                  </select>
                )}
              </Show>
            </label>
          )
        }}
      </For>
    </div>
  )
}
