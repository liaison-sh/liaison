// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  NodeSessionAtelierState,
  NodeSessionCompletion,
} from "../../../packages/shared/src/node-session-protocol"
import { readSshConfig, sshRemoteTarget } from "./session-credentials"
import {
  AutoContinue,
  decideTurnEnd,
  forgeHostOf,
  PR_MISSING_REASON,
  type TurnEndDecision,
  type TurnEndInput,
  type VerifiedPr,
  verifyPr,
} from "./turn-end"

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-turn-end-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const GUARDED = ["main", "master", "trunk", "develop", "production"]

const atelier = (patch: Partial<NodeSessionAtelierState> = {}): NodeSessionAtelierState => ({
  id: "fix-x",
  rung: "R1",
  phase: "execute",
  plan: ["frame", "execute", "handoff"],
  done: ["frame"],
  status: "running",
  awaiting: null,
  ...patch,
})

const noPr = (): VerifiedPr | null => {
  throw new Error("the PR was checked although none is due")
}

const input = (patch: Partial<TurnEndInput> = {}): TurnEndInput => ({
  latch: undefined,
  atelier: null,
  autonomy: "guided",
  emptyContinues: 0,
  totalContinues: 0,
  finish: null,
  pr: noPr,
  lastText: "Shipped the export.\nDetails follow.",
  ...patch,
})

const marked = (patch: Partial<NodeSessionCompletion> = {}): NodeSessionCompletion => ({
  by: "session",
  summary: "Fixed it",
  ...patch,
})

const prMissing: TurnEndDecision = {
  kind: "close",
  completion: { by: "needs_you", reason: PR_MISSING_REASON, reasonCode: "pr_missing" },
}

