// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX5 (W5): THE DEVICE GRANT A SIGNED IN WINDOW RAISES.
//
// The shell mints an agent scoped token for every local session, and when the
// stored one has expired that mint is a device grant: a code somebody has to
// approve in a browser. That is not a login. It happens to a user who is
// already signed in, in the middle of starting a session, and the only surface
// that ever drew the step was the LOGIN card, which a signed in window never
// shows. So the shell polled a code nobody could read, the session sat in
// `starting`, and the grant expired: the walk could only get past it by
// approving the code through the API by hand.
//
// It is a Dialog rather than a panel of its own, for the reason every other
// modal question in this app is: the app already has one way to ask something
// the user has to answer before anything else can happen, and a second visual
// language for it is the overlay's mistake repeated.
//
// THE SAME STEP, not a copy of it: `DeviceGrantStep` is the login card's own
// body, so the code, the link and the waiting line cannot drift between the
// two windows that show them.
//
// CANCEL RELEASES NOTHING, because nothing has been taken: the claim is made
// after the grant, so a start that is still waiting for a code holds no
// conversation. It takes the code off the state (through the shell, which owns
// it) and puts the runtime control back to idle, which is the state the user
// thinks they are in the moment they close this.

import { type Component, Show } from "solid-js"
import { accessToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { DEVICE_SESSION_PROMPT, DeviceGrantStep } from "./DesktopDeviceApproval"
import { clearDeviceApproval, desktopState, isDesktop } from "./desktop-store"

/** NORMATIVE. No dash punctuation (A7). */
export const DEVICE_APPROVAL_DIALOG_TITLE = "kernel.desktopUi.device.dialogTitle"
export const DEVICE_APPROVAL_CANCEL_ACTION = "kernel.desktopUi.device.cancel"

const DesktopDeviceApprovalDialog: Component = () => {
  const i18n = useI18n()
  /**
   * ONLY THE SIGNED IN WINDOW. The login card draws this step for the window
   * that has no session, and two drawings of one question on one screen is the
   * defect the login card's own step was consolidated to fix.
   */
  const uri = () => (isDesktop() && accessToken() ? desktopState().deviceApproval : null)

  return (
    <Show when={uri()}>
      {(verificationUri) => (
        <Dialog
          open={true}
          onOpenChange={(next) => {
            if (!next) clearDeviceApproval()
          }}
        >
          <Dialog.Content class="max-w-sm">
            <Dialog.Title class="text-center">{i18n.t(DEVICE_APPROVAL_DIALOG_TITLE)}</Dialog.Title>
            <div class="mt-5 flex flex-col gap-4">
              <DeviceGrantStep verificationUri={verificationUri()} prompt={DEVICE_SESSION_PROMPT} />
              <Button fullWidth variant="outline" onClick={() => clearDeviceApproval()}>
                {i18n.t(DEVICE_APPROVAL_CANCEL_ACTION)}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog>
      )}
    </Show>
  )
}

export default DesktopDeviceApprovalDialog
