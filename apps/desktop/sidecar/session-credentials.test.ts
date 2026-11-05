// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D53 (P1b B1/B4): no secret enters the session. The node's action broker
// pushes, fetches and runs gh outside the sandbox and answers with output
// only. Real git, a real Unix socket, local bare remotes, a stand-in for gh.
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type BrokerGh,
  type BrokerPlan,
  decidePush,
  ghPlanFor,
  nodeCloneAuthEnv,
  parseGhCommand,
  remoteRepoPath,
  sshRemoteTarget,
  startCredentialBroker,
  transportOf,
  writeGhShim,
  writeGitPushShim,
} from "./session-credentials"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-cred-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const TOKEN = "gho_D53canaryTOKEN0000000000"

async function run(cmd: string[], env: Record<string, string>, input?: string) {
  const child = Bun.spawn(cmd, {
    stdin: input === undefined ? "ignore" : new Response(input),
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code: await child.exited, out, err }
}

describe("D53 remote paths", () => {
  it("names a repository from every remote spelling", () => {
    expect(remoteRepoPath("https://github.com/Acme/App.git")).toBe("acme/app")
    expect(remoteRepoPath("git@github.com:acme/app.git")).toBe("acme/app")
    expect(remoteRepoPath("ssh://git@gitlab.example.org:2222/group/sub/app")).toBe("group/sub/app")
    expect(remoteRepoPath("git@github.com:acme/../x")).toBeNull()
  })
})

describe("D53 the gh grammar: the verbs the broker runs gh for", () => {
  it("only the allowed verbs on the session's own repository", () => {
    expect(parseGhCommand(["pr", "create", "--title", "t", "--body", "b"]).ok).toBe(true)
    expect(parseGhCommand(["pr", "list"]).ok).toBe(true)
    expect(parseGhCommand(["run", "view", "12"]).ok).toBe(true)
    for (const argv of [
      // P1b-fix F1: no -R at all, even the own repository (the broker sets it).
      ["-R", "acme/app", "issue", "view", "3"],
      ["pr", "view", "--repo", "github.com/acme/app"],
      ["pr", "create", "--repo", "attacker/x", "--body", "x"],
      ["pr", "view", "https://github.com/attacker/x/pull/1"],
      ["api", "repos/acme/app/pulls", "-f", "title=x"],
      ["auth", "token"],
      ["auth", "status", "--show-token"],
      ["pr", "merge", "3"],
      ["repo", "clone", "attacker/x"],
    ]) {
      expect({ argv, ok: parseGhCommand(argv).ok }).toEqual({ argv, ok: false })
    }
  })

  // P1b-fix F1: an explicit grammar per verb; anything it does not name is never run.
  it("the fix skeptic's clusters, every -R spelling, unknown flags and extra positionals are refused", () => {
    for (const argv of [
      ["pr", "create", "-dR", "attacker/x", "--title", "t", "--body", "b"],
      ["pr", "view", "1", "-cR", "attacker/x"],
      ["pr", "create", "-fR", "attacker/x"],
      ["pr", "create", "-Rattacker/x"],
      ["pr", "view", "1", "--repo=attacker/x"],
      ["pr", "list", "--repo=acme/app"],
      ["issue", "view", "https://github.com/attacker/x/issues/1"],
      ["pr", "view", "1", "--web"],
      ["pr", "create", "--editor"],
      ["pr", "create", "--draft=true"],
      ["pr", "view", "1", "2"],
      ["pr", "view", "--", "1"],
      ["issue", "view"],
      ["pr", "create", "--title"],
      ["alias", "set", "pv", "pr view -R attacker/x"],
      ["api", "graphql", "-f", "query=x"],
      ["--repo", "attacker/x", "pr", "view", "1"],
      ["pr", "view", "3", "--json", "url", "--jq", ".url"],
      ["pr", "list", "--search", "fix"],
      [],
    ]) {
      expect({ argv, ok: parseGhCommand(argv).ok }).toEqual({ argv, ok: false })
    }
    for (const argv of [
      ["pr", "create", "--title", "t", "--body", "b", "--base", "main", "--head", "node/x", "-d"],
      ["pr", "create", "--title=t", "--body-file", "out/body.md"],
      ["pr", "view", "3", "--json", "url"],
      ["pr", "list", "--state", "open", "-L", "5"],
      ["run", "view", "12", "--log-failed"],
      ["issue", "view", "#3", "-c"],
    ]) {
      expect({ argv, ok: parseGhCommand(argv).ok }).toEqual({ argv, ok: true })
    }
  })
})

const GIT_ENV = {
  PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "n",
  GIT_AUTHOR_EMAIL: "n@example.com",
  GIT_COMMITTER_NAME: "n",
  GIT_COMMITTER_EMAIL: "n@example.com",
}
const PASSWORD = ["glpat", "D53canaryPASSWORD000"].join("-") // fake, joined so the source holds no token-shaped literal

/**
 * The owner's checkout on the session's branch `node/x`, its origin a local
 * bare repository (the "resolved remote"), and a second remote `evil` the
 * owner's config also names; the broker serves the checkout with a canary
 * credential and a canary gh login. `gh` is a stand-in that prints its whole
 * environment and argv, and a body file's content.
 */
async function brokerWorld(name: string) {
  const dir = realpathSync(mkdtempSync(path.join(root, `${name}-`)))
  const g = (cwd: string, ...argv: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...argv], { env: GIT_ENV, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const remote = path.join(dir, "remote.git")
  const evil = path.join(dir, "evil.git")
  const repo = path.join(dir, "repo")
  for (const bare of [remote, evil])
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: GIT_ENV })
  spawnSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV })
  writeFileSync(path.join(repo, "a.txt"), "a\n")
  g(repo, "add", "a.txt")
  g(repo, "commit", "-q", "-m", "a")
  g(repo, "remote", "add", "origin", remote)
  g(repo, "remote", "add", "evil", evil)
  g(repo, "push", "-q", "origin", "main")
  g(repo, "switch", "-q", "-c", "node/x")
  writeFileSync(path.join(repo, "a.txt"), "b\n")
  g(repo, "commit", "-qam", "b")
  g(repo, "branch", "other")
  const realGit = spawnSync("/usr/bin/which", ["git"], {
    env: GIT_ENV,
    encoding: "utf8",
  }).stdout.trim()
  const fakeGh = path.join(dir, "real-gh")
  writeFileSync(
    fakeGh,
    '#!/bin/sh\necho "ARGV $*"\n/usr/bin/env\n[ -f "$GH_CONFIG_DIR/hosts.yml" ] && echo "HOSTS $(tr -d "\\n" < "$GH_CONFIG_DIR/hosts.yml")"\nfor a do case "$prev" in --body-file|-F) echo "BODY $(cat "$a")";; esac; prev=$a; done\n',
    { mode: 0o755 },
  )
  const plan: BrokerPlan = {
    git: realGit,
    repos: [
      {
        gitDir: path.join(repo, ".git"),
        url: remote,
        branch: "node/x",
        protected: ["main", "master"],
        credential: { username: "oauth2", password: PASSWORD },
      },
    ],
    gh: [
      {
        bin: fakeGh,
        token: TOKEN,
        repoPath: "acme/app",
        cwd: repo,
        branch: "node/x",
        gitDir: realpathSync(path.join(repo, ".git")),
        origin: true,
      },
    ],
    env: GIT_ENV,
  }
  const broker = await startCredentialBroker({ plan, socketBase: dir })
  const binDir = path.join(dir, "bin")
  const gitShim = writeGitPushShim({ binDir, git: realGit, socket: broker.socket })
  const ghShim = writeGhShim({ binDir, socket: broker.socket, git: realGit }) as string
  const remoteRef = (bare: string, ref: string) =>
    spawnSync("git", ["--git-dir", bare, "rev-parse", "-q", "--verify", ref], {
      env: GIT_ENV,
      encoding: "utf8",
    }).stdout.trim()
  // The session's environment: no secret, the shims first.
  const sessionEnv = { ...GIT_ENV, PATH: `${binDir}:${GIT_ENV.PATH}` }
  return { dir, repo, remote, evil, broker, gitShim, ghShim, remoteRef, sessionEnv, g, plan }
}