describe("P2-T09 the turn-end decision (S32, S36, S57, spec §3.6)", () => {
  it("S36: Atelier complete without a finish due → done by atelier", () => {
    expect(decideTurnEnd(input({ atelier: atelier({ status: "complete" }) }))).toEqual({
      kind: "close",
      completion: { by: "atelier", summary: "Shipped the export." },
    })
  })

  it("S36: Atelier failed → error with its reason", () => {
    expect(
      decideTurnEnd(
        input({ atelier: atelier({ status: "failed", failureReason: "tests stay red" }) }),
      ),
    ).toEqual({ kind: "fail", reason: "tests stay red" })
  })

  it("S36: awaiting user guided → needs_you atelier_awaiting; autonomous → continue (counted)", () => {
    const waiting = atelier({ awaiting: "user" })
    const guided = decideTurnEnd(input({ atelier: waiting }))
    expect(guided).toMatchObject({
      kind: "close",
      completion: { by: "needs_you", reasonCode: "atelier_awaiting" },
    })
    expect(decideTurnEnd(input({ atelier: waiting, autonomy: "autonomous" }))).toEqual({
      kind: "continue",
    })
    // Counted: on the sixth empty turn end it is the counter that stops it.
    expect(
      decideTurnEnd(input({ atelier: waiting, autonomy: "autonomous", emptyContinues: 5 })),
    ).toMatchObject({ completion: { reasonCode: "stuck_after_5_continues" } })
  })

  it("S36: a latched mark_done wins over Atelier running", () => {
    expect(
      decideTurnEnd(
        input({ latch: marked(), atelier: atelier({ awaiting: "user" }), autonomy: "autonomous" }),
      ),
    ).toEqual({ kind: "close", completion: { by: "session", summary: "Fixed it" } })
  })

  it("S32: a guided session never auto-continues; an autonomous one stops on the empty counter, then on the total cap", () => {
    expect(decideTurnEnd(input())).toEqual({ kind: "close" })
    expect(decideTurnEnd(input({ autonomy: "autonomous", emptyContinues: 4 }))).toEqual({
      kind: "continue",
    })
    expect(decideTurnEnd(input({ autonomy: "autonomous", emptyContinues: 5 }))).toMatchObject({
      kind: "close",
      completion: { by: "needs_you", reasonCode: "stuck_after_5_continues" },
    })
    expect(
      decideTurnEnd(input({ autonomy: "autonomous", emptyContinues: 0, totalContinues: 30 })),
    ).toMatchObject({
      kind: "close",
      completion: { by: "needs_you", reasonCode: "auto_continue_cap" },
    })
  })

  it("S57: mark_done with finish pr and no verified PR → needs_you pr_missing", () => {
    expect(decideTurnEnd(input({ latch: marked(), finish: "pr", pr: () => null }))).toEqual(
      prMissing,
    )
    // Atelier complete with a PR due follows the same rule.
    expect(
      decideTurnEnd(
        input({ atelier: atelier({ status: "complete" }), finish: "pr", pr: () => null }),
      ),
    ).toEqual(prMissing)
  })

  it("S57: finish commit → mark_done ends done without a PR check", () => {
    expect(decideTurnEnd(input({ latch: marked(), finish: "commit" }))).toEqual({
      kind: "close",
      completion: { by: "session", summary: "Fixed it" },
    })
  })

  it("S57: a prUrl the node did not verify never leaves the node (commit, none, no repo, needs_you)", () => {
    const reported = "https://example.com/anything"
    for (const finish of ["commit", "none", null] as const) {
      expect(decideTurnEnd(input({ latch: marked({ prUrl: reported }), finish }))).toEqual({
        kind: "close",
        completion: { by: "session", summary: "Fixed it" },
      })
    }
    expect(
      decideTurnEnd(
        input({
          latch: { by: "needs_you", reason: "stuck", reasonCode: "push_failed", prUrl: reported },
          finish: "pr",
        }),
      ),
    ).toEqual({
      kind: "close",
      completion: { by: "needs_you", reason: "stuck", reasonCode: "push_failed" },
    })
    // A due PR: only the verified one's URL, never the reported one.
    const verified = "https://github.com/acme/widget/pull/7"
    expect(
      decideTurnEnd(
        input({
          latch: marked({ prUrl: reported }),
          finish: "pr",
          pr: () => ({ url: verified, headRefName: "fix/x" }),
        }),
      ),
    ).toEqual({
      kind: "close",
      completion: { by: "session", summary: "Fixed it", prUrl: verified },
    })
  })

  it("S57: a needs_you push_failed keeps its code", () => {
    expect(
      decideTurnEnd(
        input({
          latch: { by: "needs_you", reason: "remote refused", reasonCode: "push_failed" },
          finish: "pr",
        }),
      ),
    ).toEqual({
      kind: "close",
      completion: { by: "needs_you", reason: "remote refused", reasonCode: "push_failed" },
    })
  })
})

// ── the verified PR (A29, A37, D38), on real git with a fake gh ──

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: scratch,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
}

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

/**
 * A repo whose `origin` is `remoteUrl` (an https URL on a forge), served by a
 * local bare repository through `insteadOf`, so `ls-remote` reads it.
 */
