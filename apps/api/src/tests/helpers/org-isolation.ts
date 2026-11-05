// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared fixtures of the org isolation invariants (tests/security/*): orgs
// made without the single-org bootstrap (which truncates), seeded through
// their own API, and read back store by store with queries that do not
// reuse the product's own definitions of "the org's rows".
import postgres from "postgres"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"

/**
 * The scans read every table whole, whatever its grants: on the superuser
 * login of the run's database, never the app's own pools.
 */
let scanClient: ReturnType<typeof postgres> | null = null
function scan(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_URL_SUPERUSER ?? process.env.DATABASE_URL
  if (!url) throw new Error("org isolation scans need DATABASE_URL_SUPERUSER")
  scanClient ??= postgres(url, { max: 2, onnotice: () => {} })
  return scanClient
}

/** Close the scan connection (afterAll). */
export async function closeIsolationScans(): Promise<void> {
  await scanClient?.end()
  scanClient = null
}

export interface IsolationOrg {
  orgId: string
  userId: string
  token: string
}

/** A fresh org with an admin and a bearer token; nothing else in the database is touched. */
export async function newIsolationOrg(): Promise<IsolationOrg> {
  const { orgId, adminUserId } = await minimal.secondOrg()
  return { orgId, userId: adminUserId, token: await minimal.token(adminUserId) }
}

/** POST `body` to `path` as the org's admin. */
export async function postAs(org: IsolationOrg, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${org.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * One object of each common kind, created through the org's own API, every
 * name carrying `canary` so a copy of it anywhere else can be found by text.
 * Returns the status line of each call (some routes refuse a shape; the
 * invariants assert their own floors).
 */
export async function seedOrgThroughApi(org: IsolationOrg, canary: string): Promise<string[]> {
  const n = canary
  const calls: Array<[string, unknown]> = [
    ["/api/saved-views", { app: "tickets", viewId: `v-${n}`, name: `view ${n}`, payload: {} }],
    ["/api/admin/roles", { name: `role-${n}` }],
    ["/api/contacts/groups", { name: `group ${n}` }],
    ["/api/trusted-senders", { kind: "address", value: `trusted-${n}@example.com` }],
    ["/api/document-templates", { kind: "rich_text", name: `template ${n}`, body: { blocks: [] } }],
    ["/api/projects", { name: `project ${n}` }],
    ["/api/agent/skills", { name: `skill-${n}`, description: n, body: n, visibility: "org" }],
    [
      "/api/agent/routines",
      {
        name: `routine-${n}`,
        description: n,
        prompt: n,
        kind: "recurring",
        cron: "0 0 * * *",
        timezone: "UTC",
      },
    ],
    ["/api/agent/memories", { type: "user", name: `memory-${n}`, description: n, content: n }],
    ["/api/threads", { participantIds: [], title: `thread ${n}` }],
    ["/api/knowledge/documents", { documentScope: "org", title: `doc ${n}` }],
    ["/api/knowledge/collections", { name: `collection ${n}` }],
    ["/api/knowledge/tags", { name: `tag-${n}` }],
    ["/api/agents", { handle: `agent-${n}`, displayName: `Agent ${n}` }],
    ["/api/contacts/resolve", { email: `resolved-${n}@example.com`, name: `Resolved ${n}` }],
  ]
  const status: string[] = []
  for (const [path, body] of calls) {
    const res = await postAs(org, path, body)
    status.push(`${res.status} ${path}`)
  }
  return status
}

/** Every base table of `kernel` and `app_*` that carries an `org_id` column (from pg_catalog). */
export async function orgScopedTables(): Promise<string[]> {
  const rows = await scan()<{ t: string }[]>`
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
    ORDER BY 1`
  return rows.map((r) => r.t)
}

/** Every base table outside the system schemas, for text scans. */
export async function allUserTables(): Promise<string[]> {
  const rows = await scan()<{ t: string }[]>`
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS t
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg\\_temp%' AND n.nspname NOT LIKE 'pg\\_toast%'
    ORDER BY 1`
  return rows.map((r) => r.t)
}

/**
 * Per org-scoped table: the row count and an order-independent digest of the
 * org's rows (`others`: of every row NOT of the org). Two fingerprints differ
 * when anything they cover was written.
 */
export async function orgFingerprint(
  orgId: string,
  opts: { others?: boolean } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const op = opts.others ? "IS DISTINCT FROM" : "="
  for (const t of await orgScopedTables()) {
    const [r] = await scan().unsafe<{ n: string; h: string | null }[]>(
      `SELECT count(*)::text AS n,
              md5(coalesce(string_agg(md5(x::text), '' ORDER BY md5(x::text)), '')) AS h
       FROM ${t} x WHERE x.org_id ${op} $1::uuid`,
      [orgId],
    )
    if (r && r.n !== "0") out[t] = `${r.n}:${r.h}`
  }
  return out
}

/** Tables (of `tables`, default every user table) with a row whose text contains `needle`. */
export async function tablesMentioning(
  needle: string,
  opts: { tables?: string[]; where?: (table: string) => string } = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of opts.tables ?? (await allUserTables())) {
    const extra = opts.where ? ` AND (${opts.where(t)})` : ""
    const [r] = await scan().unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM ${t} x WHERE strpos(x::text, $1) > 0${extra}`,
      [needle],
    )
    if (r && r.n !== "0") out[t] = Number(r.n)
  }
  return out
}

/** The diff of two fingerprints: tables added, removed or changed. */
export function fingerprintDiff(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k}: ${before[k] ?? "-"} -> ${after[k] ?? "-"}`)
}
