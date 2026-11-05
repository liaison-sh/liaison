// SPDX-License-Identifier: FSL-1.1-ALv2
//
// NO SECRET OF THIS COMPUTER EVER ENTERS A SESSION'S SANDBOX (D53, P1b B1/B4).
//
// The node reads this computer's credential for the session's remotes OUTSIDE
// the sandbox (`gh auth token` for github.com, git's own helpers for another
// HTTPS host) and keeps it in the sidecar's memory. It never hands it over:
// the broker on a Unix socket the node listens on is an ACTION broker. It
// runs, itself and outside the sandbox, what needs the credential, and sends
// back only the output and the exit code:
//
//   <sessionDir>/bin/git   `git push|fetch|pull` of a repository the node
//                          resolved (an HTTPS remote): the broker pushes the
//                          session's own branch to the URL the node read from
//                          the owner's config, or fetches into that git dir
//   <sessionDir>/bin/gh    the allowed gh verbs, run by the broker with the
//                          login, on the session's own repository only
//
// So no process in the sandbox (a script the session writes included) can
// obtain a token or a password: the broker has no request that answers with
// one, its replies are scrubbed of every secret it holds, and the session's
// environment carries none. An SSH remote is served the same way: the node's
// git pushes and fetches it with the owner's agent, which never reaches the
// session (a session holding the agent could sign a push of any branch to any
// repository the key reaches, past every hook). The node's own clone
// gets the credential through its process environment only (B4).

import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * P1b-fix F1: gh's command lines, as an explicit grammar per allowed verb.
 * Deny by default: a flag not named here (any `-R`/`--repo` spelling, a short
 * cluster such as `-dR`, `--web`, `--editor`), a flag with the wrong arity, a
 * positional that is not the verb's own (a URL names another repository), or
 * anything before the group is refused. The target repository is never read
 * from argv: the shim sets it to the session's origin.
 */
interface GhVerbGrammar {
  /** Flag spelling → its arity (0: a switch, 1: takes a value). */
  flags: Readonly<Record<string, 0 | 1>>
  /** How many positionals the verb takes, and what each may look like. */
  positional: { max: number; min?: number; ok: (a: string) => boolean }
}

const GH_NUMBER = (a: string) => /^#?[0-9]{1,12}$/.test(a)
/** A pull request by number, or by branch name (never a URL: no `:`). */
const GH_PR_REF = (a: string) => GH_NUMBER(a) || /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,250}$/.test(a)
/**
 * --json only: no --jq or --template, which run a filter inside gh, next to
 * its login. The session filters the JSON with its own jq, in the sandbox.
 */
const READ_FLAGS: Readonly<Record<string, 0 | 1>> = {
  "--json": 1,
}

export const GH_GRAMMAR: Readonly<Record<string, GhVerbGrammar>> = {
  "pr create": {
    flags: {
      "--title": 1,
      "-t": 1,
      "--body": 1,
      "-b": 1,
      "--body-file": 1,
      "-F": 1,
      "--base": 1,
      "-B": 1,
      "--head": 1,
      "-H": 1,
      "--label": 1,
      "-l": 1,
      "--draft": 0,
      "-d": 0,
      "--fill": 0,
      "-f": 0,
    },
    positional: { max: 0, ok: () => false },
  },
  "pr view": {
    flags: { ...READ_FLAGS, "--comments": 0, "-c": 0 },
    positional: { max: 1, ok: GH_PR_REF },
  },
  "pr list": {
    flags: {
      ...READ_FLAGS,
      "--state": 1,
      "-s": 1,
      "--limit": 1,
      "-L": 1,
      "--head": 1,
      "-H": 1,
      "--base": 1,
      "-B": 1,
      "--label": 1,
      "-l": 1,
      "--author": 1,
      "-A": 1,
      "--draft": 0,
      "-d": 0,
    },
    positional: { max: 0, ok: () => false },
  },
  "run view": {
    flags: {
      ...READ_FLAGS,
      "--log": 0,
      "--log-failed": 0,
      "--verbose": 0,
      "-v": 0,
      "--exit-status": 0,
      "--job": 1,
      "-j": 1,
      "--attempt": 1,
      "-a": 1,
    },
    positional: { max: 1, ok: GH_NUMBER },
  },
  "issue view": {
    flags: { ...READ_FLAGS, "--comments": 0, "-c": 0 },
    positional: { min: 1, max: 1, ok: GH_NUMBER },
  },
}

export type GhParse = { ok: true; verb: string } | { ok: false; reason: string }

