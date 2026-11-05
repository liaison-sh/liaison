// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TURN-END DECISION (P2-T09; S32, S36, S57, D15, D16, D38, A29, A36, A37,
// spec §3.6).
//
// When a turn ends with nothing left open (no SDK task, no unread owner
// message), the sidecar decides, first match wins:
//   1. a latched `mark_done` → done (by the session), once a due PR is verified;
//   2. a latched `needs_you` → needs you, with its reason (and code);
//   3. this session's Atelier state: complete → done (by atelier, same PR
//      rule), failed → error with its reason, awaiting the person → needs you
//      when guided, a counted continue when autonomous (D16);
//   4. autonomous, fewer than 5 consecutive empty continues and 30 in all →
//      continue with a fixed message;
//   5. otherwise: needs you (stuck or capped) when (4) ran out, else the W1
//      no-signal end (no completion).
// Every input is structural: a host-tool latch, the state file's enums, the
// session's settings, counters and git's own output. Nothing here reads the
// person's or the model's words to decide.

import {
  AUTO_CONTINUE_MAX,
  AUTO_CONTINUE_TOTAL_MAX,
  type Autonomy,
  type FinishWith,
  type NodeSessionAtelierState,
  type NodeSessionCompletion,
} from "../../../packages/shared/src/node-session-protocol"
import { parseRemote } from "./job-workspace"
import { remoteRepoPath } from "./session-credentials"

/** The PR the node verified: its URL and its head branch (A37). */
export interface VerifiedPr {
  url: string
  headRefName: string
}

export type TurnEndDecision =
  | { kind: "close"; completion?: NodeSessionCompletion }
  | { kind: "fail"; reason: string }
  | { kind: "continue" }

export interface TurnEndInput {
  /** The host tools' latch (`mark_done` / `needs_you`), if any. */
  latch: NodeSessionCompletion | undefined
  /** This session's Atelier state as read at this turn end (S35). */
  atelier: NodeSessionAtelierState | null
  autonomy: Autonomy
  emptyContinues: number
  totalContinues: number
  /** The finish step due (S57); null in a folder that is no repository. */
  finish: FinishWith | null
  /** The verified PR; called only when a done needs one. */
  pr: () => VerifiedPr | null
  /** The session's last text, whose first line summarises an Atelier completion. */
  lastText: string
}

export const PR_MISSING_REASON =
  "The session finished without a pull request the node could verify on the repository."
export const ATELIER_AWAITING_REASON = "The Atelier pipeline is waiting for you."
export const STUCK_REASON = `No progress after ${AUTO_CONTINUE_MAX} automatic continues.`
export const CAP_REASON = `Stopped after ${AUTO_CONTINUE_TOTAL_MAX} automatic continues.`
const ATELIER_FAILED_REASON = "The Atelier pipeline failed."

const needsYou = (
  reasonCode: NonNullable<NodeSessionCompletion["reasonCode"]>,
  reason: string,
): TurnEndDecision => ({ kind: "close", completion: { by: "needs_you", reason, reasonCode } })

/** The completion without the session's own `prUrl`: only a verified PR's URL leaves the node. */
function unverified(completion: NodeSessionCompletion): NodeSessionCompletion {
  const { prUrl: _reported, ...rest } = completion
  return rest
}

/** A done that needs a PR gets the verified one's URL, or becomes `pr_missing` (A29, A37). */
function doneWithPr(completion: NodeSessionCompletion, input: TurnEndInput): TurnEndDecision {
  if (input.finish !== "pr") return { kind: "close", completion: unverified(completion) }
  const pr = input.pr()
  if (!pr) return needsYou("pr_missing", PR_MISSING_REASON)
  return { kind: "close", completion: { ...unverified(completion), prUrl: pr.url } }
}

export function decideTurnEnd(input: TurnEndInput): TurnEndDecision {
  const { latch, atelier } = input
  // (1) and (2): the session's own signal.
  if (latch?.by === "needs_you") return { kind: "close", completion: unverified(latch) }
  if (latch) return doneWithPr(latch, input)
  // (3) the Atelier state of this session.
  if (atelier?.status === "complete") {
    const summary = input.lastText.trim().split("\n")[0]?.trim().slice(0, 300) ?? ""
    return doneWithPr({ by: "atelier", ...(summary ? { summary } : {}) }, input)
  }
  if (atelier?.status === "failed") {
    return { kind: "fail", reason: atelier.failureReason || ATELIER_FAILED_REASON }
  }
  if (atelier?.awaiting === "user" && input.autonomy !== "autonomous") {
    return needsYou("atelier_awaiting", ATELIER_AWAITING_REASON)
  }
  // (4) an autonomous session continues on its own, within both bounds.
  if (input.autonomy !== "autonomous") return { kind: "close" }
  if (input.emptyContinues >= AUTO_CONTINUE_MAX) {
    return needsYou("stuck_after_5_continues", STUCK_REASON)
  }
  if (input.totalContinues >= AUTO_CONTINUE_TOTAL_MAX) {
    return needsYou("auto_continue_cap", CAP_REASON)
  }
  return { kind: "continue" }
}

