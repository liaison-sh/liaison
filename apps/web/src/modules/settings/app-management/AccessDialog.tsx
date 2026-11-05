// SPDX-License-Identifier: FSL-1.1-ALv2
// "Who can use <app>" (S20, S24, A3, prototype S-ACCESS): Everyone in the
// workspace, or only selected roles and people. Admins always have access, so
// the admin role is not offered. An app with no permissions of its own cannot
// be restricted (there is nothing to drop), and the choice says why.
import { type Component, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { AccessPicker, type AccessValue } from "./AccessPicker"
import { type OrgApp, orgAppsStore } from "./org-apps-store"

export { isAdminRole } from "./AccessPicker"

const M = "kernel.appManagement"

export const AccessDialog: Component<{
  open: boolean
  app: OrgApp
  name: string
  onClose: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [access, setAccess] = createSignal<AccessValue>({
    mode: props.app.accessMode,
    roleIds: [...props.app.principals.roleIds],
    userIds: [...props.app.principals.userIds],
  })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    const { mode, roleIds, userIds } = access()
    try {
      await orgAppsStore.setAccess(api, props.app.name, {
        mode,
        roleIds: mode === "restricted" ? roleIds : [],
        userIds: mode === "restricted" ? userIds : [],
      })
      addToast({ message: i18n.t(`${M}.accessSaved`, { name: props.name }), type: "success" })
      props.onClose()
    } catch (e) {
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : i18n.t(`${M}.changeFailed`, { name: props.name }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content>
        <div data-testid="app-access-dialog">
          <Dialog.Title>{i18n.t(`${M}.accessTitle`, { name: props.name })}</Dialog.Title>
          <p class="mt-2 text-sm text-text-secondary">
            {i18n.t(`${M}.accessBody`, { name: props.name })}
          </p>
          <div class="mt-4">
            <AccessPicker
              value={access()}
              onChange={setAccess}
              canRestrict={props.app.hasOwnScopes}
              restrictHint={i18n.t(`${M}.noScopes`)}
            />
          </div>

          <Show when={error()}>
            <p class="mt-3 text-sm text-error" role="alert" data-testid="app-access-error">
              {error()}
            </p>
          </Show>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => props.onClose()}>
              {i18n.t(`${M}.cancel`)}
            </Button>
            <Button disabled={busy()} data-testid="app-access-save" onClick={() => void save()}>
              {i18n.t(`${M}.save`)}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
