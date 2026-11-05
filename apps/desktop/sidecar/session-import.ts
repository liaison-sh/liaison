// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE IMPORT LISTING AND THE START CHECK (W3 T05; S40, S42, S43, A42, A47,
// A50, A56, OPEN-10).
//
// A one-shot `liaison-sidecar --import <request file>` lists the owner's
// Claude Code sessions whose recorded cwd is inside a shared folder, or
// re-validates one id before a Follow or a Take over starts. Nothing outside
// the shared folders is listed, and nothing is ever written: the owner's
// config dir is read only.
//
// - The config dir is this process's own (`realClaudeConfigDir()`), never a
//   request field. The SDK's `listSessions`/`getSessionInfo` read
//   `process.env.CLAUDE_CONFIG_DIR` at call time and take no config dir, so
//   the two agree by construction; `configDir` here feeds our own scan and
//   bounds only, and is asserted to be the SDK's root.
// - `listSessions({dir})` returns exactly one project dir (GF-67), so a
//   session in a subfolder is found by scanning `<config>/projects` for the
//   folder's slug and its `slug-…` children, reading each transcript's
//   recorded `cwd` from its head (the slug is lossy: `/a/foo-bar` and
//   `/a/foo/bar` share one dir), and asking the SDK per distinct cwd.
// - D53: a shared folder that is a repository's top level also admits the
//   repository's own worktrees outside it (`git worktree list`, read by the
//   node at each listing and check, never a request field). Such a row keeps
//   its shared folder and names the worktree; its `cwdSubdir` is relative to
//   the worktree. Nothing outside the folder and those worktrees is read.
// - Every path is re-checked with lstat and realpath: a symlinked project
//   dir or transcript is skipped, a cwd that resolves outside the folder is
//   dropped, separator-bounded.
// - Every text that leaves the node (title, first prompt, branch) is
//   redacted (S43) and then clipped.
// - Memory (A50): the SDK reads one 64 KiB head and one 64 KiB tail per
//   transcript, the scan one more head. No transcript is read whole.
//
// Logging: codes and counts only, never a title, a prompt or a path under the
// projects dir.

import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import { constants, open } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getSessionInfo, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import {
  NODE_IMPORT_LIMITS,
  NODE_UNSHARED_GROUPS,
  type NodeImportCheckAnswer,
  type NodeImportCheckCode,
  type NodeImportRow,
  type NodeImportSidecarList,
  nodeImportCheckAnswerSchema,
  nodeImportOpSchema,
  nodeImportRowSchema,
  nodeImportSidecarListSchema,
  safeSubdir,
  safeWorktreePath,
} from "../../../packages/shared/src/node-import"
import { redactImportText } from "../../../packages/shared/src/secret-redaction"
import { realClaudeConfigDir } from "./config-isolation"
import { sharedRepoWorktrees } from "./job-workspace"
import { OWNER_SESSION_ENTRYPOINT } from "./session-config"
import {
  type DriverProbe,
  type DriverVerdict,
  drivenElsewhere,
  systemDriverProbe,
} from "./session-driver"

/** A shared folder as the shell knows it for the current server. */
export interface ImportFolder {
  name: string
  path: string
}

/** The CLI's slug of a path: every non-alphanumeric character becomes `-` (GF-68). */
export function slugOf(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-")
}

/** Over this many characters the CLI stores `slug.slice(0, 200)-<hash>` (GF-68). */
const SLUG_MAX = 200

const SDK_SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export type TranscriptLookup = { file: string } | { code: "not_found" | "ambiguous_transcript" }

/**
 * Where the CLI keeps the transcript of session `id` run in `cwd`:
 * `<projects>/<slug(cwd)>/<id>.jsonl`, or, when the slug passes 200
 * characters, the one dir named `slug.slice(0,200)-…` that holds `<id>.jsonl`
 * (OPEN-10: the hash is the CLI's own, never reimplemented here). Two such
 * dirs holding the id are ambiguous. The short form is returned whether or
 * not the file exists; the caller checks it.
 */
