// SPDX-License-Identifier: FSL-1.1-ALv2
// Per-test fixtures for the Projects and Attention feed browser scenarios.
// Rows come from the product: the projects REST routes with the test's token,
// and `/api/_test/seed` factories (roles, tickets, gated approvals) for what a
// test cannot make through a route. Scope grants happen before browser login
// because scopes are embedded into JWTs at issuance.
import { randomUUID } from "node:crypto"
import type { WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { seedGatedApproval } from "./approvals-seed"
import { getActiveUsersNamed, getTicketSlaTargetSeconds } from "./db-reads"
import { seedFactory, seedTicket, seedTicketMessages } from "./seed"

const PROJECT_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
] as const

const TICKET_SCOPES = ["tickets:tickets:read", "tickets:tickets:write"] as const

/**
 * Give the person the scopes they do not hold yet, through a role (the role
 * editor's services). Only missing ones: the admin holds `*`, so its grant is
 * a no-op and its worker-cached token stays valid. Anyone else's permission
 * version moves, so a token issued before this call is stale afterwards.
 */
async function grantMissingScopes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  scopes: string[],
  label: string,
): Promise<void> {
  await seedFactory(env, orgId, "roles.grantScopes", {
    userId,
    scopes,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    onlyMissing: true,
  })
}

/** Grant the four projects scopes to a user. Run BEFORE loginAs. */
export async function grantProjectScopes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
): Promise<void> {
  await grantMissingScopes(env, orgId, userId, [...PROJECT_SCOPES], "e2e-projects")
}

/**
 * Grant the union of scopes the attention scenarios need: projects + tickets +
 * kernel:approvals + the test app's gated tools (the person requests the
 * seeded approvals) and `test:approve` (they decide them).
 */
export async function grantPhase8AttentionScopes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
): Promise<void> {
  await grantMissingScopes(
    env,
    orgId,
    userId,
    [
      ...PROJECT_SCOPES,
      ...TICKET_SCOPES,
      "kernel:approvals:read",
      "kernel:approvals:write",
      "test:gated:write",
      "test:items:write",
      "test:approve",
    ],
    "e2e-attn",
  )
}

/**
 * Ensure exactly one active "Marie" user exists in the worker's org and return her id.
 * Goes through /api/admin/invites + /api/auth/register so the password hash uses the
 * production argon2 path (matching QA-user conventions). Idempotent across reruns.
 */
export async function ensureActiveMarie(
  env: WorkerEnv,
  world: { admin: { token: string }; org: { id: string }; serverUrl: string },
): Promise<{ id: string; email: string }> {
  const existing = await getActiveUsersNamed(env, world.org.id, "marie")
  if (existing.length > 1) {
    throw new Error(`ensureActiveMarie: ${existing.length} active Marie users — refusing to seed`)
  }
  if (existing.length === 1) return existing[0]!

  const created = await createUserWithScopes(
    world.serverUrl,
    env.db.sql,
    world.admin.token,
    world.org.id,
    {
      email: `marie-${randomUUID().slice(0, 8)}@e2e.test`,
      password: "QaPass1!",
      name: "Marie",
      scopes: [...PROJECT_SCOPES],
      schemaPrefix: env.schemaPrefix,
    },
  )
  return { id: created.id, email: created.email }
}

interface SeededProject {
  id: string
  statuses: Array<{ id: string; label: string; terminal: boolean; order: number }>
}

/**
 * Create a project (and optional tasks) via the real /api/projects routes.
 * Uses the supplied token (caller must already have projects:projects:write).
 */
