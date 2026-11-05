// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE "AUTO" MODE: WHAT A LOCAL SESSION DOES WITHOUT ASKING.
//
// The pinned Agent SDK has a native `auto` permission mode, but it is not
// usable as Liaison's default: the CLI refuses it for Claude Haiku 4.5 (and
// the other 4.5 models), for plans without auto mode, and whenever its own
// remote config turns it off, and in each case it silently falls back to
// `default`, which asks for everything. A business analyst on Haiku 4.5 would
// still get an Allow / Deny card on the first read-only skill search.
//
// So Auto is decided here, deterministically, on every model and plan. The SDK
// runs in `acceptEdits` (file edits inside the session folder need no prompt,
// the CLI's own path checks bound that to the folder), and every call the SDK
// would still ask about comes through this policy first:
//
// - a Liaison MCP tool is allowed. Liaison enforces its own scopes, and a
//   gated tool still creates a pending approval a human decides on the server:
//   allowing the CALL is not approving the ACTION, and nothing here touches
//   that.
// - a shell command is allowed unless it is clearly destructive (see
//   `destructiveShellReason`), which still asks.
// - anything the CLI itself flagged as dangerous (`defaultToNo`), outside the
//   folder (`blockedPath`) or forced by a user's own ask rule still asks.
// - a file tool the CLI asked about only because it could not place a path
//   that IS inside the folder (see below) runs, as acceptEdits meant it to.
// - every other tool asks, exactly as Manual would.
//
// ONE FOLDER, SEVERAL SPELLINGS. On a Mac whose Documents folder lives on
// another volume, `/Users/me/Documents/X` and `/Volumes/Disk/me/Documents/X`
// are the same folder. The CLI realpaths its cwd, then compares a path that
// does not exist yet (the log a command is about to write) as spelled, so a
// harmless `python3 run.py > "/Users/me/Documents/X/run.log"` came back as
// `blockedPath` and Auto asked. Every containment check here is made on real
// paths (`isInsideFolder`), and a `blockedPath` that really is inside the
// folder is not a reason to ask.

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, basename as pathBasename, resolve, sep } from "node:path"

/** The name the sidecar registers the Liaison MCP server under (sdk-runner.ts). */
export const LIAISON_MCP_SERVER = "liaison"
const LIAISON_TOOL_PREFIX = `mcp__${LIAISON_MCP_SERVER}__`

/** The SDK's hints about why it asks, as far as this policy reads them. */
export interface AskContext {
  blockedPath?: string
  defaultToNo?: boolean
  matchedAskRule?: unknown
}

/**
 * What this policy knows about the session as a whole, beyond the one call.
 * `readOutsideText`: a tool result earlier in the session carried text written
 * outside the organisation (outside-text.ts). That text stays in the model's
 * context for the rest of the session, so from then on a shell command is a
 * question for a person, as in Manual: what the model was shown may be what
 * chose it.
 */
export interface SessionFacts {
  readOutsideText?: boolean
  /**
   * The origin of the Liaison server this session is bound to (`liaisonOrigin`),
   * whose own responses are not outside text: what it serves from outside the
   * organisation it fences itself. Null or absent: every fetch is outside.
   */
  ownOrigin?: string | null
}

/** True when Auto runs this call without asking the person. */
export function autoAllows(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  context: AskContext = {},
  session: SessionFacts = {},
): boolean {
  // The CLI's own guards win: a call it marked dangerous, one reaching outside
  // the folder, or one a user's ask rule forced is a question for a human. A
  // blocked path that resolves INSIDE the folder is the CLI misreading another
  // spelling of it, not a reach outside, so the call is judged on its merits.
  if (context.defaultToNo || context.matchedAskRule) return false
  if (context.blockedPath && !isPlainFolderPath(context.blockedPath, cwd)) return false
  if (toolName.startsWith(LIAISON_TOOL_PREFIX)) return true
  if (toolName === "Bash") {
    if (session.readOutsideText) return false
    const command = typeof input.command === "string" ? input.command : ""
    return (
      command.trim().length > 0 &&
      destructiveShellReason(command, cwd, session.ownOrigin ?? null) === null
    )
  }
  if (session.readOutsideText && editRunsLater(toolName, input, cwd)) return false
  // acceptEdits already runs these inside the folder without asking; the CLI
  // only asked because the path was spelled through a symlink.
  if (context.blockedPath && FOLDER_FILE_TOOLS.has(toolName)) return true
  return false
}

// ---------------------------------------------------------------------------
// FILES IN THE FOLDER THAT RUN LATER. After outside text, a model could plant
// code an innocent-looking later command runs: a git hook, a package script,
// a Makefile target, an `.envrc` direnv loads, a CI workflow, an editor task.
// Once the session read outside text, an edit of one of these asks, even
// inside the folder (the sidecar's PreToolUse guard, index.ts). Ordinary
// source edits keep running.

