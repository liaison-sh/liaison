// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE A NODE SESSION WORKS, with REAL git (P1-T33, D17, D31). The node
// makes a worktree or a clone on a `node/` branch with its own pre-push hook,
// and the session's git (run here with the environment the session gets) can
// push its branch but never a protected one, however the push is spelled. A
// local bare repository stands in for the code host.
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NodeLevel } from "../../../packages/shared/src/node-levels"
import {
  folderRelativeCwd,
  hostGitEnv,
  makeInPlaceBranch,
  parseRemote,
  prepareSessionWorkspace,
  sessionRunsInPlace,
  WorkspaceError,
  WorkspaceNeedsYou,
} from "./job-workspace"
import {
  type JobSession,
  jobContextFor,
  type SessionJobContext,
  type UnattendedJob,
} from "./unattended"
import {
  decideLevelTool,
  levelProfile,
  levelSandboxSettings,
  prePushHookScript,
  sessionEnv,
} from "./unattended-profile"

const root = mkdtempSync(path.join(tmpdir(), "liaison-job-workspace-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const URL_ = "https://github.com/example-org/liaison-node-sample"
const host = hostGitEnv()

function git(args: string[], cwd: string, env: Record<string, string> = host) {
  const out = spawnSync("git", args, { cwd, env, encoding: "utf8" })
  return { code: out.status ?? -1, out: `${out.stdout}${out.stderr}` }
}

function sh(command: string, cwd: string, env: Record<string, string>) {
  const out = spawnSync("/bin/sh", ["-c", command], { cwd, env, encoding: "utf8" })
  return { code: out.status ?? -1, out: `${out.stdout}${out.stderr}` }
}

/**
 * A bare remote with one commit on main. `files` are committed with it (a
 * `{ link }` is committed as a symlink).
 */
function remote(files: Record<string, string | { link: string }> = {}): string {
  const seed = mkdtempSync(path.join(root, "seed-"))
  git(["init", "-q", "-b", "main"], seed)
  writeFileSync(path.join(seed, "price.ts"), "export const total = (a: number) => a\n")
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(seed, name)), { recursive: true })
    if (typeof content === "string") writeFileSync(path.join(seed, name), content)
    else symlinkSync(content.link, path.join(seed, name))
  }
  git(["add", "-f", "."], seed)
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], seed)
  const bare = path.join(root, `remote-${Math.random().toString(36).slice(2)}.git`)
  git(["clone", "-q", "--bare", seed, bare], root)
  return bare
}

/** A session job that clones URL_ (from `bare`) at `level`, in a fresh temp home. */
function cloneJob(level: NodeLevel): { job: UnattendedJob; ctx: SessionJobContext } {
  const home = realpathSync(mkdtempSync(path.join(root, "home-")))
  const session: JobSession = {
    id: "0badc0de-1111-4222-8333-444455556666",
    source: "dispatch",
    repo: URL_,
    model: "claude-haiku-4-5",
    level,
    profileLevel: level,
    configKind: "owner",
    liaisonTools: false,
  }
  const job: UnattendedJob = {
    jobId: "job-1",
    server: "https://liaison.example",
    agentId: "agent-1",
    agentName: "Dev",
    model: session.model,
    profile: { level, liaisonTools: false },
    session,
    prompt: "fix it",
    nodeRoot: path.join(home, "Liaison Node"),
    home,
  }
  return { job, ctx: jobContextFor(job, "darwin") }
}

/** The node's clone at Strict, and the environment the session's own git runs with. */
function setup() {
  const bare = remote()
  const { job, ctx } = cloneJob("strict")
  const ws = prepareSessionWorkspace({
    session: job.session as JobSession,
    level: "strict",
    ctx,
    sourceFor: () => bare,
  })
  // The node set origin back to the URL the session named: pushes go to the stand-in.
  expect(git(["-C", ws.cwd, "remote", "set-url", "origin", bare], root).code).toBe(0)
  const profile = levelProfile({ level: "strict", liaisonTools: false }, ctx, {
    sessionFolder: ws.cwd,
    defaultBranches: ws.defaultBranch ? [ws.defaultBranch] : [],
    passedMcp: new Set(),
    mirrorReads: [],
    ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
  })
  const scratch = path.join(ctx.nodeRoot, ".scratch")
  const env = sessionEnv(
    profile,
    ctx,
    { PATH: process.env.PATH },
    {
      git: {
        ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
        ...(ws.gitDir ? { gitDir: ws.gitDir } : {}),
        ...(ws.remoteHost ? { remoteHost: ws.remoteHost } : {}),
        ...(ws.remoteKind ? { remoteKind: ws.remoteKind } : {}),
        ...(ws.hooksDir ? { hooksDir: ws.hooksDir } : {}),
      },
      configDir: path.join(root, "cfg"),
      shellHome: ctx.home,
      tmpDir: path.join(scratch, "tmp"),
      cacheDir: path.join(scratch, "cache"),
      author: { name: "Dev (Liaison node)", email: "liaison-node@users.noreply.github.com" },
    },
  )
  const repo = ws.cwd
  const mainHead = () => git(["rev-parse", "main"], bare).out.trim()
  const commit = (file: string) => {
    writeFileSync(path.join(repo, file), `change ${Math.random()}\n`)
    expect(git(["add", file], repo, env).code).toBe(0)
    expect(git(["commit", "-qm", `edit ${file}`], repo, env).code).toBe(0)
  }
  return { bare, ctx, profile, ws, env, repo, mainHead, commit }
}

describe("the node's clone carries its guard (D17, D31)", () => {
  it("clones on a node/ branch, finds the default branch, and the hook is read-only", () => {
    const { ws, repo, env } = setup()
    expect(ws.kind).toBe("clone")
    expect(ws.defaultBranch).toBe("main")
    expect(ws.branch).toMatch(/^node\//)
    expect(git(["symbolic-ref", "--short", "HEAD"], repo, env).out.trim()).toBe(ws.branch as string)
    // The node's own files are never committed by accident.
    expect(git(["status", "--porcelain"], repo, env).out.trim()).toBe("")
    const hook = path.join(ws.hooksDir as string, "pre-push")
    expect(statSync(hook).mode & 0o222).toBe(0)
  })

  it("the session's own branch push succeeds", () => {
    const { bare, ws, env, repo, commit } = setup()
    commit("price.ts")
    const pushed = git(["push", "-u", "origin", ws.branch as string], repo, env)
    expect(pushed.code).toBe(0)
    expect(git(["rev-parse", "--verify", ws.branch as string], bare).code).toBe(0)
  })

  it("a push to main is refused by the pre-push hook, however it is spelled", () => {
    const { env, repo, mainHead, commit } = setup()
    const before = mainHead()
    commit("price.ts")
    const spellings: Array<[string, string]> = [
      ["plain", "git push origin HEAD:main"],
      ["refs", "git push origin HEAD:refs/heads/main"],
      ["git -C", `git -C ${JSON.stringify(repo)} push origin HEAD:main`],
      ["-c alias", "git -c alias.ship=push ship origin HEAD:main"],
      ["upper case", "git push origin HEAD:MAIN"],
      [
        "env GIT_DIR",
        `GIT_DIR=${JSON.stringify(path.join(repo, ".git"))} GIT_WORK_TREE=. git push origin HEAD:main`,
      ],
      ["a script", "printf 'git push origin HEAD:main' > ../ship.sh && sh ../ship.sh"],
      ["repo alias", "git config alias.sh '!git push origin HEAD:main' && git sh"],
      [
        "hooksPath unset in .git/config",
        "git config --unset core.hooksPath; git push origin HEAD:main",
      ],
      ["master", "git push origin HEAD:master"],
    ]
    for (const [name, command] of spellings) {
      const result = sh(command, repo, env)
      expect({
        name,
        refused: result.code !== 0,
        byTheGuard: result.out.includes("Liaison node: push refused"),
      }).toEqual({ name, refused: true, byTheGuard: true })
      expect(mainHead()).toBe(before)
    }
  })

  it("a branch other than the session's own is refused, however it is named", () => {
    const { bare, ws, env, repo, commit } = setup()
    commit("price.ts")
    git(["branch", "fix-elsewhere"], repo, env)
    for (const refspec of ["fix-elsewhere", "HEAD:fix-elsewhere", `${ws.branch}:other`]) {
      const pushed = git(["push", "origin", refspec], repo, env)
      expect({ refspec, code: pushed.code === 0 }).toEqual({ refspec, code: false })
      expect(pushed.out).toContain(`only this session's branch ${ws.branch} is pushed`)
    }
    expect(git(["rev-parse", "--verify", "fix-elsewhere"], bare).code).not.toBe(0)
    expect(git(["push", "origin", ws.branch as string], repo, env).code).toBe(0)
  })

  it("a force push, a deletion and a tag push are refused too", () => {
    const { bare, ws, env, repo, commit } = setup()
    const branch = ws.branch as string
    commit("a.ts")
    expect(git(["push", "-u", "origin", branch], repo, env).code).toBe(0)
    const pushed = git(["rev-parse", branch], bare).out.trim()
    git(["reset", "-q", "--hard", "HEAD~1"], repo, env)
    commit("b.ts")
    const forced = git(["push", "origin", `+${branch}`], repo, env)
    expect(forced.code).not.toBe(0)
    expect(forced.out).toContain("not be a fast-forward")
    expect(git(["rev-parse", branch], bare).out.trim()).toBe(pushed)
    const deleted = git(["push", "origin", `:${branch}`], repo, env)
    expect(deleted.code).not.toBe(0)
    expect(git(["rev-parse", "--verify", branch], bare).code).toBe(0)
    git(["tag", "v9"], repo, env)
    expect(git(["push", "origin", "v9"], repo, env).code).not.toBe(0)
  })

  it("the spellings that would drop the hook itself are refused before git runs (env GIT_CONFIG_*, -c hooksPath, --no-verify)", () => {
    const { ctx, profile } = setup()
    for (const command of [
      "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git push origin HEAD:main",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push origin fix-1",
      "git -c core.hooksPath=/dev/null push origin HEAD:main",
      "git push --no-verify origin HEAD:main",
      "git push --no-verify -u origin fix-1",
    ]) {
      expect({
        command,
        decision: decideLevelTool(profile, ctx, "Bash", { command }).decision,
      }).toEqual({ command, decision: "deny" })
    }
  })
})

describe("the hook path is in the clone's own git config too (fix8 H1c)", () => {
  it("a push to main is refused with no GIT_CONFIG_* in the environment at all", () => {
    const { ws, env, repo, mainHead, commit } = setup()
    expect(git(["config", "--local", "--get", "core.hooksPath"], repo).out.trim()).toBe(
      ws.hooksDir as string,
    )
    const before = mainHead()
    commit("price.ts")
    // The environment layer gone (a settings file's `env` overriding it, say):
    // .git/config alone still names the node's hook.
    const bare: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_CONFIG_")) bare[k] = v
    bare.GIT_CONFIG_NOSYSTEM = "1"
    bare.GIT_CONFIG_GLOBAL = "/dev/null"
    const pushed = git(["push", "origin", "HEAD:main"], repo, bare)
    expect(pushed.code).not.toBe(0)
    expect(pushed.out).toContain("Liaison node: push refused")
    expect(mainHead()).toBe(before)
  })
})

describe("the node never writes through a link the repository commits (fix8 H3)", () => {
  function refusal(files: Record<string, string | { link: string }>, level: NodeLevel) {
    const bare = remote(files)
    const { job, ctx } = cloneJob(level)
    try {
      prepareSessionWorkspace({
        session: job.session as JobSession,
        level,
        ctx,
        sourceFor: () => bare,
      })
      return null
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError)
      expect((error as WorkspaceError).code).toBe("settings_refused")
      return (error as Error).message
    }
  }

  for (const level of ["strict", "standard"] as const) {
    it(`a symlinked settings.local.json is refused and its target untouched (${level})`, () => {
      const victim = path.join(mkdtempSync(path.join(root, "victim-")), "zshrc")
      writeFileSync(victim, "export SAFE=1\n")
      const message = refusal({ ".claude/settings.local.json": { link: victim } }, level)
      expect(message).toContain("settings.local.json (symlink)")
      expect(readFileSync(victim, "utf8")).toBe("export SAFE=1\n")
    })

    it(`a symlinked settings.json is refused and its target untouched (${level})`, () => {
      const victim = path.join(mkdtempSync(path.join(root, "victim-")), "settings.json")
      writeFileSync(victim, "{}\n")
      const message = refusal({ ".claude/settings.json": { link: victim } }, level)
      expect(message).toContain("settings.json (symlink)")
      expect(readFileSync(victim, "utf8")).toBe("{}\n")
    })

    it(`a symlinked .claude folder is refused and nothing is written behind it (${level})`, () => {
      const owner = mkdtempSync(path.join(root, "owner-claude-"))
      const victim = path.join(owner, "settings.local.json")
      writeFileSync(victim, "{}\n")
      const message = refusal({ ".claude": { link: owner } }, level)
      expect(message).toContain(".claude (symlink)")
      expect(readFileSync(victim, "utf8")).toBe("{}\n")
      expect(existsSync(path.join(owner, "settings.json"))).toBe(false)
    })
  }
})

