// SPDX-License-Identifier: FSL-1.1-ALv2
// An app's UI bundle lacks an export its manifest names (a settings custom
// block, P2-20): an admin sees what is wrong, everyone else sees nothing. The
// same card in the browser (CustomBlock) and inside a desktop or mobile shell,
// where the export is only known missing once the isolated frame has loaded
// the bundle (isolated-app.tsx).
import { type Component, Show } from "solid-js"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"

/** The scope that administers apps (app-sdk DEFAULT_SETTINGS_ADMIN_SCOPE). */
const APPS_ADMIN_SCOPE = "kernel:apps:admin"

export const MissingExportNotice: Component<{ name: string }> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={canAccessScope(APPS_ADMIN_SCOPE)}>
      <div
        class="rounded-md border border-error-border bg-error-glow px-3 py-2 text-[13px] text-text"
        data-testid={`settings-custom-missing-${props.name}`}
      >
        {i18n.t("kernel.settingsPage.missingExport", { name: props.name })}
      </div>
    </Show>
  )
}
