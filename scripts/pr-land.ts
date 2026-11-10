// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run pr:land <number> [--wait]`: the one way a pull request reaches main.
//
// It adds the PR to main's merge queue only when:
//   - the PR is open, not a draft, targets main and has no conflict;
//   - every check on its head commit is green, and the required ones
//     (REQUIRED_CHECKS) have all reported; the secret scan must have passed,
//     a skipped run does not count (MUST_SUCCEED).
// A refusal prints what failed and the tail of the failing log. The entry is
// pinned to the head commit that was checked, so a push made meanwhile is not
// queued unchecked.
//
// The queue does the rest: it tests the PR on top of main and of the PRs ahead
// of it (the `ci` workflow's merge_group run is the full gate: every test job),
// squash-merges it when that passes, and removes it from the queue when it
// fails. A red main cannot happen through the queue, so there is no main-green
// gate and no admin bypass here.
//
// `--wait` polls pending checks for up to 30 minutes, then waits for the queue
// to merge or eject the PR (up to QUEUE_WAIT_MS) and exits 0 only when it was
// merged; an ejection prints the failing merge-group run's log. Without
// `--wait`, exit 0 means queued.
//
// GitHub sometimes drops the pull_request event of a push or an opened PR: no
// workflow runs at all for the head commit, and the checks would stay missing
// until the deadline. When no check of any kind has reported on the head for
// KICK_AFTER_MS, `--wait` closes and reopens the PR (the `reopened` event starts
// every PR workflow again), at most MAX_KICKS times per head commit.
//
// The repo's pre-push hook (scripts/git-hooks/pre-push) refuses direct pushes
// to main, and GitHub's branch protection and ruleset enforce the same on the
// server.
import { spawnSync } from "node:child_process"

export type CheckEntry =
  | {
      __typename: "CheckRun"
      name: string
      status: string
      conclusion: string
      detailsUrl?: string
      startedAt?: string
    }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl?: string }

/** Checks a PR must carry before it may land: the `ci` jobs, the CLA and the secret scan. */
export const REQUIRED_CHECKS = ["checks", "CLAAssistant", "gitleaks"]

/** Checks whose skipped or neutral run proves nothing: only a pass lets a PR land. */
const MUST_SUCCEED = new Set(["gitleaks"])

/** Check outcomes that do not block a merge. */
const PASSING_CHECK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])

export interface PrChecks {
  state: "green" | "red" | "pending"
  failing: Array<{ name: string; url?: string }>
  missing: string[]
}

/**
 * A check re-run on a new push (or after a cancelled run) reports again under
 * the same name; only its newest run speaks for the PR. Without this, a
 * superseded CANCELLED run kept a PR red after its re-run went green.
 */
function newestCheckRuns(checks: CheckEntry[]): CheckEntry[] {
  const newest = new Map<string, number>()
  checks.forEach((c, i) => {
    if (c.__typename !== "CheckRun") return
    const prev = newest.get(c.name)
    if (prev === undefined) {
      newest.set(c.name, i)
      return
    }
    const p = checks[prev] as Extract<CheckEntry, { __typename: "CheckRun" }>
    if ((c.startedAt ?? "") >= (p.startedAt ?? "")) newest.set(c.name, i)
  })
  return checks.filter((c, i) => c.__typename !== "CheckRun" || newest.get(c.name) === i)
}

export function judgePrChecks(checks: CheckEntry[]): PrChecks {
  const failing: PrChecks["failing"] = []
  let pending = false
  const seen = new Set<string>()
  for (const c of newestCheckRuns(checks)) {
    if (c.__typename === "CheckRun") {
      seen.add(c.name)
      if (c.status !== "COMPLETED") pending = true
      else if (
        MUST_SUCCEED.has(c.name) ? c.conclusion !== "SUCCESS" : !PASSING_CHECK.has(c.conclusion)
      )
        failing.push({ name: c.name, url: c.detailsUrl })
    } else {
      seen.add(c.context)
      if (c.state === "PENDING" || c.state === "EXPECTED") pending = true
      else if (c.state !== "SUCCESS") failing.push({ name: c.context, url: c.targetUrl })
    }
  }
  const missing = REQUIRED_CHECKS.filter((n) => !seen.has(n))
  const state = failing.length > 0 ? "red" : pending || missing.length > 0 ? "pending" : "green"
  return { state, failing, missing }
}

/** How long a head commit may go with no check at all before CI is re-triggered. */
export const KICK_AFTER_MS = 60_000
/** Re-triggers per head commit; past that the event is not coming and a person looks. */
export const MAX_KICKS = 2

/**
 * Whether the PR's workflows never started for this head commit and should be
 * re-triggered now. `emptySince` is when this head was first seen with no
 * check at all (null while it has some); `kicks` re-triggers already spent on it.
 */
export function decideCiKick(
  checks: CheckEntry[],
  emptySince: number | null,
  kicks: number,
  now: number,
): "wait" | "kick" | "give_up" {
  if (checks.length > 0 || emptySince === null) return "wait"
  if (now - emptySince < KICK_AFTER_MS) return "wait"
  return kicks < MAX_KICKS ? "kick" : "give_up"
}