// ── P1-T33: where a session works (S2, S15, D16, D17, D31, L5, L12, L25, K7, K8, K23) ──

/**
 * A fake owner's computer: a home (K7: the shared repo lives under it, as on a
 * real Mac, while this test's temp dir does not), a bare "GitLab" remote whose
 * default branch is `trunk2` (outside the fixed protected list), and the
 * owner's own clone of it, the shared folder a session names.
 */
function ownerWorld(files: Record<string, string> = {}) {
  const base = realpathSync(mkdtempSync(path.join(root, "session-")))
  const home = path.join(base, "home")
  const seed = path.join(base, "seed")
  mkdirSync(seed, { recursive: true })
  git(["init", "-q", "-b", "trunk2"], seed)
  writeFileSync(path.join(seed, "price.ts"), "export const total = (a: number) => a\n")
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(seed, name)), { recursive: true })
    writeFileSync(path.join(seed, name), content)
  }
  git(["add", "-f", "."], seed)
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], seed)
  const bare = path.join(base, "remote.git")
  git(["clone", "-q", "--bare", seed, bare], base)
  const code = path.join(home, "code")
  mkdirSync(code, { recursive: true })
  const repo = path.join(code, "app")
  expect(git(["clone", "-q", bare, repo], code).code).toBe(0)
  const nodeRoot = path.join(home, "Liaison Node")
  return { base, home, bare, code, repo, nodeRoot }
}

type World = ReturnType<typeof ownerWorld>

const SESSION_ID = "c0ffee12-3456-4789-abcd-0123456789ab"

function sessionJob(
  w: World,
  session: Partial<JobSession> & { level: NodeLevel },
  id = SESSION_ID,
): { job: UnattendedJob; ctx: SessionJobContext; session: JobSession } {
  const full: JobSession = {
    id,
    source: "dispatch",
    model: "claude-haiku-4-5",
    profileLevel: session.level,
    configKind: "owner",
    liaisonTools: true,
    ...session,
  }
  const job: UnattendedJob = {
    jobId: "job-1",
    server: "https://liaison.example",
    agentId: "agent-1",
    agentName: "Dev",
    model: full.model,
    profile: { level: full.level, liaisonTools: true },
    session: full,
    prompt: "fix it",
    nodeRoot: w.nodeRoot,
    home: w.home,
  }
  return { job, ctx: jobContextFor(job, "darwin"), session: full }
}

function prepare(
  w: World,
  session: Partial<JobSession> & { level: NodeLevel },
  extra: Partial<Parameters<typeof prepareSessionWorkspace>[0]> = {},
  id = SESSION_ID,
) {
  const s = sessionJob(w, session, id)
  return {
    ...s,
    ws: prepareSessionWorkspace({
      session: s.session,
      level: s.session.level,
      ctx: s.ctx,
      folders: [
        { name: "code", path: w.code, kind: "root" },
        { name: "app", path: w.repo, kind: "repo" },
      ],
      ...extra,
    }),
  }
}

function workspaceCode(fn: () => unknown): { code: string | undefined; message: string } {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError)
    return { code: (error as WorkspaceError).code, message: (error as Error).message }
  }
  throw new Error("expected a WorkspaceError")
}

const ownTree = (repo: string) => ({
  status: git(["status", "--porcelain", "--untracked-files=all"], repo).out,
  branch: git(["symbolic-ref", "--short", "HEAD"], repo).out.trim(),
  head: git(["rev-parse", "HEAD"], repo).out.trim(),
})