/** gh's argv (past `gh`) against the grammar: the verb, or why it is refused. */
export function parseGhCommand(argv: readonly string[]): GhParse {
  const [group, action, ...rest] = argv
  const verb = `${group ?? ""} ${action ?? ""}`.trim()
  const grammar =
    group && action && !group.startsWith("-") && !action.startsWith("-")
      ? GH_GRAMMAR[verb]
      : undefined
  if (!grammar) {
    return {
      ok: false,
      reason: `gh ${verb || "(nothing)"}: not allowed (only ${Object.keys(GH_GRAMMAR).join(", ")}, without a flag first)`,
    }
  }
  let positionals = 0
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a.startsWith("-")) {
      if (a === "-" || a === "--") return { ok: false, reason: `gh ${verb}: ${a} is not allowed` }
      const eq = a.startsWith("--") ? a.indexOf("=") : -1
      const name = eq > 0 ? a.slice(0, eq) : a
      const arity = Object.hasOwn(grammar.flags, name) ? grammar.flags[name] : undefined
      if (arity === undefined) {
        const next = rest[i + 1]
        const shown = (eq < 0 && next && !next.startsWith("-") ? `${a} ${next}` : a).slice(0, 80)
        return {
          ok: false,
          reason: `gh ${verb}: ${shown} is not an allowed flag (the repository is always this session's)`,
        }
      }
      if (eq > 0) {
        if (arity !== 1) return { ok: false, reason: `gh ${verb}: ${name} takes no value` }
      } else if (arity === 1) {
        if (i + 1 >= rest.length) return { ok: false, reason: `gh ${verb}: ${name} needs a value` }
        i++
      }
    } else {
      positionals++
      if (positionals > grammar.positional.max || !grammar.positional.ok(a)) {
        return { ok: false, reason: `gh ${verb}: ${a} is not an argument it takes` }
      }
    }
  }
  if (positionals < (grammar.positional.min ?? 0)) {
    return { ok: false, reason: `gh ${verb}: name what to view` }
  }
  return { ok: true, verb }
}

/** The node's credential for one remote (read outside the sandbox), for its own clone and the broker. */
export interface CredentialScope {
  /** Lowercase host (`github.com`, `gitlab.example.com:8443`). */
  host: string
  /** `owner/repo`, lowercase, no `.git`. */
  repoPath: string
  /** HTTPS remotes: the credential the node's own git authenticates with. */
  git?: { username: string; password: string } | null
  /** github.com (HTTPS or SSH): the token the broker's own gh runs with. */
  ghToken?: string | null
}

/** `https://h/owner/repo.git`, `git@h:owner/repo`, `ssh://git@h/owner/repo` → `owner/repo`. */
export function remoteRepoPath(url: string): string | null {
  const u = url.trim()
  let raw: string | null = null
  const scp = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:(?!\/\/)([^\s]+)$/.exec(u)
  if (scp && !u.includes("://") && !path.isAbsolute(u)) raw = scp[1] as string
  else {
    try {
      raw = decodeURIComponent(new URL(u).pathname)
    } catch {
      raw = null
    }
  }
  return raw ? normaliseRepoPath(raw) : null
}

function normaliseRepoPath(raw: string): string | null {
  const p = raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase()
  if (!p || p.split("/").some((s) => s === "" || s === "." || s === "..")) return null
  return p
}

// ── The action broker: the node pushes, fetches and runs gh, never the session ──

/** One repository the broker pushes and fetches for: an HTTPS remote the node resolved. */
export interface BrokerRepo {
  /** The repository's git dir (real path): the key a session's request names. */
  gitDir: string
  /** The remote URL the node read from the owner's config at start: the only one used. */
  url: string
  /** The one branch a session may push there; none: nothing is pushed. */
  branch?: string
  /** Branch names never pushed (lowercase): the default and the node's protected ones. */
  protected: readonly string[]
  /** The node's credential for that remote; never sent to the session. */
  credential: { username: string; password: string } | null
}

/** gh, run by the broker with this computer's login, for the session's own GitHub repository. */
export interface BrokerGh {
  /** The real gh (an absolute path, write-denied to the session). */
  bin: string
  token: string
  /** `owner/repo` of this repository's origin. */
  repoPath: string
  /** The repository's checkout, gh's cwd (it reads the current branch there). */
  cwd: string
  /** The session's own branch there: the only head `gh pr create` opens a pull request for. */
  branch: string | null
  /** The repository's git dir, resolved: the gh shim names the one it runs in. */
  gitDir: string
  /** The session's checkout itself (not a submodule of it). */
  origin?: boolean
}

export interface BrokerPlan {
  /** The real git the broker runs (an absolute path, write-denied to the session). */
  git: string
  repos: readonly BrokerRepo[]
  /**
   * gh for each repository of the session on github.com (the checkout's and
   * its submodules'), each pinned to its own repository and branch.
   */
  gh: readonly BrokerGh[]
  /** The node's git environment (no owner config, no prompt). */
  env: Record<string, string>
  timeoutMs?: number
}

/** What a broker request comes back as: the output, never a secret. */
export interface BrokerResult {
  code: number
  out: string
  err: string
  /** `git pull`: after the fetch, the shim integrates this ref with `merge` or `rebase`. */
  integrate?: { mode: "merge" | "rebase"; ref: string; flags: string[] }
}

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}$/
const REMOTE_NAME = /^[A-Za-z0-9._-]{1,100}$/
const refuse = (what: string, reason: string, allowed: string): BrokerResult => ({
  code: 1,
  out: "",
  err: `Liaison node: ${what} refused: ${reason}. Allowed: ${allowed}\n`,
})

export type PushDecision =
  | { ok: true; branch: string; flags: string[] }
  | { ok: false; reason: string }

const PUSH_FLAGS: Readonly<Record<string, string | null>> = {
  "-q": "-q",
  "--quiet": "-q",
  "-v": "-v",
  "--verbose": "-v",
  "-n": "--dry-run",
  "--dry-run": "--dry-run",
  "--porcelain": "--porcelain",
  // The upstream is a config write the session never makes; the push needs none.
  "-u": null,
  "--set-upstream": null,
}

