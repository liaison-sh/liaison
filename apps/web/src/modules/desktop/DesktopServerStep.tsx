// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH SCREEN ASKS FOR THE SERVER: Liaison Cloud, or a server address.
//
// A first launch (no server bound) opens on the Cloud screen when the build
// names a cloud (`LIAISON_CLOUD_DOMAIN`, packages/shared/src/cloud-workspace.ts),
// with "Use a self-hosted server" one click away. A connect link decides by
// its address: a workspace of the cloud lands on the Cloud screen, any other
// address on the address screen, both prefilled and confirmed. Everything
// else that asks for a server ("Add a server...", a bound server that stopped
// answering) keeps the address screen it had, with "Use Liaison Cloud" under
// it. A build with no cloud never shows the Cloud screen at all.

import { buildCloudDomain, workspaceSlugFromAddress } from "@liaison/shared"
import { type Component, createEffect, createSignal, on, Show } from "solid-js"
import DesktopCloudConnect from "./DesktopCloudConnect"
import DesktopConnect from "./DesktopConnect"
import { desktopState, serverAddress } from "./desktop-store"

export interface DesktopServerStepProps {
  onCancel?: () => void
  /** The cloud domain; the build's own when omitted, null for none. */
  cloudDomain?: string | null
}

const DesktopServerStep: Component<DesktopServerStepProps> = (props) => {
  const domain = () => (props.cloudDomain === undefined ? buildCloudDomain() : props.cloudDomain)
  const [chosen, setChosen] = createSignal<"cloud" | "address" | null>(null)

  const proposed = (): "cloud" | "address" => {
    const cloud = domain()
    if (!cloud) return "address"
    const linked = desktopState().deepLinkAddress
    if (linked) return workspaceSlugFromAddress(linked, cloud) ? "cloud" : "address"
    if (serverAddress() === null && desktopState().addingServer !== true) return "cloud"
    return "address"
  }
  // A new connect link decides again, over whatever was clicked before it.
  createEffect(
    on(
      () => desktopState().deepLinkAddress,
      () => setChosen(null),
      { defer: true },
    ),
  )
  const mode = () => (domain() ? (chosen() ?? proposed()) : "address")

  return (
    <Show
      when={mode() === "cloud" ? domain() : null}
      fallback={
        <DesktopConnect
          onCancel={props.onCancel}
          onUseCloud={domain() ? () => setChosen("cloud") : undefined}
        />
      }
    >
      {(cloud) => (
        <DesktopCloudConnect
          domain={cloud()}
          onCancel={props.onCancel}
          onSelfHosted={() => setChosen("address")}
        />
      )}
    </Show>
  )
}

export default DesktopServerStep
