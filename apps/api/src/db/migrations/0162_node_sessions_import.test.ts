// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0159 (Sessions wave 3, A51): a session can be an import of a Claude Code
// session the owner started elsewhere (`source = 'import'`, its mode, the
// imported CLI id, which Claude Code started it, the recorded cwd under the
// shared folder, whether a follow holds it, the Take over replay offset), and
// a node job can be a `follow`. Runs against the migrated test database; every
// case rolls back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0162_node_sessions_import.sql")

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
let other: minimal.Session
let agentId: string
let otherAgentId: string
let nodeId: string

interface ImportCols {
  source?: string
  ownerUserId?: string
  agentId?: string
  importMode?: string | null
  importSdkSessionId?: string | null
  importFrom?: string | null
  cwdSubdir?: string | null
  importReplayOffset?: number | null
}

interface Row {
  id: string
  source: string
  import_mode: string | null
  import_sdk_session_id: string | null
  import_from: string | null
  cwd_subdir: string | null
  following: boolean
  import_replay_offset: string | null
}

/** A complete import row's columns; tests override one at a time. */
function importCols(over: ImportCols = {}): ImportCols {
  return {
    source: "import",
    importMode: "follow",
    importSdkSessionId: crypto.randomUUID(),
    importFrom: "vscode",
    cwdSubdir: "",
    importReplayOffset: null,
    ...over,
  }
}

async function insertSession(tx: Tx, cols: ImportCols): Promise<Row> {
  const [row] = await tx<Row[]>`
    INSERT INTO kernel.node_sessions
      (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model,
       level, status, finish_with, import_mode, import_sdk_session_id, import_from, cwd_subdir,
       import_replay_offset)
    VALUES (${orgId}, ${cols.ownerUserId ?? owner.userId}, ${nodeId}, ${cols.agentId ?? agentId},
            ${cols.source ?? "dispatch"}, 'owner', 'T', 'T', 'claude-haiku-5-5', 'strict',
            'needs_you', 'none', ${cols.importMode ?? null}, ${cols.importSdkSessionId ?? null},
            ${cols.importFrom ?? null}, ${cols.cwdSubdir ?? null}, ${cols.importReplayOffset ?? null})
    RETURNING id, source, import_mode, import_sdk_session_id, import_from, cwd_subdir, following,
              import_replay_offset`
  return row!
}

