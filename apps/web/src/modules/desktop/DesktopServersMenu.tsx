// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVER SWITCHER IN THE SIDEBAR, on the desktop only.
//
// Every saved server with a check on the current one, then "Add a server...",
// the way a workspace switcher reads. The list and every action are the
// shell's (`DesktopBridge.servers`, apps/desktop session/desktop-servers.ts):
// choosing another server starts the page again on it, and "Add a server..."
// opens the connect step (`DesktopConnectDialog`) where the address is typed
// and checked.
//
// The shell draws no Account menu on any OS, so this and the servers group in
// Settings are the switcher.
//
// A browser, and a shell that publishes no servers, get nothing at all.

import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Check, Server } from "lucide-solid"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import type { DesktopServers } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import { serverLabel } from "~/modules/settings/NativeServersSection"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"
import { desktopServers } from "./desktop-store"

const ROW =
  "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:text-text"

const ServersMenu: Component<{ servers: DesktopServers; buttonClass?: string }> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  // Read again every time the menu opens: the list changes from Settings and
  // from a connect link while this one is closed.
  const [snapshot] = createResource(
    () => (open() ? true : undefined),
    () => props.servers.list(),
  )
  const current = () => snapshot()?.current ?? null

  async function switchTo(address: string): Promise<void> {
    if (address === current()) return
    try {
      await props.servers.switchTo(address)
    } catch {
      addToast({ message: i18n.t("kernel.servers.switchFailed"), type: "error" })
    }
  }

  return (
    <PopupMenu open={open()} onOpenChange={setOpen} placement="right-end">
      <Tooltip placement="right" content={i18n.t("kernel.servers.heading")}>
        <PopupMenu.Trigger
          aria-label={i18n.t("kernel.servers.heading")}
          data-testid="activity-servers"
          class={props.buttonClass}
        >
          <Server size={18} />
        </PopupMenu.Trigger>
      </Tooltip>
      <PopupMenu.Content
        aria-label={i18n.t("kernel.servers.heading")}
        data-testid="servers-menu"
        class="w-64"
      >
        <div
          role="presentation"
          class="px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"
        >
          {i18n.t("kernel.servers.heading")}
        </div>
        <DropdownMenu.RadioGroup
          value={current() ?? ""}
          onChange={(address: string) => void switchTo(address)}
        >
          <For each={snapshot()?.servers ?? []}>
            {(server) => (
              <DropdownMenu.RadioItem
                value={server.address}
                data-testid="servers-menu-row"
                class={ROW}
              >
                <span class="min-w-0 flex-1 truncate">{serverLabel(server)}</span>
                <DropdownMenu.ItemIndicator class="shrink-0 text-accent">
                  <Check size={14} aria-label={i18n.t("kernel.servers.currentServer")} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            )}
          </For>
        </DropdownMenu.RadioGroup>
        <Show when={props.servers.beginAdd}>
          <PopupMenu.Separator />
          <PopupMenu.Item
            data-testid="servers-menu-add"
            onSelect={() => props.servers.beginAdd?.()}
          >
            {i18n.t("kernel.servers.addServerEllipsis")}
          </PopupMenu.Item>
        </Show>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

/** The switcher, or nothing outside a desktop shell that published servers. */
const DesktopServersMenu: Component<{ buttonClass?: string }> = (props) => {
  return (
    <Show when={desktopServers()}>
      {(servers) => <ServersMenu servers={servers()} buttonClass={props.buttonClass} />}
    </Show>
  )
}

export default DesktopServersMenu
