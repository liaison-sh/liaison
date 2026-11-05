// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "What each app sends" on Settings -> Notifications: the per-app rules
// (kernel.attention_subscriptions). An app switched off, or a kind unticked,
// stops reaching the person on every channel, the feed included; the grid
// above only decides how the rest reaches them.
//
// The first row is Liaison itself (source `kernel`): replies in your threads
// can be dropped there. Mentions and system alerts are shown but cannot be:
// the translator lets them through every rule (translator.ts
// HIGH_SIGNAL_KINDS), and a box that changed nothing would be a switch that lies.

import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { appLabel } from "~/lib/app-label"
import { catalogHasKey, useI18n } from "~/modules/i18n/i18n-context"
import {
  KERNEL_ROW_KINDS,
  KERNEL_RULE_KINDS,
  kindLabel,
} from "~/modules/settings/notification-settings/kind-labels"
import {
  allowedKinds,
  fetchAppAxes,
  fetchRules,
  type SubscriptionRule,
  setKindAllowed,
  toggleSourceEnabled,
} from "~/modules/settings/notification-settings/rules-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Skeleton } from "~/ui/Skeleton"

const KERNEL_SOURCE = "kernel"

export const AppRulesSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [appAxes, { refetch: refetchAxes }] = createResource(async () => {
    try {
      return { ok: true as const, rows: await fetchAppAxes(api) }
    } catch {
      return { ok: false as const, rows: [] }
    }
  })
  const [rules, { refetch: refetchRules }] = createResource(async () => {
    try {
      return { ok: true as const, rows: await fetchRules(api) }
    } catch {
      return { ok: false as const, rows: [] as SubscriptionRule[] }
    }
  })
  const [busy, setBusy] = createSignal<string | null>(null)

  const loading = () => appAxes.loading || rules.loading
  const failed = () => appAxes()?.ok === false || rules()?.ok === false

  const rulesBySource = createMemo<Record<string, SubscriptionRule>>(() => {
    const out: Record<string, SubscriptionRule> = {}
    for (const r of rules()?.rows ?? []) out[r.source] = r
    return out
  })

  async function run(source: string, write: () => Promise<unknown>): Promise<void> {
    if (busy()) return
    setBusy(source)
    try {
      await write()
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.failedToUpdatePreference"), type: "error" })
    }
    await refetchRules()
    setBusy(null)
  }

  function setKind(source: string, declared: readonly string[], kind: string, on: boolean): void {
    void run(source, () => setKindAllowed(api, rulesBySource()[source], source, declared, kind, on))
  }

  function retry(): void {
    void refetchAxes()
    void refetchRules()
  }

  const kindCheckbox = (props: {
    source: string
    kind: string
    checked: boolean
    disabled: boolean
    onChange: (on: boolean) => void
  }) => (
    <label class="flex min-h-11 items-center gap-2 text-[12.5px] text-text lg:min-h-8">
      <input
        type="checkbox"
        data-testid={`attention-rules-kind-${props.source}-${props.kind}`}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
        class="h-4 w-4 accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span classList={{ "text-text-tertiary": props.disabled && !props.checked }}>
        {kindLabel(props.kind, i18n.t)}
      </span>
    </label>
  )

  return (
    <section data-testid="attention-rules" class="mb-10 border-t border-border-subtle pt-8">
      <h2 class={`mb-2 ${sectionHeading}`}>{i18n.t("kernel.notificationSettings.rulesTitle")}</h2>
      <p class="mb-4 text-[13px] leading-relaxed text-text-secondary">
        {i18n.t("kernel.notificationSettings.rulesHint")}
      </p>

      <Show when={!loading()} fallback={<Skeleton class="h-32 w-full" />}>
        <Show
          when={!failed()}
          fallback={
            <div
              data-testid="attention-rules-error"
              class="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3"
            >
              <p class="text-[13px] text-error">
                {i18n.t("kernel.notificationSettings.rulesLoadFailed")}
              </p>
              <button
                type="button"
                onClick={retry}
                class="min-h-11 shrink-0 rounded-sm border border-border px-3 py-1 text-[12.5px] text-text hover:bg-surface-hover lg:min-h-0"
              >
                {i18n.t("kernel.notificationSettings.retry")}
              </button>
            </div>
          }
        >
          <ul class="flex flex-col gap-3">
            {/* Liaison itself: no master switch, approvals and access requests
                must keep reaching the people who decide them. */}
            <li
              data-testid={`attention-rules-row-${KERNEL_SOURCE}`}
              class="rounded-md border border-border bg-surface px-4 py-3"
            >
              <span class="font-display text-[14px] text-text">
                {i18n.t("kernel.notificationSettings.rulesLiaison")}
              </span>
              <div class="mt-2 flex flex-col">
                <For each={KERNEL_ROW_KINDS}>
                  {(entry) => {
                    const allowed = createMemo(() =>
                      allowedKinds(rulesBySource()[KERNEL_SOURCE], KERNEL_RULE_KINDS),
                    )
                    return (
                      <>
                        {kindCheckbox({
                          source: KERNEL_SOURCE,
                          kind: entry.kind,
                          get checked() {
                            return entry.locked || allowed().has(entry.kind)
                          },
                          get disabled() {
                            return entry.locked || busy() !== null
                          },
                          onChange: (on) =>
                            setKind(KERNEL_SOURCE, KERNEL_RULE_KINDS, entry.kind, on),
                        })}
                        <Show when={entry.locked}>
                          <p class="-mt-1 mb-1 pl-6 text-[11.5px] text-text-tertiary">
                            {i18n.t("kernel.notificationSettings.alwaysDelivered")}
                          </p>
                        </Show>
                      </>
                    )
                  }}
                </For>
              </div>
            </li>

            <For each={appAxes()?.rows ?? []}>
              {(row) => {
                const rule = createMemo(() => rulesBySource()[row.app])
                const enabled = createMemo(() => rule()?.enabled ?? true)
                const allowed = createMemo(() => allowedKinds(rule(), row.kinds))
                const name = () => appLabel(row.app, i18n.t)
                return (
                  <li
                    data-testid={`attention-rules-row-${row.app}`}
                    class="rounded-md border border-border bg-surface px-4 py-3"
                  >
                    <div class="flex items-start justify-between gap-4">
                      <span class="min-w-0 font-display text-[14px] text-text">{name()}</span>
                      <button
                        type="button"
                        data-testid={`attention-rules-toggle-${row.app}`}
                        aria-pressed={enabled()}
                        aria-label={i18n.t("kernel.notificationSettings.appOnLabel", {
                          app: name(),
                        })}
                        disabled={busy() !== null}
                        onClick={() =>
                          void run(row.app, () =>
                            toggleSourceEnabled(api, rule(), row.app, !enabled()),
                          )
                        }
                        class="min-h-11 shrink-0 rounded-sm border px-3 py-1 text-[12px] font-medium transition-colors duration-150 lg:min-h-0"
                        classList={{
                          "border-accent-border bg-accent-glow text-accent": enabled(),
                          "border-border bg-bg text-text-tertiary hover:text-text": !enabled(),
                        }}
                      >
                        {enabled()
                          ? i18n.t("kernel.settingsUi.on")
                          : i18n.t("kernel.settingsUi.off")}
                      </button>
                    </div>
                    <Show when={row.kinds.length > 0}>
                      <div class="mt-2 flex flex-col">
                        <For each={row.kinds}>
                          {(kind) =>
                            kindCheckbox({
                              source: row.app,
                              kind,
                              get checked() {
                                return allowed().has(kind)
                              },
                              get disabled() {
                                return !enabled() || busy() !== null
                              },
                              onChange: (on) => setKind(row.app, row.kinds, kind, on),
                            })
                          }
                        </For>
                      </div>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
          <Show when={(appAxes()?.rows ?? []).length === 0}>
            <p data-testid="attention-rules-empty" class="mt-3 text-[13px] text-text-tertiary">
              {i18n.t("kernel.notificationSettings.rulesEmpty")}
            </p>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
