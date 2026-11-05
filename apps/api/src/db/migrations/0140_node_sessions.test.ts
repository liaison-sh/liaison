// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0140 (node sessions, P1): the connection log becomes kernel.node_connections
// (L1), kernel.node_sessions is the new session table with its events, commands,
// level confirmations (D38, D41) and the owner-only node capabilities (D37, D42);
// node jobs gain the `dispatch` and `app` sources and an app job may have no
// thread (D32, L29); routines gain folder, repo and model (L26, GAP5); a node
// profile is reduced to its level and Liaison tools (S20, D18, GAP7).
//
// The data steps run the migration FILE against the pre-0140 shape: each such
// case reverts the 0140 shape inside one transaction, seeds old-shape rows,
// replays the file's own statements and rolls everything back, so the test
// database keeps its migrated shape. The RLS, grant and check cases run against
// the migrated database itself (`bun run db:migrate` first).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { sql as appSql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0140_node_sessions.sql")

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const notices: string[] = []
const priv = postgres(privilegedUrl(), {
  max: 1,
  onnotice: (n) => {
    notices.push(String(n.message))
  },
})
type Tx = postgres.TransactionSql

function statements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
}

async function runMigration(tx: Tx): Promise<void> {
  for (const statement of statements()) await tx.unsafe(statement)
}

/** Puts back the shape 0138 left (a no-op on a database 0140 never reached). */
const REVERT_TO_0138 = [
  "DROP TABLE IF EXISTS kernel.node_capabilities",
  "DROP TABLE IF EXISTS kernel.node_level_confirmations",
  "DROP TABLE IF EXISTS kernel.node_session_commands",
  "DROP TABLE IF EXISTS kernel.node_session_events",
  `DO $$
   BEGIN
     IF to_regclass('kernel.node_connections') IS NOT NULL THEN
       DROP TABLE IF EXISTS kernel.node_sessions;
       ALTER TABLE kernel.node_connections RENAME TO node_sessions;
       ALTER INDEX kernel.node_connections_pkey RENAME TO node_sessions_pkey;
       ALTER INDEX kernel.node_connections_node_idx RENAME TO node_sessions_node_idx;
       ALTER INDEX kernel.node_connections_open_idx RENAME TO node_sessions_open_idx;
       ALTER TABLE kernel.node_sessions RENAME CONSTRAINT node_connections_node_fk TO node_sessions_node_fk;
       ALTER TABLE kernel.node_sessions RENAME CONSTRAINT node_connections_org_id_fkey TO node_sessions_org_id_fkey;
       ALTER TABLE kernel.node_sessions
         RENAME CONSTRAINT node_connections_close_reason_check TO node_sessions_close_reason_check;
       ALTER POLICY node_connections_read ON kernel.node_sessions RENAME TO node_sessions_read;
     END IF;
   END $$`,
  "ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_thread_required",
  "DELETE FROM kernel.node_jobs WHERE thread_id IS NULL OR source NOT IN ('routine', 'chat', 'agent_tag')",
  "ALTER TABLE kernel.node_jobs ALTER COLUMN thread_id SET NOT NULL",
  "ALTER TABLE kernel.node_jobs DROP CONSTRAINT IF EXISTS node_jobs_source_check",
  "ALTER TABLE kernel.node_jobs ADD CONSTRAINT node_jobs_source_check CHECK (source IN ('routine', 'chat', 'agent_tag'))",
  "ALTER TABLE kernel.routines DROP COLUMN IF EXISTS folder, DROP COLUMN IF EXISTS repo, DROP COLUMN IF EXISTS model",
  `ALTER TABLE kernel.node_profiles
     ADD COLUMN IF NOT EXISTS template text NOT NULL DEFAULT 'default',
     ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
     DROP COLUMN IF EXISTS level,
     DROP COLUMN IF EXISTS liaison_tools`,
  "ALTER TABLE kernel.node_profiles DROP CONSTRAINT IF EXISTS node_profiles_template_check",
  `ALTER TABLE kernel.node_profiles ADD CONSTRAINT node_profiles_template_check
     CHECK (template IN ('default', 'researcher', 'bug_fixer', 'custom'))`,
]

/** postgres.js queries run when `then` is called; `expect().rejects` alone never sends one. */
const run = async <T>(query: PromiseLike<T>): Promise<T> => await query

class Rollback extends Error {}

