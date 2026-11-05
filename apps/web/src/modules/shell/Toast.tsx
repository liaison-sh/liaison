// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { DecisionToasts } from "~/modules/approvals/DecisionToasts"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import { dismissToast, type Toast as ToastType, toasts } from "~/modules/shell/toast-store"

const borderColorMap: Record<ToastType["type"], string> = {
  success: "border-l-success",
  error: "border-l-error",
  warning: "border-l-warning",
  info: "border-l-accent",
}

const countdownColorMap: Record<ToastType["type"], string> = {
  success: "bg-success",
  error: "bg-error",
  warning: "bg-warning",
  info: "bg-accent",
}

const ToastItem: Component<{ toast: ToastType }> = (props) => {
  const i18n = useI18n()
  return (
    <div
      class={cn(
        "relative flex items-center gap-3 overflow-hidden rounded-md border border-border border-l-[3px] bg-elevated px-4 py-3 text-sm text-text shadow-popover",
        borderColorMap[props.toast.type],
      )}
      role="listitem"
      data-testid={`toast-${props.toast.type}`}
    >
      <span class="flex-1">{props.toast.message}</span>
      <Show when={props.toast.action}>
        {(action) => (
          <button
            type="button"
            class="shrink-0 rounded border border-border px-2 py-1 font-medium text-accent text-xs transition-colors hover:bg-hover"
            onClick={() => {
              action().onClick()
              dismissToast(props.toast.id)
            }}
          >
            {action().label}
          </button>
        )}
      </Show>
      <button
        type="button"
        class="text-text-tertiary hover:text-text transition-colors"
        onClick={() => dismissToast(props.toast.id)}
        aria-label={i18n.t("kernel.dismiss")}
      >
        ×
      </button>
      <Show when={props.toast.countdownMs}>
        {(ms) => (
          <div
            class={cn(
              "toast-countdown pointer-events-none absolute bottom-0 left-0 h-[3px] w-full",
              countdownColorMap[props.toast.type],
            )}
            style={{ "animation-duration": `${ms()}ms` }}
            data-testid="toast-countdown"
            aria-hidden="true"
          />
        )}
      </Show>
    </div>
  )
}

/** The phone tab bar's row (Shell.tsx `grid-template-rows`), plus a gap. */
const PHONE_TOAST_BOTTOM = "calc(56px + env(safe-area-inset-bottom, 0px) + 8px)"

export const ToastContainer: Component = () => {
  // On a phone the corner is the tab bar: a toast there hid Home / Chats /
  // Work for its whole life (an Undo window is 8 s). It rises above the bar
  // and spans the width instead.
  const phone = () => shellTier() === "phone"
  return (
    <div
      data-testid="toast-stack"
      data-tier={phone() ? "phone" : "wide"}
      class={cn("fixed z-50 flex flex-col gap-2", phone() ? "left-4 right-4" : "bottom-4 right-4")}
      style={phone() ? { bottom: PHONE_TOAST_BOTTOM } : undefined}
      aria-live="polite"
      aria-atomic="false"
    >
      <DecisionToasts />
      <For each={toasts()}>{(toast) => <ToastItem toast={toast} />}</For>
    </div>
  )
}
