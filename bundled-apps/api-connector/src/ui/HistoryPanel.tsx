// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connection's adapter history, in place beside Replace: the kept previous
// adapters (the last 20 saves), who saved each and when, and Restore. A
// version whose credential target differs from the current one (another API
// address, auth type or key location) would delete the stored credentials, so
// its Restore first shows that warning inline and asks again; the server
// refuses the restore without that confirmation too.

import type { AdapterVersionList, AdapterVersionView } from "@liaison/api-connector-core/contract"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { listVersions, restoreVersion, useApi } from "./api"
import { Button, formatDateTime, useI18n } from "./kit"

type LoadState = "loading" | "ready" | "error"

export const HistoryPanel: Component<{
  identifier: string
  onRestored: () => void
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [load, setLoad] = createSignal<LoadState>("loading")
  const [list, setList] = createSignal<AdapterVersionList | null>(null)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [restoring, setRestoring] = createSignal<string | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [restored, setRestored] = createSignal<{ version: string; cleared: boolean } | null>(null)

  async function refresh(): Promise<void> {
    try {
      setList(await listVersions(api, props.identifier))
      setLoad("ready")
    } catch {
      setLoad("error")
    }
  }

  onMount(() => void refresh())

  async function restore(v: AdapterVersionView, confirmWipe: boolean): Promise<void> {
    setRestoring(v.id)
    setFailed(false)
    try {
      const saved = await restoreVersion(api, props.identifier, {
        versionId: v.id,
        ...(confirmWipe ? { confirmCredentialWipe: true } : {}),
      })
      setConfirming(null)
      setRestored({ version: saved.adapterVersion, cleared: saved.credentialsCleared })
      await refresh()
      props.onRestored()
    } catch {
      setFailed(true)
    } finally {
      setRestoring(null)
    }
  }

  const onRestoreClick = (v: AdapterVersionView) => {
    setRestored(null)
    if (v.targetDiffers) setConfirming(v.id)
    else void restore(v, false)
  }

  const savedLine = (v: AdapterVersionView) =>
    i18n.t("api-connector.settings.history.saved", {
      when: formatDateTime(v.savedAt, i18n.locale()),
      who: v.savedByName ?? i18n.t("api-connector.settings.history.unknownSaver"),
    })

  return (
    <div
      data-testid={`api-connector-history-panel-${props.identifier}`}
      class="flex flex-col gap-2 rounded-sm bg-surface-sunken p-2 text-xs"
    >
      <div class="font-medium text-text">{i18n.t("api-connector.settings.history.title")}</div>
      <Show when={load() === "loading"}>
        <span class="text-text-secondary">{i18n.t("api-connector.settings.history.loading")}</span>
      </Show>
      <Show when={load() === "error"}>
        <span data-testid="api-connector-history-error" class="text-error">
          {i18n.t("api-connector.settings.history.loadFailed")}
        </span>
      </Show>
      <Show when={restored()}>
        {(r) => (
          <span data-testid="api-connector-restored" class="text-text-secondary">
            {i18n.t(
              r().cleared
                ? "api-connector.settings.history.restoredCleared"
                : "api-connector.settings.history.restored",
              { version: r().version },
            )}
          </span>
        )}
      </Show>
      <Show when={load() === "ready" && list()}>
        {(l) => (
          <>
            <Show when={l().versions.length === 0}>
              <span data-testid="api-connector-history-empty" class="text-text-secondary">
                {i18n.t("api-connector.settings.history.empty")}
              </span>
            </Show>
            <ul class="flex flex-col gap-1.5">
              <For each={l().versions}>
                {(v) => (
                  <li
                    data-testid={`api-connector-version-${v.id}`}
                    class="flex flex-col gap-1 rounded-sm border border-border p-2"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="min-w-0">
                        <span class="text-text">
                          {i18n.t("api-connector.settings.history.version", {
                            version: v.adapterVersion,
                          })}
                          <Show when={v.name}>{(n) => <> · {n()}</>}</Show>
                        </span>
                        <div class="text-text-tertiary">{savedLine(v)}</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`api-connector-restore-${v.id}`}
                        loading={restoring() === v.id && confirming() !== v.id}
                        disabled={restoring() !== null}
                        onClick={() => onRestoreClick(v)}
                      >
                        {i18n.t("api-connector.settings.history.restore")}
                      </Button>
                    </div>
                    <Show when={confirming() === v.id}>
                      <div
                        data-testid={`api-connector-restore-warning-${v.id}`}
                        class="flex flex-wrap items-center gap-2"
                      >
                        <span class="text-text">
                          {i18n.t("api-connector.settings.history.wipeWarning", {
                            target: v.target ?? "",
                          })}
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          data-testid={`api-connector-restore-confirm-${v.id}`}
                          loading={restoring() === v.id}
                          onClick={() => void restore(v, true)}
                        >
                          {i18n.t("api-connector.settings.history.restoreAnyway")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`api-connector-restore-cancel-${v.id}`}
                          onClick={() => setConfirming(null)}
                        >
                          {i18n.t("api-connector.common.cancel")}
                        </Button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
      <Show when={failed()}>
        <span data-testid="api-connector-restore-error" class="text-error">
          {i18n.t("api-connector.settings.history.restoreFailed")}
        </span>
      </Show>
    </div>
  )
}
