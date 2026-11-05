// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the target does for a moved org once the move committed and the org
// serves from here, outside the write gap (plans R1.1 step 4, R1.7):
//   - jobs and schedulers carried from the source are re-added, each once
//     (ids derived from the transfer, each marked as it is added);
//   - MCP connections: their tokens are signed with the source's JWT_SECRET,
//     which stays on the source (D36), so every carried connection of the org
//     is revoked and the org's admins get ONE attention item saying to reconnect;
//   - Gmail: the mailboxes are watched again with THIS instance's Pub/Sub topic
//     and synced from the historyId stored at the freeze (P4P-11). Strictly
//     after the commit: a watch made earlier would move push delivery away
//     from the source while it still serves the org.
// Each step is independent: one failing is reported and logged, never undoes
// the move (the org is live here already).
import { createHash } from "node:crypto"
import { sql as dsql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  enqueueAppJobForServer,
  readdOrgJobs,
  type TransferredJob,
  type TransferredScheduler,
} from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { resultRows } from "~/modules/org/purge/rows"
import { setAfterCommitResume } from "~/modules/org/transfer-state/resolver"
import { orgTransferStateOf } from "~/modules/org/transfer-state/state"

const log = rootLogger.child({ module: "org-transfer-after-commit" })
/** The kernel schema as this process names it (a test lane prefixes it). */
const K = () => dsql.raw(schemaRef("kernel"))

export interface AfterCommitInput {
  orgId: string
  transferId: string
  jobs: TransferredJob[]
  schedulers: TransferredScheduler[]
}

type Skipped = { skipped: true }

export interface AfterCommitReport {
  jobs: { jobs: number; schedulers: number } | Skipped | { error: string }
  mcp: { revoked: number; attention: boolean } | Skipped | { error: string }
  gmail: { accounts: number; rewatch: boolean } | Skipped | { error: string }
}

function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Revoke the org's live MCP connections and tell its admins once. */
export async function markMcpReconnectNeeded(
  orgId: string,
  transferId: string,
  /**
   * The carried connections (read on the target before the commit). Only these
   * are revoked: one made here after the commit is signed by this instance.
   * Null: every live one of the org (nothing was staged).
   */
  carriedIds: readonly string[] | null = null,
): Promise<{ revoked: number; attention: boolean }> {
  if (carriedIds !== null && carriedIds.length === 0) return { revoked: 0, attention: false }
  return withSystemDb("org-transfer-mcp-reconnect", async (db) => {
    const only =
      carriedIds === null ? dsql`` : dsql` AND id = ANY(${`{${carriedIds.join(",")}}`}::uuid[])`
    const rows = resultRows<{ id: string }>(
      await db.execute(
        dsql`UPDATE ${K()}.mcp_connections SET revoked_at = now()
              WHERE org_id = ${orgId}::uuid AND revoked_at IS NULL${only} RETURNING id::text`,
      ),
    )
    if (rows.length === 0) return { revoked: 0, attention: false }
    await db.queueEvent({
      app: "kernel",
      entity: "org_move",
      action: "reconnect",
      entityId: uuidFrom(`${orgId}|${transferId}|mcp-reconnect`),
      orgId,
      actorType: "system",
      actorId: null,
      timestamp: new Date().toISOString(),
      data: {
        summary: `Your workspace moved to a new server. ${rows.length} MCP connection(s) must be connected again from their client.`,
        connections: rows.length,
        settingsRoute: "/settings/mcp",
      },
    })
    return { revoked: rows.length, attention: true }
  })
}

/** The org's Gmail mailboxes here (the mail app's accounts), or none without the app. */
async function gmailAccounts(orgId: string): Promise<string[]> {
  return withSystemDb("org-transfer-gmail-accounts", async (db) => {
    const exists = resultRows<{ t: string | null }>(
      await db.execute(dsql`SELECT to_regclass('app_mail.accounts')::text AS t`),
    )[0]
    if (!exists?.t) return []
    return resultRows<{ id: string }>(
      await db.execute(
        dsql`SELECT id::text FROM app_mail.accounts
              WHERE org_id = ${orgId}::uuid AND provider = 'gmail'`,
      ),
    ).map((r) => r.id)
  })
}

