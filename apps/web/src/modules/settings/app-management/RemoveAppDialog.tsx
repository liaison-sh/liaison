// SPDX-License-Identifier: FSL-1.1-ALv2
// "Remove <app> from this workspace?" (S24, A4, prototype S-ACCESS): the app
// leaves this workspace only; its data and settings are kept, and other
// workspaces on the server are untouched. Shared by the app page's overflow
// menu, a connector card and the App store listing.
import { type Component, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { orgAppsStore } from "./org-apps-store"

const M = "kernel.appManagement"

export const RemoveAppDialog: Component<{
  open: boolean
  app: string
  name: string
  kind: "app" | "connector"
  onClose: () => void
  onRemoved?: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await orgAppsStore.remove(api, props.app)
      addToast({ message: i18n.t(`${M}.removedToast`, { name: props.name }), type: "success" })
      props.onClose()
      props.onRemoved?.()
    } catch (e) {
      // A refusal (a required app, an app others depend on) is a sentence for the person.
      setError(
        e instanceof ApiError ? e.message : i18n.t(`${M}.changeFailed`, { name: props.name }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content>
        <div data-testid="app-remove-dialog">
          <Dialog.Title>{i18n.t(`${M}.removeTitle`, { name: props.name })}</Dialog.Title>
          <p class="mt-3 text-sm text-text-secondary">
            {i18n.t(
              props.kind === "connector" ? `${M}.removeBodyConnector` : `${M}.removeBodyApp`,
              {
                name: props.name,
              },
            )}
          </p>
          <p class="mt-2 text-sm text-text-secondary">{i18n.t(`${M}.removeOthers`)}</p>
          <Show when={error()}>
            <p class="mt-3 text-sm text-error" role="alert" data-testid="app-remove-error">
              {error()}
            </p>
          </Show>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => props.onClose()}>
              {i18n.t(`${M}.cancel`)}
            </Button>
            <Button
              variant="danger"
              disabled={busy()}
              data-testid="app-remove-confirm"
              onClick={() => void remove()}
            >
              {i18n.t(`${M}.removeConfirm`)}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