describe("D53: the action broker never hands out a secret", () => {
  it("a script the session writes to disk, speaking the broker's protocol over its socket, gets no token or password back", async () => {
    const w = await brokerWorld("exfil")
    try {
      const gitDir = path.join(w.repo, ".git")
      // Every request shape: the old credential and token ones, gh's own
      // login, an env dump through gh, pushes, fetches, junk.
      const requests = [
        "git\\0protocol=https\\nhost=github.com\\npath=acme/app\\n\\n",
        "gh\\0pr\\0list\\0",
        "gh\\0\\0\\0auth\\0token\\0",
        "gh\\0\\0\\0auth\\0status\\0--show-token\\0",
        "gh\\0\\0\\0pr\\0list\\0",
        "gh\\0\\0\\0pr\\0view\\0#3\\0",
        // A git dir the node made no plan for: the checkout's plan, never another repository.
        "gh\\0\\0/etc\\0pr\\0list\\0",
        `git\\0push\\0${gitDir}\\0origin\\0node/x\\0`,
        `git\\0push\\0${gitDir}\\0origin\\0main\\0`,
        `git\\0fetch\\0${gitDir}\\0origin\\0`,
        `git\\0fetch\\0${gitDir}\\0https://evil.example/x.git\\0`,
        `git\\0credential\\0${gitDir}\\0fill\\0`,
        "junk",
      ]
      const script = path.join(w.dir, "probe.sh")
      writeFileSync(
        script,
        `#!/bin/sh\n${requests
          .map((r) => `printf '${r}' | /usr/bin/nc -U '${w.broker.socket}'; echo`)
          .join("\n")}\n`,
        { mode: 0o755 },
      )
      const sh = await run(["/bin/sh", script], w.sessionEnv)
      const decoded = sh.out
        .split("\n")
        .flatMap((l) => {
          const m = /^(out|err)=(.*)$/.exec(l)
          return m ? [Buffer.from(m[2] as string, "base64").toString("utf8")] : [l]
        })
        .join("\n")
      // The probe reached the broker (gh ran, the push landed) and got output only.
      expect(decoded).toContain("ARGV pr list")
      expect(decoded).toContain("GH_REPO=acme/app")
      expect(w.remoteRef(w.remote, "refs/heads/node/x")).not.toBe("")
      for (const secret of [TOKEN, PASSWORD]) {
        expect(sh.out).not.toContain(secret)
        expect(decoded).not.toContain(secret)
      }
      // gh ran with no token in its environment; its own config file held it, scrubbed.
      expect(decoded).not.toMatch(/^GH_TOKEN=/m)
      expect(decoded).toContain("oauth_token: ***")
      // The same from python, when this computer has it.
      const py = spawnSync("/usr/bin/python3", ["--version"], { encoding: "utf8" })
      if (py.status === 0) {
        const probe = path.join(w.dir, "probe.py")
        writeFileSync(
          probe,
          [
            "import socket, sys",
            `reqs = [${requests.map((r) => JSON.stringify(r.replace(/\\0/g, "\u0000").replace(/\\n/g, "\n"))).join(", ")}]`,
            "for r in reqs:",
            "    s = socket.socket(socket.AF_UNIX)",
            `    s.connect(${JSON.stringify(w.broker.socket)})`,
            "    s.sendall(r.encode()); s.shutdown(socket.SHUT_WR)",
            "    data = b''",
            "    while True:",
            "        c = s.recv(65536)",
            "        if not c: break",
            "        data += c",
            "    sys.stdout.write(data.decode(errors='replace'))",
          ].join("\n"),
        )
        const out = await run(["/usr/bin/python3", probe], w.sessionEnv)
        expect(out.out).toContain("exit=")
        for (const secret of [TOKEN, PASSWORD]) expect(out.out).not.toContain(secret)
      }
    } finally {
      w.broker.close()
    }
  }, 60_000)

  it("git credential fill in the session's git (through its shim) returns no password", async () => {
    const w = await brokerWorld("fill")
    try {
      const fill = await run(
        [w.gitShim, "-C", w.repo, "credential", "fill"],
        w.sessionEnv,
        "protocol=https\nhost=github.com\npath=acme/app\n\n",
      )
      expect(fill.out).not.toContain("password=")
      for (const secret of [TOKEN, PASSWORD]) expect(`${fill.out}${fill.err}`).not.toContain(secret)
    } finally {
      w.broker.close()
    }
  })
})