export function findTranscript(projectsDir: string, cwd: string, id: string): TranscriptLookup {
  if (!SDK_SESSION_ID_RE.test(id)) return { code: "not_found" }
  const slug = slugOf(cwd)
  const name = `${id}.jsonl`
  if (slug.length <= SLUG_MAX) return { file: path.join(projectsDir, slug, name) }
  const prefix = `${slug.slice(0, SLUG_MAX)}-`
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return { code: "not_found" }
  }
  const found: string[] = []
  for (const dir of entries) {
    if (!dir.startsWith(prefix)) continue
    const file = path.join(projectsDir, dir, name)
    try {
      lstatSync(file)
      found.push(file)
    } catch {
      // Not in this dir.
    }
  }
  if (found.length === 0) return { code: "not_found" }
  if (found.length > 1) return { code: "ambiguous_transcript" }
  return { file: found[0] as string }
}

/** `child` is `parent` or inside it, separator-bounded (`/a/foo-bar` is not in `/a/foo`). */
function inside(parent: string, child: string): boolean {
  return (
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
  )
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Clips to `max` UTF-16 units without leaving half a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

const redactClip = (s: string, max: number) => clip(redactImportText(s), max)

export interface HeadFacts {
  cwd: string | null
  entrypoint: string | null
}

/**
 * The first `headBytes` of a regular transcript, never through a symlink
 * (O_NOFOLLOW), giving its recorded cwd and entrypoint; null when it is not
 * a regular file or cannot be read.
 */
export async function readHead(file: string): Promise<HeadFacts | null> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!(await fh.stat()).isFile()) return null
    const buf = Buffer.alloc(NODE_IMPORT_LIMITS.headBytes)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const text = buf.toString("utf8", 0, bytesRead)
    const facts: HeadFacts = { cwd: null, entrypoint: null }
    const lines = text.split("\n")
    // The last piece may be a cut line unless the head is the whole file.
    if (bytesRead === buf.length) lines.pop()
    for (const line of lines) {
      if (!line.includes('"cwd"') && !line.includes('"entrypoint"')) continue
      let entry: { cwd?: unknown; entrypoint?: unknown }
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      if (facts.cwd === null && typeof entry.cwd === "string") facts.cwd = entry.cwd
      if (facts.entrypoint === null && typeof entry.entrypoint === "string")
        facts.entrypoint = entry.entrypoint
      if (facts.cwd !== null && facts.entrypoint !== null) break
    }
    return facts
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

/** The tail's last main-thread assistant model, if it is a plain model id (A59). */
async function lastModel(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const size = (await fh.stat()).size
    const want = Math.min(size, NODE_IMPORT_LIMITS.headBytes)
    const buf = Buffer.alloc(want)
    const { bytesRead } = await fh.read(buf, 0, want, size - want)
    const lines = buf.toString("utf8", 0, bytesRead).split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as string
      if (!line.includes('"assistant"')) continue
      try {
        const e = JSON.parse(line) as {
          type?: unknown
          isSidechain?: unknown
          message?: { model?: unknown }
        }
        if (e.type !== "assistant" || e.isSidechain === true) continue
        const model = e.message?.model
        if (typeof model !== "string") continue
        return /^[a-z0-9.\-[\]]{1,100}$/.test(model) ? model : null
      } catch {
        // A line cut by the tail's start, or a partial last line.
      }
    }
    return null
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

type RowFrom = NodeImportRow["from"]

/** Who wrote the session; `null` drops it (another SDK app's session, A56). */
function fromOf(entrypoint: string | null): RowFrom | null {
  if (entrypoint === null) return "other"
  if (entrypoint.startsWith("sdk-")) return null
  if (entrypoint === "claude-vscode") return "vscode"
  if (entrypoint === "cli") return "cli"
  if (entrypoint === OWNER_SESSION_ENTRYPOINT) return "liaison"
  return "other"
}

/** The SDK reads the config dir from the environment: it must be ours. */
function assertSdkRoot(configDir: string): void {
  if (path.join(realClaudeConfigDir(), "projects") !== path.join(configDir, "projects")) {
    throw new Error("config_dir_mismatch")
  }
}

