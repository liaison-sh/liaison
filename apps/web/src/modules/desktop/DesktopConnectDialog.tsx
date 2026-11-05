// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CONNECT STEP OVER A SIGNED IN WINDOW.
//
// The desktop keeps several servers and moves between them from the page's
// own servers UI. Two things ask for a new one while somebody is signed in:
// its "Add a server...", which opens this step to ask for the address,
// and a `liaison://connect` link, whose address is shown and confirmed rather
// than applied (FX1). The login card's first step used to be the only place
// that question was drawn, and a signed in window never shows it.
//
// THE SAME STEP, not a copy of it: `DesktopConnect` is the login card's own
// body, so the field, the refusals and the confirmation for a linked address
// cannot drift between the two windows that show them. Connecting switches the
// whole window (the shell stops the local session and nothing of this server
// reaches the next); cancelling applies nothing.

import { type Component, Show } from "solid-js"
import { accessToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Dialog } from "~/ui/Dialog"
import DesktopConnect from "./DesktopConnect"
import { desktopState, dismissConnect, isDesktop } from "./desktop-store"

/** NORMATIVE. No dash punctuation (A7). */
export const CONNECT_DIALOG_TITLE = "kernel.servers.connectDialogTitle"

const DesktopConnectDialog: Component = () => {
  const i18n = useI18n()
  /**
   * ONLY THE SIGNED IN WINDOW, and never over a device approval: the login
   * card draws this step for a window with no session, and one question at a
   * time is the rule the login card's own steps follow.
   */
  const open = () => {
    if (!isDesktop() || !accessToken()) return false
    const state = desktopState()
    if (state.deviceApproval) return false
    return state.addingServer === true || Boolean(state.deepLinkAddress)
  }

  return (
    <Show when={open()}>
      <Dialog
        open={true}
        onOpenChange={(next) => {
          if (!next) dismissConnect()
        }}
      >
        <Dialog.Content class="max-w-sm">
          <Dialog.Title class="text-center">{i18n.t(CONNECT_DIALOG_TITLE)}</Dialog.Title>
          <div class="mt-5">
            <DesktopConnect onCancel={dismissConnect} />
          </div>
        </Dialog.Content>
      </Dialog>
    </Show>
  )
}

export default DesktopConnectDialog
