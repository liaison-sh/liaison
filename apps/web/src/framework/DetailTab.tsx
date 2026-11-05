// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16.6 — Generic detail-panel tab content.
//
// The kernel registers a single `detail` tab type whose `entityId` is
// "<appName>/<entity>/<id>". This component parses that, resolves the
// matching panel from the registry (`namespaceRegistryKey(appName,
// "detail:" + entity)`), and mounts it inside `<PluginMountBoundary>` so a
// plugin crash doesn't blank the host page.
//
// The `<id>` segment is percent-encoded by the link builders (list/home views
// `encodeURIComponent` it because GIDs contain `:` and `/`). We
// `decodeURIComponent` it here before handing it to the panel so the panel's
// read tool receives the real GID (`gid://shopify/Order/123`) rather than the
// still-encoded `gid%3A%2F%2F…`, which the GraphQL `ID!` scalar rejects.
//
// Some entities need a secondary id: a `refund` is addressed by its parent
// `orderId` *and* its own id. Those are encoded into the id segment as
// "<orderId>:<refundId>" (each part individually percent-encoded) and split
// back out here so the panel can resolve and deep-link the refund.
import { type Component, Show } from "solid-js"
import { getPanel, namespaceRegistryKey } from "~/framework/app-registry"
import { PluginMountBoundary } from "~/framework/PluginMountBoundary"

export interface DetailTabProps {
  entityId: string
}

interface DetailPanelProps {
  // Panels resolve the real store subdomain themselves via the host bridge;
  // `shop` is only an optional fallback (and is intentionally not the literal
  // app name — see CLUSTER 7 of the deep review).
  shop?: string
  id: string
  orderId?: string
}

export const DetailTab: Component<DetailTabProps> = (props) => {
  const parts = () => props.entityId.split("/")
  const ok = () => parts().length === 3 && parts().every((p) => p.length > 0)
  const appName = () => parts()[0]
  const entity = () => parts()[1]
  // Raw (still-encoded) id segment as it appears in the URL.
  const rawId = () => parts()[2]
  // Decoded ids. For composite entities (refund) the segment is
  // "<orderId>:<refundId>" where each half is individually
  // `encodeURIComponent`-ed. `encodeURIComponent` escapes `:` to `%3A`, so a
  // *literal* colon can only be the separator we inserted — never a colon
  // inside an encoded GID. We therefore split on the literal `:` and decode
  // each half. (Splitting on the encoded `%3A` would wrongly fire on the `:`
  // inside `gid://…`.)
  const decoded = () => {
    const raw = rawId()
    const colon = raw.indexOf(":")
    if (entity() === "refund" && colon !== -1) {
      return {
        id: decodeURIComponent(raw.slice(colon + 1)),
        orderId: decodeURIComponent(raw.slice(0, colon)),
      }
    }
    return { id: decodeURIComponent(raw), orderId: undefined as string | undefined }
  }
  const panel = () => getPanel(namespaceRegistryKey(appName(), `detail:${entity()}`))

  return (
    <Show
      when={ok()}
      fallback={<div data-testid="detail-tab-invalid">invalid entityId: {props.entityId}</div>}
    >
      <Show
        when={panel()}
        fallback={
          <div data-testid={`detail-tab-not-found-${appName()}-${entity()}`}>
            Detail panel not found: {appName()} / {entity()}
          </div>
        }
      >
        {(p) => {
          const PanelComponent = p().component as Component<DetailPanelProps>
          return (
            <PluginMountBoundary appName={appName()}>
              <PanelComponent id={decoded().id} orderId={decoded().orderId} />
            </PluginMountBoundary>
          )
        }}
      </Show>
    </Show>
  )
}

export default DetailTab