/**
 * One process-table snapshot and one registry read for a whole listing; the
 * row's own `lastModified` stands for the transcript's mtime (no stat per row).
 */
function listingProbe(base: DriverProbe): (lastModified: number) => DriverProbe {
  let table: ReturnType<DriverProbe["processes"]> | undefined
  const registries = new Map<string, ReturnType<DriverProbe["registry"]>>()
  const processes = () => {
    if (table === undefined) table = base.processes()
    return table
  }
  const registry = (dir: string) => {
    let r = registries.get(dir)
    if (r === undefined) {
      r = base.registry(dir)
      registries.set(dir, r)
    }
    return r
  }
  return (lastModified) => ({
    platform: base.platform,
    processes,
    registry,
    mtimeMs: () => lastModified,
  })
}

/** A transcript Liaison may read: a regular file, no symlink, under the real projects dir. */
function transcriptCheck(
  file: string,
  realProjects: string,
): { ok: true; size: number } | { ok: false; code: NodeImportCheckCode } {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(file)
  } catch {
    return { ok: false, code: "not_found" }
  }
  if (st.isSymbolicLink()) return { ok: false, code: "symlink" }
  if (!st.isFile()) return { ok: false, code: "not_regular" }
  const real = realpathOrNull(file)
  if (real === null || !inside(realProjects, real) || real === realProjects)
    return { ok: false, code: "symlink" }
  return { ok: true, size: st.size }
}

export interface ListImportableOptions {
  /** `realClaudeConfigDir()` of this process; never a request field. */
  configDir: string
  folders: readonly ImportFolder[]
  /** The person's search (D47), at most 100 characters. */
  query?: string
  /** S12: list this shared folder (by name) only. */
  folder?: string
  /** A1: add `folders`, `unsharedPaths`, `skipped` and `unsharedPartial`. */
  detail?: boolean
  now: number
  probe?: DriverProbe
  /** The home folder; default `os.homedir()` (tests pass a fixture). */
  home?: string
  /** The unshared grouping's budget (S13); default 3 s. */
  groupBudgetMs?: number
  /**
   * A4: the owner's search roots that may be read (absolute, from the shell's
   * own settings, never a request field the page wrote). A cwd under one is
   * resolved even inside a protected home folder or outside the home folder.
   */
  searchRoots?: readonly string[]
}

/** A place an import may come from: the shared folder, or one of its repository's worktrees (D53). */
interface ImportRoot {
  path: string
  worktree: string | null
}

/** The home folders macOS guards with a privacy prompt (A4). */
const PROTECTED_HOME = ["Documents", "Desktop", "Downloads", "Library"] as const

const GROUP_BUDGET_MS = 3_000

/** Links followed while resolving one recorded cwd before it is given up. */
const LINK_HOPS = 8

/**
 * The git top level holding `real` (walking up for a `.git` entry, by lstat:
 * a directory or a worktree's file), stopping before the home folder, `/`
 * and any folder `allowed` refuses; else `real` itself.
 */
function gitTopOf(real: string, homes: readonly string[], allowed: (p: string) => boolean): string {
  let dir = real
  for (;;) {
    if (homes.includes(dir) || dir === path.parse(dir).root) return real
    try {
      lstatSync(path.join(dir, ".git"))
      return dir
    } catch {
      // No `.git` here.
    }
    const up = path.dirname(dir)
    if (up === dir || !allowed(up)) return real
    dir = up
  }
}

