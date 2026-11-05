// SPDX-License-Identifier: FSL-1.1-ALv2
import { useI18n } from "~/modules/i18n/i18n-context"
import type { RoutineApprover } from "./routines-store"

/** The i18n key of one approver choice. */
export function approverLabelKey(approver: RoutineApprover | null | undefined): string {
  return approver === "owner"
    ? "kernel.agentForms.approverOwner"
    : "kernel.agentForms.approverDefault"
}

interface RoutineApproverFieldProps {
  value: RoutineApprover
  onChange: (v: RoutineApprover) => void
  /** The select's test id ("routine-approver" or "routine-edit-approver"). */
  testId: string
}

/**
 * Who approves the drafts a routine raises (S29): whoever may approve that
 * action (the default), or the routine's owner alone, also on a shared
 * mailbox. The server refuses "owner" when the owner may not approve them.
 */
export default function RoutineApproverField(props: RoutineApproverFieldProps) {
  const i18n = useI18n()
  return (
    <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
      {i18n.t("kernel.agentForms.approver")}
      <select
        data-testid={props.testId}
        class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as RoutineApprover)}
      >
        <option value="default">{i18n.t(approverLabelKey("default"))}</option>
        <option value="owner">{i18n.t(approverLabelKey("owner"))}</option>
      </select>
      <span class="text-[11px]">{i18n.t("kernel.agentForms.approverHint")}</span>
    </label>
  )
}
