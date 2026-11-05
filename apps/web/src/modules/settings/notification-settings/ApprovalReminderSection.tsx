// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Approval reminders" in Settings -> Notifications, right under the grid and
// its approvals row: how often the person's agent reminds them of their own
// requests still waiting for a decision. Daily unless they chose otherwise
// (the server's `approvalReminder`; modules/approvals/reminders.ts).

import { APPROVAL_REMINDER_FREQUENCIES, type ApprovalReminderFrequency } from "@liaison/shared"
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { SegmentedChoice } from "~/modules/settings/notification-settings/SegmentedChoice"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"

interface ApprovalReminderSectionProps {
  value: ApprovalReminderFrequency
  onChange: (value: ApprovalReminderFrequency) => void
}

export const ApprovalReminderSection: Component<ApprovalReminderSectionProps> = (props) => {
  const i18n = useI18n()
  const k = (key: string) => i18n.t(`kernel.notificationSettings.${key}`)
  return (
    <section data-testid="approval-reminder" class="mb-10 border-t border-border-subtle pt-8">
      <h2 class={`mb-3 ${sectionHeading}`}>{k("approvalReminderTitle")}</h2>
      <p class="text-[13px] leading-snug text-text">{k("approvalReminderLabel")}</p>
      <p class="mt-1 mb-3 max-w-[60ch] text-[12px] leading-relaxed text-text-secondary">
        {k("approvalReminderHelp")}
      </p>
      <SegmentedChoice
        name="approvalReminder"
        testId="approval-reminder-frequency"
        label={k("approvalReminderLabel")}
        options={APPROVAL_REMINDER_FREQUENCIES}
        value={props.value}
        optionLabel={(v) => k(`approvalReminderOptions.${v}`)}
        onChange={props.onChange}
      />
      <p
        data-testid="approval-reminder-hint"
        class="mt-2.5 text-[12px] leading-relaxed text-text-secondary"
      >
        {k(`approvalReminderHints.${props.value}`)}
      </p>
    </section>
  )
}
