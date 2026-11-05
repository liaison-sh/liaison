// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge's share dialog: the generic ShareDialog (modules/sharing) over a
// document's sharing. Its `editScope` (e.g. "clevel": everyone views, only
// that scope edits) is the dialog's general-access variant.

import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import ShareDialog, { type GeneralAccessOption } from "~/modules/sharing/ShareDialog"
import { useApi } from "~/modules/shell/ApiContext"
import {
  getDocumentSharing,
  listKnowledgeMembers,
  listKnowledgeRoles,
  setDocumentSharing,
} from "./knowledge-api"

interface KnowledgeShareDialogProps {
  documentId: string
  documentTitle?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const GENERAL_ACCESS_OPTIONS: GeneralAccessOption[] = [
  {
    key: "none",
    orgAccess: "none",
    label: "knowledge.access.restricted",
    description: "knowledge.access.restrictedHint",
  },
  {
    key: "viewer",
    orgAccess: "viewer",
    label: "knowledge.access.orgView",
    description: "knowledge.access.orgViewHint",
  },
  {
    key: "editor",
    orgAccess: "editor",
    label: "knowledge.access.orgEdit",
    description: "knowledge.access.orgEditHint",
  },
  {
    key: "clevel",
    orgAccess: "viewer",
    variant: "clevel",
    label: "knowledge.access.clevel",
    description: "knowledge.access.clevelHint",
  },
]

const KnowledgeShareDialog: Component<KnowledgeShareDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  return (
    <ShareDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={`${i18n.t("knowledge.share")} ${props.documentTitle ? `"${props.documentTitle}"` : "document"}`}
      testIdPrefix="knowledge-share"
      testId="knowledge-share-dialog"
      options={GENERAL_ACCESS_OPTIONS}
      load={async () => {
        const result = await getDocumentSharing(api, props.documentId)
        return {
          orgAccess: result.orgAccess,
          variant: result.editScope ?? null,
          users: result.shares,
          roles: result.roleShares ?? [],
          dimensions: [],
        }
      }}
      save={async (state) => {
        await setDocumentSharing(api, props.documentId, {
          orgAccess: state.orgAccess,
          editScope: state.variant,
          shares: state.users,
          roleShares: state.roles,
        })
      }}
      listMembers={() => listKnowledgeMembers(api)}
      listRoles={() => listKnowledgeRoles(api)}
    />
  )
}

export default KnowledgeShareDialog
