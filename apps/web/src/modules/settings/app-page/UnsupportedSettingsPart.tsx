// SPDX-License-Identifier: FSL-1.1-ALv2
// A part of a settings page this build cannot draw (supported.ts): a calm line
// saying to update Liaison, never a control guessed from an unknown type.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

export const UnsupportedSettingsPart: Component<{ label?: string }> = (props) => {
  const i18n = useI18n()
  return (
    <div
      data-testid="settings-unsupported"
      class="rounded-md border border-border px-3 py-2 text-sm text-text-secondary"
    >
      {props.label ? <span class="font-medium text-text">{props.label}: </span> : null}
      {i18n.t("kernel.settingsPage.unsupported")}
    </div>
  )
}