export async function seedProjectWithTasks(
  env: WorkerEnv,
  token: string,
  opts: {
    name: string
    description?: string
    /** Explicit project key; omitted, the API derives one from the name. */
    key?: string
    tasks?: Array<{
      title: string
      assigneeId?: string
      statusLabel?: string
      dueDate?: string
      blocked?: boolean
    }>
  },
): Promise<SeededProject & { tasks: Array<{ id: string; title: string }> }> {
  const projectRes = await api(env.serverUrl, "/api/projects", {
    token,
    body: {
      name: opts.name,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.key ? { key: opts.key } : {}),
    },
  })
  if (projectRes.status !== 200) {
    throw new Error(
      `seedProjectWithTasks: project create failed ${projectRes.status}: ${JSON.stringify(projectRes.body)}`,
    )
  }
  const project = projectRes.body.data as SeededProject
  const tasks: Array<{ id: string; title: string }> = []
  for (const t of opts.tasks ?? []) {
    const statusId = t.statusLabel
      ? project.statuses.find((s) => s.label === t.statusLabel)?.id
      : undefined
    const r = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
      token,
      body: {
        title: t.title,
        ...(statusId ? { statusId } : {}),
        ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
        ...(t.dueDate ? { dueDate: t.dueDate } : {}),
        ...(t.blocked ? { blocked: t.blocked } : {}),
      },
    })
    if (r.status !== 200) {
      throw new Error(
        `seedProjectWithTasks: task create failed ${r.status}: ${JSON.stringify(r.body)}`,
      )
    }
    const created = r.body.data as { id: string; title: string }
    tasks.push({ id: created.id, title: created.title })
  }
  return { ...project, tasks }
}

interface ApiPage<T> {
  items: T[]
  nextCursor?: string | null
}

/**
 * Take every live project of the org out of the workspace through the
 * product: each project's tasks are deleted (the org-wide release counts and
 * the cross-project views read live tasks) and the project is archived. Use
 * in scenarios where each test must start from a known project list. The
 * token must hold the projects write scopes.
 */
export async function clearAllProjects(env: WorkerEnv, token: string): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const res = await api(env.serverUrl, "/api/projects?limit=100", { token })
    if (res.status !== 200) {
      throw new Error(`clearAllProjects: list failed ${res.status}: ${JSON.stringify(res.body)}`)
    }
    const projects = (res.body.data as ApiPage<{ id: string }>).items
    if (projects.length === 0) return
    for (const project of projects) {
      const tasks = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, { token })
      if (tasks.status !== 200) {
        throw new Error(`clearAllProjects: tasks of ${project.id} failed ${tasks.status}`)
      }
      // Deleting a task deletes its subtree; an already deleted child is a no-op.
      for (const task of (tasks.body.data as ApiPage<{ id: string }>).items) {
        const del = await api(env.serverUrl, `/api/projects/${project.id}/tasks/${task.id}`, {
          method: "DELETE",
          token,
        })
        if (del.status >= 300 && del.status !== 404) {
          throw new Error(`clearAllProjects: task delete failed ${del.status}`)
        }
      }
      const archived = await api(env.serverUrl, `/api/projects/${project.id}/archive`, {
        method: "POST",
        token,
      })
      if (archived.status !== 200) {
        throw new Error(
          `clearAllProjects: archive failed ${archived.status}: ${JSON.stringify(archived.body)}`,
        )
      }
    }
  }
  throw new Error("clearAllProjects: projects kept coming back")
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface FeedItem {
  app: string
  entity?: string
  entityId?: string
  kind: string
  metadata?: { projectId?: string }
}

/**
 * Clear what the person's attention feed shows, through the product, so rows
 * worker-shared tests left behind cannot leak into a deterministic feed. Only
 * the rows in THIS person's feed are touched:
 *
 * - Projects: their task rows are unassigned (PATCH, `adminToken`).
 * - Tickets: the tickets in the feed are closed (the state machine's close).
 * - Approvals: the pending approvals in the feed are denied (`adminToken`; the
 *   admin is always an eligible approver).
 * - Everything else (mentions, replies, ...): marked read as the person.
 *
 * `token` is the person's own, valid one (issued after any grant to them).
 */
