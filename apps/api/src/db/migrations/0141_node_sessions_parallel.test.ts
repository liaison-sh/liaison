// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0141 (node sessions, P3): a node may hold several running jobs (L2, the
// one-running index goes), each node carries its live caps (D35: 4 live, 2
// background), a job may be a resume run (resume_after, resume_command_id),
// and unacked commands have a lookup index. Runs against the migrated
// database (`bun run db:migrate` first); the "twice" case replays the file in
// a transaction that rolls back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0141_node_sessions_parallel.sql")

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const priv = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
type Tx = postgres.TransactionSql

function statements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
}

const run = async <T>(query: PromiseLike<T>): Promise<T> => await query
class Rollback extends Error {}

let orgId: string
let owner: minimal.Session
let agentId: string

async function newNode(): Promise<string> {
  const [row] = await priv<{ id: string }[]>`
    INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
    VALUES (${orgId}, ${owner.userId}, ${`d.${crypto.randomUUID()}`}, 'Mac')
    RETURNING id`
  return row!.id
}

async function runningJob(nodeId: string, resumeAfter: string | null = null): Promise<string> {
  const [row] = await priv<{ id: string }[]>`
    INSERT INTO kernel.node_jobs
      (org_id, owner_user_id, agent_id, source, prompt, status, node_id, lease_holder,
       lease_generation, resume_after)
    VALUES (${orgId}, ${owner.userId}, ${agentId}, 'app', 'p', 'running', ${nodeId}, ${nodeId}, 1,
            ${resumeAfter})
    RETURNING id`
  return row!.id
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.session(orgId)
  const [agent] = await priv<{ id: string }[]>`
    INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
    VALUES (${orgId}, 'personal', ${`@p3-${crypto.randomUUID().slice(0, 8)}`}, 'p3',
            '["kernel:threads:read"]'::jsonb, ${owner.userId})
    RETURNING id`
  agentId = agent!.id
})

afterAll(async () => {
  if (orgId) {
    await priv`DELETE FROM kernel.node_jobs WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.nodes WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.agents WHERE id = ${agentId}`
  }
  await priv.end()
  await releaseTestLock()
})

describe("0141 node sessions parallel", () => {
  it("two running jobs leased by one node are both stored", async () => {
    const nodeId = await newNode()
    const a = await runningJob(nodeId)
    const b = await runningJob(nodeId)
    const rows = await priv`SELECT id FROM kernel.node_jobs
                            WHERE lease_holder = ${nodeId} AND status = 'running'`
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort())
  })

  it("nodes default to 4 live and 2 background, and 0 live is refused", async () => {
    const nodeId = await newNode()
    const [row] = await priv<{ max_live_sessions: number; max_live_background: number }[]>`
      SELECT max_live_sessions, max_live_background FROM kernel.nodes WHERE id = ${nodeId}`
    expect(row).toEqual({ max_live_sessions: 4, max_live_background: 2 })
    await expect(
      run(priv`UPDATE kernel.nodes SET max_live_sessions = 0 WHERE id = ${nodeId}`),
    ).rejects.toMatchObject({ code: "23514" })
    await expect(
      run(priv`UPDATE kernel.nodes SET max_live_sessions = 17 WHERE id = ${nodeId}`),
    ).rejects.toMatchObject({ code: "23514" })
    await expect(
      run(
        priv`UPDATE kernel.nodes SET max_live_sessions = 2, max_live_background = 3 WHERE id = ${nodeId}`,
      ),
    ).rejects.toMatchObject({ code: "23514" })
    await priv`UPDATE kernel.nodes SET max_live_sessions = 2, max_live_background = 0 WHERE id = ${nodeId}`
  })

  it("a resume_after outside the four is refused", async () => {
    const nodeId = await newNode()
    for (const after of ["offline", "message", "crash", "level"]) {
      expect(await runningJob(nodeId, after)).toBeString()
    }
    await expect(run(runningJob(nodeId, "reboot"))).rejects.toMatchObject({ code: "23514" })
  })

  it("running it twice changes nothing", async () => {
    const shape = (tx: Tx) =>
      tx.unsafe(`
      SELECT 'col' AS k, table_name || '.' || column_name || ':' || data_type || ':' ||
             is_nullable || ':' || coalesce(column_default, '') AS v
        FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name IN ('nodes', 'node_jobs', 'node_session_commands')
      UNION ALL
      SELECT 'con', conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid)
        FROM pg_constraint
       WHERE conrelid IN ('kernel.nodes'::regclass, 'kernel.node_jobs'::regclass)
      UNION ALL
      SELECT 'idx', indexrelid::regclass::text FROM pg_index
       WHERE indrelid IN ('kernel.node_jobs'::regclass, 'kernel.node_session_commands'::regclass)
      ORDER BY 1, 2`)
    try {
      await priv.begin(async (tx) => {
        const before = await shape(tx)
        for (const s of statements()) await tx.unsafe(s)
        expect(await shape(tx)).toEqual(before)
        for (const s of statements()) await tx.unsafe(s)
        expect(await shape(tx)).toEqual(before)
        throw new Rollback()
      })
    } catch (err) {
      if (!(err instanceof Rollback)) throw err
    }
  })
})