describe("D53: git push, fetch and pull run in the broker, for the session's own branch only", () => {
  it("the session's own branch pushes through the shim; fetch and pull work; the remote never sees anything else", async () => {
    const w = await brokerWorld("push")
    try {
      const pushed = await run(
        [w.gitShim, "-C", w.repo, "push", "-u", "origin", "node/x"],
        w.sessionEnv,
      )
      expect({ code: pushed.code, err: pushed.err }).toMatchObject({ code: 0 })
      expect(w.remoteRef(w.remote, "refs/heads/node/x")).toBe(w.g(w.repo, "rev-parse", "node/x"))
      // HEAD names the own branch too.
      writeFileSync(path.join(w.repo, "a.txt"), "c\n")
      w.g(w.repo, "commit", "-qam", "c")
      expect(
        (await run([w.gitShim, "-C", w.repo, "push", "origin", "HEAD"], w.sessionEnv)).code,
      ).toBe(0)
      expect(w.remoteRef(w.remote, "refs/heads/node/x")).toBe(w.g(w.repo, "rev-parse", "HEAD"))
      // Someone else moves main on the remote; the session fetches and pulls it.
      const other = path.join(w.dir, "other")
      spawnSync("git", ["clone", "-q", w.remote, other], { env: GIT_ENV })
      writeFileSync(path.join(other, "z.txt"), "z\n")
      w.g(other, "add", "z.txt")
      w.g(other, "commit", "-qm", "z")
      w.g(other, "push", "-q", "origin", "main")
      expect((await run([w.gitShim, "-C", w.repo, "fetch", "origin"], w.sessionEnv)).code).toBe(0)
      expect(w.g(w.repo, "rev-parse", "refs/remotes/origin/main")).toBe(
        w.g(other, "rev-parse", "HEAD"),
      )
      const pulled = await run([w.gitShim, "-C", w.repo, "pull", "origin", "main"], w.sessionEnv)
      expect(pulled.code).toBe(0)
      expect(readFileSync(path.join(w.repo, "z.txt"), "utf8")).toBe("z\n")
    } finally {
      w.broker.close()
    }
  }, 60_000)

  it("another branch, a force push, a delete, a session URL, another remote and a protected branch are refused with the reason and what is allowed", async () => {
    const w = await brokerWorld("refuse")
    try {
      const before = {
        node: w.remoteRef(w.remote, "refs/heads/node/x"),
        main: w.remoteRef(w.remote, "refs/heads/main"),
      }
      for (const argv of [
        ["push", "origin", "other"],
        ["push", "origin", "other:node/x"],
        ["push", "origin", "node/x:other"],
        ["push", "--force", "origin", "node/x"],
        ["push", "-f", "origin", "node/x"],
        ["push", "origin", "+node/x"],
        ["push", "--force-with-lease", "origin", "node/x"],
        ["push", "origin", ":node/x"],
        ["push", "--delete", "origin", "node/x"],
        ["push", "--tags", "origin", "node/x"],
        ["push", "--mirror", "origin"],
        ["push", w.evil, "node/x"],
        ["push", "https://evil.example/x.git", "node/x"],
        ["push", "evil", "node/x"],
        ["push", "origin", "main"],
        ["push", "origin", "node/x:main"],
        ["push", "origin", "refs/tags/v1"],
        ["fetch", "evil"],
        ["fetch", "origin", "main:refs/heads/main"],
        ["pull", "evil", "main"],
      ]) {
        const r = await run([w.gitShim, "-C", w.repo, ...argv], w.sessionEnv)
        expect({ argv, code: r.code }).toEqual({ argv, code: 1 })
        expect({
          argv,
          said: r.err.startsWith("Liaison node: git ") && r.err.includes("Allowed:"),
        }).toEqual({ argv, said: true })
      }
      expect(w.remoteRef(w.remote, "refs/heads/node/x")).toBe(before.node)
      expect(w.remoteRef(w.remote, "refs/heads/main")).toBe(before.main)
      expect(w.remoteRef(w.remote, "refs/heads/other")).toBe("")
      expect(w.remoteRef(w.evil, "refs/heads/node/x")).toBe("")
      // A protected own branch is never pushed, however it was granted.
      const mainPlan = decidePush(
        ["origin", "main"],
        { url: w.remote, branch: "main", protected: ["main"] },
        () => w.remote,
        () => "main",
      )
      expect(mainPlan.ok).toBe(false)
    } finally {
      w.broker.close()
    }
  }, 60_000)

  it("a session's branch made a symbolic ref to another branch is not pushed", async () => {
    const w = await brokerWorld("symref")
    try {
      w.g(w.repo, "symbolic-ref", "refs/heads/node/x", "refs/heads/main")
      const r = await run([w.gitShim, "-C", w.repo, "push", "origin", "node/x"], w.sessionEnv)
      expect({ code: r.code, err: r.err }).toEqual({
        code: 1,
        err: "Liaison node: git push refused: refs/heads/node/x is not a plain branch. Allowed: git push origin node/x\n",
      })
      expect(w.remoteRef(w.remote, "refs/heads/node/x")).toBe("")
    } finally {
      w.broker.close()
    }
  })

  it("gh runs in the broker with the login; the session sees its output, never the token, and a body file is read in the session", async () => {
    const w = await brokerWorld("gh")
    try {
      const body = path.join(w.dir, "body.md")
      writeFileSync(body, "the PR body\n")
      const r = await run([w.ghShim, "pr", "create", "--title", "t", "--body-file", body], {
        ...w.sessionEnv,
        GH_TOKEN: "session-set",
        GH_REPO: "attacker/x",
      })
      expect(r.code).toBe(0)
      expect(r.out).toContain("ARGV pr create --title t --body-file")
      expect(r.out).toContain("BODY the PR body")
      expect(r.out).toContain("GH_REPO=acme/app")
      // The login is in the run's own config file, never in gh's environment
      // (a --jq filter can read the environment).
      expect(r.out).not.toMatch(/^GH_TOKEN=/m)
      expect(r.out).toContain("HOSTS github.com:    oauth_token: ***")
      expect(r.out).not.toContain(TOKEN)
      // gh never reads a path the session names: the node's own copy of the bytes.
      expect(r.out).not.toContain(`--body-file ${body}`)
      const refused = await run([w.ghShim, "auth", "token"], w.sessionEnv)
      expect(refused.code).toBe(1)
      expect(refused.err).toContain("Allowed: gh pr create")
      const merge = await run([w.ghShim, "pr", "merge", "3"], w.sessionEnv)
      expect(merge.code).toBe(1)
    } finally {
      w.broker.close()
    }
  })
})