/**
 * A session's `git push` arguments against the repository the broker serves:
 * a remote NAME whose URL in the owner's config is the resolved one, and
 * exactly the session's own branch, never forced, deleted, a tag, a pattern
 * or a protected name. `remoteUrl` reads the owner's config; `head` the
 * branch HEAD names.
 */
export function decidePush(
  args: readonly string[],
  repo: Pick<BrokerRepo, "url" | "branch" | "protected">,
  remoteUrl: (name: string) => string | null,
  head: () => string | null,
): PushDecision {
  const flags: string[] = []
  const positional: string[] = []
  for (const a of args) {
    if (a.startsWith("-")) {
      if (!Object.hasOwn(PUSH_FLAGS, a)) {
        return {
          ok: false,
          reason: `${a} is not allowed (no force, delete, tags, mirror or options)`,
        }
      }
      const kept = PUSH_FLAGS[a]
      if (kept && !flags.includes(kept)) flags.push(kept)
    } else positional.push(a)
  }
  const own = repo.branch
  if (!own) return { ok: false, reason: "this session has no branch of its own in this repository" }
  if (repo.protected.includes(own.toLowerCase())) {
    return { ok: false, reason: `${own} is a protected branch` }
  }
  if (positional.length !== 2) {
    return { ok: false, reason: "name the remote and the branch" }
  }
  const [remote, refspec] = positional as [string, string]
  if (!REMOTE_NAME.test(remote) || /^\.+$/.test(remote)) {
    return {
      ok: false,
      reason: `${remote.slice(0, 80)} is not a remote name (never a URL or a path)`,
    }
  }
  if (remoteUrl(remote) !== repo.url) {
    return { ok: false, reason: `${remote} is not this repository's remote` }
  }
  if (refspec.startsWith("+")) return { ok: false, reason: "a forced refspec is not allowed" }
  if (/[*?[\\^~\s]/.test(refspec)) return { ok: false, reason: "a pattern refspec is not allowed" }
  const colon = refspec.indexOf(":")
  const strip = (r: string) => (r.startsWith("refs/heads/") ? r.slice("refs/heads/".length) : r)
  let source = strip(colon >= 0 ? refspec.slice(0, colon) : refspec)
  const target = strip(colon >= 0 ? refspec.slice(colon + 1) : refspec)
  if (!source) return { ok: false, reason: "deleting a branch is not allowed" }
  if (source === "HEAD" || source === "@") source = head() ?? ""
  const dest = colon >= 0 ? target : source
  if (source !== own || dest !== own) {
    return { ok: false, reason: `only this session's branch ${own} is pushed here` }
  }
  return { ok: true, branch: own, flags }
}

export type FetchDecision =
  | {
      ok: true
      remote: string
      refspecs: string[]
      flags: string[]
      integrate?: BrokerResult["integrate"]
    }
  | { ok: false; reason: string }

const FETCH_FLAGS: Readonly<Record<string, string>> = {
  "-q": "-q",
  "--quiet": "-q",
  "-v": "-v",
  "--verbose": "-v",
  "-p": "--prune",
  "--prune": "--prune",
}
const PULL_MODES: Readonly<Record<string, { mode: "merge" | "rebase"; flag?: string }>> = {
  "--rebase": { mode: "rebase" },
  "-r": { mode: "rebase" },
  "--no-rebase": { mode: "merge" },
  "--ff-only": { mode: "merge", flag: "--ff-only" },
  "--ff": { mode: "merge", flag: "--ff" },
  "--no-ff": { mode: "merge", flag: "--no-ff" },
}

/**
 * `git fetch [remote [branch…]]` and `git pull <remote> <branch>`: the
 * resolved remote's branches into `refs/remotes/<remote>/`, nothing else.
 */
export function decideFetch(
  sub: "fetch" | "pull",
  args: readonly string[],
  repo: Pick<BrokerRepo, "url">,
  remoteUrl: (name: string) => string | null,
): FetchDecision {
  const flags: string[] = []
  const positional: string[] = []
  let mode: "merge" | "rebase" = "merge"
  const integrate: string[] = []
  for (const a of args) {
    if (!a.startsWith("-")) {
      positional.push(a)
      continue
    }
    if (Object.hasOwn(FETCH_FLAGS, a)) {
      const f = FETCH_FLAGS[a] as string
      if (!flags.includes(f)) flags.push(f)
    } else if (sub === "pull" && Object.hasOwn(PULL_MODES, a)) {
      const m = PULL_MODES[a] as { mode: "merge" | "rebase"; flag?: string }
      mode = m.mode
      if (m.flag) integrate.push(m.flag)
    } else {
      return { ok: false, reason: `${a} is not allowed` }
    }
  }
  const [remote = "origin", ...branches] = positional
  if (!REMOTE_NAME.test(remote) || /^\.+$/.test(remote)) {
    return {
      ok: false,
      reason: `${remote.slice(0, 80)} is not a remote name (never a URL or a path)`,
    }
  }
  if (remoteUrl(remote) !== repo.url) {
    return { ok: false, reason: `${remote} is not this repository's remote` }
  }
  if (branches.length > 20) return { ok: false, reason: "at most 20 branches at once" }
  for (const b of branches) {
    if (!BRANCH_NAME.test(b) || b.includes(":")) {
      return { ok: false, reason: `${b.slice(0, 80)} is not a branch name (no refspec)` }
    }
  }
  if (sub === "pull" && branches.length !== 1) {
    return { ok: false, reason: "name the remote and one branch" }
  }
  const refspecs =
    branches.length === 0
      ? [`+refs/heads/*:refs/remotes/${remote}/*`]
      : branches.map((b) => `+refs/heads/${b}:refs/remotes/${remote}/${b}`)
  return {
    ok: true,
    remote,
    refspecs,
    flags,
    ...(sub === "pull"
      ? { integrate: { mode, ref: `refs/remotes/${remote}/${branches[0]}`, flags: integrate } }
      : {}),
  }
}

/** Runs a program of the node's, collecting its output; never a shell. */
function run(
  bin: string,
  args: readonly string[],
  opts: { env: Record<string, string>; cwd: string; timeoutMs: number },
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, [...args], {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({ code: 1, out: "", err: `${String(error)}\n` })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    const keep = (into: Buffer[]) => (d: Buffer) => {
      size += d.length
      if (size <= MAX_OUTPUT) into.push(d)
    }
    child.stdout?.on("data", keep(out))
    child.stderr?.on("data", keep(err))
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
    child.on("error", (e) => err.push(Buffer.from(`${String(e)}\n`)))
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({
        code: code ?? (signal ? 124 : 1),
        out: Buffer.concat(out).toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
      })
    })
  })
}

