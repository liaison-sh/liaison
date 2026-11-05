// SPDX-License-Identifier: FSL-1.1-ALv2
// The task tree depth bound, apart from move-task.ts so readers that
// move-task.ts itself depends on (task-detail.ts -> task-labels.ts) can use it
// without an import cycle. A task is depth 1; its 7th ancestor is depth 8.

export const MAX_TASK_DEPTH = 8
