// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { UUID_RE } from "~/lib/uuid"
import { loadDiscussionTask } from "./discussion-task"
import { ProjectsServiceError } from "./statuses"
import { parseTaskKey } from "./task-key"

type SqlClient = RlsClient | RlsTx

/** The ONLY values `app_projects.tasks.priority` accepts — the column carries a
 *  `CHECK (priority IN ('low','normal','high','urgent'))` (0000_initial), so any
 *  other string is a constraint violation at INSERT/UPDATE time, not a soft
 *  fallback. Kept here (not in routes.ts) so every caller shares one list. */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const

/**
 * Validate a caller-supplied priority BEFORE it reaches SQL. The REST routes zod-
 * check it, but the agent tool path (sandbox handler -> rpc-bridge -> createTask)
 * passes the raw string straight through, so an agent inventing a plausible level
 * — `"medium"` is the documented one, from a four-level scale that has `normal`
 * where every other tracker has `medium` — used to surface as an opaque postgres
 * `Failed query: INSERT INTO app_projects.tasks ...` dump with the whole SQL and
 * every param in the message. Same lesson as `assertUuidParam`: reject at the
 * boundary with the real candidates so the agent can self-correct.
 *
 * Deliberately does NOT alias `medium` onto anything: in the field it stands in
 * for "P1"/"P2" just as often as for "middle of the scale", so guessing a level
 * would silently rewrite the caller's intent. Make them pick.
 */
export function assertTaskPriority(value: string | null | undefined, paramName = "priority"): void {
  if (value == null) return
  if ((TASK_PRIORITIES as readonly string[]).includes(value)) return
  throw new ProjectsServiceError(
    400,
    "invalid_priority",
    `${paramName} must be one of ${TASK_PRIORITIES.join(", ")} (got ${JSON.stringify(value)}) — this board has no "medium" level; "normal" is the mid one, "high" the one above it`,
    { candidates: [...TASK_PRIORITIES] },
  )
}

async function listStatusCandidates(
  tx: SqlClient,
  orgId: string,
  projectId: string,
): Promise<Array<{ id: string; label: string }>> {
  return extractRows<{ id: string; label: string }>(
    await tx.execute(drizzleSql`
      SELECT id, label FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
}

/**
 * Resolve a status reference to a status id within one project. Accepts an id
 * (`statusId`) or a case-insensitive label (`statusLabel`); a non-UUID value in
 * `statusId` is treated as a label — the documented field failure is an agent
 * passing the column label "TO DISCUSS" as statusId, which used to surface as a
 * raw uuid-cast SQL error. Misses throw a clean `status_not_found` carrying the
 * project's actual columns as candidates so the agent can self-correct (or
 * create the missing column via the status tools).
 */
export async function resolveStatusRef(
  tx: SqlClient,
  orgId: string,
  projectId: string,
  input: { statusId?: string | null; statusLabel?: string | null },
): Promise<string> {
  const byId = input.statusId?.trim()
  const label = (byId && !UUID_RE.test(byId) ? byId : input.statusLabel?.trim()) || null
  if (byId && UUID_RE.test(byId)) {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${projectsRel("project_statuses")}
        WHERE id = ${byId}::uuid
          AND project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
        LIMIT 1
      `),
    )
    if (rows.length === 0) {
      throw new ProjectsServiceError(404, "status_not_found", "status not in project", {
        candidates: await listStatusCandidates(tx, orgId, projectId),
      })
    }
    return rows[0]!.id
  }
  if (!label) {
    throw new ProjectsServiceError(400, "status_required", "statusId or statusLabel required")
  }
  const matches = extractRows<{ id: string; label: string }>(
    await tx.execute(drizzleSql`
      SELECT id, label FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid
        AND org_id = ${orgId}::uuid
        AND lower(label) = lower(${label})
      ORDER BY "order" ASC
    `),
  )
  if (matches.length === 1) return matches[0]!.id
  if (matches.length > 1) {
    throw new ProjectsServiceError(409, "status_ambiguous", "multiple statuses match that label", {
      candidates: matches,
    })
  }
  throw new ProjectsServiceError(
    404,
    "status_not_found",
    `no status labelled ${JSON.stringify(label)} in this project — use one of the existing columns or create it first via status_add`,
    { candidates: await listStatusCandidates(tx, orgId, projectId) },
  )
}

