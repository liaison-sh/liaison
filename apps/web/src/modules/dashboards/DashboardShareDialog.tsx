// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who sees a dashboard: the generic ShareDialog (modules/sharing) over
// GET/PUT /dashboards/:id/sharing, as Knowledge documents and contacts use it.
// A dashboard restricted to some people or roles is invisible to everyone
// else, administrators included. Anyone who sees it may open this dialog to
// see who else does; only its editors holding the share permission change it.

import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import ShareDialog, {
  type GeneralAccessOption,
  type OrgAccess,
  type RoleShare,
  type ShareMember,
  type ShareRoleTarget,
  type UserShare,
} from "~/modules/sharing/ShareDialog"
import { useApi } from "~/modules/shell/ApiContext"

interface DashboardSharingResponse {
  orgAccess: OrgAccess
  ownerUserId: string | null
  ownerName: string | null
  canManage: boolean
  users: UserShare[]
  roles: RoleShare[]
}

const GENERAL_ACCESS_OPTIONS: GeneralAccessOption[] = [
  {
    key: "none",
    orgAccess: "none",
    label: "kernel.dashboards.sharing.restricted",
    description: "kernel.dashboards.sharing.restrictedHint",
  },
  {
    key: "viewer",
    orgAccess: "viewer",
    label: "kernel.dashboards.sharing.orgView",
    description: "kernel.dashboards.sharing.orgViewHint",
  },
  {
    key: "editor",
    orgAccess: "editor",
    label: "kernel.dashboards.sharing.orgEdit",
    description: "kernel.dashboards.sharing.orgEditHint",
  },
]

function unwrap<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

export interface DashboardShareDialogProps {
  dashboardId: string
  dashboardTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful save, e.g. to reload the dashboard and the list. */
  onSaved?: () => void
}

export const DashboardShareDialog: Component<DashboardShareDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const path = () => `/dashboards/${encodeURIComponent(props.dashboardId)}/sharing`

  return (
    <ShareDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={i18n.t("kernel.dashboards.sharing.title", { name: props.dashboardTitle })}
      testIdPrefix="dashboard-share"
      testId="dashboard-share-dialog"
      options={GENERAL_ACCESS_OPTIONS}
      load={async () => {
        const s = unwrap(await api.get<DashboardSharingResponse>(path()))
        return {
          orgAccess: s.orgAccess,
          variant: null,
          users: s.users.map(({ userId, role }) => ({ userId, role })),
          roles: s.roles.map(({ roleId, role }) => ({ roleId, role })),
          dimensions: [],
          canManage: s.canManage,
        }
      }}
      save={async (state) => {
        await api.put(path(), {
          orgAccess: state.orgAccess,
          users: state.users,
          roles: state.roles,
        })
        props.onSaved?.()
      }}
      listMembers={async () => unwrap(await api.get<ShareMember[]>("/sharing/members"))}
      listRoles={async () => unwrap(await api.get<ShareRoleTarget[]>("/sharing/roles"))}
    />
  )
}
