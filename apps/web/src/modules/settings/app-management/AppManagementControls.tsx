// SPDX-License-Identifier: FSL-1.1-ALv2
// The management controls of an app's page header and a connector's card (S24,
// A7, A9, D24, prototype S-APPPAGE / S-ACCESS), for `kernel:apps:admin` only:
//
//   Enabled   a switch; turning it off asks first, in the page, saying what
//             stops and that events received while Off are not replayed
//   Who can use it   Everyone / selected roles and people ("Support + 2 people")
//   ⋯         Check for updates, View in App store, Remove from this workspace
//
// The state is the workspace's (`GET /api/org/apps`); a change elsewhere
// arrives over the WebSocket and updates these controls and the page.
import { useNavigate } from "@solidjs/router"
import { type Component, createMemo, createSignal, onMount, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { roleDisplayName } from "~/lib/app-label"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { PopupMenu } from "~/ui/PopupMenu"
import { Switch } from "~/ui/Switch"
import { appsStore, toUpgradePreview } from "../apps-store"
import { InstallAppDialog, type UpgradePreview } from "../InstallAppDialog"
import { AccessDialog } from "./AccessDialog"
import { accessSummary } from "./access-summary"
import { canDisableOrgApp, isOrgAppOff, orgAppsStore } from "./org-apps-store"
import { RemoveAppDialog } from "./RemoveAppDialog"
import { useWorkspaceRoles } from "./workspace-roles"

const M = "kernel.appManagement"
export const APPS_ADMIN_SCOPE = "kernel:apps:admin"

/** May the viewer manage the workspace's apps? */
export function canManageApps(): boolean {
  return canAccessScope(APPS_ADMIN_SCOPE)
}

export const AppManagementControls: Component<{
  appId: string
  name: string
  kind: "app" | "connector"
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()
  const roles = useWorkspaceRoles()
  const app = () => orgAppsStore.app(props.appId)
  const off = () => isOrgAppOff(app())
  // An app the workspace depends on stays on and in the workspace (A6, A24-6):
  // the switch shows it on, disabled with the reason, and Remove is not offered.
  const required = () => !canDisableOrgApp(app())
  const [confirmingOff, setConfirmingOff] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [accessOpen, setAccessOpen] = createSignal(false)
  const [removeOpen, setRemoveOpen] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [upgrade, setUpgrade] = createSignal<UpgradePreview | null>(null)

  onMount(() => {
    if (!canManageApps()) return
    void orgAppsStore.ensureLoaded(api).catch(() => {})
    // The update channel and install permission decide "Check for updates".
    if (appsStore.apps().length === 0) {
      void appsStore.load(api).catch(() => {})
      void appsStore.loadInstallPermission(api).catch(() => {})
    }
  })

  const summary = createMemo(() => {
    const a = app()
    if (!a) return ""
    const roleName = (id: string) => {
      const r = (roles() ?? []).find((x) => x.id === id)
      return r ? roleDisplayName(r.name, i18n.t) : undefined
    }
    return accessSummary(
      { mode: a.accessMode, roleIds: a.principals.roleIds, userIds: a.principals.userIds },
      roleName,
      i18n.t,
    )
  })
  const registryEntry = () => appsStore.apps().find((a) => a.name === props.appId)
  const canCheckUpdates = () => !!registryEntry()?.updateUrl && appsStore.canManageInstalls()

  async function setEnabled(enabled: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await orgAppsStore.setEnabled(api, props.appId, enabled)
      setConfirmingOff(false)
      addToast({
        message: i18n.t(enabled ? `${M}.turnedOnToast` : `${M}.turnedOffToast`, {
          name: props.name,
        }),
        type: "success",
      })
    } catch (e) {
      // A refusal names why: a required app, or the apps that depend on this one.
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : i18n.t(`${M}.changeFailed`, { name: props.name }),
      )
    } finally {
      setBusy(false)
    }
  }

  async function checkForUpdates(): Promise<void> {
    try {
      const res = await appsStore.upgradePreview(api, props.appId)
      if (res.upToDate) {
        addToast({
          message: i18n.t("kernel.appStore.upToDate", {
            name: props.name,
            version: String(res.version),
          }),
          type: "info",
        })
        return
      }
      setUpgrade(toUpgradePreview(res))
    } catch (e) {
      addToast({
        message:
          e instanceof Error && e.message
            ? e.message
            : i18n.t("kernel.settingsUi.upgradePreviewFailed"),
        type: "error",
      })
    }
  }

  return (
    <Show when={canManageApps() && app()}>
      {(a) => (
        <>
          <fieldset class="flex flex-wrap items-end gap-4" data-testid="app-management">
            <legend class="sr-only">{i18n.t(`${M}.management`, { name: props.name })}</legend>
            <div class="flex flex-col gap-1">
              <span
                class="text-[11px] font-medium text-text-secondary"
                id={`app-en-${props.appId}`}
              >
                {i18n.t(`${M}.enabled`)}
              </span>
              <Switch
                checked={!off()}
                disabled={busy() || (required() && !off())}
                label={i18n.t(`${M}.enabledLabel`, { name: props.name })}
                data-testid="app-enabled-switch"
                onChange={(next) => {
                  setError(null)
                  if (next) void setEnabled(true)
                  else setConfirmingOff(true)
                }}
              />
              <Show when={required()}>
                <span class="text-[11px] text-text-tertiary" data-testid="app-enabled-required">
                  {i18n.t(`${M}.requiredApp`)}
                </span>
              </Show>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-text-secondary">
                {i18n.t(`${M}.whoCanUse`)}
              </span>
              <Button
                size="sm"
                variant="outline"
                class="w-auto"
                disabled={off()}
                data-testid="app-access-button"
                onClick={() => setAccessOpen(true)}
              >
                {summary()} ▾
              </Button>
            </div>
            <PopupMenu open={menuOpen()} onOpenChange={setMenuOpen}>
              <PopupMenu.Trigger
                class="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
                aria-label={i18n.t(`${M}.more`, { name: props.name })}
                data-testid="app-management-more"
              >
                ⋯
              </PopupMenu.Trigger>
              <PopupMenu.Content>
                <Show when={canCheckUpdates()}>
                  <PopupMenu.Item
                    data-testid="app-management-check-updates"
                    onSelect={() => void checkForUpdates()}
                  >
                    {i18n.t(`${M}.checkForUpdates`)}
                  </PopupMenu.Item>
                </Show>
                <PopupMenu.Item
                  data-testid="app-management-store"
                  onSelect={() => navigate(`/settings/store/${encodeURIComponent(props.appId)}`)}
                >
                  {i18n.t(`${M}.viewInStore`)}
                </PopupMenu.Item>
                <Show when={!required()}>
                  <PopupMenu.Separator />
                  <PopupMenu.Item
                    variant="danger"
                    data-testid="app-management-remove"
                    onSelect={() => setRemoveOpen(true)}
                  >
                    {i18n.t(`${M}.removeItem`)}
                  </PopupMenu.Item>
                </Show>
              </PopupMenu.Content>
            </PopupMenu>
          </fieldset>

          <Show when={confirmingOff()}>
            <section
              class="basis-full rounded-md border border-warning/40 bg-bg px-3.5 py-3"
              aria-label={i18n.t(`${M}.offTitle`, { name: props.name })}
              data-testid="app-disable-confirm"
            >
              <p class="text-[13.5px] font-semibold">
                {i18n.t(`${M}.offTitle`, { name: props.name })}
              </p>
              <p class="mt-1.5 text-[13px] text-text-secondary">
                {i18n.t(`${M}.offBody`, { name: props.name })}
              </p>
              <p class="mt-1.5 text-[13px] text-text-secondary">{i18n.t(`${M}.offEvents`)}</p>
              <p class="mt-1.5 text-[13px] text-text-secondary">{i18n.t(`${M}.offKept`)}</p>
              <div class="mt-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  class="w-auto"
                  data-testid="app-disable-confirm-cancel"
                  onClick={() => setConfirmingOff(false)}
                >
                  {i18n.t(`${M}.cancel`)}
                </Button>
                <Button
                  size="sm"
                  class="w-auto"
                  disabled={busy()}
                  data-testid="app-disable-confirm-yes"
                  onClick={() => void setEnabled(false)}
                >
                  {i18n.t(`${M}.offConfirm`, { name: props.name })}
                </Button>
              </div>
            </section>
          </Show>
          <Show when={error()}>
            <p
              class="basis-full text-sm text-error"
              role="alert"
              data-testid="app-management-error"
            >
              {error()}
            </p>
          </Show>

          <Show when={accessOpen()}>
            <AccessDialog
              open={accessOpen()}
              app={a()}
              name={props.name}
              onClose={() => setAccessOpen(false)}
            />
          </Show>
          <RemoveAppDialog
            open={removeOpen()}
            app={props.appId}
            name={props.name}
            kind={props.kind}
            onClose={() => setRemoveOpen(false)}
          />
          <Dialog open={upgrade() !== null} onOpenChange={(open) => !open && setUpgrade(null)}>
            <Dialog.Content>
              <Show when={upgrade()}>
                {(preview) => (
                  <InstallAppDialog
                    mode="upgrade"
                    preview={preview()}
                    onInstall={async (grants) => {
                      await appsStore.upgradeApp(api, props.appId, grants)
                      await orgAppsStore.load(api)
                      return undefined
                    }}
                    onClose={() => setUpgrade(null)}
                  />
                )}
              </Show>
            </Dialog.Content>
          </Dialog>
        </>
      )}
    </Show>
  )
}

/** "<App> is off for everyone." — an Off app's page and card, read-only. */
export const AppOffNotice: Component<{ name: string }> = (props) => {
  const i18n = useI18n()
  return (
    <div
      class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
      role="status"
      data-testid="app-off-notice"
    >
      <span class="font-medium text-text">{i18n.t(`${M}.offNotice`, { name: props.name })}</span>{" "}
      {i18n.t(`${M}.offNoticeBody`)}
    </div>
  )
}
