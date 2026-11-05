// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE UNATTENDED RUN PATH (P1-T36, S13, S14, L6-L9, L11, L18): the SDK
// options a node session runs with, its refusals before start, and how the
// run ends (done, token limit, abort, refused). The query is a stand-in here;
// unattended.realquery.test.ts runs the real one.
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { NODE_IMPORT_LIMITS } from "../../../packages/shared/src/node-import"
import { levelRow } from "../../../packages/shared/src/node-levels"
import {
  AUTO_CONTINUE_TEXT,
  commandLine,
  type NodeSessionCommand,
} from "../../../packages/shared/src/node-session-protocol"
import { B2_2_FORMS, FIXTURE_PW } from "../../../packages/shared/src/secret-redaction.fixtures"
import { generateTranscript } from "./__fixtures__/transcript-gen"
import { BROWSER_TEST_RIGHTS } from "./browser-test-card"
import { AsyncQueue } from "./index"
import {
  OWNER_SESSION_ENTRYPOINT,
  ranForServer,
  recordOwnerRun,
  sessionConfigDir,
} from "./session-config"
import { type DriverProbe, systemDriverProbe } from "./session-driver"
import { HOST_TOOL_LINES } from "./session-host-tools"
import {
  ATELIER_LINE,
  catchUpEvents,
  type JobSession,
  jobContextFor,
  levelLines,
  MERGE_REQUEST_LINE,
  type QueryFn,
  RESULT_LINES,
  type RunUnattendedArgs,
  readJobFile,
  resumeMessage,
  runUnattended,
  SESSION_BASELINE_FILE,
  SessionAsks,
  sanitizePermissionResult,
  sessionAppend,
  sessionBaseline,
  type UnattendedJob,
  UsageCounter,
} from "./unattended"
import { jobShellHome, PENDING_RUNNER_REFUSAL, UNTRUSTED_OPEN } from "./unattended-profile"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-unattended-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SESSION_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321"
const BUNDLED = "/opt/liaison/bundled/claude"

/** A session job in a fresh temp home (its node root, data dir and ~/.claude all inside). */
function sessionJob(
  session: Partial<JobSession> = {},
  overrides: Partial<UnattendedJob> = {},
): UnattendedJob {
  const home = realpathSync(mkdtempSync(path.join(root, "home-")))
  mkdirSync(path.join(home, ".claude"), { recursive: true })
  return {
    jobId: "11111111-2222-3333-4444-555555555555",
    server: "https://liaison.example",
    agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentName: "Personal",
    agentKind: "personal",
    model: "claude-haiku-4-5",
    profile: { level: "strict", liaisonTools: false },
    session: {
      id: SESSION_ID,
      source: "app",
      model: "claude-haiku-4-5",
      level: "strict",
      profileLevel: "strict",
      configKind: "owner",
      liaisonTools: false,
      ...session,
    },
    prompt: "List the files.",
    hardTokenLimit: null,
    nodeRoot: path.join(home, "Liaison Node"),
    home,
    agentDefinition: "You are a special agent with a charter.",
    ...overrides,
  }
}

interface Captured {
  prompt: string
  options: Options
  interrupted: number
  closed: number
}

/** A query that answers with the given messages, recording what it was started with. */
function fakeQuery(
  messages: unknown[],
  captured: Captured[],
  opts: { hold?: boolean; models?: unknown[] } = {},
): QueryFn {
  return ({ prompt, options }) => {
    const record: Captured = { prompt: "", options: options as Options, interrupted: 0, closed: 0 }
    captured.push(record)
    let stopped = false
    let release: (() => void) | undefined
    const iterator = (async function* () {
      for await (const m of prompt as AsyncIterable<{ message: { content: string } }>) {
        record.prompt = m.message.content
        break
      }
      for (const message of messages) {
        if (stopped) return
        // A function stands for something the session does mid-run (a tool
        // call reaching canUseTool, a git push): it runs, nothing is yielded.
        if (typeof message === "function") {
          await (message as (o: Options) => unknown)(options as Options)
          continue
        }
        yield message
      }
      if (opts.hold && !stopped) await new Promise<void>((resolve) => (release = resolve))
    })()
    return Object.assign(iterator, {
      interrupt: async () => {
        record.interrupted++
        stopped = true
        release?.()
      },
      close: () => {
        record.closed++
        stopped = true
        release?.()
      },
      ...(opts.models ? { supportedModels: async () => opts.models } : {}),
    }) as never
  }
}

/** The system prompt's append the first query was started with. */
function appendOf(captured: Captured[]): string {
  const prompt = captured[0]?.options.systemPrompt as { append?: string } | undefined
  return prompt?.append ?? ""
}

/** The run's arguments for a temp-home job: nothing of this computer's own is read. */
function runArgs(
  job: UnattendedJob,
  captured: Captured[],
  messages: unknown[] = [RESULT],
  extra: Partial<RunUnattendedArgs> & { hold?: boolean; models?: unknown[] } = {},
): RunUnattendedArgs {
  const { hold, models, ...rest } = extra
  const home = job.home as string
  // B8: the folder a session names is one this computer shares (the server
  // resolves it from the advertised folders); a test naming none shares it.
  const folder = job.session?.folderPath
  const shared =
    job.sharedFolders || !folder
      ? job
      : {
          ...job,
          sharedFolders: [
            {
              name: job.session?.folderName ?? path.basename(folder),
              path: folder,
              kind: "repo" as const,
            },
          ],
        }
  return {
    job: shared,
    emit: () => {},
    queryFn: fakeQuery(messages, captured, { hold, models }),
    platform: "darwin",
    cliPath: BUNDLED,
    sourceEnv: { PATH: "/usr/bin:/bin", HOME: home, USER: "owner" },
    dataDir: path.join(home, "data"),
    realConfigDir: path.join(home, ".claude"),
    npmPrefix: null,
    claudeBinary: { brewPrefixes: [], run: async () => null },
    readGhToken: () => null,
    gitCredential: () => null,
    ...rest,
  }
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
}

/** A git repository with one commit, as a shared folder of the owner's. */
function ownerRepo(parent: string, name = "my-repo"): string {
  const dir = path.join(parent, name)
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "README.md"), "# sample\n")
  git(dir, "add", "README.md")
  git(dir, "commit", "-q", "-m", "init")
  return dir
}

const RESULT = {
  type: "result",
  subtype: "success",
  result: "Listed the files.",
  permission_denials: [],
  usage: { input_tokens: 10, output_tokens: 5 },
}

function assistant(id: string, input: number, output: number, text = "working") {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id,
      content: [{ type: "text", text }],
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0 },
    },
  }
}

describe("S47 the session knows what its level allows (D12)", () => {
  const SETTINGS_KEYS = [
    "sandbox.",
    "allowLocalBinding",
    "settings.json",
    "allowMachLookup",
    "machLookups",
  ]
  const appendAt = (level: "strict" | "standard" | "open") => {
    const job = sessionJob({ level, profileLevel: level })
    return sessionAppend(job, job.session as JobSession, "Ada")
  }

  it("S47: the Standard append says local servers work, headless browsers and apps need Open; it never names a settings key", () => {
    const append = appendAt("standard")
    expect(append).toContain(
      "At this level you can run local dev servers and test-runner web servers; they listen on all network interfaces, not only localhost.",
    )
    // D55: a browser test asks the owner first, each run, through the runner alone.
    expect(append).toContain("so a browser test asks the owner first")
    expect(append).toContain(
      "npx playwright test, bunx playwright test, pnpm exec playwright test, yarn exec playwright test",
    )
    expect(append).toContain("the owner approves each run")
    expect(append).toContain("Scripts run through npm run or bun run stay sandboxed")
    expect(append).not.toContain("browser tests need the owner to switch this session to Open")
    expect(append).toContain(
      "Launching apps (the open command) and Apple events work only at Open.",
    )
    expect(append).toContain("Destructive git commands are refused at this level")
    expect(append).toContain("main, master, trunk, develop, production")
    expect(append).toContain("the repository's own git hooks do not run")
    expect(append).toContain("cannot be changed from settings files")
    expect(append).toContain("tell the owner which level it needs")
    for (const key of SETTINGS_KEYS) expect(append).not.toContain(key)
  })

  it("S47: the Strict append says localhost binding is off and offers the level that allows it", () => {
    const append = appendAt("strict")
    expect(append).toContain(
      "Local servers cannot listen on a port at this level, not even on localhost: a dev server or a test runner's web server fails to bind, and that needs the owner to switch this session to Standard or Open from Liaison.",
    )
    expect(append).toContain("browser tests need the owner to switch this session to Open")
    expect(append).not.toContain("you can run local dev servers")
    for (const key of SETTINGS_KEYS) expect(append).not.toContain(key)
  })

  it("S47: the Open append has no sandbox line and says everything runs", () => {
    const append = appendAt("open")
    expect(append).toContain(
      "At this level commands run outside the sandbox: local servers, headless browsers, launching apps and git all work.",
    )
    expect(append).not.toContain("cannot be changed from settings files")
    expect(append).not.toContain("refused at this level")
    for (const key of SETTINGS_KEYS) expect(append).not.toContain(key)
  })

  it("W1-D4: every level says the sandbox, permissions and Bash rules are Liaison's, never to propose editing them, and names the level change as the way out", () => {
    for (const level of ["strict", "standard"] as const) {
      const append = appendAt(level)
      expect(append).toContain("cannot be changed from settings files")
      expect(append).toContain(
        "the sandbox's file, network and local-binding rules, the permissions and the Bash tool's rules are fixed for this level",
      )
      expect(append).toContain(
        "Never propose or make such a change, not in this session and not as advice to the owner",
      )
      // The CLI's standalone-sleep block (walk W1: "allow standalone sleeps in
      // this session's Bash configuration").
      expect(append).toContain(
        "The Bash tool refuses a standalone sleep, and that rule is fixed too",
      )
      expect(append).toContain("until <check>; do sleep 2; done")
      expect(append).toContain("do not suggest a configuration change")
      expect(append).toContain("they raise this session's level from Liaison")
      for (const key of SETTINGS_KEYS) expect(append).not.toContain(key)
    }
    // Strict: local binding is named for what it is, with the level that allows it.
    expect(appendAt("strict")).toContain("not even on localhost")
    expect(appendAt("strict")).toContain("switch this session to Standard or Open from Liaison")
    const open = appendAt("open")
    expect(open).toContain("never propose editing settings files to change them")
    for (const key of SETTINGS_KEYS) expect(open).not.toContain(key)
  })

  it("S47: the lines follow the level row (a Standard row with local binding off changes the text)", () => {
    const real = levelLines(levelRow("standard"))
    const off = levelLines({ ...levelRow("standard"), allowLocalBinding: false })
    expect(off).not.toEqual(real)
    expect(off.join("\n")).toContain("Local servers cannot listen on a port at this level")
    expect(off.join("\n")).not.toContain("you can run local dev servers")
    const browsers = levelLines({ ...levelRow("standard"), machLookups: ["com.example.render"] })
    expect(browsers.join("\n")).toContain(
      "Headless browsers (Playwright, Chromium) can start at this level.",
    )
    expect(browsers.join("\n")).not.toContain("browser tests need")
  })
})

