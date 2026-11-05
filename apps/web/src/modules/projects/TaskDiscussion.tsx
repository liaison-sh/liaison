// SPDX-License-Identifier: FSL-1.1-ALv2
// A task's discussion: the entity discussion (threads/EntityDiscussion.tsx)
// with the task's words and test ids. Its thread is the task's own, created
// with the task, which anyone who can load the task is enrolled in.

import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { EntityDiscussion } from "~/modules/threads/EntityDiscussion"

export const TaskDiscussion: Component<{ threadId: string }> = (props) => {
  const i18n = useI18n()
  return (
    <EntityDiscussion
      threadId={props.threadId}
      testId="task-discussion"
      emptyText={i18n.t("projects.noCommentsYet")}
      placeholder={i18n.t("projects.addACommentCmdEnterTo")}
      sendLabel={i18n.t("projects.comment")}
    />
  )
}

export default TaskDiscussion
