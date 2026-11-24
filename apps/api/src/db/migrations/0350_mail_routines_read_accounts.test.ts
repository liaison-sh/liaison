// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0347 adds `mail:accounts:read` to the routines made from the two shipped templates that draft
// mail without it, where their owner and their agent hold it. Anyone else's routine, one whose owner
// or agent lacks the read, and one that no longer drafts mail are left alone, and nobody is recorded
// as the routine's editor. The file's own statements are replayed on scratch copies; only the schema
// name is swapped.
import { afterAll, beforeAll, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0350_mail_routines_read_accounts.sql", import.meta.url).pathname
const KERN = "mig0347_kernel"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

const ORG = "00000000-0000-4000-8000-0000000000a1"
const OTHER_ORG = "00000000-0000-4000-8000-0000000000a2"
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`
const BY_ROLE = id(1)
const BY_GRANT = id(2)
const WITHOUT = id(3)
const ELSEWHERE = id(4)
const ROLE = id(10)
const AGENT_WIDE = id(20)
const AGENT_NARROW = id(21)
const DRAFTS = ["payments:invoices:read", "mail:conversations:write"]

const ROUTINES: Array<{
  key: string
  owner: string
  agent?: string
  app?: string | null
  template?: string
  source?: string
  scopes?: string[]
}> = [
  { key: "role", owner: BY_ROLE },
  { key: "grant", owner: BY_GRANT },
  { key: "agent-covers", owner: BY_ROLE, agent: AGENT_WIDE },
  { key: "agent-narrow", owner: BY_ROLE, agent: AGENT_NARROW },
  { key: "owner-without", owner: WITHOUT },
  { key: "granted-in-another-org", owner: ELSEWHERE },
  { key: "deals", owner: BY_ROLE, app: null, template: "deal-followups", source: "kernel" },
  { key: "brief", owner: BY_ROLE, app: null, template: "morning-brief", source: "kernel" },
  { key: "own", owner: BY_ROLE, app: null, template: "failed-payments", source: "user" },
  { key: "no-longer-drafts", owner: BY_ROLE, scopes: ["payments:invoices:read"] },
  { key: "had-it", owner: BY_ROLE, scopes: [...DRAFTS, "mail:accounts:read"] },
  { key: "had-all", owner: BY_ROLE, scopes: ["mail:conversations:write", "mail:*"] },
]

beforeAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${KERN} CASCADE`)
  await sql.unsafe(`CREATE SCHEMA ${KERN}`)
  // The scratch tables by name: the connection sees this schema first.
  await sql.unsafe(`SET search_path TO ${KERN}, public`)
  await sql.unsafe(`
    CREATE TABLE ${KERN}.routines (key text, org_id uuid, owner_user_id uuid, owner_agent_id uuid,
      app_name text, template_key text, source_kind text, scopes text[], edited_at timestamptz);
    CREATE TABLE ${KERN}.user_roles (user_id uuid, org_id uuid, role_id uuid);
    CREATE TABLE ${KERN}.role_scope_grants (role_id uuid, scope text);
    CREATE TABLE ${KERN}.user_scope_grants (user_id uuid, org_id uuid, scope text);
    CREATE TABLE ${KERN}.agents (id uuid, org_id uuid, scope_ceiling jsonb);
    CREATE FUNCTION ${KERN}.mark() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.edited_at := now(); RETURN NEW; END $$;
    CREATE TRIGGER routines_mark_definition_edit BEFORE UPDATE ON ${KERN}.routines
      FOR EACH ROW EXECUTE FUNCTION ${KERN}.mark();
    INSERT INTO user_roles VALUES ('${BY_ROLE}', '${ORG}', '${ROLE}');
    INSERT INTO role_scope_grants VALUES ('${ROLE}', 'mail:accounts:read');
    INSERT INTO user_scope_grants VALUES ('${BY_GRANT}', '${ORG}', 'mail:*'),
      ('${WITHOUT}', '${ORG}', 'mail:conversations:read'),
      ('${ELSEWHERE}', '${OTHER_ORG}', 'mail:accounts:read');
    INSERT INTO agents VALUES
      ('${AGENT_WIDE}', '${ORG}', '["payments:invoices:read", "mail:accounts:read"]'),
      ('${AGENT_NARROW}', '${ORG}', '["payments:invoices:read", "mail:conversations:write"]')`)
  for (const r of ROUTINES)
    await sql.unsafe(
      `INSERT INTO routines (key, org_id, owner_user_id, owner_agent_id, app_name, template_key, source_kind, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        r.key,
        ORG,
        r.owner,
        r.agent ?? null,
        r.app === undefined ? "payments" : r.app,
        r.template ?? "failed-payments",
        r.source ?? "app",
        r.scopes ?? DRAFTS,
      ],
    )
})

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${KERN} CASCADE`)
  await sql.end()
})

async function apply(): Promise<void> {
  const statements = readFileSync(FILE, "utf8")
    .replaceAll("kernel.", `${KERN}.`)
    .split("--> statement-breakpoint")
  await sql.begin(async (tx) => {
    // The scratch tables are the test's own: the role switch has nothing to bypass here.
    for (const statement of statements)
      if (statement.trim() !== "" && !/^(SET LOCAL|RESET) ROLE/m.test(statement))
        await tx.unsafe(statement)
  })
}

it("adds the read where owner and agent hold it, once, and marks nobody as the editor", async () => {
  await apply()
  await apply()
  const rows = (await sql.unsafe(
    `SELECT key, scopes, edited_at FROM ${KERN}.routines`,
  )) as unknown as Array<{ key: string; scopes: string[]; edited_at: Date | null }>
  const added = rows
    .filter((r) => r.scopes.filter((s) => s === "mail:accounts:read").length === 1)
    .map((r) => r.key)
    .sort()
  expect(added).toEqual(["agent-covers", "deals", "grant", "had-it", "role"])
  expect(rows.every((r) => r.edited_at === null)).toBe(true)
  // The trigger is back on.
  await sql.unsafe(`UPDATE ${KERN}.routines SET scopes = scopes WHERE key = 'role'`)
  const [after] = (await sql.unsafe(
    `SELECT edited_at FROM ${KERN}.routines WHERE key = 'role'`,
  )) as unknown as Array<{ edited_at: Date | null }>
  expect(after?.edited_at).not.toBeNull()
})