/** Lists the importable sessions of the shared folders (S40, A42, D53; S12-S14). */
export async function listImportable(o: ListImportableOptions): Promise<NodeImportSidecarList> {
  assertSdkRoot(o.configDir)
  const projectsDir = path.join(o.configDir, "projects")
  const empty = (): NodeImportSidecarList =>
    o.detail
      ? { rows: [], truncated: false, folders: [], unsharedPaths: [], skipped: 0 }
      : { rows: [], truncated: false }
  const realProjects = realpathOrNull(projectsDir)
  if (realProjects === null) return empty()
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return empty()
  }
  // Real project dirs only: a symlinked one could point anywhere.
  const projectDirs = entries.filter((name) => {
    try {
      return lstatSync(path.join(projectsDir, name)).isDirectory()
    } catch {
      return false
    }
  })
  const heads = new Map<string, HeadFacts | null>()
  const headOf = async (file: string) => {
    if (!heads.has(file)) heads.set(file, await readHead(file))
    return heads.get(file) ?? null
  }
  /** A project dir's regular transcripts (a symlink, most are dangling, T04, is never followed). */
  const transcripts = new Map<string, { file: string; mtimeMs: number }[]>()
  const transcriptsOf = (dir: string) => {
    let found = transcripts.get(dir)
    if (found !== undefined) return found
    found = []
    let names: string[] = []
    try {
      names = readdirSync(path.join(projectsDir, dir))
    } catch {
      // Gone since the listing: nothing in it.
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue
      const file = path.join(projectsDir, dir, name)
      try {
        const st = lstatSync(file)
        if (st.isFile()) found.push({ file, mtimeMs: st.mtimeMs })
      } catch {
        // Gone since the listing.
      }
    }
    transcripts.set(dir, found)
    return found
  }
  const probeFor = listingProbe(o.probe ?? systemDriverProbe())
  const seen = new Set<string>()
  const rows: NodeImportRow[] = []
  let skipped = 0

  const home = o.home ?? homedir()
  const homes = [...new Set([home, realpathOrNull(home) ?? home])]
  // Every shared folder's roots and slug dirs, also when one folder is asked
  // for: a cwd inside any shared root is never an unshared group.
  const shared = o.folders.flatMap((folder) => {
    const realF = realpathOrNull(folder.path)
    if (realF === null) return []
    // D53: the folder, then its repository's own worktrees outside it; a cwd
    // belongs to the deepest root that holds it.
    const roots: ImportRoot[] = [
      { path: realF, worktree: null },
      ...sharedRepoWorktrees(realF).map((w) => ({ path: w, worktree: w })),
    ]
    const kept = new Set<string>()
    for (const root of roots) {
      const slug = slugOf(root.path)
      for (const name of projectDirs) {
        if (
          name === slug ||
          name.startsWith(`${slug}-`) ||
          (slug.length > SLUG_MAX && name.startsWith(slug.slice(0, SLUG_MAX)))
        )
          kept.add(name)
      }
    }
    return [{ folder, realF, roots, kept }]
  })
  const lexicalRoots = [
    ...new Set(shared.flatMap((f) => [f.folder.path, ...f.roots.map((r) => r.path)])),
  ]
  /** A shared root or one of the owner's search roots holds `p`, by its text. */
  const coverRoots = [
    ...lexicalRoots,
    ...(o.searchRoots ?? []).filter((r) => path.isAbsolute(r)).map((r) => path.resolve(r)),
  ]
  const covered = (p: string) => coverRoots.some((r) => inside(r, p))
  const homeOf = (p: string) =>
    homes.filter((h) => inside(h, p)).sort((a, b) => b.length - a.length)[0] ?? null
  /**
   * A4, by the path's text alone: inside a shared or search root, or inside
   * the home folder and not in its Documents, Desktop, Downloads or Library.
   * Anything else (a removable or network volume, a system folder) is never
   * stat'ed: a stat there can raise a macOS privacy prompt or hang.
   */
  const allowed = (p: string) => {
    if (!path.isAbsolute(p)) return false
    if (covered(p)) return true
    const h = homeOf(p)
    return h !== null && !PROTECTED_HOME.some((d) => inside(path.join(h, d), p))
  }
  /**
   * A recorded cwd's real path, reached without touching a path `allowed`
   * refuses: inside the home folder each step is lstat'ed first, and a link
   * is read (readlink) and its target checked again before anything enters
   * it. A cwd under a shared or search root is the owner's to read. Null when
   * refused, gone, or past `LINK_HOPS` links.
   */
  const resolveCwd = (cwd: string, hops = 0): string | null => {
    if (!path.isAbsolute(cwd) || hops > LINK_HOPS) return null
    const p = path.resolve(cwd)
    if (!allowed(p)) return null
    if (!covered(p)) {
      const h = homeOf(p) as string
      const steps = path.relative(h, p).split(path.sep).filter(Boolean)
      let at = h
      for (let i = 0; i < steps.length; i++) {
        at = path.join(at, steps[i] as string)
        let st: ReturnType<typeof lstatSync>
        try {
          st = lstatSync(at)
        } catch {
          return null
        }
        if (st.isSymbolicLink()) {
          let target: string
          try {
            target = readlinkSync(at)
          } catch {
            return null
          }
          const next = path.resolve(path.dirname(at), target, ...steps.slice(i + 1))
          return resolveCwd(next, hops + 1)
        }
      }
    }
    const real = realpathOrNull(p)
    return real !== null && allowed(real) ? real : null
  }
  const inSharedRoot = (real: string) =>
    shared.some((f) => f.roots.some((r) => inside(r.path, real)))

  const listed = o.folder === undefined ? shared : shared.filter((f) => f.folder.name === o.folder)
  for (const { folder, roots, kept } of listed) {
    const rootOf = (real: string): ImportRoot | null => {
      let best: ImportRoot | null = null
      for (const r of roots) {
        if (inside(r.path, real) && (best === null || r.path.length > best.path.length)) best = r
      }
      return best
    }
    // Every transcript's recorded cwd: the slug is lossy, the file is not.
    const cwds = new Set<string>()
    for (const dir of kept) {
      for (const { file } of transcriptsOf(dir)) {
        const head = await headOf(file)
        if (head?.cwd) cwds.add(head.cwd)
      }
    }
    for (const cwd of cwds) {
      const realCwd = resolveCwd(cwd)
      if (realCwd === null || rootOf(realCwd) === null) continue
      let infos: SDKSessionInfo[]
      try {
        infos = await listSessions({
          dir: cwd,
          includeWorktrees: false,
          includeProgrammatic: false,
        })
      } catch {
        skipped++
        continue
      }
      for (const info of infos) {
        if (seen.has(info.sessionId)) continue
        const row = await rowOf(info)
        if (row) {
          seen.add(info.sessionId)
          rows.push(row)
        } else skipped++
      }
    }

    async function rowOf(info: SDKSessionInfo): Promise<NodeImportRow | null> {
      const infoCwd = resolveCwd(info.cwd ?? "")
      const root = infoCwd === null ? null : rootOf(infoCwd)
      if (infoCwd === null || root === null) return null
      const found = findTranscript(projectsDir, infoCwd, info.sessionId)
      if (!("file" in found)) return null
      const t = transcriptCheck(found.file, realProjects as string)
      if (!t.ok) return null
      const head = await headOf(found.file)
      const recorded = head?.cwd ? resolveCwd(head.cwd) : null
      if (recorded === null || !inside(root.path, recorded)) return null
      const from = fromOf(head?.entrypoint ?? null)
      if (from === null) return null
      const cwdSubdir = path.relative(root.path, infoCwd).split(path.sep).join("/")
      if (!safeSubdir(cwdSubdir)) return null
      const lastModified = Math.trunc(info.lastModified)
      const verdict = drivenElsewhere(
        {
          jsonl: found.file,
          sessionId: info.sessionId,
          configDir: o.configDir,
          ownPids: new Set(),
          ownLastWriteMs: null,
          now: o.now,
        },
        probeFor(lastModified),
      )
      const candidate: NodeImportRow = {
        sdkSessionId: info.sessionId,
        folderName: folder.name,
        ...(root.worktree !== null ? { worktreePath: root.worktree } : {}),
        cwdSubdir,
        title: redactClip(info.customTitle ?? info.summary ?? "", 120),
        firstPrompt: redactClip(info.firstPrompt ?? "", 300),
        branch: info.gitBranch ? redactClip(info.gitBranch, 200) : null,
        lastModified,
        createdAt: typeof info.createdAt === "number" ? Math.trunc(info.createdAt) : null,
        sizeBytes: info.fileSize ?? t.size,
        from,
        liveNow: verdict.elsewhere,
      }
      const parsed = nodeImportRowSchema.safeParse(candidate)
      return parsed.success ? parsed.data : null
    }
  }

  // A search the person asked for over the redacted fields, not a decision.
  const q = o.query?.trim().toLowerCase()
  const matched = q
    ? rows.filter((r) =>
        [
          r.title,
          r.firstPrompt,
          r.folderName,
          r.worktreePath ?? "",
          r.cwdSubdir,
          r.branch ?? "",
        ].some((f) => f.toLowerCase().includes(q)),
      )
    : rows
  matched.sort((a, b) => b.lastModified - a.lastModified)
  const page = {
    rows: matched.slice(0, NODE_IMPORT_LIMITS.listRows),
    truncated: matched.length > NODE_IMPORT_LIMITS.listRows,
  }
  if (!o.detail) {
    if (skipped > 0) process.stderr.write(`import_list skipped=${skipped}\n`)
    return page
  }

  // S12: every listed folder's total, counted before the row cap.
  const counts = new Map<string, number>()
  for (const r of matched) counts.set(r.folderName, (counts.get(r.folderName) ?? 0) + 1)
  const folders = listed.slice(0, 500).map(({ folder }) => ({
    name: folder.name,
    sessions: counts.get(folder.name) ?? 0,
  }))

  // S13, A5: the unshared groups, by each transcript's recorded cwd, not by
  // the slug. A shared folder's slug dir is classified transcript by
  // transcript (its heads are mostly read already); for a project dir no
  // shared folder's slug matches, the newest transcript's head stands for
  // the whole dir. A slug collision (two cwds in one dir) is rare; the dir
  // then counts under its newest cwd.
  const groups = new Map<string, { sessions: number; lastModified: number }>()
  const keptAll = new Set(shared.flatMap((f) => [...f.kept]))
  const started = Date.now()
  const budget = o.groupBudgetMs ?? GROUP_BUDGET_MS
  let unsharedPartial = false
  const classify = (
    cwd: string | null | undefined,
    sessions: number,
    mtimeMs: number,
    kept: boolean,
  ) => {
    const real = cwd ? resolveCwd(cwd) : null
    if (real === null) {
      skipped += sessions
      return
    }
    if (inSharedRoot(real)) {
      // In a shared slug dir it is a row (or the row checks counted it);
      // elsewhere the row listing cannot reach it.
      if (!kept) skipped += sessions
      return
    }
    const key = gitTopOf(real, homes, allowed)
    if (key.length > 4096) {
      skipped += sessions
      return
    }
    const g = groups.get(key) ?? { sessions: 0, lastModified: 0 }
    g.sessions += sessions
    g.lastModified = Math.max(g.lastModified, Math.trunc(mtimeMs))
    groups.set(key, g)
  }
  for (const dir of projectDirs) {
    if (Date.now() - started > budget) {
      unsharedPartial = true
      break
    }
    const files = transcriptsOf(dir)
    if (files.length === 0) continue
    if (keptAll.has(dir)) {
      for (const t of files) classify((await headOf(t.file))?.cwd, 1, t.mtimeMs, true)
    } else {
      const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
      const mtimeMs = newest.mtimeMs
      classify((await headOf(newest.file))?.cwd, files.length, mtimeMs, false)
    }
  }
  const unsharedPaths = [...groups]
    .map(([p, g]) => ({ path: p, sessions: g.sessions, lastModified: g.lastModified }))
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, NODE_UNSHARED_GROUPS)
  process.stderr.write(
    `import_list skipped=${skipped} groups=${groups.size}${unsharedPartial ? " partial" : ""}\n`,
  )
  return {
    ...page,
    folders,
    unsharedPaths,
    skipped,
    ...(unsharedPartial ? { unsharedPartial: true } : {}),
  }
}