describe("D53: gh values the grammar cannot judge by name", () => {
  it("no --search, --jq or --template (filters run beside the login), a foreign --head refused and the own one added, an empty body file is a body", async () => {
    const w = await brokerWorld("gh")
    try {
      for (const argv of [
        ["pr", "list", "--search", "repo:other/x is:open"],
        ["pr", "list", "-S", "fix org:acme"],
        ["pr", "list", "--search=user:someone"],
        ["pr", "list", "--search", "(OWNER:x)"],
        ["pr", "view", "3", "--json", "title", "--jq", "$ENV"],
        ["pr", "view", "3", "--json", "title", "--jq", "env.GH_TOKEN | @base64"],
        ["pr", "list", "--json", "title", "-q", "[$__loc__]"],
        ["issue", "view", "1", "--json", "title", "--template", "{{ env }}"],
        ["pr", "create", "--title", "t", "--head", "main"],
        ["pr", "create", "--title", "t", "-H", "someone:node/x"],
        ["pr", "create", "--title", "t", "--head=other"],
        // Attached short values are not a grammar spelling: refused whole.
        ["pr", "list", "-Srepo:other/x"],
        ["pr", "create", "--title", "t", "-Hmain"],
        ["pr", "view", "3", "--json", "title", "-q.title"],
        ["pr", "view", "3", "--json", "title", "--jq", ".title"],
        ["pr", "list", "--template", "{{.}}"],
      ]) {
        const r = await run([w.ghShim, ...argv], w.sessionEnv)
        expect({ argv, code: r.code, refused: r.err.includes("Liaison node: gh refused") }).toEqual(
          {
            argv,
            code: 1,
            refused: true,
          },
        )
        expect(r.out).not.toContain("ARGV")
      }
      const ok = await run([w.ghShim, "pr", "list", "--json", "title"], w.sessionEnv)
      expect(ok.code).toBe(0)
      // gh picks no head from the checkout: the broker names the session's own.
      const noHead = await run([w.ghShim, "pr", "create", "--title", "t"], w.sessionEnv)
      expect(noHead.out).toContain("ARGV pr create --title t --head node/x")
      const head = await run(
        [w.ghShim, "pr", "create", "--title", "t", "--head", "node/x"],
        w.sessionEnv,
      )
      expect(head.code).toBe(0)
      const empty = path.join(w.dir, "empty.md")
      writeFileSync(empty, "")
      const e = await run(
        [w.ghShim, "pr", "create", "--title", "t", "--body-file", empty],
        w.sessionEnv,
      )
      expect({ code: e.code, err: e.err }).toEqual({ code: 0, err: "" })
      expect(e.out).toContain("BODY ")
    } finally {
      w.broker.close()
    }
  })
})