const MAX_OUTPUT = 4 * 1024 * 1024

/** Every secret of the plan, replaced in what goes back to the session. */
function scrub(text: string, plan: BrokerPlan): string {
  let out = text
  const secrets = [
    ...plan.gh.map((g) => g.token),
    ...plan.repos.flatMap((r) => (r.credential ? [r.credential.password] : [])),
  ].filter((s) => s.length >= 4)
  for (const s of secrets) out = out.split(s).join("***")
  return out
}

/**
 * The node's own git in a served repository: its git dir named outright (no
 * `.git` file or work tree read), the owner's hooks and fsmonitor off, no
 * credential helper but the node's, which reads the credential from this
 * process's environment.
 */
function hostGit(plan: BrokerPlan, repo: BrokerRepo, args: readonly string[]) {
  const env: Record<string, string> = { ...plan.env, GIT_TERMINAL_PROMPT: "0" }
  const cred: string[] = ["-c", "credential.helper="]
  if (repo.credential) {
    env.LIAISON_BROKER_USER = repo.credential.username
    env.LIAISON_BROKER_PASSWORD = repo.credential.password
    cred.push(
      "-c",
      'credential.helper=!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$LIAISON_BROKER_USER" "$LIAISON_BROKER_PASSWORD"; }; f',
    )
  }
  return run(
    plan.git,
    [
      `--git-dir=${repo.gitDir}`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      "-c",
      // The URL's own transport only: https or ssh for a remote, file for a local path.
      `protocol.${transportOf(repo.url)}.allow=always`,
      ...cred,
      ...args,
    ],
    { env, cwd: repo.gitDir, timeoutMs: plan.timeoutMs ?? 300_000 },
  )
}

/**
 * The transport git uses for a served URL: a local path is file, `https://` is
 * https, and `ssh://` or the scp-like `user@host:path` is ssh (signed by the
 * owner's agent, here in the node: the agent never reaches the session).
 */
export function transportOf(url: string): "file" | "https" | "ssh" {
  if (path.isAbsolute(url)) return "file"
  return /^https:\/\//i.test(url) ? "https" : "ssh"
}

/** A value of the owner's config in a served repository, read by the node. */
async function configValue(
  plan: BrokerPlan,
  repo: BrokerRepo,
  key: string,
): Promise<string | null> {
  const r = await run(
    plan.git,
    [`--git-dir=${repo.gitDir}`, "-c", "core.fsmonitor=false", "config", "--get", key],
    { env: plan.env, cwd: repo.gitDir, timeoutMs: 20_000 },
  )
  return r.code === 0 ? r.out.trim() : null
}

