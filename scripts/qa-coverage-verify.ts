#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Pre-launch QA coverage verify (T1.10).
 *
 * Boots a connection to the dev DB and asserts the resting state per
 * fixture phase from this pipeline (T1.1 → T1.9). Exits non-zero with a
 * structured per-check failure list if any expected fixture is missing.
 *
 * Usage:
 *   bun run scripts/qa-coverage-verify.ts
 *   QA_EDITION=self_hosted bun run scripts/qa-coverage-verify.ts
 *
 * The verify script is the runtime backstop for the QA seed work — the
 * standard seed tier's lane snapshot test pins the same world inside an
 * isolated worker env; this script checks it against the actual dev DB so the
 * deploy gate fails if `bun run db:reset && bun run seed --yes` doesn't
 * land the expected resting state.
 */
import postgres from "postgres"

interface Check {
  phase: string
  name: string
  run: () => Promise<{ ok: boolean; detail?: string }>
}

const QA_EDITION = process.env.QA_EDITION ?? "managed"
const DB_URL =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_dev"
const sql = postgres(DB_URL, { onnotice: () => {} })

async function rowCount(query: string, params: unknown[] = []): Promise<number> {
  const rows = (await sql.unsafe(query, params)) as Array<unknown>
  return rows.length
}

async function adminOrgId(): Promise<string> {
  const rows = (await sql.unsafe(
    `SELECT id FROM kernel.organizations ORDER BY created_at ASC LIMIT 1`,
  )) as Array<{ id: string }>
  if (!rows[0]) throw new Error("No admin org found — was `bun run seed --yes` run?")
  return rows[0].id
}

