// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "This server needs a newer version of Liaison", in the desktop or phone app
// whose version is older than the oldest the server supports
// (lib/client-version.ts). The text and the action are the app's own:
//
// - Desktop: "Check for updates" runs the shell's update check, as the menu
//   does. Nothing installs without a yes.
// - Phone: a sentence naming the store the app came from.
// - At or above the minimum, and in a browser tab, nothing.
//
// "Not now" hides it until the app is opened again.

import { type Component, createSignal, Show } from "solid-js"
import { type ClientPolicy, clientPolicy } from "~/lib/client-version"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  SHELL_NOTICE_ACTION_CLASS,
  SHELL_NOTICE_CLASS,
  SHELL_NOTICE_DISMISS_CLASS,
  SHELL_NOTICE_HINT_CLASS,
} from "~/modules/shell/notice-styles"

/** The desktop shell's manual update check, or null where there is none. */
function desktopUpdateCheck(): (() => void) | null {
  const run = getDesktopBridge()?.checkForUpdates
  if (typeof run !== "function") return null
  return () => {
    void run({ manual: true }).catch(() => undefined)
  }
}

const ClientVersionNotice: Component<{
  policy?: ClientPolicy
  /** Undefined: the desktop shell's own check. Null: none. */
  checkForUpdates?: (() => void) | null
}> = (props) => {
  const i18n = useI18n()
  const [dismissed, setDismissed] = createSignal(false)
  const policy = () => props.policy ?? clientPolicy()
  const check = () =>
    props.checkForUpdates === undefined ? desktopUpdateCheck() : props.checkForUpdates
  const platform = () => (dismissed() ? null : policy().belowMinimum())
  return (
    <Show when={platform()}>
      {(below) => (
        <div role="status" data-testid="client-version-notice" class={SHELL_NOTICE_CLASS}>
          <span>{i18n.t("kernel.clientVersion.message")}</span>
          <Show
            when={below() === "desktop"}
            fallback={
              <span data-testid="client-version-store-hint" class={SHELL_NOTICE_HINT_CLASS}>
                {below() === "ios"
                  ? i18n.t("kernel.clientVersion.appStore")
                  : i18n.t("kernel.clientVersion.googlePlay")}
              </span>
            }
          >
            <Show when={check()}>
              {(run) => (
                <button
                  type="button"
                  data-testid="client-version-check"
                  onClick={() => run()()}
                  class={SHELL_NOTICE_ACTION_CLASS}
                >
                  {i18n.t("kernel.clientVersion.checkForUpdates")}
                </button>
              )}
            </Show>
          </Show>
          <button
            type="button"
            data-testid="client-version-dismiss"
            onClick={() => setDismissed(true)}
            class={SHELL_NOTICE_DISMISS_CLASS}
          >
            {i18n.t("kernel.clientVersion.dismiss")}
          </button>
        </div>
      )}
    </Show>
  )
}

export default ClientVersionNotice