function forgeRepo(remoteUrl: string) {
  const dir = realpathSync(mkdtempSync(path.join(scratch, "repo-")))
  const work = path.join(dir, "work")
  const bare = path.join(dir, "remote.git")
  mkdirSync(work)
  sh(work, "init", "-q", "-b", "main")
  writeFileSync(path.join(work, "README.md"), "# sample\n")
  sh(work, "add", "README.md")
  sh(work, "commit", "-q", "-m", "init")
  spawnSync("git", ["clone", "-q", "--bare", work, bare], { env: GIT_ENV })
  sh(work, "remote", "add", "origin", remoteUrl)
  const rewrite = [`url.${bare}.insteadOf`, remoteUrl]
  const git = (args: string[], input?: string) => {
    const r = spawnSync("git", ["-C", work, "-c", `${rewrite[0]}=${rewrite[1]}`, ...args], {
      encoding: "utf8",
      env: GIT_ENV,
      ...(input !== undefined ? { input } : {}),
    })
    return { status: r.status, stdout: r.stdout ?? "" }
  }
  const commitOn = (branch: string, cwd = work) => {
    writeFileSync(path.join(cwd, `${branch.replace(/\//g, "-")}.ts`), "export const x = 1\n")
    sh(cwd, "add", "-A")
    sh(cwd, "commit", "-q", "-m", branch)
  }
  const push = (branch: string) => {
    const r = git(["push", "-q", "origin", branch])
    if (r.status !== 0) throw new Error(`push ${branch} failed`)
  }
  /** The branch's tip on the remote, or "". */
  const tip = (branch: string) => {
    const out = spawnSync(
      "git",
      ["-C", bare, "rev-parse", "-q", "--verify", `refs/heads/${branch}`],
      {
        encoding: "utf8",
        env: GIT_ENV,
      },
    )
    return out.status === 0 ? out.stdout.trim() : ""
  }
  /** Every local and remote-tracking ref's tip, as the node records them at the start. */
  const tipsNow = () =>
    sh(work, "for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes")
      .split("\n")
      .filter(Boolean)
  const repo = {
    work,
    git,
    commitOn,
    push,
    tip,
    /** When the session started, its HEAD and every ref's tip then (D43 F3): by default, just before now. */
    since: { head: sh(work, "rev-parse", "HEAD"), at: Date.now() - 1_000, tips: tipsNow() } as {
      head: string
      at: number
      tips?: string[]
    },
    /** The session starts now: everything made so far is the past. */
    begin() {
      repo.since = { head: sh(work, "rev-parse", "HEAD"), at: Date.now(), tips: tipsNow() }
    },
    /** The forge's merge-request ref `refs/merge-requests/<n>/head` at `sha`. */
    mergeRequest(n: number, sha: string) {
      sh(bare, "update-ref", `refs/merge-requests/${n}/head`, sha)
    },
    /** A fake gh answering with this PR, its head commit as the remote has it. */
    gh(pr: PrView) {
      return fakeGh({
        headRefOid: tip(pr.headRefName),
        ...(pr.state === "MERGED" ? { mergedAt: new Date().toISOString() } : {}),
        ...pr,
      })
    },
  }
  return repo
}

interface PrView {
  url: string
  state: string
  headRefName: string
  headRefOid?: string
  mergedAt?: string | null
}

/** A fake gh that answers `pr view <url>` with this PR, and records its calls. */
function fakeGh(pr: PrView) {
  const calls: string[][] = []
  const gh = (args: string[]) => {
    calls.push(args)
    if (args[0] === "pr" && args[1] === "view" && args[2] === pr.url) {
      return { status: 0, stdout: JSON.stringify(pr) }
    }
    return { status: 1, stdout: "" }
  }
  return { gh, calls }
}

const GITHUB = "https://github.com/acme/widget.git"
const PR = "https://github.com/acme/widget/pull/7"

