// SPDX-License-Identifier: FSL-1.1-ALv2
// A custom block: an export of the app's own UI bundle, rendered inline in the
// page. The export comes from the app's export bag (the in-tree module, the
// loaded bundle, or, in a desktop or mobile shell, the isolated-frame proxy
// that renders it in a sandboxed frame), so a third-party bundle never runs in
// the page itself there. A missing export shows an admin an error card and is
// logged; everyone else sees nothing (P2-20). In a shell the proxy cannot tell
// a missing export up front: the frame reports it and the isolated view shows
// the same card (MissingExportNotice).
import { type Component, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { MissingExportNotice } from "~/framework/MissingExportNotice"
import { PluginMountBoundary } from "~/framework/PluginMountBoundary"
import type { SettingsCustomBlock } from "./types"

export const CustomBlock: Component<{
  app: string
  block: SettingsCustomBlock
  exports?: Record<string, unknown>
}> = (props) => {
  const resolved = (): Component | null => {
    const bag = props.exports
    const c = bag ? bag[props.block.component] : undefined
    if (typeof c === "function") return c as Component
    console.error(
      `App "${props.app}": settings custom block "${props.block.component}" is not exported by its UI bundle`,
    )
    return null
  }
  return (
    <Show when={resolved()} fallback={<MissingExportNotice name={props.block.component} />}>
      {(component) => (
        <div data-testid={`settings-custom-${props.block.component}`}>
          <PluginMountBoundary appName={props.app}>
            <Dynamic component={component()} />
          </PluginMountBoundary>
        </div>
      )}
    </Show>
  )
}