describe("P1-T36 the session's SDK options (S13, L6-L9, L11)", () => {
  it("the append is exactly the three lines for each source, plus the block and the limit only when present", async () => {
    for (const source of ["dispatch", "app", "routine", "agent_tag"] as const) {
      const captured: Captured[] = []
      const job = sessionJob({ source })
      await runUnattended(runArgs(job, captured))
      const append = appendOf(captured)
      const lines = append.split("\n")
      // S5: the two host-tool lines follow the three facts; A32: an owner
      // session has the bundled Atelier; S47: then the level's lines (no
      // repository here, so no push-hook line: S50.3).
      const level = levelLines(levelRow("strict"), { pushHook: false })
      expect(lines).toHaveLength(6 + level.length)
      expect(lines[0]).toMatch(/^This session runs on .+'s Liaison node, their own computer\.$/)
      expect(lines[1]).toMatch(/^.+ follows it live in the Sessions app of Liaison\.$/)
      expect(lines[2]).toBe(RESULT_LINES[source])
      expect(lines.slice(3, 5)).toEqual([...HOST_TOOL_LINES])
      expect(lines[5]).toBe(ATELIER_LINE)
      expect(lines.slice(6)).toEqual(level)
      expect(captured[0]?.options.systemPrompt).toMatchObject({
        type: "preset",
        preset: "claude_code",
      })
      // The prompt is the bare prompt, never wrapped.
      expect(captured[0]?.prompt).toBe("List the files.")
    }
    const captured: Captured[] = []
    const job = sessionJob(
      { source: "routine" },
      { trigger: { event: "the sum is off by one" }, hardTokenLimit: 50_000 },
    )
    await runUnattended(runArgs(job, captured))
    const append = appendOf(captured)
    expect(append.split("\n").slice(0, 3)).toEqual([
      expect.stringContaining("Liaison node"),
      expect.stringContaining("Sessions app"),
      RESULT_LINES.routine,
    ])
    expect(append).toContain(UNTRUSTED_OPEN)
    expect(append).toContain("the sum is off by one")
    expect(append.split("\n").at(-1)).toBe("This session stops at 50000 tokens.")
    expect(captured[0]?.prompt).toBe("List the files.")
    expect(captured[0]?.prompt).not.toContain(UNTRUSTED_OPEN)
  })

  it("owner runs load user, project and local; isolated runs only local, with an empty config (D51)", async () => {
    const owner = sessionJob({ configKind: "owner" })
    const home = owner.home as string
    mkdirSync(path.join(home, ".claude", "skills", "my-skill"), { recursive: true })
    const ownerCaptured: Captured[] = []
    await runUnattended(runArgs(owner, ownerCaptured))
    const o = ownerCaptured[0]?.options as Options
    expect(o.settingSources).toEqual(["user", "project", "local"])
    const ownerDir = sessionConfigDir(SESSION_ID, path.join(home, "data"))
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe(ownerDir)
    expect(o.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("")
    expect(existsSync(path.join(ownerDir, "skills", "my-skill"))).toBe(true)

    const isolated = sessionJob({ configKind: "isolated" })
    const ihome = isolated.home as string
    mkdirSync(path.join(ihome, ".claude", "skills", "my-skill"), { recursive: true })
    const isoCaptured: Captured[] = []
    await runUnattended(runArgs(isolated, isoCaptured))
    const i = isoCaptured[0]?.options as Options
    // D51: no project walk-up (an ancestor CLAUDE.md loads even in a git repo).
    expect(i.settingSources).toEqual(["local"])
    const isoDir = sessionConfigDir(SESSION_ID, path.join(ihome, "data"))
    expect(i.env?.CLAUDE_CONFIG_DIR).toBe(isoDir)
    expect(existsSync(path.join(isoDir, "skills"))).toBe(false)
    expect(existsSync(path.join(isoDir, "settings.json"))).toBe(false)
  })

  // P1b-fix F6: the repo's tracked settings.local.json is left as it is and
  // never loaded: the local source is off for that checkout, owner or isolated.
  it("a checkout that tracks .claude/settings.local.json runs without the local source (F6)", async () => {
    for (const configKind of ["owner", "isolated"] as const) {
      const job = sessionJob({ configKind })
      const home = job.home as string
      const repo = ownerRepo(path.join(home, "code"), `tracked-local-${configKind}`)
      mkdirSync(path.join(repo, ".claude"), { recursive: true })
      const committed = '{"permissions":{"allow":["Bash(*)"]}}'
      writeFileSync(path.join(repo, ".claude", "settings.local.json"), committed)
      git(repo, "add", "-A")
      git(repo, "commit", "-q", "-m", "local settings")
      job.session = {
        ...(job.session as JobSession),
        folderPath: repo,
        folderName: path.basename(repo),
      }
      const captured: Captured[] = []
      const outcome = await runUnattended(runArgs(job, captured, [INIT, RESULT]))
      expect(outcome.status).toBe("done")
      const o = captured[0]?.options as Options
      expect({ configKind, sources: o.settingSources }).toEqual({
        configKind,
        sources: configKind === "owner" ? ["user", "project"] : [],
      })
      const cwd = o.cwd as string
      expect(readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8")).toBe(committed)
    }
  })

  it("permissionMode default, only the bundled Atelier plugin, no disallowed tools, no agent definition", async () => {
    const captured: Captured[] = []
    const job = sessionJob()
    await runUnattended(runArgs(job, captured))
    const o = captured[0]?.options as Options & Record<string, unknown>
    expect(o.permissionMode).toBe("default")
    expect(o.allowDangerouslySkipPermissions).toBe(false)
    // S38: an owner session's one plugin is the bundled Atelier.
    expect(o.plugins).toEqual([
      { type: "local", path: path.join(job.home as string, "data", "atelier", "v0.4.0") },
    ])
    expect(o.disallowedTools).toBeUndefined()
    expect(o.agents).toBeUndefined()
    expect(o.agent).toBeUndefined()
    const append = (o.systemPrompt as { append?: string }).append ?? ""
    expect(append).not.toContain("special agent")
    expect(append).not.toContain("UNATTENDED")
    expect(typeof o.canUseTool).toBe("function")
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1)
    expect(o.model).toBe("claude-haiku-4-5")
  })

  it("an isolated session in a repo gets the repo's tracked CLAUDE.md fenced in the append and its .claude content as a local plugin (D52)", async () => {
    const job = sessionJob(
      { source: "agent_tag", configKind: "isolated" },
      { trigger: { message: "please fix the sum" } },
    )
    const home = job.home as string
    const repo = ownerRepo(path.join(home, "code"))
    mkdirSync(path.join(repo, ".claude", "skills", "repo-skill"), { recursive: true })
    writeFileSync(path.join(repo, "CLAUDE.md"), "Codeword: REPOWORD\n")
    writeFileSync(
      path.join(repo, ".claude", "skills", "repo-skill", "SKILL.md"),
      "---\nname: repo-skill\ndescription: d\n---\nREPO-SKILL\n",
    )
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "claude content")
    // Not tracked: never passed.
    writeFileSync(path.join(repo, "CLAUDE.local.md"), "UNTRACKED-LOCAL\n")
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const captured: Captured[] = []
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(job, captured, [INIT, RESULT]),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    const o = captured[0]?.options as Options
    const ctx = jobContextFor(job, "darwin")
    const pluginDir = path.join(ctx.sessionDir as string, "repo-plugin")
    expect(o.settingSources).toEqual(["local"])
    expect(o.plugins).toEqual([{ type: "local", path: pluginDir, skipMcpDiscovery: true }])
    expect(existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true)
    expect(existsSync(path.join(pluginDir, "skills", "repo-skill", "SKILL.md"))).toBe(true)
    const append = appendOf(captured)
    const lines3 = append.split("\n").slice(0, 3)
    expect(lines3[2]).toBe(RESULT_LINES.agent_tag)
    const fence = append.indexOf("<repository-memory ")
    expect(fence).toBeGreaterThan(0)
    expect(append).toContain("Codeword: REPOWORD")
    expect(append).toContain("</repository-memory>")
    expect(append).not.toContain("UNTRACKED-LOCAL")
    // The untrusted block stays whole, after the repo's block.
    expect(append.indexOf(UNTRUSTED_OPEN)).toBeGreaterThan(append.indexOf("</repository-memory>"))
    expect(append).toContain("please fix the sum")
    const start = eventsOf(lines).find((e) => e.type === "system")
    expect((start?.payload.data as Record<string, unknown> | undefined)?.repoContent).toMatchObject(
      {
        memory: ["CLAUDE.md"],
        pluginFiles: [".claude/skills/repo-skill/SKILL.md"],
      },
    )
  })

  it("an owner session in a repo, or an isolated one outside a repo, gets no repo plugin or block (D52)", async () => {
    const owner = sessionJob({ source: "dispatch", configKind: "owner" })
    const repo = ownerRepo(path.join(owner.home as string, "code"))
    writeFileSync(path.join(repo, "CLAUDE.md"), "Codeword: REPOWORD\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "memory")
    owner.session = { ...(owner.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const ownerCaptured: Captured[] = []
    await runUnattended(runArgs(owner, ownerCaptured))
    // S38: the bundled Atelier only, no repo plugin.
    expect(ownerCaptured[0]?.options.plugins).toEqual([
      { type: "local", path: path.join(owner.home as string, "data", "atelier", "v0.4.0") },
    ])
    expect(appendOf(ownerCaptured)).not.toContain("repository-memory")

    const isolated = sessionJob({ source: "agent_tag", configKind: "isolated" })
    const isoCaptured: Captured[] = []
    await runUnattended(runArgs(isolated, isoCaptured))
    expect(isoCaptured[0]?.options.plugins).toBeUndefined()
    expect(appendOf(isoCaptured).split("\n")).toHaveLength(
      5 + levelLines(levelRow("strict"), { pushHook: false }).length,
    )
  })

  describe("the bundled Atelier (S38, A14, A32, D4)", () => {
    const startData = (lines: Array<Record<string, unknown>>) =>
      eventsOf(lines).find((e) => e.type === "system" && e.payload.subtype === "start")?.payload
        .data as Record<string, unknown>

    it("S38: an owner session without a user Atelier gets the bundled plugin appended and atelierSource bundled", async () => {
      const job = sessionJob({ source: "dispatch", configKind: "owner" })
      const home = job.home as string
      const captured: Captured[] = []
      const lines: Array<Record<string, unknown>> = []
      const outcome = await runUnattended({
        ...runArgs(job, captured, [INIT, RESULT]),
        emit: (l) => lines.push(l),
        atelierHooks: () => "ok",
      })
      expect(outcome.status).toBe("done")
      const o = captured[0]?.options as Options
      const bundled = path.join(home, "data", "atelier", "v0.4.0")
      expect(o.plugins).toEqual([{ type: "local", path: bundled }])
      expect(readFileSync(path.join(bundled, "commands", "atelier.md"), "utf8")).toContain(
        "Atelier",
      )
      // Strict reads only listed folders: the bundled plugin is one of them.
      expect(o.sandbox?.filesystem?.allowRead).toContain(bundled)
      expect(appendOf(captured)).toContain("/atelier:atelier <task>")
      const data = startData(lines)
      expect(data.atelierSource).toBe("bundled")
      // The hooks' check is only said at Open, where hooks run (GF-21).
      expect(data.atelierHooks).toBeUndefined()
    })

    it("S38: an owner session whose settings enable atelier@atelier gets none added and atelierSource user", async () => {
      for (const level of ["strict", "open"] as const) {
        const job = sessionJob({
          source: "dispatch",
          configKind: "owner",
          level,
          profileLevel: level,
        })
        const home = job.home as string
        writeFileSync(
          path.join(home, ".claude", "settings.json"),
          JSON.stringify({ enabledPlugins: { "atelier@atelier": true } }),
        )
        const captured: Captured[] = []
        const lines: Array<Record<string, unknown>> = []
        await runUnattended({
          ...runArgs(job, captured, [INIT, RESULT]),
          emit: (l) => lines.push(l),
          atelierHooks: () => "bash<4",
        })
        const o = captured[0]?.options as Options
        expect({ level, plugins: o.plugins }).toEqual({ level, plugins: undefined })
        expect(existsSync(path.join(home, "data", "atelier"))).toBe(false)
        // A32: the owner's Atelier is loaded, so the instruction stands.
        expect(appendOf(captured)).toContain("/atelier:atelier <task>")
        const data = startData(lines)
        expect({ level, source: data.atelierSource, hooks: data.atelierHooks }).toEqual({
          level,
          source: "user",
          hooks: level === "open" ? "bash<4" : undefined,
        })
      }
    })

    it("D41: an owner session whose settings switch atelier@atelier off gets no Atelier at all", async () => {
      const job = sessionJob({ source: "dispatch", configKind: "owner" })
      const home = job.home as string
      writeFileSync(
        path.join(home, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "atelier@atelier": false } }),
      )
      const captured: Captured[] = []
      const lines: Array<Record<string, unknown>> = []
      await runUnattended({
        ...runArgs(job, captured, [INIT, RESULT]),
        emit: (l) => lines.push(l),
        atelierHooks: () => "ok",
      })
      expect(captured[0]?.options.plugins).toBeUndefined()
      expect(existsSync(path.join(home, "data", "atelier"))).toBe(false)
      expect(appendOf(captured)).not.toContain("/atelier:atelier")
      expect(startData(lines).atelierSource).toBe("none")
    })

    it("S38: an isolated (agent_tag) session never gets it and keeps its repo-content plugin", async () => {
      const job = sessionJob(
        { source: "agent_tag", configKind: "isolated" },
        { trigger: { message: "please fix the sum" } },
      )
      const home = job.home as string
      const repo = ownerRepo(path.join(home, "code"))
      mkdirSync(path.join(repo, ".claude", "skills", "repo-skill"), { recursive: true })
      writeFileSync(
        path.join(repo, ".claude", "skills", "repo-skill", "SKILL.md"),
        "---\nname: repo-skill\ndescription: d\n---\nREPO-SKILL\n",
      )
      git(repo, "add", "-A")
      git(repo, "commit", "-q", "-m", "claude content")
      job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
      const captured: Captured[] = []
      const lines: Array<Record<string, unknown>> = []
      await runUnattended({
        ...runArgs(job, captured, [INIT, RESULT]),
        emit: (l) => lines.push(l),
        atelierHooks: () => "ok",
      })
      const o = captured[0]?.options as Options
      const pluginDir = path.join(jobContextFor(job, "darwin").sessionDir as string, "repo-plugin")
      expect(o.plugins).toEqual([{ type: "local", path: pluginDir, skipMcpDiscovery: true }])
      expect(existsSync(path.join(home, "data", "atelier"))).toBe(false)
      expect(appendOf(captured)).not.toContain("/atelier:atelier")
      expect(startData(lines).atelierSource).toBe("none")
    })

    it("S38: an owner session at Open with the bundled Atelier says whether its hooks can run", async () => {
      const job = sessionJob({ configKind: "owner", level: "open", profileLevel: "open" })
      const lines: Array<Record<string, unknown>> = []
      const seen: string[] = []
      await runUnattended({
        ...runArgs(job, [], [INIT, RESULT]),
        emit: (l) => lines.push(l),
        atelierHooks: (p) => {
          seen.push(p)
          return "no jq"
        },
      })
      const data = startData(lines)
      expect({ source: data.atelierSource, hooks: data.atelierHooks }).toEqual({
        source: "bundled",
        hooks: "no jq",
      })
      expect(seen.length).toBe(1)
    })
  })

  it("a model the SDK does not offer ends model_unavailable with no query run", async () => {
    const captured: Captured[] = []
    const emitted: Array<Record<string, unknown>> = []
    const job = sessionJob({ model: "claude-opus-9" }, { model: "claude-opus-9" })
    const outcome = await runUnattended({
      ...runArgs(job, captured, [assistant("m1", 1, 1), RESULT], {
        models: [
          { value: "default", displayName: "Default", description: "" },
          { value: "opus", displayName: "Opus", description: "", resolvedModel: "claude-opus-5-5" },
          { value: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "" },
        ],
      }),
      emit: (e) => emitted.push(e),
    })
    expect(outcome.status).toBe("refused")
    expect(outcome.code).toBe("model_unavailable")
    expect(outcome.error).toContain("claude-opus-9")
    expect(outcome.error).toContain("claude-opus-5-5")
    // The prompt was never yielded: no turn ran.
    expect(captured[0]?.prompt).toBe("")
    expect(captured[0]?.closed).toBeGreaterThan(0)
    expect(emitted.at(-1)).toMatchObject({ type: "job_done", code: "model_unavailable" })

    // A dated snapshot of the named model is the named model.
    const ok: Captured[] = []
    const haiku = await runUnattended(
      runArgs(sessionJob(), ok, [RESULT], {
        models: [{ value: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "" }],
      }),
    )
    expect(haiku.status).toBe("done")
    expect(ok[0]?.prompt).toBe("List the files.")
  })

  // Review of #63: the node offers each family's current model only, but a
  // session that names an older version its SDK still runs (queued before,
  // a retry, a routine) starts as named. The refusal lists current models.
  it("an older version the SDK still runs starts as named; a refusal lists only current models", async () => {
    const sdk = [
      {
        value: "default",
        displayName: "Default",
        description: "",
        resolvedModel: "claude-sonnet-5-5",
      },
      { value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5" },
      {
        value: "haiku",
        displayName: "Haiku 5.5",
        description: "",
        resolvedModel: "claude-haiku-5-5",
      },
      {
        value: "claude-opus-4-7",
        displayName: "Opus 4.7",
        description: "",
        resolvedModel: "claude-opus-4-7",
      },
      {
        value: "claude-opus-4-6",
        displayName: "Opus 4.6",
        description: "",
        resolvedModel: "claude-opus-4-6",
      },
    ]
    const ok: Captured[] = []
    const legacy = sessionJob({ model: "claude-opus-4-6" }, { model: "claude-opus-4-6" })
    const ran = await runUnattended(runArgs(legacy, ok, [RESULT], { models: sdk }))
    expect(ran.status).toBe("done")
    expect(ok[0]?.prompt).toBe("List the files.")

    const refused = await runUnattended(
      runArgs(sessionJob({ model: "claude-opus-9" }, { model: "claude-opus-9" }), [], [RESULT], {
        models: sdk,
      }),
    )
    expect(refused.code).toBe("model_unavailable")
    expect(refused.error).toContain("offered: claude-opus-5-5, claude-haiku-5-5)")
  })

  it("a newer fake claude planted at a launcher that resolves into a shared folder is not run: pathToClaudeCodeExecutable is the bundled path", async () => {
    const job = sessionJob({ source: "dispatch" })
    const home = job.home as string
    const shared = path.join(home, "code", "shared")
    const pkg = path.join(shared, "lib", "node_modules", "@anthropic-ai", "claude-code")
    mkdirSync(path.join(pkg, "bin"), { recursive: true })
    writeFileSync(path.join(pkg, "package.json"), '{"name":"@anthropic-ai/claude-code"}')
    const planted = path.join(pkg, "bin", "claude")
    writeFileSync(planted, "#!/bin/sh\necho '99.0.0 (Claude Code)'\n")
    chmodSync(planted, 0o755)
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true })
    symlinkSync(planted, path.join(home, ".local", "bin", "claude"))
    job.session = { ...(job.session as JobSession), folderPath: shared, folderName: "shared" }
    const probed: string[] = []
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [RESULT], {
        claudeBinary: {
          brewPrefixes: [],
          bundledVersion: "2.1.0",
          run: async (file) => {
            probed.push(file)
            return "99.0.0 (Claude Code)"
          },
        },
      }),
    )
    expect(outcome.status).toBe("done")
    expect(captured[0]?.options.pathToClaudeCodeExecutable).toBe(BUNDLED)
    expect(probed).not.toContain(realpathSync(planted))
  })

  it("final walk F1: the start event names the session's branch, so the header shows it while it runs", async () => {
    const job = sessionJob({ source: "dispatch", level: "standard", profileLevel: "standard" })
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const captured: Captured[] = []
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(job, captured),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    const start = eventsOf(lines).find((e) => e.type === "system" && e.payload.subtype === "start")
    const branch = (start?.payload.data as { branch?: string } | undefined)?.branch
    // S50.3 (owner D13): in place, the folder's checked-out branch; on main
    // below Open with a finish step, the one the node made for it (D40).
    expect(branch).toBe("liaison/9f8e7d6c-my-repo")
  })

  it("batch-4 F5: the start event names the cwd below the session's shared folder, matched by real path", async () => {
    const job = sessionJob({ source: "dispatch" })
    const code = path.join(job.home as string, "code")
    const sub = path.join(code, "tools", "code")
    mkdirSync(sub, { recursive: true })
    job.sharedFolders = [{ name: "code", path: code, kind: "root" }]
    job.session = { ...(job.session as JobSession), folderPath: sub, folderName: "code" }
    const captured: Captured[] = []
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(job, captured),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    const start = eventsOf(lines).find((e) => e.type === "system" && e.payload.subtype === "start")
    expect((start?.payload.data as { folderRelPath?: string } | undefined)?.folderRelPath).toBe(
      "tools/code",
    )
  })

  it("final walk F2: a repo session runs git through the push shim first on its PATH", async () => {
    const job = sessionJob({ source: "dispatch", level: "standard", profileLevel: "standard" })
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const captured: Captured[] = []
    const outcome = await runUnattended(runArgs(job, captured))
    expect(outcome.status).toBe("done")
    const o = captured[0]?.options as Options
    const env = o.env as Record<string, string>
    const first = env.PATH.split(":")[0] as string
    const shim = path.join(first, "git")
    expect(readFileSync(shim, "utf8")).toContain("-u|--set-upstream")
  })

  it("the flag settings carry the guard env, in both pinned layers (K8)", async () => {
    // An isolated run (S48: owner runs are in place, isolated ones keep a worktree).
    const job = sessionJob({
      source: "agent_tag",
      configKind: "isolated",
      level: "standard",
      profileLevel: "standard",
    })
    const home = job.home as string
    const repo = ownerRepo(path.join(home, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const captured: Captured[] = []
    const outcome = await runUnattended(runArgs(job, captured))
    expect(outcome.status).toBe("done")
    const o = captured[0]?.options as Options
    const ctx = jobContextFor(job, "darwin")
    // A worktree under the node root, never the owner's folder.
    expect(o.cwd).toBe(ctx.worktreeDir)
    for (const layer of [o.settings, o.managedSettings] as Array<Record<string, unknown>>) {
      expect(layer.disableAllHooks).toBe(true)
      expect(layer.disableSkillShellExecution).toBe(true)
      expect(layer.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true })
      const env = layer.env as Record<string, string>
      const keys = Object.keys(env).filter((k) => /^GIT_CONFIG_KEY_\d+$/.test(k))
      const hooksKey = keys.find((k) => env[k] === "core.hooksPath") as string
      expect(hooksKey).toBeDefined()
      expect(env[hooksKey.replace("KEY", "VALUE")]).toBe(ctx.hooksDir as string)
      expect(env.HOME).toBe(o.env?.HOME as string)
    }
    expect(o.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false })
  })

  it("no Liaison access or refresh token from the node's environment reaches the session (S8)", async () => {
    const captured: Captured[] = []
    const job = sessionJob()
    await runUnattended(
      runArgs(job, captured, [RESULT], {
        sourceEnv: {
          PATH: "/usr/bin:/bin",
          HOME: job.home,
          LIAISON_ACCESS_TOKEN: "lia_access_secret",
          LIAISON_REFRESH_TOKEN: "lia_refresh_secret",
          ANTHROPIC_API_KEY: "sk-ant-secret",
        },
      }),
    )
    // The in-process host server's live instance (S5) is the sidecar's own
    // object, never sent to the CLI: everything else is serialised.
    const blob = JSON.stringify(captured[0]?.options, (key, value) =>
      key === "instance" ? undefined : value,
    )
    expect(blob).toContain('"liaison_session":{"type":"sdk","name":"liaison_session"}')
    expect(blob).not.toContain("lia_access_secret")
    expect(blob).not.toContain("lia_refresh_secret")
    expect(blob).not.toContain("sk-ant-secret")
  })
})

describe("P1-T36 refusals before the session starts (R9)", () => {
  it("strict or standard where no sandbox exists: sandbox_unavailable, no query", async () => {
    for (const level of ["strict", "standard"] as const) {
      const captured: Captured[] = []
      const outcome = await runUnattended(
        runArgs(sessionJob({ level, profileLevel: level }), captured, [RESULT], {
          platform: "win32",
        }),
      )
      expect(outcome).toMatchObject({ status: "refused", code: "sandbox_unavailable" })
      expect(captured).toHaveLength(0)
    }
  })

  it("Liaison tools on and no connection: auth_required, no query", async () => {
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(sessionJob({ liaisonTools: true }), captured, [RESULT]),
    )
    expect(outcome).toMatchObject({ status: "refused", code: "auth_required" })
    expect(captured).toHaveLength(0)
  })

  it("a shared folder that is gone: folder_missing, no query", async () => {
    const captured: Captured[] = []
    const job = sessionJob({
      source: "dispatch",
      folderPath: path.join(root, "nowhere", "gone"),
      folderName: "gone",
    })
    const outcome = await runUnattended(runArgs(job, captured, [RESULT]))
    expect(outcome).toMatchObject({ status: "error", code: "folder_missing" })
    expect(captured).toHaveLength(0)
  })
})

describe("runUnattended", () => {
  it("stops the run at the hard token limit and keeps the partial text (A34)", async () => {
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(sessionJob({}, { hardTokenLimit: 1000 }), captured, [
        assistant("m1", 400, 100, "half done"),
        assistant("m2", 600, 100, "more"),
        RESULT,
      ]),
    )
    expect(outcome.status).toBe("token_limit")
    expect(outcome.usage.totalTokens).toBe(1200)
    expect(outcome.text).toContain("more")
    expect(outcome.text).toContain("1000")
    expect(captured[0]?.interrupted).toBe(1)
  })

  it("rejects a mode switch while the job runs, and stops on abort", async () => {
    const captured: Captured[] = []
    const emitted: Array<Record<string, unknown>> = []
    const control = new AsyncQueue<string>()
    const running = runUnattended({
      ...runArgs(sessionJob(), captured, [assistant("m1", 1, 1)], { hold: true }),
      emit: (e) => emitted.push(e),
      control,
    })
    await Bun.sleep(50)
    control.push(JSON.stringify({ type: "set_permission_mode", mode: "bypass" }))
    await Bun.sleep(20)
    expect(emitted).toContainEqual({
      type: "permission_mode_refused",
      mode: "bypass",
      reason: "UnattendedJob",
    })
    control.push(JSON.stringify({ type: "abort", reason: "stale_lease" }))
    const outcome = await running
    expect(outcome.status).toBe("aborted")
    expect(captured[0]?.closed).toBeGreaterThan(0)
  })
})

describe("UsageCounter (A34)", () => {
  it("counts input (cached included) plus output once per API message", () => {
    const c = new UsageCounter(null)
    c.add({
      type: "assistant",
      message: {
        id: "a",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
          output_tokens: 7,
        },
      },
    })
    // The same API message streamed as a second content block.
    c.add({
      type: "assistant",
      message: {
        id: "a",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
          output_tokens: 9,
        },
      },
    })
    expect(c.snapshot()).toEqual({
      inputTokens: 115,
      cachedInputTokens: 105,
      outputTokens: 9,
      totalTokens: 124,
    })
  })

  it("walk D19: the result's modelUsage (the CLI's real totals) wins over the streamed start counts, per process", () => {
    const c = new UsageCounter(null)
    c.add({ type: "system", subtype: "init" })
    c.add({
      type: "assistant",
      message: { id: "a", usage: { input_tokens: 10, output_tokens: 3 } },
    })
    const result = (out: number) => ({
      type: "result",
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 18,
          outputTokens: out,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
        },
      },
    })
    c.add(result(469))
    expect(c.snapshot()).toEqual({
      inputTokens: 118,
      cachedInputTokens: 100,
      outputTokens: 469,
      totalTokens: 587,
    })
    // A restarted process: its results add to the ended one's.
    c.add({ type: "system", subtype: "init" })
    c.add(result(31))
    expect(c.snapshot().outputTokens).toBe(500)
  })
})

describe("readJobFile", () => {
  it("refuses a job file without a profile or a prompt", () => {
    const file = path.join(root, "job.json")
    writeFileSync(file, JSON.stringify({ jobId: "x" }))
    expect(() => readJobFile(file)).toThrow()
  })
})