export async function resolveAssignee(
  tx: SqlClient,
  orgId: string,
  input: { assigneeId?: string | null; assigneeName?: string | null },
  options: { allowInactive?: boolean } = {},
): Promise<string | null> {
  if (input.assigneeId) {
    // `allowInactive` is the bulk importer's escape hatch (a historical
    // assignee who has left, or a deactivated placeholder); the org predicate
    // always stays, so an id from another org is still rejected.
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("users")}
        WHERE id = ${input.assigneeId}::uuid
          AND org_id = ${orgId}::uuid
          ${options.allowInactive ? drizzleSql`` : drizzleSql`AND status = 'active'`}
        LIMIT 1
      `),
    )
    if (rows.length === 0) {
      throw new ProjectsServiceError(404, "assignee_not_found", "assignee not found")
    }
    return rows[0]!.id
  }
  if (!input.assigneeName) return null
  const name = input.assigneeName.trim()
  if (!name) return null
  // Exact full-name match takes priority (unchanged). If there is none, fall back to a partial
  // WHOLE-WORD match so an agent that extracted a FIRST name from prose ("Marco", "Ines") resolves
  // to the user "Marco Fulfillment" / "Ines Generalist" (BL-183 — convert-thread files tasks whose
  // owners are named by first name in the planning thread). `string_to_array` gives whole-word
  // matching — no substring false-positives ("ar" inside "Marco") and no LIKE-metacharacter
  // escaping. A partial match must be UNIQUE; >1 (e.g. "Generalist" → Ines + Raphael) is ambiguous
  // and surfaces the candidates rather than silently guessing one. A name is only ever resolved
  // to an id here; nothing downstream compares names.
  const exact = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT id, name FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid
        AND status = 'active'
        AND lower(name) = lower(${name})
    `),
  )
  if (exact.length === 1) return exact[0]!.id
  if (exact.length > 1) {
    throw new ProjectsServiceError(409, "assignee_ambiguous", "multiple users match", {
      candidates: exact.map((m) => ({ id: m.id, name: m.name })),
    })
  }
  const partial = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT id, name FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid
        AND status = 'active'
        AND lower(${name}) = ANY(string_to_array(lower(name), ' '))
    `),
  )
  if (partial.length === 0) {
    // The reverse direction: the agent wrote the FULL name ("Jordan Bellamy") and the account
    // carries only part of it ("Jordan"). Every word of the stored name must appear in the given
    // name, so "Jordan" matches "Jordan Bellamy" but never "Jordana Bellamy". Without this a
    // gated projects:create assigning "Jordan Bellamy" threw at approval time, and the approver,
    // the very user named "Jordan", could not get the request through (prod, 2026-09-22) until he
    // renamed himself. Uniqueness rules are the same as above.
    const contained = extractRows<{ id: string; name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, name FROM ${kernelRel("users")}
        WHERE org_id = ${orgId}::uuid
          AND status = 'active'
          AND btrim(name) <> ''
          AND regexp_split_to_array(lower(btrim(name)), '[[:space:]]+')
              <@ regexp_split_to_array(lower(${name}), '[[:space:]]+')
      `),
    )
    if (contained.length === 1) return contained[0]!.id
    if (contained.length > 1) {
      throw new ProjectsServiceError(409, "assignee_ambiguous", "multiple users match that name", {
        candidates: contained.map((m) => ({ id: m.id, name: m.name })),
      })
    }
    throw new ProjectsServiceError(404, "assignee_not_found", "no user with that name")
  }
  if (partial.length > 1) {
    throw new ProjectsServiceError(409, "assignee_ambiguous", "multiple users match that name", {
      candidates: partial.map((m) => ({ id: m.id, name: m.name })),
    })
  }
  return partial[0]!.id
}

