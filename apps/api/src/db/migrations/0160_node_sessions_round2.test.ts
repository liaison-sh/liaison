// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0157 (Sessions round 2): a session may end `needs_you`, carries an optional
// reasoning effort and a per-session mute, and the job remembers the protocol
// of the node that claimed it. Runs against the migrated test database
// (`bun run db:migrate` first); the replay cases roll back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0160_node_sessions_round2.sql")

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const priv = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
type Tx = postgres.TransactionSql

class Rollback extends Error {}

function statements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
}

let orgId: string
let owner: minimal.Session
let agentId: string
let nodeId: string

async function insertSession(
  tx: Tx | postgres.Sql,
  cols: { status?: string; effort?: string | null },
): Promise<{ id: string; muted: boolean; effort: string | null }> {
  const [row] = await tx<{ id: string; muted: boolean; effort: string | null }[]>`
    INSERT INTO kernel.node_sessions
      (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model,
       level, status, effort)
    VALUES (${orgId}, ${owner.userId}, ${nodeId}, ${agentId}, 'app', 'owner', 'T', 'T',
            'claude-sonnet-4-5', 'strict', ${cols.status ?? "running"}, ${cols.effort ?? null})
    RETURNING id, muted, effort`
  return row!
}

/** Runs `fn` in a transaction that is always rolled back. */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await priv.begin(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
  } catch (err) {
    if (!(err instanceof Rollback)) throw err
  }
}

async function refuses(fn: (tx: Tx) => Promise<unknown>): Promise<string> {
  let message = ""
  await inRollback(async (tx) => {
    await tx`SAVEPOINT s`
    try {
      await fn(tx)
    } catch (err) {
      message = String((err as Error).message)
    }
  })
  return message
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.session(orgId)
  const [agent] = await priv<{ id: string }[]>`
    INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
    VALUES (${orgId}, 'personal', ${`@m144-${crypto.randomUUID().slice(0, 8)}`}, 'm144',
            '["kernel:threads:read"]'::jsonb, ${owner.userId})
    RETURNING id`
  agentId = agent!.id
  const [node] = await priv<{ id: string }[]>`
    INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
    VALUES (${orgId}, ${owner.userId}, ${`d.${crypto.randomUUID()}`}, 'Mac')
    RETURNING id`
  nodeId = node!.id
})

afterAll(async () => {
  if (orgId) {
    await priv`DELETE FROM kernel.node_sessions WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.node_jobs WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.nodes WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.agents WHERE org_id = ${orgId} AND id = ${agentId}`
  }
  await priv.end()
  await releaseTestLock()
})

describe("0157 node sessions round 2", () => {
  it("S1: status needs_you is accepted, 'bogus' refused", async () => {
    await inRollback(async (tx) => {
      const row = await insertSession(tx, { status: "needs_you" })
      expect(row.id).toBeTruthy()
    })
    const message = await refuses((tx) => insertSession(tx, { status: "bogus" }))
    expect(message).toContain("node_sessions_status_check")
  })

  it("S1: every earlier status is still accepted", async () => {
    for (const status of ["queued", "running", "waiting", "paused", "done", "stopped", "failed"]) {
      await inRollback(async (tx) => {
        expect((await insertSession(tx, { status })).id).toBeTruthy()
      })
    }
  })

  it("S23: effort 'xhigh' accepted, 'ultra' refused, null accepted", async () => {
    await inRollback(async (tx) => {
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        expect((await insertSession(tx, { effort })).effort).toBe(effort)
      }
      expect((await insertSession(tx, { effort: null })).effort).toBeNull()
    })
    const message = await refuses((tx) => insertSession(tx, { effort: "ultra" }))
    expect(message).toContain("node_sessions_effort_check")
  })

  it("S14: muted defaults false and is not nullable", async () => {
    await inRollback(async (tx) => {
      const row = await insertSession(tx, {})
      expect(row.muted).toBe(false)
      const message = await tx`UPDATE kernel.node_sessions SET muted = NULL WHERE id = ${row.id}`
        .then(() => "")
        .catch((err: Error) => err.message)
      expect(message).toContain("muted")
    })
  })

  it("S6: node_jobs.node_protocol is a nullable integer", async () => {
    const [col] = await priv<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name = 'node_jobs' AND column_name = 'node_protocol'`
    expect(col).toEqual({ data_type: "integer", is_nullable: "YES" })
  })

  it("D23: the cache counters are bigint, not null, default 0", async () => {
    const cols = await priv<
      { column_name: string; data_type: string; is_nullable: string; column_default: string }[]
    >`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name = 'node_sessions'
         AND column_name IN ('tokens_cache_read', 'tokens_cache_write_5m', 'tokens_cache_write_1h')
       ORDER BY column_name`
    expect([...cols]).toEqual(
      ["tokens_cache_read", "tokens_cache_write_1h", "tokens_cache_write_5m"].map(
        (column_name) => ({
          column_name,
          data_type: "bigint",
          is_nullable: "NO",
          column_default: "0",
        }),
      ),
    )
  })

  it("the migration runs twice without error and leaves one of each", async () => {
    await inRollback(async (tx) => {
      for (const s of statements()) await tx.unsafe(s)
      for (const s of statements()) await tx.unsafe(s)
      const [shape] = await tx<{ cols: number; checks: number }[]>`
        SELECT
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'kernel'
              AND ((table_name = 'node_sessions' AND column_name IN ('effort', 'muted', 'tokens_cache_read',
                     'tokens_cache_write_5m', 'tokens_cache_write_1h'))
                OR (table_name = 'node_jobs' AND column_name = 'node_protocol'))) AS cols,
          (SELECT count(*)::int FROM pg_constraint
            WHERE conrelid = 'kernel.node_sessions'::regclass
              AND conname IN ('node_sessions_status_check', 'node_sessions_effort_check')) AS checks`
      expect(shape).toEqual({ cols: 6, checks: 2 })
      expect((await insertSession(tx, { status: "needs_you", effort: "max" })).id).toBeTruthy()
    })
  })
})