describe("gh for each GitHub repository of the session", () => {
  it("in a submodule gh is pinned to that repository and its branch; elsewhere to the checkout's", async () => {
    const w = await brokerWorld("gh-sub")
    const sub = path.join(w.dir, "sub")
    spawnSync("git", ["init", "-q", "-b", "liaison/s-sub", sub], { env: GIT_ENV })
    const origin = w.plan.gh[0] as BrokerGh
    const subPlan: BrokerGh = {
      ...origin,
      repoPath: "acme/sub",
      cwd: sub,
      branch: "liaison/s-sub",
      gitDir: realpathSync(path.join(sub, ".git")),
      origin: false,
    }
    const both = await startCredentialBroker({
      plan: { ...w.plan, gh: [origin, subPlan] },
      socketBase: w.dir,
    })
    const binDir = path.join(w.dir, "bin2")
    const realGit = spawnSync("/usr/bin/which", ["git"], {
      env: GIT_ENV,
      encoding: "utf8",
    }).stdout.trim()
    const shim = writeGhShim({ binDir, socket: both.socket, git: realGit }) as string
    const inDir = (cwd: string, ...argv: string[]) =>
      run(
        ["/bin/sh", "-c", `cd "$1" && shift && exec "$@"`, "sh", cwd, shim, ...argv],
        w.sessionEnv,
      )
    try {
      const inSub = await inDir(sub, "pr", "create", "--title", "t")
      expect(inSub.code).toBe(0)
      expect(inSub.out).toContain("GH_REPO=acme/sub")
      expect(inSub.out).toContain("ARGV pr create --title t --head liaison/s-sub")
      // Its branch only, as in the checkout.
      const foreign = await inDir(sub, "pr", "create", "--title", "t", "--head", "node/x")
      expect(foreign.code).toBe(1)
      const inRepo = await inDir(w.repo, "pr", "create", "--title", "t")
      expect(inRepo.out).toContain("GH_REPO=acme/app")
      expect(inRepo.out).toContain("--head node/x")
      const outside = await inDir(w.dir, "pr", "list")
      expect(outside.out).toContain("GH_REPO=acme/app")
      expect(outside.out + outside.err).not.toContain(TOKEN)
    } finally {
      both.close()
      w.broker.close()
    }
  })

  it("a claim picks among the node's plans only: unknown, with no checkout plan and two others, is refused", () => {
    const base = { bin: "/x/gh", token: "t0ken", cwd: "/", branch: "b" }
    const dirA = realpathSync(mkdtempSync(path.join(root, "claim-a-")))
    const dirB = realpathSync(mkdtempSync(path.join(root, "claim-b-")))
    const plan: BrokerPlan = {
      git: "/usr/bin/git",
      repos: [],
      env: {},
      gh: [
        { ...base, repoPath: "a/a", gitDir: dirA },
        { ...base, repoPath: "b/b", gitDir: dirB },
      ],
    }
    expect((ghPlanFor(plan, dirB) as BrokerGh).repoPath).toBe("b/b")
    expect(ghPlanFor(plan, "/nowhere")).toContain("run gh inside the repository")
    expect(ghPlanFor(plan, "")).toContain("run gh inside the repository")
    expect((ghPlanFor({ ...plan, gh: [plan.gh[1] as BrokerGh] }, "") as BrokerGh).repoPath).toBe(
      "b/b",
    )
    expect(ghPlanFor({ ...plan, gh: [] }, dirA)).toContain("no repository of this session")
  })
})