/** Runs `fn` on the pre-0140 shape and rolls everything back. */
async function onPre0140(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await priv.begin(async (tx) => {
      for (const s of REVERT_TO_0138) await tx.unsafe(s)
      await fn(tx)
      throw new Rollback()
    })
  } catch (err) {
    if (!(err instanceof Rollback)) throw err
  }
}

/** One read through the RLS role, as the app's user context sets it. */
async function readAs<T extends Record<string, unknown>>(
  userId: string,
  scopes: string,
  query: string,
): Promise<T[]> {
  return (await priv.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_rls")
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true),
                    set_config('app.current_user_id', ${userId}, true),
                    set_config('app.current_scopes', ${scopes}, true)`
    return tx.unsafe(query)
  })) as unknown as T[]
}

let orgId: string
let owner: minimal.Session
let member: minimal.Session
let threadId: string
const agents: string[] = []

async function newAgent(handle: string): Promise<string> {
  const [row] = await priv<{ id: string }[]>`
    INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
    VALUES (${orgId}, 'personal', ${`@${handle}-${crypto.randomUUID().slice(0, 8)}`}, ${handle},
            '["kernel:threads:read"]'::jsonb, ${owner.userId})
    RETURNING id`
  agents.push(row!.id)
  return row!.id
}

async function newRoutine(
  tx: Tx,
  agentId: string,
  runsOn: string,
  agentModelId: string | null,
  ownerUserId = owner.userId,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type, runs_on, agent_model_id)
    VALUES (${orgId}, ${ownerUserId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
            'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user', ${runsOn}, ${agentModelId})
    RETURNING id`
  return row!.id
}

