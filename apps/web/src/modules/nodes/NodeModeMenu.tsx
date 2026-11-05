// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE CHAT'S MODE PICKER (P4 N-D T6, S24, A24): the same question, the
// same rows and the same words as a desktop local session's
// (desktop/PermissionModeMenu), in the composer of a conversation that runs on
// the viewer's node, on the web, the phone or the desktop app.
//
// BYPASS IS NOT OFFERED. The chat is driven remotely: nobody is at the node to
// watch what a bypassed session does, the server refuses it (422
// bypass_unavailable_remote) and the node refuses it again. The mode is stored
// on the server with the thread's node runtime, so the next turn's job carries
// it; nothing changes under a job already running (F17).

import { Check, ChevronDown } from "lucide-solid"
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { NOTICE_MODE_NOT_CHANGED } from "~/modules/desktop/desktop-notices"
import { PERMISSION_MODE_ENTRIES } from "~/modules/desktop/PermissionModeMenu"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"
import {
  loadThreadNodeRuntime,
  myNodeRuntimeIn,
  NODE_CHAT_PERMISSION_MODES,
  type NodeChatPermissionMode,
  setThreadNodeRuntime,
} from "./thread-node-runtime"

export const NODE_MODE_CONTROL_LABEL = "kernel.nodes.chat.modeLabel"

const NODE_ENTRIES = PERMISSION_MODE_ENTRIES.filter((entry) =>
  (NODE_CHAT_PERMISSION_MODES as readonly string[]).includes(entry.mode),
)

const NodeModeMenu: Component<{ threadId?: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [open, setOpen] = createSignal(false)

  createEffect(
    on(
      () => props.threadId,
      (threadId) => {
        if (api && threadId) void loadThreadNodeRuntime(api, threadId)
      },
    ),
  )

  const runtime = () => myNodeRuntimeIn(props.threadId)
  const current = () =>
    NODE_ENTRIES.find((entry) => entry.mode === runtime()?.permissionMode) ?? NODE_ENTRIES[1]

  const choose = async (mode: NodeChatPermissionMode) => {
    const row = runtime()
    if (!api || !props.threadId || !row) return
    try {
      await setThreadNodeRuntime(api, props.threadId, {
        agentId: row.agentId,
        runsOn: row.runsOn,
        permissionMode: mode,
      })
    } catch {
      addToast({ message: i18n.t(NOTICE_MODE_NOT_CHANGED), type: "warning" })
    }
  }

  return (
    <Show when={runtime()}>
      <PopupMenu open={open()} onOpenChange={setOpen}>
        <PopupMenu.Trigger
          aria-label={i18n.t(NODE_MODE_CONTROL_LABEL)}
          data-testid="node-permission-mode-chip"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          {(() => {
            const Icon = current().icon
            return <Icon size={13} class="shrink-0" />
          })()}
          <span>{i18n.t(current().labelKey)}</span>
          <ChevronDown size={11} class="shrink-0" />
        </PopupMenu.Trigger>
        <PopupMenu.Content class="w-80" aria-label={i18n.t(NODE_MODE_CONTROL_LABEL)}>
          <PopupMenu.Group>
            <PopupMenu.Label>{i18n.t("kernel.permissionModesTitle")}</PopupMenu.Label>
          </PopupMenu.Group>
          <For each={NODE_ENTRIES}>
            {(entry) => {
              const Icon = entry.icon
              return (
                <PopupMenu.Item
                  onSelect={() => void choose(entry.mode as NodeChatPermissionMode)}
                  textValue={i18n.t(entry.labelKey)}
                  class="items-start"
                >
                  <Icon size={16} class="mt-0.5 shrink-0" />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="text-text">{i18n.t(entry.labelKey)}</span>
                    <span class="text-[11.5px] text-text-tertiary">{i18n.t(entry.hintKey)}</span>
                  </span>
                  <Show when={entry.mode === current().mode}>
                    <Check size={14} class="mt-0.5 shrink-0 text-accent" />
                  </Show>
                </PopupMenu.Item>
              )
            }}
          </For>
        </PopupMenu.Content>
      </PopupMenu>
    </Show>
  )
}

export default NodeModeMenu