describe("P2-T09 the PR the session reported is verified (A37)", () => {
  it("S57: mark_done with a reported github prUrl, PR open, head on the remote → done with prUrl", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const { gh, calls } = r.gh({ url: PR, state: "OPEN", headRefName: "fix/x" })
    const verified = verifyPr({
      reportedUrl: PR,
      cwdFacts: { branch: "fix/x", pushed: true },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh,
    })
    expect(verified).toEqual({ url: PR, headRefName: "fix/x" })
    expect(calls[0]).toEqual([
      "pr",
      "view",
      PR,
      "--json",
      "url,state,headRefName,headRefOid,mergedAt",
    ])
    expect(
      decideTurnEnd(input({ latch: marked({ prUrl: PR }), finish: "pr", pr: () => verified })),
    ).toEqual({ kind: "close", completion: { by: "session", summary: "Fixed it", prUrl: PR } })
  })

  it("S57: Atelier in a worktree branch, cwd on main, reported PR open → done", () => {
    const r = forgeRepo(GITHUB)
    const tree = path.join(path.dirname(r.work), "tree")
    sh(r.work, "worktree", "add", "-q", "-b", "atelier/fix-x", tree)
    r.commitOn("atelier/fix-x", tree)
    r.push("atelier/fix-x")
    const { gh } = r.gh({ url: PR, state: "OPEN", headRefName: "atelier/fix-x" })
    const verified = verifyPr({
      reportedUrl: PR,
      cwdFacts: { branch: "main", pushed: true },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh,
    })
    expect(verified).toEqual({ url: PR, headRefName: "atelier/fix-x" })
    expect(
      decideTurnEnd(
        input({
          latch: marked({ prUrl: PR }),
          atelier: atelier({ status: "complete" }),
          finish: "pr",
          pr: () => verified,
        }),
      ),
    ).toMatchObject({ kind: "close", completion: { by: "session", prUrl: PR } })
  })

  it("S57: a local branch ahead of what was pushed is not the PR's head", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    r.commitOn("fix/x-more")
    const { gh } = r.gh({ url: PR, state: "OPEN", headRefName: "fix/x" })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh,
      }),
    ).toBeNull()
  })

  it("S57: a reported prUrl of another repo → pr_missing", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const other = "https://github.com/acme/other/pull/7"
    const { gh, calls } = r.gh({ url: other, state: "OPEN", headRefName: "fix/x" })
    const verified = verifyPr({
      reportedUrl: other,
      cwdFacts: { branch: "fix/x", pushed: true },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh,
    })
    expect(verified).toBeNull()
    expect(calls).toEqual([])
    expect(
      decideTurnEnd(input({ latch: marked({ prUrl: other }), finish: "pr", pr: () => verified })),
    ).toEqual(prMissing)
  })

  it("S57: a reported PR whose state is CLOSED → pr_missing", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const { gh } = r.gh({ url: PR, state: "CLOSED", headRefName: "fix/x" })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh,
      }),
    ).toBeNull()
    // MERGED counts.
    const merged = r.gh({ url: PR, state: "MERGED", headRefName: "fix/x" })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: merged.gh,
      }),
    ).toEqual({ url: PR, headRefName: "fix/x" })
  })

  it("S57: pushed main + no PR (at Open) → pr_missing", () => {
    const r = forgeRepo(GITHUB)
    r.commitOn("on-main")
    r.push("main")
    // The cwd path (no reported URL): even a PR gh finds for main never counts (D38).
    const verified = verifyPr({
      cwdFacts: { branch: "main", pushed: true, prUrl: PR },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh: r.gh({ url: PR, state: "OPEN", headRefName: "main" }).gh,
    })
    expect(verified).toBeNull()
    expect(decideTurnEnd(input({ latch: marked(), finish: "pr", pr: () => verified }))).toEqual(
      prMissing,
    )
    // The cwd path on an own pushed branch with the PR gh found: verified.
    sh(r.work, "switch", "-q", "-c", "fix/y")
    r.commitOn("fix/y")
    r.push("fix/y")
    expect(
      verifyPr({
        cwdFacts: { branch: "fix/y", pushed: true, prUrl: PR },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: r.gh({ url: PR, state: "OPEN", headRefName: "fix/y" }).gh,
      }),
    ).toEqual({ url: PR, headRefName: "fix/y" })
  })

  it("S57: a reported PR whose head is develop → pr_missing", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "Develop")
    r.commitOn("Develop")
    r.push("Develop")
    const { gh } = r.gh({ url: PR, state: "OPEN", headRefName: "Develop" })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "Develop", pushed: true },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh,
      }),
    ).toBeNull()
  })

  it("S57: a gitlab remote with prUrl https on that host and a pushed non-default branch → done; on another host → pr_missing", () => {
    const r = forgeRepo("https://gitlab.example.com/acme/widget.git")
    sh(r.work, "switch", "-q", "-c", "fix/z")
    r.commitOn("fix/z")
    r.push("fix/z")
    // The cwd is back on main: the pushed branch is found among the local ones.
    sh(r.work, "switch", "-q", "main")
    // The forge's ref for merge request 3 is that branch's tip (its source).
    r.mergeRequest(3, r.tip("fix/z"))
    const mr = "https://gitlab.example.com/acme/widget/-/merge_requests/3"
    const verified = verifyPr({
      reportedUrl: mr,
      cwdFacts: { branch: "main" },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh: null,
    })
    expect(verified).toEqual({ url: mr, headRefName: "fix/z" })
    expect(
      decideTurnEnd(input({ latch: marked({ prUrl: mr }), finish: "pr", pr: () => verified })),
    ).toMatchObject({ kind: "close", completion: { by: "session", prUrl: mr } })
    expect(
      verifyPr({
        reportedUrl: "https://gitlab.other.example/acme/widget/-/merge_requests/3",
        cwdFacts: { branch: "main" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
      }),
    ).toBeNull()
    // Only main pushed: no branch of the session's own is on the remote.
    const bare = forgeRepo("https://gitlab.example.com/acme/widget.git")
    expect(
      verifyPr({
        reportedUrl: mr,
        cwdFacts: { branch: "main" },
        guarded: GUARDED,
        git: bare.git,
        since: bare.since,
        gh: null,
      }),
    ).toBeNull()
  })
})

