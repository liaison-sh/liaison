// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSummary } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { UUID_RE } from "~/lib/uuid"

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

type TaskSummaryRow = {
  id: string
  title: string
  description: string | null
  project_id: string
  project_name: string | null
  subtask_count: number
}

/**
 * Load the human-readable shape of a task for an approval card: its title, a
 * short body preview, its parent project name, and how many active subtasks
 * would be swept along by a destructive op. Read under the caller's RLS context
 * (the agent can only summarize what it can already see).
 */
async function loadTaskSummary(
  ctx: { tx: RlsClient; orgId: string },
  taskId: string,
): Promise<TaskSummaryRow | null> {
  // A summarizer runs at GATE time, before the tool executes — a non-UUID id
  // must degrade to "task not visible", not crash the approval with a raw
  // uuid-cast SQL error.
  if (!UUID_RE.test(taskId)) return null
  const r = await ctx.tx.execute(drizzleSql`
    SELECT t.id, t.title, t.description, t.project_id,
           p.name AS project_name,
           (
             SELECT count(*)::int FROM ${projectsRel("tasks")} c
             WHERE c.parent_task_id = t.id
               AND c.org_id = ${ctx.orgId}::uuid
               AND c.archived_at IS NULL
           ) AS subtask_count
    FROM ${projectsRel("tasks")} t
    LEFT JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = ${ctx.orgId}::uuid
    WHERE t.id = ${taskId}::uuid AND t.org_id = ${ctx.orgId}::uuid
    LIMIT 1
  `)
  return extractRows<TaskSummaryRow>(r)[0] ?? null
}

/**
 * Approval summary for the gated `delete` task tool. A human reviewer must see
 * WHAT is being deleted — the task's TITLE (never the opaque uuid), its project,
 * a body preview, and the subtask count that will be swept along — so a
 * destructive irreversible-feeling action is reviewable, not a blind "Delete
 * task <uuid>". Mirrors the named-entity discipline of the tickets/contacts
 * gated summarizers.
 */