describe("D53 (B4) the node's own clone", () => {
  it("gets the credential in its process env through a host-scoped helper; nothing without one", () => {
    const base = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" }
    expect(nodeCloneAuthEnv(null, base)).toEqual(base)
    expect(nodeCloneAuthEnv({ host: "gitlab.com", repoPath: "a/b" }, base)).toEqual(base)
    const env = nodeCloneAuthEnv(
      { host: "gitlab.com", repoPath: "a/b", git: { username: "oauth2", password: "glpat-x" } },
      base,
    )
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://gitlab.com.helper")
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("glpat-x")
    expect(env.LIAISON_NODE_CLONE_PASSWORD).toBe("glpat-x")
  })
})

describe("walk D2: where ssh goes for the remote (its forge, an alias resolved)", () => {
  it("the alias's HostName, the URL's port else 22 plus the config's Port, and its identity files", () => {
    const none = () => ""
    expect(sshRemoteTarget("git@gitlab.com:a/b.git", "gitlab.com", "/Users/o", none)).toEqual({
      hostname: "gitlab.com",
      ports: [22],
      identityFiles: [],
    })
    expect(
      sshRemoteTarget("ssh://git@host.example:2222/a/b.git", "host.example", "/Users/o", none)
        .ports,
    ).toEqual([2222])
    const alias = () =>
      "hostname gitlab.com\nport 443\nidentityfile ~/.ssh/id_tcdev\nidentityfile /k/%h\n"
    expect(
      sshRemoteTarget("git@gitlab-tc-dev:a/b.git", "gitlab-tc-dev", "/Users/o", alias),
    ).toEqual({
      hostname: "gitlab.com",
      ports: [22, 443],
      identityFiles: ["/Users/o/.ssh/id_tcdev"],
    })
  })
})