export function runIdFromUrl(url: string | undefined): string | null {
  return url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null
}

/** How long `--wait` follows the PR through the merge queue. */
export const QUEUE_WAIT_MS = 90 * 60_000

/** The PR as the merge queue sees it (GraphQL). */
export interface QueueStatus {
  state: "OPEN" | "CLOSED" | "MERGED"
  /** Null when the PR is not in the queue (never queued, merged or ejected). */
  mergeQueueEntry: { state: string; position: number } | null
}

/**
 * Where a PR we queued stands. Once queued, an open PR with no queue entry
 * was ejected: its merge group failed, it conflicted with the PRs ahead, or a
 * push to its branch removed it.
 */
export function decideQueue(s: QueueStatus): "merged" | "queued" | "ejected" | "closed" {
  if (s.state === "MERGED") return "merged"
  if (s.state === "CLOSED") return "closed"
  return s.mergeQueueEntry ? "queued" : "ejected"
}

export interface QueueRun {
  databaseId: number
  headBranch: string
  conclusion: string
  url: string
}

/**
 * The newest failed merge-group run that held PR `number`. Its branch is
 * gh-readonly-queue/<base>/pr-<number>-<sha>; `runs` newest first.
 */
export function failedQueueRun(runs: QueueRun[], number: string): QueueRun | undefined {
  return runs.find(
    (r) =>
      new RegExp(`^gh-readonly-queue/[^/]+/pr-${number}-[0-9a-f]+$`).test(r.headBranch) &&
      (r.conclusion === "failure" || r.conclusion === "timed_out"),
  )
}

const QUEUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: "main") { id }
    pullRequest(number: $number) { state mergeQueueEntry { state position } }
  }
}`

const ENQUEUE = `mutation($id: ID!, $oid: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $oid }) {
    mergeQueueEntry { state position }
  }
}`

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  return {
    ok: r.status === 0,
    out: r.status === 0 ? (r.stdout ?? "") : `${r.stdout ?? ""}${r.stderr ?? ""}`,
  }
}

function ghJson<T>(args: string[]): T {
  const r = sh("gh", args)
  if (!r.ok)
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.out.trim().split("\n")[0]}`)
  return JSON.parse(r.out) as T
}

/** The failing steps and the last lines of their log, from `gh run view --log-failed`. */
function failedLog(slug: string, runId: string): string {
  const out = sh("gh", ["run", "view", runId, "-R", slug, "--log-failed"]).out
  const where = [...new Set(out.split("\n").map((l) => l.split("\t").slice(0, 2).join(" / ")))]
    .filter((w) => w.includes(" / "))
    .join(", ")
  // Each line is prefixed "<job>\t<step>\t<timestamp> ".
  const tail = out
    .trim()
    .split("\n")
    .slice(-40)
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+ ?/, ""))
    .join("\n")
  return `  failing  : ${where || "(see the run)"}\n\nFailing log (last 40 lines):\n${tail || "(no failed-step log; open the run)"}`
}

interface Pr {
  /** GraphQL node id. */
  id: string
  number: number
  url: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefOid: string
  mergeable: string
  statusCheckRollup: CheckEntry[]
}

function refuse(msg: string): number {
  console.error(`\npr:land REFUSED: ${msg}\n`)
  return 1
}

