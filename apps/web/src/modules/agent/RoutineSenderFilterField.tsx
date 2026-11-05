// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import type { RoutineEventFilter } from "./routines-store"

/** The only trigger a sender filter applies to (S26). */
export const SENDER_FILTER_EVENT = "mail:message:create"

interface RoutineSenderFilterFieldProps {
  value: RoutineEventFilter | null
  onChange: (v: RoutineEventFilter | null) => void
  /** Prefix of the field's test ids ("routine" or "routine-edit"). */
  testIdPrefix: string
}

/** Drop empty lists; an empty filter is null (every new mail). */
export function normalizeSenderFilter(f: RoutineEventFilter | null): RoutineEventFilter | null {
  const contacts = f?.fromContactIds ?? []
  const groupIds = f?.fromGroupIds ?? []
  if (contacts.length === 0 && groupIds.length === 0) return null
  return {
    ...(contacts.length > 0 ? { fromContactIds: contacts } : {}),
    ...(groupIds.length > 0 ? { fromGroupIds: groupIds } : {}),
  }
}

/**
 * "Only from" for a new-mail routine (S26): the contact groups whose members'
 * mail starts the routine. Contacts chosen through the agent tools show as a
 * count that can be cleared. Mail from anyone else never starts it, and costs
 * no tokens: the server checks the sender before the agent runs.
 */
export default function RoutineSenderFilterField(props: RoutineSenderFilterFieldProps) {
  const i18n = useI18n()
  const api = useApi()
  // Read here rather than through the contacts store: the routine forms must not
  // pull the contacts module (and its session lifecycle) into every agent page.
  const [groups, setGroups] = createSignal<Array<{ id: string; name: string }>>([])
  onMount(() => {
    ;(api as unknown as { get: <T>(p: string) => Promise<T | { data: T }> })
      .get<Array<{ id: string; name: string }>>("/contacts/groups")
      .then((r) => {
        const list = r && typeof r === "object" && "data" in r ? r.data : r
        setGroups(Array.isArray(list) ? list.map((g) => ({ id: g.id, name: g.name })) : [])
      })
      .catch(() => {
        // No groups listed: the field still shows any chosen contacts.
      })
  })
  const selectedGroups = () => new Set(props.value?.fromGroupIds ?? [])
  const contactCount = () => props.value?.fromContactIds?.length ?? 0

  function toggleGroup(id: string, on: boolean) {
    const next = new Set(selectedGroups())
    if (on) next.add(id)
    else next.delete(id)
    props.onChange(
      normalizeSenderFilter({
        fromContactIds: props.value?.fromContactIds ?? [],
        fromGroupIds: [...next],
      }),
    )
  }

  return (
    <div class="flex flex-col gap-1.5" data-testid={`${props.testIdPrefix}-sender-filter`}>
      <span class="text-[12px] text-text-tertiary">{i18n.t("kernel.agentForms.senderFilter")}</span>
      <Show
        when={groups().length > 0}
        fallback={
          <span class="text-[12px] text-text-tertiary">
            {i18n.t("kernel.agentForms.senderFilterNoGroups")}
          </span>
        }
      >
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <For each={groups()}>
            {(g) => (
              <label class="flex items-center gap-1.5 text-[13px] text-text">
                <input
                  type="checkbox"
                  data-testid={`${props.testIdPrefix}-sender-group-${g.id}`}
                  checked={selectedGroups().has(g.id)}
                  onChange={(e) => toggleGroup(g.id, e.currentTarget.checked)}
                />
                {g.name}
              </label>
            )}
          </For>
        </div>
      </Show>
      <Show when={contactCount() > 0}>
        <div class="flex items-center gap-2 text-[12px] text-text">
          <span>{i18n.t("kernel.agentForms.senderFilterContacts", { n: contactCount() })}</span>
          <button
            type="button"
            class="text-accent hover:underline"
            data-testid={`${props.testIdPrefix}-sender-clear-contacts`}
            onClick={() =>
              props.onChange(
                normalizeSenderFilter({ fromGroupIds: props.value?.fromGroupIds ?? [] }),
              )
            }
          >
            {i18n.t("kernel.agentForms.senderFilterClearContacts")}
          </button>
        </div>
      </Show>
      <span class="text-[11px] text-text-tertiary">
        {i18n.t("kernel.agentForms.senderFilterHint")}
      </span>
    </div>
  )
}
