// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The look of the shell's small update notices (CompatModeNotice,
// ClientVersionNotice): calm, at the bottom of the window, never a dialog.

export const SHELL_NOTICE_CLASS =
  "fixed bottom-4 left-1/2 z-[90] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-border bg-elevated px-4 py-2 text-sm text-text shadow-popover"

export const SHELL_NOTICE_ACTION_CLASS =
  "rounded-md border border-border px-3 py-1 text-sm font-medium text-text transition-colors hover:bg-surface-hover"

export const SHELL_NOTICE_DISMISS_CLASS =
  "rounded-md px-2 py-1 text-sm text-text-secondary transition-colors hover:text-text"

export const SHELL_NOTICE_HINT_CLASS = "text-text-secondary"
