// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The import listing and the start check (W3 T05; S40, S42, S43, A42, A47,
// A50, A56, OPEN-10). Every case builds its own owner config dir and shared
// folders under a scratch dir and points CLAUDE_CONFIG_DIR at it for the
// duration of the case (set and restore): the real ~/.claude is never read
// or written. Keys are assembled at runtime, never written literally.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { DriverProbe } from "./session-driver"
import {
  checkImport,
  findTranscript,
  type ImportFolder,
  importMain,
  listImportable,
  slugOf,
} from "./session-import"

const HEAD = 64 * 1024
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "liaison-import-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
function scratch(): string {
  const dir = path.join(base, `c${++n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const savedEnv = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedEnv
})
/** The SDK reads CLAUDE_CONFIG_DIR at call time: point it at the fixture config. */
function useConfig(configDir: string): void {
  process.env.CLAUDE_CONFIG_DIR = configDir
}

function uuid(i: number): string {
  const hex = i.toString(16).padStart(12, "0")
  return `0000aaaa-0000-4000-8000-${hex}`
}

interface SessionFixture {
  cwd: string
  id: string
  entrypoint?: string
  title?: string
  prompt?: string
  branch?: string
  model?: string
  /** ms since epoch; default ten minutes ago. */
  mtimeMs?: number
  /** The project dir name; default slugOf(cwd). */
  dirName?: string
}

function sessionLines(o: SessionFixture): string {
  const ts = new Date((o.mtimeMs ?? Date.now() - 600_000) - 5_000).toISOString()
  const common = {
    cwd: o.cwd,
    sessionId: o.id,
    version: "2.1.296",
    gitBranch: o.branch ?? "main",
    entrypoint: o.entrypoint ?? "claude-vscode",
    timestamp: ts,
  }
  const lines: unknown[] = [
    {
      type: "user",
      isSidechain: false,
      parentUuid: null,
      uuid: `${o.id.slice(0, 30)}01`,
      message: { role: "user", content: o.prompt ?? "please fix the tests" },
      ...common,
    },
    {
      type: "assistant",
      isSidechain: false,
      parentUuid: `${o.id.slice(0, 30)}01`,
      uuid: `${o.id.slice(0, 30)}02`,
      message: {
        role: "assistant",
        model: o.model ?? "claude-haiku-5-5",
        content: [{ type: "text", text: "done" }],
      },
      ...common,
    },
  ]
  if (o.title !== undefined)
    lines.push({ type: "custom-title", customTitle: o.title, sessionId: o.id })
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`
}

function writeSession(configDir: string, o: SessionFixture): string {
  const dir = path.join(configDir, "projects", o.dirName ?? slugOf(o.cwd))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${o.id}.jsonl`)
  writeFileSync(file, sessionLines(o))
  const t = (o.mtimeMs ?? Date.now() - 600_000) / 1000
  utimesSync(file, t, t)
  return file
}

/** No registry, no process table: only the recent write counts. */
const quietProbe: DriverProbe = {
  platform: "test",
  mtimeMs: () => null,
  registry: () => [],
  processes: () => null,
}

function setup(): { configDir: string; shared: string; folders: ImportFolder[] } {
  const root = scratch()
  const configDir = path.join(root, "owner-config")
  mkdirSync(path.join(configDir, "projects"), { recursive: true })
  const shared = path.join(root, "x", "foo")
  mkdirSync(shared, { recursive: true })
  useConfig(configDir)
  return { configDir, shared, folders: [{ name: "foo", path: shared }] }
}

async function list(
  s: { configDir: string; folders: ImportFolder[] },
  extra: { query?: string; probe?: DriverProbe } = {},
) {
  return listImportable({
    configDir: s.configDir,
    folders: s.folders,
    now: Date.now(),
    probe: extra.probe ?? quietProbe,
    query: extra.query,
  })
}

const ids = (rows: { sdkSessionId: string }[]) => rows.map((r) => r.sdkSessionId).sort()

/** A key that a scanner recognises, built at runtime (never a literal in the repo). */
const runtimeKey = () => `${["sk", "ant", "api03"].join("-")}-${"Q7x".repeat(30)}`

describe("listImportable (S40, A42)", () => {
  it("S40, D53: sessions in the shared folder, its subfolder and the shared repo's own git worktree outside it (and that worktree's subfolder) are listed; one in a sibling prefix folder (/x/foo-bar for /x/foo) and one in an unshared folder are not", async () => {
    const s = setup()
    const root = path.dirname(path.dirname(s.shared))
    const sub = path.join(s.shared, "sub")
    const sibling = path.join(root, "x", "foo-bar")
    const unshared = path.join(root, "other")
    const worktree = path.join(root, "wt-outside")
    for (const d of [sub, sibling, unshared]) mkdirSync(d, { recursive: true })
    const git = (...a: string[]) => execFileSync("git", ["-C", s.shared, ...a], { stdio: "ignore" })
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i")
    git("worktree", "add", "-q", worktree)
    const worktreeSub = path.join(worktree, "pkg")
    mkdirSync(worktreeSub)
    writeSession(s.configDir, { cwd: s.shared, id: uuid(1) })
    writeSession(s.configDir, { cwd: sub, id: uuid(2) })
    writeSession(s.configDir, { cwd: sibling, id: uuid(3) })
    writeSession(s.configDir, { cwd: worktree, id: uuid(4) })
    writeSession(s.configDir, { cwd: unshared, id: uuid(5) })
    writeSession(s.configDir, { cwd: worktreeSub, id: uuid(6) })
    const answer = await list(s)
    expect(ids(answer.rows)).toEqual([uuid(1), uuid(2), uuid(4), uuid(6)])
    const where = Object.fromEntries(
      answer.rows.map((r) => [r.sdkSessionId, [r.worktreePath ?? null, r.cwdSubdir]]),
    )
    expect(where).toEqual({
      [uuid(1)]: [null, ""],
      [uuid(2)]: [null, "sub"],
      [uuid(4)]: [worktree, ""],
      [uuid(6)]: [worktree, "pkg"],
    })
    expect(answer.truncated).toBe(false)
    expect(answer.rows.every((r) => r.folderName === "foo" && r.from === "vscode")).toBe(true)
  })

  it("S40: a project dir that is a symlink into a shared folder's slug is skipped", async () => {
    const s = setup()
    const sub = path.join(s.shared, "evil")
    mkdirSync(sub)
    const elsewhere = path.join(path.dirname(s.configDir), "elsewhere-projects", "d")
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(path.join(elsewhere, `${uuid(7)}.jsonl`), sessionLines({ cwd: sub, id: uuid(7) }))
    symlinkSync(elsewhere, path.join(s.configDir, "projects", slugOf(sub)))
    writeSession(s.configDir, { cwd: s.shared, id: uuid(8) })
    expect(ids((await list(s)).rows)).toEqual([uuid(8)])
  })

  it("S40: a transcript that is a symlink to a file elsewhere is skipped", async () => {
    const s = setup()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(10) })
    const outside = path.join(path.dirname(s.configDir), "outside.jsonl")
    writeFileSync(outside, sessionLines({ cwd: s.shared, id: uuid(11) }))
    symlinkSync(outside, path.join(s.configDir, "projects", slugOf(s.shared), `${uuid(11)}.jsonl`))
    // T04: most *.jsonl of a real home are dangling symlinks; they are skipped too.
    symlinkSync(
      path.join(s.configDir, "gone.jsonl"),
      path.join(s.configDir, "projects", slugOf(s.shared), `${uuid(12)}.jsonl`),
    )
    expect(ids((await list(s)).rows)).toEqual([uuid(10)])
  })

  it("S40: a shared folder given through a symlink lists by its real path; a session whose cwd is a symlink resolving outside the folder is not listed", async () => {
    const s = setup()
    const link = path.join(path.dirname(s.configDir), "link-to-foo")
    symlinkSync(s.shared, link)
    const outside = path.join(path.dirname(s.configDir), "outside")
    mkdirSync(outside)
    const outLink = path.join(s.shared, "out")
    symlinkSync(outside, outLink)
    writeSession(s.configDir, { cwd: s.shared, id: uuid(20) })
    writeSession(s.configDir, { cwd: outLink, id: uuid(21) })
    const answer = await listImportable({
      configDir: s.configDir,
      folders: [{ name: "foo", path: link }],
      now: Date.now(),
      probe: quietProbe,
    })
    expect(ids(answer.rows)).toEqual([uuid(20)])
  })

  it("m3: a shared folder given through a symlinked parent lists by slug(realF)", async () => {
    const s = setup()
    const parentLink = path.join(path.dirname(s.configDir), "docs-link")
    symlinkSync(path.dirname(s.shared), parentLink)
    writeSession(s.configDir, { cwd: s.shared, id: uuid(22) })
    const answer = await listImportable({
      configDir: s.configDir,
      folders: [{ name: "foo", path: path.join(parentLink, "foo") }],
      now: Date.now(),
      probe: quietProbe,
    })
    expect(ids(answer.rows)).toEqual([uuid(22)])
  })

  it("m3: one slug dir holding sessions of /a/foo-bar and /a/foo/bar (both shared) lists both", async () => {
    const s = setup()
    const a = path.dirname(s.shared)
    const dashed = path.join(a, "foo-bar")
    const nested = path.join(s.shared, "bar")
    mkdirSync(dashed)
    mkdirSync(nested)
    expect(slugOf(dashed)).toBe(slugOf(nested))
    writeSession(s.configDir, { cwd: dashed, id: uuid(30), mtimeMs: Date.now() - 700_000 })
    writeSession(s.configDir, { cwd: nested, id: uuid(31), mtimeMs: Date.now() - 600_000 })
    const answer = await listImportable({
      configDir: s.configDir,
      folders: [
        { name: "foo", path: s.shared },
        { name: "foo-bar", path: dashed },
      ],
      now: Date.now(),
      probe: quietProbe,
    })
    expect(answer.rows.map((r) => [r.sdkSessionId, r.folderName, r.cwdSubdir])).toEqual([
      [uuid(31), "foo", "bar"],
      [uuid(30), "foo-bar", ""],
    ])
  })

  it("S40: a liaison-node session is listed with from liaison; an sdk-ts one is not listed", async () => {
    const s = setup()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(40), entrypoint: "liaison-node" })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(41), entrypoint: "sdk-ts" })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(42), entrypoint: "cli" })
    const answer = await list(s)
    expect(answer.rows.map((r) => [r.sdkSessionId, r.from]).sort()).toEqual([
      [uuid(40), "liaison"],
      [uuid(42), "cli"],
    ])
  })

  it("S43: a title, firstPrompt and branch holding a runtime-built key are redacted in the answer", async () => {
    const s = setup()
    const key = runtimeKey()
    writeSession(s.configDir, {
      cwd: s.shared,
      id: uuid(50),
      title: `deploy with ${key}`,
      prompt: `use ${key} please`,
      branch: `fix/${key}`,
    })
    const [row] = (await list(s)).rows
    const text = JSON.stringify(row)
    expect(text).not.toContain(key)
    expect(text).not.toContain("Q7xQ7x")
    expect(row?.title.startsWith("deploy with ")).toBe(true)
    expect(row?.firstPrompt.startsWith("use ")).toBe(true)
  })

  it("S42: a configDir field in the request file is ignored: the listing reads realClaudeConfigDir() only", async () => {
    const s = setup()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(60) })
    const otherConfig = path.join(path.dirname(s.configDir), "another-user-config")
    writeSession(otherConfig, { cwd: s.shared, id: uuid(61) })
    const request = path.join(path.dirname(s.configDir), "request.json")
    writeFileSync(
      request,
      JSON.stringify({ op: { kind: "list" }, folders: s.folders, configDir: otherConfig }),
    )
    const lines: string[] = []
    const code = await importMain(request, { write: (l) => lines.push(l), probe: quietProbe })
    expect(code).toBe(0)
    expect(lines.length).toBe(1)
    const out = JSON.parse(lines[0] as string) as {
      type: string
      answer: { rows: { sdkSessionId: string }[] }
    }
    expect(out.type).toBe("import_answer")
    expect(ids(out.answer.rows)).toEqual([uuid(60)])
    // The request file is read, never written or deleted.
    expect(statSync(request).isFile()).toBe(true)
  })

  it("S41/D5: liveNow is true for a row with a live registry entry, for one whose id is in a claude argv, and for one written 30 s ago; false otherwise", async () => {
    const s = setup()
    const now = Date.now()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(70) })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(71) })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(72), mtimeMs: now - 30_000 })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(73) })
    let snapshots = 0
    const probe: DriverProbe = {
      platform: "darwin",
      mtimeMs: () => null,
      registry: () => [{ pid: 501, sessionId: uuid(70), entrypoint: "claude-vscode" }],
      processes: () => {
        snapshots++
        return [
          { pid: 501, ppid: 400, args: "/usr/local/bin/claude --output-format stream-json" },
          { pid: 502, ppid: 400, args: `/usr/local/bin/claude --resume ${uuid(71)}` },
        ]
      },
    }
    const answer = await listImportable({
      configDir: s.configDir,
      folders: s.folders,
      now,
      probe,
    })
    const live = Object.fromEntries(answer.rows.map((r) => [r.sdkSessionId, r.liveNow]))
    expect(live).toEqual({
      [uuid(70)]: true,
      [uuid(71)]: true,
      [uuid(72)]: true,
      [uuid(73)]: false,
    })
    // One process-table snapshot per listing, shared by every row.
    expect(snapshots).toBe(1)
  })

  it("OPEN-10: a long-cwd session is listed and checked", async () => {
    const s = setup()
    let deep = s.shared
    while (slugOf(deep).length <= 230) deep = path.join(deep, "a-rather-long-folder-name")
    mkdirSync(deep, { recursive: true })
    const dirName = `${slugOf(deep).slice(0, 200)}-1x2y3z`
    writeSession(s.configDir, { cwd: deep, id: uuid(80), dirName })
    const answer = await list(s)
    expect(ids(answer.rows)).toEqual([uuid(80)])
    const row = answer.rows[0]
    expect(row?.cwdSubdir).toBe(path.relative(s.shared, deep))
    const check = await checkImport({
      configDir: s.configDir,
      folders: s.folders,
      sdkSessionId: uuid(80),
      folderName: "foo",
      cwdSubdir: row?.cwdSubdir ?? "",
      probe: quietProbe,
    })
    expect(check.ok).toBe(true)
  })

  it("S40: query 'fix-auth' keeps the session on branch fix-auth only", async () => {
    const s = setup()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(90), branch: "fix-auth" })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(91), branch: "main" })
    expect(ids((await list(s, { query: "FIX-AUTH" })).rows)).toEqual([uuid(90)])
    expect(ids((await list(s)).rows)).toEqual([uuid(90), uuid(91)])
  })
})

describe("findTranscript (OPEN-10, GF-68)", () => {
  it("OPEN-10: a long cwd's transcript is the single prefix dir holding <id>.jsonl; two such dirs are ambiguous", () => {
    const projects = path.join(scratch(), "projects")
    const cwd = `/${"long-segment/".repeat(20)}end`
    const prefix = slugOf(cwd).slice(0, 200)
    mkdirSync(path.join(projects, `${prefix}-aaa`), { recursive: true })
    mkdirSync(path.join(projects, `${prefix}-bbb`), { recursive: true })
    writeFileSync(path.join(projects, `${prefix}-bbb`, `${uuid(1)}.jsonl`), "{}\n")
    expect(findTranscript(projects, cwd, uuid(1))).toEqual({
      file: path.join(projects, `${prefix}-bbb`, `${uuid(1)}.jsonl`),
    })
    writeFileSync(path.join(projects, `${prefix}-aaa`, `${uuid(1)}.jsonl`), "{}\n")
    expect(findTranscript(projects, cwd, uuid(1))).toEqual({ code: "ambiguous_transcript" })
    expect(findTranscript(projects, cwd, uuid(2))).toEqual({ code: "not_found" })
    expect(findTranscript(projects, "/short", uuid(2))).toEqual({
      file: path.join(projects, "-short", `${uuid(2)}.jsonl`),
    })
    expect(findTranscript(projects, "/short", "../x")).toEqual({ code: "not_found" })
  })
})

describe("checkImport (S42, A47, A56)", () => {
  const check = (
    s: { configDir: string; folders: ImportFolder[] },
    sdkSessionId: string,
    cwdSubdir = "",
    folderName = "foo",
  ) =>
    checkImport({
      configDir: s.configDir,
      folders: s.folders,
      sdkSessionId,
      folderName,
      cwdSubdir,
      probe: quietProbe,
    })

  it("S42: check refuses a non-uuid id, an id not under that folder, a folder name the shell does not share, a cwdSubdir with '..', and an id found only under another config dir", async () => {
    const s = setup()
    const sub = path.join(s.shared, "sub")
    mkdirSync(sub)
    const unshared = path.join(path.dirname(s.configDir), "unshared")
    mkdirSync(unshared)
    writeSession(s.configDir, { cwd: sub, id: uuid(100) })
    writeSession(s.configDir, { cwd: unshared, id: uuid(101) })
    const otherConfig = path.join(path.dirname(s.configDir), "other-config")
    writeSession(otherConfig, { cwd: sub, id: uuid(102) })
    const good = await check(s, uuid(100), "sub")
    expect(good.ok).toBe(true)
    expect(await check(s, "not-a-uuid", "sub")).toEqual({ ok: false, code: "not_found" })
    expect(await check(s, uuid(101), "sub")).toEqual({ ok: false, code: "not_found" })
    expect(await check(s, uuid(100), "sub", "not-shared")).toEqual({
      ok: false,
      code: "outside_shared",
    })
    expect(await check(s, uuid(100), "sub/../..")).toEqual({ ok: false, code: "unsafe_subdir" })
    expect(await check(s, uuid(102), "sub")).toEqual({ ok: false, code: "not_found" })
  })

  it("S40: a transcript whose recorded cwd is inside the folder but stored under another folder's slug dir is refused by check (cwd mismatch)", async () => {
    const s = setup()
    const a = path.join(s.shared, "a")
    const b = path.join(s.shared, "b")
    mkdirSync(a)
    mkdirSync(b)
    // Recorded cwd b, but the file sits in a's project dir.
    writeSession(s.configDir, { cwd: b, id: uuid(110), dirName: slugOf(a) })
    const answer = await check(s, uuid(110), "a")
    expect(answer.ok).toBe(false)
  })

  it("A56: an sdk-ts session checked by id → not_found; a liaison-node session whose id this server does not know (another org's) → listed from liaison and checked already_liaison", async () => {
    const s = setup()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(120), entrypoint: "sdk-ts" })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(121), entrypoint: "liaison-node" })
    expect(await check(s, uuid(120))).toEqual({ ok: false, code: "not_found" })
    expect((await list(s)).rows.map((r) => [r.sdkSessionId, r.from])).toEqual([
      [uuid(121), "liaison"],
    ])
    expect(await check(s, uuid(121))).toEqual({ ok: false, code: "already_liaison" })
  })

  it("S43: the check answer's title holding a runtime-built key is redacted; a model 'x; rm -rf' answers null", async () => {
    const s = setup()
    const key = runtimeKey()
    writeSession(s.configDir, { cwd: s.shared, id: uuid(130), title: `title ${key}` })
    writeSession(s.configDir, { cwd: s.shared, id: uuid(131), model: "x; rm -rf" })
    const a = await check(s, uuid(130))
    expect(a.ok && a.title.startsWith("title ")).toBe(true)
    expect(JSON.stringify(a)).not.toContain(key)
    expect(a.ok && a.model).toBe("claude-haiku-5-5")
    const b = await check(s, uuid(131))
    expect(b.ok).toBe(true)
    expect(b.ok && b.model).toBeNull()
    expect(b.ok && b.driver).toEqual({ elsewhere: false, via: null })
  })

  it("S42: a check through a symlinked subdir answers symlink; a symlinked transcript answers symlink", async () => {
    const s = setup()
    const real = path.join(s.shared, "real")
    mkdirSync(real)
    symlinkSync(real, path.join(s.shared, "alias"))
    writeSession(s.configDir, { cwd: real, id: uuid(140) })
    expect(await check(s, uuid(140), "alias")).toEqual({ ok: false, code: "symlink" })
    const outside = path.join(path.dirname(s.configDir), "t.jsonl")
    writeFileSync(outside, sessionLines({ cwd: s.shared, id: uuid(141) }))
    mkdirSync(path.join(s.configDir, "projects", slugOf(s.shared)), { recursive: true })
    symlinkSync(outside, path.join(s.configDir, "projects", slugOf(s.shared), `${uuid(141)}.jsonl`))
    const answer = await check(s, uuid(141))
    expect(answer.ok).toBe(false)
  })
})

/**
 * Counts the bytes every FileHandle.read returns, per inode: the SDK's head and
 * tail reads and the listing's own head read all go through it.
 */
async function spyReads(): Promise<{ byIno: Map<number, number>; restore: () => void }> {
  const fh = await open(import.meta.path, "r")
  const proto = Object.getPrototypeOf(fh) as {
    read: (...a: unknown[]) => Promise<{ bytesRead: number }>
  }
  await fh.close()
  const original = proto.read
  const byIno = new Map<number, number>()
  proto.read = async function (this: { fd: number }, ...a: unknown[]) {
    const r = await original.apply(this, a)
    const ino = fstatSync(this.fd).ino
    byIno.set(ino, (byIno.get(ino) ?? 0) + r.bytesRead)
    return r
  }
  return { byIno, restore: () => (proto.read = original) }
}

describe("worktrees of a shared repository (D53)", () => {
  /** A shared repo `foo` with a worktree outside it, an unrelated repo's worktree, a sibling prefix folder. */
  function repoSetup() {
    const s = setup()
    const root = path.dirname(path.dirname(s.shared))
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" })
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true })
      git(dir, "init", "-q")
      git(
        dir,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      )
    }
    initRepo(s.shared)
    const worktree = path.join(root, "tmp", "foo-wt")
    git(s.shared, "worktree", "add", "-q", worktree)
    mkdirSync(path.join(worktree, "pkg"))
    const otherRepo = path.join(root, "other-repo")
    initRepo(otherRepo)
    const otherWorktree = path.join(root, "tmp", "other-wt")
    git(otherRepo, "worktree", "add", "-q", otherWorktree)
    const sibling = path.join(root, "tmp", "foo-wt-bar")
    mkdirSync(sibling, { recursive: true })
    return { ...s, root, worktree, otherWorktree, sibling, git }
  }

  const check = (
    s: { configDir: string; folders: ImportFolder[] },
    sdkSessionId: string,
    worktreePath: string | undefined,
    cwdSubdir = "",
  ) =>
    checkImport({
      configDir: s.configDir,
      folders: s.folders,
      sdkSessionId,
      folderName: "foo",
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      cwdSubdir,
      probe: quietProbe,
    })

  it("D53: a session in an unrelated repo's worktree and one in a sibling prefix folder of the worktree are not listed", async () => {
    const s = repoSetup()
    writeSession(s.configDir, { cwd: s.worktree, id: uuid(700) })
    writeSession(s.configDir, { cwd: s.otherWorktree, id: uuid(701) })
    writeSession(s.configDir, { cwd: s.sibling, id: uuid(702) })
    const answer = await list(s)
    expect(ids(answer.rows)).toEqual([uuid(700)])
    expect(answer.rows[0]?.worktreePath).toBe(s.worktree)
    expect(answer.rows[0]?.folderName).toBe("foo")
  })

  it("D53: check admits the shared repo's worktree and its subfolder; refuses an unrelated worktree, a sibling prefix folder, a removed worktree and a relative path", async () => {
    const s = repoSetup()
    writeSession(s.configDir, { cwd: s.worktree, id: uuid(710) })
    writeSession(s.configDir, { cwd: path.join(s.worktree, "pkg"), id: uuid(711) })
    writeSession(s.configDir, { cwd: s.otherWorktree, id: uuid(712) })
    writeSession(s.configDir, { cwd: s.sibling, id: uuid(713) })
    expect((await check(s, uuid(710), s.worktree)).ok).toBe(true)
    expect((await check(s, uuid(711), s.worktree, "pkg")).ok).toBe(true)
    // Without the worktree, the subdir is read against the folder: not there.
    expect((await check(s, uuid(710), undefined)).ok).toBe(false)
    expect(await check(s, uuid(712), s.otherWorktree)).toEqual({
      ok: false,
      code: "outside_shared",
    })
    expect(await check(s, uuid(713), s.sibling)).toEqual({ ok: false, code: "outside_shared" })
    expect(await check(s, uuid(710), "tmp/foo-wt")).toEqual({ ok: false, code: "unsafe_subdir" })
    expect(await check(s, uuid(711), s.worktree, "../other-wt")).toEqual({
      ok: false,
      code: "unsafe_subdir",
    })
    s.git(s.shared, "worktree", "remove", "--force", s.worktree)
    expect(await check(s, uuid(710), s.worktree)).toEqual({ ok: false, code: "outside_shared" })
  })

  it("D53: a shared subfolder of a repository opens none of that repository's worktrees", async () => {
    const s = repoSetup()
    const inner = path.join(s.shared, "inner")
    mkdirSync(inner)
    const folders = [{ name: "foo", path: inner }]
    writeSession(s.configDir, { cwd: s.worktree, id: uuid(720) })
    expect((await list({ configDir: s.configDir, folders })).rows).toEqual([])
    expect(await check({ configDir: s.configDir, folders }, uuid(720), s.worktree)).toEqual({
      ok: false,
      code: "outside_shared",
    })
  })
})

describe("listing memory (A50, A60)", () => {
  it("A50: listing a fixture with one 300 MB transcript reads at most 3 × headBytes of it", async () => {
    const s = setup()
    const file = writeSession(s.configDir, { cwd: s.shared, id: uuid(200) })
    const size = 300 * 1024 * 1024
    const fd = openSync(file, "r+")
    ftruncateSync(fd, size - 1024)
    const tail = `\n${JSON.stringify({ type: "last-prompt", sessionId: uuid(200) })}\n`
    writeSync(fd, tail, size - 1024)
    closeSync(fd)
    const ino = statSync(file).ino
    const spy = await spyReads()
    try {
      const answer = await list(s)
      expect(ids(answer.rows)).toEqual([uuid(200)])
      expect(answer.rows[0]?.sizeBytes).toBeGreaterThan(300 * 1024 * 1024 - 2048)
    } finally {
      spy.restore()
    }
    const read = spy.byIno.get(ino) ?? 0
    expect(read).toBeGreaterThan(0)
    expect(read).toBeLessThanOrEqual(3 * HEAD)
    rmSync(file)
  })

  it("A50: 200 fixture transcripts of 256 KiB each (larger than 3 × 64 KiB, so a whole-file read is visible) are each read at most 3 × headBytes", async () => {
    const s = setup()
    const filler = `${JSON.stringify({ type: "attachment", text: "z".repeat(1000) })}\n`
    const pad = filler.repeat(Math.ceil((256 * 1024) / filler.length))
    const inos: number[] = []
    for (let i = 0; i < 200; i++) {
      const cwd = path.join(s.shared, `d${i % 10}`)
      mkdirSync(cwd, { recursive: true })
      const file = writeSession(s.configDir, { cwd, id: uuid(1000 + i) })
      const head = sessionLines({ cwd, id: uuid(1000 + i) })
      writeFileSync(file, head + pad + head)
      inos.push(statSync(file).ino)
      expect(statSync(file).size).toBeGreaterThan(3 * HEAD)
    }
    const spy = await spyReads()
    let rows = 0
    try {
      rows = (await list(s)).rows.length
    } finally {
      spy.restore()
    }
    expect(rows).toBe(200)
    for (const ino of inos) {
      const read = spy.byIno.get(ino) ?? 0
      expect(read).toBeGreaterThan(0)
      expect(read).toBeLessThanOrEqual(3 * HEAD)
    }
    rmSync(path.join(s.configDir, "projects"), { recursive: true, force: true })
  })

  it("A50: the whole listing of 2,000 small fixture transcripts stays under 150 MB RSS growth", async () => {
    const s = setup()
    for (let i = 0; i < 2000; i++) {
      const cwd = path.join(s.shared, `p${i % 20}`)
      if (i < 20) mkdirSync(cwd, { recursive: true })
      writeSession(s.configDir, { cwd, id: uuid(5000 + i) })
    }
    Bun.gc(true)
    const before = process.memoryUsage().rss
    const answer = await list(s)
    const growth = process.memoryUsage().rss - before
    expect(answer.rows.length).toBe(200)
    expect(answer.truncated).toBe(true)
    expect(growth).toBeLessThan(150 * 1024 * 1024)
  })
})

describe("listing detail (S12-S14, A1, A4, A5)", () => {
  /**
   * A home folder with two shared folders (`alpha`, a repo with a worktree
   * outside it, and `beta`), an unshared repo `gamma` with 3 transcripts in
   * two subdirs, a session in the home folder, one in ~/Documents (an
   * existing repo: a stat would group it) and one whose cwd is gone.
   */
  function detailSetup() {
    const root = scratch()
    const home = path.join(root, "home")
    const configDir = path.join(root, "owner-config")
    mkdirSync(path.join(configDir, "projects"), { recursive: true })
    useConfig(configDir)
    const code = path.join(home, "code")
    const alpha = path.join(code, "alpha")
    const alphaWt = path.join(code, "alpha-wt")
    const beta = path.join(code, "beta")
    const gamma = path.join(code, "gamma")
    const documents = path.join(home, "Documents", "notes")
    for (const d of [alpha, beta, path.join(gamma, "src"), path.join(gamma, "docs"), documents])
      mkdirSync(d, { recursive: true })
    mkdirSync(path.join(gamma, ".git"))
    mkdirSync(path.join(documents, ".git"))
    const git = (...a: string[]) => execFileSync("git", ["-C", alpha, ...a], { stdio: "ignore" })
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i")
    git("worktree", "add", "-q", alphaWt)
    const now = Date.now()
    writeSession(configDir, { cwd: alpha, id: uuid(901), mtimeMs: now - 60_000 })
    writeSession(configDir, { cwd: alphaWt, id: uuid(902), mtimeMs: now - 60_000 })
    writeSession(configDir, { cwd: beta, id: uuid(903), mtimeMs: now - 60_000 })
    writeSession(configDir, {
      cwd: path.join(gamma, "src"),
      id: uuid(904),
      mtimeMs: now - 200_000,
      title: "secret plan",
      prompt: "gamma prompt",
      branch: "gamma-branch",
    })
    writeSession(configDir, { cwd: path.join(gamma, "src"), id: uuid(905), mtimeMs: now - 120_000 })
    writeSession(configDir, { cwd: path.join(gamma, "docs"), id: uuid(906), mtimeMs: now - 90_000 })
    writeSession(configDir, { cwd: home, id: uuid(907), mtimeMs: now - 500_000 })
    writeSession(configDir, { cwd: documents, id: uuid(908), mtimeMs: now - 70_000 })
    writeSession(configDir, { cwd: path.join(code, "gone"), id: uuid(909), mtimeMs: now - 80_000 })
    const folders: ImportFolder[] = [
      { name: "alpha", path: alpha },
      { name: "beta", path: beta },
    ]
    return { configDir, folders, home, gamma, documents, beta, now }
  }

  const detailList = (
    s: ReturnType<typeof detailSetup>,
    extra: { folder?: string; detail?: boolean } = {},
  ) =>
    listImportable({
      configDir: s.configDir,
      folders: s.folders,
      now: Date.now(),
      probe: quietProbe,
      home: s.home,
      ...(extra.folder !== undefined ? { folder: extra.folder } : {}),
      ...(extra.detail === false ? {} : { detail: true }),
    })

  it("S12-S14: exact folder totals, one group for the unshared repo (3 sessions) and one for the home folder, newest first; the ~/Documents and the gone cwd count in skipped and form no group", async () => {
    const s = detailSetup()
    const answer = await detailList(s)
    expect(ids(answer.rows)).toEqual([uuid(901), uuid(902), uuid(903)])
    expect(answer.folders).toEqual([
      { name: "alpha", sessions: 2 },
      { name: "beta", sessions: 1 },
    ])
    expect(answer.unsharedPaths?.map((g) => [g.path, g.sessions])).toEqual([
      [s.gamma, 3],
      [s.home, 1],
    ])
    expect(answer.skipped).toBe(2)
    expect(answer.unsharedPartial).toBeUndefined()
    const text = JSON.stringify(answer.unsharedPaths)
    expect(text).not.toContain(s.documents)
    for (const g of answer.unsharedPaths ?? [])
      expect(Object.keys(g).sort()).toEqual(["lastModified", "path", "sessions"])
    for (const leak of ["secret plan", "gamma prompt", "gamma-branch"])
      expect(text).not.toContain(leak)
  })

  it("S12: folder lists that shared folder only, with its own total", async () => {
    const s = detailSetup()
    const answer = await detailList(s, { folder: "beta" })
    expect(ids(answer.rows)).toEqual([uuid(903)])
    expect(answer.folders).toEqual([{ name: "beta", sessions: 1 }])
    // The other shared folder's sessions are still never an unshared group.
    expect(answer.unsharedPaths?.map((g) => g.path)).toEqual([s.gamma, s.home])
  })

  it("A1: the new keys come only with detail; without it the answer is exactly rows and truncated", async () => {
    const s = detailSetup()
    expect(Object.keys(await detailList(s)).sort()).toEqual([
      "folders",
      "rows",
      "skipped",
      "truncated",
      "unsharedPaths",
    ])
    const answer = await detailList(s, { detail: false })
    expect(Object.keys(answer).sort()).toEqual(["rows", "truncated"])
    expect(ids(answer.rows)).toEqual([uuid(901), uuid(902), uuid(903)])
  })

  it("S12: a folder's total is counted before the 200-row cap", async () => {
    const s = detailSetup()
    for (let i = 0; i < 205; i++) writeSession(s.configDir, { cwd: s.beta, id: uuid(2000 + i) })
    const answer = await detailList(s)
    expect(answer.rows.length).toBe(200)
    expect(answer.truncated).toBe(true)
    expect(answer.folders).toEqual([
      { name: "alpha", sessions: 2 },
      { name: "beta", sessions: 206 },
    ])
  })

  it("S13: past the grouping budget the answer says unsharedPartial", async () => {
    const s = detailSetup()
    const answer = await listImportable({
      configDir: s.configDir,
      folders: s.folders,
      now: Date.now(),
      probe: quietProbe,
      home: s.home,
      detail: true,
      groupBudgetMs: -1,
    })
    expect(answer.unsharedPartial).toBe(true)
    expect(answer.unsharedPaths).toEqual([])
  })

  it("A4: a cwd outside the home folder that no shared or search root covers is never resolved; a search root outside the home folder groups its sessions", async () => {
    const s = detailSetup()
    const outside = path.join(path.dirname(s.home), "elsewhere", "repo")
    mkdirSync(path.join(outside, ".git"), { recursive: true })
    const disk = path.join(path.dirname(s.home), "disk", "proj")
    mkdirSync(path.join(disk, ".git"), { recursive: true })
    writeSession(s.configDir, { cwd: outside, id: uuid(950), mtimeMs: s.now - 10_000 })
    writeSession(s.configDir, { cwd: disk, id: uuid(951), mtimeMs: s.now - 20_000 })
    const answer = await listImportable({
      configDir: s.configDir,
      folders: s.folders,
      now: Date.now(),
      probe: quietProbe,
      home: s.home,
      detail: true,
      searchRoots: [path.dirname(disk)],
    })
    expect(answer.unsharedPaths?.map((g) => g.path)).toEqual([disk, s.gamma, s.home])
    expect(answer.skipped).toBe(3)
  })

  it("A4: a cwd through a link inside the home folder that leads into ~/Documents is not grouped; a link to an allowed folder is", async () => {
    const s = detailSetup()
    symlinkSync(s.documents, path.join(s.home, "notes-link"))
    symlinkSync(path.join(s.home, "Documents"), path.join(s.home, "docs-link"))
    symlinkSync(s.gamma, path.join(s.home, "gamma-link"))
    writeSession(s.configDir, {
      cwd: path.join(s.home, "notes-link"),
      id: uuid(952),
      mtimeMs: s.now - 10_000,
    })
    writeSession(s.configDir, {
      cwd: path.join(s.home, "docs-link", "notes"),
      id: uuid(953),
      mtimeMs: s.now - 10_000,
    })
    writeSession(s.configDir, {
      cwd: path.join(s.home, "gamma-link", "src"),
      id: uuid(954),
      mtimeMs: s.now - 10_000,
    })
    const answer = await detailList(s)
    expect(answer.unsharedPaths?.map((g) => [g.path, g.sessions])).toEqual([
      [s.gamma, 4],
      [s.home, 1],
    ])
    expect(answer.skipped).toBe(4)
    expect(JSON.stringify(answer.unsharedPaths)).not.toContain("Documents")
  })

  it("A4: a search root inside ~/Documents covers its cwds: they are grouped", async () => {
    const s = detailSetup()
    const answer = await listImportable({
      configDir: s.configDir,
      folders: s.folders,
      now: Date.now(),
      probe: quietProbe,
      home: s.home,
      detail: true,
      searchRoots: [path.join(s.home, "Documents")],
    })
    expect(answer.unsharedPaths?.map((g) => g.path)).toEqual([s.documents, s.gamma, s.home])
    expect(answer.skipped).toBe(1)
  })

  it("A4: --import reads the request's search roots", async () => {
    const s = detailSetup()
    const request = path.join(path.dirname(s.configDir), "request.json")
    writeFileSync(
      request,
      JSON.stringify({
        op: { kind: "list", detail: true },
        folders: s.folders,
        searchRoots: [path.join(s.home, "Documents")],
      }),
    )
    const lines: string[] = []
    expect(
      await importMain(request, { write: (l) => lines.push(l), probe: quietProbe, home: s.home }),
    ).toBe(0)
    const out = JSON.parse(lines[0] as string) as {
      answer: { unsharedPaths: { path: string }[]; skipped: number }
    }
    expect(out.answer.unsharedPaths.map((g) => g.path)).toContain(s.documents)
    expect(out.answer.skipped).toBe(1)
  })

  it("A1: --import passes folder and detail through and answers the sidecar list shape", async () => {
    const s = detailSetup()
    const request = path.join(path.dirname(s.configDir), "request.json")
    writeFileSync(
      request,
      JSON.stringify({ op: { kind: "list", folder: "alpha", detail: true }, folders: s.folders }),
    )
    const lines: string[] = []
    const code = await importMain(request, {
      write: (l) => lines.push(l),
      probe: quietProbe,
      home: s.home,
    })
    expect(code).toBe(0)
    const out = JSON.parse(lines[0] as string) as {
      answer: { rows: { sdkSessionId: string }[]; folders: unknown; skipped: number }
    }
    expect(ids(out.answer.rows)).toEqual([uuid(901), uuid(902)])
    expect(out.answer.folders).toEqual([{ name: "alpha", sessions: 2 }])
    expect(out.answer.skipped).toBe(2)
  })
})
