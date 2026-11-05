// SPDX-License-Identifier: FSL-1.1-ALv2
import { useI18n } from "~/modules/i18n/i18n-context"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface ApprovalPreviewData {
  id: string
  handle?: string | null
  toolName?: string | null
  status?: "pending" | "approving" | "approved" | "denied" | "expired" | string | null
  summary?: string | null
}

export function registerEntityPreviews(): void {
  registerEntityPreview<ApprovalPreviewData>({
    app: "kernel",
    entityType: "approval_request",
    fetch: async (id, api) => {
      const res = await api.getEnvelope<ApprovalPreviewData>(`/approvals/${id}`)
      // approvals returns the row directly (not enveloped) for some callers; tolerate both shapes
      return res?.data ?? (res as unknown as ApprovalPreviewData)
    },
    render: (approval) => (
      <div data-testid={`approval-preview-${approval.id}`}>
        {approval.handle ? (
          <div class="text-text-tertiary text-[11px]">{approval.handle}</div>
        ) : null}
        <div class="font-medium text-text">
          {approval.summary ??
            approval.toolName ??
            useI18n().t("kernel.approvalsUi.approvalRequest")}
        </div>
        {approval.status ? (
          <div class="text-text-secondary text-[12px]">
            {useI18n().t(`kernel.approvalsUi.status.${approval.status}`)}
          </div>
        ) : null}
      </div>
    ),
  })
}
