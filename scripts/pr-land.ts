// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run pr:land <number> [--wait]`: the one way a pull request reaches main.
//
// It squash-merges the PR (the repo deletes the branch on merge) only when:
//   - the PR is open, not a draft, targets main and has no conflict;
//   - every check on its head commit is green, and the required ones
//     (REQUIRED_CHECKS) have all reported; the secret scan must have passed,
//     a skipped run does not count (MUST_SUCCEED);
//   - main's newest finished `ci` run is green, or the PR is the fix of that
//     red: its body or one of its commits carries `Fixes-CI: <run id>` naming a
//     red run since the last green one.
// A refusal prints what failed and the tail of the failing log, so whoever
// lands next repairs the break instead of stacking work on it. The merge is
// pinned to the head commit that was checked, so a push made meanwhile is not
// merged unchecked. `--wait` polls pending checks for up to 30 minutes.
//
// The repo's pre-push hook (scripts/git-hooks/pre-push) refuses direct pushes
// to main, and GitHub's branch protection and ruleset enforce the same on the
// server. Merging takes the admin bypass, so this script remains the merge gate.
import { spawnSync } from "node:child_process"

export interface CiRun {
  databaseId: number
  status: string
  conclusion: string
  headSha: string
  url: string
}

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

/** Runs that finished without deciding anything (superseded, skipped). */
const UNDECIDED_RUN = new Set(["cancelled", "skipped", "neutral", "stale", ""])
/** Check outcomes that do not block a merge. */
const PASSING_CHECK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])

export interface MainGate {
  allow: boolean
  /** The newest finished run when main is red. */
  redRun?: CiRun
  /** Every red run since the last green one; a fix may name any of them. */
  redRunIds: string[]
}

/** `runs` newest first, as `gh run list` returns them. */
export function decideMainGate(runs: CiRun[], fixesCi: string[]): MainGate {
  const finished = runs.filter((r) => r.status === "completed" && !UNDECIDED_RUN.has(r.conclusion))
  const redRuns: CiRun[] = []
  for (const r of finished) {
    if (r.conclusion === "success") break
    redRuns.push(r)
  }
  const redRunIds = redRuns.map((r) => String(r.databaseId))
  if (redRuns.length === 0) return { allow: true, redRunIds }
  return { allow: fixesCi.some((id) => redRunIds.includes(id)), redRun: redRuns[0], redRunIds }
}

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

/** Run ids from `Fixes-CI:` lines (PR body or commit trailers): a bare id or a run URL. */
export function parseFixesCi(text: string): string[] {
  return [...text.matchAll(/^\s*Fixes-CI:\s*\S*?(\d+)\/?\s*$/gim)].map((m) => m[1])
}

export function runIdFromUrl(url: string | undefined): string | null {
  return url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null
}

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
  number: number
  url: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefOid: string
  mergeable: string
  body: string
  commits: Array<{ messageBody: string }>
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

  const fields =
    "number,url,state,isDraft,baseRefName,headRefOid,mergeable,body,commits,statusCheckRollup"
  const deadline = Date.now() + 30 * 60_000
  let pr: Pr
  let checks: PrChecks
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
    console.error(
      `pr:land: checks still running on ${pr.url}${checks.missing.length ? ` (not reported yet: ${checks.missing.join(", ")})` : ""}; waiting 30 s`,
    )
    Bun.sleepSync(30_000)
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

  const runs = ghJson<CiRun[]>([
    "run",
    "list",
    "-R",
    slug,
    "--branch",
    "main",
    "--workflow",
    "ci.yml",
    "--event",
    "push",
    "-L",
    "20",
    "--json",
    "databaseId,status,conclusion,headSha,url",
  ])
  const fixesCi = parseFixesCi([pr.body ?? "", ...pr.commits.map((c) => c.messageBody)].join("\n"))
  const gate = decideMainGate(runs, fixesCi)
  if (!gate.allow && gate.redRun) {
    const red = gate.redRun
    return refuse(`main's CI is red, so only the fix of that red may land.
  red run  : ${red.url}  (commit ${red.headSha.slice(0, 9)})
  red runs since the last green: ${gate.redRunIds.join(", ")}
${failedLog(slug, String(red.databaseId))}

Fix what broke in its own PR, on top of origin/main, with "Fixes-CI: ${red.databaseId}" in the PR body,
and land that first. Then re-run pr:land for this one.`)
  }

  const merged = sh("gh", [
    "pr",
    "merge",
    number,
    "-R",
    slug,
    "--squash",
    // The ruleset on main lets only admins update it, through this bypass. The
    // gates above decide; a collaborator without the role is refused by GitHub.
    "--admin",
    "--match-head-commit",
    pr.headRefOid,
  ])
  if (!merged.ok) return refuse(`gh pr merge failed: ${merged.out.trim()}`)
  console.log(`pr:land: merged ${pr.url} (squash of ${pr.headRefOid.slice(0, 9)}).`)
  return 0
}

if (import.meta.main) process.exit(main())