/** Watch the org's Gmail mailboxes with this instance's topic and sync each from its historyId. */
export async function rewatchGmail(
  orgId: string,
  transferId: string,
): Promise<{ accounts: number; rewatch: boolean }> {
  const accounts = await gmailAccounts(orgId)
  if (accounts.length === 0) return { accounts: 0, rewatch: false }
  await enqueueAppJobForServer(
    "mail",
    "gmail-watch-renewal",
    { orgId },
    { jobId: `xfer-rewatch-${transferId}` },
  )
  for (const accountId of accounts) {
    await enqueueAppJobForServer(
      "mail",
      "gmail-incremental-sync",
      { orgId, accountId },
      { jobId: `xfer-sync-${transferId}-${accountId}` },
    )
  }
  return { accounts: accounts.length, rewatch: true }
}

async function step<T>(name: string, ctx: Record<string, unknown>, fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    log.error({ err, ...ctx, step: name }, `org transfer after commit: ${name} failed`)
    return { error: String((err as Error)?.message ?? err) }
  }
}

// The carried jobs and schedulers exist only in the source agent's memory, so
// they are staged on the target, in its Redis, before the commit. An
// after-commit that never ran or did not finish (the source agent died after
// the commit, or a step failed) is then resumed from here by the freeze
// resolver once the control plane says the move committed.
//
// A resume runs only what did not happen yet: each step is marked done as it
// succeeds, and each carried job and scheduler as it is added. A job that ran
// and was evicted is never added again, a scheduler an admin deleted after
// the commit stays deleted, and only the connections carried by the move are
// revoked (never one made here after the commit).
const CARRY_INDEX = "org-transfer:carry:index"
const carryKey = (transferId: string) => `org-transfer:carry:${transferId}`
const stepsKey = (transferId: string) => `org-transfer:carry:${transferId}:steps`
const addedKey = (transferId: string) => `org-transfer:carry:${transferId}:added`
type StepName = "jobs" | "mcp" | "gmail"
const CARRY_TTL_S = 14 * 24 * 3600
/** A staged set is resumed only this long after it was staged (the source normally finishes first). */
export const RESUME_AFTER_MS = 120_000
/** Resume attempts before the alert (a step that keeps failing is not retried forever). */
export const RESUME_MAX_ATTEMPTS = 5

interface StagedCarry {
  orgId: string
  transferId: string
  jobs: TransferredJob[]
  schedulers: TransferredScheduler[]
  /** The org's live MCP connections when staged: all carried from the source. */
  mcpIds?: string[]
  stagedAt: number
  attempts: number
  done: boolean
}

/** The org's live MCP connections here (before the commit: the carried ones). */
async function liveMcpConnectionIds(orgId: string): Promise<string[]> {
  return withSystemDb("org-transfer-mcp-carried", async (db) =>
    resultRows<{ id: string }>(
      await db.execute(
        dsql`SELECT id::text FROM ${K()}.mcp_connections
              WHERE org_id = ${orgId}::uuid AND revoked_at IS NULL`,
      ),
    ).map((r) => r.id),
  )
}

/** Target, before the commit (the org still incoming): keep what the after-commit steps need. */
export async function stageCarry(input: AfterCommitInput): Promise<void> {
  const staged: StagedCarry = {
    ...input,
    mcpIds: await liveMcpConnectionIds(input.orgId),
    stagedAt: Date.now(),
    attempts: 0,
    done: false,
  }
  await redis.del(stepsKey(input.transferId), addedKey(input.transferId))
  await redis.set(carryKey(input.transferId), JSON.stringify(staged), "EX", CARRY_TTL_S)
  await redis.sadd(CARRY_INDEX, input.transferId)
}

async function stepsDone(transferId: string): Promise<Set<StepName>> {
  return new Set((await redis.smembers(stepsKey(transferId))) as StepName[])
}

async function markStepDone(transferId: string, name: StepName): Promise<void> {
  await redis.sadd(stepsKey(transferId), name)
  await redis.expire(stepsKey(transferId), CARRY_TTL_S)
}

