// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client job drainer (spec section 5.3c, blueprint task 11.3).
//
// Headless work that used to read message bodies now waits here. A server-side
// trigger writes an envelope-only row; this module claims it when the tab is
// open and the mailbox is unlocked, decrypts the ids it names IN THE CRYPTO
// WORKER, and feeds that plaintext into a normal SERVER-SIDE agent turn.
//
// THE BROWSER NEVER RUNS AN AGENT TURN. There is no client sandbox, and
// building one would put arbitrary app and routine code in the user's tab with
// no isolation model and no way to reach server-credentialed tools (spec 2.3,
// 5.3c, 15 A3). The tab's entire job is to supply plaintext to a turn that runs
// where every other turn runs, in memory, redacted at persist.
//
// Four failure modes shape everything below, and each one has a test:
//
//   * The tab can close mid-drain. The lease is what makes that safe, so the
//     drainer re-checks its lease before it posts anything and drops the result
//     rather than overwriting work another device may have redone since.
//   * Two devices can be unlocked at once. The claim is single winner on the
//     server; a 409 here is normal, not an error, and the drain moves on.
//   * The mailbox can lock between jobs. The drain stops where it is.
//   * A job can lapse. `expired` and `failed` jobs are surfaced through
//     `needsAttention()` and never retried, because a job the user asked for
//     and never heard about again is the one outcome this queue may not have.

import type { OpenedMessage } from "~/modules/mailbox/crypto-protocol"
import type { MailboxApi } from "~/modules/mailbox/mailbox-api"

export type ClientJobStatus = "pending" | "claimed" | "done" | "failed" | "expired"

/** The row as the REST surface projects it. `payload` is envelope only: ids,
 *  correspondents, labels, filenames, dates. Never a subject, never a body. */
export interface ClientJobView {
  id: string
  kind: string
  status: ClientJobStatus
  accountId: string | null
  payload: Record<string, unknown>
  attempts: number
  claimedBySession: string | null
  claimedAt: string | null
  leaseExpiresAt: string | null
  expiresAt: string | null
  completedAt: string | null
  createdAt: string
  hasResult: boolean
}

/** One decrypted message, as it goes to the server-side turn and nowhere else. */
export type JobPlaintext = OpenedMessage

/**
 * How the drainer runs a turn.
 *
 * The drainer does not talk to `/api/agent/chat` itself. It hands the turn to
 * this runner, which drives the two-phase decrypt protocol: submit the turn with
 * a fresh `turnNonce`, answer the turn's decrypt request with the plaintext
 * carried here, and return the turn's text result. There is no DEFAULT runner on
 * purpose: a stand-in that posted plaintext in the prompt would be a different,
 * worse mechanism wearing this one's name. `MailboxJobsHost` supplies the real
 * one from `mailboxAgentRuntime()`.
 */
export interface AgentTurnRequest {
  jobId: string
  kind: string
  /** Built from envelope fields only. The plaintext travels separately. */
  prompt: string
  /** Fresh per job. The server refuses a decrypt request whose nonce does not
   *  match a turn this client started and still has open. */
  turnNonce: string
  messageIds: string[]
  plaintext: JobPlaintext[]
}

export type AgentTurnRunner = (request: AgentTurnRequest) => Promise<{ text: string }>

export interface ClientJobDrainerDeps {
  api: MailboxApi
  /** Opaque per-tab id. It identifies a lease holder, never an identity. */
  sessionId: string
  isUnlocked: () => boolean
  /** Fetch the sealed rows this job names and open them in the crypto worker.
   *  It takes the whole job because the envelope carries the conversation the
   *  ids belong to, which is how they are fetched. */
  openMessages: (job: ClientJobView) => Promise<JobPlaintext[]>
  /**
   * Optional. A drainer with no runner LISTS the queue for the badge and claims
   * nothing: claiming a job it cannot run would burn an attempt and, three times
   * over, mark real work failed for no reason.
   */
  runAgentTurn?: AgentTurnRunner
  /** Seal the turn's result to the user's own key. Production wires this to the
   *  crypto worker's D7 shard seal under the shard id `client-job:<jobId>`, so
   *  no key material reaches the server with the result. */
  sealResult: (jobId: string, plaintext: string) => Promise<string>
  now?: () => number
  onJobsChanged?: (jobs: ClientJobView[]) => void
  logWarn?: (message: string, data?: Record<string, unknown>) => void
}

