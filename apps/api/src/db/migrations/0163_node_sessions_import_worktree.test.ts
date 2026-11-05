// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0160 (Sessions D53): an imported session may name the shared repository's
// own worktree outside the shared folder it ran in. Runs against the migrated
// test database; every case rolls back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0163_node_sessions_import_worktree.sql")

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
  tx: Tx,
  cols: { source: "import" | "dispatch"; worktreePath: string | null },
): Promise<{ worktree_path: string | null }> {
  const isImport = cols.source === "import"
  const [row] = await tx<{ worktree_path: string | null }[]>`
    INSERT INTO kernel.node_sessions
      (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model,
       level, status, finish_with, import_mode, import_sdk_session_id, import_from, cwd_subdir,
       worktree_path)
    VALUES (${orgId}, ${owner.userId}, ${nodeId}, ${agentId}, ${cols.source}, 'owner', 'T', 'T',
            'claude-haiku-5-5', 'strict', 'needs_you', 'none',
            ${isImport ? "follow" : null}, ${isImport ? crypto.randomUUID() : null},
            ${isImport ? "vscode" : null}, ${isImport ? "pkg" : null}, ${cols.worktreePath})
    RETURNING worktree_path`
  return row!
}

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
    VALUES (${orgId}, 'personal', ${`@m160-${crypto.randomUUID().slice(0, 8)}`}, 'm160',
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
    await priv`DELETE FROM kernel.nodes WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.agents WHERE org_id = ${orgId} AND id = ${agentId}`
  }
  await priv.end()
  await releaseTestLock()
})

describe("0160 node sessions import worktree", () => {
  it("D53: an import may name a worktree, or none", async () => {
    await inRollback(async (tx) => {
      const row = await insertSession(tx, { source: "import", worktreePath: "/tmp/repo-wt" })
      expect(row.worktree_path).toBe("/tmp/repo-wt")
      const none = await insertSession(tx, { source: "import", worktreePath: null })
      expect(none.worktree_path).toBeNull()
    })
  })

  it("D53: a session that is not an import, an empty path and one over 4096 characters are refused", async () => {
    for (const cols of [
      { source: "dispatch" as const, worktreePath: "/tmp/repo-wt" },
      { source: "import" as const, worktreePath: "" },
      { source: "import" as const, worktreePath: `/${"a".repeat(4096)}` },
    ]) {
      expect(await refuses((tx) => insertSession(tx, cols))).toContain(
        "node_sessions_worktree_path_check",
      )
    }
  })

  it("re-running the migration is a no-op", async () => {
    await inRollback(async (tx) => {
      for (const s of statements()) await tx.unsafe(s)
      for (const s of statements()) await tx.unsafe(s)
      const [shape] = await tx<{ cols: number; checks: number }[]>`
        SELECT
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'kernel' AND table_name = 'node_sessions'
              AND column_name = 'worktree_path') AS cols,
          (SELECT count(*)::int FROM pg_constraint
            WHERE conrelid = 'kernel.node_sessions'::regclass
              AND conname = 'node_sessions_worktree_path_check') AS checks`
      expect(shape).toEqual({ cols: 1, checks: 1 })
    })
  })
})