export async function resetAttentionForUser(
  env: WorkerEnv,
  orgId: string,
  token: string,
  adminToken: string = token,
): Promise<void> {
  const res = await api(env.serverUrl, "/api/attention-items", { token })
  if (res.status !== 200) {
    throw new Error(`resetAttentionForUser: feed read failed ${res.status}`)
  }
  const items = (res.body.data?.items ?? res.body.data ?? []) as FeedItem[]
  const ticketIds = new Set<string>()
  const markRead: Array<{ app: string; entityType: string; entityId: string }> = []
  for (const item of items) {
    if (!item.entityId) continue
    if (item.app === "projects" && item.entity === "task" && item.metadata?.projectId) {
      const r = await api(
        env.serverUrl,
        `/api/projects/${item.metadata.projectId}/tasks/${item.entityId}`,
        { method: "PATCH", token: adminToken, body: { assigneeId: null } },
      )
      if (r.status !== 200 && r.status !== 404) {
        throw new Error(`resetAttentionForUser: unassign failed ${r.status}`)
      }
    } else if (item.app === "tickets" && item.entity === "ticket" && UUID.test(item.entityId)) {
      ticketIds.add(item.entityId)
    } else if (item.kind === "approval_pending") {
      const r = await api(env.serverUrl, `/api/approvals/${item.entityId}/decide`, {
        token: adminToken,
        body: { decision: "deny", reason: "test isolation" },
      })
      if (r.status >= 300 && r.status !== 404 && r.status !== 409) {
        throw new Error(`resetAttentionForUser: deny failed ${r.status}: ${JSON.stringify(r.body)}`)
      }
    } else if (item.entity) {
      markRead.push({ app: item.app, entityType: item.entity, entityId: item.entityId })
    }
  }
  if (ticketIds.size > 0) {
    await seedFactory(env, orgId, "tickets.close", { ticketIds: [...ticketIds] })
  }
  for (let i = 0; i < markRead.length; i += 50) {
    await api(env.serverUrl, "/api/attention-items/mark-read-bulk", {
      token,
      body: { items: markRead.slice(i, i + 50) },
    })
  }
}

interface SeededAttentionFixtures {
  projectId: string
  overdueTaskId: string
  ticketId: string
  approvalRequestId: string
}

/**
 * Seed exactly one row per provider (projects/tickets/approvals) for the target user.
 * Caller must already hold the relevant scopes (use grantPhase8AttentionScopes BEFORE login)
 * and reset the feed first (resetAttentionForUser).
 *
 * - Projects: one overdue task assigned to userId.
 * - Tickets: one open ticket awaiting a reply, five minutes old.
 * - Approvals: one pending `test:gatedEcho` approval the user's agent requested
 *   through the gate, which the user can decide (`test:approve`).
 */
export async function seedAttentionFixtures(
  env: WorkerEnv,
  params: { orgId: string; userId: string; adminToken: string; inboxId: string },
): Promise<SeededAttentionFixtures> {
  // ── Projects: overdue task ──
  const proj = await seedProjectWithTasks(env, params.adminToken, {
    name: `AttnFeed-${randomUUID().slice(0, 6)}`,
    tasks: [
      {
        title: "Overdue calibration",
        assigneeId: params.userId,
        dueDate: "2024-01-01",
      },
    ],
  })
  const overdueTaskId = proj.tasks[0]!.id

  // ── Tickets: open ticket waiting on agent reply (awaiting_agent) ──
  // Five minutes old, so the > 1h unassigned rule does not fire and the feed
  // keeps exactly one tickets row for it.
  const ticket = await seedTicket(env, params.orgId, {
    subject: "Awaiting agent reply (attention feed seed)",
    sourceInboxId: params.inboxId,
  })

  // ── Approvals: pending approval the user requested and decides ──
  const approval = await seedGatedApproval(env, params.orgId, {
    requesterUserId: params.userId,
    approverUserIds: [params.userId],
    title: "Approve attention seed",
    params: { message: "attn seed", lines: ["Body preview: attn seed"] },
  })

  return {
    projectId: proj.id,
    overdueTaskId,
    ticketId: ticket.id,
    approvalRequestId: approval.approvalRequestId,
  }
}

/**
 * Seed N pending approvals across a set of gated tool names, so the Home
 * approval facet bar has something to face. Each one is requested by
 * `userId`'s agent through the kernel's gate (in one conversation) and is
 * decidable by them, with parameters the tool accepts (an approve replays
 * them).
 *
 * Returns the created approval ids grouped by tool name, so a scenario can
 * assert exactly which rows a facet should keep and which it should hide.
 */
export async function seedApprovalsForFacets(
  env: WorkerEnv,
  params: { orgId: string; userId: string; toolNames: string[] },
): Promise<Record<string, string[]>> {
  const byTool: Record<string, string[]> = {}
  let threadId: string | undefined
  for (const toolName of params.toolNames) {
    const seeded = await seedGatedApproval(env, params.orgId, {
      requesterUserId: params.userId,
      approverUserIds: [params.userId],
      toolName,
      title: "Approval facet seed",
      ...(threadId ? { threadId } : {}),
      params:
        toolName === "test:gatedCreateItem"
          ? { title: "facet seed", team: "facet" }
          : { message: "facet seed" },
    })
    threadId = seeded.threadId
    ;(byTool[toolName] ??= []).push(seeded.approvalRequestId)
  }
  return byTool
}

