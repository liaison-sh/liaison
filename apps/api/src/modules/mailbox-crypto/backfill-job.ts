// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 12.1: seal the historical corpus, unattended.
//
// Sealing needs only the PUBLIC key, which is the whole reason an unattended
// backfill is possible at all: this job creates ciphertext it can never read
// back, exactly like the ingest path. It NULLs nothing. The plaintext columns
// stay in place for the entire dual-read window and are removed only by
// `purge.ts`, and only against a client acknowledgement.
//
// REGISTRATION (blueprint amendment A7). `registerKernelJobs()` is called from
// `index.ts`, `index.e2e.ts` and any dedicated job worker, so a job added to
// `kernel-jobs.ts` registers in EVERY process. This one therefore lives on its
// own and is called from `index.ts` only, immediately after
// `startLeadership({ role, onJobsGate: setJobsLeadership })`, so it rides the
// already-gated BullMQ path like every other scheduled worker.
//
// It never gates on `SINGLETON_LEADER_URL`. That variable IS set in prod, so a
// guard keyed on it would permit registration in precisely the process that
// never starts leadership. It gates on leadership having started
// (`hasLeadershipMonitorStarted()`), and refuses the boot otherwise: a
// process that never started leadership has no jobs gate and no lease, so
// `isLeader()` fails closed there and the backfill would silently never run,
// or run ungated if a later entrypoint wired the jobs another way. A hard
// throw at boot is right; a silently skipped backfill is worse than a refused
// boot.
//
// THE CURSOR IS `(created_at, id)`, NOT `(sent_at, id)` (amendment A8).
// `messages.sentAt` is declared `"date?"` and ingest writes it straight through
// with no fallback, so real rows carry NULL and a row-value keyset over it
// evaluates to NULL for them: they would be silently excluded from every batch
// after the first, forever, while `messages_sealed` still climbed and the job
// reported completion. `created_at` is `NOT NULL DEFAULT now()` on every app
// entity table by construction, so there is no NULL case to handle at all.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { registerJobWorker, registerScheduledJob } from "~/infra/jobs/jobs"
import { hasLeadershipMonitorStarted } from "~/infra/leadership"
import { jobsLogger as log } from "~/lib/logger"
import { sealMailFields } from "~/modules/mailbox-crypto/mail-writer"

const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

export const MAILBOX_BACKFILL_JOB_NAME = "mailbox-backfill"

/** Hourly. The work is rate limited internally, so the cadence only decides how
 *  soon a newly enrolled mailbox is picked up. */
export const MAILBOX_BACKFILL_CRON = "17 * * * *"

/** Messages per iteration, one transaction per batch: a crash loses at most one
 *  batch's work, because the cursor advances only on commit. */
export const BACKFILL_BATCH_SIZE = 200

/** One batch per second per account, so the seal cost stays off the interactive
 *  path. */
export const BACKFILL_BATCH_INTERVAL_MS = 1000

/** Consecutive batch failures before an account's backfill stops with an alert. */
export const BACKFILL_MAX_CONSECUTIVE_FAILURES = 5

/**
 * The three entity phases, in order. Messages carry the counters the UI shows;
 * conversations and drafts follow so that the purge, which NULLs their
 * plaintext too, does not leave a conversation list with no titles and a draft
 * with no body.
 *
 * Decided here rather than in the blueprint, which specifies the cursor and the
 * counters over messages only: purging conversation and draft plaintext without
 * having sealed it would destroy content, and that is not a defensible reading
 * of "seal the historical corpus".
 */
export const BACKFILL_PHASES = ["messages", "conversations", "drafts"] as const
export type BackfillPhase = (typeof BACKFILL_PHASES)[number]

export interface BackfillCursor {
  phase: BackfillPhase | "done"
  /** ISO instant of the last committed row, or null at the start of a phase. */
  createdAt: string | null
  id: string | null
}

const START_CURSOR: BackfillCursor = { phase: "messages", createdAt: null, id: null }

export interface BackfillAccountResult {
  accountId: string
  sealed: number
  batches: number
  /** True when the account reached the `done` cursor rather than stopping. */
  completed: boolean
  failures: number
}

export interface BackfillUserResult {
  userId: string
  orgId: string
  accounts: BackfillAccountResult[]
  messagesTotal: number
  messagesSealed: number
  completed: boolean
}

/** Anything that can run raw SQL under a privileged connection. */
type Executor = Pick<PrivilegedDb, "execute">