export async function resolveProjectId(
  tx: SqlClient,
  orgId: string,
  input: { projectId?: string | null; projectName?: string | null },
): Promise<string> {
  // A non-UUID projectId is a NAME the agent put in the id slot — resolve it
  // instead of letting the ::uuid cast leak a raw "Failed query" error.
  if (input.projectId && UUID_RE.test(input.projectId)) return input.projectId

  // ...OR a UUID PREFIX. Liaison's own surfaces render the short form (an
  // approval card for this very tool reads `In 0431f720`), so an agent copying
  // what it was shown hands back a truncated id. Treating that as a NAME fails
  // with "no project with that name" — which is what killed a gated
  // projects:create and left it parked at `approving` from 2026-07-22 until
  // 2026-08-04. If the system displays short ids it must accept them.
  // Requires a UNIQUE match, so an ambiguous prefix is reported, never guessed.
  if (input.projectId && !input.projectName && /^[0-9a-f]{6,}[0-9a-f-]*$/i.test(input.projectId)) {
    const byPrefix = extractRows<{ id: string; name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, name FROM ${projectsRel("projects")}
        WHERE org_id = ${orgId}::uuid
          AND archived_at IS NULL
          AND id::text LIKE lower(${input.projectId}) || '%'
      `),
    )
    if (byPrefix.length === 1) return byPrefix[0]!.id
    if (byPrefix.length > 1) {
      throw new ProjectsServiceError(
        409,
        "project_ambiguous",
        "multiple projects match that id prefix",
        {
          candidates: byPrefix.map((m) => ({ id: m.id, name: m.name })),
        },
      )
    }
    // No prefix hit — fall through and try it as a name (a project could
    // legitimately be named something hex-looking).
  }

  const projectName = input.projectName || input.projectId
  if (projectName) {
    const matches = extractRows<{ id: string; name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, name FROM ${projectsRel("projects")}
        WHERE org_id = ${orgId}::uuid
          AND archived_at IS NULL
          AND lower(name) = lower(${projectName})
      `),
    )
    if (matches.length === 0) {
      throw new ProjectsServiceError(400, "project_required", "no project with that name")
    }
    if (matches.length > 1) {
      throw new ProjectsServiceError(409, "project_ambiguous", "multiple projects match", {
        candidates: matches.map((m) => ({ id: m.id, name: m.name })),
      })
    }
    return matches[0]!.id
  }
  const active = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT id, name FROM ${projectsRel("projects")}
      WHERE org_id = ${orgId}::uuid AND archived_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 5
    `),
  )
  if (active.length === 0) {
    throw new ProjectsServiceError(400, "project_required", "no active projects")
  }
  if (active.length > 1) {
    throw new ProjectsServiceError(409, "project_ambiguous", "multiple active projects", {
      candidates: active.map((m) => ({ id: m.id, name: m.name })),
    })
  }
  return active[0]!.id
}

/**
 * The project a NEW task goes in (`create` with no parent): `resolveProjectId`,
 * whose refusal, when the call named no project at all and several are active,
 * says how to fix the call. A live agent asked to break a task into subtasks
 * sent neither a parent nor a project, got "multiple active projects" back four
 * times and gave up: the code alone did not tell it what to send.
 */
export async function resolveNewTaskProjectId(
  tx: SqlClient,
  orgId: string,
  input: { projectId?: string | null; projectName?: string | null },
  /** The conversation the call came from. When it is a task's discussion, the
   *  refusal names that task as the parent to pass (it never files the task
   *  under it: the call asked for no parent). */
  opts: { threadId?: string | null } = {},
): Promise<string> {
  try {
    return await resolveProjectId(tx, orgId, input)
  } catch (err) {
    if (
      !(err instanceof ProjectsServiceError) ||
      err.code !== "project_ambiguous" ||
      input.projectId ||
      input.projectName
    ) {
      throw err
    }
    const candidates =
      (err.details as { candidates?: Array<{ id: string; name: string }> } | undefined)
        ?.candidates ?? []
    const named = candidates.map((c) => `"${c.name}" (${c.id})`).join(", ")
    const discussed = opts.threadId
      ? await loadDiscussionTask(tx, orgId, { threadId: opts.threadId })
      : null
    const subtaskHint = discussed
      ? `A subtask of the task this conversation is about, ${discussed.key} "${discussed.title}": ` +
        `pass parentTaskId "${discussed.key}" (its id: ${discussed.id}). Another subtask: pass ` +
        "parentTaskId (the parent task's id or key; it goes in the parent's project)."
      : "A subtask: pass parentTaskId (the parent task's id or key; it goes in the parent's project)."
    throw new ProjectsServiceError(
      409,
      "project_ambiguous",
      `multiple active projects, and the call named none. ${subtaskHint} A new task: pass ` +
        `projectId, one of: ${named}.`,
      discussed
        ? { ...(err.details as object | undefined), discussionTask: discussed }
        : err.details,
    )
  }
}

/**
 * `not_found` when a project id names no project of this org (archived ones
 * count as existing). `resolveProjectId` takes a UUID as-is, so a caller that
 * resolves something INSIDE the project next (a status column) must check the
 * project first, or a bad project id reads as a bad column.
 */
export async function assertProjectExists(
  tx: SqlClient,
  orgId: string,
  projectId: string,
): Promise<void> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  if (rows.length === 0) throw new ProjectsServiceError(404, "not_found", "project not found")
}

/**
 * Resolve a task reference that may be a UUID OR a display key like "ERB-12"
 * (BL: Jira-style task keys). A UUID is returned as-is (no DB round trip); a
 * key is parsed and joined against `projects(org_id,key)` + `tasks(project_id,
 * number)`. Anything else — an unparsable string — throws `not_found` rather
 * than leaking a raw uuid-cast SQL error, mirroring `assertUuidParam`'s intent
 * but permissive of the key form.
 */
export async function resolveTaskRef(tx: SqlClient, orgId: string, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref
  const parsed = parseTaskKey(ref)
  if (!parsed) {
    throw new ProjectsServiceError(
      400,
      "invalid_id",
      `taskId must be a UUID or a task key like "ERB-12" (got ${JSON.stringify(ref)})`,
    )
  }
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT t.id
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      WHERE t.org_id = ${orgId}::uuid AND p.key = ${parsed.key} AND t.number = ${parsed.number}
      LIMIT 1
    `),
  )
  const row = rows[0]
  if (!row) {
    throw new ProjectsServiceError(404, "not_found", `no task with key ${JSON.stringify(ref)}`)
  }
  return row.id
}