/** A session's `git push|fetch|pull` in a repository the broker serves; `null`: not one (git runs as is). */
export async function brokerGit(
  plan: BrokerPlan,
  sub: string,
  gitDirClaim: string,
  args: readonly string[],
): Promise<BrokerResult | null> {
  let claimed: string
  try {
    claimed = realpathSync(gitDirClaim)
  } catch {
    return null
  }
  const repo = plan.repos.find((r) => r.gitDir === claimed)
  if (!repo) return null
  const urls = new Map<string, string | null>()
  for (const a of args) {
    if (!a.startsWith("-") && REMOTE_NAME.test(a) && !urls.has(a)) {
      urls.set(a, await configValue(plan, repo, `remote.${a}.url`))
    }
  }
  if (!urls.has("origin")) urls.set("origin", await configValue(plan, repo, "remote.origin.url"))
  const remoteUrl = (name: string) => urls.get(name) ?? null
  const finish = (
    r: { code: number; out: string; err: string },
    integrate?: BrokerResult["integrate"],
  ) => ({
    code: r.code,
    out: scrub(r.out, plan),
    err: scrub(r.err, plan),
    ...(integrate && r.code === 0 ? { integrate } : {}),
  })
  if (sub === "push") {
    const headRef = await run(
      plan.git,
      [`--git-dir=${repo.gitDir}`, "symbolic-ref", "--short", "-q", "HEAD"],
      { env: plan.env, cwd: repo.gitDir, timeoutMs: 20_000 },
    )
    const d = decidePush(args, repo, remoteUrl, () =>
      headRef.code === 0 ? headRef.out.trim() : null,
    )
    const allowed = repo.branch ? `git push origin ${repo.branch}` : "nothing in this repository"
    if (!d.ok) return refuse("git push", d.reason, allowed)
    // The session writes its own ref: a symbolic one would push another branch's
    // history. Read the ref once and push that commit, so a ref rewritten after
    // this check changes nothing.
    const ref = await run(
      plan.git,
      [
        `--git-dir=${repo.gitDir}`,
        "for-each-ref",
        "--format=%(symref) %(objectname) %(objecttype)",
        `refs/heads/${d.branch}`,
      ],
      { env: plan.env, cwd: repo.gitDir, timeoutMs: 20_000 },
    )
    const plain = /^ ([0-9a-f]{40}|[0-9a-f]{64}) commit$/.exec(ref.out.replace(/\n$/, ""))
    if (ref.code !== 0 || !plain) {
      return refuse("git push", `refs/heads/${d.branch} is not a plain branch`, allowed)
    }
    return finish(
      await hostGit(plan, repo, [
        "push",
        ...d.flags,
        repo.url,
        `${plain[1]}:refs/heads/${d.branch}`,
      ]),
    )
  }
  if (sub === "fetch" || sub === "pull") {
    const d = decideFetch(sub, args, repo, remoteUrl)
    const allowed = sub === "pull" ? "git pull origin <branch>" : "git fetch [origin [<branch>…]]"
    if (!d.ok) return refuse(`git ${sub}`, d.reason, allowed)
    return finish(
      await hostGit(plan, repo, ["fetch", ...d.flags, repo.url, ...d.refspecs]),
      d.integrate,
    )
  }
  return null
}

/**
 * `pr create --head` is the session's own branch: refused otherwise, and
 * added when absent (gh would otherwise read the head from the checkout).
 */
export function pinGhHead(argv: readonly string[], ownBranch: string | null): string[] | string {
  if (argv[0] !== "pr" || argv[1] !== "create") return [...argv]
  if (!ownBranch) return "this session has no branch of its own to open a pull request for"
  let named = false
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] as string
    const eq = a.startsWith("--") ? a.indexOf("=") : -1
    const name = eq > 0 ? a.slice(0, eq) : a
    if (name !== "--head" && name !== "-H") continue
    const value = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] ?? "")
    if (value !== ownBranch) return `--head is this session's branch (${ownBranch}) only`
    named = true
  }
  return named ? [...argv] : [...argv, "--head", ownBranch]
}

/**
 * The gh plan of the repository the shim ran in (its git dir, resolved);
 * elsewhere the checkout's own, or the session's only one. The claim only
 * picks among the plans the node made: each pins its repository and branch.
 */
export function ghPlanFor(plan: BrokerPlan, gitDirClaim: string): BrokerGh | string {
  if (plan.gh.length === 0) return "no repository of this session is on github.com"
  let claimed: string | null = null
  try {
    claimed = gitDirClaim ? realpathSync(gitDirClaim) : null
  } catch {
    claimed = null
  }
  const matched = claimed ? plan.gh.find((g) => g.gitDir === claimed) : undefined
  if (matched) return matched
  const fallback = plan.gh.find((g) => g.origin) ?? (plan.gh.length === 1 ? plan.gh[0] : undefined)
  return fallback ?? "run gh inside the repository it is for (cd into that submodule first)"
}

/** The flags of gh whose value is a file gh would read: the shim reads it in the sandbox instead. */
const GH_FILE_FLAGS = new Set(["--body-file", "-F"])

/**
 * A session's gh command, run by the broker with this computer's login, for
 * the allowed verbs on the session's own repository. A body file is read by
 * the shim inside the sandbox and sent as bytes: gh never opens a path the
 * session names.
 */