export interface BackfillDeps {
  /** Injected in tests. Defaults to a jobs-pool privileged transaction. */
  privileged?: <T>(orgId: string, reason: string, fn: (tx: Executor) => Promise<T>) => Promise<T>
  /** Injected in tests to remove the per-batch pacing. */
  batchIntervalMs?: number
  /** Injected in tests to stop the run deterministically after N batches. */
  maxBatches?: number
  batchSize?: number
}

function runPrivileged(deps: BackfillDeps) {
  return (
    deps.privileged ??
    (<T>(orgId: string, reason: string, fn: (tx: Executor) => Promise<T>) =>
      withPrivilegedDb(orgId, reason, (tx) => fn(tx as unknown as Executor), { pool: "jobs" }))
  )
}

const PHASE_TABLES: Record<BackfillPhase, { table: unknown; fields: string[] }> = {
  messages: {
    table: drizzleSql`${MAIL}.messages`,
    fields: ["subject", "text_body", "html_body", "snippet"],
  },
  conversations: { table: drizzleSql`${MAIL}.conversations`, fields: ["subject", "snippet"] },
  drafts: { table: drizzleSql`${MAIL}.drafts`, fields: ["subject", "text_body", "html_body"] },
}

interface LegacyRow {
  id: string
  created_at: string
  subject: string | null
  text_body: string | null
  html_body: string | null
  snippet: string | null
  raw_headers: Record<string, unknown> | null
}

/**
 * One batch of not-yet-sealed rows, strictly after the cursor.
 *
 * `coalesce(enc_version, 0) = 0` is the idempotency filter: a row already at
 * `enc_version = 1` is skipped, so re-running from the start of a phase writes
 * nothing over completed rows. That is what makes "restart from a stale cursor"
 * safe.
 */
