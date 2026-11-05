// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REAL QUERIES: owner sessions in the real folder (P1-T21; S48-S50, owner
// D13, A18, D26). Both CLIs (the SDK's bundled binary and this Mac's
// installed one), claude-haiku-5-5, scratch repositories and a scratch
// "owner config", never the real ~/.claude:
//
// - S49: the mirror config dir's `projects` is a link to the owner's; the
//   JSONL lands at `<owner config>/projects/<slug of the repo>/<id>.jsonl`,
//   `listSessions({dir})` on the owner's config lists it, a resume under the
//   mirror and `claude -p --resume <id>` on the owner's config both resume it.
// - D26a: a tracked project hook does not run under the flag layer's
//   disableAllHooks (a control run shows it does without), and the node's
//   own SDK PreToolUse callback still fires.
// - D26b: which CLAUDE_CODE_ENTRYPOINT makes the session visible to the IDE
//   and terminal pickers (`includeProgrammatic: false`) while streaming,
//   canUseTool, the SDK hook and Artifact keep working; the chosen
//   OWNER_SESSION_ENTRYPOINT is asserted.
// - S48, S50.2: an owner dispatch at Standard through runUnattended runs in the
//   folder itself, commits on its current branch under the real sandbox, and
//   cannot write .git/config (guard and sandbox each refuse).
//
// The login is the keychain item, kept with CLAUDE_SECURESTORAGE_CONFIG_DIR=""
// (config-isolation.ts). Skipped unless macOS with the CLI signed in.
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type CanUseTool,
  type HookCallback,
  listSessions,
  type Options,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk"
import { AsyncQueue, userMessage } from "./index"
import { OWNER_SESSION_ENTRYPOINT, prepareSessionConfig } from "./session-config"
import { runUnattended, type UnattendedJob } from "./unattended"

function signedIn(): boolean {
  if (process.platform !== "darwin") return false
  try {
    const status = Bun.spawnSync(["claude", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
    return (JSON.parse(status.stdout.toString()) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
}

const BUNDLED = path.join(
  import.meta.dir,
  "node_modules",
  "@anthropic-ai",
  `claude-agent-sdk-darwin-${process.arch}`,
  "claude",
)
/** This Mac's installed Claude Code: the `claude` on PATH, its link resolved. */
const onPath = Bun.which("claude")
const INSTALLED = process.env.LIAISON_RQ_INSTALLED_CLAUDE ?? (onPath ? realpathSync(onPath) : "")

const READY = signedIn()
if (!READY) {
  process.stderr.write(
    "session-inplace.realquery: SKIPPED - not macOS, or the CLI is not signed in\n",
  )
}
const MODEL = "claude-haiku-5-5"
const RUN_MS = 180_000
const tmpBase = READY ? realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-inplace-rq-"))) : ""
afterAll(() => {
  if (READY) rmSync(tmpBase, { recursive: true, force: true })
})

function versionOf(binary: string): string | null {
  const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
}

/** The CLI's project folder name for a cwd: every non-alphanumeric becomes `-`. */
function slug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-")
}

function cliEnv(configDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ...extra }
}

function scratchRepo(root: string, files: Record<string, string> = {}): string {
  const repo = path.join(root, "repo")
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    writeFileSync(path.join(repo, rel), body)
  }
  git(repo, "add", "-A")
  git(
    repo,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  )
  return repo
}

type Message = Record<string, unknown> & { type?: string; subtype?: string }

/** One prompt, streamed (canUseTool needs a live input), every message kept. */
async function streamed(prompt: string, options: Options): Promise<Message[]> {
  const prompts = new AsyncQueue<SDKUserMessage>()
  prompts.push(userMessage(prompt) as SDKUserMessage)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), RUN_MS - 10_000)
  const messages: Message[] = []
  const q = sdkQuery({
    prompt: prompts,
    options: { model: MODEL, maxTurns: 4, abortController: abort, stderr: () => {}, ...options },
  })
  try {
    for await (const message of q) {
      messages.push(message as Message)
      if ((message as Message).type === "result") break
    }
  } finally {
    clearTimeout(timer)
    prompts.close()
    q.close()
  }
  return messages
}

function bashCalls(messages: Message[]): number {
  let n = 0
  for (const m of messages) {
    if (m.type !== "assistant") continue
    const content = (m.message as { content?: Array<{ type?: string; name?: string }> })?.content
    for (const b of content ?? []) if (b.type === "tool_use" && b.name === "Bash") n++
  }
  return n
}

function sdkHook(seen: string[]): HookCallback {
  return async (raw) => {
    seen.push(String((raw as { tool_name?: string }).tool_name ?? ""))
    return {}
  }
}