describe("P1-T33 a shared repo session works in a worktree of its own (S15, D17)", () => {
  it("a strict session gets a worktree on node/…, the repo's own tree is untouched", () => {
    const w = ownerWorld()
    const before = ownTree(w.repo)
    const { ctx, ws } = prepare(w, { level: "strict", folderPath: w.repo, folderName: "app" })
    expect(ws.kind).toBe("worktree")
    expect(ws.cwd).toBe(ctx.worktreeDir as string)
    expect(ws.cwd.startsWith(w.nodeRoot + path.sep)).toBe(true)
    expect(ws.branch).toBe("node/app-c0ff")
    expect(git(["symbolic-ref", "--short", "HEAD"], ws.cwd).out.trim()).toBe("node/app-c0ff")
    expect(readFileSync(path.join(ws.cwd, "price.ts"), "utf8")).toContain("total")
    expect(ownTree(w.repo)).toEqual(before)
    // K7: git facts for the sandbox (the repo is under the fake home).
    expect(ws.commonDir).toBe(realpathSync(path.join(w.repo, ".git")))
    expect(ws.gitDir?.startsWith(path.join(ws.commonDir as string, "worktrees") + path.sep)).toBe(
      true,
    )
    expect(ws.startCommit).toBe(before.head)
    expect(ws.defaultBranch).toBe("trunk2")
  })

  it("a locked ref fails worktree_failed with git's text, never the repo's own tree", () => {
    const w = ownerWorld()
    mkdirSync(path.join(w.repo, ".git", "refs", "heads", "node"), { recursive: true })
    writeFileSync(path.join(w.repo, ".git", "refs", "heads", "node", "app-c0ff.lock"), "")
    const before = ownTree(w.repo)
    const r = workspaceCode(() =>
      prepare(w, { level: "standard", folderPath: w.repo, folderName: "app" }),
    )
    expect(r.code).toBe("worktree_failed")
    expect(r.message).toMatch(/lock/i)
    expect(ownTree(w.repo)).toEqual(before)
  })

  it("the checked-out settings.json is replaced by the filtered one and marked skip-worktree", () => {
    const w = ownerWorld({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(*)"], deny: ["Bash(rm -rf:*)"] },
        hooks: { PreToolUse: [] },
        env: { X: "1" },
        includeCoAuthoredBy: false,
        enabledPlugins: { "atelier@x": true },
      }),
    })
    const { ws } = prepare(w, { level: "strict", folderPath: w.repo, folderName: "app" })
    const settings = JSON.parse(readFileSync(path.join(ws.cwd, ".claude", "settings.json"), "utf8"))
    expect(settings).toEqual({
      permissions: { deny: ["Bash(rm -rf:*)"] },
      includeCoAuthoredBy: false,
      enabledPlugins: { "atelier@x": true },
    })
    expect(git(["ls-files", "-v", ".claude/settings.json"], ws.cwd).out.trim()).toBe(
      "S .claude/settings.json",
    )
    expect(git(["diff", "--quiet"], ws.cwd).code).toBe(0)
    // D53 (B3): the node's guardrail settings travel in the flag layer, never as a file here.
    expect(existsSync(path.join(ws.cwd, ".claude", "settings.local.json"))).toBe(false)
    // The owner's own checkout still has the original file.
    expect(readFileSync(path.join(w.repo, ".claude", "settings.json"), "utf8")).toContain("allow")
  })

  // D53 (B3): a session that runs `git add -A && git commit && git push` (the
  // S15 PR flow) must push nothing the node generated (its deny rules name the
  // owner's absolute home).
  for (const level of ["strict", "standard"] as const) {
    it(`git add -A stages nothing the node generated, in a worktree and in a clone (${level})`, () => {
      const w = ownerWorld({
        ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
      })
      const worktree = prepare(w, { level, folderPath: w.repo, folderName: "app" }).ws
      const clone = prepare(
        w,
        { level, repo: "https://gitlab.com/acme/app.git" },
        { sourceFor: () => w.bare },
        "0ddba11a-3456-4789-abcd-0123456789ab",
      ).ws
      // The session's git: an empty home, so no global excludes file (the owner's
      // ~/.config/git/ignore often lists settings.local.json) hides anything.
      const bare = mkdtempSync(path.join(root, "empty-home-"))
      const sessionGit = { ...host, HOME: bare, XDG_CONFIG_HOME: bare }
      for (const ws of [worktree, clone]) {
        const staged = git(["add", "-A", "--dry-run"], ws.cwd, sessionGit)
        expect({ kind: ws.kind, staged: staged.out.trim() }).toEqual({ kind: ws.kind, staged: "" })
        expect(
          git(["status", "--porcelain", "--untracked-files=all"], ws.cwd, sessionGit).out.trim(),
        ).toBe("")
        expect(existsSync(path.join(ws.cwd, ".claude", "settings.local.json"))).toBe(false)
      }
      // The owner's shared info/exclude is never touched to hide anything.
      expect(existsSync(path.join(w.repo, ".git", "info", "exclude"))).toBe(true)
      expect(readFileSync(path.join(w.repo, ".git", "info", "exclude"), "utf8")).not.toContain(
        "Liaison",
      )
    })
  }

  // P1b-fix F6: a tracked settings.local.json is never rewritten (the node's
  // deny rules name the owner's absolute home, and skip-worktree is no hard
  // guarantee against an explicit-path commit). It stays byte for byte the
  // repository's; the session does not load the local source at all, and the
  // node's guardrails travel in the flag layer.
  for (const level of ["strict", "standard"] as const) {
    it(`a tracked settings.local.json is left untouched, git status stays clean, and the local source is off (${level})`, () => {
      const committed = JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } })
      const w = ownerWorld({ ".claude/settings.local.json": committed })
      for (const ws of [
        prepare(w, { level, folderPath: w.repo, folderName: "app" }).ws,
        prepare(
          w,
          { level, repo: "https://gitlab.com/acme/app.git" },
          { sourceFor: () => w.bare },
          "0ddba11a-3456-4789-abcd-0123456789ab",
        ).ws,
      ]) {
        const file = path.join(ws.cwd, ".claude", "settings.local.json")
        expect({ kind: ws.kind, body: readFileSync(file, "utf8") }).toEqual({
          kind: ws.kind,
          body: committed,
        })
        expect(readFileSync(file, "utf8")).not.toContain(w.home)
        // Not hidden: an ordinary tracked file, unmodified.
        expect(git(["ls-files", "-v", ".claude/settings.local.json"], ws.cwd).out.trim()).toBe(
          "H .claude/settings.local.json",
        )
        const bare = mkdtempSync(path.join(root, "empty-home-"))
        const sessionGit = { ...host, HOME: bare, XDG_CONFIG_HOME: bare }
        expect(
          git(["status", "--porcelain", "--untracked-files=all"], ws.cwd, sessionGit).out.trim(),
        ).toBe("")
        // Even an explicit-path commit has nothing of the node's to carry.
        expect(git(["diff", "HEAD", "--", ".claude/settings.local.json"], ws.cwd).out).toBe("")
        expect(ws.localSettingsTracked).toBe(true)
      }
    })
  }

  it("a second prepare for the same session reuses the worktree and its branch, keeping an uncommitted edit (K23, L5)", () => {
    const w = ownerWorld()
    const first = prepare(w, { level: "strict", folderPath: w.repo, folderName: "app" }).ws
    writeFileSync(path.join(first.cwd, "price.ts"), "// edited, not committed\n")
    const second = prepare(w, { level: "strict", folderPath: w.repo, folderName: "app" }).ws
    expect(second.cwd).toBe(first.cwd)
    expect(second.branch).toBe(first.branch)
    expect(second.startCommit).toBe(first.startCommit)
    expect(readFileSync(path.join(second.cwd, "price.ts"), "utf8")).toBe(
      "// edited, not committed\n",
    )
  })

  it("the pre-push hook refuses the detected default branch (trunk2, origin/ stripped), in a hooks dir under the session dir (K8, L12)", () => {
    const w = ownerWorld()
    const { ctx, ws } = prepare(w, { level: "standard", folderPath: w.repo, folderName: "app" })
    expect(ws.defaultBranch).toBe("trunk2")
    expect(ws.hooksDir).toBe(path.join(ctx.sessionDir as string, "hooks"))
    expect(ws.hooksDir?.startsWith(ws.cwd)).toBe(false)
    expect(existsSync(path.join(ws.cwd, ".git", "hooks"))).toBe(false)
    const hook = readFileSync(path.join(ws.hooksDir as string, "pre-push"), "utf8")
    expect(hook).toContain("trunk2")
    expect(hook).not.toContain("origin/")
    // The session's git, with core.hooksPath through the environment (T30).
    const env = {
      ...host,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: ws.hooksDir as string,
      GIT_AUTHOR_NAME: "n",
      GIT_AUTHOR_EMAIL: "n@n",
      GIT_COMMITTER_NAME: "n",
      GIT_COMMITTER_EMAIL: "n@n",
    }
    writeFileSync(path.join(ws.cwd, "price.ts"), "export const total = 1\n")
    expect(git(["commit", "-qam", "fix"], ws.cwd, env).code).toBe(0)
    const refused = git(["push", "origin", "HEAD:trunk2"], ws.cwd, env)
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain("trunk2 is a protected branch")
    expect(git(["push", "origin", "node/app-c0ff"], ws.cwd, env).code).toBe(0)
  })

  // P1-walk D11: a repo with no origin/HEAD (a remote added by hand, or an old
  // clone) once made the session's own node/ branch "the default branch".
  it("with no origin/HEAD the default is the shared repo's, never the session's node/ branch (D11)", () => {
    const w = ownerWorld()
    expect(git(["remote", "set-head", "origin", "-d"], w.repo).code).toBe(0)
    const { ws } = prepare(w, { level: "standard", folderPath: w.repo, folderName: "app" })
    expect(ws.branch).toBe("node/app-c0ff")
    expect(ws.defaultBranch).toBe("trunk2")
    const hook = readFileSync(path.join(ws.hooksDir as string, "pre-push"), "utf8")
    // Never protected: it is the one branch a push here may name.
    expect(hook.split("\n").find((l) => l.startsWith("protected="))).not.toContain("node/app-c0ff")
    expect(hook).toContain("own='node/app-c0ff'")
    const env = {
      ...host,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: ws.hooksDir as string,
      GIT_AUTHOR_NAME: "n",
      GIT_AUTHOR_EMAIL: "n@n",
      GIT_COMMITTER_NAME: "n",
      GIT_COMMITTER_EMAIL: "n@n",
    }
    writeFileSync(path.join(ws.cwd, "price.ts"), "export const total = 2\n")
    expect(git(["commit", "-qam", "fix"], ws.cwd, env).code).toBe(0)
    expect(git(["push", "-u", "origin", "HEAD"], ws.cwd, env).code).toBe(0)
    expect(git(["push", "origin", "HEAD:trunk2"], ws.cwd, env).code).not.toBe(0)
  })

  it("with no origin/HEAD and the owner on a feature branch, the session's branch is still never protected (D11)", () => {
    const w = ownerWorld()
    expect(git(["remote", "set-head", "origin", "-d"], w.repo).code).toBe(0)
    expect(git(["switch", "-q", "-c", "feature-x"], w.repo).code).toBe(0)
    expect(git(["branch", "-q", "other", "HEAD"], w.repo).code).toBe(0)
    expect(git(["push", "-q", "origin", "other"], w.repo).code).toBe(0)
    const { ws } = prepare(w, { level: "standard", folderPath: w.repo, folderName: "app" })
    expect(ws.defaultBranch).not.toBe(ws.branch)
    expect(ws.defaultBranch?.startsWith("node/")).not.toBe(true)
  })

  it("an SSH origin is reported ssh with its host; an HTTPS one https", () => {
    const w = ownerWorld()
    expect(git(["remote", "set-url", "origin", "git@gitlab.com:acme/app.git"], w.repo).code).toBe(0)
    const ssh = prepare(w, { level: "strict", folderPath: w.repo, folderName: "app" }).ws
    expect({ kind: ssh.remoteKind, host: ssh.remoteHost }).toEqual({
      kind: "ssh",
      host: "gitlab.com",
    })
    expect(parseRemote("https://user@GitLab.example.org:8443/acme/app.git")).toEqual({
      kind: "https",
      host: "gitlab.example.org",
    })
    expect(parseRemote("ssh://git@github.com/acme/app.git")).toEqual({
      kind: "ssh",
      host: "github.com",
    })
    expect(parseRemote("/srv/git/app.git")).toBeNull()
  })
})

describe("P1-T33 a repo session works in a clone keyed by the session (L5, D16)", () => {
  it("a repo clone is made once on node/…, and reused (not re-cloned) for the same session", () => {
    const w = ownerWorld()
    const extra = { sourceFor: () => w.bare }
    const first = prepare(w, { level: "strict", repo: "https://gitlab.com/acme/app.git" }, extra)
    expect(first.ws.kind).toBe("clone")
    expect(first.ws.cwd).toBe(first.ctx.cloneDir as string)
    expect(first.ws.branch).toBe("node/app-c0ff")
    expect(first.ws.remoteKind).toBe("https")
    expect(first.ws.remoteHost).toBe("gitlab.com")
    expect(first.ws.defaultBranch).toBe("trunk2")
    writeFileSync(path.join(first.ws.cwd, "marker.txt"), "kept")
    const second = prepare(w, { level: "strict", repo: "https://gitlab.com/acme/app.git" }, extra)
    expect(second.ws.cwd).toBe(first.ws.cwd)
    expect(readFileSync(path.join(second.ws.cwd, "marker.txt"), "utf8")).toBe("kept")
    expect(git(["symbolic-ref", "--short", "HEAD"], second.ws.cwd).out.trim()).toBe("node/app-c0ff")
  })

  // D53 (B4): a private HTTPS repository clones again, with this computer's
  // credential handed to the node's own clone only. The "host" is a git
  // wrapper that refuses the clone unless git's credential machinery, run with
  // the clone's environment, answers with the right password for the right
  // host and repository.
  function privateHost(expected: string) {
    const dir = realpathSync(mkdtempSync(path.join(root, "private-host-")))
    const capture = path.join(dir, "capture.txt")
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim()
    const wrapper = path.join(dir, "git")
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = clone ]; then',
        `  printf 'protocol=https\\nhost=gitlab.example.org\\npath=acme/private.git\\n\\n' | '${realGit}' credential fill > '${capture}' 2>&1 || { echo "fatal: could not read Username for 'https://gitlab.example.org': terminal prompts disabled" >&2; exit 128; }`,
        `  grep -q '^password=${expected}$' '${capture}' || { echo "fatal: Authentication failed for 'https://gitlab.example.org/acme/private.git/'" >&2; exit 128; }`,
        "fi",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    return { wrapper, capture }
  }

  it("a private HTTPS repository clones with this computer's credential, given to the node's clone only (B4)", () => {
    const w = ownerWorld()
    const { wrapper, capture } = privateHost("s3cret-pass")
    const asked: string[] = []
    const { ws } = prepare(
      w,
      { level: "strict", repo: "https://gitlab.example.org/acme/private.git" },
      {
        git: wrapper,
        sourceFor: () => w.bare,
        cloneAuth: (url: string) => {
          asked.push(url)
          return {
            host: "gitlab.example.org",
            repoPath: "acme/private",
            git: { username: "bot", password: "s3cret-pass" },
          }
        },
      },
    )
    expect(asked).toEqual(["https://gitlab.example.org/acme/private.git"])
    expect(ws.kind).toBe("clone")
    expect(readFileSync(capture, "utf8")).toContain("username=bot")
    // Nothing of the credential is left in the clone's own config.
    expect(readFileSync(path.join(ws.cwd, ".git", "config"), "utf8")).not.toContain("s3cret")
    expect(ws.remotePath).toBe("acme/private")
  })

  it("without a credential the private clone fails naming the host (B4)", () => {
    const w = ownerWorld()
    const { wrapper } = privateHost("s3cret-pass")
    const r = workspaceCode(() =>
      prepare(
        w,
        { level: "strict", repo: "https://gitlab.example.org/acme/private.git" },
        { git: wrapper, sourceFor: () => w.bare, cloneAuth: () => null },
      ),
    )
    expect(r.code).toBe("worktree_failed")
    expect(r.message).toContain("gitlab.example.org")
  })

  it("a shared repo name clones that repo's origin", () => {
    const w = ownerWorld()
    const { ws } = prepare(w, { level: "standard", repo: "app" })
    expect(ws.kind).toBe("clone")
    expect(git(["remote", "get-url", "origin"], ws.cwd).out.trim()).toBe(w.bare)
  })

  it("a clone that hangs past its timeout fails `timeout`, naming the step (L25)", () => {
    const w = ownerWorld()
    const fakeGit = path.join(w.base, "slow-git")
    writeFileSync(fakeGit, "#!/bin/sh\nsleep 5\n", { mode: 0o755 })
    const started = Date.now()
    const r = workspaceCode(() =>
      prepare(
        w,
        { level: "strict", repo: "https://gitlab.com/acme/app.git" },
        { git: fakeGit, timeouts: { cloneMs: 300 } },
      ),
    )
    expect(r.code).toBe("timeout")
    expect(r.message).toContain("git clone timed out after 0.3 s")
    expect(Date.now() - started).toBeLessThan(4_000)
  })
})

