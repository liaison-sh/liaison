// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SIGNED-IN PHONE WHOSE SERVER DOES NOT ANSWER WAITS HERE, NOT ON /login.
//
// The phone app keeps its refresh token through a cold launch, so a launch
// with no network (or with the server down) is still a signed-in launch: only
// the server cannot be asked yet. ProtectedRoute used to send it to the
// sign-in page (the desktop's way to its address field, FX11), and on a phone
// that page is a sign-in form with two red lines, which reads as signed out.
// This screen says what is going on instead. The restore loop keeps asking
// behind it (auth-store.ts), so the app opens by itself once the server
// answers; Retry asks now, and the saved-servers block is the way out when the
// server is gone for good.

import { type Component, createSignal, Show } from "solid-js"
import { serverAddressOverride } from "~/lib/env"
import { retryRestore, serverUnreachable } from "~/modules/auth/auth-store"
import LoginServerChoice from "~/modules/auth/LoginServerChoice"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

function hostOf(raw: string | null): string {
  if (!raw) return ""
  try {
    return new URL(raw).host
  } catch {
    return raw
  }
}

/** Whether the retry the user asked for is still in flight (read by ProtectedRoute). */
const [retrying, setRetrying] = createSignal(false)
export const workspaceRetrying = retrying

export const WorkspaceUnreachable: Component = () => {
  const i18n = useI18n()
  const host = () => hostOf(serverAddressOverride())

  async function retry() {
    if (retrying()) return
    setRetrying(true)
    try {
      await retryRestore()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      data-testid="workspace-unreachable"
      class="flex min-h-screen flex-col items-center justify-center bg-bg px-6"
      style={{
        "padding-top": "max(24px, env(safe-area-inset-top))",
        "padding-bottom": "max(24px, env(safe-area-inset-bottom))",
      }}
    >
      <div class="flex w-full max-w-[360px] flex-col items-center gap-3 text-center">
        <h1 class="text-[17px] font-semibold text-text">
          {i18n.t("kernel.workspaceUnreachable.title")}
        </h1>
        <p role="status" class="text-[13px] text-text-secondary">
          {host()
            ? i18n.t("kernel.workspaceUnreachable.body", { host: host() })
            : i18n.t("kernel.workspaceUnreachable.bodyNoHost")}
        </p>
        <div class="mt-2 w-full">
          <Button
            fullWidth
            type="button"
            variant="outline"
            loading={retrying()}
            onClick={() => void retry()}
          >
            {i18n.t("kernel.common.retry")}
          </Button>
        </div>
        {/* Only once an attempt has failed: while one is in flight there is
            nothing to choose between yet. */}
        <Show when={serverUnreachable()}>
          <LoginServerChoice />
        </Show>
      </div>
    </div>
  )
}