export async function readStagedCarry(transferId: string): Promise<StagedCarry | null> {
  const raw = await redis.get(carryKey(transferId))
  return raw === null ? null : (JSON.parse(raw) as StagedCarry)
}

async function writeStaged(staged: StagedCarry): Promise<void> {
  await redis.set(carryKey(staged.transferId), JSON.stringify(staged), "EX", CARRY_TTL_S)
}

async function noteAfterCommit(
  transferId: string,
  report: AfterCommitReport,
  attempt: boolean,
): Promise<void> {
  const staged = await readStagedCarry(transferId)
  if (!staged) return
  const failed = [report.jobs, report.mcp, report.gmail].some((r) => "error" in r)
  staged.done = !failed
  if (attempt) staged.attempts++
  await writeStaged(staged)
  if (staged.done) await redis.srem(CARRY_INDEX, transferId)
}

export interface ResumeDeps {
  /** The control plane's state of the move; throws when it cannot be asked. */
  askControl: (orgId: string, transferId: string) => Promise<string>
  now: () => number
}

/**
 * Run the after-commit steps of every staged move whose control-plane state is
 * committed, the org serves from here and the steps never finished. A move the
 * control plane aborted drops its staged set. Never throws per move.
 */
export async function resumeStagedAfterCommit(deps: ResumeDeps): Promise<string[]> {
  const resumed: string[] = []
  for (const transferId of await redis.smembers(CARRY_INDEX)) {
    try {
      const staged = await readStagedCarry(transferId)
      if (!staged || staged.done) {
        await redis.srem(CARRY_INDEX, transferId)
        continue
      }
      if (deps.now() - staged.stagedAt < RESUME_AFTER_MS) continue
      if (staged.attempts >= RESUME_MAX_ATTEMPTS) continue
      const decided = await deps.askControl(staged.orgId, transferId)
      if (decided === "aborted" || decided === "failed") {
        await redis.del(carryKey(transferId), stepsKey(transferId), addedKey(transferId))
        await redis.srem(CARRY_INDEX, transferId)
        continue
      }
      if (decided !== "committed" && decided !== "finalized") continue
      // Served here: the org's move state is clear (the resolver or the
      // source's activation cleared it).
      if ((await orgTransferStateOf(staged.orgId)) !== null) continue
      log.warn(
        { orgId: staged.orgId, transferId },
        "org transfer: resuming the after-commit steps the source did not finish",
      )
      await runAfterCommit(
        { orgId: staged.orgId, transferId, jobs: staged.jobs, schedulers: staged.schedulers },
        { resume: true },
      )
      resumed.push(transferId)
      if (
        staged.attempts + 1 >= RESUME_MAX_ATTEMPTS &&
        !(await readStagedCarry(transferId))?.done
      ) {
        log.error(
          { alert: "org_move_after_commit_incomplete", orgId: staged.orgId, transferId },
          "org moved, but its after-commit steps keep failing; they are no longer retried",
        )
      }
    } catch (err) {
      log.warn({ err, transferId }, "resuming a staged org move failed; retried on the next pass")
    }
  }
  return resumed
}

/** Wire the freeze resolver to resume unfinished after-commit steps. */
export function wireAfterCommitResume(): void {
  setAfterCommitResume(async (askControl) => {
    await resumeStagedAfterCommit({ askControl, now: Date.now })
  })
}

export interface AfterCommitSteps {
  rewatchGmail: typeof rewatchGmail
}

/**
 * Every after-commit step not done yet, in order; only ever called once the
 * control plane committed. A step done by an earlier run reports `skipped`.
 */
