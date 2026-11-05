// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AI MODELS PAGE'S "BLOCKED HOSTS" SETTING: the OpenRouter upstream hosts
// this organization's requests are never routed to. The page's GET payload
// carries the effective list (the org's own, or the server's default when the
// org set none); each change saves the whole list through PATCH
// /settings/ai/models `{ blockedHosts }`, and "Reset to default" sends null.

import { BLOCKED_HOSTS_MAX, type BlockedHostsView } from "@liaison/shared"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { Tooltip } from "~/ui/Tooltip"

export const BlockedHostsSection: Component<{
  /** The page's GET payload value; undefined until it is loaded. */
  value: BlockedHostsView | undefined
  /** Hears the saved list (the page keeps its payload in step). */
  onSaved?: (view: BlockedHostsView) => void
}> = (props) => {
  const { t } = useI18n()
  const api = useApi()
  // The list as last saved here, else the page's payload.
  const [saved, setSaved] = createSignal<BlockedHostsView | undefined>()
  const view = () => saved() ?? props.value
  const [draft, setDraft] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const hosts = () => view()?.hosts ?? []
  const draftName = () => draft().trim()
  const canAdd = () =>
    !saving() &&
    draftName().length > 0 &&
    hosts().length < BLOCKED_HOSTS_MAX &&
    !hosts().some((h) => h.toLowerCase() === draftName().toLowerCase())

  async function save(next: string[] | null) {
    if (saving()) return
    setSaving(true)
    try {
      const res = await api.patch<{ blockedHosts?: BlockedHostsView }>("/settings/ai/models", {
        blockedHosts: next,
      })
      if (res?.blockedHosts) {
        setSaved(res.blockedHosts)
        props.onSaved?.(res.blockedHosts)
      }
      setDraft("")
    } catch {
      addToast({ message: t("kernel.aiModels.blockedHostsSaveFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  const add = () => {
    if (canAdd()) void save([...hosts(), draftName()])
  }

  return (
    <section class="flex flex-col gap-2" data-testid="ai-models-blocked-hosts">
      <h2 class="text-sm font-semibold text-text">{t("kernel.aiModels.blockedHostsTitle")}</h2>
      <p class="text-[13px] text-text-secondary">{t("kernel.aiModels.blockedHostsDesc")}</p>
      <Show when={view()}>
        {(v) => (
          <>
            <div
              class="flex flex-wrap items-center gap-2"
              data-testid="ai-models-blocked-hosts-list"
            >
              <For
                each={v().hosts}
                fallback={
                  <span
                    class="text-[13px] text-text-tertiary"
                    data-testid="ai-models-blocked-hosts-none"
                  >
                    {t("kernel.aiModels.blockedHostsNone")}
                  </span>
                }
              >
                {(host) => (
                  <span
                    class="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[12.5px] text-text"
                    data-testid={`ai-models-blocked-host-${host}`}
                  >
                    {host}
                    <Tooltip content={t("kernel.aiModels.blockedHostsRemove", { host })}>
                      <button
                        type="button"
                        class="cursor-pointer rounded-full px-1 text-text-tertiary hover:text-text disabled:opacity-50"
                        aria-label={t("kernel.aiModels.blockedHostsRemove", { host })}
                        disabled={saving()}
                        onClick={() => void save(hosts().filter((h) => h !== host))}
                        data-testid={`ai-models-blocked-host-remove-${host}`}
                      >
                        ×
                      </button>
                    </Tooltip>
                  </span>
                )}
              </For>
            </div>
            <Show when={v().isDefault && v().hosts.length > 0}>
              <p
                class="text-[12px] text-text-tertiary"
                data-testid="ai-models-blocked-hosts-default"
              >
                {t("kernel.aiModels.blockedHostsDefaultNote")}
              </p>
            </Show>
            <form
              class="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                add()
              }}
            >
              <div class="w-64">
                <Input
                  label={t("kernel.aiModels.blockedHostsInputLabel")}
                  placeholder={t("kernel.aiModels.blockedHostsInputPlaceholder")}
                  value={draft()}
                  maxLength={100}
                  disabled={saving()}
                  autocomplete="off"
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  data-testid="ai-models-blocked-hosts-input"
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!canAdd()}
                data-testid="ai-models-blocked-hosts-add"
              >
                {t("kernel.aiModels.blockedHostsAdd")}
              </Button>
              <Show when={!v().isDefault}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving()}
                  onClick={() => void save(null)}
                  data-testid="ai-models-blocked-hosts-reset"
                >
                  {t("kernel.aiModels.blockedHostsReset")}
                </Button>
              </Show>
            </form>
            <Show when={hosts().length >= BLOCKED_HOSTS_MAX}>
              <p class="text-[12px] text-text-tertiary" data-testid="ai-models-blocked-hosts-max">
                {t("kernel.aiModels.blockedHostsMax", { max: String(BLOCKED_HOSTS_MAX) })}
              </p>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