async function newNode(tx: Tx | postgres.Sql = priv): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
    VALUES (${orgId}, ${owner.userId}, ${`d.${crypto.randomUUID()}`}, 'Mac')
    RETURNING id`
  return row!.id
}

async function newSession(nodeId: string, agentId: string, ownerUserId = owner.userId) {
  const [row] = await priv<{ id: string }[]>`
    INSERT INTO kernel.node_sessions
      (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model, level, status)
    VALUES (${orgId}, ${ownerUserId}, ${nodeId}, ${agentId}, 'app', 'owner', 'Fix the bug',
            'Fix the bug', 'claude-sonnet-4-5', 'strict', 'running')
    RETURNING id`
  return row!.id
}

/** Columns, constraints, indexes and policies of every table 0140 touches. */
async function shape(tx: Tx): Promise<unknown> {
  return tx.unsafe(`
    WITH touched AS (
      SELECT oid, relname FROM pg_class
       WHERE relnamespace = 'kernel'::regnamespace AND relkind = 'r'
         AND (relname LIKE 'node\\_%' OR relname = 'routines')
    )
    SELECT 'col' AS k, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
                       || ':' || coalesce(column_default, '') AS v
      FROM information_schema.columns
     WHERE table_schema = 'kernel'
       AND table_name IN ('node_connections', 'node_sessions', 'node_session_events',
                          'node_session_commands', 'node_level_confirmations',
                          'node_capabilities', 'node_jobs', 'node_profiles', 'routines')
    UNION ALL
    SELECT 'con', c.relname || '.' || conname || ':' || pg_get_constraintdef(con.oid)
      FROM pg_constraint con JOIN touched c ON c.oid = con.conrelid
    UNION ALL
    SELECT 'idx', c.relname || '.' || i.relname
      FROM pg_index x JOIN touched c ON c.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid
    UNION ALL
    SELECT 'pol', c.relname || '.' || polname || ':' || polcmd::text
      FROM pg_policy p JOIN touched c ON c.oid = p.polrelid
    ORDER BY 1, 2`)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.session(orgId)
  member = await minimal.session(orgId)
  threadId = await minimal.thread(orgId, owner.userId)
})

afterAll(async () => {
  if (orgId) {
    await priv`DELETE FROM kernel.node_jobs WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.nodes WHERE org_id = ${orgId}`
    await priv`DELETE FROM kernel.agents WHERE org_id = ${orgId} AND id = ANY(${agents}::uuid[])`
  }
  await priv.end()
  await releaseTestLock()
})

describe("0140 node sessions: the data steps on the pre-0140 shape", () => {
  it("maps every old template to its level and Liaison tools", async () => {
    const plain = await newAgent("plain")
    const researcher = await newAgent("researcher")
    const fixer = await newAgent("fixer")
    const custom = await newAgent("custom")
    await onPre0140(async (tx) => {
      await tx.unsafe(`
        INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, template, config) VALUES
          ('${orgId}', '${owner.userId}', '${plain}', 'default', '{}'),
          ('${orgId}', '${owner.userId}', '${researcher}', 'researcher', '{"liaisonTools": true}'),
          ('${orgId}', '${owner.userId}', '${fixer}', 'bug_fixer',
           '{"repos": ["https://git.example/a.git", "https://git.example/b.git"], "guardrail": "standard"}'),
          ('${orgId}', '${owner.userId}', '${custom}', 'custom', '{"guardrail": "open", "liaisonTools": false}')`)
      await runMigration(tx)
      const rows = await tx<{ agent_id: string; level: string; liaison_tools: boolean }[]>`
        SELECT agent_id, level, liaison_tools FROM kernel.node_profiles WHERE org_id = ${orgId}`
      const by = Object.fromEntries(rows.map((r) => [r.agent_id, [r.level, r.liaison_tools]]))
      expect(by).toEqual({
        [plain]: ["strict", true],
        [researcher]: ["strict", true],
        [fixer]: ["standard", true],
        [custom]: ["open", false],
      })
      const gone = await tx`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'kernel' AND table_name = 'node_profiles'
           AND column_name IN ('template', 'config')`
      expect(gone).toHaveLength(0)
    })
  })

  it("moves the bug_fixer's first repo into that agent's node routines with no repo, not its cloud routines", async () => {
    const fixer = await newAgent("fixer2")
    const plain = await newAgent("plain2")
    notices.length = 0
    await onPre0140(async (tx) => {
      await tx.unsafe(`
        INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, template, config) VALUES
          ('${orgId}', '${owner.userId}', '${fixer}', 'bug_fixer',
           '{"repos": ["https://git.example/first.git", "https://git.example/second.git"]}')`)
      const onNode = await newRoutine(tx, fixer, "node", null)
      const elseCloud = await newRoutine(tx, fixer, "node_else_cloud", null)
      const cloud = await newRoutine(tx, fixer, "cloud", null)
      const otherAgent = await newRoutine(tx, plain, "node", null)
      const otherOwner = await newRoutine(tx, fixer, "node", null, member.userId)
      await runMigration(tx)
      const rows = await tx<{ id: string; repo: string | null }[]>`
        SELECT id, repo FROM kernel.routines WHERE org_id = ${orgId}`
      const repo = Object.fromEntries(rows.map((r) => [r.id, r.repo]))
      expect(repo[onNode]).toBe("https://git.example/first.git")
      expect(repo[elseCloud]).toBe("https://git.example/first.git")
      expect(repo[cloud]).toBeNull()
      expect(repo[otherAgent]).toBeNull()
      expect(repo[otherOwner]).toBeNull()
    })
    const notice = notices.find((n) => n.includes(fixer))
    expect(notice).toContain("https://git.example/first.git")
    expect(notice).toContain("https://git.example/second.git")
  })

  it("copies a Claude agent_model_id into model for node routines only", async () => {
    const agent = await newAgent("models")
    await onPre0140(async (tx) => {
      const node = await newRoutine(tx, agent, "node", "claude-sonnet-4-5")
      const elseCloud = await newRoutine(tx, agent, "node_else_cloud", "claude-opus-4-1")
      const cloud = await newRoutine(tx, agent, "cloud", "claude-sonnet-4-5")
      const gemini = await newRoutine(tx, agent, "node", "gemini-2.5-flash-lite")
      const none = await newRoutine(tx, agent, "node", null)
      await runMigration(tx)
      const rows = await tx<{ id: string; model: string | null }[]>`
        SELECT id, model FROM kernel.routines WHERE org_id = ${orgId}`
      const model = Object.fromEntries(rows.map((r) => [r.id, r.model]))
      expect(model[node]).toBe("claude-sonnet-4-5")
      expect(model[elseCloud]).toBe("claude-opus-4-1")
      expect(model[cloud]).toBeNull()
      expect(model[gemini]).toBeNull()
      expect(model[none]).toBeNull()
    })
  })

  it("the connection log is node_connections with its rows; node_sessions is the new table", async () => {
    await onPre0140(async (tx) => {
      const nodeId = await newNode(tx)
      await tx`INSERT INTO kernel.node_sessions (org_id, node_id, conn_id)
               VALUES (${orgId}, ${nodeId}, 'conn-1')`
      await runMigration(tx)
      const log = await tx<{ conn_id: string }[]>`
        SELECT conn_id FROM kernel.node_connections WHERE node_id = ${nodeId}`
      expect(log.map((r) => r.conn_id)).toEqual(["conn-1"])
      const cols = await tx<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'kernel' AND table_name = 'node_sessions'`
      const names = cols.map((c) => c.column_name)
      expect(names).toContain("config_kind")
      expect(names).toContain("last_batch_no")
      // D49: a dispatch's repo (a git URL or a shared repo folder's name).
      expect(names).toContain("repo")
      expect(names).not.toContain("conn_id")
      const renamed = await tx<{ v: string }[]>`
        SELECT i.relname::text AS v FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
         WHERE x.indrelid = 'kernel.node_connections'::regclass
        UNION ALL
        SELECT polname FROM pg_policy WHERE polrelid = 'kernel.node_connections'::regclass
        UNION ALL
        SELECT conname FROM pg_constraint WHERE conrelid = 'kernel.node_connections'::regclass`
      expect(renamed.map((r) => r.v).sort()).toEqual(
        [
          "node_connections_pkey",
          "node_connections_node_idx",
          "node_connections_open_idx",
          "node_connections_read",
          "node_connections_pkey",
          "node_connections_node_fk",
          "node_connections_org_id_fkey",
          "node_connections_close_reason_check",
        ].sort(),
      )
    })
  })

  it("running it twice changes nothing", async () => {
    const fixer = await newAgent("twice")
    await onPre0140(async (tx) => {
      await tx.unsafe(`
        INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, template, config) VALUES
          ('${orgId}', '${owner.userId}', '${fixer}', 'bug_fixer',
           '{"repos": ["https://git.example/x.git"], "guardrail": "open"}')`)
      await newRoutine(tx, fixer, "node", "claude-sonnet-4-5")
      await runMigration(tx)
      const data = () => tx`
        SELECT (SELECT json_agg(p ORDER BY p.id) FROM kernel.node_profiles p WHERE p.org_id = ${orgId}) AS profiles,
               (SELECT json_agg(r ORDER BY r.id) FROM kernel.routines r WHERE r.org_id = ${orgId}) AS routines`
      const shapeOnce = await shape(tx)
      const dataOnce = await data()
      await runMigration(tx)
      expect(await shape(tx)).toEqual(shapeOnce)
      expect(await data()).toEqual(dataOnce)
    })
  })
})