describe("the broker serves an SSH remote too (2026-10-22)", () => {
  it("the node's git allows the URL's own transport only", () => {
    expect(transportOf("https://github.com/a/b.git")).toBe("https")
    expect(transportOf("HTTPS://github.com/a/b.git")).toBe("https")
    expect(transportOf("git@github.com:a/b.git")).toBe("ssh")
    expect(transportOf("ssh://git@gitlab.com:2222/a/b.git")).toBe("ssh")
    expect(transportOf("/srv/git/b.git")).toBe("file")
    // A helper transport reads as ssh, and git allows no other: protocol.allow=never.
    expect(transportOf("ext::sh -c touch% /tmp/x")).toBe("ssh")
  })

  it("the session's own branch pushes over SSH through the broker, with the agent in the node only; another branch is refused", async () => {
    const dir = realpathSync(mkdtempSync(path.join(root, "ssh-")))
    const bare = path.join(dir, "remote.git")
    const repo = path.join(dir, "repo")
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: GIT_ENV })
    spawnSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV })
    const g = (...argv: string[]) =>
      spawnSync("git", ["-C", repo, ...argv], { env: GIT_ENV, encoding: "utf8" })
    writeFileSync(path.join(repo, "a.txt"), "a\n")
    g("add", "a.txt")
    g("commit", "-q", "-m", "a")
    g("switch", "-q", "-c", "node/s")
    g("branch", "other")
    const url = `ssh://fake.example${bare}`
    g("remote", "add", "origin", url)
    // A stand-in ssh: runs the remote command here, and says whether it saw the agent.
    const fakeSsh = path.join(dir, "fake-ssh")
    writeFileSync(
      fakeSsh,
      '#!/bin/sh\necho "agent=${SSH_AUTH_SOCK:-none}" >> "$(dirname "$0")/ssh.log"\nshift\neval "$@"\n',
      { mode: 0o755 },
    )
    const realGit = spawnSync("/usr/bin/which", ["git"], {
      env: GIT_ENV,
      encoding: "utf8",
    }).stdout.trim()
    const broker = await startCredentialBroker({
      plan: {
        git: realGit,
        repos: [
          {
            gitDir: realpathSync(path.join(repo, ".git")),
            url,
            branch: "node/s",
            protected: ["main"],
            credential: null,
          },
        ],
        gh: [],
        env: { ...GIT_ENV, GIT_SSH_COMMAND: fakeSsh, SSH_AUTH_SOCK: "/tmp/owner-agent.sock" },
      },
      socketBase: dir,
    })
    const binDir = path.join(dir, "bin")
    const shim = writeGitPushShim({ binDir, git: realGit, socket: broker.socket })
    // The session: no agent of its own, the shim first.
    const env = { ...GIT_ENV, PATH: `${binDir}:${GIT_ENV.PATH}` }
    try {
      const own = await run(["/bin/sh", "-c", `cd "${repo}" && "${shim}" push origin node/s`], env)
      expect(own.code).toBe(0)
      const landed = spawnSync(
        "git",
        ["--git-dir", bare, "rev-parse", "-q", "--verify", "refs/heads/node/s"],
        {
          env: GIT_ENV,
          encoding: "utf8",
        },
      )
      expect(landed.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
      expect(readFileSync(path.join(dir, "ssh.log"), "utf8")).toContain(
        "agent=/tmp/owner-agent.sock",
      )
      const other = await run(["/bin/sh", "-c", `cd "${repo}" && "${shim}" push origin other`], env)
      expect(other.code).toBe(1)
      expect(other.err).toContain("only this session's branch node/s is pushed here")
      const main = await run(
        ["/bin/sh", "-c", `cd "${repo}" && "${shim}" push origin node/s:main`],
        env,
      )
      expect(main.code).toBe(1)
      expect(
        spawnSync("git", ["--git-dir", bare, "rev-parse", "-q", "--verify", "refs/heads/other"], {
          env: GIT_ENV,
        }).status,
      ).not.toBe(0)
    } finally {
      broker.close()
    }
  })
})