// ─── Rich populated fixtures (visual QA) ───────────────────────────────────
//
// These helpers exist to put the workspace in a *populated* state so visual
// tests can validate layout density, balance, and overflow behaviour — the
// thin K1/K2/K3 fixtures used by per-feature scenarios are intentionally
// minimal and produce sparse-looking screenshots.

export interface RichProjectSeed {
  id: string
  name: string
  statuses: Array<{ id: string; label: string; terminal: boolean; order: number }>
  tasks: Array<{ id: string; title: string; statusLabel: string; depth: number }>
}

interface RichProjectSpec {
  /** Stable name that appears in screenshots. Avoid Date.now / random suffixes. */
  name: string
  description?: string
  /** Optional explicit owner (defaults to the token's user). */
  ownerId?: string
  /**
   * Distribution of *root* tasks per default status. Subtasks are added on
   * top of these parents; the totals below describe roots only.
   * Default profile (~28 tasks total) lands across all five statuses.
   */
  distribution?: {
    backlog?: number
    todo?: number
    in_progress?: number
    done?: number
    cancelled?: number
  }
  /**
   * Indices (within the *flat root list*) that get a small subtask tree.
   * Each entry adds 2 children, and the first child gets 1 grandchild
   * (depth=3). Default mirrors a realistic mix.
   */
  subtaskParents?: number[]
  /** Round-robin assignee pool. If omitted, tasks stay unassigned. */
  assigneeIds?: string[]
  /** Anchor date used for relative due-date generation. Defaults to today. */
  anchor?: Date
}

const DEFAULT_DISTRIBUTION = {
  backlog: 6,
  todo: 8,
  in_progress: 5,
  done: 6,
  cancelled: 3,
} satisfies Required<RichProjectSpec["distribution"]>

// Stable, deterministic titles. Order matters — they're consumed sequentially
// so the same dataset shows the same labels in the same positions every run.
const TASK_TITLES = [
  "Audit user-permission edge cases",
  "Replace logo asset with vector mark",
  "Backfill OAuth refresh-token rotation",
  "Calibration drift on load-cell #4",
  "Document the data-export flow",
  "Drop legacy /v1 search endpoint",
  "Email-bounce dashboard for support",
  "Enable strict CSP on marketing pages",
  "Fix flaky CI step in worker matrix",
  "Investigate intermittent 502 on staging",
  "Migrate auth middleware to Hono v5",
  "Move pricing seed to LiteLLM source",
  "Onboard Marie to release rotation",
  "Patch SSO assertion replay window",
  "Pin Playwright to 1.59 for visual stability",
  "Profile ProjectKanbanView render path",
  "Promote feature flag: unified attention",
  "Publish Q2 roadmap to public site",
  "Reconcile invoice INV-4271 with billing ledger",
  "Refactor outbox worker leader election",
  "Remove unused activity-bar slot",
  "Rename status 'in_progress' → 'doing'",
  "Run accessibility audit on Home feed",
  "Schedule data-deletion compliance pass",
  "Spike: deterministic LLM provider boundary",
  "Switch tooltip motion to 120ms ease-out",
  "Tighten thread-references rate limit",
  "Triage user-reported regressions",
  "Update README quickstart for Bun 1.3",
  "Verify SLA timer on closed tickets",
  "Wire new emoji set into reactions",
  "Write postmortem: Tuesday 03:00 incident",
] as const

const SUBTASK_TITLES = [
  "Reproduce on staging",
  "Capture trace + logs",
  "Draft fix in branch",
  "Add regression test",
  "Get review from owning team",
  "Write changelog entry",
  "Verify in canary",
  "Roll out to production",
  "Update operator runbook",
  "Notify support of behaviour change",
  "Backfill historical rows",
  "Schedule deprecation window",
] as const

const PRIORITIES = ["low", "normal", "normal", "high", "urgent"] as const

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!
}

function isoDay(anchor: Date, deltaDays: number): string {
  const d = new Date(anchor.getTime() + deltaDays * 86400000)
  return d.toISOString().slice(0, 10)
}

/**
 * Create a *populated* project with realistic metadata for visual QA. Returns
 * stable, deterministic content so snapshots compare reliably across runs.
 *
 * Goes through the real /api/projects routes (no privileged DB inserts) so the
 * server-side hooks (events, RLS, attention providers) all run.
 */