// ── F3 (D43): a PR the session did not make never counts ──

describe("P2-T09 the PR is tied to this session (D43 F3)", () => {
  it("S57: an old MERGED PR of this repo whose head branch is still on the remote → pr_missing, with or without a local copy", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "old/feature")
    r.commitOn("old/feature")
    r.push("old/feature")
    sh(r.work, "switch", "-q", "main")
    sh(r.work, "merge", "-q", "--no-ff", "-m", "merge old/feature", "old/feature")
    // The session starts here and does no work.
    r.begin()
    const old = {
      url: PR,
      state: "MERGED",
      headRefName: "old/feature",
      mergedAt: "2026-01-01T00:00:00Z",
    }
    // The local copy, at the merged commit (an ancestor of the session's start).
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "main" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: r.gh(old).gh,
      }),
    ).toBeNull()
    // No local copy at all (the branch was deleted here, never on the remote).
    sh(r.work, "branch", "-q", "-D", "old/feature")
    const verified = verifyPr({
      reportedUrl: PR,
      cwdFacts: { branch: "main" },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh: r.gh(old).gh,
    })
    expect(verified).toBeNull()
    expect(
      decideTurnEnd(input({ latch: marked({ prUrl: PR }), finish: "pr", pr: () => verified })),
    ).toEqual(prMissing)
  })

  it("S57: a PR merged before the session started is refused even on a pushed branch; one merged since counts", () => {
    const r = forgeRepo(GITHUB)
    r.begin()
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const before = new Date(r.since.at - 60_000).toISOString()
    const view = { url: PR, state: "MERGED", headRefName: "fix/x" }
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: r.gh({ ...view, mergedAt: before }).gh,
      }),
    ).toBeNull()
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: r.gh(view).gh,
      }),
    ).toEqual({ url: PR, headRefName: "fix/x" })
  })

  it("S57: a GitHub PR whose head commit is not the session branch's pushed tip → pr_missing", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const { gh } = r.gh({ url: PR, state: "OPEN", headRefName: "fix/x", headRefOid: r.since.head })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x", pushed: true },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh,
      }),
    ).toBeNull()
  })

  it("S57 (batch-2 F3): a start HEAD the repo does not have (history rewritten, shallow clone) is not provably the session's → pr_missing", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const view = { url: PR, state: "OPEN", headRefName: "fix/x" }
    const args = {
      reportedUrl: PR,
      cwdFacts: { branch: "fix/x", pushed: true },
      guarded: GUARDED,
      git: r.git,
    }
    // Control: with the real start, the same PR counts.
    expect(verifyPr({ ...args, since: r.since, gh: r.gh(view).gh })).toEqual({
      url: PR,
      headRefName: "fix/x",
    })
    const verified = verifyPr({
      ...args,
      since: { ...r.since, head: "0123456789abcdef0123456789abcdef01234567" },
      gh: r.gh(view).gh,
    })
    expect(verified).toBeNull()
    expect(
      decideTurnEnd(input({ latch: marked({ prUrl: PR }), finish: "pr", pr: () => verified })),
    ).toEqual(prMissing)
  })

  const GITLAB = "https://gitlab.example.com/acme/widget.git"
  const MR = "https://gitlab.example.com/acme/widget/-/merge_requests/3"

  it("S57 (other hosts): a URL into another repo on the same host → pr_missing", () => {
    const r = forgeRepo(GITLAB)
    sh(r.work, "switch", "-q", "-c", "fix/z")
    r.commitOn("fix/z")
    r.push("fix/z")
    r.mergeRequest(3, r.tip("fix/z"))
    for (const url of [
      "https://gitlab.example.com/acme/other/-/merge_requests/3",
      "https://gitlab.example.com/anything",
    ]) {
      expect(
        verifyPr({
          reportedUrl: url,
          cwdFacts: { branch: "fix/z" },
          guarded: GUARDED,
          git: r.git,
          since: r.since,
          gh: null,
        }),
      ).toBeNull()
    }
  })

  it("S57 (other hosts): a feature branch pushed before the session started → pr_missing", () => {
    const r = forgeRepo(GITLAB)
    sh(r.work, "switch", "-q", "-c", "fix/old")
    r.commitOn("fix/old")
    r.push("fix/old")
    r.mergeRequest(3, r.tip("fix/old"))
    // Months later, a session starts on that branch and pushes nothing.
    r.begin()
    expect(
      verifyPr({
        reportedUrl: MR,
        cwdFacts: { branch: "fix/old" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
      }),
    ).toBeNull()
  })

  it("S57 (D43 F3, batch-2 F1): a session on main that does nothing and reports an old feature branch's open PR → pr_missing; a commit made on it since → done", () => {
    const r = forgeRepo(GITHUB)
    sh(r.work, "switch", "-q", "-c", "fix/old")
    r.commitOn("fix/old")
    r.push("fix/old")
    sh(r.work, "switch", "-q", "main")
    // Months later, a session starts on main and does nothing.
    r.begin()
    const verified = verifyPr({
      reportedUrl: PR,
      cwdFacts: { branch: "main" },
      guarded: GUARDED,
      git: r.git,
      since: r.since,
      gh: r.gh({ url: PR, state: "OPEN", headRefName: "fix/old" }).gh,
    })
    expect(verified).toBeNull()
    expect(
      decideTurnEnd(input({ latch: marked({ prUrl: PR }), finish: "pr", pr: () => verified })),
    ).toEqual(prMissing)
    // The session does work on that branch and pushes it: its own now.
    sh(r.work, "switch", "-q", "fix/old")
    writeFileSync(path.join(r.work, "more.ts"), "export const y = 2\n")
    sh(r.work, "add", "more.ts")
    sh(r.work, "commit", "-q", "-m", "more")
    r.push("fix/old")
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/old" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: r.gh({ url: PR, state: "OPEN", headRefName: "fix/old" }).gh,
      }),
    ).toEqual({ url: PR, headRefName: "fix/old" })
  })

  it("S57 (other hosts, D43 F3, batch-2 F1): a session on main that does nothing and reports an old branch's merge request → pr_missing", () => {
    const r = forgeRepo(GITLAB)
    sh(r.work, "switch", "-q", "-c", "fix/old")
    r.commitOn("fix/old")
    r.push("fix/old")
    r.mergeRequest(3, r.tip("fix/old"))
    sh(r.work, "switch", "-q", "main")
    r.begin()
    for (const url of [
      MR,
      "https://gitlab.example.com/acme/widget/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Fold",
    ]) {
      expect(
        verifyPr({
          reportedUrl: url,
          cwdFacts: { branch: "main" },
          guarded: GUARDED,
          git: r.git,
          since: r.since,
          gh: null,
        }),
      ).toBeNull()
    }
  })

  it("S57 (other hosts): a merge request whose source is another commit → pr_missing; the new-merge-request link git push prints names the branch → done", () => {
    const r = forgeRepo(GITLAB)
    sh(r.work, "switch", "-q", "-c", "fix/z")
    r.commitOn("fix/z")
    r.push("fix/z")
    r.mergeRequest(3, r.since.head)
    expect(
      verifyPr({
        reportedUrl: MR,
        cwdFacts: { branch: "fix/z" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
      }),
    ).toBeNull()
    const printed =
      "https://gitlab.example.com/acme/widget/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Fz"
    expect(
      verifyPr({
        reportedUrl: printed,
        cwdFacts: { branch: "main" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
      }),
    ).toEqual({ url: printed, headRefName: "fix/z" })
    // The same link naming a branch the session never pushed: refused.
    expect(
      verifyPr({
        reportedUrl: printed.replace("fix%2Fz", "fix%2Fnone"),
        cwdFacts: { branch: "main" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
      }),
    ).toBeNull()
  })
})

// ── F4 (D43): an ssh host alias is resolved by ssh's own config ──

/** A fixture ssh config (never the owner's own): two aliases of the forges. */
function sshFixture(): string {
  const file = path.join(scratch, `ssh-config-${Math.random().toString(36).slice(2)}`)
  writeFileSync(
    file,
    [
      "Host gh-work",
      "  HostName github.com",
      "  User git",
      "Host gitlab-work",
      "  HostName gitlab.com",
      "  User git",
      "",
    ].join("\n"),
  )
  return file
}

/** The forge host as `ssh -G -F <fixture> <alias>` resolves it. */
const resolved = (url: string, alias: string, file: string) =>
  sshRemoteTarget(url, alias, scratch, (h) => readSshConfig(h, file)).hostname

describe("P2-T09 the PR check behind an ssh host alias (D43 F4)", () => {
  it("S57: origin git@gh-work:… (an alias of github.com) is checked as GitHub through gh", () => {
    const file = sshFixture()
    const origin = "git@gh-work:acme/widget.git"
    expect(resolved(origin, "gh-work", file)).toBe("github.com")
    const r = forgeRepo(origin)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const { gh, calls } = r.gh({ url: PR, state: "OPEN", headRefName: "fix/x" })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x", pushed: true },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh,
        forgeHost: resolved(origin, "gh-work", file),
      }),
    ).toEqual({ url: PR, headRefName: "fix/x" })
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", PR])
  })

  it("S57: origin git@gitlab-work:… (an alias of gitlab.com) accepts a merge request on gitlab.com", () => {
    const file = sshFixture()
    const origin = "git@gitlab-work:group/repo.git"
    const r = forgeRepo(origin)
    sh(r.work, "switch", "-q", "-c", "fix/z")
    r.commitOn("fix/z")
    r.push("fix/z")
    r.mergeRequest(3, r.tip("fix/z"))
    const mr = "https://gitlab.com/group/repo/-/merge_requests/3"
    expect(
      verifyPr({
        reportedUrl: mr,
        cwdFacts: { branch: "fix/z" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
        forgeHost: resolved(origin, "gitlab-work", file),
      }),
    ).toEqual({ url: mr, headRefName: "fix/z" })
  })
})

