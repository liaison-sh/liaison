// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared E2E fixtures for the Agent App (Skills + Routines) scenarios.
 *
 * Why this file: every Agent-app scenario needs at least 2 of the helpers
 * below. Extracting them keeps the scenario files focused on UI flow. Layers:
 *
 *   - agent-bootstrap.ts  → login + sidebar nav (existing)
 *   - helpers/run-cron.ts → low-level BullMQ enqueue (existing)
 *   - this file           → feature-level fixtures bridging the two
 *
 * Rows a test needs come from the seed route (./agent-seed.ts); what stays
 * here writes directly: the per-test truncates.
 */
import type { WorkerEnv } from "@liaison/test-helpers"
import { api, restoreStandardAgentApp } from "@liaison/test-helpers"
import { resolveJobQueue } from "../../../../../api/src/infra/jobs/queue-classes"
import { QA_ROLE_AGENT } from "../../../../../api/src/seed/world/qa"
import { PW_ADMIN } from "../pw-lanes"
import { latestRoutineRun } from "./db-reads"
import { triggerCronJob } from "./run-cron"

// ─── Per-test isolation ─────────────────────────────────────────────────────

/**
 * Truncate the four agent-app tables + approval_requests so per-test seed
 * doesn't leak from one scenario into the next within a single worker.
 *
 * Threads / messages are NOT truncated — each test opens its own chat thread,
 * so prior-test threads do not interfere with active-thread assertions.
 */
export async function clearAgentAppTables(env: WorkerEnv): Promise<void> {
  const ks = `${env.schemaPrefix}kernel`
  await retryOnDeadlock(() =>
    env.db.sql.unsafe(
      `TRUNCATE
       "${ks}".skills,
       "${ks}".disabled_app_skills,
       "${ks}".routines,
       "${ks}".routine_runs,
       "${ks}".approval_requests
     CASCADE`,
    ),
  )
}

/**
 * Run a statement that Postgres may pick as the victim of a deadlock (SQLSTATE
 * 40P01) and run it again.
 *
 * `TRUNCATE ... CASCADE` takes ACCESS EXCLUSIVE locks on these tables and on
 * every table with a foreign key to them, one after the other, while the
 * worker's own server keeps writing to them (routine scheduler, approvals,
 * attention materializer) in an order of its own. Two transactions that take
 * the same locks in opposite orders deadlock, and Postgres aborts one. When it
 * aborts this statement, nothing was applied, so running it again is exact.
 * Anything else, and a deadlock that persists, still throws.
 */
async function retryOnDeadlock<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code !== "40P01" || attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
}

/** Truncate sub-run state in the worker's schema between tests.
 *  CASCADE clears hidden threads (FK from agent_runs.thread_id) and the
 *  agent_runs themselves; `sub_agent_definitions` is independent and cleared
 *  alongside so definition leaks don't trip later scenarios. */
export async function clearSubAgentTables(env: WorkerEnv): Promise<void> {
  const ks = `${env.schemaPrefix}kernel`
  await env.db.sql.unsafe(
    `TRUNCATE TABLE "${ks}".agent_runs, "${ks}".sub_agent_definitions RESTART IDENTITY CASCADE`,
  )
  // Hidden subrun threads have no FK-cascade path from agent_runs (the FK is
  // agent_runs.thread_id → threads.id, not the reverse) so clean them explicitly.
  await env.db.sql.unsafe(`DELETE FROM "${ks}".threads WHERE type = 'subrun'`)
}

/**
 * Restore the agent-app seed baseline (skills, routines, agent chats, past
 * runs) after `clearAgentAppTables`.
 *
 * A lane resets to the seeded world before every spec file, but a file that
 * clears these tables leaves them empty for its own later tests, and a
 * per-worker stack (`LIAISON_PW_SHARED_STACK=0`) keeps them empty for later
 * files too. The leading clear drops any test-made rows; the standard tier's
 * agent-app part (`liaison seed --tier standard --only agent-app`) then
 * writes the baseline again, exactly as the lane seeded it.
 */
export async function restoreAgentAppBaseline(env: WorkerEnv): Promise<void> {
  // Clear + seed as one unit: the leading clear makes a rerun after a deadlock
  // in the seed start from the same empty tables.
  await retryOnDeadlock(async () => {
    await clearAgentAppTables(env)
    await restoreStandardAgentApp(env, PW_ADMIN.email)
  })
}

// ─── API lookups ─────────────────────────────────────────────────────────────

export interface RoutineByName {
  id: string
  outputThreadId: string | null
  status: string
  lastRunStatus: string | null
}