describe("P1-T28: the session job file and its folders (L5, L22, R7)", () => {
  const SESSION_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321"
  function sessionJobFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      jobId: "11111111-2222-3333-4444-555555555555",
      server: "https://liaison.example",
      agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      agentName: "Personal",
      model: "claude-haiku-4-5",
      profile: { level: "standard", liaisonTools: true },
      session: {
        id: SESSION_ID,
        source: "dispatch",
        folderPath: "/Users/owner/code/my-repo",
        folderName: "my-repo",
        model: "claude-haiku-4-5",
        level: "standard",
        profileLevel: "standard",
        configKind: "owner",
        liaisonTools: true,
      },
      prompt: "Fix the flaky test.",
      hardTokenLimit: null,
      nodeRoot: "/Users/owner/Liaison Node",
      kind: "unattended",
      ...overrides,
    }
  }
  function write(body: Record<string, unknown>): string {
    const file = path.join(root, `session-job-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(body))
    return file
  }

  it("a session job file parses with its session and its level profile", () => {
    const read = readJobFile(write(sessionJobFile()))
    expect(read.profile).toEqual({ level: "standard", liaisonTools: true })
    expect(read.session).toEqual({
      id: SESSION_ID,
      source: "dispatch",
      folderPath: "/Users/owner/code/my-repo",
      folderName: "my-repo",
      model: "claude-haiku-4-5",
      level: "standard",
      profileLevel: "standard",
      configKind: "owner",
      liaisonTools: true,
      autonomy: "guided",
      finishWith: null,
    })
  })

  it("S30: sessionOf reads autonomy and defaults to guided", () => {
    const named = sessionJobFile()
    Object.assign(named.session as Record<string, unknown>, {
      autonomy: "autonomous",
      finishWith: "commit",
    })
    expect(readJobFile(write(named)).session).toMatchObject({
      autonomy: "autonomous",
      finishWith: "commit",
    })
    // An older shell names neither: guided, no finish step chosen.
    expect(readJobFile(write(sessionJobFile())).session).toMatchObject({
      autonomy: "guided",
      finishWith: null,
    })
    // An unknown value is read as the default, never as autonomous.
    const unknown = sessionJobFile()
    Object.assign(unknown.session as Record<string, unknown>, {
      autonomy: "yolo",
      finishWith: "merge",
    })
    expect(readJobFile(write(unknown)).session).toMatchObject({
      autonomy: "guided",
      finishWith: null,
    })
  })

  it("W2-D5: sessionOf reads the folder's holder as plain text; a blank or non-string one is absent", () => {
    const named = sessionJobFile()
    Object.assign(named.session as Record<string, unknown>, {
      folderHeldBy: '"Fix cart\u0007total" (ac492ea4, waiting on you)',
    })
    expect(readJobFile(write(named)).session?.folderHeldBy).toBe(
      '"Fix cart total" (ac492ea4, waiting on you)',
    )
    for (const bad of ["  ", 7, null]) {
      const file = sessionJobFile()
      Object.assign(file.session as Record<string, unknown>, { folderHeldBy: bad })
      expect(readJobFile(write(file)).session?.folderHeldBy).toBeUndefined()
    }
  })

  it("S57 (D43 F10): sessionOf reads the claiming server's protocol; anything but a positive integer is dropped", () => {
    const named = sessionJobFile()
    Object.assign(named.session as Record<string, unknown>, { serverProtocol: 3 })
    expect(readJobFile(write(named)).session?.serverProtocol).toBe(3)
    for (const bad of [0, -1, 2.5, "4", null]) {
      const odd = sessionJobFile()
      Object.assign(odd.session as Record<string, unknown>, { serverProtocol: bad })
      expect(readJobFile(write(odd)).session?.serverProtocol).toBeUndefined()
    }
  })

  it("S33: a run resumed for an autonomy switch keeps its SDK session and says why", () => {
    const resumed = sessionJobFile()
    ;(resumed.session as Record<string, unknown>).resume = {
      sdkSessionId: "sdk-1",
      after: "autonomy",
    }
    expect(readJobFile(write(resumed)).session?.resume).toEqual({
      sdkSessionId: "sdk-1",
      after: "autonomy",
    })
    expect(resumeMessage("autonomy")).toBe(
      "The session was interrupted (its autonomy changed). Continue where you left off.",
    )
  })

  it("an unattended job without a session, or with a template profile, is refused", () => {
    expect(() => readJobFile(write(sessionJobFile({ session: undefined })))).toThrow(/session/)
    expect(() =>
      readJobFile(write(sessionJobFile({ profile: { template: "custom", config: {} } }))),
    ).toThrow(/profile/)
    expect(() =>
      readJobFile(
        write(
          sessionJobFile({ profile: { level: "standard", liaisonTools: true, template: "x" } }),
        ),
      ),
    ).toThrow(/profile/)
    const bad = sessionJobFile()
    ;(bad.session as Record<string, unknown>).level = "bypass"
    expect(() => readJobFile(write(bad))).toThrow(/session/)
    const relative = sessionJobFile()
    ;(relative.session as Record<string, unknown>).folderPath = "code/my-repo"
    expect(() => readJobFile(write(relative))).toThrow(/session/)
  })

  it("the job file never carries an access token (K25)", () => {
    expect(() => readJobFile(write(sessionJobFile({ accessToken: "lia_user_token" })))).toThrow(
      /access token/,
    )
    expect(() => readJobFile(write(sessionJobFile({ access_token: "lia_user_token" })))).toThrow(
      /access token/,
    )
    const nested = sessionJobFile()
    ;(nested.session as Record<string, unknown>).accessToken = "lia_user_token"
    expect(() => readJobFile(write(nested))).toThrow(/access token/)
  })

  it("an interactive job file still parses unchanged (CAV2)", () => {
    const today = {
      jobId: "11111111-2222-3333-4444-555555555555",
      server: "https://liaison.example",
      agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      agentName: "Personal",
      model: "claude-haiku-4-5",
      profile: { template: "default", config: {} },
      prompt: "hello",
      nodeRoot: "/Users/owner/Liaison Node",
      kind: "interactive",
      permissionMode: "manual",
      resumeSessionId: "sess-previous",
    }
    const read = readJobFile(write(today))
    expect(read.kind).toBe("interactive")
    expect(read.profile).toEqual({ template: "default", config: {} })
    expect(read.session).toBeUndefined()
    // The shell's next job document (T37) writes the level profile for both kinds.
    const next = readJobFile(write({ ...today, profile: { level: "strict", liaisonTools: true } }))
    expect(next.profile).toEqual({ level: "strict", liaisonTools: true })
  })

  it("folders are keyed by the session id, not the job id", () => {
    const one = readJobFile(write(sessionJobFile()))
    const two = readJobFile(
      write(sessionJobFile({ jobId: "22222222-3333-4444-5555-666666666666" })),
    )
    const a = jobContextFor(one, "darwin")
    const b = jobContextFor(two, "darwin")
    const short = "9f8e7d6c5b4a"
    expect(a.sessionDir).toBe(path.join("/Users/owner/Liaison Node", ".sessions", short))
    expect(a.hooksDir).toBe(path.join("/Users/owner/Liaison Node", ".sessions", short, "hooks"))
    expect(a.worktreeDir).toBe(
      path.join("/Users/owner/Liaison Node", "worktrees", `my-repo-${short}`),
    )
    expect(a.cloneDir).toBeUndefined()
    expect(b.sessionDir).toBe(a.sessionDir)
    expect(b.worktreeDir).toBe(a.worktreeDir)
    expect(JSON.stringify(a)).not.toContain("11111111")
    // A repo session clones under the agent folder, keyed by the session too.
    const repoJob = readJobFile(
      write(
        sessionJobFile({
          session: {
            ...(sessionJobFile().session as Record<string, unknown>),
            folderPath: undefined,
            folderName: undefined,
            repo: "git@gitlab.com:example/sample-repo.git",
          },
        }),
      ),
    )
    const r = jobContextFor(repoJob, "darwin")
    expect(r.cloneDir).toBe(
      path.join("/Users/owner/Liaison Node", "personal-aaaaaaaa", "sessions", short, "sample-repo"),
    )
    expect(r.worktreeDir).toBeUndefined()
  })

  it("an app session without a folder works in sessions/<id>; other sources in the agent folder", () => {
    const appJob = readJobFile(
      write(
        sessionJobFile({
          session: {
            ...(sessionJobFile().session as Record<string, unknown>),
            source: "app",
            folderPath: undefined,
            folderName: undefined,
          },
        }),
      ),
    )
    const app = jobContextFor(appJob, "darwin")
    expect(app.cwd).toBe(path.join("/Users/owner/Liaison Node", "sessions", SESSION_ID))
    const routineJob = readJobFile(
      write(
        sessionJobFile({
          session: {
            ...(sessionJobFile().session as Record<string, unknown>),
            source: "routine",
            folderPath: undefined,
            folderName: undefined,
          },
        }),
      ),
    )
    expect(jobContextFor(routineJob, "darwin").cwd).toBe(
      path.join("/Users/owner/Liaison Node", "personal-aaaaaaaa"),
    )
  })
})

// ── P1-T44: the events, the waiting, the result (S5, S14 base, S15, D39, K17) ──

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "sdk-session-1",
  model: "claude-haiku-4-5-20251001",
}

/** The session_events lines the run wrote, flattened, and every line in order. */
function eventsOf(lines: Array<Record<string, unknown>>) {
  const events = lines
    .filter((l) => l.type === "session_events")
    .flatMap((l) => l.events as Array<{ type: string; payload: Record<string, unknown> }>)
  return events
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }] },
  }
}

describe("P1-T44 the session's events (S5, protocol §Events)", () => {
  it("start and settings_filtered events come first, then user_message, then normalised events", async () => {
    const job = sessionJob()
    const home = job.home as string
    writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [] }, permissions: { allow: ["Bash(*)"] } }),
    )
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(job, [], [INIT, assistant("m1", 3, 2, "Hello"), RESULT]),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    const events = eventsOf(lines)
    expect(events.map((e) => e.type)).toEqual([
      "system",
      "system",
      "user_message",
      "assistant_text",
      "usage",
      "result",
    ])
    const [start, filtered, user] = events
    expect(start?.payload).toMatchObject({ subtype: "start" })
    const data = start?.payload.data as Record<string, unknown>
    expect(data.sessionId).toBe("sdk-session-1")
    expect(data.claudeCode).toBe(`${data.claudeCodeVersion} bundled ${BUNDLED}`)
    expect(data.claudeCodeSource).toBe("bundled")
    // D15: the level travels as a code for the web to say.
    expect(data.level).toBe(job.session?.level)
    expect(data.configDir).toBe(sessionConfigDir(SESSION_ID, path.join(home, "data")))
    expect(data.configKind).toBe("owner")
    expect(data.settingSources).toEqual(["user", "project", "local"])
    // S5: the host server is the one server every session gets.
    expect(data.mcp).toEqual({ loaded: ["liaison_session"], skipped: [] })
    expect(filtered?.payload).toMatchObject({
      subtype: "settings_filtered",
      data: { hooksOff: true, userKeysNotMirrored: ["hooks", "permissions.allow"], mcpSkipped: [] },
    })
    expect(user?.payload).toEqual({ text: "List the files." })
  })

  it("Open has no settings_filtered event", async () => {
    const lines: Array<Record<string, unknown>> = []
    await runUnattended({
      ...runArgs(sessionJob({ level: "open", profileLevel: "open" }), [], [INIT, RESULT]),
      emit: (l) => lines.push(l),
    })
    const types = eventsOf(lines).map((e) => `${e.type}:${String(e.payload.subtype ?? "")}`)
    expect(types).toEqual(["system:start", "user_message:", "result:success"])
  })

  it("job_done comes after the last events flush", async () => {
    const lines: Array<Record<string, unknown>> = []
    await runUnattended({
      ...runArgs(sessionJob(), [], [INIT, assistant("m1", 1, 1), RESULT]),
      emit: (l) => lines.push(l),
    })
    const types = lines.map((l) => l.type)
    const done = types.indexOf("job_done")
    expect(done).toBe(types.length - 1)
    expect(types.lastIndexOf("session_events")).toBeLessThan(done)
    expect(eventsOf(lines).at(-1)?.type).toBe("result")
  })
})

describe("P1-T44 an askable call waits for the owner (S12, S14 base, D39)", () => {
  it("an ask decision reaches canUseTool and emits one permission_request; the run is still pending", async () => {
    const lines: Array<Record<string, unknown>> = []
    const control = new AsyncQueue<string>()
    const asks = new SessionAsks()
    let answer: Promise<unknown> | undefined
    const abort = new AbortController()
    const running = runUnattended({
      ...runArgs(
        sessionJob(),
        [],
        [
          INIT,
          toolUse("toolu_1", "Edit", { file_path: "/elsewhere/x.ts" }),
          async (options: Options) => {
            answer = options.canUseTool?.(
              "Edit",
              { file_path: "/elsewhere/x.ts" },
              {
                signal: abort.signal,
                toolUseID: "toolu_1",
                requestId: "ctl-1",
                decisionReason: "Edit: /elsewhere/x.ts is outside this session's folder",
              },
            )
            // The CLI waits on the answer before it goes on.
            await answer
          },
          RESULT,
        ],
      ),
      emit: (l) => lines.push(l),
      control,
      asks,
    })
    let settled = false
    void running.then(() => {
      settled = true
    })
    await Bun.sleep(400)
    const requests = eventsOf(lines).filter((e) => e.type === "permission_request")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.payload).toEqual({
      requestId: "toolu_1",
      tool: "Edit",
      input: { file_path: "/elsewhere/x.ts" },
      reason: "Edit: /elsewhere/x.ts is outside this session's folder",
    })
    expect(asks.pending()).toEqual(["toolu_1"])
    expect(settled).toBe(false)
    // Nothing answers in P1 (D39): the run ends only when the shell stops it.
    control.push(JSON.stringify({ type: "abort" }))
    const outcome = await running
    expect(outcome.status).toBe("aborted")
    expect(await answer).toMatchObject({ behavior: "deny", interrupt: true })
  })

  it("AskUserQuestion emits a question and ExitPlanMode a plan_request", async () => {
    const lines: Array<Record<string, unknown>> = []
    const control = new AsyncQueue<string>()
    const signal = new AbortController().signal
    const questions = [
      { question: "Which branch?", header: "Branch", options: [], multiSelect: false },
    ]
    const running = runUnattended({
      ...runArgs(
        sessionJob(),
        [],
        [
          INIT,
          async (o: Options) => {
            await Promise.all([
              o.canUseTool?.(
                "AskUserQuestion",
                { questions },
                { signal, toolUseID: "toolu_q", requestId: "ctl-q" },
              ),
              o.canUseTool?.(
                "ExitPlanMode",
                { plan: "1. read\n2. fix" },
                { signal, toolUseID: "toolu_p", requestId: "ctl-p" },
              ),
            ])
          },
          RESULT,
        ],
      ),
      emit: (l) => lines.push(l),
      control,
    })
    await Bun.sleep(400)
    const asked = eventsOf(lines).filter((e) => e.type === "question" || e.type === "plan_request")
    expect(asked.map((e) => e.payload)).toEqual([
      { requestId: "toolu_q", questions },
      { requestId: "toolu_p", plan: "1. read\n2. fix" },
    ])
    control.push(JSON.stringify({ type: "abort" }))
    expect((await running).status).toBe("aborted")
  })

  it("walk D6: an ExitPlanMode with no plan in its input carries the plan file plan mode wrote", async () => {
    const lines: Array<Record<string, unknown>> = []
    const control = new AsyncQueue<string>()
    const signal = new AbortController().signal
    const job = sessionJob()
    const planDir = path.join(
      sessionConfigDir(SESSION_ID, path.join(job.home as string, "data")),
      "plans",
    )
    const running = runUnattended({
      ...runArgs(
        job,
        [],
        [
          INIT,
          async (o: Options) => {
            // Plan mode had the model write its plan here (through the Write tool).
            mkdirSync(planDir, { recursive: true })
            writeFileSync(path.join(planDir, "old.md"), "an older plan")
            await Bun.sleep(20)
            writeFileSync(path.join(planDir, "fluttering-otter.md"), "# Plan\n1. read\n2. fix")
            await o.canUseTool?.(
              "ExitPlanMode",
              {},
              { signal, toolUseID: "toolu_p", requestId: "c" },
            )
          },
          RESULT,
        ],
      ),
      emit: (l) => lines.push(l),
      control,
    })
    await until(() => eventsOf(lines).some((e) => e.type === "plan_request"))
    expect(eventsOf(lines).find((e) => e.type === "plan_request")?.payload).toEqual({
      requestId: "toolu_p",
      plan: "# Plan\n1. read\n2. fix",
    })
    control.push(JSON.stringify({ type: "abort" }))
    expect((await running).status).toBe("aborted")
  })

  it("a setMode to bypass in updatedPermissions is stripped; leaving to plan is kept", async () => {
    const result = sanitizePermissionResult({
      behavior: "allow",
      updatedInput: { file_path: "x" },
      updatedPermissions: [
        { type: "setMode", mode: "bypassPermissions", destination: "session" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { type: "setMode", mode: "plan", destination: "session" },
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    })
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "x" },
      updatedPermissions: [
        { type: "setMode", mode: "plan", destination: "session" },
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    })
    // Through the waiting request too.
    const asks = new SessionAsks()
    const waiting = asks.ask("toolu_9", null, new AbortController().signal)
    expect(
      asks.resolve("toolu_9", {
        behavior: "allow",
        updatedPermissions: [
          { type: "setMode", mode: "bypassPermissions", destination: "session" },
        ],
      }),
    ).toBe(true)
    expect(await waiting).toEqual({ behavior: "allow", updatedPermissions: [] })
  })
})

describe("P1-T44 the result reports the branch and whether it was pushed (S15, K17)", () => {
  function remoteWorld() {
    const job = sessionJob({ source: "dispatch", level: "standard", profileLevel: "standard" })
    const home = job.home as string
    const repo = ownerRepo(path.join(home, "code"))
    const bare = path.join(home, "remote.git")
    git(home, "clone", "-q", "--bare", repo, bare)
    git(repo, "remote", "add", "origin", bare)
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    return { job, bare }
  }

  async function resultOf(job: UnattendedJob, during: Array<(o: Options) => unknown>) {
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    await runUnattended({
      ...runArgs(job, captured, [INIT, ...during, RESULT]),
      emit: (l) => lines.push(l),
    })
    return {
      result: eventsOf(lines).find((e) => e.type === "result")?.payload,
      cwd: captured[0]?.options.cwd as string,
    }
  }

  // Each runs a whole session plus synchronous git work (a bare clone, a
  // commit, a push): well under a second alone, but past bun's 5 s default
  // once under load (seen 2026-10-15), so each has its own budget.
  const GIT_RUN_TIMEOUT_MS = 30_000

  it(
    "pushed is false before the push; in place, the branch is the folder's own",
    async () => {
      const before = remoteWorld()
      const r1 = await resultOf(before.job, [])
      expect(r1.result).toMatchObject({ isError: false, pushed: false })
      // S50.6 (owner D13): in place, the folder's checked-out branch, read from
      // the folder: on main, the one the node made for the session (D40).
      expect(r1.result?.branch).toBe("liaison/9f8e7d6c-my-repo")
      expect(r1.cwd).toBe(before.job.session?.folderPath as string)
    },
    GIT_RUN_TIMEOUT_MS,
  )

  it(
    "pushed is true after `git push origin <branch>` without -u",
    async () => {
      const after = remoteWorld()
      let branch = ""
      const r2 = await resultOf(after.job, [
        (o) => {
          const cwd = o.cwd as string
          writeFileSync(path.join(cwd, "fix.ts"), "export const x = 1\n")
          git(cwd, "add", "fix.ts")
          git(cwd, "commit", "-q", "-m", "fix")
          branch = spawnSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
            encoding: "utf8",
          }).stdout.trim()
          git(cwd, "push", "-q", "origin", branch)
        },
      ])
      expect(r2.result).toMatchObject({ isError: false, branch, pushed: true })
      expect(r2.result?.prUrl).toBeUndefined()
    },
    GIT_RUN_TIMEOUT_MS,
  )

  // P1-walk D1: end-of-turn events reached the server ~2 s late: the result's
  // facts ran a synchronous `git ls-remote` (network) while the turn's last
  // events sat in the batcher, and the blocked event loop never flushed them.
  it("the turn's events go out before the result's facts, and no remote is read when nothing was pushed (D1)", async () => {
    const { job } = remoteWorld()
    const home = job.home as string
    const bin = path.join(home, "fake-bin")
    mkdirSync(bin, { recursive: true })
    const log = path.join(home, "git-calls.log")
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    )
    const lines: Array<Record<string, unknown>> = []
    await runUnattended({
      ...runArgs(job, [], [INIT, assistant("m1", 3, 2, "Done."), RESULT]),
      sourceEnv: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: "owner" },
      emit: (l) => lines.push(l),
    })
    const batches = lines
      .filter((l) => l.type === "session_events")
      .map((l) => (l.events as Array<{ type: string }>).map((e) => e.type))
    const withResult = batches.find((b) => b.includes("result"))
    expect(withResult).toBeDefined()
    expect(withResult).not.toContain("assistant_text")
    expect(batches.some((b) => b.includes("assistant_text"))).toBe(true)
    const calls = existsSync(log) ? readFileSync(log, "utf8") : ""
    expect(calls).toContain("symbolic-ref")
    expect(calls).not.toContain("ls-remote")
  })

  it("a session in no repository reports no branch", async () => {
    const r = await resultOf(sessionJob(), [])
    expect(r.result).toEqual({ text: "Listed the files.", isError: false, subtype: "success" })
  })
})

// ── P3-T05: the long-lived session (D36, S9, S16, G1, G11) ──

const CMD = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** One owner command as the shell writes it on stdin. */
function cmdLine(n: number, command: NodeSessionCommand): string {
  return commandLine({ type: "command", commandId: CMD(n), seq: n, command })
}

interface Live {
  queryFn: QueryFn
  /** What the session yields next. */
  out: AsyncQueue<unknown>
  /** The user messages the SDK pulled, in order. */
  pulled: Array<{ uuid: string; text: string }>
  options: Options[]
  interrupts: number
  closes: number
  models: string[]
  /** What `applyFlagSettings` received, in order. */
  flags: Array<Record<string, unknown>>
  /** S54: the task ids `stopTask` received, in order. */
  stoppedTasks: string[]
}

/**
 * A query that stays open like a streaming one: it pulls its input eagerly
 * (as the SDK does), answers each pulled message with the CLI's lifecycle
 * (`queued`, then `started` unless `holdStart`), and yields whatever the test
 * puts on `out`, until closed.
 */
function liveQuery(
  opts: { holdStart?: boolean; stillQueued?: string[]; flagsRefused?: boolean } = {},
): Live {
  const live: Live = {
    queryFn: null as never,
    out: new AsyncQueue<unknown>(),
    pulled: [],
    options: [],
    interrupts: 0,
    closes: 0,
    models: [],
    flags: [],
    stoppedTasks: [],
  }
  live.queryFn = ({ prompt, options }) => {
    live.options.push(options as Options)
    void (async () => {
      for await (const m of prompt as AsyncIterable<{
        uuid: string
        message: { content: string }
      }>) {
        live.pulled.push({ uuid: m.uuid, text: m.message.content })
        live.out.push({ type: "command_lifecycle", command_uuid: m.uuid, state: "queued" })
        if (!opts.holdStart || live.pulled.length === 1) {
          live.out.push({ type: "command_lifecycle", command_uuid: m.uuid, state: "started" })
        }
      }
    })()
    const iterator = live.out[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      interrupt: async () => {
        live.interrupts++
        return { still_queued: opts.stillQueued ?? [] }
      },
      close: () => {
        live.closes++
        live.out.close()
      },
      setModel: async (model: string) => {
        live.models.push(model)
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        live.flags.push(settings)
        if (opts.flagsRefused) throw new Error("unknown control request")
      },
      stopTask: async (taskId: string) => {
        live.stoppedTasks.push(taskId)
      },
      supportedModels: async () => [
        { value: "claude-haiku-4-5", displayName: "Haiku", description: "" },
        { value: "claude-sonnet-4-5", displayName: "Sonnet", description: "" },
      ],
    } as never
  }
  return live
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function steer(job: UnattendedJob, live: Live, extra: Partial<RunUnattendedArgs> = {}) {
  const lines: Array<Record<string, unknown>> = []
  const control = new AsyncQueue<string>()
  const running = runUnattended({
    ...runArgs(job, []),
    queryFn: live.queryFn,
    emit: (l) => lines.push(l),
    control,
    ...extra,
  })
  return { lines, control, running, events: () => eventsOf(lines) }
}

const applied = (events: Array<{ type: string; payload: Record<string, unknown> }>) =>
  events.filter((e) => e.type === "command_applied").map((e) => e.payload)

describe("P3-T05 the long-lived session (D36, S9)", () => {
  it("a message mid-run is yielded at the next pull, with user_message carrying its commandId, then command_applied", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push(assistant("m1", 1, 1, "working"))
    s.control.push(cmdLine(1, { type: "message", payload: { text: "Also list .claude" } }))
    await until(() => live.pulled.length === 2)
    expect(live.pulled[1]?.text).toBe("Also list .claude")
    await until(() => applied(s.events()).length === 1)
    const events = s.events()
    const user = events.findIndex((e) => e.type === "user_message" && e.payload.commandId)
    const ack = events.findIndex((e) => e.type === "command_applied")
    expect(events[user]?.payload).toEqual({ text: "Also list .claude", commandId: CMD(1) })
    expect(events[ack]?.payload).toEqual({ commandId: CMD(1), type: "message", outcome: "applied" })
    expect(user).toBeLessThan(ack)
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
  })

  it("the run continues after a result while a message is queued, and ends done after the next result", async () => {
    const live = liveQuery({ holdStart: true })
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "message", payload: { text: "then this" } }))
    await until(() => live.pulled.length === 2)
    live.out.push({ ...RESULT, result: "first" })
    await Bun.sleep(50)
    let settled = false
    void s.running.then(() => {
      settled = true
    })
    await Bun.sleep(20)
    expect(settled).toBe(false)
    expect(live.closes).toBe(0)
    // The CLI starts the queued message as the next turn.
    live.out.push({
      type: "command_lifecycle",
      command_uuid: live.pulled[1]?.uuid,
      state: "started",
    })
    live.out.push({ ...RESULT, result: "second" })
    const outcome = await s.running
    expect(outcome.status).toBe("done")
    expect(outcome.text).toBe("second")
    expect(live.closes).toBeGreaterThan(0)
  })

  it("a result with an open task_started does not end the run", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push({ type: "system", subtype: "task_started", task_id: "t1", description: "bg" })
    live.out.push({ ...RESULT, result: "early" })
    let settled = false
    void s.running.then(() => {
      settled = true
    })
    await Bun.sleep(50)
    expect(settled).toBe(false)
    live.out.push({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
    })
    live.out.push({ ...RESULT, result: "after the task" })
    const outcome = await s.running
    expect(outcome.status).toBe("done")
    expect(outcome.text).toBe("after the task")
  })

  it("stop cancels two queued messages, denies a pending ask with interrupt, calls interrupt and close, and ends stopped", async () => {
    const live = liveQuery({ holdStart: true, stillQueued: ["u1", "u2"] })
    const asks = new SessionAsks()
    const s = steer(sessionJob(), live, { asks, stopGraceMs: 50 })
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push(toolUse("toolu_1", "Edit", { file_path: "/elsewhere/x.ts" }))
    await until(() => live.options.length === 1)
    const answer = live.options[0]?.canUseTool?.("Edit", { file_path: "/elsewhere/x.ts" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_1",
      requestId: "c1",
    } as never)
    s.control.push(cmdLine(1, { type: "message", payload: { text: "one" } }))
    s.control.push(cmdLine(2, { type: "message", payload: { text: "two" } }))
    await until(() => live.pulled.length === 3)
    s.control.push(cmdLine(3, { type: "stop", payload: {} }))
    const outcome = await s.running
    expect(outcome.status).toBe("stopped")
    expect(await answer).toMatchObject({ behavior: "deny", interrupt: true })
    expect(live.interrupts).toBe(1)
    expect(live.closes).toBeGreaterThan(0)
    const events = s.events()
    expect(applied(events)).toEqual([
      { commandId: CMD(1), type: "message", outcome: "cancelled" },
      { commandId: CMD(2), type: "message", outcome: "cancelled" },
      { commandId: CMD(3), type: "stop", outcome: "applied" },
    ])
    expect(events.find((e) => e.type === "decision")?.payload).toEqual({
      requestId: "toolu_1",
      outcome: "deny",
      by: "stop",
    })
    expect(
      events.find((e) => e.type === "system" && e.payload.subtype === "still_queued")?.payload,
    ).toMatchObject({ data: { count: 2 } })
    // No message of the owner's was delivered.
    expect(events.filter((e) => e.type === "user_message" && e.payload.commandId)).toEqual([])
    const done = s.lines.find((l) => l.type === "job_done")
    expect(done?.status).toBe("stopped")
  })

  it("a second stop is noop", async () => {
    const live = liveQuery()
    // A long grace: the second stop arrives while the first still waits for the result.
    const s = steer(sessionJob(), live, { stopGraceMs: 5_000 })
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "stop", payload: {} }))
    s.control.push(cmdLine(2, { type: "stop", payload: {} }))
    await until(() => applied(s.events()).length === 1)
    expect(applied(s.events())).toEqual([{ commandId: CMD(2), type: "stop", outcome: "noop" }])
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    expect((await s.running).status).toBe("stopped")
    expect(applied(s.events())).toEqual([
      { commandId: CMD(2), type: "stop", outcome: "noop" },
      { commandId: CMD(1), type: "stop", outcome: "applied" },
    ])
    expect(live.interrupts).toBe(1)
  })

  it("set_model to an offered model calls setModel and emits model_changed; an unknown one fails model_unavailable", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "set_model", payload: { model: "claude-sonnet-4-5" } }))
    s.control.push(cmdLine(2, { type: "set_model", payload: { model: "gpt-9" } }))
    await until(() => applied(s.events()).length === 2)
    expect(live.models).toEqual(["claude-sonnet-4-5"])
    const events = s.events()
    expect(events.find((e) => e.type === "model_changed")?.payload).toEqual({
      from: "claude-haiku-4-5",
      to: "claude-sonnet-4-5",
    })
    expect(applied(events)).toEqual([
      { commandId: CMD(1), type: "set_model", outcome: "applied" },
      { commandId: CMD(2), type: "set_model", outcome: "failed", error: "model_unavailable" },
    ])
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
  })

  it("walk D7: a model the node offers applies even when the session's CLI lists it otherwise", async () => {
    const live = liveQuery()
    // The SDK in the session lists Haiku and Sonnet 4.5 only; the node offers Sonnet 5.
    const job = sessionJob({ offeredModels: ["claude-haiku-4-5", "claude-sonnet-5"] })
    const file = path.join(job.home as string, "job.json")
    writeFileSync(file, JSON.stringify(job))
    expect(readJobFile(file).session?.offeredModels).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
    ])
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "set_model", payload: { model: "claude-sonnet-5" } }))
    s.control.push(cmdLine(2, { type: "set_model", payload: { model: "claude-opus-9" } }))
    await until(() => applied(s.events()).length === 2)
    expect(live.models).toEqual(["claude-sonnet-5"])
    expect(applied(s.events())).toEqual([
      { commandId: CMD(1), type: "set_model", outcome: "applied" },
      { commandId: CMD(2), type: "set_model", outcome: "failed", error: "model_unavailable" },
    ])
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
  })

  it("set_level to the session's own level is noop", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "strict" } }))
    await until(() => applied(s.events()).length === 1)
    expect(applied(s.events())[0]).toMatchObject({ outcome: "noop", type: "set_level" })
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
  })
})

describe("walk D5: two runs starting together", () => {
  it("each has its own shell home, gone with its run; neither fails the other", async () => {
    const one = sessionJob()
    const two = sessionJob(
      { id: "abcdefab-1111-4222-8333-444455556666" },
      { jobId: "99999999-8888-4777-8666-555544443333" },
    )
    const data = path.join(one.home as string, "data")
    const homes: string[] = []
    const seen: QueryFn = (args) => {
      homes.push(String((args.options as Options).env?.HOME))
      return fakeQuery([INIT, RESULT], [])(args)
    }
    const [a, b] = await Promise.all([
      runUnattended({ ...runArgs(one, []), dataDir: data, queryFn: seen }),
      runUnattended({ ...runArgs(two, []), dataDir: data, queryFn: seen }),
    ])
    expect([a.status, b.status]).toEqual(["done", "done"])
    expect(new Set(homes).size).toBe(2)
    for (const home of homes) {
      expect(path.dirname(home)).toBe(path.join(data, "node-job-home"))
      expect(existsSync(home)).toBe(false)
    }
  })
})

describe("walk D3: the start facts carry the SDK session id", () => {
  it("what the CLI says before its init (a rate-limit notice, a message read) waits for it; the start names the SDK session", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    // An owner message the CLI reads before its init (its lifecycle comes first).
    s.control.push(cmdLine(1, { type: "message", payload: { text: "also this" } }))
    await until(() => live.pulled.length === 2)
    live.out.push({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
      session_id: "sdk-session-1",
    })
    await Bun.sleep(30)
    live.out.push(INIT)
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
    const events = s.events()
    expect(events[0]?.type).toBe("system")
    expect(events[0]?.payload.subtype).toBe("start")
    expect((events[0]?.payload.data as Record<string, unknown> | undefined)?.sessionId).toBe(
      "sdk-session-1",
    )
    const users = events.filter((e) => e.type === "user_message").map((e) => e.payload)
    expect(users[0]).toEqual({ text: sessionJob().prompt })
    expect(users[1]).toEqual({ text: "also this", commandId: CMD(1) })
    // Every start event of the run carries it.
    const starts = events.filter((e) => e.type === "system" && e.payload.subtype === "start")
    expect(starts).toHaveLength(1)
    expect(applied(events)).toEqual([{ commandId: CMD(1), type: "message", outcome: "applied" }])
  })

  it("a run that ends before any init still sends what it held, start facts first", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })
    await Bun.sleep(30)
    live.out.close()
    await s.running
    const events = s.events()
    expect(events[0]?.payload.subtype).toBe("start")
    expect(events.some((e) => e.type === "system" && e.payload.subtype === "rate_limit")).toBe(true)
  })
})

describe("P3-T05 a run that resumes its session (D36, G1, R7)", () => {
  it("a resume job passes options.resume and emits resumed then the synthetic user_message", async () => {
    const live = liveQuery()
    const job = sessionJob({ resume: { sdkSessionId: "sdk-session-1", after: "offline" } })
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    expect(live.options[0]?.resume).toBe("sdk-session-1")
    expect(live.pulled[0]?.text).toBe(
      "The session was interrupted (the computer was offline). Continue where you left off.",
    )
    live.out.push(INIT)
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
    const events = s.events()
    expect(events[0]).toMatchObject({ type: "resumed", payload: { after: "offline" } })
    expect(events.find((e) => e.type === "user_message")?.payload).toEqual({
      text: "The session was interrupted (the computer was offline). Continue where you left off.",
      synthetic: true,
    })
  })

  it("a resume by message emits user_message with that commandId and acks it applied", async () => {
    const live = liveQuery()
    const job = sessionJob(
      { resume: { sdkSessionId: "sdk-session-1", after: "message", commandId: CMD(7) } },
      { prompt: "What did you do before I stopped you?" },
    )
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    expect(live.pulled[0]?.text).toBe("What did you do before I stopped you?")
    live.out.push(INIT)
    live.out.push(RESULT)
    await s.running
    const events = s.events()
    expect(events.find((e) => e.type === "user_message")?.payload).toEqual({
      text: "What did you do before I stopped you?",
      commandId: CMD(7),
    })
    expect(applied(events)).toEqual([{ commandId: CMD(7), type: "message", outcome: "applied" }])
  })

  it("a resume by message re-sent on stdin before the first SDK message is fed to the SDK once (M1)", async () => {
    const live = liveQuery()
    const text = "What did you do before I stopped you?"
    const job = sessionJob(
      { resume: { sdkSessionId: "sdk-session-1", after: "message", commandId: CMD(7) } },
      { prompt: text },
    )
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    // The runner re-sends the still unacked command before the CLI's first message.
    s.control.push(cmdLine(7, { type: "message", payload: { text } }))
    await Bun.sleep(50)
    live.out.push(INIT)
    live.out.push(RESULT)
    await s.running
    expect(live.pulled.map((p) => p.text)).toEqual([text])
    const events = s.events()
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1)
    expect(applied(events)).toEqual([{ commandId: CMD(7), type: "message", outcome: "applied" }])
  })

  it("walk D3: a message resume with no SDK session starts fresh on the message and still acks it", async () => {
    const live = liveQuery()
    const text = "What did you do before I stopped you?"
    const job = sessionJob({ resume: { after: "message", commandId: CMD(7) } }, { prompt: text })
    const file = path.join(job.home as string, "job.json")
    writeFileSync(file, JSON.stringify(job))
    expect(readJobFile(file).session?.resume).toEqual({ after: "message", commandId: CMD(7) })
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    expect(live.options[0]?.resume).toBeUndefined()
    expect(live.pulled[0]?.text).toBe(text)
    live.out.push(INIT)
    live.out.push(RESULT)
    await s.running
    const events = s.events()
    expect(events.some((e) => e.type === "resumed")).toBe(false)
    expect(events.find((e) => e.type === "user_message")?.payload).toEqual({
      text,
      commandId: CMD(7),
    })
    expect(applied(events)).toEqual([{ commandId: CMD(7), type: "message", outcome: "applied" }])
  })

  it("a job file's resume is read, and a malformed one refuses the file", () => {
    const job = sessionJob({ resume: { sdkSessionId: "abc-123", after: "crash" } })
    const file = path.join(job.home as string, "job.json")
    writeFileSync(file, JSON.stringify(job))
    expect(readJobFile(file).session?.resume).toEqual({ sdkSessionId: "abc-123", after: "crash" })
    writeFileSync(
      file,
      JSON.stringify({
        ...job,
        session: { ...job.session, resume: { sdkSessionId: "x", after: "nap" } },
      }),
    )
    expect(() => readJobFile(file)).toThrow()
  })
})

// ── P3-T08: the owner's answers through the session's stdin (S9, S12, S14) ──

describe("P3-T08 answers reach the waiting canUseTool calls", () => {
  const sig = () => new AbortController().signal

  it("Deny through a command resolves deny and the CLI's next message carries a denied tool_result", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    const answer = live.options[0]?.canUseTool?.(
      "Write",
      { file_path: "/outside/x.txt", content: "x" },
      { signal: sig(), toolUseID: "toolu_w", requestId: "c" } as never,
    )
    await until(() => s.events().some((e) => e.type === "permission_request"))
    s.control.push(
      cmdLine(1, {
        type: "permission_decision",
        payload: { requestId: "toolu_w", allow: false, scope: "once" },
      }),
    )
    const result = (await answer) as { behavior: string; message?: string }
    expect(result).toEqual({ behavior: "deny", message: "Denied by the owner." })
    // What the CLI does with a deny: a tool_result marked as an error.
    live.out.push({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_w", is_error: true, content: result.message },
        ],
      },
    })
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
    const events = s.events()
    expect(events.find((e) => e.type === "decision")?.payload).toEqual({
      requestId: "toolu_w",
      outcome: "deny",
      by: "owner",
    })
    expect(events.find((e) => e.type === "tool_result")?.payload).toMatchObject({
      id: "toolu_w",
      isError: true,
    })
    expect(applied(events)).toEqual([
      { commandId: CMD(1), type: "permission_decision", outcome: "applied" },
    ])
  })

  it("D55: Allow for this session never covers a Playwright test runner: every run asks the owner", async () => {
    const live = liveQuery()
    const s = steer(sessionJob({ level: "standard", profileLevel: "standard" }), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    const command = { command: "npx playwright test" }
    const ask = (id: string) =>
      live.options[0]?.canUseTool?.("Bash", command, {
        signal: sig(),
        toolUseID: id,
        requestId: id,
      } as never)
    const first = ask("toolu_p1")
    await until(() => s.events().some((e) => e.type === "permission_request"))
    s.control.push(
      cmdLine(1, {
        type: "permission_decision",
        payload: { requestId: "toolu_p1", allow: true, scope: "session" },
      }),
    )
    expect((await first)?.behavior).toBe("allow")
    void ask("toolu_p2")
    await until(() => s.events().filter((e) => e.type === "permission_request").length === 2)
    expect(
      s
        .events()
        .filter((e) => e.type === "permission_request")
        .map((e) => e.payload.requestId),
    ).toEqual(["toolu_p1", "toolu_p2"])
    expect(s.events().some((e) => e.payload.subtype === "allowed_for_session")).toBe(false)
    s.control.push(JSON.stringify({ type: "abort" }))
    await s.running
  })

  it("D56 F3: the browser test card says the repository's code runs with the owner's full rights and lists the test files changed here", async () => {
    const live = liveQuery()
    const job = sessionJob({ level: "standard", profileLevel: "standard" })
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    mkdirSync(path.join(repo, "tests"), { recursive: true })
    writeFileSync(path.join(repo, "playwright.config.ts"), "export default {}\n")
    writeFileSync(path.join(repo, "tests", "home.spec.ts"), "// planted\n")
    writeFileSync(path.join(repo, "README.md"), "# not run by the test\n")
    void live.options[0]?.canUseTool?.("Bash", { command: "npx playwright test" }, {
      signal: sig(),
      toolUseID: "toolu_pw",
      requestId: "toolu_pw",
    } as never)
    await until(() => s.events().some((e) => e.type === "permission_request"))
    const card = s.events().find((e) => e.type === "permission_request")?.payload
    expect(card?.browserTest).toEqual({
      files: ["playwright.config.ts", "tests/home.spec.ts"],
      more: 0,
    })
    expect(card?.reason).toBe(
      `${BROWSER_TEST_RIGHTS} Changed in this folder: playwright.config.ts, tests/home.spec.ts.`,
    )
    s.control.push(JSON.stringify({ type: "abort" }))
    await s.running
  })

  it("Allow for this session allows a second Write in the same directory with no request, and not one in another directory", async () => {
    const live = liveQuery()
    const job = sessionJob()
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    const ask = (id: string, file: string) =>
      live.options[0]?.canUseTool?.("Write", { file_path: file, content: "x" }, {
        signal: sig(),
        toolUseID: id,
        requestId: id,
      } as never)
    const first = ask("toolu_1", "/outside/dir/a.txt")
    await until(() => s.events().some((e) => e.type === "permission_request"))
    s.control.push(
      cmdLine(1, {
        type: "permission_decision",
        payload: { requestId: "toolu_1", allow: true, scope: "session" },
      }),
    )
    expect((await first)?.behavior).toBe("allow")
    expect(await ask("toolu_2", "/outside/dir/b.txt")).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/outside/dir/b.txt", content: "x" },
    })
    void ask("toolu_3", "/outside/other/c.txt")
    await until(() => s.events().filter((e) => e.type === "permission_request").length === 2)
    const events = s.events()
    expect(
      events.filter((e) => e.type === "permission_request").map((e) => e.payload.requestId),
    ).toEqual(["toolu_1", "toolu_3"])
    expect(events.filter((e) => e.type === "decision").map((e) => e.payload)).toEqual([
      { requestId: "toolu_1", outcome: "allow_session", by: "owner" },
      { requestId: "toolu_2", outcome: "allow_session", by: "owner" },
    ])
    // Kept for a resumed run of the session.
    const dir = jobContextFor(job, "darwin").sessionDir as string
    expect(existsSync(path.join(dir, "allowed.json"))).toBe(true)
    s.control.push(JSON.stringify({ type: "abort" }))
    await s.running
  })

  it("a typed message answers the one waiting single-question AskUserQuestion", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    const questions = [{ question: "A or B?", header: "Pick", options: [], multiSelect: false }]
    const answer = live.options[0]?.canUseTool?.("AskUserQuestion", { questions }, {
      signal: sig(),
      toolUseID: "toolu_q",
      requestId: "q",
    } as never)
    await until(() => s.events().some((e) => e.type === "question"))
    s.control.push(cmdLine(1, { type: "message", payload: { text: "B" } }))
    expect(await answer).toEqual({
      behavior: "allow",
      updatedInput: { questions, answers: { "A or B?": "B" } },
    })
    // Not sent to the session as a message.
    expect(live.pulled).toHaveLength(1)
    await until(() => applied(s.events()).length === 1)
    expect(applied(s.events())[0]).toEqual({
      commandId: CMD(1),
      type: "message",
      outcome: "applied",
    })
    live.out.push(RESULT)
    await s.running
  })

  it("the process ending emits decision expired for each open request", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    for (const id of ["toolu_a", "toolu_b"]) {
      void live.options[0]?.canUseTool?.("Write", { file_path: `/outside/${id}`, content: "x" }, {
        signal: sig(),
        toolUseID: id,
        requestId: id,
      } as never)
    }
    await until(() => s.events().filter((e) => e.type === "permission_request").length === 2)
    live.out.push(RESULT)
    await s.running
    expect(
      s
        .events()
        .filter((e) => e.type === "decision")
        .map((e) => e.payload),
    ).toEqual([
      { requestId: "toolu_a", outcome: "expired", by: "process_exit" },
      { requestId: "toolu_b", outcome: "expired", by: "process_exit" },
    ])
  })
})

// ── P3-T19: a cut tool output stays whole on this computer (S7) ──

describe("P3-T19 the run spills cut outputs into its session dir", () => {
  it("a tool_result over 64 KiB is written to <sessionDir>/spill/<id>.txt", async () => {
    const live = liveQuery()
    const job = sessionJob()
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    const output = "line\n".repeat(30_000)
    live.out.push(INIT)
    live.out.push({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_seq", content: output }],
      },
    })
    live.out.push(RESULT)
    await s.running
    const dir = jobContextFor(job, "darwin").sessionDir as string
    expect(readFileSync(path.join(dir, "spill", "toolu_seq.txt"), "utf8")).toBe(output)
    expect(s.events().find((e) => e.type === "tool_result")).toMatchObject({ truncated: true })
  })
})

// ── P3-T23: a level change restarts the process (D34) ──

describe("P3-T23 the level switch", () => {
  /** What the session's PreToolUse guard answers for a Write to a path. */
  async function guard(live: Live, filePath: string): Promise<string> {
    const hook = live.options[0]?.hooks?.PreToolUse?.[0]?.hooks?.[0] as unknown as (
      input: unknown,
    ) => Promise<{ hookSpecificOutput: { permissionDecision: string } }>
    const out = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath, content: "x" },
      cwd: live.options[0]?.cwd,
    })
    return out.hookSpecificOutput.permissionDecision
  }

  it("lowering to strict refuses a Standard-only write at once, then restarts", async () => {
    const live = liveQuery()
    const job = sessionJob(
      { level: "standard", profileLevel: "standard" },
      {
        profile: { level: "standard", liaisonTools: false },
      },
    )
    const outside = path.join(job.home as string, "Documents", "notes.txt")
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    expect(await guard(live, outside)).toBe("allow")
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "strict" } }))
    await until(() => applied(s.events()).length === 1)
    expect(await guard(live, outside)).not.toBe("allow")
    const outcome = await s.running
    expect(outcome).toMatchObject({
      status: "restart",
      level: "strict",
      sdkSessionId: "sdk-session-1",
    })
    expect(live.interrupts).toBe(1)
    expect(applied(s.events())).toEqual([
      { commandId: CMD(1), type: "set_level", outcome: "applied" },
    ])
    expect(s.lines.at(-1)).toMatchObject({ type: "job_done", status: "restart", level: "strict" })
  })

  it("D56 F2: lowering Standard to Strict refuses a Playwright runner until the restart (the running CLI still excludes it from its sandbox)", async () => {
    const live = liveQuery()
    const job = sessionJob(
      { level: "standard", profileLevel: "standard" },
      { profile: { level: "standard", liaisonTools: false } },
    )
    const bash = async (command: string) => {
      const hook = live.options[0]?.hooks?.PreToolUse?.[0]?.hooks?.[0] as unknown as (
        input: unknown,
      ) => Promise<{
        hookSpecificOutput: {
          hookEventName: string
          permissionDecision: string
          permissionDecisionReason?: string
        }
      }>
      return (
        await hook({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          cwd: live.options[0]?.cwd,
        })
      ).hookSpecificOutput
    }
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    expect((await bash("npx playwright test")).permissionDecision).toBe("ask")
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "strict" } }))
    await until(() => applied(s.events()).length === 1)
    expect(await bash("npx playwright test")).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: `Refused at the strict level: ${PENDING_RUNNER_REFUSAL}`,
      hookEventName: "PreToolUse",
    })
    expect((await bash("ls")).permissionDecision).toBe("allow")
    expect(await s.running).toMatchObject({ status: "restart", level: "strict" })
  })

  it("raising restarts only after the next result, and keeps the stricter guard until then", async () => {
    const live = liveQuery()
    const job = sessionJob()
    const outside = path.join(job.home as string, "Documents", "notes.txt")
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "standard" } }))
    await until(() => applied(s.events()).length === 1)
    expect(await guard(live, outside)).not.toBe("allow")
    let settled = false
    void s.running.then(() => {
      settled = true
    })
    await Bun.sleep(50)
    expect(settled).toBe(false)
    expect(live.interrupts).toBe(0)
    // Background work keeps the session going past this result.
    live.out.push({ type: "system", subtype: "task_started", task_id: "task-1" })
    live.out.push(RESULT)
    expect(await s.running).toMatchObject({
      status: "restart",
      level: "standard",
      sdkSessionId: "sdk-session-1",
    })
  })

  it("walk D18: a raise during a tool restarts when that tool returns, before the turn ends", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push(toolUse("toolu_sleep", "Bash", { command: "sleep 20" }))
    await until(() => s.events().some((e) => e.type === "tool_call"))
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "standard" } }))
    await until(() => applied(s.events()).length === 1)
    await Bun.sleep(30)
    // The tool still runs: nothing is interrupted.
    expect(live.interrupts).toBe(0)
    live.out.push({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_sleep", content: "" }] },
    })
    await until(() => live.interrupts === 1)
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    expect(await s.running).toMatchObject({
      status: "restart",
      level: "standard",
      sdkSessionId: "sdk-session-1",
    })
  })

  it("walk D18: a raise while the session waits on the owner restarts at once", async () => {
    const live = liveQuery()
    const job = sessionJob()
    const outside = path.join(job.home as string, "Documents", "notes.txt")
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push(toolUse("toolu_w", "Write", { file_path: outside, content: "x" }))
    await until(() => s.events().some((e) => e.type === "tool_call"))
    void live.options[0]?.canUseTool?.("Write", { file_path: outside, content: "x" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_w",
      requestId: "c",
    } as never)
    await until(() => s.events().some((e) => e.type === "permission_request"))
    expect(live.interrupts).toBe(0)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "standard" } }))
    await until(() => live.interrupts === 1)
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    expect((await s.running).status).toBe("restart")
  })

  it("a raise whose next result is the final one ends done at the new level, with no turn added (m2)", async () => {
    const live = liveQuery()
    const job = sessionJob()
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "standard" } }))
    await until(() => applied(s.events()).length === 1)
    live.out.push(RESULT)
    const outcome = await s.running
    expect(outcome.status).toBe("done")
    expect(live.pulled).toHaveLength(1)
    expect(s.events().find((e) => e.type === "level_changed")?.payload).toEqual({
      from: "strict",
      to: "standard",
    })
  })

  it("a message the CLI had not read is handed to the restarted run", async () => {
    const live = liveQuery({ holdStart: true })
    const job = sessionJob(
      { level: "standard", profileLevel: "standard" },
      {
        profile: { level: "standard", liaisonTools: false },
      },
    )
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "message", payload: { text: "later" } }))
    await until(() => live.pulled.length === 2)
    s.control.push(cmdLine(2, { type: "set_level", payload: { level: "strict" } }))
    expect((await s.running).status).toBe("restart")
    // Not settled: the restarted process (same job) applies it when written again.
    expect(applied(s.events()).map((a) => a.commandId)).toEqual([CMD(2)])
    const again = liveQuery()
    const restarted = steer(
      {
        ...job,
        session: {
          ...(job.session as JobSession),
          level: "strict",
          levelChange: { from: "standard" },
          resume: { sdkSessionId: "sdk-session-1", after: "level" },
        },
      },
      again,
    )
    await until(() => again.pulled.length === 1)
    again.out.push(INIT)
    restarted.control.push(cmdLine(1, { type: "message", payload: { text: "later" } }))
    await until(() => again.pulled.length === 2)
    expect(again.pulled[1]?.text).toBe("later")
    again.out.push(RESULT)
    await restarted.running
  })

  it("the restarted run emits resumed level, then level_changed after start", async () => {
    const live = liveQuery()
    const job = sessionJob({
      level: "strict",
      levelChange: { from: "standard" },
      resume: { sdkSessionId: "sdk-session-1", after: "level" },
    })
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    expect(live.options[0]?.resume).toBe("sdk-session-1")
    live.out.push(INIT)
    live.out.push(RESULT)
    await s.running
    const types = s
      .events()
      .map((e) => `${e.type}${e.payload.subtype ? `:${e.payload.subtype}` : ""}`)
    expect(types.slice(0, 5)).toEqual([
      "resumed",
      "system:start",
      "system:settings_filtered",
      "level_changed",
      "user_message",
    ])
    expect(s.events().find((e) => e.type === "level_changed")?.payload).toEqual({
      from: "standard",
      to: "strict",
    })
    expect(s.events().find((e) => e.type === "resumed")?.payload).toEqual({ after: "level" })
  })

  it("the start event names the session's working directory (P2's display seam)", async () => {
    const live = liveQuery()
    const job = sessionJob()
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push(RESULT)
    await s.running
    const start = s.events().find((e) => e.type === "system" && e.payload.subtype === "start")
    expect((start?.payload.data as { cwd?: string } | undefined)?.cwd).toBe(live.options[0]?.cwd)
  })
})

/** Calls one of the session's host tools as the CLI would, through the server the run passed. */
async function callHostTool(
  options: Options | undefined,
  name: "mark_done" | "needs_you",
  input: Record<string, unknown>,
): Promise<unknown> {
  const server = options?.mcpServers?.liaison_session as
    | {
        type?: string
        instance?: {
          _registeredTools?: Record<
            string,
            { handler: (a: unknown, e: unknown) => Promise<unknown> }
          >
        }
      }
    | undefined
  const tool = server?.instance?._registeredTools?.[name]
  if (server?.type !== "sdk" || !tool) throw new Error(`the run passed no host tool ${name}`)
  return tool.handler(input, {})
}

const jobDone = (lines: Array<Record<string, unknown>>) => lines.find((l) => l.type === "job_done")

describe("P1-T06 the completion latch (S1, S5, S6, S7, S10)", () => {
  it("S1/S6: a run that called mark_done ends job_done.completion {by:session}", async () => {
    const captured: Captured[] = []
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(sessionJob(), captured, [
        INIT,
        toolUse("toolu_d", "mcp__liaison_session__mark_done", { summary: "Listed them" }),
        (o: Options) => callHostTool(o, "mark_done", { summary: "Listed them" }),
        // More work in the same turn after mark_done: still done (S6).
        assistant("m2", 1, 1, "One more look."),
        RESULT,
      ]),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toEqual({ by: "session", summary: "Listed them" })
    expect(jobDone(lines)?.completion).toEqual({ by: "session", summary: "Listed them" })
    const marked = eventsOf(lines).find(
      (e) => e.type === "system" && e.payload.subtype === "marked_done",
    )
    expect(marked?.payload).toMatchObject({ subtype: "marked_done", text: "Listed them" })
    // S5: the host server rides beside the others, and the guard knows it was passed.
    const o = captured[0]?.options as Options
    expect(Object.keys(o.mcpServers ?? {})).toContain("liaison_session")
  })

  it("S6: needs_you is the run's completion when it was the later call", async () => {
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(
        sessionJob(),
        [],
        [
          INIT,
          (o: Options) => callHostTool(o, "mark_done", { summary: "done?" }),
          (o: Options) => callHostTool(o, "needs_you", { reason: "Which branch?" }),
          RESULT,
        ],
      ),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    expect(jobDone(lines)?.completion).toEqual({ by: "needs_you", reason: "Which branch?" })
  })

  it("S6: an owner message delivered after mark_done clears it: completion absent", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await callHostTool(live.options[0], "mark_done", { summary: "first pass" })
    s.control.push(cmdLine(1, { type: "message", payload: { text: "Also do the tests" } }))
    await until(() => applied(s.events()).length === 1)
    live.out.push({ ...RESULT, result: "Did the tests." })
    const outcome = await s.running
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toBeUndefined()
    expect("completion" in (jobDone(s.lines) ?? {})).toBe(false)
  })

  it("S10: a run whose last text is 'Done!' and no tool call has no completion", async () => {
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(
        sessionJob(),
        [],
        [INIT, assistant("m1", 1, 1, "Done!"), { ...RESULT, result: "Done!" }],
      ),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    expect(outcome.text).toBe("Done!")
    expect(outcome.completion).toBeUndefined()
    expect("completion" in (jobDone(lines) ?? {})).toBe(false)
  })

  it("S7: the mark_done command stops the run with completion by owner", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live, { stopGraceMs: 50 })
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "mark_done", payload: { summary: "Good enough" } }))
    const outcome = await s.running
    expect(outcome.status).toBe("stopped")
    expect(outcome.completion).toEqual({ by: "owner", summary: "Good enough" })
    expect(live.interrupts).toBe(1)
    expect(live.closes).toBeGreaterThan(0)
    expect(applied(s.events())).toEqual([
      { commandId: CMD(1), type: "mark_done", outcome: "applied" },
    ])
    expect(jobDone(s.lines)?.completion).toEqual({ by: "owner", summary: "Good enough" })
  })

  it("S7: mark_done after a stop is noop and the run ends stopped without completion", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live, { stopGraceMs: 5_000 })
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    s.control.push(cmdLine(1, { type: "stop", payload: {} }))
    s.control.push(cmdLine(2, { type: "mark_done", payload: {} }))
    await until(() => applied(s.events()).length === 1)
    expect(applied(s.events())).toEqual([{ commandId: CMD(2), type: "mark_done", outcome: "noop" }])
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    const outcome = await s.running
    expect(outcome.status).toBe("stopped")
    expect(outcome.completion).toBeUndefined()
  })

  it("S4: a token_limit run that called mark_done carries job_done.completion {by: session}", async () => {
    const captured: Captured[] = []
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(sessionJob({}, { hardTokenLimit: 1000 }), captured, [
        INIT,
        toolUse("toolu_d", "mcp__liaison_session__mark_done", { summary: "Shipped it" }),
        (o: Options) => callHostTool(o, "mark_done", { summary: "Shipped it" }),
        assistant("m2", 900, 200, "Wrapping up."),
        RESULT,
      ]),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("token_limit")
    expect(outcome.completion).toEqual({ by: "session", summary: "Shipped it" })
    expect(jobDone(lines)?.completion).toEqual({ by: "session", summary: "Shipped it" })
  })

  it("S57: a token_limit run's completion never carries the prUrl the session reported", async () => {
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(
        sessionJob({}, { hardTokenLimit: 1000 }),
        [],
        [
          INIT,
          (o: Options) =>
            callHostTool(o, "mark_done", {
              summary: "Shipped it",
              prUrl: "https://example.com/not/verified",
            }),
          assistant("m2", 900, 200, "Wrapping up."),
          RESULT,
        ],
      ),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("token_limit")
    expect(outcome.completion).toEqual({ by: "session", summary: "Shipped it" })
    expect(jobDone(lines)?.completion).toEqual({ by: "session", summary: "Shipped it" })
  })

  it("S5: at Strict the guard allows the host tools of the server the run passed", async () => {
    const captured: Captured[] = []
    await runUnattended(runArgs(sessionJob(), captured, [INIT, RESULT]))
    const o = captured[0]?.options as Options
    const hook = o.hooks?.PreToolUse?.[0]?.hooks?.[0] as unknown as (
      input: unknown,
    ) => Promise<{ hookSpecificOutput: { permissionDecision: string } }>
    const decide = async (tool: string) =>
      (
        await hook({
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: { summary: "x" },
          cwd: o.cwd,
          mcp_server: { name: "liaison_session", source: "sdk" },
        })
      ).hookSpecificOutput.permissionDecision
    expect(await decide("mcp__liaison_session__mark_done")).toBe("allow")
    expect(await decide("mcp__liaison_session__needs_you")).toBe("allow")
  })
})

describe("P1-T10 Artifact on the session's CLI (S27, spec §6)", () => {
  type Sys = { subtype: string; text: string; data: Record<string, unknown> }
  async function systemOf(tools: string[] | undefined): Promise<Sys[]> {
    const lines: Array<Record<string, unknown>> = []
    await runUnattended({
      ...runArgs(sessionJob(), [], [tools ? { ...INIT, tools } : INIT, RESULT]),
      emit: (l) => lines.push(l),
    })
    return eventsOf(lines)
      .filter((e) => e.type === "system")
      .map((e) => e.payload as Sys)
  }

  it("S27: a CLI whose tool list lacks Artifact: the start event records it and the next line says Artifact unavailable on CLI <v>", async () => {
    const [start, next] = await systemOf(["Bash", "Read", "mcp__liaison_session__mark_done"])
    expect(start.subtype).toBe("start")
    expect(start.data.artifact).toBe("unavailable")
    expect(next).toEqual({
      subtype: "artifact_unavailable",
      text: `Artifact unavailable on CLI ${start.data.claudeCodeVersion}`,
      data: { claudeCodeVersion: start.data.claudeCodeVersion },
    })
  })

  it("S27: a CLI that lists Artifact: available, and no unavailable line", async () => {
    const sys = await systemOf(["Bash", "Read", "Artifact"])
    expect(sys[0].data.artifact).toBe("available")
    expect(sys.some((e) => e.subtype === "artifact_unavailable")).toBe(false)
  })

  it("S27: an init without a tool list states nothing about Artifact", async () => {
    const sys = await systemOf(undefined)
    expect("artifact" in sys[0].data).toBe(false)
    expect(sys.some((e) => e.subtype === "artifact_unavailable")).toBe(false)
  })
})

describe("P1-T09 the reasoning level (S24)", () => {
  it("S24: options.effort is passed at start", async () => {
    const live = liveQuery()
    const s = steer(sessionJob({ effort: "high" }), live)
    await until(() => live.pulled.length === 1)
    expect(live.options[0]?.effort).toBe("high")
    live.out.push(INIT)
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")

    // No level named: the model's default, no key at all.
    const plain = liveQuery()
    const p = steer(sessionJob(), plain)
    await until(() => plain.pulled.length === 1)
    expect(plain.options[0] && "effort" in plain.options[0]).toBe(false)
    plain.out.push(INIT)
    plain.out.push(RESULT)
    await p.running
  })

  it("S24: the job file's effort is read, and an unknown level refuses the file", () => {
    const job = sessionJob({ effort: "xhigh" })
    const file = path.join(root, `effort-job-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(job))
    expect(readJobFile(file).session?.effort).toBe("xhigh")
    writeFileSync(file, JSON.stringify({ ...job, session: { ...job.session, effort: "ultra" } }))
    expect(() => readJobFile(file)).toThrow()
    writeFileSync(file, JSON.stringify({ ...job, session: { ...job.session, effort: null } }))
    expect(readJobFile(file).session?.effort ?? null).toBeNull()
  })

  it("S24: set_effort calls applyFlagSettings with exactly {effortLevel} and no settings/permissions/sandbox key, and the pinned Options.settings object is deep-equal before and after", async () => {
    const live = liveQuery()
    const s = steer(sessionJob({ effort: "low" }), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    const pinned = live.options[0]?.settings
    const before = structuredClone(pinned)
    s.control.push(cmdLine(1, { type: "set_effort", payload: { effort: "max" } }))
    s.control.push(cmdLine(2, { type: "set_effort", payload: { effort: null } }))
    await until(() => applied(s.events()).length === 2)
    expect(live.flags).toEqual([{ effortLevel: "max" }, { effortLevel: null }])
    for (const flags of live.flags) {
      expect(Object.keys(flags)).toEqual(["effortLevel"])
    }
    expect(live.options[0]?.settings).toBe(pinned)
    expect(live.options[0]?.settings).toEqual(before)
    expect(applied(s.events())).toEqual([
      { commandId: CMD(1), type: "set_effort", outcome: "applied" },
      { commandId: CMD(2), type: "set_effort", outcome: "applied" },
    ])
    // W1-D9: the server appends the one `effort_changed` line; the node adds none.
    const changes = s
      .events()
      .filter((e) => e.type === "system" && e.payload.subtype === "effort_changed")
    expect(changes).toEqual([])
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
  })

  it("S54: stop_task stops that one subagent through the SDK's stopTask and the run goes on", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "stop_task", payload: { taskId: "task_7" } }))
    await until(() => applied(s.events()).length === 1)
    expect(live.stoppedTasks).toEqual(["task_7"])
    expect(applied(s.events())).toEqual([
      { commandId: CMD(1), type: "stop_task", outcome: "applied" },
    ])
    expect(live.interrupts).toBe(0)
    expect(live.closes).toBe(0)
    live.out.push(RESULT)
    expect((await s.running).status).toBe("done")
  })

  it("S24: a set_effort the CLI refuses settles applied with the note that it applies from the next run", async () => {
    const live = liveQuery({ flagsRefused: true })
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_effort", payload: { effort: "high" } }))
    await until(() => applied(s.events()).length === 1)
    expect(applied(s.events())).toEqual([
      {
        commandId: CMD(1),
        type: "set_effort",
        outcome: "applied",
        error: "applies from the next run",
      },
    ])
    live.out.push(RESULT)
    await s.running
  })

  it("S24: a level restart after set_effort starts with the new effort", async () => {
    const live = liveQuery()
    const s = steer(
      sessionJob(
        { level: "standard", profileLevel: "standard", effort: "low" },
        { profile: { level: "standard", liaisonTools: false } },
      ),
      live,
    )
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_effort", payload: { effort: "max" } }))
    await until(() => applied(s.events()).length === 1)
    s.control.push(cmdLine(2, { type: "set_level", payload: { level: "strict" } }))
    const outcome = await s.running
    // The restart's job_done names the effort the next process starts with
    // (the job document still holds the one this run started with).
    expect(outcome).toMatchObject({ status: "restart", level: "strict", effort: "max" })
    expect(s.lines.at(-1)).toMatchObject({ type: "job_done", status: "restart", effort: "max" })
  })
})