export interface CheckImportOptions {
  configDir: string
  folders: readonly ImportFolder[]
  sdkSessionId: string
  folderName: string
  /** D53: the worktree `cwdSubdir` is relative to; re-checked against git's own list. */
  worktreePath?: string
  cwdSubdir: string
  now?: number
  probe?: DriverProbe
}

const refuse = (code: NodeImportCheckCode): NodeImportCheckAnswer => ({ ok: false, code })

export interface ImportTargetOptions {
  configDir: string
  /** The shared folder's path as the shell knows it, never a server value. */
  folderPath: string
  sdkSessionId: string
  /**
   * D53: one of the folder's own git worktrees outside it, as listed; it is
   * accepted only when the node's own `git worktree list` of the folder names
   * it now. Absent: `cwdSubdir` is relative to the folder.
   */
  worktreePath?: string
  cwdSubdir: string
  /** D28 b: an in-place follow of Liaison's own session is not refused (A56). */
  allowLiaison?: boolean
}

export type ImportTarget =
  | { ok: true; file: string; cwd: string; from: RowFrom; info: SDKSessionInfo }
  | { ok: false; code: NodeImportCheckCode }

/**
 * Resolves one session's transcript from the folder the shell shares, the
 * recorded subdir and the id, and checks it exactly as an import start does:
 * a uuid, a safe subdir inside the real folder with no symlinked step, a
 * session the SDK knows there, a regular non-symlink transcript under the
 * real projects dir whose head says it ran in that cwd, and not another SDK
 * app's or Liaison's own session (A56). Shared by `checkImport` and the
 * follow host's `follow_add` (follow-host.ts), which trusts no path it did
 * not resolve itself.
 */