async function main(): Promise<void> {
  const org = await adminOrgId()
  const checks: Check[] = [
    {
      phase: "T1.1",
      name: "agent_memory has ≥8 typed entries + per-user _index rows",
      run: async () => {
        const typed = await rowCount(
          `SELECT 1 FROM kernel.agent_memory WHERE org_id = $1 AND type != '_index'`,
          [org],
        )
        const indexRows = await rowCount(
          `SELECT 1 FROM kernel.agent_memory WHERE org_id = $1 AND type = '_index'`,
          [org],
        )
        if (typed < 8) return { ok: false, detail: `expected ≥8 typed rows, got ${typed}` }
        if (indexRows < 3) return { ok: false, detail: `expected ≥3 _index rows, got ${indexRows}` }
        return { ok: true }
      },
    },
    {
      phase: "T1.2",
      name: "app_knowledge has ≥8 documents + ≥3 collections",
      run: async () => {
        const docs = await rowCount(
          `SELECT 1 FROM app_knowledge.documents WHERE org_id = $1 AND archived_at IS NULL`,
          [org],
        )
        const cols = await rowCount(
          `SELECT 1 FROM app_knowledge.collections WHERE org_id = $1 AND archived_at IS NULL`,
          [org],
        )
        if (docs < 8) return { ok: false, detail: `expected ≥8 docs, got ${docs}` }
        if (cols < 3) return { ok: false, detail: `expected ≥3 collections, got ${cols}` }
        return { ok: true }
      },
    },
    {
      phase: "T1.2",
      name: "≥2 documents are unfiled (no collection_membership)",
      run: async () => {
        const orphans = await rowCount(
          `SELECT 1 FROM app_knowledge.documents d
           WHERE d.org_id = $1 AND d.archived_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM app_knowledge.collection_memberships m
               WHERE m.target_id = d.id AND m.target_type = 'document'
             )`,
          [org],
        )
        if (orphans < 2) return { ok: false, detail: `expected ≥2 orphans, got ${orphans}` }
        return { ok: true }
      },
    },
    {
      phase: "T1.3",
      name: "app_tickets has ≥3 inboxes + ≥10 tickets + ≥5 categories",
      run: async () => {
        const inboxes = await rowCount(`SELECT 1 FROM app_tickets.inboxes WHERE org_id = $1`, [org])
        const tickets = await rowCount(`SELECT 1 FROM app_tickets.tickets WHERE org_id = $1`, [org])
        const cats = await rowCount(
          `SELECT 1 FROM app_tickets.categories WHERE org_id = $1 AND archived_at IS NULL`,
          [org],
        )
        if (inboxes < 3 || tickets < 10 || cats < 5)
          return {
            ok: false,
            detail: `inboxes=${inboxes} tickets=${tickets} categories=${cats}`,
          }
        return { ok: true }
      },
    },
    {
      phase: "T1.4",
      name: "kernel.attention_events has ≥6 events for admin",
      run: async () => {
        // First user in created_at order is the admin = admin.
        const userRows = (await sql.unsafe(
          `SELECT id FROM kernel.users WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [org],
        )) as Array<{ id: string }>
        const userId = userRows[0]?.id
        if (!userId) return { ok: false, detail: "no admin user found" }
        const n = await rowCount(
          `SELECT 1 FROM kernel.attention_events WHERE org_id = $1 AND user_id = $2`,
          [org, userId],
        )
        if (n < 6) return { ok: false, detail: `expected ≥6 events, got ${n}` }
        return { ok: true }
      },
    },
    {
      phase: "T1.5",
      name: "approval_requests covers pending / approved / denied",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT status, COUNT(*)::int AS n FROM kernel.approval_requests
           WHERE org_id = $1 GROUP BY status`,
          [org],
        )) as Array<{ status: string; n: number }>
        const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n] as const))
        if ((byStatus.pending ?? 0) < 1) return { ok: false, detail: "no pending row" }
        if ((byStatus.approved ?? 0) < 1) return { ok: false, detail: "no approved row" }
        if ((byStatus.denied ?? 0) < 1) return { ok: false, detail: "no denied row" }
        return { ok: true }
      },
    },
    {
      phase: "T1.5",
      name: "approval_requests has a compound bundle (head + 2 steps)",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT bundle_id, COUNT(*)::int AS n FROM kernel.approval_requests
           WHERE org_id = $1 AND bundle_id IS NOT NULL
           GROUP BY bundle_id`,
          [org],
        )) as Array<{ bundle_id: string; n: number }>
        if (!rows.some((r) => r.n >= 3))
          return { ok: false, detail: "no bundle with 3+ rows found" }
        return { ok: true }
      },
    },
    {
      phase: "T1.6",
      name: "routine_runs ≥5; ≥1 agent_chat with toolCalls metadata",
      run: async () => {
        const runs = await rowCount(`SELECT 1 FROM kernel.routine_runs WHERE org_id = $1`, [org])
        const toolCallMsgs = await rowCount(
          `SELECT 1 FROM kernel.messages m
           JOIN kernel.threads t ON t.id = m.thread_id
           WHERE m.org_id = $1 AND t.type = 'agent_chat' AND m.metadata ? 'toolCalls'`,
          [org],
        )
        if (runs < 5) return { ok: false, detail: `expected ≥5 runs, got ${runs}` }
        if (toolCallMsgs < 1)
          return { ok: false, detail: "no agent_chat message with toolCalls metadata" }
        return { ok: true }
      },
    },
    {
      phase: "T1.7",
      name: "saved_views ≥3 with mixed personal/shared",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT shared_with_org FROM kernel.saved_views WHERE org_id = $1`,
          [org],
        )) as Array<{ shared_with_org: boolean }>
        if (rows.length < 3) return { ok: false, detail: `expected ≥3, got ${rows.length}` }
        if (!rows.some((r) => r.shared_with_org === true))
          return { ok: false, detail: "no shared view" }
        if (!rows.some((r) => r.shared_with_org === false))
          return { ok: false, detail: "no personal view" }
        return { ok: true }
      },
    },
    {
      phase: "T1.8",
      name: "≥3 mail accounts (gmail + imap providers)",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT provider FROM app_mail.accounts WHERE org_id = $1 AND disconnected_at IS NULL`,
          [org],
        )) as Array<{ provider: string }>
        const providers = new Set(rows.map((r) => r.provider))
        if (rows.length < 3) return { ok: false, detail: `expected ≥3, got ${rows.length}` }
        if (!providers.has("gmail") || !providers.has("imap"))
          return {
            ok: false,
            detail: `missing provider — got [${[...providers].join(", ")}]`,
          }
        return { ok: true }
      },
    },
    {
      phase: "T1.8",
      name: "≥8 mail conversations spanning every status",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT status FROM app_mail.conversations WHERE org_id = $1`,
          [org],
        )) as Array<{ status: string }>
        const statuses = new Set(rows.map((r) => r.status))
        if (rows.length < 8) return { ok: false, detail: `expected ≥8, got ${rows.length}` }
        for (const want of ["open", "trashed", "escalated"]) {
          if (!statuses.has(want)) return { ok: false, detail: `missing status ${want}` }
        }
        return { ok: true }
      },
    },
    {
      phase: "T1.8",
      name: "Slack + GitHub connector placeholders present",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT app_name FROM kernel.connected_accounts
           WHERE org_id = $1 AND app_name IN ('slack', 'github') AND status = 'active'`,
          [org],
        )) as Array<{ app_name: string }>
        const apps = new Set(rows.map((r) => r.app_name))
        if (!apps.has("slack")) return { ok: false, detail: "no slack connector" }
        if (!apps.has("github")) return { ok: false, detail: "no github connector" }
        return { ok: true }
      },
    },
    {
      phase: "T1.8",
      name: "≥1 fr-FR locale user exists (Diana)",
      run: async () => {
        const rows = (await sql.unsafe(
          `SELECT id FROM kernel.users WHERE org_id = $1 AND locale = 'fr-FR'`,
          [org],
        )) as Array<{ id: string }>
        if (rows.length < 1) return { ok: false, detail: "no fr-FR user" }
        return { ok: true }
      },
    },
    {
      phase: "T1.9",
      name:
        QA_EDITION === "self_hosted"
          ? "self_hosted edition: no credit_balance row for admin org"
          : "managed edition: credit_balance row exists for admin org",
      run: async () => {
        const rows = (await sql.unsafe(`SELECT 1 FROM kernel.credit_balances WHERE org_id = $1`, [
          org,
        ])) as Array<unknown>
        if (QA_EDITION === "self_hosted") {
          if (rows.length !== 0)
            return { ok: false, detail: `expected 0 rows in self_hosted mode, got ${rows.length}` }
        } else {
          if (rows.length === 0)
            return { ok: false, detail: "no credit_balance row in managed mode" }
        }
        return { ok: true }
      },
    },
  ]

  const results: Array<{ phase: string; name: string; ok: boolean; detail?: string }> = []
  for (const c of checks) {
    try {
      const r = await c.run()
      results.push({ phase: c.phase, name: c.name, ...r })
    } catch (err) {
      results.push({
        phase: c.phase,
        name: c.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const passed = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)

  for (const r of results) {
    const icon = r.ok ? "✓" : "✗"
    const detail = r.detail ? ` — ${r.detail}` : ""
    // eslint-disable-next-line no-console
    console.log(`  ${icon} [${r.phase}] ${r.name}${detail}`)
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nqa-coverage-verify (edition=${QA_EDITION}): ${passed.length} passed, ${failed.length} failed.`,
  )
  await sql.end({ timeout: 5 })
  if (failed.length > 0) process.exit(1)
}

await main()
