// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Toggle } from "~/ui/Toggle"

export interface LiaisonTeamBody {
  available: boolean
  canManage: boolean
  register: {
    enabled: boolean
    state: "off" | "pending" | "registered" | "retiring" | "error"
    lastError?: string
    instanceId?: string | null
    registeredAt?: string | null
  }
  forwardBugReports: { enabled: boolean }
  bugReportsTeamOnly?: { enabled: boolean }
  sharePerformance?: { enabled: boolean }
  outbox?: {
    pending: number
    failed: number
    expired: number
    lastDeliveredAt: string | null
    lastError: string | null
  }
}

const DOCS_URL = "https://github.com/liaison-sh/liaison/blob/main/docs/self-hosting/liaison-team.md"

/**
 * Settings > System: the instance-wide "share with the Liaison team"
 * switches. All start off. The switches are disabled, with the reason beside
 * them, when this org cannot change them or sharing is unavailable; forwarding
 * is disabled while registration is off, and "only to the Liaison team" while
 * forwarding is off. The server id and outbox counts are
 * the operator's only.
 */
export const LiaisonTeamSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [status, { mutate }] = createResource(() =>
    api.get<LiaisonTeamBody>("/admin/liaison-team").catch(() => null),
  )
  const [saving, setSaving] = createSignal(false)
  // The performance report exactly as it would be sent now (operator only).
  const [preview, setPreview] = createSignal<string | null>(null)
  async function showPreview() {
    if (preview() !== null) {
      setPreview(null)
      return
    }
    try {
      const body = await api.get<{ message: string; data: unknown }>(
        "/admin/liaison-team/performance",
      )
      setPreview(JSON.stringify(body.data, null, 2))
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : i18n.t("kernel.liaisonTeam.saveFailed"),
        type: "error",
      })
    }
  }

  async function change(body: {
    register?: boolean
    forwardBugReports?: boolean
    bugReportsTeamOnly?: boolean
    sharePerformance?: boolean
  }) {
    if (saving()) return
    setSaving(true)
    try {
      mutate(await api.put<LiaisonTeamBody>("/admin/liaison-team", body))
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : i18n.t("kernel.liaisonTeam.saveFailed"),
        type: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  const fields = () => [
    i18n.t("kernel.liaisonTeam.fieldVersion"),
    i18n.t("kernel.liaisonTeam.fieldEdition"),
    i18n.t("kernel.liaisonTeam.fieldUsers"),
    i18n.t("kernel.liaisonTeam.fieldServerId"),
  ]
  const stateLabel = (state: LiaisonTeamBody["register"]["state"]) => {
    switch (state) {
      case "pending":
        return i18n.t("kernel.liaisonTeam.statePending")
      case "registered":
        return i18n.t("kernel.liaisonTeam.stateRegistered")
      case "retiring":
        return i18n.t("kernel.liaisonTeam.stateRetiring")
      case "error":
        return i18n.t("kernel.liaisonTeam.stateError")
      default:
        return i18n.t("kernel.liaisonTeam.stateOff")
    }
  }

  const onOff = (on: boolean) =>
    on ? i18n.t("kernel.liaisonTeam.on") : i18n.t("kernel.liaisonTeam.off")

  return (
    <Show when={status()}>
      {(s) => {
        const locked = () => !s().canManage || !s().available
        const reason = () =>
          !s().available
            ? i18n.t("kernel.liaisonTeam.unavailable")
            : !s().canManage
              ? i18n.t("kernel.liaisonTeam.notOperator")
              : null
        const outbox = () => {
          const o = s().outbox
          return o && (o.pending > 0 || o.failed > 0 || o.expired > 0) ? o : null
        }
        return (
          <section
            class="flex flex-col gap-3 rounded border p-4"
            data-testid="settings-liaison-team"
          >
            <h3 class="text-sm font-medium">{i18n.t("kernel.liaisonTeam.title")}</h3>
            <p class="text-xs text-muted-foreground">{i18n.t("kernel.liaisonTeam.intro")}</p>

            <div class="flex flex-col gap-1">
              <div class="text-xs font-medium">{i18n.t("kernel.liaisonTeam.fieldsTitle")}</div>
              <ul class="list-disc pl-5 text-xs text-muted-foreground">
                <For each={fields()}>{(f) => <li data-testid="liaison-team-field">{f}</li>}</For>
              </ul>
            </div>

            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <div class="text-sm">{i18n.t("kernel.liaisonTeam.registerLabel")}</div>
                <p class="text-xs text-muted-foreground">
                  {i18n.t("kernel.liaisonTeam.registerHelp")}
                </p>
              </div>
              <Toggle
                pressed={s().register.enabled}
                onChange={(next) => change({ register: next })}
                disabled={locked() || saving()}
                aria-label={i18n.t("kernel.liaisonTeam.registerLabel")}
                data-testid="toggle-liaison-register"
              >
                {onOff(s().register.enabled)}
              </Toggle>
            </div>

            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <div class="text-sm">{i18n.t("kernel.liaisonTeam.forwardLabel")}</div>
                <p class="text-xs text-muted-foreground">
                  {i18n.t("kernel.liaisonTeam.forwardHelp")}
                </p>
                <Show when={!locked() && !s().register.enabled}>
                  <p class="text-xs text-muted-foreground" data-testid="liaison-team-forward-hint">
                    {i18n.t("kernel.liaisonTeam.needsRegistration")}
                  </p>
                </Show>
              </div>
              <Toggle
                pressed={s().forwardBugReports.enabled}
                onChange={(next) => change({ forwardBugReports: next })}
                disabled={locked() || !s().register.enabled || saving()}
                aria-label={i18n.t("kernel.liaisonTeam.forwardLabel")}
                data-testid="toggle-liaison-forward"
              >
                {onOff(s().forwardBugReports.enabled)}
              </Toggle>
            </div>

            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <div class="text-sm">{i18n.t("kernel.liaisonTeam.teamOnlyLabel")}</div>
                <p class="text-xs text-muted-foreground">
                  {i18n.t("kernel.liaisonTeam.teamOnlyHelp")}
                </p>
                <Show when={!locked() && !s().forwardBugReports.enabled}>
                  <p
                    class="text-xs text-muted-foreground"
                    data-testid="liaison-team-team-only-hint"
                  >
                    {i18n.t("kernel.liaisonTeam.needsForwarding")}
                  </p>
                </Show>
              </div>
              <Toggle
                pressed={s().bugReportsTeamOnly?.enabled === true}
                onChange={(next) => change({ bugReportsTeamOnly: next })}
                disabled={locked() || !s().forwardBugReports.enabled || saving()}
                aria-label={i18n.t("kernel.liaisonTeam.teamOnlyLabel")}
                data-testid="toggle-liaison-team-only"
              >
                {onOff(s().bugReportsTeamOnly?.enabled === true)}
              </Toggle>
            </div>

            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <div class="text-sm">{i18n.t("kernel.liaisonTeam.performanceLabel")}</div>
                <p class="text-xs text-muted-foreground">
                  {i18n.t("kernel.liaisonTeam.performanceHelp")}
                </p>
                <Show when={!locked() && !s().register.enabled}>
                  <p
                    class="text-xs text-muted-foreground"
                    data-testid="liaison-team-performance-hint"
                  >
                    {i18n.t("kernel.liaisonTeam.needsRegistration")}
                  </p>
                </Show>
                <Show when={s().canManage}>
                  <button
                    type="button"
                    class="self-start text-xs underline"
                    onClick={() => void showPreview()}
                    data-testid="liaison-team-performance-preview"
                  >
                    {preview() === null
                      ? i18n.t("kernel.liaisonTeam.performancePreview")
                      : i18n.t("kernel.liaisonTeam.performancePreviewHide")}
                  </button>
                </Show>
              </div>
              <Toggle
                pressed={s().sharePerformance?.enabled === true}
                onChange={(next) => change({ sharePerformance: next })}
                disabled={locked() || !s().register.enabled || saving()}
                aria-label={i18n.t("kernel.liaisonTeam.performanceLabel")}
                data-testid="toggle-liaison-performance"
              >
                {onOff(s().sharePerformance?.enabled === true)}
              </Toggle>
            </div>
            <Show when={preview()}>
              {(text) => (
                <pre
                  class="max-h-80 overflow-auto rounded border p-2 text-xs"
                  data-testid="liaison-team-performance-json"
                >
                  {text()}
                </pre>
              )}
            </Show>

            <Show when={reason()}>
              {(r) => (
                <p class="text-xs text-muted-foreground" data-testid="liaison-team-reason">
                  {r()}
                </p>
              )}
            </Show>

            <div class="flex flex-col gap-1 text-xs" data-testid="liaison-team-state">
              <div>
                <span class="text-muted-foreground">{i18n.t("kernel.liaisonTeam.stateLabel")}</span>{" "}
                <span data-testid="liaison-team-state-value">{stateLabel(s().register.state)}</span>
              </div>
              <Show when={s().register.state === "error" && s().register.lastError}>
                <div class="text-rose-900" data-testid="liaison-team-error">
                  {i18n.t("kernel.liaisonTeam.lastError", { error: s().register.lastError ?? "" })}
                </div>
              </Show>
              <Show when={s().canManage && s().register.instanceId}>
                <div data-testid="liaison-team-server-id">
                  <span class="text-muted-foreground">{i18n.t("kernel.liaisonTeam.serverId")}</span>{" "}
                  <code>{s().register.instanceId}</code>
                </div>
              </Show>
              <Show when={outbox()}>
                {(o) => (
                  <div data-testid="liaison-team-outbox">
                    {i18n.t("kernel.liaisonTeam.outbox", {
                      pending: String(o().pending),
                      failed: String(o().failed),
                      expired: String(o().expired),
                    })}
                  </div>
                )}
              </Show>
            </div>

            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs underline"
              data-testid="liaison-team-docs"
            >
              {i18n.t("kernel.liaisonTeam.docsLink")}
            </a>
          </section>
        )
      }}
    </Show>
  )
}