/** Poll cadence while a tab is open and unlocked. The wake event covers the
 *  gap; this is the floor, not the mechanism. */
export const DRAIN_POLL_INTERVAL_MS = 60_000

/** The wake event a server-side enqueue broadcasts. Matched by the host that
 *  owns the drainer, so a wake is one immediate drain rather than a poll. */
export const MAILBOX_JOBS_WAKE = {
  app: "kernel",
  entity: "mailbox_jobs",
  action: "pending",
} as const

/** Stop working with this much of the lease left, rather than racing the clock
 *  into a post the server will refuse anyway. */
const LEASE_SAFETY_MARGIN_MS = 5_000

export interface DrainSummary {
  locked: boolean
  drained: number
  skipped: number
  failed: number
  leaseLost: number
  stoppedBecauseLocked: boolean
  /** True when this build has no turn runner, so the queue was listed only. */
  noRunner: boolean
}

function emptySummary(locked: boolean): DrainSummary {
  return {
    locked,
    drained: 0,
    skipped: 0,
    failed: 0,
    leaseLost: 0,
    stoppedBecauseLocked: false,
    noRunner: false,
  }
}

function messageIdsOf(job: ClientJobView): string[] {
  const ids = job.payload?.messageIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === "string")
}

/**
 * The instruction the server-side turn runs, built from ENVELOPE fields only.
 *
 * The plaintext never travels in the prompt: it is answered into the turn's own
 * decrypt request, which is what keeps it out of every place a prompt is
 * persisted (thread messages, tool results, audit).
 */
export function buildJobPrompt(job: ClientJobView): string {
  const payload = job.payload ?? {}
  const ids = messageIdsOf(job)
  const lines = [
    `Run the queued mailbox job "${job.kind}".`,
    `Messages: ${ids.join(", ") || "none named"}.`,
  ]
  const from = payload.fromEmail
  if (typeof from === "string" && from) lines.push(`From: ${from}.`)
  const labels = payload.labels
  if (Array.isArray(labels) && labels.length > 0) lines.push(`Labels: ${labels.join(", ")}.`)
  const filenames = payload.attachmentFilenames
  if (Array.isArray(filenames) && filenames.length > 0) {
    lines.push(`Attachments: ${filenames.join(", ")}.`)
  }
  lines.push(
    "The message text is supplied to this turn separately and must not be repeated back verbatim.",
  )
  return lines.join("\n")
}

export interface ClientJobDrainer {
  start(): void
  stop(): void
  /** Immediate drain, for the wake event and the manual "run now" control. */
  wake(): Promise<DrainSummary>
  drainOnce(): Promise<DrainSummary>
  /** Everything the last listing returned, for the pending-jobs badge. */
  jobs(): ClientJobView[]
  pendingCount(): number
  /** Jobs that stopped without running: the user has to be told. */
  needsAttention(): ClientJobView[]
}