export async function resolveImportTarget(o: ImportTargetOptions): Promise<ImportTarget> {
  const no = (code: NodeImportCheckCode): ImportTarget => ({ ok: false, code })
  assertSdkRoot(o.configDir)
  if (!SDK_SESSION_ID_RE.test(o.sdkSessionId)) return no("not_found")
  if (!safeSubdir(o.cwdSubdir)) return no("unsafe_subdir")
  const realF = realpathOrNull(o.folderPath)
  if (realF === null) return no("not_found")
  let base = realF
  if (o.worktreePath !== undefined) {
    if (!safeWorktreePath(o.worktreePath)) return no("unsafe_subdir")
    // D53: only a worktree the node itself lists for this folder, by real path.
    if (!sharedRepoWorktrees(realF).includes(o.worktreePath)) return no("outside_shared")
    base = o.worktreePath
  }
  const joined = o.cwdSubdir === "" ? base : path.join(base, ...o.cwdSubdir.split("/"))
  const cwd = realpathOrNull(joined)
  if (cwd === null) return no("not_found")
  if (!inside(base, cwd)) return no("outside_shared")
  // A symlinked step inside the folder: the run's cwd would not be this path.
  if (cwd !== joined) return no("symlink")
  const projectsDir = path.join(o.configDir, "projects")
  const realProjects = realpathOrNull(projectsDir)
  if (realProjects === null) return no("not_found")
  let info: SDKSessionInfo | undefined
  try {
    info = await getSessionInfo(o.sdkSessionId, { dir: cwd })
  } catch {
    info = undefined
  }
  if (!info) return no("not_found")
  const found = findTranscript(projectsDir, cwd, o.sdkSessionId)
  if (!("file" in found)) return no(found.code)
  const t = transcriptCheck(found.file, realProjects)
  if (!t.ok) return no(t.code)
  const head = await readHead(found.file)
  const recorded = head?.cwd ? realpathOrNull(head.cwd) : null
  // The file must say it ran here: a dir name never proves a cwd.
  if (recorded !== cwd) return no("not_found")
  const entrypoint = head?.entrypoint ?? null
  if (entrypoint === OWNER_SESSION_ENTRYPOINT && !o.allowLiaison) return no("already_liaison")
  const from = fromOf(entrypoint)
  if (from === null) return no("not_found")
  return { ok: true, file: found.file, cwd, from, info }
}