describe("P1-T21 owner sessions in the real folder (S48-S50, owner D13, D26)", () => {
  it("S50: an in-place folder with settings.local.json starts with settingSources lacking local", async () => {
    const job = sessionJob({ level: "standard", profileLevel: "standard", source: "dispatch" })
    const home = job.home as string
    const repo = ownerRepo(path.join(home, "code"))
    mkdirSync(path.join(repo, ".claude"), { recursive: true })
    const local = JSON.stringify({ permissions: { allow: ["Bash(*)"] } })
    writeFileSync(path.join(repo, ".claude", "settings.local.json"), local)
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const captured: Captured[] = []
    const outcome = await runUnattended(runArgs(job, captured, [INIT, RESULT]))
    expect(outcome.status).toBe("done")
    const o = captured[0]?.options as Options
    expect(o.cwd).toBe(repo)
    expect(o.settingSources).toEqual(["user", "project"])
    // Never written, never moved: the owner's file as it was.
    expect(readFileSync(path.join(repo, ".claude", "settings.local.json"), "utf8")).toBe(local)
    expect(existsSync(path.join(job.nodeRoot, "worktrees"))).toBe(false)
  })

  it("S49: an owner session runs with the picker-visible entrypoint and its projects linked; an isolated one keeps the SDK's", async () => {
    const owner = sessionJob({ level: "standard", profileLevel: "standard" })
    const captured: Captured[] = []
    await runUnattended(runArgs(owner, captured))
    expect(captured[0]?.options.env?.CLAUDE_CODE_ENTRYPOINT).toBe("liaison-node")
    const mirror = captured[0]?.options.env?.CLAUDE_CONFIG_DIR as string
    expect(lstatSync(path.join(mirror, "projects")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(mirror, "projects"))).toBe(
      path.join(owner.home as string, ".claude", "projects"),
    )

    const isolated = sessionJob({ source: "agent_tag", configKind: "isolated" })
    const capturedIsolated: Captured[] = []
    await runUnattended(runArgs(isolated, capturedIsolated))
    expect(capturedIsolated[0]?.options.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  it("S50: a session folder at or inside the run's shell home is never emptied, at the start or the end (F4)", async () => {
    for (const inner of [false, true]) {
      const job = sessionJob({ level: "standard", profileLevel: "standard", source: "dispatch" })
      const dataDir = path.join(job.home as string, "data")
      const shellHome = jobShellHome(dataDir, job.jobId)
      const repo = inner
        ? ownerRepo(shellHome, "my-repo")
        : ownerRepo(path.dirname(shellHome), path.basename(shellHome))
      writeFileSync(path.join(repo, "owner-notes.txt"), "uncommitted\n")
      job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
      const captured: Captured[] = []
      const outcome = await runUnattended(runArgs(job, captured, [INIT, RESULT], { dataDir }))
      expect({ inner, notes: readFileSync(path.join(repo, "owner-notes.txt"), "utf8") }).toEqual({
        inner,
        notes: "uncommitted\n",
      })
      expect({ inner, ran: captured.length, status: outcome.status }).toEqual({
        inner,
        ran: 0,
        status: "error",
      })
    }
  })

  it("S50: the push-hook line is in the append only where the session's git runs with it", async () => {
    const hookLine = "the repository's own git hooks do not run"
    const inRepo = sessionJob({ level: "standard", profileLevel: "standard", source: "dispatch" })
    const repo = ownerRepo(path.join(inRepo.home as string, "code"))
    inRepo.session = { ...(inRepo.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const a: Captured[] = []
    await runUnattended(runArgs(inRepo, a, [INIT, RESULT]))
    expect(a[0]?.options.cwd).toBe(repo)
    expect(appendOf(a)).toContain(hookLine)
    expect(a[0]?.options.env?.GIT_CONFIG_KEY_0).toBe("core.hooksPath")

    const plain = sessionJob({ level: "standard", profileLevel: "standard", source: "dispatch" })
    const folder = path.join(plain.home as string, "notes")
    mkdirSync(folder, { recursive: true })
    plain.session = { ...(plain.session as JobSession), folderPath: folder, folderName: "notes" }
    const b: Captured[] = []
    await runUnattended(runArgs(plain, b, [INIT, RESULT]))
    expect(b[0]?.options.cwd).toBe(folder)
    expect(appendOf(b)).not.toContain(hookLine)
  })

  it("S50: an in-place session below Open is told branch switches are refused and that the node made its branch (F1, D40 with the G4 flag on)", async () => {
    const line =
      "You work in the owner's own folder: git commands that switch its branch or rewrite its files (checkout or switch of a branch, rebase, merge, pull, cherry-pick, revert, am, bisect) are refused at this level and need the owner to switch this session to Open. Liaison made the branch liaison/9f8e7d6c-my-repo for this session and checked it out: commit on it, then git push origin liaison/9f8e7d6c-my-repo."
    const run = async (level: "standard" | "open") => {
      const job = sessionJob({ level, profileLevel: level, source: "dispatch" })
      const repo = ownerRepo(path.join(job.home as string, "code"))
      job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
      const captured: Captured[] = []
      await runUnattended(runArgs(job, captured, [INIT, RESULT]))
      expect(captured[0]?.options.cwd).toBe(repo)
      return appendOf(captured)
    }
    expect(await run("standard")).toContain(line)
    expect(await run("open")).not.toContain(line)
    const isolated = sessionJob({ source: "agent_tag", configKind: "isolated" })
    const captured: Captured[] = []
    await runUnattended(runArgs(isolated, captured))
    expect(appendOf(captured)).not.toContain(line)
  })
})

describe("P1-T22 one driver at a time (S51, owner D13, D28)", () => {
  const SDK = "41173e76-dc0a-4f5f-8c7a-fde5d5329047"
  /** The CLI's init for the resumed session: the same id. */
  const SDK_INIT = { ...INIT, session_id: SDK }

  /** An in-place owner session at Standard resuming SDK by a message. */
  function drivenJob(resume: Record<string, unknown>) {
    const job = sessionJob(
      {
        level: "standard",
        profileLevel: "standard",
        source: "dispatch",
        resume: { sdkSessionId: SDK, after: "message", commandId: CMD(7), ...resume } as never,
      },
      { prompt: "Carry on." },
    )
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    return { job, repo, config: path.join(job.home as string, ".claude") }
  }

  /** VS Code holds SDK: its registry entry, its live process. */
  const vscodeProbe = (): DriverProbe => ({
    mtimeMs: () => null,
    registry: () => [{ pid: 4242, sessionId: SDK, entrypoint: "claude-vscode" }],
    processes: () => [{ pid: 4242, args: "/x/native-binary/claude --output-format stream-json" }],
    platform: "darwin",
  })

  it("S51: a message without confirmDrivenElsewhere to a driven session starts no run and settles driven_elsewhere; with it, the run starts", async () => {
    const { job } = drivenJob({})
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        emit: (l) => lines.push(l),
        driverProbe: vscodeProbe(),
      }),
    )
    expect(captured).toHaveLength(0)
    // Ended without a completion: the session shows Needs you, with the reason.
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toBeUndefined()
    expect(outcome.text).toContain("VS Code")
    const events = eventsOf(lines)
    expect(
      events.filter((e) => e.type === "system").map((e) => [e.payload.subtype, e.payload.data]),
    ).toEqual([["driver", { elsewhere: true, via: "vscode" }]])
    expect(applied(events)).toEqual([
      { commandId: CMD(7), type: "message", outcome: "failed", error: "driven_elsewhere" },
    ])

    const confirmed = drivenJob({ confirmDrivenElsewhere: true })
    const confirmedCaptured: Captured[] = []
    const ran = await runUnattended(
      runArgs(confirmed.job, confirmedCaptured, [SDK_INIT, RESULT], { driverProbe: vscodeProbe() }),
    )
    expect(confirmedCaptured).toHaveLength(1)
    expect(ran.status).toBe("done")
  })

  it("D33 (batch-4 F3): an orphaned claude holding the session refuses the resume and names its pid and the CLI session id", async () => {
    const { job } = drivenJob({})
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        emit: (l) => lines.push(l),
        driverProbe: {
          mtimeMs: () => null,
          registry: () => [{ pid: 5093, sessionId: SDK, entrypoint: "claude-vscode" }],
          processes: () => [
            { pid: 5093, ppid: 1, args: `/x/native-binary/claude --resume=${SDK}` },
          ],
          platform: "darwin",
        },
      }),
    )
    expect(captured).toHaveLength(0)
    expect(outcome.completion).toBeUndefined()
    expect(outcome.text).toContain("orphaned Claude process (pid 5093)")
    const events = eventsOf(lines)
    expect(
      events.filter((e) => e.type === "system").map((e) => [e.payload.subtype, e.payload.data]),
    ).toEqual([["driver", { elsewhere: true, via: null, orphanPid: 5093, cliSessionId: SDK }]])
  })

  it("W1-D3: the node's own earlier claude, orphaned with no --resume and registered in the session's config dir, refuses the resume as an orphan", async () => {
    const { job } = drivenJob({})
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        emit: (l) => lines.push(l),
        driverProbe: {
          // The transcript names the node as its last writer.
          mtimeMs: () => Date.now() - 30_000,
          lastEntrypoint: () => "liaison-node",
          // Only the node's own per-session config dir knows it.
          registry: (dir) =>
            dir.includes(`${path.sep}session-config${path.sep}`)
              ? [{ pid: 20847, sessionId: SDK, entrypoint: "sdk-ts" }]
              : [],
          processes: () => [
            {
              pid: 20847,
              ppid: 1,
              args: "/tmp/claude-501/x/claude --output-format stream-json --verbose",
            },
          ],
          platform: "darwin",
        },
      }),
    )
    expect(captured).toHaveLength(0)
    expect(outcome.completion).toBeUndefined()
    expect(outcome.text).toContain("orphaned Claude process (pid 20847)")
    const events = eventsOf(lines)
    expect(
      events.filter((e) => e.type === "system").map((e) => [e.payload.subtype, e.payload.data]),
    ).toEqual([["driver", { elsewhere: true, via: null, orphanPid: 20847, cliSessionId: SDK }]])
  })

  it("W1-D3: each claude the run starts is handed to the runner's watchdog once", async () => {
    const { job } = drivenJob({ confirmDrivenElsewhere: true })
    const looks: Array<[string, string]> = []
    const captured: Captured[] = []
    await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        driverProbe: {
          mtimeMs: () => null,
          registry: () => [],
          processes: () => [],
          platform: "darwin",
        },
        claudeGuard: (dir, id, watched) => {
          looks.push([dir, id])
          watched.add(31337)
          return [31337]
        },
      }),
    )
    expect(captured).toHaveLength(1)
    expect(looks).toHaveLength(1)
    expect(looks[0]?.[0]).toContain(`${path.sep}session-config${path.sep}`)
    expect(looks[0]?.[1]).toBe(SDK)
  })

  it("S51: before a resume, the node's own last write is not a driver; a later foreign write is", async () => {
    const { job, repo, config } = drivenJob({ confirmDrivenElsewhere: true })
    const dir = path.join(config, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"))
    mkdirSync(dir, { recursive: true })
    const jsonl = path.join(dir, `${SDK}.jsonl`)
    writeFileSync(jsonl, "{}\n")
    const at = (ms: number) => utimesSync(jsonl, ms / 1000, ms / 1000)
    const probe: DriverProbe = { ...systemDriverProbe(), processes: () => [], platform: "darwin" }
    // The node's own (confirmed) run wrote it last, 20 s ago.
    at(Date.now() - 20_000)
    const first: Captured[] = []
    await runUnattended(runArgs(job, first, [SDK_INIT, RESULT], { driverProbe: probe }))
    expect(first).toHaveLength(1)

    // Resumed again, unconfirmed: nobody else wrote since, so it runs.
    const again = {
      ...job,
      session: {
        ...(job.session as JobSession),
        resume: { sdkSessionId: SDK, after: "level" as const },
      },
    }
    const second: Captured[] = []
    await runUnattended(runArgs(again, second, [SDK_INIT, RESULT], { driverProbe: probe }))
    expect(second).toHaveLength(1)

    // VS Code wrote it 3 s ago: driven elsewhere, no run.
    at(Date.now() - 3_000)
    const third: Captured[] = []
    const lines: Array<Record<string, unknown>> = []
    await runUnattended(
      runArgs(again, third, [SDK_INIT, RESULT], { driverProbe: probe, emit: (l) => lines.push(l) }),
    )
    expect(third).toHaveLength(0)
    expect(
      eventsOf(lines)
        .filter((e) => e.type === "system")
        .map((e) => e.payload.data),
    ).toEqual([{ elsewhere: true, via: null }])
  })

  it("S51: a crash or offline resume within 60 s of the node's own last write starts (F3)", async () => {
    for (const after of ["crash", "offline"] as const) {
      const { job, repo, config } = drivenJob({})
      job.session = {
        ...(job.session as JobSession),
        resume: { sdkSessionId: SDK, after },
      }
      const dir = path.join(config, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"))
      mkdirSync(dir, { recursive: true })
      const jsonl = path.join(dir, `${SDK}.jsonl`)
      // The node's CLI was writing when the sidecar died: finish never ran, so
      // no own-write record exists; the transcript itself says who wrote last.
      writeFileSync(
        jsonl,
        `${JSON.stringify({ type: "assistant", entrypoint: "liaison-node", sessionId: SDK })}\n{"type":"last-prompt"}\n`,
      )
      utimesSync(jsonl, (Date.now() - 5_000) / 1000, (Date.now() - 5_000) / 1000)
      // The run that wrote it recorded it as this server's at its init (D49 F6, B2-3).
      const own = sessionConfigDir(
        (job.session as JobSession).id,
        path.join(job.home as string, "data"),
      )
      mkdirSync(own, { recursive: true })
      recordOwnerRun(own, job.server, SDK)
      const probe: DriverProbe = { ...systemDriverProbe(), processes: () => [], platform: "darwin" }
      const captured: Captured[] = []
      const lines: Array<Record<string, unknown>> = []
      await runUnattended(
        runArgs(job, captured, [SDK_INIT, RESULT], {
          driverProbe: probe,
          emit: (l) => lines.push(l),
        }),
      )
      expect({ after, runs: captured.length }).toEqual({ after, runs: 1 })
      expect(
        eventsOf(lines).filter((e) => e.type === "system" && e.payload.subtype === "driver"),
      ).toEqual([])
    }
  })
})

