// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T09: HOW THIS SESSION ASKS BEFORE IT ACTS, where the model already is.
//
// The overlay drew this as a row of four toggle buttons in a floating panel,
// a second time on every screen that panel covered. It is one menu now, a
// sibling of Attach in the composer's control row, in the same idiom as the
// model selector two elements along: the question "what may this run without
// asking" belongs next to "what is running it".
//
// BYPASS ASKS FIRST, and the confirmation says what STOPS happening rather
// than how dangerous it is. In Bypass the SDK stops calling `canUseTool`
// altogether, so the sidecar emits no permission request at all and there is
// nothing for the conversation to show. A user who turned it on still
// expecting prompts would read that silence as a broken prompt path.
//
// The four labels are spec.md's normative copy, moved from
// apps/desktop/src/session/desktop-copy.ts with no paraphrase.
//
// THE BYPASS QUESTION IS THE SHELL'S (P6d-FX1, SK-2). This menu used to draw
// its own confirmation dialog and then write the mode. A dialog drawn by the
// page is not a gate: the bridge method it guarded is on the window, so any
// script could call it and skip the question entirely, and what it wrote
// persisted into the next session. The shell asks instead, with its own native
// dialog naming the folder being handed over, and remembers nothing unless the
// answer was yes. So there is one question, asked by the half that can enforce
// it, and this menu only asks for the change: a refusal leaves the pill
// reading what the session is actually running in.

import { Check, ChevronDown, Code, Hand, NotebookPen, Sparkles, Waypoints } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import type { DesktopPermissionMode } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"
import { NOTICE_MODE_NOT_CHANGED } from "./desktop-notices"
import { desktopState, isDesktop, localSessionFor, setPermissionMode } from "./desktop-store"

/**
 * THE SAME WORDS AND THE SAME PICTURES CLAUDE USES. A person who has met this
 * question once, in Claude, must not have to learn it a second time here: the
 * menu is titled "Modes", every row carries the icon that names it there, a
 * one line description of what it does, and a tick on the one this session is
 * running in. Liaison has five modes and no effort dial, so the menu has five
 * rows and no slider: a control invented to match a picture would be a lie.
 *
 * AUTO IS FIRST AND IS THE DEFAULT: Liaison tools and everyday commands run
 * without a question, destructive ones still ask (sidecar/auto-policy.ts). A
 * business user should not have to click Allow for a read-only skill search.
 *
 * The words themselves are i18n keys, not literals: this menu is read in
 * French too.
 */
export const MODE_AUTO = "kernel.permissionModeAuto"
export const MODE_MANUAL = "kernel.permissionModeManual"
export const MODE_EDIT = "kernel.permissionModeEdit"
export const MODE_PLAN = "kernel.permissionModePlan"
export const MODE_BYPASS = "kernel.permissionModeBypass"

/** What the trigger is called, for the person who reaches it by keyboard. */
export const PERMISSION_MODE_CONTROL_LABEL = "kernel.desktopUi.permissionMode.controlLabel"

type ModeIcon = Component<{ size?: number; class?: string }>

export interface PermissionModeEntry {
  mode: DesktopPermissionMode
  labelKey: string
  hintKey: string
  icon: ModeIcon
}

/** Every mode's row, shared with the node chat's menu (modules/nodes/NodeModeMenu). */
export const PERMISSION_MODE_ENTRIES: PermissionModeEntry[] = [
  {
    mode: "auto",
    labelKey: MODE_AUTO,
    hintKey: "kernel.permissionModeAutoHint",
    icon: Sparkles as ModeIcon,
  },
  {
    mode: "manual",
    labelKey: MODE_MANUAL,
    hintKey: "kernel.permissionModeManualHint",
    icon: Hand as ModeIcon,
  },
  {
    mode: "edit",
    labelKey: MODE_EDIT,
    hintKey: "kernel.permissionModeEditHint",
    icon: Code as ModeIcon,
  },
  {
    mode: "plan",
    labelKey: MODE_PLAN,
    hintKey: "kernel.permissionModePlanHint",
    icon: NotebookPen as ModeIcon,
  },
  {
    mode: "bypass",
    labelKey: MODE_BYPASS,
    hintKey: "kernel.permissionModeBypassHint",
    icon: Waypoints as ModeIcon,
  },
]

interface PermissionModeMenuProps {
  /** The conversation this composer writes into. */
  threadId?: string
}

const PermissionModeMenu: Component<PermissionModeMenuProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)

  const live = () => localSessionFor(props.threadId ?? null, desktopState().agentId)
  const currentMode = () => desktopState().permissionMode
  const currentEntry = () =>
    PERMISSION_MODE_ENTRIES.find((entry) => entry.mode === currentMode()) ??
    PERMISSION_MODE_ENTRIES[0]

  // Nothing optimistic: the pill reads the state, and the state only moves
  // once the shell accepted the change. A refusal is SAID (P6d-FX2, SK-3):
  // the shell answers false for a declined bypass confirmation and for a mode
  // the running session would not take, and a pill that silently stays where
  // it was reads as a control that does nothing.
  const choose = async (mode: DesktopPermissionMode) => {
    const applied = await setPermissionMode(mode)
    if (!applied) addToast({ message: i18n.t(NOTICE_MODE_NOT_CHANGED), type: "warning" })
  }

  return (
    <Show when={isDesktop() && live()}>
      <PopupMenu open={open()} onOpenChange={setOpen}>
        <PopupMenu.Trigger
          aria-label={i18n.t(PERMISSION_MODE_CONTROL_LABEL)}
          data-testid="permission-mode-chip"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          {/* The chip says the WHOLE name, with the row's own icon beside it:
              "Bypass" alone is a verb with no object, and the icon is half of
              how this control is recognised. */}
          {(() => {
            const Icon = currentEntry().icon
            return <Icon size={13} class="shrink-0" />
          })()}
          <span>{i18n.t(currentEntry().labelKey)}</span>
          <ChevronDown size={11} class="shrink-0" />
        </PopupMenu.Trigger>

        <PopupMenu.Content class="w-80" aria-label={i18n.t(PERMISSION_MODE_CONTROL_LABEL)}>
          <PopupMenu.Group>
            <PopupMenu.Label>{i18n.t("kernel.permissionModesTitle")}</PopupMenu.Label>
          </PopupMenu.Group>
          <For each={PERMISSION_MODE_ENTRIES}>
            {(entry) => {
              const Icon = entry.icon
              return (
                <PopupMenu.Item
                  onSelect={() => void choose(entry.mode)}
                  textValue={i18n.t(entry.labelKey)}
                  class="items-start"
                >
                  <Icon size={16} class="mt-0.5 shrink-0" />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="text-text">{i18n.t(entry.labelKey)}</span>
                    <span class="text-[11.5px] text-text-tertiary">{i18n.t(entry.hintKey)}</span>
                  </span>
                  <Show when={entry.mode === currentMode()}>
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

export default PermissionModeMenu