export async function seedRichProject(
  env: WorkerEnv,
  token: string,
  spec: RichProjectSpec,
): Promise<RichProjectSeed> {
  const distribution = { ...DEFAULT_DISTRIBUTION, ...(spec.distribution ?? {}) }
  const anchor = spec.anchor ?? new Date()

  const projRes = await api(env.serverUrl, "/api/projects", {
    token,
    body: {
      name: spec.name,
      ...(spec.description ? { description: spec.description } : {}),
    },
  })
  if (projRes.status !== 200) {
    throw new Error(
      `seedRichProject: project create failed ${projRes.status}: ${JSON.stringify(projRes.body)}`,
    )
  }
  const project = projRes.body.data as RichProjectSeed
  const statusByLabel = new Map(project.statuses.map((s) => [s.label, s]))

  const tasks: RichProjectSeed["tasks"] = []
  let titleIdx = 0
  let subIdx = 0
  let positionalIdx = 0
  const subtaskParentSet = new Set(spec.subtaskParents ?? [0, 2, 4, 7, 11, 14, 18, 22])

  const order: Array<keyof typeof distribution> = [
    "backlog",
    "todo",
    "in_progress",
    "done",
    "cancelled",
  ]

  for (const statusLabel of order) {
    const count = distribution[statusLabel] ?? 0
    const status = statusByLabel.get(statusLabel)
    if (!status || count === 0) continue
    for (let i = 0; i < count; i++) {
      const title = pick(TASK_TITLES, titleIdx++)
      // Due-date pattern: a few overdue, a few this-week, most none.
      // Skip dues for terminal statuses — they read as noise on done/cancelled.
      let dueDate: string | undefined
      if (!status.terminal) {
        if (i % 7 === 0) dueDate = isoDay(anchor, -2 - (i % 4))
        else if (i % 5 === 0) dueDate = isoDay(anchor, 3 + (i % 4))
      }
      const blocked = !status.terminal && i % 11 === 0
      const priority = pick(PRIORITIES, titleIdx + i)
      const assigneeId = spec.assigneeIds?.length
        ? spec.assigneeIds[positionalIdx % spec.assigneeIds.length]
        : undefined
      const r = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
        token,
        body: {
          title,
          statusId: status.id,
          ...(dueDate ? { dueDate } : {}),
          ...(blocked ? { blocked: true } : {}),
          ...(priority !== "normal" ? { priority } : {}),
          ...(assigneeId ? { assigneeId } : {}),
        },
      })
      if (r.status !== 200) {
        throw new Error(
          `seedRichProject: task create failed ${r.status}: ${JSON.stringify(r.body)}`,
        )
      }
      const created = r.body.data as { id: string; title: string }
      tasks.push({ id: created.id, title: created.title, statusLabel, depth: 1 })

      // Subtasks for selected parent indices — depth 2 + a single grandchild
      // on the first child (depth 3) for tree-line visual coverage.
      if (subtaskParentSet.has(positionalIdx)) {
        const childIds: string[] = []
        for (let c = 0; c < 2; c++) {
          const subTitle = pick(SUBTASK_TITLES, subIdx++)
          const childRes = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
            token,
            body: {
              title: subTitle,
              parentTaskId: created.id,
              statusId: status.id,
              ...(spec.assigneeIds?.length
                ? {
                    assigneeId: spec.assigneeIds[(positionalIdx + c + 1) % spec.assigneeIds.length],
                  }
                : {}),
            },
          })
          if (childRes.status !== 200) {
            throw new Error(
              `seedRichProject: child create failed ${childRes.status}: ${JSON.stringify(childRes.body)}`,
            )
          }
          const child = childRes.body.data as { id: string; title: string }
          childIds.push(child.id)
          tasks.push({ id: child.id, title: child.title, statusLabel, depth: 2 })
        }
        if (childIds[0]) {
          const grandTitle = pick(SUBTASK_TITLES, subIdx++)
          const grandRes = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
            token,
            body: {
              title: grandTitle,
              parentTaskId: childIds[0],
              statusId: status.id,
            },
          })
          if (grandRes.status === 200) {
            const g = grandRes.body.data as { id: string; title: string }
            tasks.push({ id: g.id, title: g.title, statusLabel, depth: 3 })
          }
        }
      }
      positionalIdx++
    }
  }

  return { id: project.id, name: project.name ?? spec.name, statuses: project.statuses, tasks }
}