describe("P2-T07 autonomy and the finish step at run start (S30, S31, S57, A26, A27, A30, A32)", () => {
  const AUTONOMY_BLOCK =
    "You run autonomously: never ask the person a question. Decide with sensible, reversible defaults and record your assumptions. Call mcp__liaison_session__needs_you only when you are truly blocked, with the reason. Call mcp__liaison_session__mark_done with a one-line summary when the task is finished."
  const FAN_OUT =
    "Workflow, Monitor, SendMessage and TaskStop are not available here: run subagents with Agent calls in one message, at most 4 at once."
  const W1_IN_PLACE =
    "You work in the owner's own folder: git commands that switch its branch or rewrite its files (checkout or switch of a branch, rebase, merge, pull, cherry-pick, revert, am, bisect) are refused at this level and need the owner to switch this session to Open. To push your commits, run git branch <name> (it does not switch), then git push origin <name>."
  const ATELIER_LINE =
    "For a code change, drive it with the Atelier flow (/atelier:atelier <task>) at the depth it warrants."

  /** A Standard dispatch session in place in a fresh repo of the owner's. */
  const repoJob = (session: Partial<JobSession> = {}) => {
    const job = sessionJob({
      level: "standard",
      profileLevel: "standard",
      source: "dispatch",
      ...session,
    })
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    return job
  }
  const appendFor = (
    session: Partial<JobSession>,
    workspace: Parameters<typeof sessionAppend>[4] = {},
  ) => {
    const job = sessionJob({ level: "standard", profileLevel: "standard", ...session })
    return sessionAppend(job, job.session as JobSession, "Ada", null, workspace)
  }

  it("S31: an autonomous run's options disallow AskUserQuestion, EnterPlanMode and ExitPlanMode; a guided run's have no disallowedTools", async () => {
    const auto: Captured[] = []
    await runUnattended(runArgs(sessionJob({ autonomy: "autonomous" }), auto))
    expect(auto[0]?.options.disallowedTools).toEqual([
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
    ])
    expect(auto[0]?.options.env?.ATELIER_AUTONOMY).toBe("autonomous")
    expect(auto[0]?.options.env?.ATELIER_HOST).toBe("liaison")
    // No repository: no finish step.
    expect(auto[0]?.options.env?.ATELIER_HOST_FINISH).toBeUndefined()
    for (const session of [{ autonomy: "guided" as const }, {}]) {
      const guided: Captured[] = []
      await runUnattended(runArgs(sessionJob(session), guided))
      expect(guided[0]?.options.disallowedTools).toBeUndefined()
      expect(guided[0]?.options.env?.ATELIER_AUTONOMY).toBeUndefined()
    }
  })

  it("S31: the autonomous system-prompt block is present only when autonomous", async () => {
    const auto = appendFor({ autonomy: "autonomous" }).split("\n")
    expect(auto).toContain(AUTONOMY_BLOCK)
    expect(auto).toContain(FAN_OUT)
    // After the host-tool lines, before the level's lines.
    expect(auto.indexOf(AUTONOMY_BLOCK)).toBe(5)
    for (const autonomy of ["guided", undefined] as const) {
      const guided = appendFor(autonomy ? { autonomy } : {})
      expect(guided).not.toContain("You run autonomously")
      expect(guided).not.toContain(FAN_OUT)
    }
    // Through the run too.
    const captured: Captured[] = []
    await runUnattended(runArgs(sessionJob({ autonomy: "autonomous" }), captured))
    expect(appendOf(captured).split("\n")).toContain(AUTONOMY_BLOCK)
  })

  it("S57: a repo session's append carries the pr finishing block by default, the commit block for commit, and only the leave-uncommitted line for none", async () => {
    const captured: Captured[] = []
    await runUnattended(runArgs(repoJob(), captured, [INIT, RESULT]))
    const pr = appendOf(captured)
    expect(pr).toContain("When the work is finished: run the repository's own checks")
    expect(pr).toContain("open a pull request whose body is your summary")
    expect(pr).toContain("prUrl = the pull request's URL")
    expect(pr).toContain("call needs_you with the error and code push_failed")
    expect(pr).toContain("never mark_done without the pull request")
    expect(captured[0]?.options.env?.ATELIER_HOST_FINISH).toBe("pr")
    expect(captured[0]?.options.env?.ATELIER_AUTONOMY).toBe("guided")

    const commit = appendFor({ finishWith: "commit" }, { repo: true })
    expect(commit).toContain("commit on a branch of your own")
    expect(commit).toContain("do not push")
    expect(commit).not.toContain("pull request")
    const none = appendFor({ finishWith: "none" }, { repo: true })
    expect(none).toContain("leave the changes uncommitted, then call mark_done")
    expect(none).not.toContain("commit on a branch")
    expect(none).not.toContain("pull request")
    // Not a repository: no finish step at all, whatever finishWith says.
    for (const finishWith of ["pr", "commit", "none"] as const) {
      const off = appendFor({ finishWith })
      expect({ finishWith, block: off.includes("When the work is finished") }).toEqual({
        finishWith,
        block: false,
      })
    }
  })

  it("S57: the pr finishing block names the .atelier exclusion, the protected-branch rule and the title/body publication rule", () => {
    const pr = appendFor({}, { repo: true })
    expect(pr).toContain("never commit .atelier/")
    expect(pr).toContain(
      "never the default branch or a protected one (main, master, trunk, develop, production)",
    )
    expect(pr).toContain("push that branch, never the default branch")
    expect(pr).toContain(
      "the title and body follow the same rules as the code: no absolute or home-relative local paths, no session ids, no names the repository's checks forbid",
    )
  })

  it("D40: with a node-made branch the in-place line and the branch sentence name it and never say git switch -c; without one they are W1's git branch lines, byte for byte", () => {
    const made = "liaison/9f8e7d6c-my-repo"
    const on = levelLines(levelRow("standard"), { inPlace: true, nodeBranch: made })
    const inPlaceOn = on.find((l) => l.startsWith("You work in the owner's own folder"))
    expect(inPlaceOn).toContain(`Liaison made the branch ${made} for this session`)
    expect(inPlaceOn).not.toContain("git switch -c")
    expect(inPlaceOn).not.toContain("git branch <name>")
    const off = levelLines(levelRow("standard"), { inPlace: true })
    expect(off.find((l) => l.startsWith("You work in the owner's own folder"))).toBe(W1_IN_PLACE)
    const appendOn = appendFor({}, { repo: true, inPlace: true, nodeBranch: made })
    expect(appendOn).toContain(inPlaceOn as string)
    expect(appendOn).toContain(
      `Liaison made the branch ${made} for this session: commit on it, never on the default branch.`,
    )
    expect(appendOn).not.toContain("git switch -c")
    const appendOff = appendFor({}, { repo: true, inPlace: true })
    expect(appendOff.split("\n")).toContain(W1_IN_PLACE)
    expect(appendOff).not.toContain("git switch -c")
    expect(appendOff).toContain(
      "If you are on the default or a protected branch, run git branch <name>, which does not switch, then git push origin <name>.",
    )
    // At Open the session switches freely: no branch sentence.
    const open = sessionAppend(
      sessionJob({ level: "open", profileLevel: "open" }),
      { ...(sessionJob({ level: "open", profileLevel: "open" }).session as JobSession) },
      "Ada",
      null,
      { repo: true, inPlace: true },
    )
    expect(open).not.toContain("If you are on the default or a protected branch")
  })

  it("A32: the Atelier line is in the append only when Atelier is loaded", () => {
    expect(appendFor({}, { repo: true, atelier: true }).split("\n")).toContain(ATELIER_LINE)
    expect(appendFor({}, { repo: true })).not.toContain("Atelier")
  })

  it("D40: an in-place run below Open on main starts on the node-made branch and its start event reports it; finishWith none leaves main", async () => {
    const start = async (job: ReturnType<typeof repoJob>) => {
      const lines: Array<Record<string, unknown>> = []
      const captured: Captured[] = []
      await runUnattended({ ...runArgs(job, captured, [INIT, RESULT]), emit: (l) => lines.push(l) })
      const repo = (job.session as JobSession).folderPath as string
      const head = spawnSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim()
      const ev = eventsOf(lines).find((e) => e.type === "system" && e.payload.subtype === "start")
      const data = ev?.payload.data as Record<string, unknown> | undefined
      return {
        head,
        branch: data?.branch,
        nodeBranch: data?.nodeBranch,
        append: appendOf(captured),
      }
    }
    const made = "liaison/9f8e7d6c-my-repo"
    const pr = await start(repoJob())
    expect({ head: pr.head, branch: pr.branch, nodeBranch: pr.nodeBranch }).toEqual({
      head: made,
      branch: made,
      nodeBranch: { name: made, from: "main" },
    })
    expect(pr.append).toContain(`Liaison made the branch ${made} for this session`)
    const none = await start(repoJob({ finishWith: "none" }))
    expect({ head: none.head, branch: none.branch, nodeBranch: none.nodeBranch }).toEqual({
      head: "main",
      branch: "main",
      nodeBranch: undefined,
    })
    expect(none.append).not.toContain("Liaison made the branch")
  })

  it("D56 F1: a resume whose switch back to the session's branch git refuses ends Needs you with git's words, never worktree_failed, and starts no session", async () => {
    const job = repoJob()
    const repo = (job.session as JobSession).folderPath as string
    const made = "liaison/9f8e7d6c-my-repo"
    await runUnattended(runArgs(job, [], [INIT, RESULT]))
    writeFileSync(path.join(repo, "README.md"), "# session work\n")
    git(repo, "commit", "-q", "-am", "session work")
    git(repo, "switch", "-q", "main")
    writeFileSync(path.join(repo, "README.md"), "# the owner's edit\n")
    const branches = () =>
      spawnSync("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        encoding: "utf8",
      }).stdout
    const before = branches()
    const captured: Captured[] = []
    const out = await runUnattended(runArgs(job, captured, [INIT, RESULT]))
    expect(out.status).toBe("done")
    expect(out.code).toBeUndefined()
    expect(out.completion?.by).toBe("needs_you")
    expect(out.completion?.reason).toContain(`the session's branch ${made}`)
    expect(out.completion?.reason).toContain("would be overwritten")
    // The computer's words, not the model's: the web says so (final recheck).
    expect(out.completion?.reasonCode).toBe("workspace_blocked")
    expect(captured).toEqual([])
    expect(branches()).toBe(before)
    expect(
      spawnSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("main")
  })

  it("S30: the start event reports autonomy and finishWith", async () => {
    const cases = [
      {
        job: repoJob({ autonomy: "autonomous", finishWith: "commit" }),
        autonomy: "autonomous",
        finishWith: "commit",
      },
      { job: repoJob(), autonomy: "guided", finishWith: "pr" },
      {
        job: sessionJob({ autonomy: "autonomous", finishWith: "pr" }),
        autonomy: "autonomous",
        finishWith: null,
      },
    ] as const
    for (const c of cases) {
      const lines: Array<Record<string, unknown>> = []
      await runUnattended({ ...runArgs(c.job, [], [INIT, RESULT]), emit: (l) => lines.push(l) })
      const start = eventsOf(lines).find(
        (e) => e.type === "system" && e.payload.subtype === "start",
      )
      const data = start?.payload.data as Record<string, unknown> | undefined
      expect({ autonomy: data?.autonomy, finishWith: data?.finishWith }).toEqual({
        autonomy: c.autonomy,
        finishWith: c.finishWith,
      })
    }
  })
})