describe("final walk F2: `git push -u` without a write to git's config", () => {
  it("the shim drops -u and --set-upstream from git push only, whatever comes before push", async () => {
    const binDir = path.join(root, "f2-bin")
    const fakeGit = path.join(root, "f2-real-git")
    writeFileSync(fakeGit, '#!/bin/sh\nfor a do printf "[%s]" "$a"; done\n', { mode: 0o755 })
    const shim = writeGitPushShim({ binDir, git: fakeGit })
    expect(shim).toBe(path.join(binDir, "git"))
    const args = async (...argv: string[]) =>
      (await run([shim, ...argv], { PATH: "/usr/bin:/bin" })).out
    expect(await args("push", "-u", "origin", "node/x")).toBe("[push][origin][node/x]")
    expect(await args("push", "--set-upstream", "origin", "node/x")).toBe("[push][origin][node/x]")
    expect(await args("-C", "a dir", "-c", "x.y=-u", "push", "origin", "-u", "node/x")).toBe(
      "[-C][a dir][-c][x.y=-u][push][origin][node/x]",
    )
    // Not a push, or after `--`: unchanged.
    expect(await args("status", "-u")).toBe("[status][-u]")
    expect(await args("-C", "push", "commit", "-u")).toBe("[-C][push][commit][-u]")
    expect(await args("push", "origin", "--", "-u")).toBe("[push][origin][--][-u]")
    expect(() => writeGitPushShim({ binDir, git: "git" })).toThrow()
  })

  it("a push -u from a worktree whose repository config is not writable succeeds with no config error", async () => {
    const dir = path.join(root, "f2-real")
    mkdirSync(dir, { recursive: true })
    const env = {
      PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "n",
      GIT_AUTHOR_EMAIL: "n@example.com",
      GIT_COMMITTER_NAME: "n",
      GIT_COMMITTER_EMAIL: "n@example.com",
    }
    const git = async (cwd: string, ...argv: string[]) =>
      run(["git", "-C", cwd, ...argv], env).then((r) => {
        if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.err}`)
        return r
      })
    const remote = path.join(dir, "remote.git")
    const repo = path.join(dir, "repo")
    const wt = path.join(dir, "wt")
    await run(["git", "init", "-q", "--bare", remote], env)
    await run(["git", "init", "-q", repo], env)
    await git(repo, "commit", "-q", "--allow-empty", "-m", "a")
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "worktree", "add", "-q", "-b", "node/x", wt, "HEAD")
    const realGit = (await run(["/usr/bin/which", "git"], env)).out.trim()
    const shim = writeGitPushShim({ binDir: path.join(root, "f2-real-bin"), git: realGit })
    // The session cannot write the owner's config (the sandbox denies it).
    const config = path.join(repo, ".git", "config")
    chmodSync(config, 0o444)
    try {
      const pushed = await run([shim, "-C", wt, "push", "-u", "origin", "node/x"], env)
      expect(pushed.code).toBe(0)
      expect(pushed.err).not.toContain("could not lock config file")
      expect(pushed.err).not.toContain("unable to write upstream")
      const remoteRefs = await run(["git", "--git-dir", remote, "branch", "--list"], env)
      expect(remoteRefs.out).toContain("node/x")
    } finally {
      chmodSync(config, 0o644)
    }
  })
})

// 2026-10-22: a session started on an older app kept that version's shims on
// resume. Each shim is read-only, so rewriting it in place threw, the caller
// swallowed it, and the session ran the old version's git and nc.
describe("a resumed session gets this version's shims", () => {
  it("each shim is replaced whole, read-only, and a link in its place is never followed", () => {
    const binDir = realpathSync(mkdtempSync(path.join(root, "reshim-")))
    const realGit = spawnSync("which", ["git"]).stdout.toString().trim()
    writeGitPushShim({ binDir, git: realGit })
    const git = writeGitPushShim({ binDir, git: realGit, socket: "/tmp/broker.sock" })
    expect(readFileSync(git, "utf8")).toContain("/tmp/broker.sock")
    expect(statSync(git).mode & 0o777).toBe(0o555)
    writeGhShim({ binDir, socket: "/tmp/one.sock" })
    const gh = writeGhShim({ binDir, socket: "/tmp/two.sock", git: realGit }) as string
    expect(readFileSync(gh, "utf8")).toContain("/tmp/two.sock")

    const target = path.join(binDir, "target")
    writeFileSync(target, "owner's file")
    rmSync(path.join(binDir, "gh"), { force: true })
    symlinkSync(target, path.join(binDir, "gh"))
    writeGhShim({ binDir, socket: "/tmp/broker.sock" })
    expect(readFileSync(target, "utf8")).toBe("owner's file")
    expect(lstatSync(path.join(binDir, "gh")).isSymbolicLink()).toBe(false)
  })
})
