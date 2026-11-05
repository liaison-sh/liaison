// SPDX-License-Identifier: FSL-1.1-ALv2
// "Apps this role can use" on a role's page (S20, prototype S-ROLES): each app
// of the workspace, whether this role can use it and why. It is set on each
// app under Who can use it, which opens from the row; an app the role cannot
// use hides its permissions too. Read from the workspace's app list, so it is
// shown to apps admins only.
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { appLabel, roleDisplayName } from "~/lib/app-label"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { AccessDialog, isAdminRole } from "./AccessDialog"
import { canManageApps } from "./AppManagementControls"
import { accessSummary } from "./access-summary"
import { type OrgApp, orgAppsStore } from "./org-apps-store"
import { useWorkspaceRoles } from "./workspace-roles"

const M = "kernel.appManagement"

type Use = { can: boolean; off: boolean; why: string }

export const RoleAppsSection: Component<{ roleId: string; roleName: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const roles = useWorkspaceRoles()
  const [editing, setEditing] = createSignal<string | null>(null)

  onMount(() => {
    if (canManageApps()) void orgAppsStore.ensureLoaded(api).catch(() => {})
  })

  const apps = createMemo(() =>
    orgAppsStore
      .apps()
      .filter((a) => a.name !== "kernel" && a.kind !== "connector" && a.status !== "removed"),
  )
  const roleName = (id: string) => {
    const r = (roles() ?? []).find((x) => x.id === id)
    return r ? roleDisplayName(r.name, i18n.t) : undefined
  }
  const admin = () => isAdminRole({ name: props.roleName })

  function use(app: OrgApp): Use {
    if (app.status === "disabled") return { can: false, off: true, why: i18n.t(`${M}.roleOff`) }
    if (app.accessMode === "everyone" || admin())
      return { can: true, off: false, why: i18n.t(`${M}.roleEveryone`) }
    if (app.principals.roleIds.includes(props.roleId))
      return { can: true, off: false, why: i18n.t(`${M}.roleListed`) }
    const summary = accessSummary(
      { mode: app.accessMode, roleIds: app.principals.roleIds, userIds: app.principals.userIds },
      roleName,
      i18n.t,
    )
    return { can: false, off: false, why: i18n.t(`${M}.roleNotListed`, { summary }) }
  }

  const editingApp = () => {
    const name = editing()
    return name ? orgAppsStore.app(name) : undefined
  }

  return (
    <Show when={canManageApps()}>
      <section data-testid="role-apps-section" class="flex flex-col gap-3">
        <header class="flex flex-col gap-1">
          <h2 class="text-[15px] font-semibold text-text">{i18n.t(`${M}.roleApps`)}</h2>
          <p class="text-[12.5px] text-text-secondary">{i18n.t(`${M}.roleAppsHint`)}</p>
        </header>
        <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          <For
            each={apps()}
            fallback={
              <li class="px-4 py-3 text-[13px] text-text-secondary">{i18n.t(`${M}.noApps`)}</li>
            }
          >
            {(app) => {
              const u = () => use(app)
              const name = () => appLabel(app.name, i18n.t, app.displayName)
              return (
                <li
                  class="flex items-center gap-3 px-4 py-2.5"
                  data-testid={`role-app-${app.name}`}
                >
                  <div class="min-w-0 flex-1">
                    <div class="text-[13px] font-medium text-text">{name()}</div>
                    <div class="text-xs text-text-secondary">{u().why}</div>
                  </div>
                  <span
                    class="rounded-full border px-2 py-px text-[11px] font-medium"
                    classList={{
                      "border-success/40 text-success": u().can,
                      "border-border text-text-secondary": !u().can,
                    }}
                    data-testid={`role-app-state-${app.name}`}
                  >
                    {u().off
                      ? i18n.t(`${M}.offBadge`)
                      : u().can
                        ? i18n.t(`${M}.canUse`)
                        : i18n.t(`${M}.cantUse`)}
                  </span>
                  <Show when={!u().off && app.hasOwnScopes && !admin()}>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="w-auto"
                      data-testid={`role-app-access-${app.name}`}
                      onClick={() => setEditing(app.name)}
                    >
                      {i18n.t(`${M}.whoCanUse`)}
                    </Button>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
        <Show when={editingApp()}>
          {(app) => (
            <AccessDialog
              open
              app={app()}
              name={appLabel(app().name, i18n.t, app().displayName)}
              onClose={() => setEditing(null)}
            />
          )}
        </Show>
      </section>
    </Show>
  )
}
