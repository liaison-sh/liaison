// SPDX-License-Identifier: FSL-1.1-ALv2

import { ArrowUpRight, Check } from "lucide-solid"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"

export interface DimensionCatalogEntry {
  key: string
  app: string
  type: string
  order?: string[]
  values?: string[]
  label?: string
  description?: string
  manageHref?: string
}

export interface DimensionGrantState {
  /** Values granted directly to this user. */
  direct: string[]
  /** Values inherited from roles (role name → values). */
  inherited: Array<{ roleId: string; roleName: string; values: string[] }>
}

export interface DimensionPanelsProps {
  catalog: DimensionCatalogEntry[]
  catalogLoading?: boolean
  /** Current grant state for this user, keyed by dimension full-key. */
  grants: Record<string, DimensionGrantState>
  /**
   * Apply a new set of direct values for a dimension. Empty array → revoke the
   * direct grant. Caller should refetch on success.
   */
  onSetValues: (dimensionKey: string, values: string[]) => Promise<void>
  testIdPrefix: string
}

/** The app's name in the reader's language (the capability catalog's app names). */
function appLabel(app: string, t: (key: string) => string): string {
  const key = `kernel.capabilities.apps.${app}`
  const named = t(key)
  return named !== key ? named : app.charAt(0).toUpperCase() + app.slice(1)
}

function dimensionLabel(entry: DimensionCatalogEntry): string {
  if (entry.label) return entry.label
  const tail = entry.key.split(":").slice(1).join(":")
  return tail.charAt(0).toUpperCase() + tail.slice(1).replace(/_/g, " ")
}

function declaredValues(entry: DimensionCatalogEntry): string[] {
  return entry.values ?? entry.order ?? []
}

/**
 * A dimension surfaces in the admin UI only when its values are configurable.
 * Either:
 *  - the manifest declares `values` / `order` → render a checkbox grid, or
 *  - the manifest declares `manageHref` → render a link to the dedicated
 *    settings page (eg. mail inboxes are configured per-account).
 *
 * Dimensions without either are intentionally hidden — the rule is that
 * apps must opt-in to admin-UI visibility, never via free text.
 */
function isVisible(entry: DimensionCatalogEntry): boolean {
  return declaredValues(entry).length > 0 || !!entry.manageHref
}

