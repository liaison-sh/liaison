// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0158 (Sessions wave 2): a session carries its autonomy (guided by default),
// how its work should end (`finish_with`, null = a pull request for a repo),
// the last valid Atelier state, and the once-per-end post-back claim. Runs
// against the migrated test database; the replay cases roll back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0161_node_sessions_autonomy.sql")

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

interface Row {
  id: string
  autonomy: string
  finish_with: string | null
  atelier: unknown
  posted_back_ended_at: Date | null
}

async function insertSession(
  tx: Tx | postgres.Sql,
  cols: { autonomy?: string; finishWith?: string | null },
): Promise<Row> {
  const autonomy = cols.autonomy
  const [row] = autonomy
    ? await tx<Row[]>`
        INSERT INTO kernel.node_sessions
          (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model,
           level, status, autonomy, finish_with)
        VALUES (${orgId}, ${owner.userId}, ${nodeId}, ${agentId}, 'app', 'owner', 'T', 'T',
                'claude-haiku-5-5', 'strict', 'running', ${autonomy}, ${cols.finishWith ?? null})
        RETURNING id, autonomy, finish_with, atelier, posted_back_ended_at`
    : await tx<Row[]>`
        INSERT INTO kernel.node_sessions
          (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model,
           level, status, finish_with)
        VALUES (${orgId}, ${owner.userId}, ${nodeId}, ${agentId}, 'app', 'owner', 'T', 'T',
                'claude-haiku-5-5', 'strict', 'running', ${cols.finishWith ?? null})
        RETURNING id, autonomy, finish_with, atelier, posted_back_ended_at`
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
    VALUES (${orgId}, 'personal', ${`@m158-${crypto.randomUUID().slice(0, 8)}`}, 'm158',
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

describe("0158 node sessions autonomy", () => {
  it("S30: autonomy defaults guided, 'autonomous' accepted, 'auto' refused", async () => {
    await inRollback(async (tx) => {
      expect((await insertSession(tx, {})).autonomy).toBe("guided")
      expect((await insertSession(tx, { autonomy: "autonomous" })).autonomy).toBe("autonomous")
      const row = await insertSession(tx, {})
      const message = await tx`UPDATE kernel.node_sessions SET autonomy = NULL WHERE id = ${row.id}`
        .then(() => "")
        .catch((err: Error) => err.message)
      expect(message).toContain("autonomy")
    })
    const message = await refuses((tx) => insertSession(tx, { autonomy: "auto" }))
    expect(message).toContain("node_sessions_autonomy_check")
  })

  it("S57: finish_with null by default, 'pr' accepted, 'push' refused", async () => {
    await inRollback(async (tx) => {
      expect((await insertSession(tx, {})).finish_with).toBeNull()
      for (const finishWith of ["pr", "commit", "none"]) {
        expect((await insertSession(tx, { finishWith })).finish_with).toBe(finishWith)
      }
    })
    const message = await refuses((tx) => insertSession(tx, { finishWith: "push" }))
    expect(message).toContain("node_sessions_finish_with_check")
  })

  it("S35: atelier is a nullable jsonb holding the last state; A38: posted_back_ended_at starts null", async () => {
    await inRollback(async (tx) => {
      const row = await insertSession(tx, {})
      expect(row.atelier).toBeNull()
      expect(row.posted_back_ended_at).toBeNull()
      const state = { id: "x", rung: "R2", phase: "execute", status: "running", awaiting: null }
      const [updated] = await tx<{ atelier: unknown }[]>`
        UPDATE kernel.node_sessions SET atelier = ${tx.json(state)} WHERE id = ${row.id}
        RETURNING atelier`
      expect(updated!.atelier).toEqual(state)
    })
  })

  it("A38: the post-back claim succeeds once per ended_at", async () => {
    await inRollback(async (tx) => {
      const row = await insertSession(tx, {})
      const claim = () => tx<{ id: string }[]>`
        UPDATE kernel.node_sessions SET posted_back_ended_at = ended_at
         WHERE id = ${row.id} AND ended_at IS NOT NULL
           AND posted_back_ended_at IS DISTINCT FROM ended_at
        RETURNING id`
      expect((await claim()).length).toBe(0)
      await tx`UPDATE kernel.node_sessions SET ended_at = now() WHERE id = ${row.id}`
      expect((await claim()).length).toBe(1)
      expect((await claim()).length).toBe(0)
    })
  })

  it("the migration runs twice without error and leaves one of each", async () => {
    await inRollback(async (tx) => {
      for (const s of statements()) await tx.unsafe(s)
      for (const s of statements()) await tx.unsafe(s)
      const [shape] = await tx<{ cols: number; checks: number }[]>`
        SELECT
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'kernel' AND table_name = 'node_sessions'
              AND column_name IN ('autonomy', 'finish_with', 'atelier', 'posted_back_ended_at')) AS cols,
          (SELECT count(*)::int FROM pg_constraint
            WHERE conrelid = 'kernel.node_sessions'::regclass
              AND conname IN ('node_sessions_autonomy_check', 'node_sessions_finish_with_check')) AS checks`
      expect(shape).toEqual({ cols: 4, checks: 2 })
      const row = await insertSession(tx, { autonomy: "autonomous", finishWith: "commit" })
      expect([row.autonomy, row.finish_with]).toEqual(["autonomous", "commit"])
    })
  })
})
