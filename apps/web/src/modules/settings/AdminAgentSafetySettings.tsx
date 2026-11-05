// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Org admin setting: whether an agent turn that has read outside text (an inbound
// mail, a web page, a remote tool result) has its outward actions held for a
// person. Stored as `organizations.settings.webContentProtection`
// ("standard" by default, "hardened", or "off") and written through PATCH /org,
// which requires kernel:org:admin and records the change as an org update event.

import { type Component, createResource, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Switch } from "~/ui/Switch"

type Protection = "off" | "standard" | "hardened"

interface OrgPayload {
  settings?: { webContentProtection?: Protection } | null
}

const AdminAgentSafetySettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [protection, setProtection] = createSignal<Protection>("standard")
  // The non-off value to restore when the switch goes back on ("hardened" stays hardened).
  const [onValue, setOnValue] = createSignal<Exclude<Protection, "off">>("standard")
  const [saving, setSaving] = createSignal(false)

  const [loaded] = createResource(async () => {
    const res = (await api.get("/org")) as OrgPayload | { data?: OrgPayload }
    const org = ("data" in (res as Record<string, unknown>)
      ? (res as { data?: OrgPayload }).data
      : (res as OrgPayload)) ?? { settings: null }
    const value = org.settings?.webContentProtection ?? "standard"
    setProtection(value)
    if (value !== "off") setOnValue(value)
    return value
  })

  const enabled = () => protection() !== "off"

  async function change(next: boolean) {
    if (saving()) return
    const previous = protection()
    const value: Protection = next ? onValue() : "off"
    setProtection(value)
    setSaving(true)
    try {
      await api.patch("/org", { settings: { webContentProtection: value } })
    } catch {
      setProtection(previous)
      addToast({ message: i18n.t("kernel.agentSafety.saveFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Show
        when={!loaded.loading}
        fallback={
          <div
            class="h-20 animate-pulse rounded-md bg-surface-hover"
            data-testid="agent-safety-skeleton"
          />
        }
      >
        <div class="flex min-h-11 items-start justify-between gap-4" data-testid="agent-safety-row">
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium text-text">
              {i18n.t("kernel.agentSafety.untrustedLabel")}
            </span>
            <span class="text-xs text-text-secondary">
              {i18n.t("kernel.agentSafety.untrustedHelp")}
            </span>
            <Show when={!enabled()}>
              <span class="text-xs text-text" data-testid="agent-safety-off-note">
                {i18n.t("kernel.agentSafety.offNote")}
              </span>
            </Show>
          </div>
          <Switch
            checked={enabled()}
            onChange={change}
            disabled={saving()}
            label={i18n.t("kernel.agentSafety.untrustedLabel")}
            data-testid="agent-safety-untrusted-switch"
          />
        </div>
      </Show>
    </div>
  )
}

export default AdminAgentSafetySettings
