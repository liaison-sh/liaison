// SPDX-License-Identifier: FSL-1.1-ALv2
// The host's own confirmation before an app's screen decides an approval
// (`decideApproval`, framework/host-app-calls.ts). An app's Approve button only
// asks: the person decides here, in a dialog the app cannot draw, style or click.
// Mounted once in the Shell (`<AppApprovalConfirmHost/>`), like the connect dialog.

import { type Component, createSignal, For, onCleanup, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

export interface AppApprovalConfirmRequest {
  app: string
  decision: "approve" | "deny"
  title: string
  lines: string[]
}

interface Pending extends AppApprovalConfirmRequest {
  resolve: (confirmed: boolean) => void
}

const [pending, setPending] = createSignal<Pending | null>(null)

/** The open request, or null. */
export function appApprovalConfirmRequest(): AppApprovalConfirmRequest | null {
  return pending()
}

/** Close the dialog and answer its caller. No-op when none is open. */
export function settleAppApprovalConfirm(confirmed: boolean): void {
  const current = pending()
  if (!current) return
  setPending(null)
  current.resolve(confirmed)
}

/** Ask the person to confirm an app's approval decision. Resolves false when cancelled. */
export function confirmAppApproval(request: AppApprovalConfirmRequest): Promise<boolean> {
  // A newer request replaces one still open: the older caller is cancelled.
  settleAppApprovalConfirm(false)
  return new Promise((resolve) => {
    setPending({
      ...request,
      title: request.title.slice(0, 200),
      lines: request.lines.slice(0, 12).map((line) => line.slice(0, 300)),
      resolve,
    })
  })
}

export const AppApprovalConfirmHost: Component = () => {
  const i18n = useI18n()
  onCleanup(() => settleAppApprovalConfirm(false))
  return (
    <Dialog
      open={pending() !== null}
      onOpenChange={(open) => !open && settleAppApprovalConfirm(false)}
    >
      <Dialog.Content>
        <Show when={pending()} keyed>
          {(request) => (
            <div data-testid="app-approval-confirm" data-app={request.app}>
              <Dialog.Title>
                {request.decision === "approve"
                  ? i18n.t("app-frame.approvalConfirm.approveTitle")
                  : i18n.t("app-frame.approvalConfirm.denyTitle")}
              </Dialog.Title>
              <p
                class="mt-3 text-sm font-medium text-text"
                data-testid="app-approval-confirm-title"
              >
                {request.title}
              </p>
              <Show when={request.lines.length > 0}>
                <ul class="mt-2 space-y-1 text-sm text-text-secondary">
                  <For each={request.lines}>{(line) => <li>{line}</li>}</For>
                </ul>
              </Show>
              <p class="mt-3 text-xs text-text-tertiary">
                {i18n.t("app-frame.approvalConfirm.askedBy", { app: request.app })}
              </p>
              <div class="mt-5 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  data-testid="app-approval-confirm-cancel"
                  onClick={() => settleAppApprovalConfirm(false)}
                >
                  {i18n.t("app-frame.approvalConfirm.cancel")}
                </Button>
                <Button
                  variant={request.decision === "approve" ? "primary" : "danger"}
                  data-testid="app-approval-confirm-ok"
                  onClick={() => settleAppApprovalConfirm(true)}
                >
                  {request.decision === "approve"
                    ? i18n.t("app-frame.approvalConfirm.approve")
                    : i18n.t("app-frame.approvalConfirm.deny")}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Dialog.Content>
    </Dialog>
  )
}