function main(): number {
  const args = process.argv.slice(2)
  const wait = args.includes("--wait")
  const number = args.find((a) => /^\d+$/.test(a))
  if (!number) {
    console.error("usage: bun run pr:land <pr number> [--wait]")
    return 2
  }
  const remote = sh("git", ["remote", "get-url", "origin"]).out.trim()
  const slug = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
  if (!slug) return refuse(`origin (${remote || "none"}) is not a GitHub repository`)

  const fields = "id,number,url,state,isDraft,baseRefName,headRefOid,mergeable,statusCheckRollup"
  const deadline = Date.now() + 30 * 60_000
  let pr: Pr
  let checks: PrChecks
  let head = ""
  let emptySince: number | null = null
  let kicks = 0
  for (;;) {
    pr = ghJson<Pr>(["pr", "view", number, "-R", slug, "--json", fields])
    if (pr.state !== "OPEN") return refuse(`${pr.url} is ${pr.state.toLowerCase()}, not open`)
    if (pr.isDraft) return refuse(`${pr.url} is a draft`)
    if (pr.baseRefName !== "main") return refuse(`${pr.url} targets ${pr.baseRefName}, not main`)
    if (pr.mergeable === "CONFLICTING")
      return refuse(
        `${pr.url} conflicts with main: rebase it on origin/main and push the branch again`,
      )
    checks = judgePrChecks(pr.statusCheckRollup ?? [])
    if (checks.state !== "pending" || !wait || Date.now() > deadline) break
    if (pr.headRefOid !== head) {
      head = pr.headRefOid
      emptySince = null
      kicks = 0
    }
    const rollup = pr.statusCheckRollup ?? []
    if (rollup.length > 0) emptySince = null
    else emptySince ??= Date.now()
    const kick = decideCiKick(rollup, emptySince, kicks, Date.now())
    if (kick === "give_up")
      return refuse(
        `${pr.url}: GitHub started no workflow for ${head.slice(0, 9)} even after ${MAX_KICKS} close/reopen re-triggers. Check https://www.githubstatus.com and the repo's Actions settings.`,
      )
    if (kick === "kick") {
      kicks++
      console.error(
        `pr:land: no check reported on ${head.slice(0, 9)} after ${KICK_AFTER_MS / 1000} s (GitHub dropped the event); closing and reopening ${pr.url} to start CI (${kicks}/${MAX_KICKS})`,
      )
      const closed = sh("gh", ["pr", "close", number, "-R", slug])
      const reopened = sh("gh", ["pr", "reopen", number, "-R", slug])
      if (!closed.ok || !reopened.ok)
        return refuse(`re-triggering CI failed: ${(closed.ok ? reopened : closed).out.trim()}`)
      emptySince = Date.now()
    }
    console.error(
      `pr:land: checks still running on ${pr.url}${checks.missing.length ? ` (not reported yet: ${checks.missing.join(", ")})` : ""}; waiting 30 s`,
    )
    // A head with nothing reported yet is polled faster, so a dropped event is caught in a minute.
    Bun.sleepSync(emptySince !== null ? 15_000 : 30_000)
  }

  if (checks.state === "pending") {
    return refuse(
      `${pr.url} checks have not finished${checks.missing.length ? ` (not reported yet: ${checks.missing.join(", ")})` : ""}. Re-run with --wait.`,
    )
  }
  if (checks.state === "red") {
    const names = checks.failing.map((c) => c.name).join(", ")
    const runId = checks.failing.map((c) => runIdFromUrl(c.url)).find((id) => id !== null)
    return refuse(
      `${pr.url} has failing checks: ${names}.\n${runId ? failedLog(slug, runId) : ""}\n\nFix it on the PR branch and push the branch again, then re-run pr:land.`,
    )
  }

  const [owner, name] = slug.split("/")
  const queueStatus = (): { queue: boolean; pr: QueueStatus } => {
    const r = ghJson<{
      data: { repository: { mergeQueue: { id: string } | null; pullRequest: QueueStatus } }
    }>([
      "api",
      "graphql",
      "-f",
      `query=${QUEUE_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ])
    return { queue: r.data.repository.mergeQueue !== null, pr: r.data.repository.pullRequest }
  }

  const before = queueStatus()
  if (!before.queue)
    return refuse(
      "main has no merge queue: enable it in the branch ruleset (required checks: checks, codeql, gitleaks; squash merge).",
    )
  if (before.pr.mergeQueueEntry) {
    console.log(
      `pr:land: ${pr.url} is already in the merge queue (${before.pr.mergeQueueEntry.state}).`,
    )
  } else {
    const queued = sh("gh", [
      "api",
      "graphql",
      "-f",
      `query=${ENQUEUE}`,
      "-f",
      `id=${pr.id}`,
      "-f",
      `oid=${pr.headRefOid}`,
    ])
    if (!queued.ok)
      return refuse(`adding ${pr.url} to the merge queue failed: ${queued.out.trim()}`)
    console.log(
      `pr:land: queued ${pr.url} (head ${pr.headRefOid.slice(0, 9)}); the merge queue tests it on top of main and squash-merges it when green.`,
    )
  }
  if (!wait) return 0

  const queueDeadline = Date.now() + QUEUE_WAIT_MS
  for (;;) {
    const now = queueStatus().pr
    const where = decideQueue(now)
    if (where === "merged") {
      console.log(`pr:land: merged ${pr.url}.`)
      return 0
    }
    if (where === "closed") return refuse(`${pr.url} was closed while in the merge queue`)
    if (where === "ejected") {
      const runs = ghJson<QueueRun[]>([
        "run",
        "list",
        "-R",
        slug,
        "--workflow",
        "ci.yml",
        "--event",
        "merge_group",
        "-L",
        "50",
        "--json",
        "databaseId,headBranch,conclusion,url",
      ])
      const failed = failedQueueRun(runs, number)
      const next = failed
        ? `  merge group run: ${failed.url}\n${failedLog(slug, String(failed.databaseId))}\n\nFix it on the PR branch, push, and re-run pr:land.`
        : "No failed merge-group run names it: it conflicted with the PRs ahead of it, or its branch got a push. Rebase on origin/main if needed, push, and re-run pr:land."
      return refuse(`${pr.url} was removed from the merge queue without merging.\n${next}`)
    }
    if (Date.now() > queueDeadline)
      return refuse(
        `${pr.url} is still in the merge queue after ${QUEUE_WAIT_MS / 60_000} minutes (${now.mergeQueueEntry?.state}); it stays queued.`,
      )
    console.error(
      `pr:land: ${pr.url} in the merge queue (${now.mergeQueueEntry?.state}, position ${now.mergeQueueEntry?.position}); waiting 30 s`,
    )
    Bun.sleepSync(30_000)
  }
}

if (import.meta.main) process.exit(main())