export interface ProjectsLandingSeed {
  ownerProjects: Array<{ id: string; name: string }>
}

/**
 * Create a stable set of named projects so the projects-home landing reads as a
 * realistic workspace (not a one-row demo). Each project gets a small but
 * non-zero task count so the row meta-line ("N tasks") populates.
 */
export async function seedProjectsLandingBaseline(
  env: WorkerEnv,
  token: string,
  opts: { assigneeIds?: string[] } = {},
): Promise<ProjectsLandingSeed> {
  const specs: RichProjectSpec[] = [
    {
      name: "Bug Tracker",
      description: "Customer-reported defects and triage queue.",
      distribution: { backlog: 4, todo: 6, in_progress: 3, done: 2, cancelled: 1 },
      subtaskParents: [1, 4, 8],
      assigneeIds: opts.assigneeIds,
    },
    {
      name: "Q2 Roadmap",
      description: "Quarterly planning and execution tracker.",
      distribution: { backlog: 3, todo: 4, in_progress: 2, done: 4, cancelled: 0 },
      subtaskParents: [2, 5],
      assigneeIds: opts.assigneeIds,
    },
    {
      name: "Mobile App Launch",
      description: "iOS + Android launch checklist.",
      distribution: { backlog: 5, todo: 3, in_progress: 4, done: 1, cancelled: 0 },
      subtaskParents: [0, 3, 6],
      assigneeIds: opts.assigneeIds,
    },
    {
      name: "Customer Onboarding",
      description: "Reduce time-to-first-value for new orgs.",
      distribution: { backlog: 2, todo: 3, in_progress: 1, done: 3, cancelled: 1 },
      assigneeIds: opts.assigneeIds,
    },
    {
      name: "Internal Tools",
      description: "Eng productivity + observability investments.",
      distribution: { backlog: 1, todo: 2, in_progress: 1, done: 2, cancelled: 0 },
      assigneeIds: opts.assigneeIds,
    },
  ]
  const ownerProjects: Array<{ id: string; name: string }> = []
  for (const spec of specs) {
    const seed = await seedRichProject(env, token, spec)
    ownerProjects.push({ id: seed.id, name: seed.name })
  }
  return { ownerProjects }
}

// ─── Rich, populated attention feed (visual QA) ────────────────────────────
//
// `seedAttentionFixtures` emits exactly one row per provider — fine for unit
// scenarios but visually thin. `seedRichAttentionFeed` produces a varied set
// of ~12 attention rows across all kinds (overdue at varying days_over,
// due-this-week at varying days_remaining, blocked, SLA imminent, awaiting,
// unassigned, two approvals — one expiring within the hour, one not), so
// the home feed snapshot exercises every metric tone, every kind icon, the
// stagger animation, and the lower-priority collapsible.
export interface RichAttentionSeed {
  projectId: string
  taskIds: { overdueId: string; thisWeekId: string; blockedId: string }
  ticketIds: { slaImminentId: string; awaitingId: string; unassignedId: string }
  approvalIds: { soonId: string; normalId: string }
}

const RICH_ATTENTION_TASKS = [
  // Overdue (varying days). Most urgent first.
  { title: "Calibration drift on load-cell #4", deltaDays: -7, blocked: false },
  { title: "Patch SSO assertion replay window", deltaDays: -3, blocked: false },
  { title: "Audit user-permission edge cases", deltaDays: -1, blocked: false },
  // Due this week.
  { title: "Investigate intermittent 502 on staging", deltaDays: 2, blocked: false },
  { title: "Onboard Marie to release rotation", deltaDays: 4, blocked: false },
  // Blocked (no due date — appears as "blocked" metric).
  { title: "Migrate auth middleware to Hono v5", deltaDays: null, blocked: true },
] as const