describe("P1-T33 folders, Open, and the checks at start (S2, D26, L16, L22)", () => {
  it("open works in the folder itself: no worktree, no hook", () => {
    const w = ownerWorld()
    const { ws } = prepare(w, { level: "open", folderPath: w.repo, folderName: "app" })
    expect(ws.kind).toBe("folder")
    expect(ws.cwd).toBe(w.repo)
    expect(ws.hooksDir).toBeUndefined()
    expect(existsSync(path.join(w.nodeRoot, "worktrees"))).toBe(false)
  })

  it("a missing folder is folder_missing", () => {
    const w = ownerWorld()
    const r = workspaceCode(() =>
      prepare(w, { level: "strict", folderPath: path.join(w.code, "gone"), folderName: "gone" }),
    )
    expect(r.code).toBe("folder_missing")
  })

  it("a non-node, non-git folder works in place; one with allow rules, hooks or env is refused at strict and standard, not at open", () => {
    const w = ownerWorld()
    const plain = path.join(w.home, "notes")
    mkdirSync(plain, { recursive: true })
    // B8: the folder is one this computer shares.
    const notesShared = { folders: [{ name: "notes", path: plain, kind: "root" as const }] }
    const ok = prepare(
      w,
      { level: "strict", folderPath: plain, folderName: "notes" },
      notesShared,
    ).ws
    expect(ok.kind).toBe("folder")
    expect(ok.cwd).toBe(plain)
    expect(ok.hooksDir).toBeUndefined()
    mkdirSync(path.join(plain, ".claude"))
    writeFileSync(
      path.join(plain, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(*)"] }, env: { A: "1" }, hooks: {} }),
    )
    for (const level of ["strict", "standard"] as const) {
      const r = workspaceCode(() =>
        prepare(w, { level, folderPath: plain, folderName: "notes" }, notesShared),
      )
      expect(r.code).toBe("settings_refused")
      expect(r.message).toContain("permissions.allow")
      expect(r.message).toContain("env")
      expect(r.message).toContain("hooks")
    }
    expect(
      prepare(w, { level: "open", folderPath: plain, folderName: "notes" }, notesShared).ws.cwd,
    ).toBe(plain)
  })

  // P1b B8: the node checks the server's folder and repo against its own
  // shared folders; the server's own checks are not the only ones.
  it("a folder outside this computer's shared folders is refused, at every level (B8)", () => {
    const w = ownerWorld()
    const secret = path.join(w.home, "private")
    mkdirSync(secret, { recursive: true })
    for (const level of ["strict", "standard", "open"] as const) {
      for (const folderPath of [w.home, secret, path.join(w.code, "..", "private")]) {
        const r = workspaceCode(() => prepare(w, { level, folderPath, folderName: "x" }))
        expect({ level, folderPath, code: r.code }).toEqual({
          level,
          folderPath,
          code: "folder_missing",
        })
        expect(r.message).toContain("shared")
      }
    }
    // A symlink inside a shared folder that points out of it is refused too.
    symlinkSync(secret, path.join(w.code, "escape"))
    const r = workspaceCode(() =>
      prepare(w, { level: "open", folderPath: path.join(w.code, "escape"), folderName: "escape" }),
    )
    expect(r.code).toBe("folder_missing")
  })

  // P1b-fix F5: a shared root is resolved through its links before it confines
  // anything, and one that resolves to home (or above it) confines nothing.
  it("a shared folder that is a link to home, or home itself, lets no folder through (F5)", () => {
    const w = ownerWorld()
    const secret = path.join(w.home, "private")
    mkdirSync(secret, { recursive: true })
    const linkToHome = path.join(w.base, "shared-link")
    symlinkSync(w.home, linkToHome)
    for (const folders of [
      [{ name: "link", path: linkToHome, kind: "root" as const }],
      [{ name: "home", path: w.home, kind: "root" as const }],
      [{ name: "root", path: "/", kind: "root" as const }],
      [{ name: "up", path: path.dirname(w.home), kind: "root" as const }],
    ]) {
      for (const folderPath of [secret, path.join(linkToHome, "private")]) {
        const r = workspaceCode(() =>
          prepare(w, { level: "open", folderPath, folderName: "x" }, { folders }),
        )
        expect({ root: folders[0]?.path, folderPath, code: r.code }).toEqual({
          root: folders[0]?.path,
          folderPath,
          code: "folder_missing",
        })
      }
    }
    // A shared root reached through a link to a real project still confines to it.
    const linkToCode = path.join(w.base, "code-link")
    symlinkSync(w.code, linkToCode)
    const ok = prepare(
      w,
      { level: "open", folderPath: path.join(w.code, "app"), folderName: "app" },
      { folders: [{ name: "code", path: linkToCode, kind: "root" }] },
    )
    expect(ok.ws.cwd).toBe(path.join(w.code, "app"))
    const out = workspaceCode(() =>
      prepare(
        w,
        { level: "open", folderPath: secret, folderName: "x" },
        { folders: [{ name: "code", path: linkToCode, kind: "root" }] },
      ),
    )
    expect(out.code).toBe("folder_missing")
  })

  it("a repo that is not an https or ssh URL (a local path, file://, a transport helper, an option) is refused (B8)", () => {
    const w = ownerWorld()
    for (const repo of [
      w.repo,
      `file://${w.bare}`,
      "../app",
      "ext::sh -c touch% /tmp/pwned",
      "ext::true",
      "fd::0",
      "--upload-pack=touch /tmp/pwned",
      "-uhack",
    ]) {
      const r = workspaceCode(() => prepare(w, { level: "open", repo }))
      expect({ repo, code: r.code }).toEqual({ repo, code: "worktree_failed" })
      expect(r.message).toContain("not a repository URL")
    }
  })

  it("no folder and no repo: the session's default folder, made by the node", () => {
    const w = ownerWorld()
    const { ctx, ws } = prepare(w, { level: "strict", source: "app" })
    expect(ws.kind).toBe("default")
    expect(ws.cwd).toBe(ctx.cwd)
    expect(statSync(ws.cwd).isDirectory()).toBe(true)
  })
})

// ── P1-T21: owner sessions in the real folder (S48, S50, owner D13, D26a) ──

const nodeBranches = (repo: string) =>
  git(["for-each-ref", "--format=%(refname:short)", "refs/heads/node/"], repo).out.trim()
const worktrees = (repo: string) =>
  git(["worktree", "list", "--porcelain"], repo)
    .out.split("\n")
    .filter((l) => l.startsWith("worktree "))

describe("P1-T21 owner sessions run in the folder itself (S48, D13)", () => {
  for (const level of ["strict", "standard"] as const) {
    it(`S48: an owner dispatch on a repo folder at ${level} runs in the folder itself, creates no worktree and no node/ branch`, () => {
      const w = ownerWorld()
      const before = ownTree(w.repo)
      const session = { level, folderPath: w.repo, folderName: "app" }
      const { ctx, ws } = prepare(w, session, {
        inPlace: sessionRunsInPlace(sessionJob(w, session).session),
      })
      expect(ws.cwd).toBe(w.repo)
      expect(ws.kind).toBe("folder")
      expect(ws.inPlace).toBe(true)
      expect(ws.repoDir).toBe(w.repo)
      expect(ws.sourceRepo).toBe(w.repo)
      // The folder's own checked-out branch, not a node/ one.
      expect(ws.branch).toBe("trunk2")
      expect(nodeBranches(w.repo)).toBe("")
      expect(worktrees(w.repo)).toHaveLength(1)
      expect(existsSync(path.join(w.nodeRoot, "worktrees"))).toBe(false)
      expect(existsSync(ctx.worktreeDir as string)).toBe(false)
      expect(ownTree(w.repo)).toEqual(before)
      // The main checkout's git facts, the guard's hook dir and start commit.
      expect(ws.gitDir).toBe(realpathSync(path.join(w.repo, ".git")))
      expect(ws.commonDir).toBe(realpathSync(path.join(w.repo, ".git")))
      expect(ws.hooksDir).toBe(ctx.hooksDir as string)
      expect(existsSync(path.join(ctx.hooksDir as string, "pre-push"))).toBe(true)
      expect(ws.startCommit).toBe(before.head)
      expect(ws.defaultBranch).toBe("trunk2")
    })
  }

  it("S48: an agent_tag run on the same folder still gets a worktree", () => {
    const w = ownerWorld()
    const session = {
      level: "standard" as const,
      folderPath: w.repo,
      folderName: "app",
      source: "agent_tag" as const,
      configKind: "isolated" as const,
    }
    const inPlace = sessionRunsInPlace(sessionJob(w, session).session)
    expect(inPlace).toBe(false)
    const { ctx, ws } = prepare(w, session, { inPlace })
    expect(ws.kind).toBe("worktree")
    expect(ws.cwd).toBe(ctx.worktreeDir as string)
    expect(nodeBranches(w.repo)).toBe("node/app-c0ff")
  })

  it("S48: a session with an existing node worktree keeps it", () => {
    const w = ownerWorld()
    const session = { level: "standard" as const, folderPath: w.repo, folderName: "app" }
    // Its first run, before D13: a node worktree.
    const first = prepare(w, session)
    expect(first.ws.kind).toBe("worktree")
    const resumed = prepare(w, session, { inPlace: true })
    expect(resumed.ws.kind).toBe("worktree")
    expect(resumed.ws.cwd).toBe(first.ws.cwd)
    expect(resumed.ws.branch).toBe("node/app-c0ff")
  })

  it("S48: a shared repo named by repo resolves to its folder in place", () => {
    const w = ownerWorld()
    const { ctx, ws } = prepare(w, { level: "standard", repo: "app" }, { inPlace: true })
    expect(ws.cwd).toBe(w.repo)
    expect(ws.kind).toBe("folder")
    expect(ws.inPlace).toBe(true)
    expect(existsSync(ctx.cloneDir as string)).toBe(false)
    expect(nodeBranches(w.repo)).toBe("")
  })

  it("S48: Open on a repo folder runs in place with the repo's facts", () => {
    const w = ownerWorld()
    const { ws } = prepare(
      w,
      { level: "open", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(ws.cwd).toBe(w.repo)
    expect(ws.repoDir).toBe(w.repo)
    expect(ws.hooksDir).toBeUndefined()
    expect(ws.localSettingsDropped).toBeUndefined()
  })
})

describe("W3 T12 a Take over import runs in its recorded cwd (A44, S48)", () => {
  const importSession = (w: World, cwdSubdir: string) => ({
    level: "strict" as const,
    source: "import" as const,
    folderPath: w.repo,
    folderName: "app",
    finishWith: "none" as const,
    cwdSubdir,
  })

  it("A44: an in-place import with cwdSubdir 'sub' runs with cwd <folder>/sub and write scope <folder>", () => {
    const w = ownerWorld({ "sub/notes.md": "# notes\n" })
    const before = ownTree(w.repo)
    const session = importSession(w, "sub")
    expect(sessionRunsInPlace(sessionJob(w, session).session)).toBe(true)
    const { ws } = prepare(w, session, { inPlace: true })
    expect(ws.cwd).toBe(path.join(w.repo, "sub"))
    expect(ws.writeDir).toBe(w.repo)
    expect(ws.kind).toBe("folder")
    expect(ws.inPlace).toBe(true)
    expect(ws.repoDir).toBe(w.repo)
    expect(ws.branch).toBe("trunk2")
    expect(nodeBranches(w.repo)).toBe("")
    expect(ownTree(w.repo)).toEqual(before)
    // The folder itself: no subfolder, no write scope of its own.
    const top = prepare(w, importSession(w, ""), { inPlace: true }).ws
    expect(top.cwd).toBe(w.repo)
    expect(top.writeDir).toBeUndefined()
  })

  it("A44: a cwdSubdir that is a symlink resolving outside the folder is refused unsafe_subdir, never run in the folder", () => {
    const w = ownerWorld()
    const outside = path.join(w.base, "elsewhere")
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, path.join(w.repo, "out"))
    // A sibling whose name starts with the folder's: separator-bounded, still outside.
    const sibling = `${w.repo}-two`
    mkdirSync(sibling, { recursive: true })
    symlinkSync(sibling, path.join(w.repo, "twin"))
    for (const sub of ["out", "twin", "../app-two", "missing", "/etc"]) {
      const r = workspaceCode(() => prepare(w, importSession(w, sub), { inPlace: true }))
      expect({ sub, code: r.code }).toEqual({ sub, code: "unsafe_subdir" })
    }
    // A file is not a working directory either.
    writeFileSync(path.join(w.repo, "a-file"), "x")
    expect(
      workspaceCode(() => prepare(w, importSession(w, "a-file"), { inPlace: true })).code,
    ).toBe("unsafe_subdir")
  })

  it("D53: an import recorded in the shared repo's own worktree outside the folder runs in place there (its subfolder too); an unrelated folder, a sibling prefix folder, another repo's worktree and a non-in-place run are refused unsafe_subdir", () => {
    const w = ownerWorld({ "pkg/notes.md": "# notes\n" })
    const worktree = path.join(w.base, "tmp", "app-wt")
    mkdirSync(path.dirname(worktree), { recursive: true })
    expect(git(["worktree", "add", "-q", "-b", "wt-branch", worktree], w.repo).code).toBe(0)
    const before = ownTree(w.repo)
    const inWorktree = (worktreePath: string, sub = "") => ({
      ...importSession(w, sub),
      worktreePath,
    })
    const top = prepare(w, inWorktree(worktree), { inPlace: true }).ws
    expect(top.cwd).toBe(worktree)
    expect(top.kind).toBe("folder")
    expect(top.inPlace).toBe(true)
    expect(top.branch).toBe("wt-branch")
    expect(top.writeDir).toBeUndefined()
    const sub = prepare(w, inWorktree(worktree, "pkg"), { inPlace: true }).ws
    expect(sub.cwd).toBe(path.join(worktree, "pkg"))
    expect(sub.writeDir).toBe(worktree)
    // The owner's checkout is untouched (no branch switched, no file written).
    expect(ownTree(w.repo)).toEqual(before)
    expect(git(["symbolic-ref", "--short", "HEAD"], w.repo).out.trim()).toBe("trunk2")

    const unrelated = path.join(w.base, "tmp", "elsewhere")
    const sibling = `${worktree}-bar`
    for (const d of [unrelated, sibling]) mkdirSync(d, { recursive: true })
    const other = path.join(w.base, "other")
    mkdirSync(other, { recursive: true })
    git(["init", "-q"], other)
    git(
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"],
      other,
    )
    const otherWt = path.join(w.base, "tmp", "other-wt")
    git(["worktree", "add", "-q", otherWt], other)
    for (const wt of [unrelated, sibling, otherWt, "tmp/app-wt", `${worktree}/../app-wt`]) {
      const r = workspaceCode(() => prepare(w, inWorktree(wt), { inPlace: true }))
      expect({ wt, code: r.code }).toEqual({ wt, code: "unsafe_subdir" })
    }
    // A44: only in place, never a node worktree or clone of the worktree.
    expect(workspaceCode(() => prepare(w, inWorktree(worktree), { inPlace: false })).code).toBe(
      "unsafe_subdir",
    )
    // The subdir climbing out of the worktree.
    expect(
      workspaceCode(() => prepare(w, inWorktree(worktree, "../app-wt-bar"), { inPlace: true }))
        .code,
    ).toBe("unsafe_subdir")
  })
})

describe("P1-T21 the owner's settings in place are judged, never written (S50.4, D26a)", () => {
  it("S50: a tracked settings.json with hooks starts at Standard; the file and the index stay the owner's", () => {
    const body = `${JSON.stringify({ attribution: { commit: "" }, hooks: { Stop: [] } }, null, 2)}\n`
    const w = ownerWorld({ ".claude/settings.json": body })
    const before = ownTree(w.repo)
    const { ws } = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(ws.cwd).toBe(w.repo)
    expect(readFileSync(path.join(w.repo, ".claude", "settings.json"), "utf8")).toBe(body)
    // No skip-worktree bit ("S"): git sees the file as the owner left it ("H").
    expect(git(["ls-files", "-v", ".claude/settings.json"], w.repo).out.trim()).toBe(
      "H .claude/settings.json",
    )
    expect(ownTree(w.repo)).toEqual(before)
    expect(ws.localSettingsTracked).toBeUndefined()
  })

  for (const [key, value] of [
    ["permissions", { allow: ["Bash(*)"] }],
    ["permissions", { additionalDirectories: ["/"] }],
    ["permissions", { defaultMode: "bypassPermissions" }],
    ["env", { X: "1" }],
    ["apiKeyHelper", "/bin/echo"],
  ] as const) {
    it(`S50: a tracked settings.json with ${key} ${JSON.stringify(value)} refuses Standard in place, naming Open, file untouched`, () => {
      const body = JSON.stringify({ [key]: value })
      const w = ownerWorld({ ".claude/settings.json": body })
      const r = workspaceCode(() =>
        prepare(w, { level: "standard", folderPath: w.repo, folderName: "app" }, { inPlace: true }),
      )
      expect(r.code).toBe("settings_refused")
      expect(r.message).toContain("Open")
      expect(readFileSync(path.join(w.repo, ".claude", "settings.json"), "utf8")).toBe(body)
      expect(git(["ls-files", "-v", ".claude/settings.json"], w.repo).out.trim()).toBe(
        "H .claude/settings.json",
      )
    })
  }

  it("S50: an untracked settings.local.json with permissions.allow is never judged: the local source is dropped", () => {
    const w = ownerWorld()
    mkdirSync(path.join(w.repo, ".claude"), { recursive: true })
    const local = JSON.stringify({ permissions: { allow: ["Bash(*)"] } })
    writeFileSync(path.join(w.repo, ".claude", "settings.local.json"), local)
    const { ws } = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(ws.localSettingsDropped).toBe(true)
    expect(readFileSync(path.join(w.repo, ".claude", "settings.local.json"), "utf8")).toBe(local)
  })
})

describe("S52 (batch-4 F5): the cwd below the session's shared folder, by exact path", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "f5-rel-")))
  const code = path.join(base, "code")
  mkdirSync(path.join(code, "tools", "code", "api"), { recursive: true })
  mkdirSync(path.join(base, "code-bar"), { recursive: true })
  mkdirSync(path.join(base, "other", "code"), { recursive: true })
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const shared = [{ name: "code", path: code, kind: "root" as const }]

  it("a subfolder that bears the shared folder's own name is still read from the folder's real path", () => {
    expect(folderRelativeCwd(shared, "code", path.join(code, "tools", "code", "api"))).toBe(
      "tools/code/api",
    )
  })

  it("the folder itself is the empty path", () => {
    expect(folderRelativeCwd(shared, "code", code)).toBe("")
  })

  it("a sibling with the folder's name as a prefix, or a folder of the same name elsewhere, is not below it", () => {
    expect(folderRelativeCwd(shared, "code", path.join(base, "code-bar"))).toBeNull()
    expect(folderRelativeCwd(shared, "code", path.join(base, "other", "code"))).toBeNull()
  })

  it("a name the node shares twice, or not at all, gives nothing", () => {
    const twice = [
      ...shared,
      { name: "code", path: path.join(base, "other", "code"), kind: "root" as const },
    ]
    expect(folderRelativeCwd(twice, "code", code)).toBeNull()
    expect(folderRelativeCwd(shared, "elsewhere", code)).toBeNull()
  })
})

