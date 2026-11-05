#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reconstructs one operator's real usage of a Liaison deployment from the
// AUDIT TRAIL of her (and her agent's) tool calls, anonymized, so a haiku
// writer can later rebuild a realistic conversation around the call
// sequence WITHOUT ever seeing a real message body (A44,
// brainstorm-decisions.md — "the most important data is the audit of her
// agent's MCP calls, not the actual conversation").
//
// Usage:
//   bun scripts/bench/audit-usage-export.ts \
//     --dsn <postgres url> --user <email or user id> --since <ISO date> --out <dir>
//
// Connects READ ONLY: the session sets `default_transaction_read_only = on`
// and a 30s `statement_timeout` before issuing a single query, and every
// query below is a plain SELECT. Nothing is ever written to the database.
//
// Tables/columns read (see README.md written into --out for the same list
// with the "why"):
//   kernel.users            id, org_id, email, name           (resolve + name list)
//   kernel.contacts         id, org_id, name                  (name list only)
//   kernel.agents           id, org_id, owner_user_id, kind    (resolve the user's personal agent(s))
//   kernel.audit_log        id, timestamp, actor_id, actor_type, app, entity_type,
//                           entity_id, action, changes, metadata, event_id,
//                           agent_id, requester_user_id
//   kernel.threads          id, type, created_at              (via thread_participants)
//   kernel.thread_participants  thread_id, user_id            (membership only, no content)
//   kernel.messages         id, thread_id, author_type, author_agent_id, created_at,
//                           length(content) AS content_chars  — the body itself is NEVER selected
//   kernel.agent_runs       every column except actor, prompt, input, output, summary,
//                           error_message (the free text / content columns)
//
// Never reads kernel.messages.content, any app_mail body, or any ticket body.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import {
  type Anonymizer,
  createAnonymizer,
} from "../../apps/api/src/tests/bench/long-context/audit-anonymize"

interface Args {
  dsn: string
  user: string
  since: string
  out: string
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const dsn = get("dsn")
  const user = get("user")
  const since = get("since")
  const out = get("out")
  if (!dsn || !user || !since || !out) {
    console.error(
      "Usage: bun scripts/bench/audit-usage-export.ts --dsn <postgres url> --user <email or user id> --since <ISO date> --out <dir>",
    )
    process.exit(1)
  }
  return { dsn, user, since, out }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pseudonymizes a single scalar id/text field (null-safe). Text fields that
 *  are not UUID-shaped (e.g. a Shopify order number in entity_id) pass
 *  through the same PII scan as free text, so a stray email/name still gets
 *  caught. */
function anonId(anonymizer: Anonymizer, value: string | null): string | null {
  if (value === null) return null
  return anonymizer.anonymizeText(value)
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.out, { recursive: true })

  const sql = postgres(args.dsn, {
    max: 1,
    onnotice: () => {},
  })

