// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * SlotPanels — mounts the panels contributed to a named slot.
 *
 * Phase 17, Task B10. Used by host pages (contact_detail today, the invoicing
 * document_detail page later) to expose an extension point that other apps
 * contribute panels to via their manifest `slots.<slot>.panels[]` entries.
 *
 * Data flow:
 *   1. `GET /api/v1/slots/:slot` returns the visibility-filtered panel list
 *      from the server (see apps/api/src/modules/slots/registry.ts).
 *   2. For each returned panel `{ app, id, label }`, we look up the resolved
 *      component in the local contribution registry by `(app, id)`. The
 *      contribution registry is populated by `registerAppFromManifest` at
 *      bootstrap time when the manifest declares
 *      `slots.<slot>.panels[].component`.
 *   3. Mount each component. A bundle-load failure for a particular panel
 *      surfaces as a "Panel unavailable" placeholder; an empty enumeration
 *      renders nothing (no skeleton noise) per Convention Reminders.
 */

import { type Component, createResource, For, Show } from "solid-js"
import { getContributions } from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface ServerPanel {
  id: string
  app: string
  label: string
  component: string
  order?: number
  visibility_scope?: string
}

interface SlotPanelsProps {
  slot: string
  /**
   * The entity id passed through to each mounted panel — e.g. the contact id
   * for the `contact_detail` slot. Forwarded as `entityId` prop to match the
   * existing `ContributionEntry.component` signature.
   */
  entityId?: string
}

async function fetchSlotPanels(
  api: ReturnType<typeof useApi>,
  slot: string,
): Promise<ServerPanel[]> {
  // Paths are relative to the API base (`/api` by default — see ~/lib/env).
  // Hitting `/v1/slots/:slot` resolves to `/api/v1/slots/:slot` on the wire.
  // `api.get<T>` unwraps the `{ data }` envelope and returns `T` directly
  // (see parseSuccessResponse in ~/lib/api-client).
  const res = await api.get<{ panels: ServerPanel[] }>(`/v1/slots/${slot}`)
  return res.panels
}

export const SlotPanels: Component<SlotPanelsProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [panels] = createResource(
    () => props.slot,
    (slot) => fetchSlotPanels(api, slot),
  )

  function resolveComponent(p: ServerPanel) {
    const contributions = getContributions(props.slot)
    return contributions.find((c) => c.appId === p.app && c.id === p.id)?.component
  }

  return (
    <Show when={panels()} fallback={null}>
      {(list) => (
        <Show when={list().length > 0} fallback={null}>
          <div data-testid={`slot-panels-${props.slot}`}>
            <For each={list()}>
              {(p) => {
                const Comp = resolveComponent(p)
                return (
                  <Show
                    when={Comp}
                    fallback={
                      <div
                        data-testid={`slot-panel-unavailable-${p.app}-${p.id}`}
                        class="text-sm text-text-tertiary"
                      >
                        {i18n.t("kernel.shellUi.panelUnavailable")}
                      </div>
                    }
                  >
                    {(C) => {
                      const Resolved = C()
                      return <Resolved entityId={props.entityId} />
                    }}
                  </Show>
                )
              }}
            </For>
          </div>
        </Show>
      )}
    </Show>
  )
}
