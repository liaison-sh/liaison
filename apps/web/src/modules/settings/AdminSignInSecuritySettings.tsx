// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Org admin setting: administrators must use two-step verification. Stored as
// `organizations.settings.requireAdminSecondFactor` (off by default) and written
// through PATCH /org, which requires kernel:org:admin. When on, an administrator
// without two-step verification signs in to a screen that only sets it up. The
// server refuses to turn it on for an admin who has none themselves (409).

import { type Component, createResource, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Switch } from "~/ui/Switch"

interface OrgPayload {
  settings?: { requireAdminSecondFactor?: boolean } | null
}

const AdminSignInSecuritySettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [required, setRequired] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  const [loaded] = createResource(async () => {
    const res = (await api.get("/org")) as OrgPayload | { data?: OrgPayload }
    const org = ("data" in (res as Record<string, unknown>)
      ? (res as { data?: OrgPayload }).data
      : (res as OrgPayload)) ?? { settings: null }
    const value = org.settings?.requireAdminSecondFactor === true
    setRequired(value)
    return value
  })

  async function change(next: boolean) {
    if (saving()) return
    const previous = required()
    setRequired(next)
    setSaving(true)
    try {
      await api.patch("/org", { settings: { requireAdminSecondFactor: next } })
    } catch (err) {
      setRequired(previous)
      const needsOwn = err instanceof ApiError && err.status === 409
      addToast({
        message: i18n.t(
          needsOwn ? "kernel.signInSecurity.needsOwnFirst" : "kernel.signInSecurity.saveFailed",
        ),
        type: "error",
      })
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
            data-testid="sign-in-security-skeleton"
          />
        }
      >
        <div
          class="flex min-h-11 items-start justify-between gap-4"
          data-testid="sign-in-security-row"
        >
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium text-text">
              {i18n.t("kernel.signInSecurity.requireAdminLabel")}
            </span>
            <span class="text-xs text-text-secondary">
              {i18n.t("kernel.signInSecurity.requireAdminHelp")}
            </span>
          </div>
          <Switch
            checked={required()}
            onChange={change}
            disabled={saving()}
            label={i18n.t("kernel.signInSecurity.requireAdminLabel")}
            data-testid="sign-in-security-require-admin-switch"
          />
        </div>
      </Show>
    </div>
  )
}

export default AdminSignInSecuritySettings
