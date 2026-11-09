// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a company is shared with: the generic ShareDialog over
// GET /contacts/companies/:id/sharing. Read only here: changing a company's
// sharing is not offered on the page yet, so the dialog shows who sees it.

import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import ShareDialog, {
  type DimensionShare,
  type GeneralAccessOption,
  type OrgAccess,
  type RoleShare,
  type ShareMember,
  type ShareRoleTarget,
  type UserShare,
} from "~/modules/sharing/ShareDialog"
import { useApi } from "~/modules/shell/ApiContext"

interface CompanySharingResponse {
  orgAccess: OrgAccess
  users: UserShare[]
  roles: RoleShare[]
  dimensions?: DimensionShare[]
}

const GENERAL_ACCESS_OPTIONS: GeneralAccessOption[] = [
  {
    key: "none",
    orgAccess: "none",
    label: "contacts.sharing.private",
    description: "contacts.sharing.privateHint",
  },
  {
    key: "viewer",
    orgAccess: "viewer",
    label: "contacts.sharing.orgView",
    description: "contacts.sharing.orgViewHint",
  },
  {
    key: "editor",
    orgAccess: "editor",
    label: "contacts.sharing.orgEdit",
    description: "contacts.sharing.orgEditHint",
  },
]

export const CompanyShareDialog: Component<{
  companyId: string
  companyName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  return (
    <ShareDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={i18n.t("contacts.companies.shareTitle", { name: props.companyName })}
      testIdPrefix="company-share"
      options={GENERAL_ACCESS_OPTIONS}
      load={async () => {
        const s = await api.get<CompanySharingResponse>(
          `/contacts/companies/${props.companyId}/sharing`,
        )
        return {
          orgAccess: s.orgAccess,
          variant: null,
          users: s.users ?? [],
          roles: s.roles ?? [],
          dimensions: s.dimensions ?? [],
          canManage: false,
        }
      }}
      save={async () => {}}
      listMembers={async () => await api.get<ShareMember[]>("/sharing/members")}
      listRoles={async () => await api.get<ShareRoleTarget[]>("/sharing/roles")}
      describeDimension={(share) => `${share.key} = ${share.value}`}
    />
  )
}
