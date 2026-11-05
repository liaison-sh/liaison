// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a contact is shared with: the generic ShareDialog (modules/sharing) over
// GET/PUT /contacts/:id/sharing. A contact found in someone's own mail is
// private to them; adding it to the organisation is this dialog's choice, made
// by its owner. A shared mailbox's senders are shared with that mailbox's
// members (a dimension grant), shown here as "everyone with access to …".

import { type Component, createResource } from "solid-js"
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

interface ContactSharingResponse {
  orgAccess: OrgAccess
  ownerUserId: string | null
  canManage: boolean
  users: UserShare[]
  roles: RoleShare[]
  dimensions: DimensionShare[]
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

interface ContactShareDialogProps {
  contactId: string
  contactName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful save, e.g. to reload the contact. */
  onSaved?: () => void
}

function unwrap<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

export const ContactShareDialog: Component<ContactShareDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  // Mailbox names for dimension grants; a reader without the mail app sees a
  // generic label.
  const [mailboxes] = createResource(
    () => (props.open ? true : null),
    async () => {
      try {
        const list = unwrap(
          await api.get<Array<{ id: string; emailAddress: string; displayName: string | null }>>(
            "/mail/accounts",
          ),
        )
        return new Map(list.map((a) => [a.id, a.displayName || a.emailAddress]))
      } catch {
        return new Map<string, string>()
      }
    },
  )

  function describeDimension(share: DimensionShare): string {
    if (share.key === "mail:inbox") {
      const name = mailboxes()?.get(share.value)
      return name
        ? i18n.t("contacts.sharing.mailboxMembers", { name })
        : i18n.t("contacts.sharing.sharedMailboxMembers")
    }
    return `${share.key} = ${share.value}`
  }

  return (
    <ShareDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={i18n.t("contacts.sharing.title", { name: props.contactName })}
      testIdPrefix="contact-share"
      options={GENERAL_ACCESS_OPTIONS}
      load={async () => {
        const s = unwrap(
          await api.get<ContactSharingResponse>(`/contacts/${props.contactId}/sharing`),
        )
        return {
          orgAccess: s.orgAccess,
          variant: null,
          users: s.users,
          roles: s.roles,
          dimensions: s.dimensions,
          canManage: s.canManage,
        }
      }}
      save={async (state) => {
        await api.put(`/contacts/${props.contactId}/sharing`, {
          orgAccess: state.orgAccess,
          users: state.users,
          roles: state.roles,
          dimensions: state.dimensions,
        })
        props.onSaved?.()
      }}
      listMembers={async () => unwrap(await api.get<ShareMember[]>("/sharing/members"))}
      listRoles={async () => unwrap(await api.get<ShareRoleTarget[]>("/sharing/roles"))}
      describeDimension={describeDimension}
    />
  )
}