/**
 * The auto-continue counters (D15, A2, A36). `empty` counts consecutive
 * continues with no progress since the previous one; `total` never resets
 * within a run. Progress: a successful file edit or a delivered owner message
 * (`progress()`), a TodoWrite whose completed count rose (`todo`), or, seen
 * at the turn end, a changed `git status --porcelain` fingerprint or a changed
 * Atelier phase / done[] (`turnEnd`).
 */
export class AutoContinue {
  empty = 0
  total = 0
  private progressed = false
  private todoDone = 0
  private seen: { git: string | null; atelier: string | null } | null = null
  private baseline: { git: string | null; atelier: string | null } | null = null

  progress(): void {
    this.progressed = true
  }

  /** A TodoWrite with this many items completed. */
  todo(completed: number): void {
    if (completed > this.todoDone) this.progressed = true
    this.todoDone = completed
  }

  /** The turn end's structural facts; resets `empty` when anything moved. */
  turnEnd(facts: { git: string | null; atelier: string | null }): void {
    this.seen = facts
    const base = this.baseline
    if (base && (base.git !== facts.git || base.atelier !== facts.atelier)) this.progressed = true
    if (this.progressed) this.empty = 0
  }

  /** A continue was sent: counted, and the next one is judged from here. */
  continued(): void {
    this.empty++
    this.total++
    this.progressed = false
    this.baseline = this.seen
  }
}

type Exec = (args: string[], input?: string) => { status: number | null; stdout: string }

const SHA = /^[0-9a-f]{40,64}$/

/**
 * When the session started (D43 F3): the cwd's HEAD then (null in a repo with
 * no commit yet), the time, and the tip of every local and remote-tracking
 * ref then, kept by the node across the session's runs. A commit that any of
 * those already contained, a push made before, or a PR merged before is never
 * this session's. `tips` is absent only in a baseline kept by an older node.
 */
export interface SessionBaseline {
  head: string | null
  at: number
  tips?: string[]
}

/**
 * The forges' ssh endpoints on port 443 (their documented firewall
 * workaround, set as an ssh HostName), mapped to the forge's web host.
 */
const FORGE_SSH_ENDPOINTS: Readonly<Record<string, string>> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
}

/** A host as its forge's web host: `ssh.github.com` is github.com (batch-2 F2). */
export function forgeWebHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "")
  return FORGE_SSH_ENDPOINTS[h] ?? h
}

/**
 * The forge origin is on (D43 F4, batch-2 F2): github.com when either the host
 * written in the remote URL or the one ssh resolves is GitHub's, else the
 * resolved host as its forge's web host, else the written one.
 */
export function forgeHostOf(written?: string, resolved?: string): string | undefined {
  const hosts = [resolved, written].filter((h): h is string => !!h).map(forgeWebHost)
  return hosts.includes("github.com") ? "github.com" : hosts[0]
}

/** The tips of every local branch and remote-tracking ref (D43 F3), deduplicated. */
export function refTips(git: Exec): string[] {
  const out = git(["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"])
  if (out.status !== 0) return []
  return [...new Set(out.stdout.split("\n").map((l) => l.trim()))].filter((l) => SHA.test(l))
}

/**
 * The PR the session made, verified from git's and gh's own answers (A29,
 * A37, D38, D43 F3), or null. Never from the cwd's branch alone when a URL was
 * reported, so an Atelier worktree branch with the cwd on main counts.
 *
 * The head branch is always one of the session's own: a local branch, not a
 * default or protected one (case-folded), whose tip is on the remote at the
 * same commit, and whose tip is a commit made since the session started (not
 * contained in its start HEAD, nor reachable from any ref's tip at the start).
 * - github.com (with a reported URL, else the PR gh found for the cwd's pushed
 *   branch): the URL's repo is origin's; gh says the PR is OPEN, or MERGED
 *   since the session started; its head is such a branch and gh's head commit
 *   is that branch's tip.
 * - another host: the URL is https on origin's host, inside origin's repo, and
 *   either names the branch (the new-merge-request link `git push` prints) or
 *   is a merge request / pull request whose forge ref
 *   (`refs/merge-requests/<n>/head`, `refs/pull/<n>/head`) is the branch's tip.
 */