export async function brokerGh(
  plan: BrokerPlan,
  argv: readonly string[],
  body: Buffer | null,
  gitDirClaim = "",
): Promise<BrokerResult> {
  const allowed = `gh ${Object.keys(GH_GRAMMAR).join(", gh ")}`
  const gh = ghPlanFor(plan, gitDirClaim)
  if (typeof gh === "string") return refuse("gh", gh, "git push only")
  if (argv[0] === "auth") return refuse("gh", "the node's GitHub login is never printed", allowed)
  const parsed = parseGhCommand(argv)
  if (!parsed.ok) return refuse("gh", parsed.reason, allowed)
  const pinned = pinGhHead(argv, gh.branch)
  if (typeof pinned === "string") return refuse("gh", pinned, allowed)
  const args = pinned
  let tmp: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    const eq = a.startsWith("--") ? a.indexOf("=") : -1
    const name = eq > 0 ? a.slice(0, eq) : a
    if (!GH_FILE_FLAGS.has(name)) continue
    if (body === null) return refuse("gh", `${name} is read by the node's gh shim only`, allowed)
    if (!tmp) {
      tmp = mkdtempSync(path.join(tmpdir(), "lia-gh-"))
      writeFileSync(path.join(tmp, "body"), body, { mode: 0o600 })
    }
    const file = path.join(tmp, "body")
    if (eq > 0) args[i] = `${name}=${file}`
    else args[i + 1] = file
  }
  const home = mkdtempSync(path.join(tmpdir(), "lia-ghh-"))
  try {
    // The login sits in this run's own config file, never in gh's environment:
    // a --jq filter reads the environment ($ENV), so a token there would be
    // one transform away from the session (scrub matches it only verbatim).
    writeFileSync(
      path.join(home, "hosts.yml"),
      `github.com:\n    oauth_token: ${gh.token}\n    git_protocol: https\n`,
      { mode: 0o600 },
    )
    const env: Record<string, string> = {
      PATH: uniqPath([path.dirname(plan.git), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
      HOME: home,
      GH_CONFIG_DIR: home,
      GH_REPO: gh.repoPath,
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      // gh reads the current branch with git: the owner's hooks and fsmonitor off.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
      ...(plan.env.LANG ? { LANG: plan.env.LANG } : {}),
    }
    const r = await run(gh.bin, args, { env, cwd: gh.cwd, timeoutMs: plan.timeoutMs ?? 120_000 })
    return { code: r.code, out: scrub(r.out, plan), err: scrub(r.err, plan) }
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

const uniqPath = (dirs: string[]) => [...new Set(dirs)].join(":")

/** The broker's wire reply: the exit code and base64 output, never a secret. */
export function encodeBrokerReply(r: BrokerResult | null): string {
  if (!r) return "pass\n"
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
  return [
    `exit=${r.code}`,
    `out=${b64(r.out)}`,
    `err=${b64(r.err)}`,
    ...(r.integrate
      ? [
          `mode=${r.integrate.mode}`,
          `ref=${r.integrate.ref}`,
          `flags=${r.integrate.flags.join(" ")}`,
        ]
      : []),
    "",
  ].join("\n")
}

/**
 * One request: `git\0<push|fetch|pull>\0<git dir>\0arg…` or
 * `gh\0<"" | "b:"+body base64>\0<git dir or "">\0arg…`.
 */
export async function handleBrokerRequest(raw: Buffer, plan: BrokerPlan): Promise<string> {
  const fields = raw.toString("utf8").split("\0")
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop()
  const [op, a, b, ...rest] = fields
  if (op === "git" && a && b) {
    if (a !== "push" && a !== "fetch" && a !== "pull") return encodeBrokerReply(null)
    return encodeBrokerReply(await brokerGit(plan, a, b, rest))
  }
  if (op === "gh" && a !== undefined) {
    const body = a.startsWith("b:") ? Buffer.from(a.slice(2), "base64") : null
    return encodeBrokerReply(await brokerGh(plan, rest, body, b ?? ""))
  }
  return encodeBrokerReply({ code: 1, out: "", err: "Liaison node: not a broker request\n" })
}

/** A Unix socket path short enough for macOS (104 bytes), in a fresh 0700 folder. */
export function brokerSocketPath(base: string = tmpdir()): { dir: string; socket: string } {
  const candidates = [base, "/tmp"]
  for (const parent of candidates) {
    try {
      const real = realpathSync(parent)
      const dir = mkdtempSync(path.join(real, "lia-"))
      const socket = path.join(dir, "c.sock")
      if (Buffer.byteLength(socket) < 100) return { dir, socket }
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The next candidate.
    }
  }
  throw new Error("no folder short enough for the session's broker socket")
}

export interface CredentialBroker {
  socket: string
  close(): void
}

const MAX_REQUEST = 4 * 1024 * 1024

/** Listens for the session's git and gh shims. Logs nothing; answers with output only. */
export async function startCredentialBroker(opts: {
  plan: BrokerPlan
  socketBase?: string
}): Promise<CredentialBroker> {
  const { dir, socket } = brokerSocketPath(opts.socketBase)
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    const chunks: Buffer[] = []
    let size = 0
    conn.on("data", (d: Buffer) => {
      size += d.length
      if (size > MAX_REQUEST) conn.destroy()
      else chunks.push(d)
    })
    conn.on("end", () => {
      handleBrokerRequest(Buffer.concat(chunks), opts.plan)
        .then((reply) => conn.end(reply))
        .catch(() =>
          conn.end(
            encodeBrokerReply({ code: 1, out: "", err: "Liaison node: the broker failed\n" }),
          ),
        )
    })
    conn.on("error", () => conn.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => resolve())
  })
  chmodSync(socket, 0o600)
  return {
    socket,
    close: () => {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** zsh, never sh: bash (macOS's sh) imports functions from the environment (P1b-fix F2). */
const ZSH_CANDIDATES = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The zsh lines that print a broker reply's output and exit with its code. */
function replyLines(base64Decode: string): string[] {
  return [
    'lines=("${(@f)reply}")',
    "code=${${(M)lines:#exit=*}#exit=}",
    "out=${${(M)lines:#out=*}#out=}",
    "err=${${(M)lines:#err=*}#err=}",
    `[[ -n $out ]] && print -rn -- "$out" | ${base64Decode}`,
    `[[ -n $err ]] && print -rn -- "$err" | ${base64Decode} >&2`,
    'if [[ -z $code ]]; then print -ru2 -- "Liaison node: the node did not answer"; exit 1; fi',
  ]
}

/**
 * A shim, replaced whole: the one a run wrote before (read-only, perhaps from
 * an older version of this app) is removed first, then the new one created
 * without following a link. Rewriting it in place fails on its read-only mode,
 * which left a resumed session on the shims of the version that started it.
 */
function writeShim(file: string, body: string): void {
  rmSync(file, { force: true })
  const fd = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o555,
  )
  try {
    writeSync(fd, body)
  } finally {
    closeSync(fd)
  }
  chmodSync(file, 0o555)
}

/**
 * The gh shim, in `<sessionDir>/bin` (write-denied to the session, K8), first
 * on the session's PATH: it sends gh's arguments (and a body file's bytes,
 * read here in the sandbox) to the broker, which runs gh outside it with this
 * computer's login. No token ever reaches the session.
 */
export function writeGhShim(opts: {
  binDir: string
  socket: string
  /** The real git, which names the repository gh runs in (absolute; else none is named). */
  git?: string
  nc?: string
  zsh?: string | null
  platform?: NodeJS.Platform
}): string | null {
  const nc = opts.nc ?? "/usr/bin/nc"
  const zsh = opts.zsh !== undefined ? opts.zsh : ZSH_CANDIDATES.find((z) => existsSync(z))
  if (!zsh) return null
  const decode = `/usr/bin/base64 ${(opts.platform ?? process.platform) === "darwin" ? "-D" : "-d"}`
  mkdirSync(opts.binDir, { recursive: true, mode: 0o700 })
  const shim = path.join(opts.binDir, "gh")
  const script = [
    `#!${zsh} -f`,
    "# Liaison node (D53): gh runs in the node, outside the sandbox, with this computer's",
    "# login and for this session's repository only; only its output comes back.",
    "path=(/usr/bin /bin /usr/sbin /sbin)",
    'body=""',
    'args=("$@")',
    "for (( i = 1; i <= $#args; i++ )); do",
    '  f=""',
    "  case ${args[i]} in",
    "    (--body-file|-F) f=${args[i+1]-} ;;",
    "    (--body-file=*) f=${args[i]#--body-file=} ;;",
    "    (*) continue ;;",
    "  esac",
    // "b:" marks a body even when the file is empty ("" is no body file).
    '  if [[ $f == - ]]; then body="b:$(/usr/bin/base64 | /usr/bin/tr -d "\\n")"',
    '  else body="b:$(/usr/bin/base64 < "$f" | /usr/bin/tr -d "\\n")" || exit 1; fi',
    "done",
    // The repository gh runs in, by its git dir: the broker's plan for it.
    opts.git && path.isAbsolute(opts.git)
      ? `gd=$(${shq(opts.git)} rev-parse --absolute-git-dir 2>/dev/null) || gd=""`
      : 'gd=""',
    `reply=$({ printf 'gh\\0%s\\0%s\\0' "$body" "$gd"; for a in "$@"; do printf '%s\\0' "$a"; done; } | ${shq(nc)} -U ${shq(opts.socket)})`,
    ...replyLines(decode),
    "exit $code",
    "",
  ].join("\n")
  writeShim(shim, script)
  return shim
}

/**
 * The session's `git`, first on its PATH in `<sessionDir>/bin` (write-denied
 * to the session). With the broker (D53): `git push`, `git fetch` and
 * `git pull` in a repository the broker serves (its HTTPS or SSH remote, read
 * from the owner's config at start) go to the broker, which runs them outside
 * the sandbox with the node's credential or the owner's agent and sends back
 * only the output; a pull's merge or rebase then runs here. Everything else,
 * and every repository the broker does not serve, is the real git (which
 * holds no credential and no agent here).
 *
 * Final walk F2: `git push -u` records the upstream in the repository's
 * config, which a session never writes (D17): the push itself needs no
 * upstream, so the shim drops `-u` / `--set-upstream`. It grants nothing:
 * the level guard still judges the command as written, and the sandbox holds.
 */
export function writeGitPushShim(opts: {
  binDir: string
  git: string
  /** The broker's socket; without it, only the -u drop. */
  socket?: string
  nc?: string
  zsh?: string | null
  platform?: NodeJS.Platform
}): string {
  if (!path.isAbsolute(opts.git)) throw new Error("git push shim: the real git is not a path")
  const zsh = opts.zsh !== undefined ? opts.zsh : ZSH_CANDIDATES.find((z) => existsSync(z))
  if (!zsh) throw new Error("git push shim: no zsh")
  const nc = opts.nc ?? "/usr/bin/nc"
  const decode = `/usr/bin/base64 ${(opts.platform ?? process.platform) === "darwin" ? "-D" : "-d"}`
  mkdirSync(opts.binDir, { recursive: true, mode: 0o700 })
  const shim = path.join(opts.binDir, "git")
  const broker = opts.socket
    ? [
        "if [[ $sub == (push|fetch|pull) ]]; then",
        '  gd=$("$real" "${pre[@]}" rev-parse --absolute-git-dir 2>/dev/null)',
        "  if [[ -n $gd ]]; then",
        `    reply=$({ printf 'git\\0%s\\0%s\\0' "$sub" "$gd"; for a in "\${rest[@]}"; do printf '%s\\0' "$a"; done; } | ${shq(nc)} -U ${shq(opts.socket)})`,
        "    if [[ $reply != pass* ]]; then",
        ...replyLines(decode).map((l) => `      ${l}`),
        "      mode=${${(M)lines:#mode=*}#mode=}",
        "      ref=${${(M)lines:#ref=*}#ref=}",
        "      flags=(${=${${(M)lines:#flags=*}#flags=}})",
        '      if [[ $code == 0 && $mode == merge ]]; then exec "$real" "${pre[@]}" merge --no-edit "${flags[@]}" "$ref"; fi',
        '      if [[ $code == 0 && $mode == rebase ]]; then exec "$real" "${pre[@]}" rebase "$ref"; fi',
        "      exit $code",
        "    fi",
        "  fi",
        "fi",
      ]
    : []
  writeShim(
    shim,
    [
      `#!${zsh} -f`,
      "# Liaison node: the session's git. push, fetch and pull of a repository the node",
      "# serves run in the node (its credential never reaches the session); `git push`",
      "# drops -u/--set-upstream, a config write the session never makes. Anything",
      "# else is the real git, unchanged.",
      `real=${shq(opts.git)}`,
      'pre=(); sub=""; rest=()',
      "i=1",
      "while (( i <= $# )); do",
      "  a=${@[i]}",
      "  if [[ -z $sub ]]; then",
      "    case $a in",
      '      (-C|-c|--git-dir|--work-tree|--namespace|--config-env) pre+=("$a" "${@[i+1]-}"); (( i += 2 )); continue ;;',
      '      (-*) pre+=("$a") ;;',
      "      (*) sub=$a ;;",
      "    esac",
      "  else",
      '    rest+=("$a")',
      "  fi",
      "  (( i++ ))",
      "done",
      ...broker,
      'if [[ -z $sub ]]; then exec "$real" "${pre[@]}"; fi',
      "if [[ $sub == push ]]; then",
      "  kept=(); seen=0",
      '  for a in "${rest[@]}"; do',
      '    if (( seen )); then kept+=("$a")',
      '    elif [[ $a == -- ]]; then seen=1; kept+=("$a")',
      '    elif [[ $a != (-u|--set-upstream) ]]; then kept+=("$a"); fi',
      "  done",
      '  rest=("${kept[@]}")',
      "fi",
      'exec "$real" "${pre[@]}" "$sub" "${rest[@]}"',
      "",
    ].join("\n"),
  )
  return shim
}

/** Walk D2: where ssh really goes for a session's SSH remote, read from ssh's own config. */
export interface SshRemoteTarget {
  /** The host ssh connects to (an alias's HostName), lowercase. */
  hostname: string
  /** The URL's port (`ssh://host:2222/…`), else 22, and the config's Port. */
  ports: number[]
  /** The identity files ssh's config names for that host (absolute paths). */
  identityFiles: string[]
}

/**
 * Walk D2: `ssh -G <host>` (outside the sandbox, at start, 3 s at most): the
 * HostName, Port and IdentityFile ssh's config sets for the remote's host.
 * Nothing found leaves the remote's own host and port.
 */
export function sshRemoteTarget(
  url: string,
  host: string,
  home: string,
  sshConfig: (host: string) => string = readSshConfig,
): SshRemoteTarget {
  let port = 22
  try {
    if (url.includes("://")) port = Number(new URL(url).port) || 22
  } catch {
    // scp-like: no port in the URL
  }
  const config = sshConfig(host)
  const one = (key: string) => new RegExp(`^${key} (\\S+)$`, "m").exec(config)?.[1]
  const hostname = (one("hostname") ?? host).toLowerCase().replace(/\.$/, "")
  const fromConfig = Number(one("port"))
  const identityFiles = [...config.matchAll(/^identityfile (.+)$/gm)]
    .map((m) => (m[1] as string).trim())
    .map((f) => (f.startsWith("~/") ? path.join(home, f.slice(2)) : f))
    .filter((f) => path.isAbsolute(f) && !f.includes("%"))
  return {
    hostname: /^[a-z0-9.-]+$/.test(hostname) ? hostname : host.toLowerCase(),
    ports: [...new Set([port, ...(fromConfig > 0 ? [fromConfig] : [])])],
    identityFiles: [...new Set(identityFiles)],
  }
}

/**
 * `ssh -G <host>`: the options ssh's own config sets for that host (an alias's
 * HostName among them). `configFile` reads that file instead of the user's
 * (`-F`), for a fixture.
 */
export function readSshConfig(host: string, configFile?: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return ""
  const r = spawnSync("ssh", [...(configFile ? ["-F", configFile] : []), "-G", host], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  return r.status === 0 ? r.stdout : ""
}

/**
 * B4: the environment the NODE's own clone runs with (outside the sandbox) so
 * a private HTTPS repository clones: a helper for the clone's host that reads
 * the credential from that process's environment. Never the session's env.
 */
export function nodeCloneAuthEnv(
  scope: CredentialScope | null,
  base: Record<string, string>,
): Record<string, string> {
  if (!scope?.git) return base
  const n = Number(base.GIT_CONFIG_COUNT ?? 0)
  return {
    ...base,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `credential.https://${scope.host}.helper`,
    [`GIT_CONFIG_VALUE_${n}`]:
      '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$LIAISON_NODE_CLONE_USER" "$LIAISON_NODE_CLONE_PASSWORD"; }; f',
    LIAISON_NODE_CLONE_USER: scope.git.username,
    LIAISON_NODE_CLONE_PASSWORD: scope.git.password,
  }
}