/** A fixture ssh config for the forges' ssh-over-443 endpoints (GitHub's and GitLab's documented workaround). */
function ssh443Fixture(): string {
  const file = path.join(scratch, `ssh-443-${Math.random().toString(36).slice(2)}`)
  writeFileSync(
    file,
    [
      "Host github.com",
      "  HostName ssh.github.com",
      "  Port 443",
      "  User git",
      "Host gitlab.com",
      "  HostName altssh.gitlab.com",
      "  Port 443",
      "  User git",
      "",
    ].join("\n"),
  )
  return file
}

describe("P2-T09 the PR check over ssh on port 443 (batch-2 F2)", () => {
  it("S57: origin git@github.com:… with HostName ssh.github.com is still GitHub: gh is asked and the open PR counts", () => {
    const file = ssh443Fixture()
    const origin = "git@github.com:acme/widget.git"
    expect(resolved(origin, "github.com", file)).toBe("ssh.github.com")
    const r = forgeRepo(origin)
    sh(r.work, "switch", "-q", "-c", "fix/x")
    r.commitOn("fix/x")
    r.push("fix/x")
    const { gh, calls } = r.gh({ url: PR, state: "OPEN", headRefName: "fix/x" })
    expect(
      verifyPr({
        reportedUrl: PR,
        cwdFacts: { branch: "fix/x", pushed: true },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh,
        forgeHost: resolved(origin, "github.com", file),
      }),
    ).toEqual({ url: PR, headRefName: "fix/x" })
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", PR])
  })

  it("S57: the node's forge host: GitHub when either host is, a 443 endpoint as its forge, else the resolved host", () => {
    expect(forgeHostOf("github.com", "ssh.github.com")).toBe("github.com")
    expect(forgeHostOf("gh-work", "github.com")).toBe("github.com")
    expect(forgeHostOf("github.com", "proxy.example.com")).toBe("github.com")
    expect(forgeHostOf("gitlab.com", "altssh.gitlab.com")).toBe("gitlab.com")
    expect(forgeHostOf("gitlab-work", "gitlab.example.com")).toBe("gitlab.example.com")
    expect(forgeHostOf("gitlab.example.com")).toBe("gitlab.example.com")
    expect(forgeHostOf(undefined, undefined)).toBeUndefined()
  })

  it("S57: origin git@gitlab.com:… with HostName altssh.gitlab.com accepts a merge request on gitlab.com", () => {
    const file = ssh443Fixture()
    const origin = "git@gitlab.com:group/repo.git"
    expect(resolved(origin, "gitlab.com", file)).toBe("altssh.gitlab.com")
    const r = forgeRepo(origin)
    sh(r.work, "switch", "-q", "-c", "fix/z")
    r.commitOn("fix/z")
    r.push("fix/z")
    r.mergeRequest(3, r.tip("fix/z"))
    const mr = "https://gitlab.com/group/repo/-/merge_requests/3"
    expect(
      verifyPr({
        reportedUrl: mr,
        cwdFacts: { branch: "fix/z" },
        guarded: GUARDED,
        git: r.git,
        since: r.since,
        gh: null,
        forgeHost: resolved(origin, "gitlab.com", file),
      }),
    ).toEqual({ url: mr, headRefName: "fix/z" })
  })
})

describe("P2-T09 the empty-continue counter (D15, A2, A36)", () => {
  it("S32: progress since the previous continue resets the empty count; the total never resets", () => {
    const c = new AutoContinue()
    c.turnEnd({ git: "a", atelier: null })
    c.continued()
    c.turnEnd({ git: "a", atelier: null })
    c.continued()
    expect({ empty: c.empty, total: c.total }).toEqual({ empty: 2, total: 2 })
    // A changed git status fingerprint is progress.
    c.turnEnd({ git: "b", atelier: null })
    expect(c.empty).toBe(0)
    c.continued()
    // A TodoWrite whose completed count rose; then one that did not.
    c.todo(2)
    c.turnEnd({ git: "b", atelier: null })
    expect(c.empty).toBe(0)
    c.continued()
    c.todo(2)
    c.turnEnd({ git: "b", atelier: null })
    expect(c.empty).toBe(1)
    c.continued()
    // An Atelier phase or done[] change.
    c.turnEnd({ git: "b", atelier: "validate" })
    expect(c.empty).toBe(0)
    expect(c.total).toBe(5)
  })
})