describe("P2-T08 the session reads its Atelier state (S35)", () => {
  /** A tool result for `id`, as the CLI sends it back. */
  const toolResult = (id: string) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "written" }] },
  })

  it("S35: a Write to .atelier/pipelines/x/state.json emits one atelier event after its tool_result; the same content again emits nothing", async () => {
    const job = sessionJob({ source: "dispatch" })
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    const file = path.join(repo, ".atelier", "pipelines", "x", "state.json")
    const content = JSON.stringify({
      id: "x",
      task: "Add an export",
      rung: "R1",
      phase: "execute",
      plan: ["frame", "brainstorm", "spec", "review", "execute", "validate", "handoff"],
      done: ["frame", "brainstorm", "spec", "review"],
      status: "running",
      awaiting: null,
      // The init's SDK session id: this session's pipeline.
      sourceSessionId: INIT.session_id,
      failure: null,
      updatedAt: "2026-10-16T08:00:00Z",
    })
    const write = () => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(
        job,
        [],
        [
          INIT,
          toolUse("toolu_w1", "Write", { file_path: file, content }),
          write,
          toolResult("toolu_w1"),
          toolUse("toolu_w2", "Write", { file_path: file, content }),
          write,
          toolResult("toolu_w2"),
          RESULT,
        ],
      ),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    const events = eventsOf(lines)
    const atelier = events.filter((e) => e.type === "system" && e.payload.subtype === "atelier")
    expect(atelier).toHaveLength(1)
    expect(atelier[0]?.payload.data).toEqual({
      id: "x",
      rung: "R1",
      phase: "execute",
      plan: ["frame", "brainstorm", "spec", "review", "execute", "validate", "handoff"],
      done: ["frame", "brainstorm", "spec", "review"],
      status: "running",
      awaiting: null,
    })
    const at = events.indexOf(atelier[0] as (typeof events)[number])
    const firstResult = events.findIndex(
      (e) => e.type === "tool_result" && e.payload.id === "toolu_w1",
    )
    const secondCall = events.findIndex(
      (e) => e.type === "tool_call" && e.payload.id === "toolu_w2",
    )
    expect(firstResult).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(firstResult)
    expect(at).toBeLessThan(secondCall)
  })
})

