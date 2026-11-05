// SPDX-License-Identifier: FSL-1.1-ALv2
import { X } from "lucide-solid"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { scopeIdTitle, scopeLabel } from "~/lib/capability-copy"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

/** One scope the editor may put on a routine (GET /agent/routines/scope-options). */
export interface RoutineScopeOption {
  scope: string
  app: string
  description?: string
}

interface RoutineScopesFieldProps {
  value: string[]
  onChange: (next: string[]) => void
}

/** Rows offered at once: the search narrows the rest. */
const MAX_OFFERED = 8

/**
 * A ROUTINE'S SCOPES, PICKED BY ITS OWNER (D20). A routine runs with exactly
 * the scopes set here: nothing is guessed from its prompt any more. The
 * current scopes read as words (the identifier stays in the title, charter
 * agent.md); the editor can remove any and add the ones they hold, which is
 * what the server offers and the only thing it accepts as new.
 */
export default function RoutineScopesField(props: RoutineScopesFieldProps) {
  const api = useApi()
  const i18n = useI18n()
  const [query, setQuery] = createSignal("")

  const [options] = createResource(async () => {
    try {
      const res = (await api.get("/agent/routines/scope-options")) as unknown
      const rows = Array.isArray(res) ? res : (res as { data?: unknown })?.data
      return Array.isArray(rows)
        ? (rows as RoutineScopeOption[]).filter((o) => typeof o?.scope === "string")
        : []
    } catch {
      return []
    }
  })

  const descriptions = createMemo(
    () => new Map((options() ?? []).map((o) => [o.scope, o.description])),
  )

  function label(scope: string): string {
    return scopeLabel(scope, i18n.t, descriptions().get(scope))
  }

  const offered = createMemo(() => {
    const q = query().trim().toLowerCase()
    const current = new Set(props.value)
    return (options() ?? [])
      .filter((o) => !current.has(o.scope))
      .filter(
        (o) =>
          !q ||
          o.scope.toLowerCase().includes(q) ||
          label(o.scope).toLowerCase().includes(q) ||
          (o.description ?? "").toLowerCase().includes(q),
      )
      .slice(0, MAX_OFFERED)
  })

  return (
    <div data-testid="routine-scopes-field" class="flex flex-col gap-1.5">
      <span class="text-[12px] text-text-tertiary">{i18n.t("kernel.agentForms.scopes")}</span>
      <span class="text-[11px] text-text-tertiary">{i18n.t("kernel.agentForms.scopesHint")}</span>
      <Show
        when={props.value.length > 0}
        fallback={
          <span data-testid="routine-scopes-empty" class="text-[12px] text-text-secondary">
            {i18n.t("kernel.agentForms.scopesEmpty")}
          </span>
        }
      >
        <ul class="flex flex-wrap gap-1.5">
          <For each={props.value}>
            {(scope) => (
              <li
                data-testid={`routine-scope-chip-${scope}`}
                title={scopeIdTitle(scope, i18n.t)}
                class="flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[12px] text-text"
              >
                <span>{label(scope)}</span>
                <button
                  type="button"
                  data-testid={`routine-scope-remove-${scope}`}
                  aria-label={i18n.t("kernel.agentForms.scopeRemove", { scope: label(scope) })}
                  class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
                  onClick={() => props.onChange(props.value.filter((s) => s !== scope))}
                >
                  <X size={11} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <input
        type="text"
        data-testid="routine-scope-search"
        class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
        placeholder={i18n.t("kernel.agentForms.scopeAddPlaceholder")}
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <Show when={!options.loading}>
        <Show
          when={offered().length > 0}
          fallback={
            <span class="text-[11px] text-text-tertiary">
              {i18n.t("kernel.agentForms.scopesNoneToAdd")}
            </span>
          }
        >
          <ul class="flex flex-col">
            <For each={offered()}>
              {(option) => (
                <li>
                  <button
                    type="button"
                    data-testid={`routine-scope-add-${option.scope}`}
                    title={scopeIdTitle(option.scope, i18n.t)}
                    class="w-full rounded px-2 py-1 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                    onClick={() => {
                      props.onChange([...props.value, option.scope])
                      setQuery("")
                    }}
                  >
                    + {label(option.scope)}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