async function insertJob(
  tx: Tx,
  cols: { kind: string; source: string; permissionMode?: string | null },
): Promise<{ id: string; kind: string; source: string }> {
  const [row] = await tx<{ id: string; kind: string; source: string }[]>`
    INSERT INTO kernel.node_jobs
      (org_id, owner_user_id, agent_id, target_node_id, source, prompt, kind, permission_mode)
    VALUES (${orgId}, ${owner.userId}, ${agentId}, ${nodeId}, ${cols.source}, '', ${cols.kind},
            ${cols.permissionMode ?? null})
    RETURNING id, kind, source`
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

/** The error message `fn` raises inside a rolled-back transaction ("" when it succeeds). */
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

// The first draft's shape check (review M9): an equality between "is an
// import" and "has every import column". It holds for a non-import row that
// carries only some import columns, so it accepted the rows below. Kept as the
// red reference; never in the migration.
const DRAFT_EQUALITY_CHECK = `ALTER TABLE kernel.node_sessions ADD CONSTRAINT node_sessions_import_shape
  CHECK ((source = 'import') = (import_mode IS NOT NULL AND import_sdk_session_id IS NOT NULL
         AND import_from IS NOT NULL AND cwd_subdir IS NOT NULL))`

const LONE_COLUMNS: [string, ImportCols][] = [
  ["import_mode", { importMode: "follow" }],
  ["import_sdk_session_id", { importSdkSessionId: "00000000-0000-4000-8000-000000000001" }],
  ["import_from", { importFrom: "cli" }],
  ["cwd_subdir", { cwdSubdir: "apps/api" }],
  ["import_replay_offset", { importReplayOffset: 10 }],
]

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.session(orgId)
  other = await minimal.session(orgId)
  const agent = async (userId: string) => {
    const [row] = await priv<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${orgId}, 'personal', ${`@m159-${crypto.randomUUID().slice(0, 8)}`}, 'm159',
              '["kernel:threads:read"]'::jsonb, ${userId})
      RETURNING id`
    return row!.id
  }
  agentId = await agent(owner.userId)
  otherAgentId = await agent(other.userId)
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
    await priv`DELETE FROM kernel.agents WHERE org_id = ${orgId} AND id IN (${agentId}, ${otherAgentId})`
  }
  await priv.end()
  await releaseTestLock()
})

describe("0159 node sessions import", () => {
  it("S40: an import row with every import column is accepted; following starts false", async () => {
    await inRollback(async (tx) => {
      const id = crypto.randomUUID()
      const row = await insertSession(
        tx,
        importCols({
          importMode: "take_over",
          importSdkSessionId: id,
          importFrom: "cli",
          cwdSubdir: "apps/web",
        }),
      )
      expect([
        row.source,
        row.import_mode,
        row.import_sdk_session_id,
        row.import_from,
        row.cwd_subdir,
      ]).toEqual(["import", "take_over", id, "cli", "apps/web"])
      expect(row.following).toBe(false)
      expect(row.import_replay_offset).toBeNull()
      const [updated] = await tx<{ following: boolean; import_replay_offset: string }[]>`
        UPDATE kernel.node_sessions SET following = true, import_replay_offset = 8388608
         WHERE id = ${row.id} RETURNING following, import_replay_offset`
      expect([updated!.following, Number(updated!.import_replay_offset)]).toEqual([true, 8388608])
    })
  })

  it("S40: source import needs import_mode, import_sdk_session_id, import_from and cwd_subdir (each missing one refused)", async () => {
    for (const missing of [
      { importMode: null },
      { importSdkSessionId: null },
      { importFrom: null },
      { cwdSubdir: null },
    ] satisfies ImportCols[]) {
      const message = await refuses((tx) => insertSession(tx, importCols(missing)))
      expect(message).toContain("node_sessions_import_shape")
    }
  })

  it("S40: a dispatch row with import_mode alone, import_sdk_session_id alone, import_from alone, cwd_subdir alone, or import_replay_offset alone is refused", async () => {
    for (const [, lone] of LONE_COLUMNS) {
      const message = await refuses((tx) => insertSession(tx, { source: "dispatch", ...lone }))
      expect(message).toContain("node_sessions_import_shape")
    }
    // Red reference: under the first draft's equality check every one of these
    // dispatch rows was accepted.
    for (const [column, lone] of LONE_COLUMNS) {
      await inRollback(async (tx) => {
        await tx.unsafe(
          "ALTER TABLE kernel.node_sessions DROP CONSTRAINT node_sessions_import_shape",
        )
        await tx.unsafe(DRAFT_EQUALITY_CHECK)
        const row = await insertSession(tx, { source: "dispatch", ...lone })
        expect([column, row.source]).toEqual([column, "dispatch"])
      })
    }
  })

  it("A51: each import column keeps its vocabulary and bounds", async () => {
    const cases: [ImportCols, string][] = [
      [importCols({ importMode: "watch" }), "node_sessions_import_mode_check"],
      [
        importCols({ importSdkSessionId: "../../etc/passwd" }),
        "node_sessions_import_sdk_session_id_check",
      ],
      [importCols({ importFrom: "jetbrains" }), "node_sessions_import_from_check"],
      [importCols({ cwdSubdir: "a".repeat(1025) }), "node_sessions_cwd_subdir_len"],
      [importCols({ importReplayOffset: -1 }), "node_sessions_import_replay_offset_check"],
    ]
    for (const [cols, constraint] of cases) {
      expect(await refuses((tx) => insertSession(tx, cols))).toContain(constraint)
    }
    await inRollback(async (tx) => {
      const row = await insertSession(
        tx,
        importCols({ cwdSubdir: "a".repeat(1024), importReplayOffset: 0 }),
      )
      expect([row.cwd_subdir?.length, Number(row.import_replay_offset)]).toEqual([1024, 0])
    })
  })

  it("S42: the same import_sdk_session_id twice for one owner is refused; for another owner it is accepted", async () => {
    const id = crypto.randomUUID()
    const message = await refuses(async (tx) => {
      await insertSession(tx, importCols({ importSdkSessionId: id }))
      await insertSession(tx, importCols({ importSdkSessionId: id, importMode: "take_over" }))
    })
    expect(message).toContain("node_sessions_import_once")
    await inRollback(async (tx) => {
      const mine = await insertSession(tx, importCols({ importSdkSessionId: id }))
      const theirs = await insertSession(
        tx,
        importCols({ importSdkSessionId: id, ownerUserId: other.userId, agentId: otherAgentId }),
      )
      expect([mine.import_sdk_session_id, theirs.import_sdk_session_id]).toEqual([id, id])
    })
  })

  it("A45: a follow job is accepted (source import, no thread, no permission mode); kind 'watch' refused", async () => {
    await inRollback(async (tx) => {
      const job = await insertJob(tx, { kind: "follow", source: "import" })
      expect([job.kind, job.source]).toEqual(["follow", "import"])
      const inPlace = await insertJob(tx, { kind: "follow", source: "app" })
      expect([inPlace.kind, inPlace.source]).toEqual(["follow", "app"])
    })
    expect(await refuses((tx) => insertJob(tx, { kind: "watch", source: "import" }))).toContain(
      "node_jobs_kind_check",
    )
    expect(
      await refuses((tx) =>
        insertJob(tx, { kind: "follow", source: "import", permissionMode: "auto" }),
      ),
    ).toContain("node_jobs_permission_mode_check")
    expect(await refuses((tx) => insertJob(tx, { kind: "unattended", source: "chat" }))).toContain(
      "node_jobs_thread_required",
    )
  })

  it("migration runs twice", async () => {
    await inRollback(async (tx) => {
      for (const s of statements()) await tx.unsafe(s)
      for (const s of statements()) await tx.unsafe(s)
      const [shape] = await tx<{ cols: number; checks: number; indexes: number }[]>`
        SELECT
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'kernel' AND table_name = 'node_sessions'
              AND column_name IN ('import_mode', 'import_sdk_session_id', 'import_from', 'cwd_subdir',
                                  'following', 'import_replay_offset')) AS cols,
          (SELECT count(*)::int FROM pg_constraint
            WHERE conrelid IN ('kernel.node_sessions'::regclass, 'kernel.node_jobs'::regclass)
              AND conname IN ('node_sessions_source_check', 'node_jobs_source_check',
                              'node_jobs_kind_check', 'node_jobs_permission_mode_check',
                              'node_jobs_thread_required', 'node_sessions_import_mode_check',
                              'node_sessions_import_sdk_session_id_check',
                              'node_sessions_import_from_check', 'node_sessions_cwd_subdir_len',
                              'node_sessions_import_replay_offset_check',
                              'node_sessions_import_shape')) AS checks,
          (SELECT count(*)::int FROM pg_indexes
            WHERE schemaname = 'kernel' AND indexname = 'node_sessions_import_once') AS indexes`
      expect(shape).toEqual({ cols: 6, checks: 11, indexes: 1 })
      const row = await insertSession(tx, importCols())
      expect(row.source).toBe("import")
    })
  })
})