async function readBatch(
  tx: Executor,
  phase: BackfillPhase,
  accountId: string,
  cursor: BackfillCursor,
  limit: number,
): Promise<LegacyRow[]> {
  const table = PHASE_TABLES[phase].table
  const columns =
    phase === "messages"
      ? drizzleSql`id::text AS id, created_at, subject, text_body, html_body, snippet, raw_headers`
      : phase === "conversations"
        ? drizzleSql`id::text AS id, created_at, subject, NULL::text AS text_body, NULL::text AS html_body, snippet, NULL::jsonb AS raw_headers`
        : drizzleSql`id::text AS id, created_at, subject, text_body, html_body, NULL::text AS snippet, NULL::jsonb AS raw_headers`
  const after =
    cursor.createdAt && cursor.id
      ? drizzleSql`AND (created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : drizzleSql``
  return extractRows<LegacyRow>(
    await tx.execute(drizzleSql`
      SELECT ${columns} FROM ${table}
       WHERE account_id = ${accountId}::uuid
         AND coalesce(enc_version, 0) = 0
         ${after}
       ORDER BY created_at ASC, id ASC
       LIMIT ${limit}`),
  )
}

/** The one place a legacy row becomes a sealed row. Writes ciphertext and key
 *  material, bumps `enc_version`, and leaves every plaintext column alone. */
async function sealRow(
  tx: Executor,
  phase: BackfillPhase,
  userId: string,
  orgId: string,
  row: LegacyRow,
  account?: { id: string; encryptionState: string },
): Promise<void> {
  const values =
    phase === "messages"
      ? {
          subject: row.subject,
          textBody: row.text_body,
          htmlBody: row.html_body,
          snippet: row.snippet,
        }
      : phase === "conversations"
        ? { subject: row.subject, snippet: row.snippet }
        : // Both bodies, each into its own sealed slot. `html_body ?? text_body`
          // was wrong twice over: drafts shipped NOT NULL DEFAULT '', so `??`
          // never fell through for a legacy row whose html_body is the empty
          // default, and `sealMailFields` reads '' as absence, so the row was
          // stamped enc_version = 1 with NOTHING sealed while the purge went on
          // to NULL the text body. A draft carrying a text AND an html
          // alternative lost whichever one was not chosen.
          { subject: row.subject, body: row.text_body, htmlBody: row.html_body }

  const sealed = await sealMailFields({
    userId,
    orgId,
    entity: phase,
    entityId: row.id,
    values,
    headers: phase === "messages" ? row.raw_headers : null,
    // A server-managed mailbox seals its legacy rows under its own key (v2).
    account,
  })
  const c = sealed.columns

  // `raw_headers` is deliberately NOT rewritten here. Reducing it to the
  // allowlist is the purge's job (step 7b), and touching it now would make the
  // Invariant P trigger's `NEW.raw_headers IS DISTINCT FROM OLD.raw_headers`
  // branch fire on a mailbox that is still legitimately half migrated.
  if (phase === "messages") {
    await tx.execute(drizzleSql`
      UPDATE ${MAIL}.messages
         SET subject_ciphertext = ${c.subjectCiphertext ?? null},
             text_body_ciphertext = ${c.textBodyCiphertext ?? null},
             html_body_ciphertext = ${c.htmlBodyCiphertext ?? null},
             snippet_ciphertext = ${c.snippetCiphertext ?? null},
             raw_headers_ciphertext = ${c.rawHeadersCiphertext ?? null},
             content_key_wrapped = ${c.contentKeyWrapped ?? null},
             content_key_epk = ${c.contentKeyEpk ?? null},
             enc_key_id = ${sealed.keyId},
             enc_version = 1
       WHERE id = ${row.id}::uuid`)
    return
  }
  if (phase === "conversations") {
    await tx.execute(drizzleSql`
      UPDATE ${MAIL}.conversations
         SET subject_ciphertext = ${c.subjectCiphertext ?? null},
             snippet_ciphertext = ${c.snippetCiphertext ?? null},
             content_key_wrapped = ${c.contentKeyWrapped ?? null},
             content_key_epk = ${c.contentKeyEpk ?? null},
             enc_key_id = ${sealed.keyId},
             enc_version = 1
       WHERE id = ${row.id}::uuid`)
    return
  }
  await tx.execute(drizzleSql`
    UPDATE ${MAIL}.drafts
       SET subject_ciphertext = ${c.subjectCiphertext ?? null},
           body_ciphertext = ${c.bodyCiphertext ?? null},
           html_body_ciphertext = ${c.htmlBodyCiphertext ?? null},
           content_key_wrapped = ${c.contentKeyWrapped ?? null},
           content_key_epk = ${c.contentKeyEpk ?? null},
           enc_key_id = ${sealed.keyId},
           enc_version = 1
     WHERE id = ${row.id}::uuid`)
}

function nextPhase(phase: BackfillPhase): BackfillPhase | "done" {
  const index = BACKFILL_PHASES.indexOf(phase)
  return (BACKFILL_PHASES[index + 1] as BackfillPhase | undefined) ?? "done"
}

async function readCursor(
  run: ReturnType<typeof runPrivileged>,
  orgId: string,
  userId: string,
  accountId: string,
): Promise<BackfillCursor> {
  const rows = await run(orgId, "mailbox-backfill:cursor", async (tx) =>
    extractRows<{ backfill_cursor: Record<string, unknown> | null }>(
      await tx.execute(drizzleSql`
        SELECT backfill_cursor FROM ${K}.mailbox_migration_state
         WHERE user_id = ${userId}::uuid`),
    ),
  )
  const stored = rows[0]?.backfill_cursor as Record<string, BackfillCursor> | null
  const mine = stored?.[accountId]
  if (
    mine &&
    typeof mine === "object" &&
    (mine.phase === "done" || BACKFILL_PHASES.includes(mine.phase as BackfillPhase))
  ) {
    return { phase: mine.phase, createdAt: mine.createdAt ?? null, id: mine.id ?? null }
  }
  return { ...START_CURSOR }
}

/** Persist the cursor keyed by account, so a user with two personal mailboxes
 *  resumes each independently. */
async function writeCursor(
  tx: Executor,
  userId: string,
  orgId: string,
  accountId: string,
  cursor: BackfillCursor,
): Promise<void> {
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.mailbox_migration_state (user_id, org_id, backfill_cursor, backfill_started_at)
    VALUES (${userId}::uuid, ${orgId}::uuid,
            jsonb_build_object(${accountId}::text, ${JSON.stringify(cursor)}::jsonb), now())
    ON CONFLICT (user_id) DO UPDATE
      SET backfill_cursor =
            coalesce(${K}.mailbox_migration_state.backfill_cursor, '{}'::jsonb)
            || jsonb_build_object(${accountId}::text, ${JSON.stringify(cursor)}::jsonb),
          backfill_started_at = coalesce(${K}.mailbox_migration_state.backfill_started_at, now())`)
}

