// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T15, step two: APPROVE THIS DEVICE.
//
// It REPLACES the address step in the same card at the same width. The walk
// caught both panels on screen at once, one drawn full screen behind the
// other, which is two questions asked simultaneously with no way to tell which
// one the app is waiting on.
//
// There is no fetch here at all. The shell mints the grant, polls it, and
// drops the code when it stops waiting (FX10); this renders what the bridge
// reports and nothing else. A webview running its own initiate and poll would
// mint a SECOND device code for a grant the shell has already started.
//
// THE LINK IS SANITIZED (P6d-FX1, SK-10). The verification URI comes from the
// device grant response of whatever server this install is bound to, and on a
// desktop that address is typed by the user (DesktopConnect accepts any http(s)
// origin). It was rendered raw, so a `javascript:` URI would have executed on
// click. It goes through the same `isSafeUserUrl` the agent's own markdown
// links go through; the code and the rest of the step still render, because a
// user who can read the code can still finish in a browser they opened.

import { type Component, Show } from "solid-js"
import { isSafeUserUrl } from "~/lib/sanitize"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import {
  canOpenDeviceApproval,
  desktopState,
  isDesktop,
  openDeviceApprovalPage,
} from "./desktop-store"

/** NORMATIVE, spec.md's "User-facing copy" table. Do not paraphrase. */
export const DEVICE_LOGIN_PROMPT = "kernel.desktopUi.device.loginPrompt"
export const DEVICE_LOGIN_CODE_LABEL = "kernel.desktopUi.device.codeLabel"
export const DEVICE_LOGIN_OPEN_ACTION = "kernel.desktopUi.device.openApprovalPage"
export const DEVICE_LOGIN_WAITING = "kernel.desktopUi.device.waiting"
/** The same step over a signed in window: a conversation is waiting on it. */
export const DEVICE_SESSION_PROMPT = "kernel.desktopUi.device.sessionPrompt"

/** The way back to step one, for a code that was minted against the wrong server. */
export const USE_DIFFERENT_SERVER_ACTION = "kernel.desktopUi.device.useDifferentServer"

/**
 * The user code carried by a verification URI, or null.
 *
 * The server builds that URI as `<base>/auth/device?code=<userCode>`, and the
 * code is what a user reads off this screen and matches in the browser. A URI
 * shaped any other way still gets its link: the code is an aid, never the
 * mechanism.
 */
export function userCodeFrom(verificationUri: string): string | null {
  try {
    return new URL(verificationUri).searchParams.get("code") || null
  } catch {
    return null
  }
}

/**
 * THE STEP ITSELF, with no card and no dialog around it (P6d-FX5, W5).
 *
 * A grant is raised whenever a local session needs an agent scoped token, and
 * that is not only on a login: a user who is already signed in and starts a
 * session on this machine gets one too. This step used to be drawn ONLY inside
 * the login card, which a signed in window never shows, so the shell polled a
 * code the user could not read and the session sat in `starting` until the
 * grant expired. The same step is now drawn in the app's own Dialog for that
 * window (`DesktopDeviceApprovalDialog.tsx`), which is why the body is a
 * component of its own: two drawings of one question is how they drift.
 */
export const DeviceGrantStep: Component<{ verificationUri: string; prompt?: string }> = (props) => {
  const i18n = useI18n()
  return (
    <div class="flex flex-col gap-4">
      <p class="text-center text-[13px] text-text-secondary">
        {i18n.t(props.prompt ?? DEVICE_LOGIN_PROMPT)}
      </p>
      <Show when={userCodeFrom(props.verificationUri)}>
        {(code) => (
          <div class="flex flex-col items-center gap-1">
            <p class="text-[12.5px] text-text-secondary">{i18n.t(DEVICE_LOGIN_CODE_LABEL)}</p>
            <p
              data-testid="device-approval-code"
              class="font-mono text-[20px] font-semibold tracking-[0.18em] text-text"
            >
              {code()}
            </p>
          </div>
        )}
      </Show>
      {/*
        THROUGH THE SHELL when it can: a `target=_blank` link does nothing in
        the desktop webview, so the button that was the only way to the
        approval page opened nothing. The link stays for a shell without the
        command.
      */}
      <Show when={isSafeUserUrl(props.verificationUri)}>
        <Show
          when={canOpenDeviceApproval()}
          fallback={
            <a
              href={props.verificationUri}
              target="_blank"
              rel="noreferrer"
              class="w-full rounded-sm bg-accent px-4 py-[10px] text-center text-[13.5px] font-semibold text-bg transition-colors duration-150 hover:bg-accent-hover"
            >
              {i18n.t(DEVICE_LOGIN_OPEN_ACTION)}
            </a>
          }
        >
          <button
            type="button"
            data-testid="device-approval-open"
            onClick={() => void openDeviceApprovalPage(props.verificationUri)}
            class="w-full rounded-sm bg-accent px-4 py-[10px] text-center text-[13.5px] font-semibold text-bg transition-colors duration-150 hover:bg-accent-hover"
          >
            {i18n.t(DEVICE_LOGIN_OPEN_ACTION)}
          </button>
        </Show>
      </Show>
      <p class="text-center text-[12.5px] text-text-tertiary">{i18n.t(DEVICE_LOGIN_WAITING)}</p>
    </div>
  )
}

interface DesktopDeviceApprovalProps {
  onUseDifferentServer: () => void
}

const DesktopDeviceApproval: Component<DesktopDeviceApprovalProps> = (props) => {
  const i18n = useI18n()
  const uri = () => (isDesktop() ? desktopState().deviceApproval : null)

  return (
    <Show when={uri()}>
      {(verificationUri) => (
        <div class="flex flex-col gap-4">
          <DeviceGrantStep verificationUri={verificationUri()} />
          <Button fullWidth variant="outline" onClick={() => props.onUseDifferentServer()}>
            {i18n.t(USE_DIFFERENT_SERVER_ACTION)}
          </Button>
        </div>
      )}
    </Show>
  )
}

export default DesktopDeviceApproval