/** Re-validates one session before an import starts (S42, A47, A56). */
export async function checkImport(o: CheckImportOptions): Promise<NodeImportCheckAnswer> {
  assertSdkRoot(o.configDir)
  if (!SDK_SESSION_ID_RE.test(o.sdkSessionId)) return refuse("not_found")
  const folder = o.folders.find((f) => f.name === o.folderName)
  if (!folder) return refuse("outside_shared")
  const target = await resolveImportTarget({
    configDir: o.configDir,
    folderPath: folder.path,
    sdkSessionId: o.sdkSessionId,
    ...(o.worktreePath !== undefined ? { worktreePath: o.worktreePath } : {}),
    cwdSubdir: o.cwdSubdir,
  })
  if (!target.ok) return refuse(target.code)
  const { file, from, info } = target
  const verdict: DriverVerdict = drivenElsewhere(
    {
      jsonl: file,
      sessionId: o.sdkSessionId,
      configDir: o.configDir,
      ownPids: new Set(),
      ownLastWriteMs: null,
      now: o.now ?? Date.now(),
    },
    o.probe ?? systemDriverProbe(),
  )
  const answer = nodeImportCheckAnswerSchema.safeParse({
    ok: true,
    title: redactClip(info.customTitle ?? info.summary ?? "", 120),
    model: await lastModel(file),
    from,
    liveNow: verdict.elsewhere,
    driver: {
      elsewhere: verdict.elsewhere,
      via: verdict.via,
      ...(verdict.orphanPid !== undefined ? { orphanPid: verdict.orphanPid } : {}),
    },
  })
  return answer.success ? answer.data : refuse("not_found")
}