/** Tools that write a file, and the input field naming it. */
const FILE_WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
}

/** Directories whose files configure or run code rather than hold the work. */
const RUNNABLE_DIRS = new Set([
  ".git",
  ".husky",
  ".githooks",
  ".github",
  ".gitlab",
  ".circleci",
  ".buildkite",
  ".devcontainer",
  ".vscode",
  ".idea",
  ".claude",
  ".cursor",
  ".codex",
  ".gemini",
])

/** Files a build, a package manager, a test runner or the shell runs or reads as code. */
const RUNNABLE_FILES = new Set([
  "package.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "bunfig.toml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "tox.ini",
  "noxfile.py",
  "conftest.py",
  "Pipfile",
  "Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Justfile",
  ".justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "Rakefile",
  "Gemfile",
  "Cargo.toml",
  "build.rs",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "pom.xml",
  "CMakeLists.txt",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".envrc",
  ".env",
  ".gitattributes",
  ".gitmodules",
  ".pre-commit-config.yaml",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".travis.yml",
  "lefthook.yml",
  ".lefthook.yml",
])

/**
 * True when this tool call writes a file that runs or configures code later
 * (see above). A write tool with no readable path counts as one: fail closed.
 */
export function editRunsLater(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  const field = FILE_WRITE_TOOLS[toolName]
  if (!field) return false
  const path = input[field]
  if (typeof path !== "string" || path.length === 0) return true
  const absolute = realLocation(isAbsolute(path) ? path : resolve(cwd, path))
  const root = realLocation(cwd)
  const relative = absolute.startsWith(root + sep) ? absolute.slice(root.length + 1) : absolute
  const parts = relative.split(sep).filter(Boolean)
  const name = parts.at(-1) ?? ""
  if (RUNNABLE_FILES.has(name) || /^\.env\./.test(name)) return true
  return parts.slice(0, -1).some((part) => RUNNABLE_DIRS.has(part))
}

/**
 * True when a shell command reads from the network: a fetcher, a git command
 * that talks to a remote, a forge CLI, a remote shell, a package runner. Its
 * output is outside text (outside-text.ts). A fetch whose every URL is on the
 * session's own Liaison server (`fetchesOnlyFromOwnServer`) is not.
 */
export function readsFromNetwork(
  command: string,
  cwd: string,
  ownOrigin: string | null = null,
): boolean {
  for (const { words } of splitSegments(command)) {
    const { program, args } = programOf(words)
    if (!program) continue
    if (FETCHERS.has(program) && fetchesOnlyFromOwnServer(words, ownOrigin)) continue
    if (FETCHERS.has(program) || NETWORK_PROGRAMS.has(program)) return true
    if (program === "git" && args.some((arg) => GIT_NETWORK.has(arg))) return true
    if (packageRunnerReason(program, args, cwd) !== null) return true
    if (SHELLS.has(program)) {
      const flag = args.indexOf("-c")
      if (
        flag !== -1 &&
        args[flag + 1] !== undefined &&
        readsFromNetwork(args[flag + 1], cwd, ownOrigin)
      ) {
        return true
      }
    }
  }
  return false
}

/** Programs other than the fetchers whose output comes from elsewhere. */
const NETWORK_PROGRAMS = new Set(["gh", "glab", "ssh", "scp", "sftp", "nc", "ncat", "telnet"])

/** git subcommands that talk to a remote. */
const GIT_NETWORK = new Set(["fetch", "pull", "clone", "ls-remote", "submodule", "remote"])

/**
 * Directories inside a folder whose contents configure a tool rather than hold
 * the work: git hooks, the agent's own settings, editor tasks. A blocked path
 * in one of them still asks, whichever spelling it came in.
 */
const PROTECTED_DIRS = new Set([".git", ".claude", ".vscode", ".idea", ".husky"])

/** Inside the folder, and not inside one of its protected directories. */
function isPlainFolderPath(path: string, folder: string): boolean {
  if (!isInsideFolder(path, folder)) return false
  const root = realLocation(folder)
  const relative = realLocation(isAbsolute(path) ? path : resolve(folder, path)).slice(root.length)
  return !relative.split(sep).some((part) => PROTECTED_DIRS.has(part))
}

/** Tools acceptEdits runs inside the folder without asking. */
const FOLDER_FILE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
])

/**
 * A path's real location: symlinks resolved on the deepest part that exists,
 * the rest (a file about to be written) appended as spelled.
 */
export function realLocation(path: string): string {
  let head = resolve(path)
  const tail: string[] = []
  while (!existsSync(head)) {
    const parent = dirname(head)
    if (parent === head) break
    tail.unshift(pathBasename(head))
    head = parent
  }
  let real = head
  try {
    real = realpathSync(head)
  } catch {
    // Unreadable: compare as spelled, which can only make the check stricter.
  }
  return tail.length > 0 ? join(real, ...tail) : real
}