describe("P2-T07b the node makes the session's branch in the owner's folder (D40, OPEN-5 / G4)", () => {
  const NODE_BRANCH = "liaison/c0ffee12-app"

  /** An in-place owner session's workspace on the repo's default branch, with uncommitted work. */
  function onDefault(session: Partial<JobSession> = {}) {
    const w = ownerWorld()
    writeFileSync(path.join(w.repo, "price.ts"), "export const total = (a: number) => a + 1\n")
    const s = { level: "standard" as const, folderPath: w.repo, folderName: "app", ...session }
    const { ws, ctx, session: full } = prepare(w, s, { inPlace: true })
    return { w, ws, ctx, session: full }
  }

  it("D40: an in-place owner session below Open on the default branch gets a node-made branch at the same commit, uncommitted work carried", () => {
    const { w, ws, session } = onDefault()
    const before = ownTree(w.repo)
    expect(before.branch).toBe("trunk2")
    const made = makeInPlaceBranch({ workspace: ws, session })
    expect(made).toEqual({ name: NODE_BRANCH, from: "trunk2" })
    const after = ownTree(w.repo)
    expect(after).toEqual({ ...before, branch: NODE_BRANCH })
    expect(ws.branch).toBe(NODE_BRANCH)
    // The default branch's ref did not move.
    expect(git(["rev-parse", "trunk2"], w.repo).out.trim()).toBe(before.head)
    // A protected name, case-folded, counts too.
    const m = onDefault()
    git(["switch", "-q", "-c", "Main"], m.w.repo)
    m.ws.branch = "Main"
    expect(makeInPlaceBranch({ workspace: m.ws, session: m.session })?.from).toBe("Main")
  })

  it("D40: no node-made branch with finishWith none, at Open, on a branch of the owner's own, or with the G4 flag false", () => {
    const cases: Array<[string, () => ReturnType<typeof onDefault>, boolean | undefined]> = [
      ["none", () => onDefault({ finishWith: "none" }), undefined],
      ["open", () => onDefault({ level: "open", profileLevel: "open" }), undefined],
      [
        "own",
        () => {
          const o = onDefault()
          git(["switch", "-q", "-c", "feature/mine"], o.w.repo)
          o.ws.branch = "feature/mine"
          return o
        },
        undefined,
      ],
      ["flag false", () => onDefault(), false],
    ]
    for (const [label, make, enabled] of cases) {
      const { w, ws, session } = make()
      const before = ownTree(w.repo)
      const made = makeInPlaceBranch({
        workspace: ws,
        session,
        ...(enabled === undefined ? {} : { enabled }),
      })
      expect({ label, made, after: ownTree(w.repo) }).toEqual({ label, made: null, after: before })
    }
    // finishWith commit makes one, like pr.
    const c = onDefault({ finishWith: "commit" })
    expect(makeInPlaceBranch({ workspace: c.ws, session: c.session })?.name).toBe(NODE_BRANCH)
  })

  it("W2-D5: while another Liaison session holds the folder, a session that would switch its branch parks on the owner: no branch made, the checkout untouched", () => {
    const { w, ws, session } = onDefault({
      folderHeldBy: '"Fix cart total" (ac492ea4, waiting on you)',
    })
    const before = ownTree(w.repo)
    const branches = heads(w.repo)
    let thrown: unknown = null
    try {
      makeInPlaceBranch({ workspace: ws, session })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WorkspaceNeedsYou)
    const message = (thrown as Error).message
    expect(message).toContain('"Fix cart total" (ac492ea4, waiting on you)')
    expect(message).toContain("on trunk2")
    expect(message).toContain("Finish or stop that session")
    expect(message.length).toBeLessThanOrEqual(300)
    expect(ownTree(w.repo)).toEqual(before)
    expect(heads(w.repo)).toEqual(branches)
    expect(ws.branch).toBe("trunk2")
    expect(ws.nodeBranch).toBeUndefined()
  })

  it("W2-D5: a held folder on a branch of the owner's own needs no switch: the session runs on it (S50.9)", () => {
    const o = onDefault({ folderHeldBy: '"Other" (12345678, running)' })
    git(["switch", "-q", "-c", "feature/mine"], o.w.repo)
    o.ws.branch = "feature/mine"
    const before = ownTree(o.w.repo)
    expect(makeInPlaceBranch({ workspace: o.ws, session: o.session })).toBeNull()
    expect(ownTree(o.w.repo)).toEqual(before)
  })

  it("D40: a name already taken gets the next free suffix, never a switch to the existing branch", () => {
    const { w, ws, session } = onDefault()
    git(["branch", NODE_BRANCH], w.repo)
    expect(makeInPlaceBranch({ workspace: ws, session })?.name).toBe(`${NODE_BRANCH}-2`)
    expect(ownTree(w.repo).branch).toBe(`${NODE_BRANCH}-2`)
  })

  const heads = (repo: string) =>
    git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repo)
      .out.split("\n")
      .filter(Boolean)
      .sort()

  /** The owner's folder with no remote (the walk repo's shape). */
  function noRemote(session: Partial<JobSession> = {}) {
    const o = onDefault(session)
    expect(git(["remote", "remove", "origin"], o.w.repo).code).toBe(0)
    git(["update-ref", "-d", "refs/remotes/origin/HEAD"], o.w.repo)
    return o
  }

  it("W1-D2: with no remote, every resume of a session on its own branch reuses it: no new branch, no switch, the start branch stays the default", () => {
    const { w, session } = noRemote()
    const first = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(first.ws.defaultBranch).toBe("trunk2")
    const made = makeInPlaceBranch({
      workspace: first.ws,
      session,
      sessionDir: first.ctx.sessionDir,
    })
    expect(made).toEqual({ name: NODE_BRANCH, from: "trunk2" })
    const branches = heads(w.repo)
    for (let resume = 0; resume < 3; resume++) {
      const again = prepare(
        w,
        { level: "standard", folderPath: w.repo, folderName: "app" },
        { inPlace: true },
      )
      expect(again.ws.defaultBranch).toBe("trunk2")
      const reused = makeInPlaceBranch({
        workspace: again.ws,
        session,
        sessionDir: again.ctx.sessionDir,
      })
      expect(reused).toEqual({ name: NODE_BRANCH, from: "trunk2" })
      expect(again.ws.nodeBranch).toEqual({ name: NODE_BRANCH, from: "trunk2" })
      expect(heads(w.repo)).toEqual(branches)
      expect(ownTree(w.repo).branch).toBe(NODE_BRANCH)
    }
  })

  it("W1-D2: back on the default branch, a resume switches to the session's recorded branch, never a new one", () => {
    const { w, ws, ctx, session } = noRemote()
    makeInPlaceBranch({ workspace: ws, session, sessionDir: ctx.sessionDir })
    git(["switch", "-q", "trunk2"], w.repo)
    const branches = heads(w.repo)
    const again = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(
      makeInPlaceBranch({ workspace: again.ws, session, sessionDir: again.ctx.sessionDir }),
    ).toEqual({
      name: NODE_BRANCH,
      from: "trunk2",
    })
    expect(heads(w.repo)).toEqual(branches)
    expect(ownTree(w.repo).branch).toBe(NODE_BRANCH)
  })

  it("D56 F1: a resume whose switch to the recorded branch git refuses (the owner's uncommitted changes) parks on the owner with git's words: no new branch, no switch, never worktree_failed", () => {
    const { w, ws, ctx, session } = noRemote()
    makeInPlaceBranch({ workspace: ws, session, sessionDir: ctx.sessionDir })
    // The session's branch carries a committed change to price.ts ...
    git(["add", "price.ts"], w.repo)
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "session work"], w.repo)
    // ... and the owner, back on the default branch, edits the same file.
    git(["switch", "-q", "trunk2"], w.repo)
    writeFileSync(path.join(w.repo, "price.ts"), "export const total = (a: number) => a * 2\n")
    const before = ownTree(w.repo)
    const branches = heads(w.repo)
    const again = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    let thrown: unknown = null
    try {
      makeInPlaceBranch({ workspace: again.ws, session, sessionDir: again.ctx.sessionDir })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WorkspaceNeedsYou)
    expect(thrown).not.toBeInstanceOf(WorkspaceError)
    const message = (thrown as Error).message
    expect(message).toContain(`the session's branch ${NODE_BRANCH}`)
    expect(message).toContain("would be overwritten")
    expect(message.length).toBeLessThanOrEqual(300)
    expect(heads(w.repo)).toEqual(branches)
    expect(ownTree(w.repo)).toEqual(before)
    expect(again.ws.nodeBranch).toBeUndefined()
  })

  it("W1-D2: a liaison/ branch is never the default; a session from before the record keeps its branch; a local main is the fallback", () => {
    const { w, ws, ctx, session } = noRemote()
    makeInPlaceBranch({ workspace: ws, session })
    // No record at all (a session from before W1-D2).
    rmSync(path.join(ctx.sessionDir as string, "start-branch"), { force: true })
    const branches = heads(w.repo)
    const legacy = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(legacy.ws.defaultBranch).toBeUndefined()
    expect(
      makeInPlaceBranch({ workspace: legacy.ws, session, sessionDir: legacy.ctx.sessionDir })?.name,
    ).toBe(NODE_BRANCH)
    expect(heads(w.repo)).toEqual(branches)
    // A local main is the default when nothing else names one.
    rmSync(path.join(ctx.sessionDir as string, "start-branch"), { force: true })
    git(["branch", "main", "trunk2"], w.repo)
    const withMain = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(withMain.ws.defaultBranch).toBe("main")
  })

  it("D40: git switch -c from the session is still refused, and the refusal names the node-made branch", () => {
    const { w, ws, ctx, session } = onDefault()
    const made = makeInPlaceBranch({ workspace: ws, session })
    const profile = (nodeBranch?: string) =>
      levelProfile({ level: "standard", liaisonTools: true }, ctx, {
        sessionFolder: w.repo,
        defaultBranches: ["trunk2"],
        passedMcp: new Set(),
        mirrorReads: [],
        inPlace: true,
        ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
        ...(nodeBranch ? { nodeBranch } : {}),
      })
    for (const command of ["git switch -c feat/x", "git checkout -b feat/x", "git switch trunk2"]) {
      const d = decideLevelTool(profile(made?.name), ctx, "Bash", { command }, { cwd: w.repo })
      expect({ command, decision: d.decision }).toEqual({ command, decision: "deny" })
      expect(d.reason).toContain(`Liaison made the branch ${NODE_BRANCH} for this session`)
      expect(d.reason).toContain(`git push origin ${NODE_BRANCH}`)
      expect(d.reason).not.toContain("git branch <name>")
    }
    // No node-made branch (the G4 "no"): W1's refusal, byte for byte.
    expect(
      decideLevelTool(profile(), ctx, "Bash", { command: "git switch -c feat/x" }, { cwd: w.repo })
        .reason,
    ).toBe(
      "git switch: it switches the owner's branch or rewrites their working tree, refused in their folder below Open. To push your commits, run git branch <name> (it does not switch) then git push origin <name>; anything else needs the owner to switch this session to Open",
    )
    expect(ownTree(w.repo).branch).toBe(NODE_BRANCH)
  })

  it.skipIf(process.platform !== "darwin")(
    "D40: under the session's own sandbox profile, the node-made branch is checked out, HEAD is unchanged by any session command, and a commit lands on that branch",
    () => {
      const { w, ws, ctx, session } = onDefault()
      const made = makeInPlaceBranch({ workspace: ws, session })
      expect(made?.name).toBe(NODE_BRANCH)
      const p = levelProfile({ level: "standard", liaisonTools: true }, ctx, {
        sessionFolder: w.repo,
        defaultBranches: ["trunk2"],
        passedMcp: new Set(),
        mirrorReads: [],
        advertisedFolders: [w.code, w.repo],
        inPlace: true,
        nodeBranch: NODE_BRANCH,
        ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
      })
      const sandbox = levelSandboxSettings(p, ctx, {
        ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
        ...(ws.gitDir ? { gitDir: ws.gitDir } : {}),
        ...(ws.branch ? { branch: ws.branch } : {}),
      })
      const denied = (sandbox?.filesystem?.denyWrite ?? []).filter((d) => !d.includes("*"))
      const headFile = path.join(ws.commonDir as string, "HEAD")
      // The profile's write denies, as seatbelt rules (the CLI's own backstop).
      const seatbelt = `(version 1)(allow default)${denied
        .map((d) => `(deny file-write* (subpath ${JSON.stringify(d)}))`)
        .join("")}`
      const run = (command: string) =>
        spawnSync("sandbox-exec", ["-p", seatbelt, "/bin/sh", "-c", command], {
          cwd: w.repo,
          env: host,
          encoding: "utf8",
        })
      const head = () => readFileSync(headFile, "utf8")
      expect(head()).toBe(`ref: refs/heads/${NODE_BRANCH}\n`)
      for (const command of [
        "git switch -c feat/x",
        "git switch -q trunk2",
        "git checkout -q trunk2",
        "git symbolic-ref HEAD refs/heads/trunk2",
        "printf 'ref: refs/heads/trunk2\\n' > .git/HEAD",
        "git update-ref --no-deref HEAD trunk2",
      ]) {
        run(command)
        expect({ command, head: head() }).toEqual({
          command,
          head: `ref: refs/heads/${NODE_BRANCH}\n`,
        })
      }
      const before = git(["rev-parse", "trunk2"], w.repo).out.trim()
      const commit = run("git -c user.name=t -c user.email=t@t commit -qam 'fix: total'")
      expect(commit.status).toBe(0)
      expect(git(["rev-parse", "trunk2"], w.repo).out.trim()).toBe(before)
      expect(git(["rev-parse", `${NODE_BRANCH}~1`], w.repo).out.trim()).toBe(before)
    },
  )
})

