// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Notifications, "On call" (etiquette rule 9): who incidents and
// critical alerts interrupt, even in quiet hours. Everyone sees the list; an
// admin picks the members. With nobody picked, the admins are on call.

import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  fetchOnCall,
  type OnCallData,
  putOnCall,
} from "~/modules/settings/notification-settings/settings-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"

export const OnCallSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const k = (key: string) => i18n.t(`kernel.notificationSettings.${key}`)
  const [data, setData] = createSignal<OnCallData | null>(null)
  const [picked, setPicked] = createSignal<string[]>([])
  const [failed, setFailed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  function show(next: OnCallData): void {
    setData(next)
    setPicked(next.source === "list" ? next.onCall.map((u) => u.id) : [])
  }

  onMount(async () => {
    try {
      show(await fetchOnCall(api))
    } catch {
      setFailed(true)
    }
  })

  const saved = createMemo(() => {
    const d = data()
    return d && d.source === "list" ? d.onCall.map((u) => u.id) : []
  })
  const dirty = createMemo(() => {
    const a = [...picked()].sort()
    const b = [...saved()].sort()
    return a.length !== b.length || a.some((id, i) => id !== b[i])
  })

  function toggle(id: string): void {
    const now = picked()
    setPicked(now.includes(id) ? now.filter((x) => x !== id) : [...now, id])
  }

  async function save(): Promise<void> {
    if (saving() || !dirty()) return
    setSaving(true)
    try {
      show(await putOnCall(api, picked()))
    } catch {
      addToast({ message: k("saveFailed"), type: "error" })
    }
    setSaving(false)
  }

  return (
    <section data-testid="notif-on-call" class="mb-10 border-t border-border-subtle pt-8">
      <div class="mb-3 flex items-baseline justify-between gap-4">
        <h2 class={sectionHeading}>{k("onCallTitle")}</h2>
        <Show when={data()?.canEdit}>
          <button
            type="button"
            data-testid="notif-on-call-save"
            disabled={!dirty() || saving()}
            onClick={() => void save()}
            class="min-h-11 shrink-0 rounded-sm border border-accent-border bg-accent-glow px-4 py-1.5 text-[13px] font-medium text-accent hover:bg-accent-wash hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            {saving() ? i18n.t("kernel.common.saving") : k("onCallSave")}
          </button>
        </Show>
      </div>
      <p class="mb-3 max-w-[60ch] text-[12px] leading-relaxed text-text-secondary">
        {k("onCallHint")}
      </p>
      <Show when={failed()}>
        <p data-testid="notif-on-call-error" class="text-[13px] text-error">
          {k("onCallLoadFailed")}
        </p>
      </Show>
      <Show when={data()}>
        {(d) => (
          <>
            <Show when={d().source !== "list"}>
              <p data-testid="notif-on-call-default" class="mb-3 text-[12px] text-text-secondary">
                {k(d().source === "nobody" ? "onCallNobody" : "onCallDefault")}
              </p>
            </Show>
            <Show
              when={d().canEdit}
              fallback={
                <>
                  <ul data-testid="notif-on-call-list" class="flex flex-col gap-1">
                    <For each={d().onCall}>
                      {(u) => (
                        <li
                          data-testid={`notif-on-call-person-${u.id}`}
                          class="text-[13px] text-text"
                        >
                          {u.name}
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="mt-3 text-[12px] text-text-tertiary">{k("onCallAdminOnly")}</p>
                </>
              }
            >
              <ul data-testid="notif-on-call-members" class="flex flex-col gap-1">
                <For each={d().members}>
                  {(m) => (
                    <li>
                      <label class="flex min-h-11 cursor-pointer items-center gap-3 text-[13px] text-text lg:min-h-0">
                        <input
                          type="checkbox"
                          data-testid={`notif-on-call-member-${m.id}`}
                          checked={picked().includes(m.id)}
                          onChange={() => toggle(m.id)}
                        />
                        {m.name}
                      </label>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