export async function runAfterCommit(
  input: AfterCommitInput,
  opts: { resume?: boolean; steps?: Partial<AfterCommitSteps> } = {},
): Promise<AfterCommitReport> {
  const ctx = { orgId: input.orgId, transferId: input.transferId }
  const { transferId } = input
  const staged = await readStagedCarry(transferId)
  const done = staged ? await stepsDone(transferId) : new Set<StepName>()
  const run = async <T>(name: StepName, fn: () => Promise<T>) => {
    if (done.has(name)) return { skipped: true as const }
    const r = await step(name, ctx, fn)
    if (staged && !(r && typeof r === "object" && "error" in r)) {
      await markStepDone(transferId, name).catch((err) =>
        log.warn({ err, ...ctx, step: name }, "org transfer: marking an after-commit step failed"),
      )
    }
    return r
  }
  const jobs = await run("jobs", async () => {
    const added = staged ? new Set(await redis.smembers(addedKey(transferId))) : new Set<string>()
    return readdOrgJobs(
      transferId,
      { jobs: input.jobs, schedulers: input.schedulers },
      staged
        ? {
            added,
            onAdded: async (keys) => {
              await redis.sadd(addedKey(transferId), ...keys)
              await redis.expire(addedKey(transferId), CARRY_TTL_S)
            },
          }
        : {},
    )
  })
  const mcp = await run("mcp", () =>
    markMcpReconnectNeeded(input.orgId, transferId, staged?.mcpIds ?? null),
  )
  const gmail = await run("gmail", () =>
    (opts.steps?.rewatchGmail ?? rewatchGmail)(input.orgId, transferId),
  )
  log.info({ ...ctx, jobs, mcp, gmail }, "org transfer: after-commit steps done")
  const report = { jobs, mcp, gmail }
  await noteAfterCommit(input.transferId, report, opts.resume === true).catch((err) =>
    log.warn({ err, ...ctx }, "org transfer: noting the after-commit result failed"),
  )
  return report
}

/** A control-plane message of the org the source had not delivered at the commit. */
export interface CarriedMessage {
  type: string
  messageId: string
  data: Record<string, unknown>
}

/**
 * Target: queue the source's undelivered control-plane messages of the org in
 * this instance's outbox (P4P-15), with their message ids, so the control plane
 * deduplicates one the source delivered after all. Only the org's messages.
 */
export async function adoptOutboxMessages(
  orgId: string,
  messages: readonly CarriedMessage[],
): Promise<{ adopted: number }> {
  let adopted = 0
  await withSystemDb("org-transfer-adopt-outbox", async (db) => {
    for (const m of messages) {
      if (m.data?.orgId !== orgId)
        throw new Error("org transfer: a control-plane message of another org")
      const rows = resultRows<{ id: string }>(
        await db.execute(
          dsql`INSERT INTO ${K()}.control_plane_outbox (type, message_id, data)
                VALUES (${m.type}, ${m.messageId}::uuid, ${JSON.stringify(m.data)}::jsonb)
                ON CONFLICT (message_id) DO NOTHING RETURNING id::text`,
        ),
      )
      adopted += rows.length
    }
  })
  return { adopted }
}

/** Source: the org's control-plane messages still pending here (not claimed by a sender). */
export async function pendingOutboxMessages(
  orgId: string,
): Promise<Array<CarriedMessage & { id: string }>> {
  return withSystemDb("org-transfer-pending-outbox", async (db) =>
    resultRows<{ id: string; type: string; message_id: string; data: Record<string, unknown> }>(
      await db.execute(
        dsql`SELECT id::text, type, message_id::text, data FROM ${K()}.control_plane_outbox
              WHERE status = 'pending' AND data->>'orgId' = ${orgId} ORDER BY created_at`,
      ),
    ).map((r) => ({ id: r.id, type: r.type, messageId: r.message_id, data: r.data })),
  )
}

/** Source: the carried messages are the target's to send now; still-pending ones here are cancelled. */
export async function cancelCarriedOutbox(
  ids: readonly string[],
  transferId: string,
): Promise<number> {
  if (ids.length === 0) return 0
  return withSystemDb("org-transfer-cancel-outbox", async (db) => {
    const rows = resultRows<{ id: string }>(
      await db.execute(
        dsql`UPDATE ${K()}.control_plane_outbox
                SET status = 'cancelled', last_error = ${`carried to the target by transfer ${transferId}`},
                    updated_at = now()
              WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND status = 'pending' RETURNING id::text`,
      ),
    )
    return rows.length
  })
}