export const DimensionPanels: Component<DimensionPanelsProps> = (props) => {
  const i18n = useI18n()
  const [pendingKey, setPendingKey] = createSignal<string | null>(null)
  const [errorByKey, setErrorByKey] = createSignal<Record<string, string>>({})

  const groupedByApp = createMemo(() => {
    const map = new Map<string, DimensionCatalogEntry[]>()
    for (const entry of props.catalog) {
      if (!isVisible(entry)) continue
      const bucket = map.get(entry.app) ?? []
      bucket.push(entry)
      map.set(entry.app, bucket)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  })

  function directValuesFor(key: string): Set<string> {
    return new Set(props.grants[key]?.direct ?? [])
  }

  function inheritedFor(key: string): DimensionGrantState["inherited"] {
    return props.grants[key]?.inherited ?? []
  }

  async function toggleValue(key: string, value: string) {
    if (pendingKey()) return
    const current = directValuesFor(key)
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setPendingKey(key)
    setErrorByKey((prev) => {
      const out = { ...prev }
      delete out[key]
      return out
    })
    try {
      await props.onSetValues(key, [...next])
    } catch (err) {
      setErrorByKey((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : "Failed to update",
      }))
    } finally {
      setPendingKey(null)
    }
  }

  return (
    <Show
      when={!props.catalogLoading}
      fallback={
        <div class="flex flex-col gap-2">
          <For each={[0, 1]}>
            {() => (
              <div class="h-20 animate-pulse rounded-md border border-border-subtle bg-surface/40" />
            )}
          </For>
        </div>
      }
    >
      <Show
        when={props.catalog.length > 0}
        fallback={
          <div class="rounded-md border border-dashed border-border-subtle bg-surface/30 px-3 py-5 text-center text-[11.5px] text-text-tertiary">
            {i18n.t("kernel.settingsUi.noTeamOrSensitivityConstraintsDeclared")}
          </div>
        }
      >
        <div class="flex flex-col gap-4">
          <For each={groupedByApp()}>
            {([app, entries]) => (
              <div class="flex flex-col gap-2">
                <h3 class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
                  {appLabel(app, i18n.t)}
                </h3>
                <For each={entries}>
                  {(entry) => {
                    const directSet = () => directValuesFor(entry.key)
                    const inherited = () => inheritedFor(entry.key)
                    const allValues = () => declaredValues(entry)
                    const pending = () => pendingKey() === entry.key
                    const errorMsg = () => errorByKey()[entry.key]
                    return (
                      <section
                        class={cn(
                          "rounded-md border border-border-subtle bg-surface/40 px-3.5 py-3",
                          pending() && "opacity-60",
                        )}
                        data-testid={`${props.testIdPrefix}-dimension-${entry.key}`}
                      >
                        <header class="mb-1 flex items-baseline justify-between gap-3">
                          <div class="flex items-baseline gap-2">
                            <span class="font-display text-[13px] font-medium tracking-tight text-text">
                              {dimensionLabel(entry)}
                            </span>
                            <span class="font-mono text-[10px] text-text-tertiary">
                              {entry.key}
                            </span>
                          </div>
                          <Show when={entry.description}>
                            <p class="max-w-[60%] text-right text-[10.5px] leading-snug text-text-tertiary">
                              {entry.description}
                            </p>
                          </Show>
                        </header>

                        <Show
                          when={allValues().length > 0}
                          fallback={
                            <Show when={entry.manageHref}>
                              {(href) => (
                                <a
                                  href={href()}
                                  class="inline-flex items-center gap-1.5 self-start rounded-md border border-border-subtle bg-bg/40 px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-surface-hover hover:text-text"
                                  data-testid={`${props.testIdPrefix}-dimension-manage-${entry.key}`}
                                >
                                  {i18n.t("kernel.settingsUi.manageIn")}{" "}
                                  {appLabel(entry.app, i18n.t)}{" "}
                                  {i18n.t("kernel.settingsUi.settings")}
                                  <ArrowUpRight size={11} aria-hidden />
                                </a>
                              )}
                            </Show>
                          }
                        >
                          <div class="flex flex-wrap gap-1.5">
                            <For each={allValues()}>
                              {(value) => {
                                const checked = () => directSet().has(value)
                                const inheritedFrom = () =>
                                  inherited()
                                    .filter((inh) => inh.values.includes(value))
                                    .map((inh) => inh.roleName)
                                return (
                                  <button
                                    type="button"
                                    onClick={() => void toggleValue(entry.key, value)}
                                    disabled={pending()}
                                    aria-pressed={checked()}
                                    data-testid={`${props.testIdPrefix}-dimension-value-${entry.key}-${value}`}
                                    data-granted={checked() ? "true" : "false"}
                                    data-inherited={inheritedFrom().length > 0 ? "true" : "false"}
                                    title={
                                      inheritedFrom().length > 0
                                        ? i18n.t("kernel.settingsUi.inheritedVia", {
                                            roles: inheritedFrom().join(", "),
                                          })
                                        : undefined
                                    }
                                    class={cn(
                                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] font-mono text-[10.5px] transition-colors duration-150",
                                      checked()
                                        ? "border-accent-border bg-accent-glow text-accent"
                                        : inheritedFrom().length > 0
                                          ? "border-border-subtle bg-bg/40 text-text-secondary"
                                          : "border-border bg-bg text-text-secondary hover:border-border-strong hover:text-text",
                                    )}
                                  >
                                    <Check
                                      size={9}
                                      stroke-width={3}
                                      class={cn(
                                        !checked() && inheritedFrom().length === 0 && "opacity-0",
                                        !checked() && inheritedFrom().length > 0 && "opacity-50",
                                      )}
                                      aria-hidden
                                    />
                                    {value}
                                    <Show when={!checked() && inheritedFrom().length > 0}>
                                      <span class="text-[9px] uppercase tracking-wider text-text-tertiary">
                                        {i18n.t("kernel.settingsUi.via")}{" "}
                                        {inheritedFrom().join(", ")}
                                      </span>
                                    </Show>
                                  </button>
                                )
                              }}
                            </For>
                          </div>
                        </Show>

                        <Show when={errorMsg()}>
                          <p
                            class="mt-2 text-[11px] text-error"
                            data-testid={`${props.testIdPrefix}-dimension-error-${entry.key}`}
                          >
                            {errorMsg()}
                          </p>
                        </Show>
                      </section>
                    )
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Show>
  )
}
