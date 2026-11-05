// SPDX-License-Identifier: FSL-1.1-ALv2
// Install from URL (S21, A11, A12): the package is checked (signature, then
// what it asks for) and installed only with the scopes the admin grants. A
// registry listing opens it with its package URL filled in: registry packages
// take the same consent path, never an automatic grant.
import { type Component, Show } from "solid-js"
import { useApi } from "~/modules/shell/ApiContext"
import { Dialog } from "~/ui/Dialog"
import { orgAppsStore } from "../app-management/org-apps-store"
import { appsStore } from "../apps-store"
import { InstallAppDialog } from "../InstallAppDialog"

export const StoreInstallDialog: Component<{
  open: boolean
  initialUrl?: string
  onClose: () => void
}> = (props) => {
  const api = useApi()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content>
        <Show when={props.open}>
          <InstallAppDialog
            initialUrl={props.initialUrl}
            fetchManifest={(url) => appsStore.preflight(api, url)}
            onInstall={async (args) => {
              if (!args.url) throw new Error("URL required")
              await appsStore.installApp(api, { ...args, url: args.url })
              await Promise.allSettled([appsStore.loadCatalog(api), orgAppsStore.load(api)])
              return undefined
            }}
            onClose={() => props.onClose()}
          />
        </Show>
      </Dialog.Content>
    </Dialog>
  )
}