export async function seedRichAttentionFeed(
  env: WorkerEnv,
  params: {
    orgId: string
    userId: string
    adminToken: string
    inboxId: string
  },
): Promise<RichAttentionSeed> {
  // ── Projects: 6 task rows (3 overdue, 2 due-this-week, 1 blocked) ──
  const today = new Date()
  const isoDate = (delta: number) =>
    new Date(today.getTime() + delta * 86400000).toISOString().slice(0, 10)
  const proj = await seedProjectWithTasks(env, params.adminToken, {
    name: "Bug Tracker",
    tasks: RICH_ATTENTION_TASKS.map((t) => ({
      title: t.title,
      assigneeId: params.userId,
      ...(t.deltaDays !== null ? { dueDate: isoDate(t.deltaDays) } : {}),
      ...(t.blocked ? { blocked: true } : {}),
    })),
  })

  const findId = (title: string): string => proj.tasks.find((x) => x.title === title)?.id ?? ""

  // ── Tickets: 3 rows exercising different kinds ──

  // 1. SLA imminent: unanswered, created 85% of the org's high-priority SLA
  //    target ago, so its deadline is inside the last quarter.
  const highTargetSeconds = await getTicketSlaTargetSeconds(env, params.orgId, "high")
  const slaImminent = await seedFactory<{ id: string }>(env, params.orgId, "tickets.ticket", {
    subject: "Refund processing failure on plan-upgrade",
    priority: "high",
    sourceInboxId: params.inboxId,
    createdMinutesAgo: Math.round((highTargetSeconds * 0.85) / 60),
  })
  // The deadline walks the org's business hours from the creation time, so a
  // ticket created 85% of the target ago is "inside the last quarter" only when
  // the whole span fell inside working hours: after hours its deadline rolls to
  // the next working morning and the row is not an SLA risk. Pin the deadline
  // to the last quarter, whatever the time of day the run happens at.
  const ticketsSchema = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
  await env.db.sql.unsafe(
    `UPDATE ${ticketsSchema}.tickets
        SET sla_deadline = now() + make_interval(secs => sla_target_seconds * 0.15)
      WHERE id = $1 AND org_id = $2`,
    [slaImminent.id, params.orgId],
  )

  // 2. Awaiting agent reply: assigned to the user (so the unassigned rule
  //    does not fire for it), answered once, then a newer customer message.
  const awaiting = await seedFactory<{ id: string }>(env, params.orgId, "tickets.ticket", {
    subject: "Question about team-tier monthly reset",
    sourceInboxId: params.inboxId,
    assignedTo: params.userId,
    createdMinutesAgo: 6 * 60,
    firstResponseMinutesAgo: 5 * 60,
  })
  await seedTicketMessages(env, params.orgId, awaiting.id, [
    { kind: "inbound", textBody: "follow-up question", sentAtOffsetSeconds: -2 * 3600 },
  ])

  // 3. Unassigned: open, no assignee, > 1h old, already answered (no SLA
  //    risk) and no customer message (no awaiting_agent).
  const unassigned = await seedFactory<{ id: string }>(env, params.orgId, "tickets.ticket", {
    subject: "Webhook delivery to acme.dev intermittently 502s",
    priority: "low",
    sourceInboxId: params.inboxId,
    withInboundMessage: false,
    createdMinutesAgo: 4 * 60,
    firstResponseMinutesAgo: 90,
  })

  // ── Approvals: 2 pending, requested by the user's agent through the gate ──
  // The tool sets the window: test:gatedEcho expires in an hour (inside the
  // feed's last-hour warning tone), test:gatedEchoLater in six (the calm tone).
  const approvalSoon = await seedGatedApproval(env, params.orgId, {
    requesterUserId: params.userId,
    approverUserIds: [params.userId],
    title: "Send follow-up to billing-customer@example.com",
    params: { message: "Send follow-up to billing-customer@example.com" },
  })
  const approvalNormal = await seedGatedApproval(env, params.orgId, {
    requesterUserId: params.userId,
    approverUserIds: [params.userId],
    threadId: approvalSoon.threadId,
    toolName: "test:gatedEchoLater",
    title: "Forward Hans Weber to mailbox archive",
    params: { message: "Forward Hans Weber to mailbox archive" },
  })

  return {
    projectId: proj.id,
    taskIds: {
      overdueId: findId("Calibration drift on load-cell #4"),
      thisWeekId: findId("Investigate intermittent 502 on staging"),
      blockedId: findId("Migrate auth middleware to Hono v5"),
    },
    ticketIds: {
      slaImminentId: slaImminent.id,
      awaitingId: awaiting.id,
      unassignedId: unassigned.id,
    },
    approvalIds: {
      soonId: approvalSoon.approvalRequestId,
      normalId: approvalNormal.approvalRequestId,
    },
  }
}