export function verifyPr(args: {
  reportedUrl?: string
  /** `sessionResultFacts` for the cwd: its branch, whether pushed, gh's PR for it. */
  cwdFacts: { branch?: string; pushed?: boolean; prUrl?: string }
  /** Protected and default branch names, lower-case. */
  guarded: readonly string[]
  /** git in the session's cwd, outside the sandbox. */
  git: Exec
  /** gh, outside the sandbox; null when none is installed. */
  gh: Exec | null
  /** D43 F3: when the session started. */
  since: SessionBaseline
  /**
   * D43 F4: origin's host as ssh resolves it (`ssh -G`: an alias's HostName),
   * for an ssh remote; absent, the host written in the remote URL. Either one
   * matches, a forge's ssh-over-443 endpoint as the forge (batch-2 F2).
   */
  forgeHost?: string
}): VerifiedPr | null {
  const guarded = new Set(args.guarded.map((b) => b.toLowerCase()))
  const origin = args.git(["config", "--get", "remote.origin.url"])
  const originUrl = origin.status === 0 ? origin.stdout.trim() : ""
  const parsed = originUrl ? parseRemote(originUrl) : null
  const originRepo = originUrl ? remoteRepoPath(originUrl) : null
  if (!parsed || !originRepo) return null
  // Either the written or the resolved host, each as its forge's web host (batch-2 F2).
  const hosts = new Set(
    [parsed.host, ...(args.forgeHost ? [args.forgeHost] : [])].map(forgeWebHost),
  )
  const github = hosts.has("github.com")
  const reportedRaw = args.reportedUrl ?? (github ? args.cwdFacts.prUrl : undefined)
  const reported = reportedRaw && URL.canParse(reportedRaw) ? new URL(reportedRaw) : null
  if (reported?.protocol !== "https:" || !hosts.has(forgeWebHost(reported.hostname))) {
    return null
  }
  const remoteRef = (ref: string): string | null => {
    const out = args.git(["ls-remote", "origin", ref])
    const sha = out.status === 0 ? (out.stdout.trim().split(/\s+/)[0] ?? "") : ""
    return SHA.test(sha) ? sha : null
  }
  /** The branch's tip when it is one of the session's own, pushed as it is; else null. */
  const sessionTip = (branch: string): string | null => {
    if (branch === "" || guarded.has(branch.toLowerCase())) return null
    const local = args.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`])
    const sha = local.status === 0 ? local.stdout.trim() : ""
    if (!SHA.test(sha) || remoteRef(`refs/heads/${branch}`) !== sha) return null
    if (args.since.head) {
      // Exit 0: the start HEAD already contained it (an old commit); 1: a new
      // one; anything else (unknown commit): not provably the session's.
      const old = args.git(["merge-base", "--is-ancestor", sha, args.since.head])
      if (old.status !== 1) return null
    }
    const tips = args.since.tips ?? []
    if (tips.length > 0) {
      // Reachable from no ref the session started with: a commit made since
      // (an old feature branch, pushed long ago, is not the session's).
      const fresh = args.git(
        ["rev-list", "-n1", "--stdin"],
        `${sha}\n${tips.map((t) => `^${t}`).join("\n")}\n`,
      )
      if (fresh.status !== 0 || fresh.stdout.trim() !== sha) return null
    }
    return sha
  }
  // The URL's path inside origin's repo (case-folded, as remoteRepoPath folds).
  const pathInRepo = (): string | null => {
    const p = decodeURIComponent(reported.pathname).replace(/\/+$/, "")
    const prefix = `/${originRepo}/`
    return p.toLowerCase().startsWith(prefix) ? p.slice(prefix.length) : null
  }

  if (github) {
    const rest = pathInRepo()
    if (!rest || !/^pull\/\d+$/.test(rest) || !args.gh) return null
    const view = args.gh([
      "pr",
      "view",
      reported.href,
      "--json",
      "url,state,headRefName,headRefOid,mergedAt",
    ])
    if (view.status !== 0) return null
    let pr: {
      url?: unknown
      state?: unknown
      headRefName?: unknown
      headRefOid?: unknown
      mergedAt?: unknown
    }
    try {
      pr = JSON.parse(view.stdout) as typeof pr
    } catch {
      return null
    }
    const mergedAt = typeof pr.mergedAt === "string" ? Date.parse(pr.mergedAt) : Number.NaN
    const live = pr.state === "OPEN" || (pr.state === "MERGED" && mergedAt >= args.since.at)
    if (!live) return null
    const head = typeof pr.headRefName === "string" ? pr.headRefName : ""
    const tip = sessionTip(head)
    if (!tip || pr.headRefOid !== tip) return null
    const url =
      typeof pr.url === "string" && URL.canParse(pr.url) && new URL(pr.url).protocol === "https:"
        ? pr.url
        : reported.href
    return { url, headRefName: head }
  }

  // Another host (A29, D43 F3): no forge API here, so the forge's own refs.
  const rest = pathInRepo()
  if (!rest) return null
  if (rest === "-/merge_requests/new") {
    const branch = reported.searchParams.get("merge_request[source_branch]") ?? ""
    return sessionTip(branch) ? { url: reported.href, headRefName: branch } : null
  }
  const mr = /^-\/merge_requests\/(\d+)$/.exec(rest)
  const pull = /^pulls?\/(\d+)$/.exec(rest)
  const ref = mr ? `refs/merge-requests/${mr[1]}/head` : pull ? `refs/pull/${pull[1]}/head` : null
  if (!ref) return null
  const source = remoteRef(ref)
  if (!source) return null
  // The session's own branch at that commit: the cwd's first, else any local one.
  const locals = args.git(["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"])
  if (locals.status !== 0) return null
  const named = locals.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(([sha, name]) => sha === source && name)
    .map(([, name]) => name as string)
  const cwd = args.cwdFacts.branch
  const ordered = cwd && named.includes(cwd) ? [cwd, ...named.filter((n) => n !== cwd)] : named
  const head = ordered.find((name) => sessionTip(name) === source)
  return head ? { url: reported.href, headRefName: head } : null
}
