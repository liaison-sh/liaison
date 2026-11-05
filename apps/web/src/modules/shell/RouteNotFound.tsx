// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the main panel shows for an address no page answers: a route of an app
// that is not installed, or a mistyped link. Without it the previous tab stayed
// on screen under the new address, as if the link had opened it.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

export const RouteNotFound: Component<{ onHome: () => void }> = (props) => {
  const i18n = useI18n()
  return (
    <div
      class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-surface p-8 text-center"
      data-testid="route-not-found"
    >
      <p class="text-sm font-medium text-text">{i18n.t("kernel.shellUi.routeNotFound")}</p>
      <p class="max-w-md text-xs text-text-secondary">
        {i18n.t("kernel.shellUi.routeNotFoundDetail")}
      </p>
      <Button
        variant="outline"
        size="sm"
        class="mt-2"
        data-testid="route-not-found-home"
        onClick={() => props.onHome()}
      >
        {i18n.t("kernel.shellUi.routeNotFoundHome")}
      </Button>
    </div>
  )
}
