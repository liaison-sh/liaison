// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A COMPUTER'S SETTINGS TAB: its name and workload (sessions at once, of
// which for others and routines; NodeSettingsEditor's bounds), "Ready to
// work" on this computer (its live checks, each with its fix or Turn off,
// and whether the OS lets Liaison read the places it looks in), whether chats
// started away from it may run in Auto (RemoteAutoRow), and Remove,
// which asks first: the computer's credential stops working at once.

import type { NodeFolderList } from "@liaison/shared"
import { useNavigate } from "@solidjs/router"
import { type Component, createEffect, createSignal, on, Show } from "solid-js"
import { serverAddressOverride } from "~/lib/env"
import { useI18n } from "~/modules/i18n/i18n-context"
import { deleteNode, type NodeSummary } from "~/modules/nodes/node-api"
import { nodeFolders } from "~/modules/nodes/node-folders-api"
import { setNodeSession } from "~/modules/nodes/node-session"
import { refetchNodes } from "~/modules/nodes/nodes-store"
import { NodeSettingsEditor } from "~/modules/settings/NodeSettingsEditor"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { ReadyChecks } from "./ComputerChecks"
import { COMPUTERS_ROUTE } from "./computer-model"
import { RemoteAutoRow } from "./RemoteAutoRow"
import type { ThisComputer } from "./this-computer"

const target = "min-h-[44px] sm:min-h-0"

export const ComputerSettingsTab: Component<{
  node: NodeSummary
  isThis: boolean
  tc: ThisComputer
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()
  const [removing, setRemoving] = createSignal(false)
  const [folders, setFolders] = createSignal<NodeFolderList | null>(null)

  // "Can read Documents": what this computer said about the places it looks in
  // (read once it is known to be this computer, which the shell says after mount).
  createEffect(
    on(
      () => props.isThis && props.node.online && props.node.enabled,
      (ready) => {
        if (!ready || folders()) return
        void nodeFolders(api, props.node.id)
          .then(setFolders)
          .catch(() => undefined)
      },
    ),
  )

  async function remove(): Promise<void> {
    try {
      await deleteNode(api, props.node.id)
      if (props.isThis) {
        // This computer is no computer of the viewer's any more: its copy goes too.
        const server = serverAddressOverride()
        if (server) await props.tc.shell?.storeNodeCredential?.(server, null).catch(() => undefined)
        setNodeSession(null)
      }
      setRemoving(false)
      await refetchNodes()
      navigate(COMPUTERS_ROUTE)
    } catch {
      addToast({ message: i18n.t("kernel.computers.actionFailed"), type: "error" })
    }
  }

  return (
    <div data-testid="computer-settings" class="flex flex-col gap-8">
      <section>
        <h2 class={`${sectionHeading} mb-4`}>{i18n.t("kernel.computers.settings.general")}</h2>
        <NodeSettingsEditor node={props.node} onSaved={() => void refetchNodes()} />
      </section>

      <Show when={props.isThis && props.tc.available}>
        <ReadyChecks tc={props.tc} os={props.node.os} denied={folders()?.search.denied ?? []} />
      </Show>

      <Show when={props.isThis && props.tc.shell?.setRemoteAuto ? props.tc.shell : null}>
        {(shell) => <RemoteAutoRow shell={shell()} />}
      </Show>

      <section
        data-testid="computer-remove-section"
        class="flex flex-col gap-3 border-t border-border-subtle pt-6 sm:flex-row sm:items-start sm:justify-between"
      >
        <div class="min-w-0">
          <p class="text-[13px] font-medium text-text">
            {i18n.t("kernel.computers.settings.removeTitle")}
          </p>
          <p class="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
            {i18n.t("kernel.computers.settings.removeBody")}
          </p>
        </div>
        <Button
          variant="outline"
          class={`w-full shrink-0 text-warning sm:w-auto ${target}`}
          data-testid={`computer-remove-${props.node.id}`}
          onClick={() => setRemoving(!removing())}
        >
          {i18n.t("kernel.computers.settings.removeButton", { name: props.node.name })}
        </Button>
      </section>
      <Show when={removing()}>
        <div
          data-testid={`computer-remove-confirm-box-${props.node.id}`}
          class="-mt-4 flex flex-col gap-3 rounded-md border border-warning-border bg-warning-glow px-4 py-3"
        >
          <p
            data-testid={`computer-remove-confirm-text-${props.node.id}`}
            class="text-[13px] leading-relaxed text-text"
          >
            {i18n.t("kernel.computers.settings.removeConfirm", { name: props.node.name })}
          </p>
          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              class={target}
              data-testid={`computer-remove-cancel-${props.node.id}`}
              onClick={() => setRemoving(false)}
            >
              {i18n.t("kernel.nodeSessions.confirm.cancel")}
            </Button>
            <Button
              class={target}
              data-testid={`computer-remove-confirm-${props.node.id}`}
              onClick={() => void remove()}
            >
              {i18n.t("kernel.computers.settings.removeConfirmButton")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}