/** The request file the shell writes (0600): unknown keys, such as a configDir, are ignored. */
const importRequestSchema = z.object({
  op: nodeImportOpSchema,
  folders: z
    .array(z.object({ name: z.string().min(1).max(200), path: z.string().min(1).max(4096) }))
    .max(1000),
  /** A4: the owner's search roots, from the shell's settings. */
  searchRoots: z.array(z.string().min(1).max(4096)).max(1000).optional(),
})

export const IMPORT_ANSWER = "import_answer"

/**
 * `liaison-sidecar --import <request file>`: reads the file once (never writes
 * or deletes it; the shell does), prints exactly one line
 * `{type:"import_answer", answer}` or `{type:"import_answer", error}`, and
 * exits.
 */
export async function importMain(
  requestFile: string,
  io: {
    write?: (line: string) => void
    probe?: DriverProbe
    now?: () => number
    /** Tests only: the home folder (default `os.homedir()`). */
    home?: string
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line))
  const say = (body: Record<string, unknown>) =>
    write(`${JSON.stringify({ type: IMPORT_ANSWER, ...body })}\n`)
  let request: z.infer<typeof importRequestSchema>
  try {
    request = importRequestSchema.parse(JSON.parse(readFileSync(requestFile, "utf8")))
  } catch {
    process.stderr.write("import invalid_request\n")
    say({ error: "invalid_request" })
    return 2
  }
  const configDir = realClaudeConfigDir()
  const now = io.now?.() ?? Date.now()
  try {
    const op = request.op
    const answer: unknown =
      op.kind === "list"
        ? await listImportable({
            configDir,
            folders: request.folders,
            query: op.query,
            ...(op.folder !== undefined ? { folder: op.folder } : {}),
            ...(op.detail ? { detail: true } : {}),
            ...(request.searchRoots !== undefined ? { searchRoots: request.searchRoots } : {}),
            now,
            probe: io.probe,
            ...(io.home !== undefined ? { home: io.home } : {}),
          })
        : await checkImport({
            configDir,
            folders: request.folders,
            sdkSessionId: op.sdkSessionId,
            folderName: op.folderName,
            ...(op.worktreePath !== undefined ? { worktreePath: op.worktreePath } : {}),
            cwdSubdir: op.cwdSubdir,
            now,
            probe: io.probe,
          })
    // The list answer is checked against the shared shape before it leaves.
    if (op.kind === "list" && !nodeImportSidecarListSchema.safeParse(answer).success)
      throw new Error("invalid_answer")
    say({ answer })
    return 0
  } catch (error) {
    const code =
      (error as Error).message === "config_dir_mismatch" ? "config_dir_mismatch" : "failed"
    process.stderr.write(`import ${code}\n`)
    say({ error: code })
    return 1
  }
}