/** One turn under `configDir`; returns the session id and the final text. */
async function turn(args: {
  binary: string
  cwd: string
  configDir: string
  prompt: string
  sessionId?: string
  resume?: string
}): Promise<{ sessionId: string; text: string }> {
  const q = sdkQuery({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      model: MODEL,
      pathToClaudeCodeExecutable: args.binary,
      env: cliEnv(args.configDir),
      settingSources: [],
      allowedTools: [],
      tools: [],
      maxTurns: 1,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.resume ? { resume: args.resume } : {}),
    },
  })
  let sessionId = ""
  let text = ""
  for await (const m of q) {
    const msg = m as Record<string, unknown>
    if (typeof msg.session_id === "string") sessionId = msg.session_id
    if (msg.type === "result" && typeof msg.result === "string") text = msg.result
  }
  return { sessionId, text }
}

/** `listSessions` read the way a tool on the owner's config reads it. */
async function listAsOwner(ownerConfig: string, dir: string, includeProgrammatic: boolean) {
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = ownerConfig
  try {
    return await listSessions({ dir, includeProgrammatic })
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
}

for (const [label, binary, idBase] of [
  ["bundled", BUNDLED, "5a5a5a5a"],
  ["installed", INSTALLED, "5b5b5b5b"],
] as const) {
  describe.if(READY)(`owner session in the real folder, ${label} CLI (S49)`, () => {
    it(
      "S49: the transcript lands in the owner's projects and resumes",
      async () => {
        expect(existsSync(binary)).toBe(true)
        const version = versionOf(binary)
        expect(version).not.toBeNull()
        const root = path.join(tmpBase, label)
        const ownerConfig = path.join(root, "owner-claude")
        const dataDir = path.join(root, "data")
        const repo = path.join(root, "shared folder", "repo")
        mkdirSync(ownerConfig, { recursive: true })
        mkdirSync(repo, { recursive: true })
        git(repo, "init", "-q", "-b", "main")
        git(
          repo,
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        )

        const id = `${idBase}-1111-4222-8333-444444444444`
        // The node's own mirror, as an owner run builds it.
        const config = prepareSessionConfig({
          sessionId: id,
          configKind: "owner",
          level: "standard",
          realConfigDir: ownerConfig,
          dataDir,
        })
        const link = path.join(config.dir, "projects")
        expect(lstatSync(link).isSymbolicLink()).toBe(true)

        const first = await turn({
          binary,
          cwd: repo,
          configDir: config.dir,
          sessionId: id,
          prompt: "Remember the word PERIWINKLE. Reply with just OK.",
        })
        expect(first.sessionId).toBe(id)

        // The JSONL is in the owner's projects, under the repo's slug.
        const projectDir = path.join(ownerConfig, "projects", slug(realpathSync(repo)))
        const file = path.join(projectDir, `${id}.jsonl`)
        expect(existsSync(file)).toBe(true)
        // The link survived the run (the CLI did not replace it by a real dir).
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        const head = readFileSync(file, "utf8")
          .split("\n")
          .find((l) => l.includes('"entrypoint"'))
        const entrypoint = head ? (JSON.parse(head) as { entrypoint?: string }).entrypoint : null

        const listed = await listAsOwner(ownerConfig, repo, true)
        const listedIde = await listAsOwner(ownerConfig, repo, false)
        process.stderr.write(
          `session-inplace.realquery: ${label} ${version} file=${file} entrypoint=${entrypoint} listed=${JSON.stringify(
            listed.map((s) => s.sessionId),
          )} listedIdePicker=${JSON.stringify(listedIde.map((s) => s.sessionId))} projects=${JSON.stringify(
            readdirSync(path.join(ownerConfig, "projects")),
          )}\n`,
        )
        expect(listed.map((s) => s.sessionId)).toContain(id)

        // Resumed under the mirror (the node's own resume).
        const second = await turn({
          binary,
          cwd: repo,
          configDir: config.dir,
          resume: id,
          prompt: "Which word did I ask you to remember? Reply with just the word.",
        })
        expect(second.sessionId).toBe(id)
        expect(second.text.toUpperCase()).toContain("PERIWINKLE")

        // Resumed by the CLI on the owner's own config, in the folder.
        const cli = Bun.spawnSync(
          [
            binary,
            "-p",
            "--resume",
            id,
            "--model",
            MODEL,
            "--max-turns",
            "1",
            "Repeat the word I asked you to remember. Reply with just the word.",
          ],
          { cwd: repo, env: cliEnv(ownerConfig), stdout: "pipe", stderr: "pipe", timeout: RUN_MS },
        )
        process.stderr.write(
          `session-inplace.realquery: ${label} cli resume exit=${cli.exitCode} out=${cli.stdout
            .toString()
            .trim()
            .slice(0, 200)} err=${cli.stderr.toString().trim().slice(0, 300)}\n`,
        )
        expect(cli.exitCode).toBe(0)
        expect(cli.stdout.toString().toUpperCase()).toContain("PERIWINKLE")
        // Still one file: the owner's projects hold every turn.
        expect(readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"))).toEqual([`${id}.jsonl`])
      },
      RUN_MS * 2,
    )
  })
}

// D26a: in place below Open the node never rewrites the owner's tracked
// .claude/settings.json; a project `hooks` key is inert only because the flag
// layer's disableAllHooks (pinnedSettings) turns it off. Proven here on the
// real CLI, with a control run showing the same hooks DO run without it, and
// the node's own SDK PreToolUse callback still firing under it.
for (const [label, binary] of [
  ["bundled", BUNDLED],
  ["installed", INSTALLED],
] as const) {
  describe.if(READY)(`project hooks under the flag layer, ${label} CLI (D26a)`, () => {
    it(
      "S50: a tracked project hook does not run under disableAllHooks; the SDK hook still does",
      async () => {
        const root = path.join(tmpBase, `hooks-${label}`)
        const markers = path.join(root, "markers")
        mkdirSync(markers, { recursive: true })
        const hook = (name: string) => ({
          hooks: [{ type: "command", command: `touch '${path.join(markers, name)}'` }],
        })
        const repo = scratchRepo(root, {
          ".claude/settings.json": JSON.stringify({
            hooks: {
              SessionStart: [hook("session-start")],
              PreToolUse: [{ matcher: "*", ...hook("pre-tool") }],
              UserPromptSubmit: [hook("prompt")],
            },
          }),
        })
        const configDir = path.join(root, "config")
        mkdirSync(configDir, { recursive: true })
        const prompt = "Run the Bash command `echo probe-ok` exactly once, then reply DONE."
        const allow: CanUseTool = async (_t, input) => ({ behavior: "allow", updatedInput: input })

        const run = async (disable: boolean) => {
          rmSync(markers, { recursive: true, force: true })
          mkdirSync(markers, { recursive: true })
          const seen: string[] = []
          const messages = await streamed(prompt, {
            cwd: repo,
            pathToClaudeCodeExecutable: binary,
            env: cliEnv(configDir),
            settingSources: ["user", "project", "local"],
            permissionMode: "default",
            ...(disable ? { settings: { disableAllHooks: true } as Options["settings"] } : {}),
            hooks: { PreToolUse: [{ hooks: [sdkHook(seen)] }] },
            canUseTool: allow,
            persistSession: false,
          })
          return { bash: bashCalls(messages), seen, ran: readdirSync(markers).sort() }
        }
        const control = await run(false)
        const pinned = await run(true)
        process.stderr.write(
          `session-inplace.realquery: hooks ${label} control=${JSON.stringify(control)} pinned=${JSON.stringify(pinned)}\n`,
        )
        // The control proves the hooks are real and would run.
        expect(control.bash).toBeGreaterThan(0)
        expect(control.ran).toContain("pre-tool")
        // Under the flag layer's disableAllHooks none of them runs...
        expect(pinned.bash).toBeGreaterThan(0)
        expect(pinned.ran).toEqual([])
        // ...and the node's own SDK guard still sees the call.
        expect(pinned.seen).toContain("Bash")
      },
      RUN_MS * 2,
    )
  })
}

// D26b: which CLAUDE_CODE_ENTRYPOINT makes an owner session visible to the
// IDE and terminal pickers (listSessions includeProgrammatic:false) while
// streaming, canUseTool, the SDK PreToolUse hook and the Artifact tool hold.
// Printed per candidate; the chosen one (OWNER_SESSION_ENTRYPOINT) asserted.
// "sdk-ts" is the control: what the SDK sets when the variable is unset.
const ENTRYPOINT_CANDIDATES = ["sdk-ts", "cli", "claude-vscode", "liaison-node"] as const
for (const [label, binary, idBase] of [
  ["bundled", BUNDLED, "6a6a6a6a"],
  ["installed", INSTALLED, "6b6b6b6b"],
] as const) {
  describe.if(READY)(`session entrypoint for the pickers, ${label} CLI (D26b)`, () => {
    it(
      "S49: the owner entrypoint lists in the pickers and keeps streaming, canUseTool, hooks and Artifact",
      async () => {
        const results: Record<string, Record<string, unknown>> = {}
        for (const [i, entrypoint] of ENTRYPOINT_CANDIDATES.entries()) {
          const root = path.join(tmpBase, `ep-${label}-${entrypoint}`)
          const ownerConfig = path.join(root, "owner-claude")
          mkdirSync(ownerConfig, { recursive: true })
          const repo = scratchRepo(root)
          const id = `${idBase}-1111-4222-8333-44444444444${i}`
          const config = prepareSessionConfig({
            sessionId: id,
            configKind: "owner",
            level: "standard",
            realConfigDir: ownerConfig,
            dataDir: path.join(root, "data"),
          })
          const asked: string[] = []
          const seen: string[] = []
          const canUseTool: CanUseTool = async (t, input) => {
            asked.push(t)
            return { behavior: "allow", updatedInput: input }
          }
          // A write: never auto-allowed, so it reaches canUseTool.
          const messages = await streamed(
            "Run the Bash command `touch probe-file.txt` exactly once, then reply DONE.",
            {
              cwd: repo,
              pathToClaudeCodeExecutable: binary,
              env: cliEnv(config.dir, {
                CLAUDE_CODE_ENTRYPOINT: entrypoint,
                CLAUDE_CODE_ARTIFACT: "1",
              }),
              settingSources: [],
              permissionMode: "default",
              includePartialMessages: true,
              sessionId: id,
              hooks: { PreToolUse: [{ hooks: [sdkHook(seen)] }] },
              canUseTool,
            },
          )
          const init = messages.find((m) => m.type === "system" && m.subtype === "init")
          const file = path.join(ownerConfig, "projects", slug(realpathSync(repo)), `${id}.jsonl`)
          const line = existsSync(file)
            ? readFileSync(file, "utf8")
                .split("\n")
                .find((l) => l.includes('"entrypoint"'))
            : undefined
          const listed = await listAsOwner(ownerConfig, repo, false)
          results[entrypoint] = {
            transcriptEntrypoint: line
              ? (JSON.parse(line) as { entrypoint?: string }).entrypoint
              : null,
            listedInPicker: listed.some((s) => s.sessionId === id),
            streamEvents: messages.filter((m) => m.type === "stream_event").length,
            canUseTool: asked.includes("Bash"),
            sdkHook: seen.includes("Bash"),
            artifact: ((init?.tools as string[] | undefined) ?? []).includes("Artifact"),
            result: (messages.find((m) => m.type === "result") as { subtype?: string })?.subtype,
          }
        }
        process.stderr.write(
          `session-inplace.realquery: entrypoints ${label} ${JSON.stringify(results)}\n`,
        )
        const chosen = results[OWNER_SESSION_ENTRYPOINT] as Record<string, unknown>
        expect(chosen).toMatchObject({
          transcriptEntrypoint: OWNER_SESSION_ENTRYPOINT,
          listedInPicker: true,
          canUseTool: true,
          sdkHook: true,
          artifact: true,
          result: "success",
        })
        expect(chosen.streamEvents as number).toBeGreaterThan(0)
      },
      RUN_MS * 4,
    )
  })
}

// S48, S50.2 end to end: an owner dispatch at Standard on a shared repo runs
// through runUnattended in the folder itself (no worktree, no node/ branch),
// under the real sandbox the node generates: a commit on the folder's
// current branch lands; a write to .git/config is refused; the transcript is
// in the owner's projects under the folder's slug.
for (const [label, binary, idBase] of [
  ["bundled", BUNDLED, "7a7a7a7a"],
  ["installed", INSTALLED, "7b7b7b7b"],
] as const) {
  describe.if(READY)(`owner session in place through the node, ${label} CLI (S48, S50)`, () => {
    it(
      "S50: at Standard in place a commit lands on the session's own branch and .git/config is not written",
      async () => {
        const version = versionOf(binary) as string
        const root = path.join(tmpBase, `e2e-${label}`)
        const ownerConfig = path.join(root, "owner-claude")
        mkdirSync(ownerConfig, { recursive: true })
        const repo = scratchRepo(root)
        const configBefore = readFileSync(path.join(repo, ".git", "config"), "utf8")
        const headBefore = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"])
          .stdout.toString()
          .trim()
        const id = `${idBase}-1111-4222-8333-444444444444`
        const nodeRoot = path.join(root, "Liaison Node")
        // The guard refuses a command naming .git/config; a script writing it
        // meets the sandbox alone (S50.2).
        writeFileSync(
          path.join(root, "touch-config.sh"),
          `echo '[y]' >> '${path.join(repo, ".git", "config")}'\n`,
        )
        mkdirSync(nodeRoot, { recursive: true })
        const job: UnattendedJob = {
          jobId: `${idBase}-2222-4333-8444-555555555555`,
          server: "https://liaison.example",
          agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          agentName: "Personal",
          model: MODEL,
          profile: { level: "standard", liaisonTools: false },
          session: {
            id,
            source: "dispatch",
            model: MODEL,
            level: "standard",
            profileLevel: "standard",
            configKind: "owner",
            liaisonTools: false,
            folderPath: repo,
            folderName: "repo",
          },
          sharedFolders: [{ name: "repo", path: repo, kind: "repo" }],
          prompt: [
            "Run these two Bash commands, one at a time, and report each one's output:",
            "1. `echo hello > inplace.txt && git add inplace.txt && git commit -q -m inplace && git log --oneline -1`",
            "2. `echo '[x]' >> .git/config`",
            `3. \`sh '${path.join(root, "touch-config.sh")}'\``,
            "Then stop.",
          ].join("\n"),
          hardTokenLimit: null,
          nodeRoot,
        }
        const lines: Array<Record<string, unknown>> = []
        const outcome = await runUnattended({
          job,
          emit: (l) => lines.push(l),
          control: new AsyncQueue<string>(),
          cliPath: binary,
          npmPrefix: null,
          claudeBinary: { bundledVersion: version, run: async () => null },
          dataDir: path.join(root, "data"),
          realConfigDir: ownerConfig,
          stopGraceMs: 10_000,
        })
        const events = lines
          .filter((l) => l.type === "session_events")
          .flatMap((l) => l.events as Array<{ type: string; payload: Record<string, unknown> }>)
        const start = events.find((e) => e.type === "system" && e.payload.subtype === "start")
        const log = Bun.spawnSync(["git", "-C", repo, "log", "--format=%s", "-2"]).stdout.toString()
        const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list"]).stdout.toString()
        const configAfter = readFileSync(path.join(repo, ".git", "config"), "utf8")
        // The CLI's own session id (the node keeps it as the session's sdkSessionId).
        const projectDir = path.join(ownerConfig, "projects", slug(realpathSync(repo)))
        const jsonl = existsSync(projectDir)
          ? readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"))
          : []
        const file = path.join(projectDir, jsonl[0] ?? "none.jsonl")
        process.stderr.write(
          `session-inplace.realquery: e2e ${label} status=${outcome.status} cwd=${JSON.stringify(
            (start?.payload.data as Record<string, unknown> | undefined)?.cwd,
          )} log=${JSON.stringify(log)} branches=${JSON.stringify(branches)} configChanged=${
            configAfter !== configBefore
          } transcript=${existsSync(file)} refusals=${JSON.stringify(
            lines.filter((l) => l.type === "job_refusal"),
          )}\n`,
        )
        process.stderr.write(
          `session-inplace.realquery: e2e ${label} tools=${JSON.stringify(
            events
              .filter((e) => e.type === "tool_call" || e.type === "tool_result")
              .map((e) => JSON.stringify(e.payload).slice(0, 300)),
          )}\n`,
        )
        expect(outcome.status).toBe("done")
        // The commit landed in the folder, on the session's own branch: below
        // Open, in place on the default branch with a PR finish, the node
        // starts `liaison/<session>-<folder>` at run start (G4,
        // IN_PLACE_NEW_BRANCH_BELOW_OPEN), and main is left where it was.
        expect(log.split("\n")[0]).toBe("inplace")
        expect(
          Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD~1"]).stdout.toString().trim(),
        ).toBe(headBefore)
        expect(
          branches
            .split("\n")
            .map((b) => b.trim())
            .filter(Boolean),
        ).toEqual([`* liaison/${id.replace(/[^0-9a-z]/g, "").slice(0, 8)}-repo`, "main"])
        expect(
          Bun.spawnSync(["git", "-C", repo, "rev-parse", "main"]).stdout.toString().trim(),
        ).toBe(headBefore)
        expect(existsSync(path.join(nodeRoot, "worktrees"))).toBe(false)
        // .git/config is the owner's: never written by the session.
        expect(configAfter).toBe(configBefore)
        // The transcript is the owner's, under the folder's own slug.
        expect(jsonl).toHaveLength(1)
        const head = readFileSync(file, "utf8")
          .split("\n")
          .find((l) => l.includes('"entrypoint"'))
        expect(head ? (JSON.parse(head) as { entrypoint?: string }).entrypoint : null).toBe(
          OWNER_SESSION_ENTRYPOINT,
        )
      },
      RUN_MS * 2,
    )
  })
}