describe("0140 node sessions: the migrated database", () => {
  let agentId: string
  let nodeId: string

  beforeAll(async () => {
    agentId = await newAgent("sessions")
    nodeId = await newNode()
  })

  it("the owner reads their session and its events; another member and an org admin with * read neither", async () => {
    const sessionId = await newSession(nodeId, agentId)
    await priv`INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload)
               VALUES (${sessionId}, 1, now(), 'user_message', '{"text":"Fix the bug"}')`
    const sessions = `SELECT id FROM kernel.node_sessions WHERE id = '${sessionId}'`
    const events = `SELECT seq FROM kernel.node_session_events WHERE session_id = '${sessionId}'`
    expect(await readAs(owner.userId, "", sessions)).toHaveLength(1)
    expect(await readAs(owner.userId, "", events)).toHaveLength(1)
    expect(await readAs(member.userId, "", sessions)).toHaveLength(0)
    expect(await readAs(member.userId, "", events)).toHaveLength(0)
    expect(await readAs(member.userId, "*", sessions)).toHaveLength(0)
    expect(await readAs(member.userId, "*,kernel:*", events)).toHaveLength(0)
  })

  it("the node's capabilities and level confirmations are owner-only too", async () => {
    await priv`INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, shared_folders, level_pins)
               VALUES (${nodeId}, ${orgId}, ${owner.userId},
                       '[{"name":"repo","path":"/Users/o/repo"}]', '[]')
               ON CONFLICT (node_id) DO NOTHING`
    await priv`INSERT INTO kernel.node_level_confirmations
                 (org_id, owner_user_id, node_id, agent_id, level, purpose, expires_at)
               VALUES (${orgId}, ${owner.userId}, ${nodeId}, ${agentId}, 'open', 'profile_raise',
                       now() + interval '5 minutes')`
    const caps = `SELECT node_id FROM kernel.node_capabilities WHERE node_id = '${nodeId}'`
    const confs = `SELECT id FROM kernel.node_level_confirmations WHERE node_id = '${nodeId}'`
    expect(await readAs(owner.userId, "", caps)).toHaveLength(1)
    expect(await readAs(owner.userId, "", confs)).toHaveLength(1)
    expect(await readAs(member.userId, "*", caps)).toHaveLength(0)
    expect(await readAs(member.userId, "*", confs)).toHaveLength(0)
  })

  it("liaison_app cannot UPDATE or DELETE node_session_events", async () => {
    const sessionId = await newSession(nodeId, agentId)
    await priv`INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload)
               VALUES (${sessionId}, 1, now(), 'assistant_text', '{"text":"ok"}')`
    await expect(
      run(
        appSql`UPDATE kernel.node_session_events SET payload = '{}' WHERE session_id = ${sessionId}`,
      ),
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      run(appSql`DELETE FROM kernel.node_session_events WHERE session_id = ${sessionId}`),
    ).rejects.toMatchObject({ code: "42501" })
    // Deleting the session still cascades to its events (the referential action
    // runs as the table owner).
    await priv`DELETE FROM kernel.node_sessions WHERE id = ${sessionId}`
    const left =
      await priv`SELECT 1 FROM kernel.node_session_events WHERE session_id = ${sessionId}`
    expect(left).toHaveLength(0)
  })

  it("a dispatch job without a thread is refused; an app job without a thread is stored", async () => {
    const insert = (source: string, thread: string | null) => priv`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt)
      VALUES (${orgId}, ${owner.userId}, ${agentId}, ${thread}, ${source}, 'p') RETURNING id`
    await expect(run(insert("dispatch", null))).rejects.toMatchObject({ code: "23514" })
    await expect(run(insert("chat", null))).rejects.toMatchObject({ code: "23514" })
    const [dispatch] = await insert("dispatch", threadId)
    const [appJob] = await insert("app", null)
    expect(dispatch!.id).toBeString()
    expect(appJob!.id).toBeString()
  })

  it("an event row stores truncated and full_bytes", async () => {
    const sessionId = await newSession(nodeId, agentId)
    await priv`INSERT INTO kernel.node_session_events
                 (session_id, seq, at, type, payload, truncated, full_bytes)
               VALUES (${sessionId}, 1, now(), 'tool_result',
                       '{"id":"toolu_1","isError":false,"output":"..."}', true, 70000),
                      (${sessionId}, 2, now(), 'assistant_text', '{"text":"done"}', DEFAULT, DEFAULT)`
    const rows = await priv<{ seq: number; truncated: boolean; full_bytes: number | null }[]>`
      SELECT seq, truncated, full_bytes FROM kernel.node_session_events
       WHERE session_id = ${sessionId} ORDER BY seq`
    expect(rows.map((r) => [r.seq, r.truncated, r.full_bytes])).toEqual([
      [1, true, 70000],
      [2, false, null],
    ])
    await expect(
      run(priv`INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload)
           VALUES (${sessionId}, 3, now(), 'not_a_type', '{}')`),
    ).rejects.toMatchObject({ code: "23514" })
  })

  it("a session_start confirmation with a session_id, or an attached_session_id on a profile_raise, is refused by the checks", async () => {
    const sessionId = await newSession(nodeId, agentId)
    const confirm = (
      purpose: string,
      agent: string | null,
      session: string | null,
      attached: string | null,
    ) =>
      priv`INSERT INTO kernel.node_level_confirmations
             (org_id, owner_user_id, node_id, agent_id, session_id, level, purpose,
              attached_session_id, expires_at)
           VALUES (${orgId}, ${owner.userId}, ${nodeId}, ${agent}, ${session}, 'standard',
                   ${purpose}, ${attached}, now() + interval '5 minutes')`
    await expect(run(confirm("session_start", null, sessionId, null))).rejects.toMatchObject({
      code: "23514",
    })
    await expect(run(confirm("profile_raise", agentId, null, sessionId))).rejects.toMatchObject({
      code: "23514",
    })
    await expect(run(confirm("session_raise", agentId, null, null))).rejects.toMatchObject({
      code: "23514",
    })
    await expect(run(confirm("profile_raise", agentId, sessionId, null))).rejects.toMatchObject({
      code: "23514",
    })
    await confirm("session_start", agentId, null, sessionId)
    await confirm("session_raise", null, sessionId, null)
    await confirm("profile_raise", agentId, null, null)
  })
})