  try {
    // A dedicated reserved connection: SET applies at the SESSION level and
    // every subsequent query below must run on that SAME connection, or the
    // read-only/timeout guard would not cover it.
    const reserved = await sql.reserve()
    try {
      await reserved`SET default_transaction_read_only = on`
      await reserved`SET statement_timeout = '30s'`

      // --- resolve the user -------------------------------------------------
      const isUuid = UUID_RE.test(args.user)
      const userRows = await reserved<{ id: string; orgId: string; email: string; name: string }[]>`
        SELECT id, org_id AS "orgId", email, name
        FROM kernel.users
        WHERE ${isUuid ? reserved`id = ${args.user}::uuid` : reserved`email = ${args.user}`}
        LIMIT 1
      `
      const user = userRows[0]
      if (!user) {
        console.error(`No kernel.users row found for --user ${args.user}`)
        process.exit(1)
      }

      // --- the user's personal agent(s) (A11: agent acting FOR the user) ----
      // Older deployments predate the agents kernel: probe the catalog, never assume.
      const hasRelation = async (schema: string, name: string): Promise<boolean> => {
        const rows = await reserved<{ ok: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = ${name}
          ) AS ok
        `
        return rows[0]?.ok === true
      }
      const hasColumn = async (schema: string, table: string, column: string): Promise<boolean> => {
        const rows = await reserved<{ ok: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${column}
          ) AS ok
        `
        return rows[0]?.ok === true
      }
      const hasAgents = await hasRelation("kernel", "agents")
      const hasAuditAgentCols = await hasColumn("kernel", "audit_log", "agent_id")
      const hasAuthorAgentId = await hasColumn("kernel", "messages", "author_agent_id")
      const hasAgentRuns = await hasRelation("kernel", "agent_runs")
      const ownedAgents = hasAgents
        ? await reserved<{ id: string }[]>`
        SELECT id FROM kernel.agents
        WHERE org_id = ${user.orgId}::uuid AND owner_user_id = ${user.id}::uuid AND kind = 'personal'
      `
        : []
      const ownedAgentIds = ownedAgents.map((a) => a.id)
      console.error(
        `schema: agents=${hasAgents} audit agent cols=${hasAuditAgentCols} author_agent_id=${hasAuthorAgentId} agent_runs=${hasAgentRuns}`,
      )

      // --- name list for the anonymizer (kernel.users + kernel.contacts, same org) ---
      const userNames = await reserved<{ name: string }[]>`
        SELECT name FROM kernel.users WHERE org_id = ${user.orgId}::uuid AND name IS NOT NULL
      `
      const contactNames = await reserved<{ name: string }[]>`
        SELECT name FROM kernel.contacts WHERE org_id = ${user.orgId}::uuid AND name IS NOT NULL
      `
      const anonymizer = createAnonymizer([
        ...userNames.map((r) => r.name),
        ...contactNames.map((r) => r.name),
      ])

      // --- audit_log: the user herself, OR her personal agent acting, OR the
      // audit row naming her as the requester behind an agent turn --------
      const auditRows = await reserved<
        {
          id: string
          timestamp: Date
          actorId: string | null
          actorType: string
          app: string | null
          entityType: string | null
          entityId: string | null
          action: string
          changes: unknown
          metadata: unknown
          eventId: string | null
          agentId: string | null
          requesterUserId: string | null
        }[]
      >`
        SELECT id, timestamp, actor_id AS "actorId", actor_type AS "actorType", app,
               entity_type AS "entityType", entity_id AS "entityId", action, changes,
               metadata, event_id AS "eventId",
               ${hasAuditAgentCols ? reserved`agent_id AS "agentId", requester_user_id AS "requesterUserId"` : reserved`NULL::uuid AS "agentId", NULL::uuid AS "requesterUserId"`}
        FROM kernel.audit_log
        WHERE org_id = ${user.orgId}::uuid
          AND timestamp >= ${args.since}::timestamptz
          AND (
            actor_id = ${user.id}::uuid
            ${hasAuditAgentCols ? reserved`OR requester_user_id = ${user.id}::uuid` : reserved``}
            ${hasAuditAgentCols && ownedAgentIds.length > 0 ? reserved`OR agent_id = ANY(${ownedAgentIds}::uuid[])` : reserved``}
          )
        ORDER BY timestamp ASC
      `
      const auditOut = auditRows.map((r) => ({
        id: anonId(anonymizer, r.id),
        timestamp: r.timestamp.toISOString(),
        actorId: anonId(anonymizer, r.actorId),
        actorType: r.actorType,
        app: r.app,
        entityType: r.entityType,
        entityId: anonId(anonymizer, r.entityId),
        action: r.action,
        changes: anonymizer.anonymizeJsonValue(r.changes),
        metadata: anonymizer.anonymizeJsonValue(r.metadata),
        eventId: anonId(anonymizer, r.eventId),
        agentId: anonId(anonymizer, r.agentId),
        requesterUserId: anonId(anonymizer, r.requesterUserId),
      }))
      writeJsonl(join(args.out, "audit.jsonl"), auditOut)

      // --- threads the user participates in, boundaries only ---------------
      const threadRows = await reserved<{ id: string; type: string; createdAt: Date }[]>`
        SELECT t.id, t.type, t.created_at AS "createdAt"
        FROM kernel.threads t
        JOIN kernel.thread_participants tp ON tp.thread_id = t.id
        WHERE t.org_id = ${user.orgId}::uuid AND tp.user_id = ${user.id}::uuid
        ORDER BY t.created_at ASC
      `
      const threadIds = threadRows.map((t) => t.id)
      const threadsOut = threadRows.map((t) => ({
        id: anonId(anonymizer, t.id),
        type: t.type,
        createdAt: t.createdAt.toISOString(),
      }))
      writeJsonl(join(args.out, "threads.jsonl"), threadsOut)

      // --- message shape only: never content, only its length --------------
      const messageRows =
        threadIds.length > 0
          ? await reserved<
              {
                id: string
                threadId: string
                authorType: string
                authorAgentId: string | null
                createdAt: Date
                contentChars: number
              }[]
            >`
        SELECT id, thread_id AS "threadId", author_type AS "authorType",
               ${hasAuthorAgentId ? reserved`author_agent_id AS "authorAgentId"` : reserved`NULL::uuid AS "authorAgentId"`}, created_at AS "createdAt",
               length(content) AS "contentChars"
        FROM kernel.messages
        WHERE thread_id = ANY(${threadIds}::uuid[])
        ORDER BY created_at ASC
      `
          : []
      const messagesOut = messageRows.map((m) => ({
        id: anonId(anonymizer, m.id),
        threadId: anonId(anonymizer, m.threadId),
        authorType: m.authorType,
        authorAgentId: anonId(anonymizer, m.authorAgentId),
        createdAt: m.createdAt.toISOString(),
        contentChars: m.contentChars,
      }))
      writeJsonl(join(args.out, "messages-shape.jsonl"), messagesOut)

      // --- agent_runs: the dedicated tool-call/turn table, non-content columns ---
      const agentRunRows =
        hasAgentRuns && ownedAgentIds.length > 0
          ? await reserved<
              {
                id: string
                parentRunId: string | null
                rootRunId: string
                threadId: string
                parentThreadId: string | null
                agentId: string | null
                subagentType: string | null
                status: string
                errorCode: string | null
                usagePromptTokens: number
                usageCompletionTokens: number
                creditCost: string
                maxSteps: number
                timeoutMs: number
                schemaRetryBudget: number
                schemaRetryCount: number
                attemptCount: number
                nestingDepth: number
                startedAt: Date | null
                finishedAt: Date | null
                createdAt: Date
              }[]
            >`
        SELECT id, parent_run_id AS "parentRunId", root_run_id AS "rootRunId",
               thread_id AS "threadId", parent_thread_id AS "parentThreadId",
               agent_id AS "agentId", subagent_type AS "subagentType", status,
               error_code AS "errorCode", usage_prompt_tokens AS "usagePromptTokens",
               usage_completion_tokens AS "usageCompletionTokens", credit_cost AS "creditCost",
               max_steps AS "maxSteps", timeout_ms AS "timeoutMs",
               schema_retry_budget AS "schemaRetryBudget", schema_retry_count AS "schemaRetryCount",
               attempt_count AS "attemptCount", nesting_depth AS "nestingDepth",
               started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt"
        FROM kernel.agent_runs
        WHERE org_id = ${user.orgId}::uuid
          AND agent_id = ANY(${ownedAgentIds}::uuid[])
          AND created_at >= ${args.since}::timestamptz
        ORDER BY created_at ASC
      `
          : []
      const agentRunsOut = agentRunRows.map((r) => ({
        id: anonId(anonymizer, r.id),
        parentRunId: anonId(anonymizer, r.parentRunId),
        rootRunId: anonId(anonymizer, r.rootRunId),
        threadId: anonId(anonymizer, r.threadId),
        parentThreadId: anonId(anonymizer, r.parentThreadId),
        agentId: anonId(anonymizer, r.agentId),
        subagentType: r.subagentType,
        status: r.status,
        errorCode: r.errorCode,
        usagePromptTokens: r.usagePromptTokens,
        usageCompletionTokens: r.usageCompletionTokens,
        creditCost: r.creditCost,
        maxSteps: r.maxSteps,
        timeoutMs: r.timeoutMs,
        schemaRetryBudget: r.schemaRetryBudget,
        schemaRetryCount: r.schemaRetryCount,
        attemptCount: r.attemptCount,
        nestingDepth: r.nestingDepth,
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }))
      writeJsonl(join(args.out, "agent-runs.jsonl"), agentRunsOut)

      // --- README ------------------------------------------------------------
      const readme = `# Audit usage export

Generated ${new Date().toISOString()} by scripts/bench/audit-usage-export.ts for --user ${args.user} --since ${args.since}.

## Connection

Read only. The session ran \`SET default_transaction_read_only = on\` and
\`SET statement_timeout = '30s'\` before any query, on one reserved
connection every query below shares. No INSERT, UPDATE, or DELETE was ever
issued.

## Tables and columns read

- kernel.users: id, org_id, email, name (resolve the user; name is read ONLY to seed the anonymizer's name list, never written raw)
- kernel.contacts: name (org scoped, name list for the anonymizer only)
- kernel.agents: id, org_id, owner_user_id, kind (find the user's personal agent(s), the A11 principal that acts for her)
- kernel.audit_log: id, timestamp, actor_id, actor_type, app, entity_type, entity_id, action, changes, metadata, event_id, agent_id, requester_user_id -> audit.jsonl
- kernel.threads (joined via kernel.thread_participants): id, type, created_at -> threads.jsonl
- kernel.thread_participants: thread_id, user_id (membership filter only, no columns of its own are written out)
- kernel.messages: id, thread_id, author_type, author_agent_id, created_at, length(content) AS content_chars -> messages-shape.jsonl. content itself is NEVER selected, only its length.
- kernel.agent_runs: every column except actor (opaque ActorContext snapshot), prompt, input, output, summary, error_message -> agent-runs.jsonl

## What was never read

kernel.messages.content, any app_mail message body, any ticket body/note
text. No table outside the list above was queried.

## Anonymization

Every UUID-shaped field (row ids, actor_id, agent_id, requester_user_id,
event_id, thread_id, author_agent_id, entity_id when UUID-shaped) is
replaced by a stable pseudonym from ONE in-memory map built for this run
only — the same source UUID always yields the same pseudonym across every
output file, so audit.jsonl / threads.jsonl / messages-shape.jsonl /
agent-runs.jsonl stay joinable on the pseudonyms. changes and metadata JSON
keep their keys and value shapes; free text values over 40 characters
collapse to a "<text:N chars>" token; tool/action name fields and
short ABC-1234-shaped identifiers survive verbatim. The pseudonym mapping
lives only in this process's memory and is written nowhere.

## Row counts

- audit.jsonl: ${auditOut.length}
- threads.jsonl: ${threadsOut.length}
- messages-shape.jsonl: ${messagesOut.length}
- agent-runs.jsonl: ${agentRunsOut.length}
`
      writeFileSync(join(args.out, "README.md"), readme)

      console.log(
        `Wrote ${auditOut.length} audit rows, ${threadsOut.length} threads, ${messagesOut.length} message shapes, ${agentRunsOut.length} agent runs to ${args.out}`,
      )
    } finally {
      reserved.release()
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