/** Seal one account, resuming from its stored cursor. */
export async function runMailboxBackfillForAccount(
  userId: string,
  orgId: string,
  accountId: string,
  deps: BackfillDeps = {},
): Promise<BackfillAccountResult> {
  const run = runPrivileged(deps)
  const batchSize = deps.batchSize ?? BACKFILL_BATCH_SIZE
  const intervalMs = deps.batchIntervalMs ?? BACKFILL_BATCH_INTERVAL_MS
  let cursor = await readCursor(run, orgId, userId, accountId)
  let sealed = 0
  let batches = 0
  let failures = 0

  while (cursor.phase !== "done") {
    if (deps.maxBatches !== undefined && batches >= deps.maxBatches) {
      return { accountId, sealed, batches, completed: false, failures }
    }
    const phase = cursor.phase
    try {
      const advanced = await run(orgId, `mailbox-backfill:${phase}`, async (tx) => {
        const rows = await readBatch(tx, phase, accountId, cursor, batchSize)
        if (rows.length === 0) {
          const moved: BackfillCursor = { phase: nextPhase(phase), createdAt: null, id: null }
          await writeCursor(tx, userId, orgId, accountId, moved)
          return { moved, count: 0 }
        }
        const state = extractRows<{ encryption_state: string | null }>(
          await tx.execute(drizzleSql`
            SELECT encryption_state FROM ${MAIL}.accounts WHERE id = ${accountId}::uuid`),
        )[0]?.encryption_state
        const account = { id: accountId, encryptionState: state ?? "none" }
        for (const row of rows) {
          await sealRow(tx, phase, userId, orgId, row, account)
        }
        const last = rows[rows.length - 1] as LegacyRow
        const moved: BackfillCursor = {
          phase,
          createdAt: new Date(last.created_at).toISOString(),
          id: last.id,
        }
        await writeCursor(tx, userId, orgId, accountId, moved)
        return { moved, count: rows.length }
      })
      cursor = advanced.moved
      sealed += advanced.count
      if (advanced.count > 0) batches++
      failures = 0
    } catch (err) {
      failures++
      // The message id, never the blob. A logged ciphertext is not a leak but it
      // is noise that makes a real incident unreadable.
      log.error(
        { err, userId, accountId, phase, cursorId: cursor.id, failures },
        "mailbox backfill batch failed",
      )
      if (failures >= BACKFILL_MAX_CONSECUTIVE_FAILURES) {
        log.error(
          { userId, accountId, phase, failures },
          "mailbox backfill STOPPED for this account after consecutive failures",
        )
        return { accountId, sealed, batches, completed: false, failures }
      }
    }
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { accountId, sealed, batches, completed: true, failures }
}

async function personalAccounts(
  run: ReturnType<typeof runPrivileged>,
  orgId: string,
  userId: string,
): Promise<string[]> {
  const rows = await run(orgId, "mailbox-backfill:accounts", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${MAIL}.accounts
         WHERE org_id = ${orgId}::uuid AND owner_type = 'user' AND owner_id = ${userId}::uuid
         ORDER BY created_at ASC, id ASC`),
    ),
  )
  return rows.map((r) => r.id)
}

/** `messages_total` and `messages_sealed`, which drive the UI progress bar. */
async function refreshCounters(
  run: ReturnType<typeof runPrivileged>,
  orgId: string,
  userId: string,
  completed: boolean,
): Promise<{ total: number; sealed: number }> {
  return run(orgId, "mailbox-backfill:counters", async (tx) => {
    const rows = extractRows<{ total: number; sealed: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE coalesce(m.enc_version, 0) > 0)::int AS sealed
          FROM ${MAIL}.messages m
          JOIN ${MAIL}.accounts a ON a.id = m.account_id
         WHERE a.org_id = ${orgId}::uuid AND a.owner_type = 'user'
           AND a.owner_id = ${userId}::uuid`),
    )
    const counts = rows[0] ?? { total: 0, sealed: 0 }
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.mailbox_migration_state
        (user_id, org_id, messages_total, messages_sealed, backfill_completed_at)
      VALUES (${userId}::uuid, ${orgId}::uuid, ${counts.total}, ${counts.sealed},
              ${completed ? drizzleSql`now()` : drizzleSql`NULL`})
      ON CONFLICT (user_id) DO UPDATE
        SET messages_total = EXCLUDED.messages_total,
            messages_sealed = EXCLUDED.messages_sealed,
            backfill_completed_at = ${completed ? drizzleSql`now()` : drizzleSql`${K}.mailbox_migration_state.backfill_completed_at`}`)
    return counts
  })
}

/** Seal every personal mailbox of one enrolled user. Idempotent and resumable. */
export async function runMailboxBackfillForUser(
  userId: string,
  orgId: string,
  deps: BackfillDeps = {},
): Promise<BackfillUserResult> {
  const run = runPrivileged(deps)
  const accounts = await personalAccounts(run, orgId, userId)
  const results: BackfillAccountResult[] = []
  for (const accountId of accounts) {
    results.push(await runMailboxBackfillForAccount(userId, orgId, accountId, deps))
  }
  // An enrolled user with NO personal mail account is COMPLETE, not incomplete.
  // Requiring at least one account left `backfill_completed_at` NULL forever for
  // such a user, so `usersNeedingBackfill` re-selected them on every hourly
  // sweep and the enrollment UI never reached done. There is nothing to seal.
  const completed = results.every((r) => r.completed)
  const counts = await refreshCounters(run, orgId, userId, completed)
  return {
    userId,
    orgId,
    accounts: results,
    messagesTotal: counts.total,
    messagesSealed: counts.sealed,
    completed,
  }
}

/** Every enrolled user whose backfill has not finished. */
export async function usersNeedingBackfill(
  deps: BackfillDeps = {},
): Promise<Array<{ userId: string; orgId: string }>> {
  const run = runPrivileged(deps)
  return run("00000000-0000-0000-0000-000000000000", "mailbox-backfill:scan", async (tx) =>
    extractRows<{ user_id: string; org_id: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT i.user_id::text AS user_id, i.org_id::text AS org_id
          FROM ${K}.user_mailbox_identities i
          LEFT JOIN ${K}.mailbox_migration_state s ON s.user_id = i.user_id
         WHERE i.status = 'active'
           AND s.backfill_completed_at IS NULL`),
    ).map((r) => ({ userId: r.user_id, orgId: r.org_id })),
  )
}

