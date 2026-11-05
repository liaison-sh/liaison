// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lively world's task labels: two groups and a handful of the demo
// projects' tasks labelled, so a walk shows the board's Labels filter, the
// task chips and a subtask inheriting its parent's value (the preamp manual's
// two translations inherit "Docs"). Task references are the demo tier's
// (`demo:task:<key>`, support-specs.ts PROJECT_SPECS).
import type { LabelGroupSpec, TaskLabelSpec } from "~/seed/factories/projects/labels"

export const LIVELY_LABEL_GROUPS: readonly LabelGroupSpec[] = [
  { name: "Type", values: ["Bug", "Feature", "Chore"] },
  { name: "Area", values: ["Firmware", "Docs", "Web", "Logistics"] },
]

const task = (key: string, labels: Record<string, string>): TaskLabelSpec => ({
  externalRef: `demo:task:${key}`,
  labels,
})

export const LIVELY_TASK_LABELS: readonly TaskLabelSpec[] = [
  task("preamp-firmware", { Type: "Feature", Area: "Firmware" }),
  task("preamp-manual", { Type: "Chore", Area: "Docs" }),
  task("preamp-kb", { Area: "Docs" }),
  task("preamp-packaging", { Type: "Chore", Area: "Logistics" }),
  task("web-copy", { Type: "Feature", Area: "Web" }),
  task("web-runtime-spec", { Type: "Bug", Area: "Web" }),
  task("web-dealer-locator", { Type: "Feature", Area: "Web" }),
  task("jp-customs-pack", { Type: "Chore", Area: "Logistics" }),
  task("backlog-macros", { Area: "Docs" }),
  task("backlog-sla-report", { Type: "Chore" }),
]
