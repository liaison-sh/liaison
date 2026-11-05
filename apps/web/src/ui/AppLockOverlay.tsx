// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The screen in front of a locked workspace.
//
// It COVERS rather than replaces. The app underneath stays mounted: a lock
// that unmounted the tree would drop every open tab, every scroll position and
// every unsent draft the moment a phone spent five minutes in a pocket, and
// the user would pay for the lock in work rather than in a glance.
//
// Opaque, not translucent: the point is that the workspace cannot be read.
//
// `ui/` owns no strings, so every label comes from the caller.
import { type Component, createSignal, Show } from "solid-js"
import { cn } from "~/lib/cn"

export interface AppLockOverlayProps {
  locked: boolean
  /** Runs the biometric. Resolves false when it was refused or failed. */
  onUnlock: () => Promise<boolean>
  title: string
  unlockLabel: string
  /** Shown after an attempt that did not succeed. */
  failedLabel: string
  class?: string
}

export const AppLockOverlay: Component<AppLockOverlayProps> = (props) => {
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  async function attempt(): Promise<void> {
    if (busy()) return
    setBusy(true)
    setFailed(false)
    try {
      const ok = await props.onUnlock()
      // A refusal is shown, never retried on its own: a loop that re-prompts
      // is how a platform decides an app is abusing the sensor.
      if (!ok) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.locked}>
      <div
        data-testid="app-lock-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        class={cn(
          "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-bg px-8",
          props.class,
        )}
      >
        <p class="text-center text-[17px] font-semibold text-text">{props.title}</p>
        <button
          type="button"
          data-testid="app-lock-unlock"
          disabled={busy()}
          onClick={() => void attempt()}
          class="flex min-h-11 items-center justify-center rounded-md bg-accent px-6 text-[15px] font-medium text-accent-foreground disabled:opacity-60"
        >
          {props.unlockLabel}
        </button>
        <Show when={failed()}>
          <p data-testid="app-lock-failed" role="status" class="text-[13px] text-text-secondary">
            {props.failedLabel}
          </p>
        </Show>
      </div>
    </Show>
  )
}