export interface SearchInput {
  query?: string
  archived?: "include" | "only" | "exclude"
  limit?: number
  cursor?: string
}

export async function searchProjectsForTool(
  tx: SqlClient,
  orgId: string,
  input: SearchInput,
): Promise<{ items: unknown[]; nextCursor: string | null; totalCount: number }> {
  const { listProjects, searchTasksByTitle } = await import("./create-project")
  const projectsResult = await listProjects({
    tx: tx as never,
    orgId,
    archived: input.archived ?? "exclude",
    q: input.query,
    cursor: input.cursor,
    limit: input.limit,
    includeTotal: true,
  })
  // The tool description promises project AND task titles. Tag projects and append matching tasks
  // (by title) so an agent can find a task by name and act on it (BL-108). Cursor paginates projects.
  const projectItems = projectsResult.items.map((p) => ({ type: "project" as const, ...p }))
  const q = (input.query ?? "").trim()
  const taskItems = q
    ? await searchTasksByTitle(
        tx as never,
        orgId,
        q,
        input.limit ?? 25,
        input.archived ?? "exclude",
      )
    : []
  // `search` is a relevance FINDER (cursor-paginated by PROJECTS, with task-title
  // matches appended); totalCount is the count of matching PROJECTS — the
  // paginated axis — not the blended row count. For a task work-list sweep use
  // tasks_byProject / tasks_byAssignee, which count tasks.
  return {
    items: [...projectItems, ...taskItems],
    nextCursor: projectsResult.nextCursor,
    totalCount: projectsResult.total ?? projectItems.length,
  }
}
