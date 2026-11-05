// SPDX-License-Identifier: FSL-1.1-ALv2
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import type { JSX } from "solid-js"
import { type ParentComponent, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

interface DialogRootProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Defaults to Kobalte's own `true`. A NON-modal dialog keeps the rest of
   *  the page interactive: no focus trap, no scroll lock, no `aria-hidden` on
   *  everything outside it. The tablet sidebar drawer is the one surface that
   *  needs it, because the activity rail it opened from stays beside it and
   *  has to keep taking taps and Tab stops. */
  modal?: boolean
}

const DialogRoot: ParentComponent<DialogRootProps> = (props) => {
  const [local, others] = splitProps(props, ["children"])
  return (
    <KobalteDialog
      open={others.open}
      onOpenChange={others.onOpenChange}
      modal={others.modal ?? true}
    >
      {local.children}
    </KobalteDialog>
  )
}

interface DialogContentProps {
  class?: string
  style?: JSX.CSSProperties
  overlayClass?: string
  /** Inline geometry for the scrim. A class cannot express "start where the
   *  activity rail ends" without fighting `inset-0` on equal specificity. */
  overlayStyle?: JSX.CSSProperties
  /** Test hook on the scrim, for the surfaces whose scrim is itself a control
   *  (tap the dimmed content area to dismiss). */
  overlayTestId?: string
  positionerClass?: string
  /** Forwarded to Kobalte's Dialog.Content — a non-modal dialog stays open when
   *  the interaction outside it was aimed at a surface that owns it (the
   *  activity rail beside the tablet drawer). */
  onInteractOutside?: (e: { detail: { originalEvent: Event } } & Event) => void
  /** Forwarded to Kobalte's Dialog.Content — consumers (ImageLightbox) override
   *  the default focus handoff on open/close. */
  onOpenAutoFocus?: (e: Event) => void
  onCloseAutoFocus?: (e: Event) => void
}

const DialogContent: ParentComponent<DialogContentProps> = (props) => {
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "overlayClass",
    "overlayStyle",
    "overlayTestId",
    "positionerClass",
  ])

  return (
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay
        data-testid={local.overlayTestId}
        style={local.overlayStyle}
        class={cn(
          "fixed inset-0 z-50 bg-overlay-heavy backdrop-blur-sm transition-opacity duration-150",
          local.overlayClass,
        )}
      />
      <div
        class={cn("fixed inset-0 z-50 flex items-center justify-center p-4", local.positionerClass)}
      >
        <KobalteDialog.Content
          {...others}
          class={cn(
            "w-full max-w-md rounded-xl border border-border bg-elevated p-6 shadow-popover",
            local.class,
          )}
        >
          {local.children}
        </KobalteDialog.Content>
      </div>
    </KobalteDialog.Portal>
  )
}

const DialogTitle: ParentComponent<{ class?: string }> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"])
  return (
    <KobalteDialog.Title class={cn("text-lg font-semibold text-text", local.class)} {...others}>
      {local.children}
    </KobalteDialog.Title>
  )
}

const DialogDescription: ParentComponent<{ class?: string }> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"])
  return (
    <KobalteDialog.Description
      class={cn("mt-2 text-sm text-text-secondary", local.class)}
      {...others}
    >
      {local.children}
    </KobalteDialog.Description>
  )
}

export const Dialog = Object.assign(DialogRoot, {
  Content: DialogContent,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: KobalteDialog.CloseButton,
})