export async function getRoutineByName(
  env: WorkerEnv,
  token: string,
  name: string,
): Promise<RoutineByName | null> {
  const res = await api(env.serverUrl, "/api/agent/routines", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) return null
  const data = (res.body?.data ?? []) as Array<{
    id: string
    name: string
    outputThreadId?: string | null
    status?: string
    lastRunStatus?: string | null
  }>
  const row = data.find((r) => r.name === name)
  if (!row) return null
  return {
    id: row.id,
    outputThreadId: row.outputThreadId ?? null,
    status: row.status ?? "",
    lastRunStatus: row.lastRunStatus ?? null,
  }
}

export interface SkillByName {
  id: string
  name: string
  forkedFrom: string | null
  createdByActorType: string
  domain: string | null
}

export async function getSkillByName(
  env: WorkerEnv,
  token: string,
  name: string,
): Promise<SkillByName | null> {
  const res = await api(env.serverUrl, "/api/agent/skills", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) return null
  const data = (res.body?.data ?? []) as Array<{
    id: string
    name: string
    forkedFrom?: string | null
    createdByActorType?: string
    domain?: string | null
  }>
  const row = data.find((r) => r.name === name)
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    forkedFrom: row.forkedFrom ?? null,
    createdByActorType: row.createdByActorType ?? "user",
    domain: row.domain ?? null,
  }
}

// ─── BullMQ ──────────────────────────────────────────────────────────────────

/**
 * Enqueue a routine-tick job onto its real kernel class queue
 * (apps/api/src/infra/jobs/queue-classes.ts) with the same payload shape the
 * production scheduler emits (orgId, routineId,
 * scheduledAt, requestUuid). The worker uses requestUuid as the lock key,
 * so each call generates a fresh uuid to avoid lock collisions.
 */
export async function forceRoutineTick(
  env: WorkerEnv,
  orgId: string,
  routineId: string,
): Promise<void> {
  await triggerCronJob(env, resolveJobQueue("kernel", "routine-tick").queueName, "routine-tick", {
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    requestUuid: crypto.randomUUID(),
  })
}

/** The standard world's role agent, which owns its shared `triage-bug-report`
 *  skill. A shared skill belongs to a ROLE agent (`skills_select`, 0047: a row
 *  owned by a role agent is readable org-wide and A15 lets only a
 *  `kernel:agents:admin` write it), so every scenario that asks a question
 *  about an org skill asks it on that agent's page. */
export const ROLE_AGENT_HANDLE = QA_ROLE_AGENT.handle

// ─── Scheduled-agent-action scenario helpers ─────────────────────────────────

/**
 * Create a multi-participant thread (used by the scheduled-agent-action
 * scenario). Returns the thread id. `ownerToken` creates the thread; the rest
 * of `participantIds` are added as participants so the agent's `threads_reply`
 * fans an attention row to each.
 */
export async function seedSharedThread(
  env: WorkerEnv,
  ownerToken: string,
  participantIds: string[],
  title = "Shared digest thread",
): Promise<string> {
  const res = await api(env.serverUrl, "/api/threads", {
    method: "POST",
    token: ownerToken,
    body: {
      forceCreate: true,
      participantIds,
      title,
      initialMessage: { content: "Kicking off the shared digest thread." },
    },
  })
  if (res.status !== 200) {
    throw new Error(`seedSharedThread failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return (res.body as { data: { id: string } }).data.id
}

/**
 * Poll `routine_runs` until the latest run for `routineId` reaches a terminal
 * status, then assert it succeeded (`succeeded` or `output_thread_recreated` —
 * both are success variants). Throws with the observed status on failure.
 */
export async function expectRoutineRunSucceeds(
  env: WorkerEnv,
  routineId: string,
  opts: { timeout?: number } = {},
): Promise<void> {
  const row = await pollUntil(
    async () => {
      const r = await latestRoutineRun(env, routineId)
      if (!r) return null
      // Skipped statuses are not terminal-success — keep polling for a real run.
      if (r.status.startsWith("skipped_")) return null
      return r
    },
    { timeout: opts.timeout ?? 120_000, interval: 1500, label: "routine-run-terminal" },
  )
  if (row.status !== "succeeded" && row.status !== "output_thread_recreated") {
    throw new Error(
      `routine run did not succeed: status=${row.status} error=${row.error ?? "<none>"}`,
    )
  }
}

// ─── Generic polling ─────────────────────────────────────────────────────────

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 10_000
  const interval = opts.interval ?? 200
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v !== null && v !== undefined) return v
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(
    `pollUntil${opts.label ? ` (${opts.label})` : ""} timed out after ${timeout}ms${
      lastErr ? `: ${String(lastErr)}` : ""
    }`,
  )
}
