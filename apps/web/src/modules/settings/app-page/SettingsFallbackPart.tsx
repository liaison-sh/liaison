// SPDX-License-Identifier: FSL-1.1-ALv2
// A part of a settings page this build cannot draw, standing in with the
// fallback its manifest gives (supported.ts): the app's line of text, and an
// "Open in browser" link to the server's own page for it (the fallback's href,
// else the app's settings page), opened outside the app.
import { ExternalLink } from "lucide-solid"
import type { Component } from "solid-js"
import { appSettingsHref } from "~/framework/define-app"
import { appLink } from "~/lib/share"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import type { SettingsBlockFallback } from "./supported"

/** The server URL a fallback opens: its path, an anchor on the settings page, or the page. */
export function settingsFallbackUrl(app: string, fallback: SettingsBlockFallback): string {
  const page = appSettingsHref(app)
  const href = fallback.href
  if (href === undefined) return appLink(page)
  return appLink(href.startsWith("#") ? `${page}${href}` : href)
}

export const SettingsFallbackPart: Component<{
  app: string
  fallback: SettingsBlockFallback
  label?: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <div
      data-testid="settings-fallback"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-sm text-text-secondary"
    >
      <span>
        {props.label ? <span class="font-medium text-text">{props.label}: </span> : null}
        {props.fallback.text}
      </span>
      <Button
        variant="outline"
        size="sm"
        data-testid="settings-fallback-open"
        onClick={() => void openExternal(settingsFallbackUrl(props.app, props.fallback))}
      >
        <ExternalLink size={14} aria-hidden="true" />
        {i18n.t("kernel.settingsPage.fallbackOpen")}
      </Button>
    </div>
  )
}