/** True when `path` is the folder or inside it, whichever spelling either uses. */
export function isInsideFolder(path: string, folder: string): boolean {
  const root = realLocation(folder)
  const target = realLocation(isAbsolute(path) ? path : resolve(folder, path))
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Every spelling of the session folder a command is likely to use: the path as
 * given, its real path, and the path through each symlink directly under the
 * filesystem root or the home directory that leads into it (`/tmp` and `/var`
 * on macOS, `~/Documents` on a relocated home). The SDK is handed the ones that
 * are not the CLI's own (real) cwd as additional directories, so the CLI's own
 * path checks accept them too.
 *
 * A candidate link is only ever read (`readlink`), never resolved: resolving
 * touches the target, and on macOS a link into Google Drive, iCloud or a
 * network volume (`/home` is an automount) raises a privacy prompt ("… wants to
 * access files managed by Google Drive") that blocks the session until someone
 * answers it. A link counts when its text, resolved against its parent, is a
 * spelling already found or a folder above one; the root is read first so a
 * home link written through `/tmp` still matches.
 */
export function folderSpellings(folder: string, home: string): string[] {
  const given = resolve(folder)
  const spellings = new Set([given, realLocation(given)])
  for (const parent of ["/", home]) {
    let entries: string[] = []
    try {
      entries = readdirSync(parent)
    } catch {
      continue
    }
    for (const entry of entries) {
      const link = join(parent, entry)
      let target: string
      try {
        if (!lstatSync(link).isSymbolicLink()) continue
        target = resolve(parent, readlinkSync(link))
      } catch {
        continue
      }
      for (const known of [...spellings]) {
        if (known === target || known.startsWith(target + sep)) {
          spellings.add(join(link, known.slice(target.length)))
        }
      }
    }
  }
  return [...spellings]
}

/** Commands that are never run without a human saying so, wherever they point. */
const ALWAYS_ASK = new Set([
  "sudo",
  "su",
  "doas",
  "mkfs",
  "dd",
  "shred",
  "diskutil",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "launchctl",
  "crontab",
  "chown",
])

/** Removers whose targets are checked against the folder. */
const REMOVERS = new Set(["rm", "rmdir", "unlink", "trash"])

/** Shells whose `-c` argument is itself a command to check. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"])

/**
 * Why a shell command is clearly destructive, or null when Auto may run it.
 * Deliberately conservative: anything it cannot resolve (a variable, a home
 * path, a directory change before a removal) asks rather than guesses.
 */
export function destructiveShellReason(
  command: string,
  cwd: string,
  ownOrigin: string | null = null,
): string | null {
  // Piping a download straight into a shell runs code nobody has read.
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/.test(command)) {
    return "pipes a download into a shell"
  }
  if (/:\s*\(\s*\)\s*\{/.test(command)) return "defines a fork bomb"
  if (/>\s*\/dev\/(disk|sd|nvme|rdisk)/.test(command)) return "writes to a raw disk"
  // A removal whose path is computed by the shell cannot be checked here.
  if (/`|\$\(/.test(command) && /\b(rm|rmdir|unlink|trash|shred)\b/.test(command)) {
    return "removes a path the shell computes"
  }

  // `${HOME}` reads as `$HOME`: the splitter cuts at braces.
  const segments = splitSegments(command.replace(/\$\{HOME\}/g, "$HOME"))
  const downloaded = downloadedCodeReason(command, segments, cwd, ownOrigin)
  if (downloaded) return downloaded
  // Where a later removal runs from. A `cd` into a path this can resolve moves
  // it; one it cannot resolve (a variable, `~`, `-`, no argument, or a cd
  // inside a subshell whose scope this does not track) makes it unknown, and
  // every removal after that asks.
  const subshell = /[(){}]/.test(command)
  let directory: string | null = resolve(cwd)
  for (const { words } of segments) {
    const { program, args, viaXargs } = programOf(words)
    // Checked before the program: a redirection can stand on its own segment
    // (`echo x &> file` splits at the `&`).
    for (const target of writeTargets(program, args, words)) {
      const what = startupFileKind(target, directory, cwd)
      if (what) return `writes to ${what} outside the session folder`
    }
    if (!program) continue
    if (ALWAYS_ASK.has(program)) return `runs ${program}`
    if (program === "eval") return "evaluates a constructed command"
    if (SHELLS.has(program)) {
      const flag = args.indexOf("-c")
      if (flag !== -1 && args[flag + 1] !== undefined) {
        const inner = destructiveShellReason(args[flag + 1], cwd, ownOrigin)
        if (inner) return inner
      }
      continue
    }
    if (program === "cd" || program === "pushd") {
      const destination = args.find((arg) => !arg.startsWith("-"))
      directory =
        directory === null || subshell || destination === undefined || /[$`~]/.test(destination)
          ? null
          : resolve(directory, destination)
      continue
    }
    if (program === "chmod" && args.some((arg) => /^-\w*R/.test(arg))) {
      return "changes permissions recursively"
    }
    if (
      program === "find" &&
      args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir")
    ) {
      if (args.includes("-delete") || args.some((arg) => REMOVERS.has(basename(arg)))) {
        return "deletes files through find"
      }
    }
    if (program === "git") {
      const joined = args.join(" ")
      if (/\bpush\b.*(--force\b|-f\b|--force-with-lease\b|--mirror\b|--delete\b)/.test(joined)) {
        return "force-pushes or deletes a remote branch"
      }
      if (/\breset\b.*--hard\b/.test(joined)) return "discards work with git reset --hard"
      if (/\bclean\b.*-\w*f/.test(joined)) return "deletes untracked files with git clean"
    }
    if (REMOVERS.has(program)) {
      if (viaXargs) return `runs ${program} on paths piped in`
      const targets = args.filter((arg) => !arg.startsWith("-"))
      if (targets.length === 0) continue
      if (directory === null)
        return `runs ${program} after changing to a directory it cannot resolve`
      // Real paths on both sides: the folder may be addressed through a symlink.
      const root = realLocation(cwd)
      for (const target of targets) {
        if (/[$`~]/.test(target)) return `runs ${program} on a path it cannot resolve`
        const absolute = realLocation(isAbsolute(target) ? target : resolve(directory, target))
        if (absolute === root || !isInsideFolder(absolute, cwd)) {
          return `runs ${program} outside the session folder`
        }
      }
    }
  }
  return null
}

/** Shell keywords a simple command may follow in a compound one (`do curl …`). */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"])

/** The program a simple command runs, past environment assignments and wrappers. */
function programOf(words: string[]): { program: string; args: string[]; viaXargs: boolean } {
  let index = 0
  let viaXargs = false
  // Leading environment assignments, wrappers that run the next word, and the
  // keywords of a loop or a condition.
  while (
    index < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) ||
      SHELL_KEYWORDS.has(words[index]) ||
      ["env", "command", "nohup", "time", "exec", "xargs", "nice"].includes(words[index]))
  ) {
    if (words[index] === "xargs") viaXargs = true
    index++
  }
  return { program: basename(words[index] ?? ""), args: words.slice(index + 1), viaXargs }
}

// ---------------------------------------------------------------------------
// CODE FROM THE NETWORK. A session in Auto reads text written by outsiders
// (mail, tickets, web pages, through its Liaison tools), and such text can ask
// for a command. Whatever it asks for, a command that fetches something and
// then runs what it fetched is a question for a person: the code it runs was
// never shown to anyone. A fetch that only saves a file, or feeds data to a
// script that is already in the folder, still runs.

/** Programs that fetch from the network. */
const FETCHERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c", "curlie"])

/** Programs that run the code they are given, and the flags that give it inline. */
const INTERPRETERS: Array<{ match: RegExp; inline: string[] }> = [
  { match: /^(ba|z|da|fi|k|c|tc)?sh$/, inline: ["-c"] },
  { match: /^(python[0-9.]*|pypy[0-9.]*)$/, inline: ["-c", "-m"] },
  { match: /^(node|nodejs|tsx|ts-node)$/, inline: ["-e", "--eval", "-p", "--print"] },
  { match: /^(deno|bun)$/, inline: ["-e", "--eval"] },
  { match: /^perl[0-9.]*$/, inline: ["-e", "-E"] },
  { match: /^(ruby|irb|lua|luajit|osascript|Rscript)$/, inline: ["-e"] },
  { match: /^php[0-9.]*$/, inline: ["-r"] },
  { match: /^(pwsh|powershell)$/, inline: ["-c", "-command", "-Command"] },
]

function interpreter(program: string): { inline: string[] } | null {
  return INTERPRETERS.find((entry) => entry.match.test(program)) ?? null
}

/** `source file` and `. file` run the file in the current shell. */
const SOURCERS = new Set(["source", "."])

/**
 * The file an interpreter would run, `"-"` when it reads its program from
 * standard input, or null when the program is given inline (`-c`, `-e`, `-m`).
 */
function programSource(program: string, args: string[]): string | null {
  if (SOURCERS.has(program)) return args[0] ?? "-"
  const kind = interpreter(program)
  if (!kind) return null
  if (/sh$/.test(program) && args.includes("-s")) return "-"
  for (const arg of args) {
    if (kind.inline.some((flag) => arg === flag || (flag.length === 2 && arg.startsWith(flag)))) {
      return null
    }
    if (arg === "-") return "-"
    if (!arg.startsWith("-")) return arg
  }
  return "-"
}

/** Code an interpreter is given inline (`-c`, `-e`, `-r`…), or null. */
function inlineCode(program: string, args: string[]): string | null {
  // A shell's `-c` is checked as a command of its own (destructiveShellReason).
  if (SHELLS.has(program)) return null
  const kind = interpreter(program)
  if (!kind) return null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const flag = kind.inline.find(
      (f) => f !== "-m" && (arg === f || (f.length === 2 && arg.startsWith(f))),
    )
    if (flag) return arg === flag ? (args[i + 1] ?? "") : arg.slice(flag.length)
    if (!arg.startsWith("-")) return null
  }
  return null
}

/** Inline code that reaches the network or evaluates a string as code. */
const INLINE_FETCH_OR_EVAL =
  /urlopen|urllib|requests\.|httpx|http\.client|fetch\s*\(|https?:\/\/|\bhttps?\.(get|request)|net\/http|open-uri|Net::HTTP|LWP|HTTP::Tiny|IO::Socket|socket\.|\beval\b|\bexec\b|child_process|\bsystem\s*\(|`/

/**
 * Why a package runner would fetch and run code, or null. `npx`/`bunx` of a
 * package already installed in the folder (`node_modules/.bin`) runs that
 * install, not a download, and keeps running.
 */
function packageRunnerReason(program: string, args: string[], cwd: string): string | null {
  const operands = args.filter((arg) => !arg.startsWith("-"))
  const first = operands[0]
  const localBin = (name: string | undefined) =>
    name !== undefined &&
    !name.includes("@", 1) &&
    existsSync(join(cwd, "node_modules", ".bin", basename(name)))
  if (program === "npx" || program === "bunx" || program === "pnpx") {
    return localBin(first) ? null : `runs a package through ${program}`
  }
  if (program === "npm" && (first === "exec" || first === "x")) {
    return localBin(operands[1]) ? null : "runs a package through npm exec"
  }
  if ((program === "pnpm" || program === "yarn" || program === "bun") && first === "dlx") {
    return `runs a package through ${program} dlx`
  }
  if (program === "bun" && first === "x") {
    return localBin(operands[1]) ? null : "runs a package through bun x"
  }
  if (program === "uvx" || (program === "pipx" && first === "run")) {
    return `runs a package through ${program}`
  }
  if (program === "uv" && first === "tool" && operands[1] === "run")
    return "runs a package through uv"
  const fromUrl = (arg: string) => /:\/\/|^git\+|^git@/.test(arg)
  if (/^pip[0-9.]*$/.test(program) && first === "install" && args.some(fromUrl)) {
    return "installs a package from a URL"
  }
  if (
    /^python[0-9.]*$/.test(program) &&
    args.includes("pip") &&
    args.includes("install") &&
    args.some(fromUrl)
  ) {
    return "installs a package from a URL"
  }
  if (program === "uv" && first === "pip" && args.some(fromUrl))
    return "installs a package from a URL"
  if (
    program === "go" &&
    (first === "run" || first === "install") &&
    operands.slice(1).some((a) => a.includes("@"))
  ) {
    return `runs go ${first} of a remote module`
  }
  if (
    program === "cargo" &&
    first === "install" &&
    args.some((a) => a === "--git" || a.startsWith("--git="))
  ) {
    return "installs a crate from git"
  }
  if (program === "deno" && operands.some((a) => /^(https?|npm|jsr):/.test(a))) {
    return "runs remote code through deno"
  }
  return null
}

/** A fetch or a command substitution opened right before a fetcher. */
const FETCH_IN_SUBSTITUTION =
  /(\$\(|`|<\(|>\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:env\s+|command\s+)?(?:\S*\/)?(?:curl|wget|fetch|https?|xh|aria2c|curlie)\b/

/** Why a command runs code it fetched, or null. */
function downloadedCodeReason(
  command: string,
  segments: Segment[],
  cwdForRunners: string,
  ownOrigin: string | null,
): string | null {
  const parsed = segments.map((segment) => ({ ...segment, ...programOf(segment.words) }))
  // 0. A package runner fetches a package and runs it in one step
  //    (`npx some-tool`, `uvx tool`, `pip install git+https://…`), and an
  //    interpreter given inline code that fetches or evaluates code.
  for (const { program, args } of parsed) {
    const runner = packageRunnerReason(program, args, cwdForRunners)
    if (runner) return runner
    const inline = inlineCode(program, args)
    if (inline !== null && INLINE_FETCH_OR_EVAL.test(inline)) {
      return `runs inline ${program} code that fetches or evaluates code`
    }
  }
  // 1. A fetch piped (through anything) into a program that reads its code
  //    from standard input: `curl … | python3`, `wget -O- … | gunzip | sh`.
  let fetching = false
  for (const { program, args, piped } of parsed) {
    if (!piped) fetching = false
    if (FETCHERS.has(program)) {
      fetching = true
      continue
    }
    if (fetching && programSource(program, args) === "-") {
      return `pipes a download into ${program}`
    }
  }
  // 2. A fetch inside `$(…)`, backticks or `<(…)` in a command that also runs
  //    an interpreter: `bash -c "$(curl …)"`, `source <(curl …)`.
  if (FETCH_IN_SUBSTITUTION.test(command)) {
    const runner = parsed.find(
      ({ program }) => interpreter(program) !== null || SOURCERS.has(program),
    )
    if (runner) return `runs a download through ${runner.program}`
  }
  // 3. A fetch saved to a file, and that file then run, sourced or made
  //    executable: `curl -o i.sh … && sh i.sh`, `curl … > i && chmod +x i && ./i`.
  //    A file fetched from the session's own Liaison server is the
  //    organisation's own, as a file already in the folder is.
  const saved = parsed.flatMap(({ program, args, words }) =>
    FETCHERS.has(program) && !fetchesOnlyFromOwnServer(words, ownOrigin)
      ? fetchOutputs(program, args, words)
      : [],
  )
  if (saved.length > 0) {
    // A download named by the shell (`-o "$f"` in a loop) could be any file:
    // then every file the command runs may be one it downloaded.
    const unnamed = saved.some((output) => /[$`]/.test(output))
    const isSaved = (word: string) => {
      const name = fileName(word)
      return name !== null && (unnamed || saved.some((output) => fileName(output) === name))
    }
    for (const { program, args, words } of parsed) {
      if (!program || FETCHERS.has(program)) continue
      const spelled = words.find((word) => basename(word) === program) ?? program
      if (spelled.includes("/") && isSaved(spelled)) return "runs a file it downloaded"
      const source = programSource(program, args)
      if (source && source !== "-" && isSaved(source)) return "runs a file it downloaded"
      if (program === "chmod" && args.some(isSaved)) return "makes a downloaded file executable"
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// THE SESSION'S OWN SERVER. A fetch from the Liaison server the session is
// bound to reads the organisation's own data: the server fences whatever in it
// came from outside. Only a fetch this can read entirely counts: curl, or wget
// told not to follow a redirect, spelled bare and run directly (no
// environment, wrapper or xargs before it), with only the flags listed here, and every URL an https
// URL spelled literally on exactly that origin (scheme, host and port). A
// redirect follow, a proxy, another CA, a config file, an unknown flag, an
// http URL, a host the shell computes or a second host: a fetch like any other.

/** The https origin of a Liaison server URL, or null for anything else. */
export function liaisonOrigin(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.origin
      : null
  } catch {
    return null
  }
}

/** curl's flags this reads: those without a value, and those taking one. */
const CURL_FLAGS = {
  bare: new Set([
    "--fail",
    "--fail-with-body",
    "--fail-early",
    "--silent",
    "--show-error",
    "--remote-name",
    "--remote-name-all",
    "--create-dirs",
    "--compressed",
    "--verbose",
    "--include",
    "--head",
    "--get",
    "--progress-bar",
    "--no-progress-meter",
    "--remote-time",
    "--http1.1",
    "--http2",
    "--retry-all-errors",
  ]),
  valued: new Set([
    "--output",
    "--output-dir",
    "--header",
    "--request",
    "--data",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "--json",
    "--form",
    "--form-string",
    "--user-agent",
    "--write-out",
    "--max-time",
    "--connect-timeout",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--continue-at",
    "--range",
    "--upload-file",
    "--oauth2-bearer",
    "--user",
    "--cookie",
    "--cookie-jar",
    "--time-cond",
    "--referer",
  ]),
  shortBare: "fsSOJRiIGv#",
  shortValued: "oHXdFAwmCrTubcze",
}

/** wget's, likewise. `--max-redirect` is read on its own: it must be 0. */
const WGET_FLAGS = {
  bare: new Set([
    "--quiet",
    "--no-verbose",
    "--verbose",
    "--continue",
    "--timestamping",
    "--no-clobber",
    "--https-only",
    "-nv",
    "-nc",
  ]),
  valued: new Set([
    "--output-document",
    "--directory-prefix",
    "--header",
    "--user-agent",
    "--timeout",
    "--tries",
    "--method",
    "--body-data",
    "--post-data",
    "--output-file",
    "--append-output",
  ]),
  shortBare: "qvcN",
  shortValued: "OPUTtoa",
}

/** True when `word` is an https URL literally on `origin`; the path may hold a variable. */
function onOwnOrigin(word: string, origin: string): boolean {
  if (/`|\$\(/.test(word)) return false
  const authority = /^https:\/\/([A-Za-z0-9.-]+(?::[0-9]+)?)(?=[/?#]|$)/.exec(word)
  if (!authority) return false
  try {
    return new URL(`https://${authority[1]}/`).origin === origin
  } catch {
    return false
  }
}

/**
 * True when a fetcher's words (one simple command) fetch only from `origin`,
 * by the rules above. False whenever there is any doubt.
 */
export function fetchesOnlyFromOwnServer(words: string[], origin: string | null): boolean {
  if (!origin) return false
  let index = 0
  while (index < words.length && SHELL_KEYWORDS.has(words[index])) index++
  // Spelled bare: `./curl` is a script in the folder, not the fetcher.
  const program = words[index] ?? ""
  const flags = program === "curl" ? CURL_FLAGS : program === "wget" ? WGET_FLAGS : null
  if (!flags) return false
  const args = words.slice(index + 1)
  const urls: string[] = []
  let noRedirect = program === "curl"
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") {
      urls.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith("--")) {
      const [flag, inline] = arg.split(/=(.*)/s, 2)
      if (program === "curl" && flag === "--url") {
        const value = inline ?? args[++i]
        if (value === undefined) return false
        urls.push(value)
      } else if (program === "wget" && flag === "--max-redirect") {
        if ((inline ?? args[++i]) !== "0") return false
        noRedirect = true
      } else if (flags.bare.has(flag)) {
        if (inline !== undefined) return false
      } else if (flags.valued.has(flag)) {
        if (inline === undefined && args[++i] === undefined) return false
      } else {
        return false
      }
      continue
    }
    if (flags.bare.has(arg)) continue
    if (arg.startsWith("-") && arg.length > 1) {
      // A cluster of short flags; a valued one takes the rest, or the next word.
      const cluster = arg.slice(1)
      for (let c = 0; c < cluster.length; c++) {
        const letter = cluster[c] as string
        if (flags.shortBare.includes(letter)) continue
        if (!flags.shortValued.includes(letter)) return false
        if (c === cluster.length - 1 && args[++i] === undefined) return false
        break
      }
      continue
    }
    urls.push(arg)
  }
  return noRedirect && urls.length > 0 && urls.every((url) => onOwnOrigin(url, origin))
}

/** The last path part a word names, or null for standard output and the like. */
function fileName(word: string): string | null {
  const trimmed = word.replace(/[?#].*$/, "").replace(/\/+$/, "")
  const name = basename(trimmed)
  return name && name !== "-" && name !== "." && name !== ".." ? name : null
}

/** Where a fetch writes what it fetched (as spelled), as far as its flags say. */
function fetchOutputs(program: string, args: string[], words: string[]): string[] {
  const outputs = redirectTargets(words)
  const urls = args.filter((arg) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg))
  let remoteName = program === "fetch" || program === "aria2c"
  let explicit = false
  const output = (value: string | undefined) => {
    if (value !== undefined) {
      outputs.push(value)
      explicit = true
    }
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("--")) {
      const [flag, inlineValue] = arg.split(/=(.*)/s, 2)
      if (flag === "--output" || flag === "--output-document" || flag === "--out") {
        output(inlineValue ?? args[++i])
      } else if (
        flag === "--remote-name" ||
        flag === "--remote-name-all" ||
        flag === "--download"
      ) {
        remoteName = true
      }
      continue
    }
    if (!/^-[A-Za-z0-9#]+/.test(arg)) continue
    // A cluster of short flags: `-fsSLo out`, `-qO-`, `-oout`.
    const cluster = arg.slice(1)
    const outFlag = program === "wget" ? "O" : "o"
    const at = cluster.indexOf(outFlag)
    if (at !== -1) {
      const rest = cluster.slice(at + 1)
      output(rest.length > 0 ? rest : args[++i])
    } else if (program !== "wget" && cluster.includes("O")) {
      remoteName = true
    } else if (
      (program === "http" || program === "https" || program === "xh") &&
      cluster.includes("d")
    ) {
      remoteName = true
    }
  }
  // wget saves under the URL's own name unless told otherwise.
  if (program === "wget" && !explicit) remoteName = true
  if (remoteName) outputs.push(...urls.map((url) => url.replace(/^[^:]+:\/\/[^/]*/, "")))
  return outputs
}

/** The targets of `>`, `>>`, `>|` (and their numbered forms) in a command's words. */
function redirectTargets(words: string[]): string[] {
  const targets: string[] = []
  for (let i = 0; i < words.length; i++) {
    const match = /^(?:\d|&)?>>?\|?(.*)$/s.exec(words[i])
    if (!match) continue
    const target = match[1].length > 0 ? match[1] : words[i + 1]
    if (target !== undefined && !target.startsWith("&")) targets.push(target)
  }
  return targets
}

// ---------------------------------------------------------------------------
// FILES THAT RUN LATER. A login script, an SSH key, a launch agent or another
// agent's settings is code or trust the next shell, login or session picks up
// unseen. A shell command writing one outside the session folder asks.

/** Files a shell or a login reads, by name, wherever they are. */
const STARTUP_FILES = new Set([
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".bash_aliases",
  ".profile",
  ".kshrc",
  ".cshrc",
  ".tcshrc",
  ".login",
  ".gitconfig",
  ".envrc",
])

/** Directories whose contents run, log in or configure an agent, by name. */
const STARTUP_DIRS: Record<string, string> = {
  ".ssh": "SSH settings",
  ".gnupg": "GPG settings",
  ".aws": "cloud credentials settings",
  ".kube": "cluster credentials settings",
  ".docker": "Docker settings",
  LaunchAgents: "a launch agent",
  LaunchDaemons: "a launch daemon",
  StartupItems: "a startup item",
  autostart: "an autostart entry",
  ".claude": "agent settings",
  ".codex": "agent settings",
  ".gemini": "agent settings",
  ".cursor": "agent settings",
}

/** The files a simple command writes, as spelled. */
function writeTargets(program: string, args: string[], words: string[]): string[] {
  const targets = redirectTargets(words)
  const operands = args.filter((arg) => !arg.startsWith("-"))
  if (program === "tee") targets.push(...operands)
  // `sed -i` edits its files in place; its first operand is the script.
  if (
    program === "sed" &&
    args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))
  ) {
    targets.push(...operands)
  }
  if (["cp", "mv", "ln", "install", "rsync", "ditto", "scp"].includes(program)) {
    const last = operands.at(-1)
    if (last !== undefined) targets.push(last)
  }
  return targets
}

/**
 * What kind of startup or agent file a write target is, when it is one and
 * lies outside the session folder; null otherwise. `~` and `$HOME` are read as
 * the home directory; a relative path after a `cd` this cannot follow is
 * judged by its name alone, as if outside.
 */
function startupFileKind(target: string, directory: string | null, cwd: string): string | null {
  let path = target
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1))
  else path = path.replace(/^\$HOME(?=\/|$)/, homedir())
  const absolute = isAbsolute(path) ? path : directory !== null ? resolve(directory, path) : null
  if (absolute !== null && isInsideFolder(absolute, cwd)) return null
  const parts = (absolute ?? path).split(/[\\/]+/)
  const name = parts.at(-1) ?? ""
  if (STARTUP_FILES.has(name)) return `a login script (${name})`
  for (const part of parts) {
    const kind = STARTUP_DIRS[part]
    if (kind) return kind
  }
  const spelled = absolute ?? path
  if (/^\/(private\/)?etc\//.test(spelled)) return "system settings"
  if (/\/\.config\/(fish|systemd)\//.test(spelled)) return "a login script"
  if (/^\/(private\/)?var\/(at|spool\/cron)\/|^\/usr\/lib\/cron\//.test(spelled)) return "a crontab"
  return null
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/")
  return slash === -1 ? word : word.slice(slash + 1)
}

/** One simple command: its words, and whether a `|` feeds it the previous one's output. */
interface Segment {
  words: string[]
  piped: boolean
}

/**
 * Splits a command line into the words of each simple command, on `;`, `&&`,
 * `||`, `|`, `&`, newlines and `$(`/backtick boundaries. Quotes are honoured,
 * so `sh -c "rm -rf /"` keeps its argument as one word for the recursive check.
 * Not a shell parser: good enough to find the program of each command, and
 * anything odd it produces errs towards more segments, not fewer. A segment
 * after a single `|` (or `|&`) is marked as reading the previous one's output.
 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ""
  let hasWord = false
  let quote: '"' | "'" | null = null
  let piped = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ""
    hasWord = false
  }
  const endSegment = (pipeFollows: boolean) => {
    endWord()
    if (words.length > 0) {
      segments.push({ words, piped })
      words = []
      piped = pipeFollows
    } else {
      // An empty segment (`a | | b` is not a pipe into b, `$(` right after a
      // separator) keeps whatever the separator before it said.
      piped = piped || pipeFollows
    }
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) quote = null
      else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
    } else if (char === "\\" && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
    } else if (char === " " || char === "\t") {
      endWord()
    } else if (char === "|") {
      if (command[i + 1] === "|") {
        i++
        endSegment(false)
      } else {
        if (command[i + 1] === "&") i++
        endSegment(true)
      }
    } else if (";&\n`(){}".includes(char)) {
      endSegment(false)
    } else if (char === "$" && command[i + 1] === "(") {
      endSegment(false)
      i++
    } else {
      word += char
      hasWord = true
    }
  }
  endSegment(false)
  return segments
}
