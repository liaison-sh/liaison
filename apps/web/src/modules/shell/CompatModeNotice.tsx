// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Some apps run in compatibility mode until you update Liaison", in the
// desktop or phone app (compat-mode-notice.ts). Calm and small, like the web
// update banner: it stays until the app is updated or the person says
// "Not now" (until the set of apps in compatibility mode changes).

import { type Component, createEffect, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type CompatNotice, compatNotice } from "~/modules/shell/compat-mode-notice"
import {
  SHELL_NOTICE_ACTION_CLASS,
  SHELL_NOTICE_CLASS,
  SHELL_NOTICE_DISMISS_CLASS,
  SHELL_NOTICE_HINT_CLASS,
} from "~/modules/shell/notice-styles"

const CompatModeNotice: Component<{ notice?: CompatNotice }> = (props) => {
  const i18n = useI18n()
  const model = () => props.notice ?? compatNotice()
  // A new set of apps in compatibility mode: the desktop shell checks for an update now.
  createEffect(() => model().sync())
  return (
    <Show when={model().notice()}>
      {(notice) => (
        <div role="status" data-testid="compat-mode-notice" class={SHELL_NOTICE_CLASS}>
          <span>{i18n.t("kernel.compatMode.message")}</span>
          <Show
            when={notice().shell === "desktop"}
            fallback={
              <span data-testid="compat-mode-store-hint" class={SHELL_NOTICE_HINT_CLASS}>
                {i18n.t("kernel.compatMode.storeHint")}
              </span>
            }
          >
            <Show when={notice().canCheck}>
              <button
                type="button"
                data-testid="compat-mode-check"
                onClick={() => model().checkForUpdates()}
                class={SHELL_NOTICE_ACTION_CLASS}
              >
                {i18n.t("kernel.compatMode.checkForUpdates")}
              </button>
            </Show>
          </Show>
          <button
            type="button"
            data-testid="compat-mode-dismiss"
            onClick={() => model().dismiss()}
            class={SHELL_NOTICE_DISMISS_CLASS}
          >
            {i18n.t("kernel.compatMode.dismiss")}
          </button>
        </div>
      )}
    </Show>
  )
}

export default CompatModeNotice