export async function runMailboxBackfillSweep(deps: BackfillDeps = {}): Promise<void> {
  const users = await usersNeedingBackfill(deps)
  for (const user of users) {
    try {
      const result = await runMailboxBackfillForUser(user.userId, user.orgId, deps)
      log.info(
        {
          userId: user.userId,
          messagesTotal: result.messagesTotal,
          messagesSealed: result.messagesSealed,
          completed: result.completed,
        },
        "mailbox backfill pass finished",
      )
    } catch (err) {
      log.error({ err, userId: user.userId }, "mailbox backfill pass failed")
    }
  }
}

export interface BackfillRegistrationDeps {
  registerScheduled?: (
    appName: string,
    jobName: string,
    cron: string,
    handler: (payload: unknown) => Promise<void>,
  ) => Promise<string>
  registerWorker?: (
    appName: string,
    jobName: string,
    handler: (payload: unknown) => Promise<void>,
  ) => void
}

/**
 * The purge is ADMIN INVOKED, never scheduled. It is registered here, on the
 * same leader-gated site as the backfill and behind the same boot assertion,
 * because a destructive job must not be able to fire on a node with no
 * leadership state. There is deliberately no cron: someone has to ask for it,
 * per user, and the job still refuses without a valid acknowledgement.
 */
export const MAILBOX_PURGE_JOB_NAME = "mailbox-purge"

/**
 * Register the backfill worker. Call this from `index.ts` ONLY, immediately
 * after `startLeadership(...)`.
 *
 * Throws when this process never started leadership (the leadership monitor).
 * See the header: the throw keeps the job off any entrypoint that has no jobs
 * gate and no leader lease.
 */
export async function registerMailboxBackfillWorker(
  deps: BackfillRegistrationDeps = {},
): Promise<void> {
  if (!hasLeadershipMonitorStarted()) {
    throw new Error(
      "registerMailboxBackfillWorker called in a process that never started the leadership monitor " +
        "(startLeadership()): this process has no jobs gate and no leader lease, so the backfill " +
        "would not run under the singleton gate. Register it from index.ts, immediately after startLeadership().",
    )
  }
  const register = deps.registerScheduled ?? registerScheduledJob
  await register("kernel", MAILBOX_BACKFILL_JOB_NAME, MAILBOX_BACKFILL_CRON, async () =>
    runMailboxBackfillSweep(),
  )

  const registerWorker = deps.registerWorker ?? registerJobWorker
  registerWorker("kernel", MAILBOX_PURGE_JOB_NAME, async (payload: unknown) => {
    const { userId, orgId } = (payload ?? {}) as { userId?: string; orgId?: string }
    if (!userId || !orgId) {
      throw new Error("mailbox-purge requires an explicit userId and orgId: it is per user")
    }
    // Imported lazily so the destructive module is not in the boot import graph.
    const { purgeMailboxPlaintext } = await import("~/modules/mailbox-crypto/purge")
    const result = await purgeMailboxPlaintext(userId, orgId)
    log.warn({ ...result }, "admin invoked mailbox purge finished")
  })
}
