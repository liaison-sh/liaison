// SPDX-License-Identifier: FSL-1.1-ALv2
// An installed app's "Outbound access" (GET/POST /api/apps/:name/outbound): the
// hosts its code may reach. Granted hosts, and the ones a version declares that
// wait for an admin's approval, each with Revoke / Allow for an admin who may
// change them (the instance operator for an instance app, the owning org's
// admin for its own app). A change holds from the app's next run. Calm: plain
// lists, no alarm colour.
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { appsStore, type OutboundAccess } from "../apps-store"

const S = "kernel.appStore"

export const OutboundAccessSection: Component<{ appId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [access, { mutate }] = createResource(
    () => props.appId,
    (name) => appsStore.outboundAccess(api, name).catch(() => null),
  )
  const [busy, setBusy] = createSignal<string | null>(null)

  async function change(domain: string, kind: "grant" | "revoke"): Promise<void> {
    setBusy(domain)
    try {
      const next = await appsStore.setOutboundAccess(api, props.appId, { [kind]: [domain] })
      mutate((prev) => (prev ? { ...prev, ...next } : next))
    } catch (e) {
      addToast({
        message: i18n.t(`${S}.outboundChangeFailed`, {
          message: e instanceof ApiError || e instanceof Error ? e.message : String(e),
        }),
        type: "error",
      })
    } finally {
      setBusy(null)
    }
  }

  const row = (domain: string, kind: "grant" | "revoke", a: OutboundAccess) => (
    <li
      class="flex items-center justify-between gap-2 px-4 py-1.5"
      data-testid={`app-outbound-${kind === "revoke" ? "granted" : "pending"}-${domain}`}
    >
      <span class="break-all font-mono text-[13px]">{domain}</span>
      <Show when={a.canManage}>
        <Button
          size="sm"
          variant="ghost"
          class="w-auto"
          disabled={busy() !== null}
          data-testid={`app-outbound-${kind}-${domain}`}
          onClick={() => void change(domain, kind)}
        >
          {kind === "revoke" ? i18n.t(`${S}.outboundRevoke`) : i18n.t(`${S}.outboundAllow`)}
        </Button>
      </Show>
    </li>
  )

  return (
    <Show when={access()}>
      {(a) => (
        <section class="mb-6" data-testid="app-outbound-access">
          <h2 class="text-[13px] font-semibold">{i18n.t(`${S}.outboundAccess`)}</h2>
          <p class="mb-2 text-xs text-text-secondary">{i18n.t(`${S}.outboundAccessHint`)}</p>
          <Show
            when={a().declared.length > 0}
            fallback={
              <p class="text-[13px] text-text-secondary" data-testid="app-outbound-none">
                {i18n.t(`${S}.outboundNone`)}
              </p>
            }
          >
            <div class="flex flex-col gap-3 rounded-lg border border-border bg-surface py-2 text-[13px]">
              <Show when={a().granted === null}>
                <p class="px-4 text-text-secondary" data-testid="app-outbound-grandfathered">
                  {i18n.t(`${S}.outboundAllHosts`)}
                </p>
              </Show>
              <Show when={(a().granted ?? a().declared).length > 0}>
                <div>
                  <p class="px-4 text-xs font-medium text-text-secondary">
                    {i18n.t(`${S}.outboundGranted`)}
                  </p>
                  <ul>
                    <For each={a().granted ?? a().declared}>
                      {(domain) => row(domain, "revoke", a())}
                    </For>
                  </ul>
                </div>
              </Show>
              <Show when={a().pending.length > 0}>
                <div>
                  <p class="px-4 text-xs font-medium text-text-secondary">
                    {i18n.t(`${S}.outboundPending`)}
                  </p>
                  <ul>
                    <For each={a().pending}>{(domain) => row(domain, "grant", a())}</For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>
        </section>
      )}
    </Show>
  )
}