export async function summarizeDeleteTask(
  params: { taskId: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const task = await loadTaskSummary(ctx, params.taskId)
  if (!task) {
    return {
      kind: "projects.delete",
      title: "Delete task",
      subtitle: "Task not found or already deleted",
      lines: [`Task id: ${params.taskId}`],
    }
  }
  const lines: string[] = []
  if (task.description?.trim()) lines.push(clip(task.description.trim(), 220))
  if (task.subtask_count > 0) {
    lines.push(`Also deletes ${task.subtask_count} subtask${task.subtask_count === 1 ? "" : "s"}`)
  }
  if (lines.length === 0) lines.push("(no description)")
  return {
    kind: "projects.delete",
    title: `Delete: ${task.title}`,
    subtitle: task.project_name ? `In ${task.project_name}` : "Delete task and its subtasks",
    lines,
    links: [
      {
        label: "Open task",
        app: "projects",
        entityType: "task",
        entityId: task.id,
      },
    ],
  }
}

/**
 * Approval summary for the gated `merge` task tool. The reviewer must see BOTH
 * task titles — which one is archived (source) and which one is kept (target) —
 * not two opaque uuids, so a "keep the most-detailed, merge the rest" cleanup
 * is reviewable before it archives the source.
 */
export async function summarizeMergeTasks(
  params: { sourceId: string; targetId: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const [source, target] = await Promise.all([
    loadTaskSummary(ctx, params.sourceId),
    loadTaskSummary(ctx, params.targetId),
  ])
  const sourceTitle = source?.title ?? `task ${params.sourceId}`
  const targetTitle = target?.title ?? `task ${params.targetId}`
  const lines = [
    `Archives (merged away): ${clip(sourceTitle, 140)}`,
    `Keeps (merged into): ${clip(targetTitle, 140)}`,
  ]
  const sourceSubtasks = source?.subtask_count ?? 0
  if (sourceSubtasks > 0) {
    lines.push(`Moves ${sourceSubtasks} subtask${sourceSubtasks === 1 ? "" : "s"} to the kept task`)
  }
  return {
    kind: "projects.merge",
    title: `Merge "${clip(sourceTitle, 80)}" into "${clip(targetTitle, 80)}"`,
    subtitle: target?.project_name ? `In ${target.project_name}` : "Merge tasks",
    lines,
    links: [
      {
        label: "Open kept task",
        app: "projects",
        entityType: "task",
        entityId: params.targetId,
      },
    ],
  }
}

/**
 * Approval summary for the gated `create` task tool. The reviewer sees the
 * task title, target project, and a body preview — a creation card that reads
 * like the task it will produce, not an opaque params dump.
 */
export async function summarizeCreateTask(
  params: {
    projectId?: string | null
    projectName?: string | null
    title: string
    description?: string | null
    assigneeName?: string | null
    priority?: string
    dueDate?: string | null
    statusLabel?: string | null
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  let projectName = params.projectName ?? null
  if (!projectName && params.projectId) {
    if (UUID_RE.test(params.projectId)) {
      const r = await ctx.tx.execute(drizzleSql`
        SELECT name FROM ${projectsRel("projects")}
        WHERE id = ${params.projectId}::uuid AND org_id = ${ctx.orgId}::uuid
        LIMIT 1
      `)
      projectName = extractRows<{ name: string }>(r)[0]?.name ?? null
    } else {
      // Agents sometimes put the project NAME in the id slot — show it as-is.
      projectName = params.projectId
    }
  }
  const lines: string[] = []
  if (params.description?.trim()) lines.push(clip(params.description.trim(), 220))
  if (params.assigneeName) lines.push(`Assignee: ${params.assigneeName}`)
  if (params.statusLabel) lines.push(`Status: ${params.statusLabel}`)
  if (params.priority) lines.push(`Priority: ${params.priority}`)
  if (params.dueDate) lines.push(`Due: ${params.dueDate}`)
  if (lines.length === 0) lines.push("(no description)")
  return {
    kind: "projects.create",
    title: `Create task: ${clip(params.title, 100)}`,
    subtitle: projectName ? `In ${projectName}` : "Create task",
    lines,
  }
}

/**
 * Approval summary for the gated `update` task tool. The reviewer sees WHICH
 * task changes (title, project) and exactly the fields the edit touches —
 * never a blind "Update task <uuid>".
 */
export async function summarizeUpdateTask(
  params: {
    taskId: string
    title?: string
    description?: string | null
    statusId?: string
    statusLabel?: string | null
    assigneeId?: string | null
    priority?: string
    dueDate?: string | null
    startDate?: string | null
    blocked?: boolean
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const task = await loadTaskSummary(ctx, params.taskId)
  const lines: string[] = []
  if (params.title !== undefined) lines.push(`Title -> ${clip(params.title, 120)}`)
  if (params.description !== undefined) {
    lines.push(
      params.description?.trim()
        ? `Description -> ${clip(params.description.trim(), 180)}`
        : "Description cleared",
    )
  }
  if (params.statusLabel) lines.push(`Status -> ${params.statusLabel}`)
  else if (params.statusId !== undefined) lines.push("Status changes")
  if (params.assigneeId !== undefined) lines.push(params.assigneeId ? "Reassigned" : "Unassigned")
  if (params.priority !== undefined) lines.push(`Priority -> ${params.priority}`)
  if (params.dueDate !== undefined) lines.push(`Due -> ${params.dueDate ?? "(cleared)"}`)
  if (params.startDate !== undefined) lines.push(`Start -> ${params.startDate ?? "(cleared)"}`)
  if (params.blocked !== undefined) lines.push(params.blocked ? "Marked blocked" : "Unblocked")
  if (lines.length === 0) lines.push("(no field changes)")
  return {
    kind: "projects.update",
    title: task ? `Update: ${clip(task.title, 100)}` : "Update task",
    subtitle: task?.project_name ? `In ${task.project_name}` : "Update task fields",
    lines,
    links: [
      {
        label: "Open task",
        app: "projects",
        entityType: "task",
        entityId: params.taskId,
      },
    ],
  }
}

/** Resolve the human-readable project name for a status-tool approval card. */
async function loadProjectName(
  ctx: { tx: RlsClient; orgId: string },
  params: { projectId?: string | null; projectName?: string | null },
): Promise<string | null> {
  if (params.projectName) return params.projectName
  if (!params.projectId) return null
  if (!UUID_RE.test(params.projectId)) return params.projectId
  const r = await ctx.tx.execute(drizzleSql`
    SELECT name FROM ${projectsRel("projects")}
    WHERE id = ${params.projectId}::uuid AND org_id = ${ctx.orgId}::uuid
    LIMIT 1
  `)
  return extractRows<{ name: string }>(r)[0]?.name ?? null
}

/** Resolve a status reference to its current label for a status-tool approval card. */
async function loadStatusLabel(
  ctx: { tx: RlsClient; orgId: string },
  params: { statusId?: string | null; statusLabel?: string | null },
): Promise<string | null> {
  if (params.statusLabel) return params.statusLabel
  if (!params.statusId) return null
  if (!UUID_RE.test(params.statusId)) return params.statusId
  const r = await ctx.tx.execute(drizzleSql`
    SELECT label FROM ${projectsRel("project_statuses")}
    WHERE id = ${params.statusId}::uuid AND org_id = ${ctx.orgId}::uuid
    LIMIT 1
  `)
  return extractRows<{ label: string }>(r)[0]?.label ?? null
}

export async function summarizeAddStatus(
  params: {
    projectId?: string | null
    projectName?: string | null
    label: string
    terminal?: boolean
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const projectName = await loadProjectName(ctx, params)
  const lines: string[] = []
  if (params.terminal) lines.push("Terminal column (tasks moved here count as done)")
  if (lines.length === 0) lines.push("New board column")
  return {
    kind: "projects.status_add",
    title: `Add status column: ${clip(params.label, 80)}`,
    subtitle: projectName ? `In ${projectName}` : "Add status column",
    lines,
  }
}

export async function summarizeUpdateStatus(
  params: {
    projectId?: string | null
    projectName?: string | null
    statusId?: string
    statusLabel?: string
    label?: string
    color?: string | null
    terminal?: boolean
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const projectName = await loadProjectName(ctx, params)
  const currentLabel = await loadStatusLabel(ctx, params)
  const lines: string[] = []
  if (params.label !== undefined) lines.push(`Label -> ${clip(params.label, 80)}`)
  if (params.color !== undefined) lines.push(`Color -> ${params.color ?? "(cleared)"}`)
  if (params.terminal !== undefined) {
    lines.push(params.terminal ? "Becomes terminal (counts as done)" : "Becomes non-terminal")
  }
  if (lines.length === 0) lines.push("(no field changes)")
  return {
    kind: "projects.status_update",
    title: currentLabel
      ? `Update status column: ${clip(currentLabel, 80)}`
      : "Update status column",
    subtitle: projectName ? `In ${projectName}` : "Update status column",
    lines,
  }
}

export async function summarizeDeleteStatus(
  params: {
    projectId?: string | null
    projectName?: string | null
    statusId?: string
    statusLabel?: string
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const projectName = await loadProjectName(ctx, params)
  const label = await loadStatusLabel(ctx, params)
  return {
    kind: "projects.status_delete",
    title: label ? `Delete status column: ${clip(label, 80)}` : "Delete status column",
    subtitle: projectName ? `In ${projectName}` : "Delete status column",
    lines: ["Only an EMPTY column can be deleted (tasks must be moved out first)"],
  }
}

type ChecklistItemSummaryRow = {
  id: string
  title: string
  details: string | null
  task_id: string
  task_title: string | null
  project_name: string | null
}

/**
 * Approval summary for the gated `checklist_remove_item` tool. The reviewer
 * sees WHICH item goes (its title, never the uuid) and on which task, since a
 * removed item takes its validation states with it.
 */
export async function summarizeRemoveChecklistItem(
  params: { itemId: string; taskId?: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const row = UUID_RE.test(params.itemId)
    ? extractRows<ChecklistItemSummaryRow>(
        await ctx.tx.execute(drizzleSql`
          SELECT i.id, i.title, i.details, i.task_id, t.title AS task_title, p.name AS project_name
          FROM ${projectsRel("task_checklist_items")} i
          LEFT JOIN ${projectsRel("tasks")} t ON t.id = i.task_id AND t.org_id = ${ctx.orgId}::uuid
          LEFT JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = ${ctx.orgId}::uuid
          WHERE i.id = ${params.itemId}::uuid AND i.org_id = ${ctx.orgId}::uuid
          LIMIT 1
        `),
      )[0]
    : undefined
  if (!row) {
    return {
      kind: "projects.checklist_remove_item",
      title: "Remove checklist item",
      subtitle: "Checklist item not found or already removed",
      lines: [`Item id: ${params.itemId}`],
    }
  }
  const lines = [`Task: ${clip(row.task_title ?? `task ${row.task_id}`, 140)}`]
  if (row.details?.trim()) lines.push(clip(row.details.trim(), 220))
  lines.push("Its validation states are removed with it")
  return {
    kind: "projects.checklist_remove_item",
    title: `Remove checklist item: ${clip(row.title, 80)}`,
    subtitle: row.project_name ? `In ${row.project_name}` : "Remove checklist item",
    lines,
    links: [{ label: "Open task", app: "projects", entityType: "task", entityId: row.task_id }],
  }
}

/**
 * Approval summary for `createProject` when it is held (a turn that read data
 * some project readers cannot see): the project and EVERY task it brings, so
 * the approver sees the whole plan they approve, numbered, with each task's
 * assignee. The card holds 8 lines of 200 characters: tasks are packed several
 * to a line, and the exact payload lists anything the card cannot.
 */
export async function summarizeCreateProject(
  params: {
    name: string
    description?: string | null
    tasks?: Array<{ title?: string; assigneeName?: string | null; timebox?: unknown }> | null
    timeBudgets?: boolean
  },
  _ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const lines: string[] = []
  if (params.description?.trim()) lines.push(clip(params.description.trim(), 200))
  const tasks = Array.isArray(params.tasks) ? params.tasks : []
  // Approving the card is the person turning time and budgets on: the card says so.
  if (params.timeBudgets === true) {
    const planned = tasks.filter((t) => typeof t.timebox === "string").length
    lines.push(
      planned > 0
        ? `Turns time and budgets on, with planned time on ${planned === 1 ? "1 task" : `${planned} tasks`}`
        : "Turns time and budgets on",
    )
  }
  if (tasks.length === 0) {
    lines.push("No tasks yet")
  } else {
    lines.push(tasks.length === 1 ? "1 task:" : `${tasks.length} tasks:`)
    const items = tasks.map((task, i) => {
      const title = clip(String(task.title ?? "").trim() || "(untitled)", 80)
      return `${i + 1}. ${title}${task.assigneeName ? ` (${task.assigneeName})` : ""}`
    })
    const MAX_LINES = 8
    let current = ""
    let shown = 0
    for (const item of items) {
      const next = current ? `${current} · ${item}` : item
      if (next.length <= 200) {
        current = next
        shown++
        continue
      }
      // Keep the last line free for the "and N more" note when tasks remain.
      if (lines.length >= MAX_LINES - 2) break
      lines.push(current)
      current = item
      shown++
    }
    if (current) lines.push(current)
    if (shown < items.length) lines.push(`and ${items.length - shown} more in the exact payload`)
  }
  return {
    kind: "projects.createProject",
    title: `Create project: ${clip(params.name, 100)}`,
    subtitle: tasks.length > 0 ? "A new project with its tasks" : "A new project",
    lines,
    impact: "internal",
  }
}

/**
 * Approval summary for the gated `client_report_send`: what goes out, to whom, and,
 * before Approve, a warning on any text that matches an internal note of the project or
 * an active member's name (deterministic, no model). The warning never blocks.
 */
export async function summarizeClientReportSend(
  params: { reportId?: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const { clientReportReadyToSend } = await import("~/apps/projects/service/client-reports")
  try {
    const ready = await clientReportReadyToSend({
      tx: ctx.tx,
      orgId: ctx.orgId,
      input: { reportId: params.reportId },
    })
    const r = ready.report
    return {
      kind: "projects.client_report_send",
      title: `Send the client report: ${clip(r.project_name, 80)}, week ending ${r.period_end}`,
      subtitle: `To ${ready.recipient.name ? `${ready.recipient.name} <${ready.recipient.email}>` : ready.recipient.email}`,
      lines: [
        ...ready.warnings.map((w) =>
          w.kind === "internal_note"
            ? `Warning: matches an internal note of the project: "${clip(w.words, 80)}"`
            : `Warning: names a member of your team: ${clip(w.words, 80)}`,
        ),
        ...r.sections.map((s) => `${clip(s.heading, 80)}: ${clip(s.text, 160)}`),
        ...(r.left_out.length > 0 ? [`Left out on purpose: ${r.left_out.length} item(s)`] : []),
      ],
    }
  } catch (err) {
    return {
      kind: "projects.client_report_send",
      title: "Send a client report",
      subtitle: "Send a client report",
      lines: [err instanceof Error ? err.message : "The report could not be read."],
    }
  }
}

interface DealCardRow {
  id: string
  title: string
  number: number | null
  project_key: string | null
  project_name: string
  company_name: string | null
}

const PERIOD_WORDS: Record<string, string> = { month: " per month", year: " per year" }

function dealAmount(minor: number, currency: unknown, period: unknown): string {
  const code = typeof currency === "string" ? currency.toUpperCase() : ""
  let digits = 2
  try {
    if (code) {
      digits =
        new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2
    }
  } catch {
    // Not a currency code: two decimals, as most are.
  }
  const amount = (minor / 10 ** digits).toFixed(digits)
  return `${amount}${code ? ` ${code}` : ""}${PERIOD_WORDS[String(period)] ?? ""}`
}

/**
 * Approval summary of `deals_update`, shown when a deal change is held for a decision: which deal,
 * whose, and what changes. The deal's stored amount is left out (it has a scope of its own, which
 * a decider may not hold), and so is a client shared by name.
 */
export async function summarizeDealsUpdate(
  params: Record<string, unknown>,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const ref = typeof params.taskId === "string" ? params.taskId.trim() : ""
  const { parseTaskKey, formatTaskKey } = await import("~/apps/projects/service/task-key")
  const key = UUID_RE.test(ref) ? null : parseTaskKey(ref)
  const names = async (table: "companies" | "contacts", id: unknown): Promise<string | null> => {
    if (typeof id !== "string" || !UUID_RE.test(id)) return null
    const [row] = extractRows<{ name: string | null }>(
      await ctx.tx.execute(drizzleSql`
        SELECT name FROM ${kernelRel(table)}
         WHERE id = ${id}::uuid AND org_id = ${ctx.orgId}::uuid AND org_access <> 'none'`),
    )
    return row?.name?.trim() || null
  }
  const [deal] =
    key || UUID_RE.test(ref)
      ? extractRows<DealCardRow>(
          await ctx.tx.execute(drizzleSql`
            SELECT t.id::text AS id, t.title, t.number, p.key AS project_key,
                   p.name AS project_name, c.name AS company_name
              FROM ${projectsRel("tasks")} t
              JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
              LEFT JOIN ${projectsRel("deals")} d ON d.task_id = t.id
              LEFT JOIN ${kernelRel("companies")} c
                ON c.id = d.company_id AND c.org_id = t.org_id AND c.org_access <> 'none'
             WHERE t.org_id = ${ctx.orgId}::uuid
               AND ${
                 key
                   ? drizzleSql`p.key = ${key.key} AND t.number = ${key.number}`
                   : drizzleSql`t.id = ${ref}::uuid`
               }
             LIMIT 1`),
        )
      : []
  const outcome = params.outcome
  const article = deal ? "the" : "a"
  const act =
    outcome === "won" || outcome === "lost"
      ? `Mark ${article} deal ${outcome}`
      : outcome === "open"
        ? `Reopen ${article} deal`
        : `Change ${article} deal`

  const lines: string[] = []
  const says = (field: string, value: unknown, words: (v: unknown) => string = String) => {
    if (value === undefined) return
    lines.push(`${field}: ${value === null || value === "" ? "cleared" : clip(words(value), 160)}`)
  }
  says("Outcome", outcome)
  says("Reason", params.reason)
  if (params.companyId !== undefined) {
    const name = await names("companies", params.companyId)
    says("Client", params.companyId, () => name ?? "a company shared by name")
  }
  if (params.contactId !== undefined) {
    const name = await names("contacts", params.contactId)
    says("Contact", params.contactId, () => name ?? "a contact shared by name")
  }
  says("Amount", params.amountMinor, (v) =>
    dealAmount(Number(v), params.currency, params.amountPeriod),
  )
  says("Probability", params.probability, (v) => `${String(v)}%`)
  says("Next step", params.nextStep)

  return {
    kind: "projects.deals_update",
    title: deal ? `${act}: ${clip(deal.title, 120)}` : act,
    subtitle: deal
      ? [deal.company_name, deal.project_name]
          .filter((n): n is string => Boolean(n))
          .map((n) => clip(n, 90))
          .join(", ")
      : "The deal is not visible to the person who asked",
    ...(deal?.project_key && deal.number !== null
      ? { ref: formatTaskKey(deal.project_key, deal.number) }
      : {}),
    lines,
    ...(deal
      ? {
          links: [{ label: "Open deal", app: "projects", entityType: "task", entityId: deal.id }],
        }
      : {}),
  }
}