/**
 * Install a route observer that fails the test on any request to /api/apps/<app>/attention-items.
 * The unified aggregator is the only path; per-app frontend fetches indicate a regression.
 */
export async function observeNoPerAppAttentionFetches(page: Page): Promise<() => Promise<void>> {
  const violations: string[] = []
  const handler = async (route: import("@playwright/test").Route) => {
    violations.push(route.request().url())
    await route.fallback()
  }
  await page.route("**/api/apps/*/attention-items**", handler)
  return async () => {
    await page.unroute("**/api/apps/*/attention-items**", handler)
    if (violations.length > 0) {
      throw new Error(`forbidden per-app attention-items fetches: ${violations.join(", ")}`)
    }
  }
}

// ─── Checklist + release fixtures ──────────────────────────────────────────
//
// Thin wrappers over the real checklist REST routes, for scenarios that need
// a checklist in place before the page loads (the checklist scenario itself
// drives the UI instead).

/** PUT /projects/:id/validation-levels; returns the saved levels in order. */
export async function setValidationLevels(
  env: WorkerEnv,
  token: string,
  projectId: string,
  levels: Array<{ name: string }>,
): Promise<Array<{ id: string; name: string }>> {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/validation-levels`, {
    method: "PUT",
    token,
    body: { levels: levels.map((l) => ({ name: l.name })) },
  })
  if (r.status !== 200) {
    throw new Error(`setValidationLevels failed ${r.status}: ${JSON.stringify(r.body)}`)
  }
  return (r.body.data as { levels: Array<{ id: string; name: string }> }).levels
}

/** POST /projects/:id/tasks/:taskId/checklist; returns the created items. */
export async function addChecklistItems(
  env: WorkerEnv,
  token: string,
  projectId: string,
  taskId: string,
  titles: string[],
): Promise<Array<{ id: string; title: string }>> {
  const r = await api(env.serverUrl, `/api/projects/${projectId}/tasks/${taskId}/checklist`, {
    token,
    body: { items: titles.map((title) => ({ title })) },
  })
  if (r.status !== 200) {
    throw new Error(`addChecklistItems failed ${r.status}: ${JSON.stringify(r.body)}`)
  }
  return (r.body.data as { items: Array<{ id: string; title: string }> }).items
}

/** POST /projects/:id/tasks/:taskId/checklist/validations (human actor). */
export async function setChecklistValidations(
  env: WorkerEnv,
  token: string,
  projectId: string,
  taskId: string,
  validations: Array<{
    itemId: string
    level: string
    state: "not_done" | "fail" | "success" | "na"
    note?: string
  }>,
): Promise<void> {
  const r = await api(
    env.serverUrl,
    `/api/projects/${projectId}/tasks/${taskId}/checklist/validations`,
    { token, body: { validations } },
  )
  if (r.status !== 200) {
    throw new Error(`setChecklistValidations failed ${r.status}: ${JSON.stringify(r.body)}`)
  }
}

// Task labels. The taxonomy itself is always written through the
// production paths (settings tree or `projects:labels.*` tools); this only
// archives it, and db-reads.ts reads back the ids the UI-created nodes got.

/**
 * Archive every live label group of the org through `projects:labels.archive`
 * (its values go with it), so a scenario starts from "no label group". The
 * token must hold `projects:labels:admin`.
 */
export async function clearAllLabels(env: WorkerEnv, token: string): Promise<void> {
  const res = await api(env.serverUrl, "/api/apps/run-tool", {
    token,
    body: { toolName: "projects:labels.list", params: {} },
  })
  const groups = (res.body as { data?: { groups?: Array<{ id: string; archived?: boolean }> } })
    .data?.groups
  if (res.status !== 200 || !groups) {
    throw new Error(`clearAllLabels: labels.list failed ${res.status}: ${JSON.stringify(res.body)}`)
  }
  for (const group of groups) {
    if (group.archived) continue
    const r = await api(env.serverUrl, "/api/apps/run-tool", {
      token,
      body: { toolName: "projects:labels.archive", params: { id: group.id, archived: true } },
    })
    const data = (r.body as { data?: { error?: unknown } }).data
    if (r.status !== 200 || !data || data.error !== undefined) {
      throw new Error(`clearAllLabels: archive failed ${r.status}: ${JSON.stringify(r.body)}`)
    }
  }
}