describe("P2-T09 the turn-end decision and auto-continue (S32, S36, S57, A36, A37)", () => {
  /** A tool result for `id`, as the CLI sends it back. */
  const toolResult = (id: string) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "edited" }] },
  })
  /** An Edit the session made and its successful result. */
  const edit = (n: number) => [
    toolUse(`toolu_e${n}`, "Edit", { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" }),
    toolResult(`toolu_e${n}`),
  ]
  const continues = (events: Array<{ type: string; payload: Record<string, unknown> }>) =>
    events
      .filter((e) => e.type === "system" && e.payload.subtype === "auto_continue")
      .map((e) => e.payload.data as { n: number; total: number })
  const autonomous = (session: Partial<JobSession> = {}) =>
    sessionJob({ autonomy: "autonomous", ...session })
  /** A Standard dispatch session in place in a fresh repo of the owner's. */
  const repoJob = (session: Partial<JobSession> = {}) => {
    const job = sessionJob({
      level: "standard",
      profileLevel: "standard",
      source: "dispatch",
      ...session,
    })
    const repo = ownerRepo(path.join(job.home as string, "code"))
    job.session = { ...(job.session as JobSession), folderPath: repo, folderName: "my-repo" }
    return job
  }

  it("S32: six empty turn ends in an autonomous session → needs_you stuck_after_5_continues with five auto_continue events", async () => {
    const live = liveQuery()
    const s = steer(autonomous(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    for (let turn = 1; turn <= 5; turn++) {
      live.out.push({ ...RESULT, result: `turn ${turn}` })
      // The continue is pulled and delivered like any input: it never resets the counter.
      await until(() => live.pulled.length === turn + 1)
    }
    live.out.push({ ...RESULT, result: "turn 6" })
    const outcome = await s.running
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toMatchObject({
      by: "needs_you",
      reasonCode: "stuck_after_5_continues",
    })
    expect(continues(s.events())).toEqual([1, 2, 3, 4, 5].map((n) => ({ n, total: n })))
    expect(live.pulled.slice(1).map((p) => p.text)).toEqual(Array(5).fill(AUTO_CONTINUE_TEXT))
    // A continue is not the owner's: no user_message for it.
    expect(
      s.events().filter((e) => e.type === "user_message" && e.payload.text === AUTO_CONTINUE_TEXT),
    ).toHaveLength(0)
  })

  it("S32: eight turn ends where every second one follows an Edit → the run does not end on the counter", async () => {
    const script: unknown[] = [INIT]
    for (let turn = 1; turn <= 8; turn++) {
      if (turn % 2 === 0) script.push(...edit(turn))
      script.push({ ...RESULT, result: `turn ${turn}` })
    }
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(autonomous(), [], script),
      emit: (l) => lines.push(l),
    })
    const n = continues(eventsOf(lines))
    expect(n).toHaveLength(8)
    expect(Math.max(...n.map((c) => c.n))).toBe(2)
    expect(outcome.completion).toBeUndefined()
  })

  it("S32: six turn ends each after a FAILED Edit → needs_you stuck_after_5_continues (a failed edit is no progress)", async () => {
    const script: unknown[] = [INIT]
    for (let turn = 1; turn <= 6; turn++) {
      const id = `toolu_f${turn}`
      script.push(
        toolUse(id, "Edit", { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" }),
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "tool_result", tool_use_id: id, content: "no match", is_error: true },
            ],
          },
        },
        { ...RESULT, result: `turn ${turn}` },
      )
    }
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(autonomous(), [], script),
      emit: (l) => lines.push(l),
    })
    expect(continues(eventsOf(lines))).toEqual([1, 2, 3, 4, 5].map((n) => ({ n, total: n })))
    expect(outcome.completion).toMatchObject({
      by: "needs_you",
      reasonCode: "stuck_after_5_continues",
    })
  })

  it("S32: 31 progressing turn ends (an Edit before each) → needs_you auto_continue_cap after 30 auto_continue events", async () => {
    const script: unknown[] = [INIT]
    for (let turn = 1; turn <= 31; turn++) script.push(...edit(turn), RESULT)
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(autonomous(), [], script),
      emit: (l) => lines.push(l),
    })
    const n = continues(eventsOf(lines))
    expect(n).toHaveLength(30)
    expect(n.every((c) => c.n === 1)).toBe(true)
    expect(n.at(-1)).toEqual({ n: 1, total: 30 })
    expect(outcome.completion).toMatchObject({ by: "needs_you", reasonCode: "auto_continue_cap" })
  })

  it("S32: a state.json phase advance resets the counter", async () => {
    const job = autonomous({ source: "dispatch" })
    // A plain folder (no git: no status fingerprint to reset the counter).
    const folder = path.join(job.home as string, "plain")
    mkdirSync(path.join(folder, ".atelier", "pipelines", "x"), { recursive: true })
    job.session = { ...(job.session as JobSession), folderPath: folder, folderName: "plain" }
    job.sharedFolders = [{ name: "plain", path: folder, kind: "root" }]
    const writeState = (phase: string) => () =>
      writeFileSync(
        path.join(folder, ".atelier", "pipelines", "x", "state.json"),
        JSON.stringify({
          id: "x",
          rung: "R1",
          phase,
          plan: ["frame", "execute", "handoff"],
          done: ["frame"],
          status: "running",
          awaiting: null,
          sourceSessionId: INIT.session_id,
          updatedAt: "2026-10-16T08:00:00Z",
        }),
      )
    const script: unknown[] = [INIT, writeState("execute")]
    for (let turn = 1; turn <= 5; turn++) script.push(RESULT)
    // The sixth turn end would be the stuck one, but the phase advanced.
    script.push(writeState("validate"), RESULT)
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({ ...runArgs(job, [], script), emit: (l) => lines.push(l) })
    const n = continues(eventsOf(lines))
    expect(n.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 1])
    expect(outcome.completion).toBeUndefined()
  })

  it("S32: an owner message delivered with a commandId resets it", async () => {
    const live = liveQuery()
    const s = steer(autonomous(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    for (let turn = 1; turn <= 5; turn++) {
      live.out.push(RESULT)
      await until(() => live.pulled.length === turn + 1)
    }
    s.control.push(cmdLine(1, { type: "message", payload: { text: "Try the other file" } }))
    await until(() => applied(s.events()).length === 1)
    live.out.push(RESULT)
    await until(() => continues(s.events()).length === 6)
    await callHostTool(live.options[0], "mark_done", { summary: "Done" })
    live.out.push(RESULT)
    const outcome = await s.running
    expect(continues(s.events()).map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 1])
    expect(outcome.completion).toEqual({ by: "session", summary: "Done" })
  })

  it("S32: a guided session never auto-continues", async () => {
    const lines: Array<Record<string, unknown>> = []
    const outcome = await runUnattended({
      ...runArgs(sessionJob(), [], [INIT, RESULT, RESULT]),
      emit: (l) => lines.push(l),
    })
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toBeUndefined()
    expect(continues(eventsOf(lines))).toEqual([])
  })

  it("S32: Stop during an auto_continue turn ends stopped and pushes no further continue", async () => {
    const live = liveQuery()
    const s = steer(autonomous(), live, { stopGraceMs: 200 })
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    live.out.push(RESULT)
    // The continue turn runs.
    await until(() => live.pulled.length === 2)
    live.out.push(assistant("m2", 1, 1, "still going"))
    s.control.push(cmdLine(1, { type: "stop", payload: {} }))
    await until(() => live.interrupts === 1)
    live.out.push(RESULT)
    const outcome = await s.running
    expect(outcome.status).toBe("stopped")
    expect(outcome.completion).toBeUndefined()
    expect(continues(s.events())).toEqual([{ n: 1, total: 1 }])
    expect(live.pulled).toHaveLength(2)
  })

  it("S57: mark_done with finish pr and pushed:false → needs_you pr_missing", async () => {
    const outcome = await runUnattended(
      runArgs(
        repoJob(),
        [],
        [INIT, (o: Options) => callHostTool(o, "mark_done", { summary: "Fixed" }), RESULT],
      ),
    )
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toMatchObject({ by: "needs_you", reasonCode: "pr_missing" })
  }, 30_000)

  it("S32 (D31): the turn end's git status and PR check never run the owner repo's fsmonitor", async () => {
    const job = repoJob({ autonomy: "autonomous" })
    const repo = (job.session as JobSession).folderPath as string
    const marker = path.join(job.home as string, "fsmonitor-ran")
    const monitor = path.join(job.home as string, "fsmonitor.sh")
    writeFileSync(monitor, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`)
    chmodSync(monitor, 0o755)
    git(repo, "config", "core.fsmonitor", monitor)
    // The planted monitor runs on a plain status: the probe is live.
    git(repo, "status", "--porcelain")
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    const outcome = await runUnattended(
      runArgs(
        job,
        [],
        [INIT, RESULT, (o: Options) => callHostTool(o, "mark_done", { summary: "Done" }), RESULT],
      ),
    )
    // The status fingerprint ran at the first turn end and the PR check at the second.
    expect(outcome.completion).toMatchObject({ by: "needs_you", reasonCode: "pr_missing" })
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  it("S57 (D43 F4): an origin behind an ssh host alias gets the finishing block of the forge the alias names", async () => {
    const config = path.join(tmpdir(), `ssh-fixture-${Math.random().toString(36).slice(2)}`)
    writeFileSync(
      config,
      "Host gh-work\n  HostName github.com\nHost gitlab-work\n  HostName gitlab.com\n",
    )
    const appendFor = async (origin: string) => {
      const job = repoJob()
      git((job.session as JobSession).folderPath as string, "remote", "add", "origin", origin)
      const captured: Captured[] = []
      await runUnattended({ ...runArgs(job, captured, [INIT, RESULT]), sshConfigFile: config })
      return (captured[0]?.options.systemPrompt as { append?: string } | undefined)?.append ?? ""
    }
    // An alias of github.com is GitHub: gh opens the PR, no merge-request line.
    expect(await appendFor("git@gh-work:acme/widget.git")).not.toContain(MERGE_REQUEST_LINE)
    // An alias of another forge is not.
    expect(await appendFor("git@gitlab-work:group/repo.git")).toContain(MERGE_REQUEST_LINE)
    rmSync(config)
  }, 30_000)

  it("in place with a submodule on another host: its git dir is in the commit set (config, hooks denied); its SSH remote gets no shim, agent or host (the broker pushes it)", async () => {
    const config = path.join(tmpdir(), `ssh-fixture-${Math.random().toString(36).slice(2)}`)
    writeFileSync(config, "Host gh-alt\n  HostName github.com\n  Port 443\n")
    const run = async (level: "strict" | "standard") => {
      const job = repoJob({ level, profileLevel: level })
      const repo = (job.session as JobSession).folderPath as string
      git(repo, "remote", "add", "origin", "https://gitlab.com/acme/app.git")
      const libSource = ownerRepo(path.join(job.home as string, "src"), "lib")
      git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", libSource, "lib")
      git(path.join(repo, "lib"), "switch", "-q", "-c", "fix/lib")
      git(path.join(repo, "lib"), "remote", "set-url", "origin", "git@gh-alt:acme/lib.git")
      // web: an HTTPS GitHub submodule, with this computer's gh login available.
      const webSource = ownerRepo(path.join(job.home as string, "src"), "web")
      git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", webSource, "web")
      git(path.join(repo, "web"), "remote", "set-url", "origin", "https://github.com/acme/web.git")
      const captured: Captured[] = []
      await runUnattended({
        ...runArgs(job, captured, [INIT, RESULT]),
        sshConfigFile: config,
        readGhToken: () => "gho_submoduleCANARY",
        gitCredential: () => ({ username: "u", password: "never-for-a-submodule" }),
      })
      const o = captured[0]?.options as Options
      const sessions = path.join(job.nodeRoot, ".sessions")
      const shims = existsSync(sessions)
        ? spawnSync("find", [sessions, "-name", "nc", "-type", "f"], { encoding: "utf8" })
            .stdout.trim()
            .split("\n")
            .filter(Boolean)
        : []
      return { o, lib: path.join(realpathSync(repo), ".git", "modules", "lib"), shims }
    }
    const standard = await run("standard")
    const fs = standard.o.sandbox?.filesystem
    expect(fs?.allowWrite).toContain(path.join(standard.lib, "objects"))
    expect(fs?.allowWrite).toContain(path.join(standard.lib, "refs", "heads", "fix", "lib"))
    for (const f of ["config", "hooks", "info", "HEAD", "packed-refs"]) {
      expect(fs?.denyWrite).toContain(path.join(standard.lib, f))
    }
    // 2026-10-22: no SSH proxy and no agent in the sandbox; the broker pushes lib.
    expect(standard.shims).toHaveLength(0)
    expect(standard.o.env?.SSH_AUTH_SOCK).toBeUndefined()
    expect(standard.o.sandbox?.network?.allowUnixSockets ?? []).toHaveLength(1)
    // No credential reaches a submodule's HTTPS remote (a session's program could read it).
    const env = standard.o.env ?? {}
    const keys = Object.entries(env)
      .filter(([k]) => /^GIT_CONFIG_KEY_/.test(k))
      .map(([, v]) => v)
    expect(keys).not.toContain("credential.https://github.com.helper")
    const strict = await run("strict")
    const domains = strict.o.sandbox?.network?.allowedDomains ?? []
    // github.com for web's HTTPS remote; lib's SSH alias adds nothing.
    expect(domains).toContain("github.com")
    expect(domains).toContain("gitlab.com")
    expect(domains).not.toContain("gh-alt")
    expect(domains).not.toContain("*")
    rmSync(config)
  }, 30_000)

  it("S57 (D43 F10): against a server older than wave 2 a repo session gets no finish step and mark_done ends done without a PR", async () => {
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(repoJob({ serverProtocol: 3 }), captured, [
        INIT,
        (o: Options) => callHostTool(o, "mark_done", { summary: "Fixed it" }),
        RESULT,
      ]),
    )
    const append =
      (captured[0]?.options.systemPrompt as { append?: string } | undefined)?.append ?? ""
    expect(append).not.toContain("When the work is finished")
    expect(append).not.toContain(MERGE_REQUEST_LINE)
    expect(captured[0]?.options.env?.ATELIER_HOST_FINISH).toBeUndefined()
    expect(outcome.completion).toEqual({ by: "session", summary: "Fixed it" })
    // The same session from a wave-2 server: the PR is due.
    const due = await runUnattended(
      runArgs(
        repoJob({ serverProtocol: 4 }),
        [],
        [INIT, (o: Options) => callHostTool(o, "mark_done", { summary: "Fixed it" }), RESULT],
      ),
    )
    expect(due.completion).toMatchObject({ by: "needs_you", reasonCode: "pr_missing" })
  }, 30_000)

  it("S57 (D43 F3): the session's start is kept across its runs, never re-measured", () => {
    const home = mkdtempSync(path.join(tmpdir(), "liaison-baseline-"))
    const repo = ownerRepo(home)
    const sessionDir = path.join(home, ".sessions", "abc")
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }
    const start = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim()
    const first = sessionBaseline(sessionDir, repo, env, () => 1_000)
    // Batch-2 F1: every ref's tip at the start is recorded with it.
    expect(first).toEqual({ head: start, at: 1_000, tips: [start] })
    expect(existsSync(path.join(sessionDir, SESSION_BASELINE_FILE))).toBe(true)
    // The session commits and the run restarts: the start stays the first one.
    writeFileSync(path.join(repo, "x.ts"), "export const x = 1\n")
    git(repo, "add", "x.ts")
    git(repo, "commit", "-q", "-m", "x")
    expect(sessionBaseline(sessionDir, repo, env, () => 2_000)).toEqual({
      head: start,
      at: 1_000,
      tips: [start],
    })
    // Without a session dir: this run's own start.
    const moved = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim()
    expect(sessionBaseline(null, repo, env, () => 3_000)).toEqual({
      head: moved,
      at: 3_000,
      tips: [moved],
    })
    rmSync(home, { recursive: true, force: true })
  })

  it("S57: finish commit → mark_done ends done without a push", async () => {
    const outcome = await runUnattended(
      runArgs(
        repoJob({ finishWith: "commit" }),
        [],
        [INIT, (o: Options) => callHostTool(o, "mark_done", { summary: "Committed" }), RESULT],
      ),
    )
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toEqual({ by: "session", summary: "Committed" })
  }, 30_000)

  it("S57: set_level pending + mark_done latched without a PR at the final result → pr_missing", async () => {
    const live = liveQuery()
    const s = steer(repoJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "open" } }))
    await until(() => applied(s.events()).length === 1)
    await callHostTool(live.options[0], "mark_done", { summary: "Fixed" })
    live.out.push(RESULT)
    const outcome = await s.running
    expect(outcome.status).toBe("done")
    expect(outcome.completion).toMatchObject({ by: "needs_you", reasonCode: "pr_missing" })
    expect(s.events().some((e) => e.type === "level_changed")).toBe(true)
  }, 30_000)

  it("S32: a level restart pending + an autonomous empty turn end at the final result → the restart is taken, not done", async () => {
    const live = liveQuery()
    const s = steer(autonomous(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "standard" } }))
    await until(() => applied(s.events()).length === 1)
    live.out.push(RESULT)
    const outcome = await s.running
    expect(outcome.status).toBe("restart")
    expect(outcome.level).toBe("standard")
    expect(s.events().some((e) => e.type === "level_changed")).toBe(false)
    expect(continues(s.events())).toEqual([])
    expect(live.pulled).toHaveLength(1)
  })
})

describe("P2-T09 OPEN-6: a pull request on another forge", () => {
  const MR_LINE =
    "This repository is not on GitHub, and glab cannot reach its API from this session: after you push your branch, pass the merge-request link that git push prints as prUrl to mark_done; if git push prints none, call needs_you saying so."

  it("S57: the pr finishing block on a non-GitHub remote says to report the merge-request link git push prints; on GitHub or with commit it does not", () => {
    const append = (session: Partial<JobSession>, remoteHost?: string) => {
      const job = sessionJob({ level: "standard", profileLevel: "standard", ...session })
      return sessionAppend(job, job.session as JobSession, "Ada", null, {
        repo: true,
        ...(remoteHost ? { remoteHost } : {}),
      })
    }
    expect(append({}, "gitlab.example.com")).toContain(MR_LINE)
    expect(append({}, "github.com")).not.toContain(MR_LINE)
    expect(append({})).not.toContain(MR_LINE)
    expect(append({ finishWith: "commit" }, "gitlab.example.com")).not.toContain(MR_LINE)
  })
})

// ── P2-T10: switching autonomy mid-run (S33) ──

describe("P2-T10 the autonomy switch (S33)", () => {
  const DENIED =
    "This session is now autonomous: decide with a sensible default and record the assumption."
  const askQuestion = (live: Live, id: string) =>
    live.options[0]?.canUseTool?.(
      "AskUserQuestion",
      { questions: [{ question: "Which file?", header: "File", options: [], multiSelect: false }] },
      { signal: new AbortController().signal, toolUseID: id, requestId: id } as never,
    ) as Promise<{ behavior: string; message?: string }>
  /** One tool step: a Bash call and its result (the safe point a restart waits for). */
  const step = (live: Live, id: string) => {
    live.out.push(toolUse(id, "Bash", { command: "true" }))
    live.out.push({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
    })
  }
  const autonomyChanged = (events: Array<{ type: string; payload: Record<string, unknown> }>) =>
    events
      .filter((e) => e.type === "system" && e.payload.subtype === "autonomy_changed")
      .map((e) => e.payload.data)

  it("S33: set_autonomy autonomous mid-turn denies a pending AskUserQuestion with the fixed message and the next one too", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    const pending = askQuestion(live, "toolu_q1")
    await until(() => s.events().some((e) => e.type === "question"))
    s.control.push(cmdLine(1, { type: "set_autonomy", payload: { autonomy: "autonomous" } }))
    await until(() => applied(s.events()).length === 1)
    expect(applied(s.events())).toEqual([
      { commandId: CMD(1), type: "set_autonomy", outcome: "applied" },
    ])
    expect(await pending).toMatchObject({ behavior: "deny", message: DENIED })
    expect(s.events().find((e) => e.type === "decision")?.payload).toEqual({
      requestId: "toolu_q1",
      outcome: "deny",
      by: "owner",
    })
    expect(await askQuestion(live, "toolu_q2")).toMatchObject({ behavior: "deny", message: DENIED })
    const plan = (await live.options[0]?.canUseTool?.("ExitPlanMode", { plan: "x" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_p",
      requestId: "toolu_p",
    } as never)) as { behavior: string; message?: string }
    expect(plan).toMatchObject({ behavior: "deny", message: DENIED })
    // Only the first question ever reached the owner.
    expect(s.events().filter((e) => e.type === "question")).toHaveLength(1)
    expect(s.events().some((e) => e.type === "plan_request")).toBe(false)
    expect(autonomyChanged(s.events())).toEqual([
      { from: "guided", to: "autonomous", applied: true },
    ])
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    await s.running
  })

  it("S31: a session started autonomous denies AskUserQuestion and ExitPlanMode in canUseTool too", async () => {
    const live = liveQuery()
    const s = steer(sessionJob({ autonomy: "autonomous" }), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    // Answered at once: a question that waited on the person would never settle here.
    const now = <T>(p: Promise<T> | undefined) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r("waiting on the person"), 500))])
    expect(await now(askQuestion(live, "toolu_q1"))).toMatchObject({
      behavior: "deny",
      message: DENIED,
    })
    const plan = await now(
      live.options[0]?.canUseTool?.("ExitPlanMode", { plan: "x" }, {
        signal: new AbortController().signal,
        toolUseID: "toolu_p",
        requestId: "toolu_p",
      } as never),
    )
    expect(plan).toMatchObject({ behavior: "deny", message: DENIED })
    expect(s.events().some((e) => e.type === "question" || e.type === "plan_request")).toBe(false)
    s.control.push(cmdLine(1, { type: "stop", payload: {} }))
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    await s.running
  })

  it("S33: it ends the run with restart for autonomy at the same level and no level_changed", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_autonomy", payload: { autonomy: "autonomous" } }))
    await until(() => applied(s.events()).length === 1)
    await Bun.sleep(30)
    // Never in the middle of a step: the restart waits for one to end.
    expect(live.interrupts).toBe(0)
    step(live, "toolu_s1")
    await until(() => live.interrupts === 1)
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    const outcome = await s.running
    expect(outcome).toMatchObject({
      status: "restart",
      level: "strict",
      autonomy: "autonomous",
      restartFor: "autonomy",
      sdkSessionId: "sdk-session-1",
    })
    expect(s.lines.at(-1)).toMatchObject({
      type: "job_done",
      status: "restart",
      level: "strict",
      autonomy: "autonomous",
      restartFor: "autonomy",
    })
    expect(s.events().some((e) => e.type === "level_changed")).toBe(false)
  })

  it("S33: autonomous→guided restarts and the next run has no disallowedTools", async () => {
    const live = liveQuery()
    const job = sessionJob({ autonomy: "autonomous" })
    const s = steer(job, live)
    await until(() => live.pulled.length === 1)
    expect(live.options[0]?.disallowedTools).toEqual([
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
    ])
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_autonomy", payload: { autonomy: "guided" } }))
    await until(() => applied(s.events()).length === 1)
    step(live, "toolu_s1")
    await until(() => live.interrupts === 1)
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    const outcome = await s.running
    expect(outcome).toMatchObject({ status: "restart", autonomy: "guided", restartFor: "autonomy" })
    expect(autonomyChanged(s.events())).toEqual([
      { from: "autonomous", to: "guided", applied: true },
    ])
    // The runner restarts the job with the autonomy the outcome carries (T06).
    const again = liveQuery()
    const restarted = steer(
      {
        ...job,
        session: {
          ...(job.session as JobSession),
          autonomy: outcome.autonomy,
          resume: { sdkSessionId: "sdk-session-1", after: "autonomy" },
        },
      },
      again,
    )
    await until(() => again.pulled.length === 1)
    expect(again.options[0]?.disallowedTools).toBeUndefined()
    expect(again.options[0]?.resume).toBe("sdk-session-1")
    again.out.push(INIT)
    again.out.push(RESULT)
    await restarted.running
  })

  it("S33: set_autonomy while a level restart is pending → the one restart carries the new level and the new autonomy", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_level", payload: { level: "standard" } }))
    await until(() => applied(s.events()).length === 1)
    s.control.push(cmdLine(2, { type: "set_autonomy", payload: { autonomy: "autonomous" } }))
    await until(() => applied(s.events()).length === 2)
    expect(applied(s.events()).map((a) => a.outcome)).toEqual(["applied", "applied"])
    step(live, "toolu_s1")
    await until(() => live.interrupts === 1)
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    const outcome = await s.running
    expect(outcome).toMatchObject({
      status: "restart",
      level: "standard",
      autonomy: "autonomous",
    })
    // A level change: the runner names it (levelChange), not an autonomy-only resume.
    expect(outcome.restartFor).toBeUndefined()
    expect(live.interrupts).toBe(1)
  })

  it("S33: set_level while an autonomy restart is pending → the one restart carries both, with level_changed", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_autonomy", payload: { autonomy: "autonomous" } }))
    await until(() => applied(s.events()).length === 1)
    s.control.push(cmdLine(2, { type: "set_level", payload: { level: "standard" } }))
    await until(() => applied(s.events()).length === 2)
    expect(applied(s.events()).map((a) => a.outcome)).toEqual(["applied", "applied"])
    step(live, "toolu_s1")
    await until(() => live.interrupts === 1)
    live.out.push({ ...RESULT, subtype: "error_during_execution", is_error: true })
    const outcome = await s.running
    expect(outcome).toMatchObject({
      status: "restart",
      level: "standard",
      autonomy: "autonomous",
    })
    // The level wins the resume reason: the runner sends levelChange, the next run level_changed.
    expect(outcome.restartFor).toBeUndefined()
    expect(live.interrupts).toBe(1)
  })

  it("S32: set_autonomy pending + an autonomous empty turn end at the final result → the restart is taken, not done", async () => {
    const live = liveQuery()
    const s = steer(sessionJob(), live)
    await until(() => live.pulled.length === 1)
    live.out.push(INIT)
    await until(() => s.events().length > 0)
    s.control.push(cmdLine(1, { type: "set_autonomy", payload: { autonomy: "autonomous" } }))
    await until(() => applied(s.events()).length === 1)
    live.out.push(RESULT)
    const outcome = await s.running
    expect(outcome).toMatchObject({
      status: "restart",
      level: "strict",
      autonomy: "autonomous",
      restartFor: "autonomy",
    })
    expect(outcome.completion).toBeUndefined()
    expect(s.events().some((e) => e.type === "level_changed")).toBe(false)
    expect(
      s.events().filter((e) => e.type === "system" && e.payload.subtype === "auto_continue"),
    ).toEqual([])
    expect(live.pulled).toHaveLength(1)
  })
})

describe("W3 T12 Take over resumes in place, in the recorded cwd (S41, S51, A44, A62)", () => {
  const SDK = "5e0c1d2a-7b3f-4c8e-9a1d-2f3e4d5c6b7a"
  const SDK_INIT = { ...INIT, session_id: SDK }
  const runtimeKey = () => `${["sk", "ant", "api03"].join("-")}-${"Q7x".repeat(8)}`

  /** A Take over import of SDK in `<repo>/sub`, resumed by the owner's first message. */
  function takeOverJob(
    session: Partial<JobSession> = {},
    resume: Record<string, unknown> = {},
    level: "strict" | "standard" = "strict",
  ) {
    const job = sessionJob(
      {
        level,
        profileLevel: level,
        source: "import",
        finishWith: "none",
        resume: { sdkSessionId: SDK, after: "message", commandId: CMD(9), ...resume } as never,
        ...session,
      },
      { prompt: "Carry on." },
    )
    const repo = ownerRepo(path.join(job.home as string, "code"))
    mkdirSync(path.join(repo, "sub"), { recursive: true })
    job.session = {
      ...(job.session as JobSession),
      folderPath: repo,
      folderName: "my-repo",
      cwdSubdir: "sub",
    }
    const projectDir = path.join(
      job.home as string,
      ".claude",
      "projects",
      path.join(repo, "sub").replace(/[^a-zA-Z0-9]/g, "-"),
    )
    mkdirSync(projectDir, { recursive: true })
    return { job, repo, jsonl: path.join(projectDir, `${SDK}.jsonl`) }
  }

  /** One JSON line padded to exactly `bytes` bytes, newline included. */
  function lineOf(entry: Record<string, unknown>, bytes: number): string {
    const bare = JSON.stringify({ ...entry, pad: "" })
    const pad = bytes - 1 - Buffer.byteLength(bare)
    if (pad < 0) throw new Error(`line over ${bytes} bytes`)
    return `${JSON.stringify({ ...entry, pad: "x".repeat(pad) })}\n`
  }

  /** 300 bytes: one old line (0-100), then what VS Code appended after the replay (100-300). */
  function transcript(file: string) {
    const body =
      lineOf({ type: "user", message: { content: "old line already imported" } }, 100) +
      lineOf(
        {
          type: "assistant",
          message: {
            id: "m1",
            content: [{ type: "text", text: `key ${runtimeKey()}` }],
          },
        },
        134,
      ) +
      lineOf({ type: "user", message: { content: "typed in vscode" } }, 66)
    writeFileSync(file, body)
    // An old write: the driver check sees nobody holding it now.
    utimesSync(file, (Date.now() - 600_000) / 1000, (Date.now() - 600_000) / 1000)
    return body
  }

  const noDriver = (): DriverProbe => ({
    ...systemDriverProbe(),
    registry: () => [],
    processes: () => [],
    platform: "darwin",
  })

  it("A44: an in-place import with cwdSubdir 'sub' runs with cwd <folder>/sub and write scope <folder>", async () => {
    const { job, repo } = takeOverJob()
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], { driverProbe: noDriver() }),
    )
    expect(outcome.status).toBe("done")
    const o = captured[0]?.options as Options
    expect(o.cwd).toBe(path.join(repo, "sub"))
    expect(o.resume).toBe(SDK)
    expect(o.sandbox?.filesystem?.allowWrite).toContain(repo)
    expect(existsSync(path.join(job.nodeRoot, "worktrees"))).toBe(false)
  })

  it("D53: an in-place import recorded in the shared repo's own worktree outside the folder runs in that worktree's subfolder, write scope the worktree", async () => {
    const { job, repo } = takeOverJob()
    const worktree = path.join(realpathSync(job.home as string), "wt", "my-repo-wt")
    mkdirSync(path.dirname(worktree), { recursive: true })
    git(repo, "worktree", "add", "-q", "-b", "wt", worktree)
    mkdirSync(path.join(worktree, "sub"))
    job.session = { ...(job.session as JobSession), worktreePath: worktree }
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], { driverProbe: noDriver() }),
    )
    expect(outcome.status).toBe("done")
    const o = captured[0]?.options as Options
    expect(o.cwd).toBe(path.join(worktree, "sub"))
    expect(o.resume).toBe(SDK)
    expect(o.sandbox?.filesystem?.allowWrite).toContain(worktree)
    expect(o.sandbox?.filesystem?.allowWrite).not.toContain(repo)
  })

  it("D53: an import naming a folder that is no worktree of the shared repo is refused unsafe_subdir and never runs", async () => {
    const { job } = takeOverJob()
    const elsewhere = path.join(realpathSync(job.home as string), "elsewhere")
    mkdirSync(path.join(elsewhere, "sub"), { recursive: true })
    job.session = { ...(job.session as JobSession), worktreePath: elsewhere }
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], { driverProbe: noDriver() }),
    )
    expect({ status: outcome.status, code: outcome.code }).toEqual({
      status: "refused",
      code: "unsafe_subdir",
    })
    expect(captured).toEqual([])
  })

  it("D49 F6: an owner run records, in its own config dir, that it ran the SDK session for its server", async () => {
    const { job } = takeOverJob()
    const captured: Captured[] = []
    await runUnattended(runArgs(job, captured, [SDK_INIT, RESULT], { driverProbe: noDriver() }))
    expect(captured).toHaveLength(1)
    const dataDir = path.join(job.home as string, "data")
    const id = (job.session as JobSession).id
    expect(ranForServer(id, SDK, "https://liaison.example", dataDir)).toBe(true)
    expect(ranForServer(id, SDK, "https://other.example", dataDir)).toBe(false)
    expect(
      ranForServer(id, "6e0c1d2a-7b3f-4c8e-9a1d-2f3e4d5c6b7a", "https://liaison.example", dataDir),
    ).toBe(false)
  })

  // B2-3 (D52): the F6 check guarded the follow host only. A server the owner
  // shares the same folder with could send a run job naming another server's
  // liaison-node session: a Take over's catch-up uploaded its transcript, and
  // a plain resume wrote into it and recorded it as its own.
  describe("B2-3: a job naming an SDK session another server ran is refused", () => {
    const A = "https://a.example"
    const A_SESSION = "7a7a7a7a-1111-4222-8333-444444444444"
    /** A liaison-node transcript, as server A's in-place owner session wrote it. */
    function nodeTranscript(file: string, cwd: string): string {
      const body =
        lineOf(
          {
            type: "user",
            cwd,
            entrypoint: OWNER_SESSION_ENTRYPOINT,
            sessionId: SDK,
            message: { content: "server a's own prompt" },
          },
          1000,
        ) +
        lineOf(
          {
            type: "assistant",
            message: { id: "m1", content: [{ type: "text", text: "server a's own answer" }] },
          },
          150,
        )
      writeFileSync(file, body)
      utimesSync(file, (Date.now() - 600_000) / 1000, (Date.now() - 600_000) / 1000)
      return body
    }
    const dataDirOf = (job: { home?: string }) => path.join(job.home as string, "data")

    for (const shape of [
      { name: "a Take over with its catch-up from 0", session: {}, resume: { catchUpFrom: 0 } },
      {
        name: "a plain resume of an app session",
        session: { source: "app" },
        resume: { after: "level" },
      },
    ]) {
      it(`B2-3: ${shape.name}, from this server, for a session server A ran, is refused already_liaison and uploads nothing`, async () => {
        const { job, repo, jsonl } = takeOverJob(shape.session as never, shape.resume)
        const body = nodeTranscript(jsonl, path.join(repo, "sub"))
        // Server A's own session recorded that it ran SDK (D49 F6).
        const aDir = sessionConfigDir(A_SESSION, dataDirOf(job))
        mkdirSync(aDir, { recursive: true })
        recordOwnerRun(aDir, A, SDK)
        const lines: Array<Record<string, unknown>> = []
        const captured: Captured[] = []
        const outcome = await runUnattended(
          runArgs(job, captured, [SDK_INIT, RESULT], {
            driverProbe: noDriver(),
            emit: (l) => lines.push(l),
          }),
        )
        expect(outcome).toMatchObject({ status: "refused", code: "already_liaison" })
        expect(captured).toHaveLength(0)
        const wire = JSON.stringify(eventsOf(lines))
        expect(wire).not.toContain("server a's own")
        // Nothing recorded the session as this server's.
        const id = (job.session as JobSession).id
        expect(ranForServer(id, SDK, job.server, dataDirOf(job))).toBe(false)
        expect(readFileSync(jsonl, "utf8")).toBe(body)
      })
    }

    it("B2-3: a job reusing server A's own Liaison session id from this server is refused as well", async () => {
      const { job, repo, jsonl } = takeOverJob({ id: A_SESSION } as never, { catchUpFrom: 0 })
      nodeTranscript(jsonl, path.join(repo, "sub"))
      const aDir = sessionConfigDir(A_SESSION, dataDirOf(job))
      mkdirSync(aDir, { recursive: true })
      recordOwnerRun(aDir, A, SDK)
      const captured: Captured[] = []
      const outcome = await runUnattended(
        runArgs(job, captured, [SDK_INIT, RESULT], { driverProbe: noDriver() }),
      )
      expect(outcome).toMatchObject({ status: "refused", code: "already_liaison" })
      expect(captured).toHaveLength(0)
    })

    it("B2-3: the server that ran it resumes its own liaison-node session as before", async () => {
      const { job, repo, jsonl } = takeOverJob({ source: "app" } as never, { after: "level" })
      nodeTranscript(jsonl, path.join(repo, "sub"))
      const id = (job.session as JobSession).id
      const own = sessionConfigDir(id, dataDirOf(job))
      mkdirSync(own, { recursive: true })
      recordOwnerRun(own, job.server, SDK)
      const captured: Captured[] = []
      const outcome = await runUnattended(
        runArgs(job, captured, [SDK_INIT, RESULT], { driverProbe: noDriver() }),
      )
      expect(outcome.status).toBe("done")
      expect(captured).toHaveLength(1)
      expect((captured[0] as Captured).options.resume).toBe(SDK)
    })
  })

  it("A44: an import with a pr-less finish on main gets no node-made branch", async () => {
    const { job, repo } = takeOverJob({}, {}, "standard")
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        driverProbe: noDriver(),
        emit: (l) => lines.push(l),
      }),
    )
    expect(captured).toHaveLength(1)
    const start = eventsOf(lines).find((e) => e.type === "system" && e.payload.subtype === "start")
    const data = start?.payload.data as Record<string, unknown>
    expect(data.branch).toBe("main")
    expect(data.nodeBranch).toBeUndefined()
    expect(
      spawnSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" }).stdout.trim(),
    ).toBe("* main")
  })

  it("A62: a run with catchUpFrom 100 over a transcript of 300 bytes emits the redacted events of bytes 100-300 before the SDK starts", async () => {
    const { job, jsonl } = takeOverJob({}, { catchUpFrom: 100 })
    const body = transcript(jsonl)
    expect(Buffer.byteLength(body)).toBe(300)
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        driverProbe: noDriver(),
        emit: (l) => lines.push(l),
      }),
    )
    expect(captured).toHaveLength(1)
    const events = eventsOf(lines)
    const wire = JSON.stringify(events)
    expect(wire).not.toContain(runtimeKey())
    expect(wire).not.toContain("old line already imported")
    const typed = events.findIndex(
      (e) => e.type === "user_message" && e.payload.text === "typed in vscode",
    )
    const said = events.findIndex(
      (e) => e.type === "assistant_text" && String(e.payload.text).includes("[redacted"),
    )
    const start = events.findIndex((e) => e.type === "system" && e.payload.subtype === "start")
    expect(said).toBeGreaterThanOrEqual(0)
    expect(typed).toBeGreaterThan(said)
    expect(start).toBeGreaterThan(typed)
    // The transcript is read, never written.
    expect(readFileSync(jsonl, "utf8")).toBe(body)
  })

  it("B2-2: a Take over's catch-up of a Read of every listed assignment form uploads no value", () => {
    const { jsonl } = takeOverJob({}, { catchUpFrom: 0 })
    const text = B2_2_FORMS.map((f) => f.line).join("\n")
    writeFileSync(
      jsonl,
      `${[
        { type: "user", message: { content: "read the env" } },
        {
          type: "assistant",
          message: {
            id: "m1",
            content: [
              { type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: ".env" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_r1", content: text }] },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    )
    const events = [...catchUpEvents(jsonl, 0)]
    const result = events.find((e) => e.type === "tool_result") as (typeof events)[number]
    expect(result.type).toBe("tool_result")
    const output = (result.payload as { output: string }).output
    for (const { form, kept } of B2_2_FORMS) {
      expect({ form, kept: output.includes(kept) }).toEqual({ form, kept: true })
    }
    expect(JSON.stringify(events)).not.toContain(FIXTURE_PW)
  })

  it("A62: catchUpFrom past the end emits the transcript_gone note and no catch-up", async () => {
    const { job, jsonl } = takeOverJob({}, { catchUpFrom: 1000 })
    transcript(jsonl)
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        driverProbe: noDriver(),
        emit: (l) => lines.push(l),
      }),
    )
    expect(captured).toHaveLength(1)
    const events = eventsOf(lines)
    expect(
      events
        .filter((e) => e.type === "system" && e.payload.subtype === "follow")
        .map((e) => e.payload.data),
    ).toEqual([{ state: "ended", why: "transcript_gone" }])
    expect(
      events.some((e) => e.type === "user_message" && e.payload.text === "typed in vscode"),
    ).toBe(false)
  })

  it("D49 F5: catchUpFrom 0 over a generated 120 MB transcript uploads at most the last 8 MiB, notes the older lines once, and keeps RSS growth bounded", async () => {
    const { job, jsonl } = takeOverJob({}, { catchUpFrom: 0 })
    try {
      const gen = generateTranscript({
        file: jsonl,
        sessionId: SDK,
        cwd: path.dirname(jsonl),
        bytes: 120 * 1024 * 1024,
        seed: 5,
      })
      utimesSync(jsonl, (Date.now() - 600_000) / 1000, (Date.now() - 600_000) / 1000)
      // The lines before the window, counted on disk in 1 MiB reads.
      const windowFrom = gen.bytes - NODE_IMPORT_LIMITS.historyBytes
      let older = 0
      let windowStart = -1
      const fd = openSync(jsonl, "r")
      const buf = Buffer.alloc(1024 * 1024)
      for (let at = 0; windowStart < 0; ) {
        const got = readSync(fd, buf, 0, buf.length, at)
        if (got <= 0) break
        for (let i = 0; i < got; i++) {
          if (buf[i] !== 0x0a) continue
          older++
          if (at + i + 1 >= windowFrom) {
            windowStart = at + i + 1
            break
          }
        }
        at += got
      }
      closeSync(fd)
      expect(windowStart).toBeGreaterThanOrEqual(windowFrom)
      Bun.gc(true)
      const rss0 = process.memoryUsage().rss
      let peak = rss0
      let uploaded = 0
      let count = 0
      const notes: unknown[] = []
      let started = false
      const captured: Captured[] = []
      await runUnattended(
        runArgs(job, captured, [SDK_INIT, RESULT], {
          driverProbe: noDriver(),
          emit: (l) => {
            peak = Math.max(peak, process.memoryUsage().rss)
            if (l.type !== "session_events") return
            for (const e of l.events as Array<{ type: string; payload: Record<string, unknown> }>) {
              if (e.type === "system" && e.payload.subtype === "start") started = true
              if (started) continue
              if (e.type === "system" && e.payload.subtype === "follow") notes.push(e.payload)
              else if (e.type === "system") continue
              else {
                count++
                uploaded += Buffer.byteLength(JSON.stringify(e))
              }
            }
          },
        }),
      )
      expect(captured).toHaveLength(1)
      expect(count).toBeGreaterThan(100)
      expect(uploaded).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(notes).toEqual([
        {
          subtype: "follow",
          text: `Older lines not imported (${older})`,
          data: { state: "started", olderLinesOmitted: older },
        },
      ])
      expect((peak - rss0) / (1024 * 1024)).toBeLessThan(100)
    } finally {
      rmSync(jsonl, { force: true })
    }
  }, 120_000)

  it("S51: Take over while the VS Code-like process still writes the transcript in <folder>/sub → driver event, no SDK start", async () => {
    const { job, jsonl } = takeOverJob({}, { catchUpFrom: 100 })
    transcript(jsonl)
    // VS Code wrote it 3 s ago, in the subfolder's own project dir.
    utimesSync(jsonl, (Date.now() - 3_000) / 1000, (Date.now() - 3_000) / 1000)
    const lines: Array<Record<string, unknown>> = []
    const captured: Captured[] = []
    const outcome = await runUnattended(
      runArgs(job, captured, [SDK_INIT, RESULT], {
        driverProbe: noDriver(),
        emit: (l) => lines.push(l),
      }),
    )
    expect(captured).toHaveLength(0)
    expect(outcome.completion).toBeUndefined()
    const events = eventsOf(lines)
    expect(
      events.filter((e) => e.type === "system").map((e) => [e.payload.subtype, e.payload.data]),
    ).toEqual([["driver", { elsewhere: true, via: null }]])
    // No catch-up before the driver check passed.
    expect(events.some((e) => e.type === "user_message")).toBe(false)
  })

  it("A44: the import's result line is the Sessions one", () => {
    expect(RESULT_LINES.import).toBe(
      "Your final message is the session's result, shown in Sessions.",
    )
  })
})