// ── Submodules in place: their own git dirs, resolved and checked ──

describe("in place with submodules: each nested git dir is the session's, nothing else", () => {
  const sub = (cwd: string, url: string, name: string) =>
    git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", url, name], cwd)

  /**
   * The owner's folder with `lib` (on its branch fix/lib, an SSH origin on
   * another host), `lib/deep` (nested twice, detached), `ext` (its .git file
   * points at a repository outside the folder) and `linked` (its git dir
   * under .git/modules is a link out of it).
   */
  function withSubmodules() {
    const w = ownerWorld()
    expect(sub(w.repo, remote(), "lib").code).toBe(0)
    const lib = path.join(w.repo, "lib")
    expect(sub(lib, remote(), "deep").code).toBe(0)
    expect(git(["switch", "-q", "-c", "fix/lib"], lib).code).toBe(0)
    git(["remote", "set-url", "origin", "git@gitlab.example.com:acme/lib.git"], lib)
    expect(sub(w.repo, remote(), "ext").code).toBe(0)
    const outside = path.join(w.base, "outside")
    mkdirSync(outside)
    git(["init", "-q", "-b", "main"], outside)
    writeFileSync(path.join(w.repo, "ext", ".git"), `gitdir: ${path.join(outside, ".git")}\n`)
    expect(sub(w.repo, remote(), "linked").code).toBe(0)
    const moved = path.join(w.base, "moved-linked")
    renameSync(path.join(w.repo, ".git", "modules", "linked"), moved)
    symlinkSync(moved, path.join(w.repo, ".git", "modules", "linked"))
    const s = { level: "standard" as const, folderPath: w.repo, folderName: "app" }
    const { ws, ctx } = prepare(w, s, { inPlace: true })
    const modules = path.join(w.repo, ".git", "modules")
    return { w, ws, ctx, lib, outside, moved, modules }
  }

  function sandboxOf(t: ReturnType<typeof withSubmodules>) {
    const { w, ws, ctx } = t
    const p = levelProfile({ level: "standard", liaisonTools: true }, ctx, {
      sessionFolder: w.repo,
      defaultBranches: ["trunk2"],
      passedMcp: new Set(),
      mirrorReads: [],
      advertisedFolders: [w.code, w.repo],
      inPlace: true,
      ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
    })
    return levelSandboxSettings(p, ctx, {
      ...(ws.commonDir ? { commonDir: ws.commonDir } : {}),
      ...(ws.gitDir ? { gitDir: ws.gitDir } : {}),
      ...(ws.branch ? { branch: ws.branch } : {}),
      ...(ws.nested ? { nested: ws.nested } : {}),
      ...(ws.foreignGitDirs ? { foreignGitDirs: ws.foreignGitDirs } : {}),
    })
  }

  it("resolves lib and lib/deep under .git/modules; a .git file or a modules link pointing out is refused", () => {
    const t = withSubmodules()
    const { ws, modules, outside, moved } = t
    expect(
      ws.nested?.map((n) => ({ ...n, checkout: path.relative(t.w.repo, n.checkout) })),
    ).toEqual([
      {
        checkout: "lib",
        commonDir: path.join(modules, "lib"),
        gitDir: path.join(modules, "lib"),
        branch: "fix/lib",
        defaultBranch: "main",
        remoteUrl: "git@gitlab.example.com:acme/lib.git",
        remoteHost: "gitlab.example.com",
        remoteKind: "ssh",
        remotePort: 22,
        remotePath: "acme/lib",
      },
      {
        // A local path as origin: no remote host to push to.
        checkout: path.join("lib", "deep"),
        commonDir: path.join(modules, "lib", "modules", "deep"),
        gitDir: path.join(modules, "lib", "modules", "deep"),
        branch: "main",
        defaultBranch: "main",
      },
    ])
    // Never granted; their config and hooks are denied wherever they live.
    expect(ws.foreignGitDirs?.sort()).toEqual([path.join(outside, ".git"), moved].sort())
  })

  it("the sandbox: a commit in lib is writable; every repo's config, hooks, HEAD and other branches are not", () => {
    const t = withSubmodules()
    const { modules, outside, moved } = t
    const fs = sandboxOf(t)?.filesystem
    const allow = fs?.allowWrite ?? []
    const denied = fs?.denyWrite ?? []
    const writable = (abs: string) =>
      allow.some((a) => abs === a || abs.startsWith(a + path.sep)) &&
      !denied.some((d) => abs === d || abs.startsWith(d + path.sep))
    const lib = path.join(modules, "lib")
    const deep = path.join(lib, "modules", "deep")
    for (const f of [
      path.join(lib, "objects", "ab", "cdef"),
      path.join(lib, "refs", "heads", "fix", "lib"),
      path.join(lib, "logs", "refs", "heads", "fix", "lib"),
      path.join(lib, "index"),
      path.join(deep, "objects", "ab", "cdef"),
    ]) {
      expect({ f, w: writable(f) }).toEqual({ f, w: true })
    }
    for (const f of [
      path.join(lib, "config"),
      path.join(lib, "hooks", "pre-commit"),
      path.join(lib, "info", "exclude"),
      path.join(lib, "HEAD"),
      path.join(lib, "packed-refs"),
      path.join(lib, "refs", "heads", "main"),
      path.join(lib, "refs", "tags", "v1"),
      path.join(deep, "config"),
      path.join(deep, "hooks", "post-checkout"),
      path.join(deep, "HEAD"),
      // The refused ones: the modules link itself, and the git dirs behind them.
      path.join(modules, "ext"),
      path.join(modules, "linked"),
      path.join(modules, "linked", "objects", "ab"),
      path.join(t.w.repo, ".git", "config"),
      path.join(t.w.repo, ".git", "hooks", "pre-push"),
    ]) {
      expect({ f, w: writable(f) }).toEqual({ f, w: false })
    }
    for (const dir of [path.join(outside, ".git"), moved]) {
      for (const f of ["config", "hooks", "info"]) expect(denied).toContain(path.join(dir, f))
    }
    // Only the resolved git dirs are granted: nothing outside the folder's .git.
    for (const a of allow.filter((x) => x.includes(`${path.sep}modules${path.sep}`))) {
      expect(a.startsWith(lib + path.sep) || a === path.join(lib, "index")).toBe(true)
    }
  })

  it.skipIf(process.platform !== "darwin")(
    "under the session's write denies: a commit on lib's branch lands; config, hooks and HEAD of lib, deep and the refused ones do not change",
    () => {
      const t = withSubmodules()
      const { w, modules, moved } = t
      const run = sandboxRun(sandboxOf(t)?.filesystem?.denyWrite ?? [], w.repo)
      const before = git(["rev-parse", "fix/lib"], t.lib).out.trim()
      writeFileSync(path.join(t.lib, "price.ts"), "export const total = (a: number) => a + 2\n")
      const commit = run("cd lib && git -c user.name=t -c user.email=t@t commit -qam 'fix: lib'")
      expect(commit.status).toBe(0)
      expect(git(["rev-parse", "fix/lib~1"], t.lib).out.trim()).toBe(before)
      const files = [
        path.join(modules, "lib", "config"),
        path.join(modules, "lib", "HEAD"),
        path.join(modules, "lib", "modules", "deep", "config"),
        path.join(moved, "config"),
        path.join(t.outside, ".git", "config"),
      ]
      const snap = () => files.map((f) => readFileSync(f, "utf8"))
      const was = snap()
      for (const command of [
        "cd lib && git config core.fsmonitor 'touch /tmp/pwned'",
        "cd lib && git switch -q main",
        "cd lib/deep && git config core.sshCommand 'sh -c evil'",
        "cd linked && git config core.fsmonitor evil",
        "cd ext && git config core.fsmonitor evil",
        "printf '#!/bin/sh\\n' > .git/modules/lib/hooks/pre-commit",
        "printf '#!/bin/sh\\n' > .git/modules/lib/modules/deep/hooks/pre-commit",
        "rm -rf .git/modules/linked && mkdir .git/modules/linked",
      ]) {
        run(command)
      }
      expect(snap()).toEqual(was)
      for (const hook of ["lib", path.join("lib", "modules", "deep")]) {
        expect(existsSync(path.join(modules, hook, "hooks", "pre-commit"))).toBe(false)
      }
      expect(realpathSync(path.join(modules, "linked"))).toBe(moved)
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "a session never plants commondir, alternates, a rebase todo or a legacy remote in any git dir (the owner's next git never runs its fsmonitor)",
    () => {
      const t = withSubmodules()
      const { w, modules } = t
      const run = sandboxRun(sandboxOf(t)?.filesystem?.denyWrite ?? [], w.repo)
      // The attack: a copy of the git dir whose config runs a monitor, and
      // commondir pointing the real one at it.
      const marker = path.join(w.base, "fsmonitor-ran")
      const evil = path.join(w.base, "evil-git")
      git(["clone", "-q", "--bare", t.lib, evil], w.base)
      writeFileSync(
        path.join(evil, "config"),
        `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = "touch ${marker}; false"\n`,
      )
      const planted: string[] = []
      for (const dir of [
        path.join(w.repo, ".git"),
        path.join(modules, "lib"),
        path.join(modules, "lib", "modules", "deep"),
      ]) {
        for (const [rel, body] of [
          ["commondir", evil],
          ["gitdir", "/tmp/x/.git"],
          ["objects/info/alternates", path.join(evil, "objects")],
          ["rebase-merge/git-rebase-todo", `exec touch ${marker}`],
          ["sequencer/todo", `exec touch ${marker}`],
          ["remotes/origin", "URL: https://evil.example/x.git"],
          ["branches/evil", "https://evil.example/x.git"],
          ["info/attributes", "* filter=x"],
          ["config.worktree", "[core]\n\tfsmonitor = x\n"],
          ["hooks/post-checkout", "#!/bin/sh\n"],
        ] as const) {
          const f = path.join(dir, rel)
          planted.push(f)
          run(`mkdir -p '${path.dirname(f)}' && printf '%s\\n' '${body}' > '${f}'`)
        }
      }
      expect(planted.filter((f) => existsSync(f))).toEqual([])
      // The owner's own git, outside the sandbox, in the parent and the submodule.
      for (const cwd of [w.repo, t.lib]) {
        spawnSync("git", ["status", "--porcelain"], { cwd, env: host, encoding: "utf8" })
      }
      expect(existsSync(marker)).toBe(false)
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "no git dir is planted below the checkout's top or under .git/modules, and no submodule's .git file is rewritten; the commit in lib still lands",
    () => {
      const t = withSubmodules()
      const { w, modules } = t
      const run = sandboxRun(sandboxOf(t)?.filesystem?.denyWrite ?? [], w.repo)
      const gitfile = readFileSync(path.join(t.lib, ".git"), "utf8")
      for (const command of [
        "mkdir -p src/evil && git init -q src/evil",
        "mkdir -p src/other/.git && printf '[core]\\n' > src/other/.git/config",
        "printf 'gitdir: ../../evil\\n' > lib/.git",
        "rm -f lib/.git",
        "mkdir -p .git/modules/planted/.git",
        "mkdir -p .git/modules/lib/modules/x && printf x > .git/modules/lib/modules/x/.git",
        "printf 'gitdir: /tmp/x\\n' > lib/deep/.git",
      ]) {
        run(command)
      }
      for (const f of [
        path.join(w.repo, "src", "evil", ".git"),
        path.join(w.repo, "src", "other", ".git"),
        path.join(modules, "planted", ".git"),
        path.join(modules, "lib", "modules", "x", ".git"),
      ]) {
        expect({ f, there: existsSync(f) }).toEqual({ f, there: false })
      }
      expect(readFileSync(path.join(t.lib, ".git"), "utf8")).toBe(gitfile)
      expect(readFileSync(path.join(t.lib, "deep", ".git"), "utf8")).toStartWith("gitdir: ")
      expect(readFileSync(path.join(t.lib, "deep", ".git"), "utf8")).not.toContain("/tmp/x")
      // An ordinary file named like .git elsewhere stays the session's.
      expect(run("printf x > src/.gitignore && printf x > src/.github").status).toBe(0)
      writeFileSync(path.join(t.lib, "price.ts"), "export const total = (a: number) => a + 3\n")
      expect(
        run("cd lib && git -c user.name=t -c user.email=t@t commit -qam 'fix: lib'").status,
      ).toBe(0)
    },
  )

  it("a detached submodule gets the node's own branch at the same commit (work tree untouched); one on its default gets one too; that default is protected", () => {
    const t = withSubmodules()
    const { w, modules } = t
    const deep = path.join(t.lib, "deep")
    // deep: detached at its commit (git's usual state for a submodule).
    const head = git(["rev-parse", "HEAD"], deep).out.trim()
    expect(git(["switch", "-q", "--detach"], deep).code).toBe(0)
    // lib: back on its default branch, with an uncommitted change.
    expect(git(["switch", "-q", "main"], t.lib).code).toBe(0)
    writeFileSync(path.join(t.lib, "wip.ts"), "export {}\n")
    const libHead = git(["rev-parse", "HEAD"], t.lib).out.trim()
    const again = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    makeInPlaceBranch({
      workspace: again.ws,
      session: again.session,
      sessionDir: again.ctx.sessionDir as string,
    })
    const byPath = (rel: string) =>
      again.ws.nested?.find((n) => path.relative(w.repo, n.checkout) === rel)
    expect(byPath("lib")?.branch).toBe("liaison/c0ffee12-lib")
    expect(byPath(path.join("lib", "deep"))?.branch).toBe("liaison/c0ffee12-deep")
    expect(git(["symbolic-ref", "--short", "HEAD"], deep).out.trim()).toBe("liaison/c0ffee12-deep")
    expect(git(["rev-parse", "HEAD"], deep).out.trim()).toBe(head)
    expect(git(["rev-parse", "HEAD"], t.lib).out.trim()).toBe(libHead)
    expect(readFileSync(path.join(t.lib, "wip.ts"), "utf8")).toBe("export {}\n")
    // The grant: the new ref, never main.
    const fs = sandboxOf({ ...t, ws: again.ws, ctx: again.ctx })?.filesystem
    const writable = (abs: string) =>
      (fs?.allowWrite ?? []).some((a) => abs === a || abs.startsWith(a + path.sep)) &&
      !(fs?.denyWrite ?? []).some((d) => abs === d || abs.startsWith(d + path.sep))
    expect(writable(path.join(modules, "lib", "refs", "heads", "liaison", "c0ffee12-lib"))).toBe(
      true,
    )
    expect(writable(path.join(modules, "lib", "refs", "heads", "main"))).toBe(false)
    expect(writable(path.join(modules, "lib", "modules", "deep", "refs", "heads", "main"))).toBe(
      false,
    )
    // A resume keeps the recorded branch, never a second one.
    const resumed = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    makeInPlaceBranch({
      workspace: resumed.ws,
      session: resumed.session,
      sessionDir: resumed.ctx.sessionDir as string,
    })
    expect(resumed.ws.nested?.map((n) => n.branch)).toEqual([
      "liaison/c0ffee12-lib",
      "liaison/c0ffee12-deep",
    ])
    expect(git(["branch", "--list", "liaison/*"], t.lib).out.trim().split("\n")).toHaveLength(1)
  })

  it("without the branch step (finish none), a submodule on its default or detached gets no ref at all", () => {
    const t = withSubmodules()
    const { w, modules } = t
    expect(git(["switch", "-q", "main"], t.lib).code).toBe(0)
    const s = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app", finishWith: "none" },
      { inPlace: true },
    )
    makeInPlaceBranch({ workspace: s.ws, session: s.session })
    expect(s.ws.nested?.map((n) => n.branch)).toEqual([undefined, undefined])
    expect(git(["symbolic-ref", "--short", "HEAD"], t.lib).out.trim()).toBe("main")
    const fs = sandboxOf({ ...t, ws: s.ws, ctx: s.ctx })?.filesystem
    expect(fs?.allowWrite ?? []).not.toContain(path.join(modules, "lib", "refs", "heads", "main"))
  })

  it("each submodule's default branch is in the node's pre-push guard", () => {
    const w = ownerWorld()
    expect(sub(w.repo, remote(), "lib").code).toBe(0)
    const lib = path.join(w.repo, "lib")
    git(["update-ref", "refs/remotes/origin/trunk-lib", "HEAD"], lib)
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk-lib"], lib)
    const { ws } = prepare(
      w,
      { level: "standard", folderPath: w.repo, folderName: "app" },
      { inPlace: true },
    )
    expect(ws.nested?.[0]?.defaultBranch).toBe("trunk-lib")
    const hook = readFileSync(path.join(ws.hooksDir as string, "pre-push"), "utf8")
    expect(hook).toContain("trunk-lib")
    expect(hook).toContain("trunk2")
  })
})

/**
 * The sandbox's write denies as Seatbelt rules, globs as the CLI turns them
 * into regexes (`**\/` any folders, `*` one segment, the path and below).
 */
function sandboxRun(denyWrite: readonly string[], cwd: string) {
  const esc = (s: string) => s.replace(/[.^$+{}()|\\]/g, "\\$&")
  const globRegex = (g: string) =>
    `^${esc(g)
      .replace(/\*\*\//g, "__GS__")
      .replace(/\*\*/g, "__G__")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/__GS__/g, "(.*/)?")
      .replace(/__G__/g, ".*")}(/.*)?$`
  const rules = denyWrite.map((d) =>
    /[*?]/.test(d)
      ? `(deny file-write* (regex ${JSON.stringify(globRegex(d))}))`
      : `(deny file-write* (subpath ${JSON.stringify(d)}))`,
  )
  const seatbelt = `(version 1)(allow default)${rules.join("")}`
  return (command: string) =>
    spawnSync("sandbox-exec", ["-p", seatbelt, "/bin/sh", "-c", command], {
      cwd,
      env: host,
      encoding: "utf8",
    })
}

// An SSH push runs in the sandbox, so the hook holds it to the session's own
// branch per repository (the broker does for HTTPS): a submodule's push named
// another branch and went out (2026-10-22).
describe("the pre-push hook knows each repository's own branch", () => {
  it("a repository with an own branch pushes it only; one with none keeps the default rules", () => {
    const dir = realpathSync(mkdtempSync(path.join(root, "own hook-")))
    const app = path.join(dir, "app")
    const lib = path.join(dir, "lib")
    const free = path.join(dir, "free")
    for (const r of [app, lib, free]) git(["init", "-q", "-b", "main", r], dir)
    const realGit = spawnSync("/usr/bin/which", ["git"], { encoding: "utf8" }).stdout.trim()
    const hook = path.join(dir, "pre-push")
    writeFileSync(
      hook,
      prePushHookScript(["main"], {
        git: realGit,
        own: [
          { gitDir: path.join(app, ".git"), branch: "liaison/s-app" },
          { gitDir: path.join(lib, ".git"), branch: "liaison/s-lib" },
          // A default branch is never a repository's own: the rules above hold it.
          { gitDir: path.join(free, ".git"), branch: "main" },
        ],
      }),
      { mode: 0o700 },
    )
    const zero = "0".repeat(40)
    const sha = "1".repeat(40)
    const push = (cwd: string, branch: string) =>
      spawnSync("/bin/sh", [hook, "origin", "url"], {
        cwd,
        env: host,
        encoding: "utf8",
        input: `refs/heads/x ${sha} refs/heads/${branch} ${zero}\n`,
      })
    expect(push(lib, "liaison/s-lib").status).toBe(0)
    const other = push(lib, "liaison/s-app")
    expect(other.status).toBe(1)
    expect(other.stderr).toContain("only this session's branch liaison/s-lib is pushed")
    expect(push(app, "liaison/s-app").status).toBe(0)
    expect(push(app, "fix-1").status).toBe(1)
    // No own branch: any branch but a protected one, as before.
    expect(push(free, "fix-1").status).toBe(0)
    expect(push(free, "main").status).toBe(1)
    expect(() =>
      prePushHookScript([], { own: [{ gitDir: "relative/.git", branch: "b" }] }),
    ).toThrow()
    expect(() => prePushHookScript([], { own: [{ gitDir: "/a/.git", branch: "b;rm" }] })).toThrow()
  })
})