export function createClientJobDrainer(deps: ClientJobDrainerDeps): ClientJobDrainer {
  const now = deps.now ?? (() => Date.now())
  const warn = deps.logWarn ?? (() => {})
  let known: ClientJobView[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<DrainSummary> | null = null

  function publish(jobs: ClientJobView[]): void {
    known = jobs
    deps.onJobsChanged?.(jobs)
  }

  async function list(): Promise<ClientJobView[]> {
    const jobs = await deps.api.get<ClientJobView[]>("/mailbox/client-jobs")
    const rows = Array.isArray(jobs) ? jobs : []
    publish(rows)
    return rows
  }

  function leaseHeld(leaseExpiresAt: string | null): boolean {
    if (!leaseExpiresAt) return false
    return Date.parse(leaseExpiresAt) - LEASE_SAFETY_MARGIN_MS > now()
  }

  async function runJob(
    job: ClientJobView,
    runAgentTurn: AgentTurnRunner,
    summary: DrainSummary,
  ): Promise<void> {
    let claim: ClientJobView
    try {
      claim = await deps.api.post<ClientJobView>(`/mailbox/client-jobs/${job.id}/claim`, {
        sessionId: deps.sessionId,
      })
    } catch {
      // Another device won the claim, or the job moved on. Both are normal.
      summary.skipped++
      return
    }

    const ids = messageIdsOf(job)
    let plaintext: JobPlaintext[]
    try {
      plaintext = ids.length > 0 ? await deps.openMessages(job) : []
    } catch {
      // A decrypt that failed is a mailbox problem, not a job result. Leave the
      // lease to expire so the job comes back rather than burning a status.
      warn("mailbox client job could not decrypt its messages", { jobId: job.id })
      summary.skipped++
      return
    }

    let result: { text: string }
    try {
      result = await runAgentTurn({
        jobId: job.id,
        kind: job.kind,
        prompt: buildJobPrompt(job),
        turnNonce: crypto.randomUUID(),
        messageIds: ids,
        plaintext,
      })
    } catch {
      // Deliberately no reason string. A message written by a tab that has just
      // decrypted a mailbox is exactly the shape of an accidental leak back
      // into the control plane.
      if (leaseHeld(claim.leaseExpiresAt)) {
        await deps.api
          .post(`/mailbox/client-jobs/${job.id}`, {
            sessionId: deps.sessionId,
            status: "failed",
          })
          .catch(() => {})
      }
      summary.failed++
      return
    }

    // The lease is re-checked HERE, after the turn, because that is where the
    // time went. Posting a result on a lease we no longer hold would overwrite
    // whatever the device that reclaimed the job has since done.
    if (!leaseHeld(claim.leaseExpiresAt)) {
      warn("mailbox client job lost its lease before the result was posted", { jobId: job.id })
      summary.leaseLost++
      return
    }

    const resultCiphertext = await deps.sealResult(job.id, result.text)
    await deps.api.post(`/mailbox/client-jobs/${job.id}`, {
      sessionId: deps.sessionId,
      status: "done",
      resultCiphertext,
    })
    summary.drained++
  }

  async function drain(): Promise<DrainSummary> {
    if (!deps.isUnlocked()) return emptySummary(true)
    const summary = emptySummary(false)
    const jobs = await list()
    const runAgentTurn = deps.runAgentTurn
    if (!runAgentTurn) {
      // Surface the queue, claim nothing. See `runAgentTurn` on the deps.
      summary.noRunner = true
      summary.skipped = jobs.filter((job) => job.status === "pending").length
      return summary
    }
    for (const job of jobs) {
      if (job.status !== "pending") continue
      if (!deps.isUnlocked()) {
        summary.stoppedBecauseLocked = true
        break
      }
      await runJob(job, runAgentTurn, summary)
    }
    return summary
  }

  async function drainOnce(): Promise<DrainSummary> {
    // One drain at a time. A poll landing on top of a wake would otherwise
    // double-claim the same queue from the same tab.
    if (inFlight) return inFlight
    const running = drain().finally(() => {
      inFlight = null
    })
    inFlight = running
    return running
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        void drainOnce().catch((error) => warn("mailbox client job poll failed", { error }))
      }, DRAIN_POLL_INTERVAL_MS)
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    wake: drainOnce,
    drainOnce,
    jobs: () => known,
    pendingCount: () => known.filter((job) => job.status === "pending").length,
    needsAttention: () =>
      known.filter((job) => job.status === "failed" || job.status === "expired"),
  }
}
