// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a direct route into an app the viewer cannot use shows instead of the
// app's page (S19, S20): an admin turned it off or restricted it to other
// roles and people. Nothing was deleted; an admin can change it from the app's
// settings.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

export const AppUnavailableNotice: Component = () => {
  const i18n = useI18n()
  return (
    <div
      class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
      data-testid="app-unavailable-notice"
    >
      <p class="text-sm font-medium text-text">{i18n.t("kernel.shellUi.appUnavailable")}</p>
      <p class="max-w-md text-xs text-text-secondary">
        {i18n.t("kernel.shellUi.appUnavailableDetail")}
      </p>
    </div>
  )
}
