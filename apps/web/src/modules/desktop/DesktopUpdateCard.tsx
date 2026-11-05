// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE UPDATE THE SHELL IS INSTALLING, OVER THE WHOLE WINDOW.
//
// Once the user says yes to an update, the shell downloads it, installs it and
// restarts (the NSIS installer relaunches it on Windows). The only signs of that
// used to be the window title and the taskbar or dock progress, which users
// missed: they saw a window that stopped answering and closed it half way.
// So the page covers everything with one card, on EVERY screen (it is mounted
// at the app root, beside the router, so the login and connect steps get it
// too), for as long as the shell's `updateProgress` is set.
//
// It cannot be dismissed on purpose: there is nothing to go back to, and the
// window behind it is about to be replaced. The backdrop takes the pointer,
// the card takes the focus and keeps Tab and Escape.

import { type Component, createEffect, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { DesktopUpdateProgress } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import { desktopState, isDesktop } from "./desktop-store"

/** NORMATIVE. No dash punctuation. */
export const UPDATE_CARD_TITLE = "kernel.desktopUi.update.title"
export const UPDATE_CARD_DOWNLOADING = "kernel.desktopUi.update.downloading"
export const UPDATE_CARD_INSTALLING = "kernel.desktopUi.update.installing"
export const UPDATE_CARD_RESTART_NOTICE = "kernel.desktopUi.update.restartNotice"

const UpdateCardBody: Component<{ progress: DesktopUpdateProgress }> = (props) => {
  const i18n = useI18n()
  let card: HTMLDivElement | undefined
  createEffect(() => card?.focus())

  const installing = () => props.progress.phase === "installing"
  const percent = () => (installing() ? null : props.progress.percent)
  const status = () =>
    i18n.t(installing() ? UPDATE_CARD_INSTALLING : UPDATE_CARD_DOWNLOADING, {
      version: props.progress.version,
    })

  return (
    <div
      data-testid="desktop-update-backdrop"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-overlay-heavy p-4 backdrop-blur-sm"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-update-title"
        tabIndex={-1}
        data-testid="desktop-update-card"
        data-phase={props.progress.phase}
        onKeyDown={(event) => {
          if (event.key === "Tab" || event.key === "Escape") event.preventDefault()
        }}
        class="w-full max-w-md rounded-xl border border-border bg-elevated p-8 shadow-popover outline-none"
      >
        <h2 id="desktop-update-title" class="text-center text-xl font-semibold text-text">
          {i18n.t(UPDATE_CARD_TITLE)}
        </h2>
        <div role="status" aria-live="polite" class="mt-6 flex flex-col gap-3">
          <div class="flex items-baseline justify-between gap-3 text-sm">
            <span data-testid="desktop-update-status" class="font-medium text-text">
              {status()}
            </span>
            <Show when={percent() !== null}>
              <span data-testid="desktop-update-percent" class="tabular-nums text-text-secondary">
                {percent()}%
              </span>
            </Show>
          </div>
          <div
            role="progressbar"
            aria-label={status()}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent() ?? undefined}
            data-testid="desktop-update-bar"
            data-indeterminate={percent() === null ? "true" : undefined}
            class="relative h-2 w-full overflow-hidden rounded-full bg-surface-hover"
          >
            <Show
              when={percent() !== null}
              fallback={<div class="h-full w-full animate-pulse rounded-full bg-accent/60" />}
            >
              <div
                class="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${percent()}%` }}
              />
            </Show>
          </div>
          <Show when={installing()}>
            <p data-testid="desktop-update-restart" class="text-sm text-text-secondary">
              {i18n.t(UPDATE_CARD_RESTART_NOTICE)}
            </p>
          </Show>
        </div>
      </div>
    </div>
  )
}

const DesktopUpdateCard: Component = () => {
  const progress = () => (isDesktop() ? (desktopState().updateProgress ?? null) : null)
  return (
    <Show when={progress()}>
      {(current) => (
        <Portal>
          <UpdateCardBody progress={current()} />
        </Portal>
      )}
    </Show>
  )
}

export default DesktopUpdateCard
